package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	airiskapp "mathstudy/backend/internal/application/airisk"
)

// StartChatSession identifies a session after its welcome and first user
// message have committed atomically.
type StartChatSession struct {
	SessionID string `json:"session_id"`
}

// StartChatNotifier runs immediately after the initial session transaction
// commits and before assistant generation begins. Transport notification
// failures must not be reported as persistence failures.
type StartChatNotifier func(StartChatSession)

type chatMessageIDs struct {
	UserMessageID      string
	AssistantMessageID string
	TaskID             string
}

const (
	defaultFirstChatClaimTTL = 3 * time.Minute
	firstChatClaimGrace      = 5 * time.Second
)

// StartChat atomically materializes a draft session and its first user message,
// then generates the assistant reply. The notifier lets transports publish the
// committed session ID before the potentially slow model call.
func (s *Service) StartChat(
	ctx context.Context,
	userID string,
	sessionID string,
	topic *string,
	mode string,
	message string,
	attachments []string,
	onStarted StartChatNotifier,
	stream ChatStreamCallbacks,
) (ChatResult, error) {
	if !isUUIDv4(sessionID) {
		return ChatResult{}, ErrInvalidSessionID
	}
	sessionID = strings.ToLower(sessionID)
	if strings.TrimSpace(message) == "" {
		return ChatResult{}, ErrEmptyMessage
	}
	if len(message) > maxChatMessageBytes {
		return ChatResult{}, ErrMessageTooLarge
	}
	if mode == "" {
		mode = "chat"
	}
	validatedMode, err := validateSessionMode(mode)
	if err != nil {
		return ChatResult{}, err
	}
	attachments, err = normalizeChatAttachments(attachments)
	if err != nil {
		return ChatResult{}, err
	}
	systemInstruction := sessionModeInstruction(validatedMode)
	historyByteBudget, ok := chatHistoryByteBudget(message, systemInstruction, attachments)
	if !ok {
		return ChatResult{}, ErrMessageTooLarge
	}
	requestHash := firstChatRequestHash(topic, validatedMode, message, attachments)
	existing, exists, err := s.repo.GetSession(ctx, sessionID, userID)
	if err != nil {
		return ChatResult{}, err
	}
	if exists {
		return s.replayStartChat(
			ctx,
			userID,
			existing,
			topic,
			validatedMode,
			message,
			attachments,
			historyByteBudget,
			onStarted,
			requestHash,
			false,
			stream,
		)
	}
	if s.guard != nil {
		lease, err := s.guard.Acquire(ctx, userID, "session_chat", message, true)
		if err != nil {
			return ChatResult{}, err
		}
		defer releaseAILease(lease)
	}

	welcomeMessageID, err := s.newID()
	if err != nil {
		return ChatResult{}, err
	}
	ids, err := s.newChatMessageIDs()
	if err != nil {
		return ChatResult{}, err
	}
	ids.AssistantMessageID = startAssistantMessageID(sessionID)

	startedAt := s.now()
	userCreatedAt := s.now()
	if !userCreatedAt.After(startedAt) {
		userCreatedAt = startedAt.Add(time.Microsecond)
	}
	agent := "tutor"
	session := LearningSession{
		ID:           sessionID,
		StudentID:    userID,
		IsActive:     true,
		CurrentTopic: topic,
		Mode:         validatedMode,
		StartedAt:    startedAt,
	}
	welcome := Message{
		ID:        welcomeMessageID,
		SessionID: sessionID,
		Role:      "assistant",
		Content:   welcomeMessage(validatedMode),
		Agent:     &agent,
		CreatedAt: startedAt,
	}
	userMessage := Message{
		ID:          ids.UserMessageID,
		SessionID:   sessionID,
		Role:        "user",
		Content:     message,
		Attachments: attachments,
		CreatedAt:   userCreatedAt,
	}
	created, err := s.repo.CreateFirstChat(ctx, session, []Message{welcome, userMessage}, FirstChatRequest{
		SessionID:          sessionID,
		RequestHash:        requestHash,
		AssistantMessageID: ids.AssistantMessageID,
		ClaimToken:         ids.TaskID,
		ClaimExpiresAt:     firstChatClaimExpiresAt(ctx, startedAt),
	})
	if err != nil {
		s.releaseFirstChatClaim(session.ID, ids.TaskID)
		return ChatResult{}, err
	}
	if !created {
		existing, exists, err := s.repo.GetSession(ctx, sessionID, userID)
		if err != nil {
			return ChatResult{}, err
		}
		if !exists {
			return ChatResult{}, ErrSessionIDConflict
		}
		return s.replayStartChat(
			ctx,
			userID,
			existing,
			topic,
			validatedMode,
			message,
			attachments,
			historyByteBudget,
			onStarted,
			requestHash,
			true,
			stream,
		)
	}
	if onStarted != nil {
		onStarted(StartChatSession{SessionID: sessionID})
	}

	history := selectRecentChatHistory([]Message{welcome}, historyByteBudget)
	return s.completeFirstChat(
		ctx,
		session,
		userID,
		message,
		attachments,
		history,
		systemInstruction,
		userCreatedAt,
		airiskapp.UsageDate(startedAt),
		ids,
		stream,
	)
}

func (s *Service) replayStartChat(
	ctx context.Context,
	userID string,
	session LearningSession,
	topic *string,
	mode string,
	message string,
	attachments []string,
	historyByteBudget int,
	onStarted StartChatNotifier,
	requestHash string,
	guardHeld bool,
	stream ChatStreamCallbacks,
) (ChatResult, error) {
	storedRequest, exists, err := s.repo.GetFirstChatRequest(ctx, session.ID)
	if err != nil {
		return ChatResult{}, err
	}
	if !exists || storedRequest.RequestHash != requestHash {
		return ChatResult{}, ErrSessionIDConflict
	}
	if onStarted != nil {
		onStarted(StartChatSession{SessionID: session.ID})
	}
	storedReply, replyExists, err := s.repo.GetMessage(ctx, session.ID, storedRequest.AssistantMessageID)
	if err != nil {
		return ChatResult{}, err
	}
	if replyExists {
		taskID, err := s.newID()
		if err != nil {
			return ChatResult{}, err
		}
		agent := "tutor"
		if storedReply.Agent != nil && strings.TrimSpace(*storedReply.Agent) != "" {
			agent = *storedReply.Agent
		}
		result := ChatResult{
			TaskID:    taskID,
			MessageID: storedReply.ID,
			Agent:     agent,
			Content:   storedReply.Content,
		}
		if err := publishStoredChatResult(stream, result); err != nil {
			return ChatResult{}, err
		}
		return result, nil
	}
	if storedRequest.CompletedAt != nil {
		return ChatResult{}, ErrFirstChatCannotResume
	}

	messages, total, err := s.repo.ListMessages(ctx, session.ID, 3, 0)
	if err != nil {
		return ChatResult{}, err
	}
	if total != 2 || len(messages) != 2 ||
		normalizedChatRole(messages[0].Role) != "assistant" ||
		normalizedChatRole(messages[1].Role) != "user" {
		return ChatResult{}, ErrFirstChatCannotResume
	}
	claimTime := s.now()
	if storedRequest.ClaimExpiresAt.After(claimTime) {
		return ChatResult{}, ErrStartChatInProgress
	}

	if !guardHeld && s.guard != nil {
		lease, err := s.guard.Acquire(ctx, userID, "session_chat", message, true)
		if err != nil {
			return ChatResult{}, err
		}
		defer releaseAILease(lease)
	}
	taskID, err := s.newID()
	if err != nil {
		return ChatResult{}, err
	}
	claimTime = s.now()
	claimed, err := s.repo.ClaimFirstChat(
		ctx,
		session.ID,
		taskID,
		claimTime,
		firstChatClaimExpiresAt(ctx, claimTime),
	)
	if err != nil {
		s.releaseFirstChatClaim(session.ID, taskID)
		return ChatResult{}, err
	}
	if !claimed {
		return ChatResult{}, ErrStartChatInProgress
	}
	ids := chatMessageIDs{
		UserMessageID:      messages[1].ID,
		AssistantMessageID: storedRequest.AssistantMessageID,
		TaskID:             taskID,
	}
	history := selectRecentChatHistory([]Message{messages[0]}, historyByteBudget)
	return s.completeFirstChat(
		ctx,
		session,
		userID,
		message,
		attachments,
		history,
		sessionModeInstruction(mode),
		messages[1].CreatedAt,
		airiskapp.UsageDate(claimTime),
		ids,
		stream,
	)
}

func firstChatRequestHash(topic *string, mode string, message string, attachments []string) string {
	payload := struct {
		Version     int      `json:"version"`
		Topic       *string  `json:"topic"`
		Mode        string   `json:"mode"`
		Message     string   `json:"message"`
		Attachments []string `json:"attachments"`
	}{
		Version:     1,
		Topic:       topic,
		Mode:        mode,
		Message:     message,
		Attachments: attachments,
	}
	encoded, _ := json.Marshal(payload)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func firstChatClaimExpiresAt(ctx context.Context, now time.Time) time.Time {
	ttl := defaultFirstChatClaimTTL
	if deadline, ok := ctx.Deadline(); ok && deadline.After(now) {
		ttl = deadline.Sub(now) + firstChatClaimGrace
	}
	return now.Add(ttl)
}

func startAssistantMessageID(sessionID string) string {
	digest := sha256.Sum256([]byte("session-first-assistant:" + sessionID))
	digest[6] = (digest[6] & 0x0f) | 0x50
	digest[8] = (digest[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%08x-%04x-%04x-%04x-%012x",
		digest[0:4],
		digest[4:6],
		digest[6:8],
		digest[8:10],
		digest[10:16],
	)
}

func isUUIDv4(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index := 0; index < len(value); index++ {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		character := value[index]
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	if value[14] != '4' {
		return false
	}
	return strings.ContainsRune("89abAB", rune(value[19]))
}

func (s *Service) newChatMessageIDs() (chatMessageIDs, error) {
	userMessageID, err := s.newID()
	if err != nil {
		return chatMessageIDs{}, err
	}
	assistantMessageID, err := s.newID()
	if err != nil {
		return chatMessageIDs{}, err
	}
	taskID, err := s.newID()
	if err != nil {
		return chatMessageIDs{}, err
	}
	return chatMessageIDs{
		UserMessageID:      userMessageID,
		AssistantMessageID: assistantMessageID,
		TaskID:             taskID,
	}, nil
}

func (s *Service) completeChat(
	ctx context.Context,
	session LearningSession,
	userID string,
	message string,
	attachments []string,
	history []Message,
	systemInstruction string,
	userCreatedAt time.Time,
	ids chatMessageIDs,
	stream ChatStreamCallbacks,
) (ChatResult, error) {
	assistantMessage, agent, metered, err := s.buildAssistantMessage(
		ctx,
		session,
		userID,
		message,
		attachments,
		history,
		systemInstruction,
		userCreatedAt,
		ids,
		stream,
	)
	if err != nil {
		return ChatResult{}, err
	}
	if metered {
		if err := s.repo.InsertMeteredAssistantMessage(ctx, userID, assistantMessage, airiskapp.UsageDate(userCreatedAt)); err != nil {
			return ChatResult{}, err
		}
	} else if err := s.repo.InsertMessage(ctx, assistantMessage); err != nil {
		return ChatResult{}, err
	}
	return chatResult(ids.TaskID, assistantMessage, agent), nil
}

func (s *Service) completeFirstChat(
	ctx context.Context,
	session LearningSession,
	userID string,
	message string,
	attachments []string,
	history []Message,
	systemInstruction string,
	userCreatedAt time.Time,
	usageDate string,
	ids chatMessageIDs,
	stream ChatStreamCallbacks,
) (ChatResult, error) {
	assistantMessage, agent, metered, err := s.buildAssistantMessage(
		ctx,
		session,
		userID,
		message,
		attachments,
		history,
		systemInstruction,
		userCreatedAt,
		ids,
		stream,
	)
	if err != nil {
		s.releaseFirstChatClaim(session.ID, ids.TaskID)
		return ChatResult{}, err
	}
	completed, err := s.repo.CompleteFirstChat(ctx, FirstChatCompletion{
		StudentID:  userID,
		ClaimToken: ids.TaskID,
		UsageDate:  usageDate,
		Message:    assistantMessage,
		Metered:    metered,
	})
	if err != nil {
		s.releaseFirstChatClaim(session.ID, ids.TaskID)
		return ChatResult{}, err
	}
	if !completed {
		return ChatResult{}, ErrStartChatInProgress
	}
	return chatResult(ids.TaskID, assistantMessage, agent), nil
}

func (s *Service) releaseFirstChatClaim(sessionID string, claimToken string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = s.repo.ReleaseFirstChat(ctx, sessionID, claimToken, s.now())
}

func (s *Service) buildAssistantMessage(
	ctx context.Context,
	session LearningSession,
	userID string,
	message string,
	attachments []string,
	history []Message,
	systemInstruction string,
	userCreatedAt time.Time,
	ids chatMessageIDs,
	stream ChatStreamCallbacks,
) (Message, string, bool, error) {
	if stream.OnStart != nil {
		if err := stream.OnStart(ChatStreamStart{
			TaskID:    ids.TaskID,
			MessageID: ids.AssistantMessageID,
			Agent:     "tutor",
		}); err != nil {
			return Message{}, "", false, wrapChatStreamDeliveryError(err)
		}
	}
	output, metered, err := s.generateAssistant(ctx, ChatAgentInput{
		SessionID:         session.ID,
		StudentID:         userID,
		Message:           message,
		SystemInstruction: systemInstruction,
		Attachments:       attachments,
		History:           history,
	}, func(chunk ChatAgentChunk) error {
		if stream.OnChunk == nil {
			return nil
		}
		agent := chunk.Agent
		if agent == "" {
			agent = "tutor"
		}
		return stream.OnChunk(ChatStreamChunk{
			MessageID: ids.AssistantMessageID,
			Agent:     agent,
			Content:   chunk.Content,
		})
	})
	if err != nil {
		return Message{}, "", false, err
	}
	agent := output.Agent
	if agent == "" {
		agent = "tutor"
	}
	assistantCreatedAt := s.now()
	if !assistantCreatedAt.After(userCreatedAt) {
		assistantCreatedAt = userCreatedAt.Add(time.Microsecond)
	}
	assistantMessage := Message{
		ID:        ids.AssistantMessageID,
		SessionID: session.ID,
		Role:      "assistant",
		Content:   output.Content,
		Agent:     &agent,
		CreatedAt: assistantCreatedAt,
	}
	return assistantMessage, agent, metered, nil
}

func publishStoredChatResult(stream ChatStreamCallbacks, result ChatResult) error {
	if stream.OnStart != nil {
		if err := stream.OnStart(ChatStreamStart{
			TaskID:    result.TaskID,
			MessageID: result.MessageID,
			Agent:     result.Agent,
		}); err != nil {
			return wrapChatStreamDeliveryError(err)
		}
	}
	if stream.OnChunk != nil && result.Content != "" {
		if err := stream.OnChunk(ChatStreamChunk{
			MessageID: result.MessageID,
			Agent:     result.Agent,
			Content:   result.Content,
		}); err != nil {
			return wrapChatStreamDeliveryError(err)
		}
	}
	return nil
}

func chatResult(taskID string, message Message, agent string) ChatResult {
	return ChatResult{
		TaskID:    taskID,
		MessageID: message.ID,
		Agent:     agent,
		Content:   message.Content,
	}
}
