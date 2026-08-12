package openaicompat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	maxSSELineSize  = 8 << 20
	maxSSEEventSize = 16 << 20
)

var errSSETerminal = errors.New("SSE terminal event reached")

type sseFrame struct {
	Event string
	Data  []byte
}

func readSSE(reader io.Reader, consume func(sseFrame) error) error {
	if reader == nil {
		return errors.New("SSE response body is empty")
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), maxSSELineSize)
	eventName := ""
	dataLines := make([]string, 0, 4)
	dataSize := 0
	dispatch := func() error {
		if len(dataLines) == 0 {
			eventName = ""
			dataSize = 0
			return nil
		}
		data := []byte(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		dataSize = 0
		frame := sseFrame{Event: eventName, Data: data}
		eventName = ""
		return consume(frame)
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if found && strings.HasPrefix(value, " ") {
			value = value[1:]
		}
		switch field {
		case "event":
			eventName = strings.TrimSpace(value)
		case "data":
			dataSize += len(value) + 1
			if dataSize > maxSSEEventSize {
				return errors.New("SSE event exceeds size limit")
			}
			dataLines = append(dataLines, value)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read SSE response: %w", err)
	}
	return dispatch()
}

type chatStreamChunk struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content   any    `json:"content"`
			Refusal   string `json:"refusal"`
			ToolCalls []struct {
				Index    *int   `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *chatUsage `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Param   string `json:"param"`
		Code    any    `json:"code"`
	} `json:"error"`
}

type chatResponsesStreamState struct {
	request     ResponsesRequest
	id          string
	model       string
	created     int64
	sequence    int
	started     bool
	finalized   bool
	finishSeen  bool
	status      string
	incomplete  any
	usage       ResponsesUsage
	buffered    int
	nextOutput  int
	message     *streamMessage
	tools       map[int]*streamTool
	outputOrder []streamOutputRef
}

type streamMessage struct {
	OutputIndex  int
	ID           string
	Text         strings.Builder
	Refusal      strings.Builder
	TextStarted  bool
	TextIndex    int
	RefusalStart bool
	RefusalIndex int
	ContentOrder []string
	Done         bool
}

type streamTool struct {
	ChatIndex   int
	OutputIndex int
	ID          string
	CallID      string
	Name        string
	Arguments   strings.Builder
	Done        bool
}

type streamOutputRef struct {
	Kind      string
	ToolIndex int
}

func newChatResponsesStreamState(request ResponsesRequest, model string) *chatResponsesStreamState {
	return &chatResponsesStreamState{
		request: request, id: newResponsesID(), model: model, created: time.Now().Unix(),
		sequence: -1, status: "completed", tools: make(map[int]*streamTool),
	}
}

func (s *chatResponsesStreamState) consume(chunk chatStreamChunk) ([]ResponsesStreamEvent, error) {
	if strings.TrimSpace(chunk.Model) != "" {
		s.model = strings.TrimSpace(chunk.Model)
	}
	if chunk.Created > 0 {
		s.created = chunk.Created
	}
	if chunk.Usage != nil {
		s.usage = responsesUsageFromChat(chunk.Usage)
	}
	events := s.ensureStarted()
	for _, choice := range chunk.Choices {
		if text := chatMessageText(choice.Delta.Content); text != "" {
			if err := s.reserveStreamContent(text); err != nil {
				return nil, err
			}
			events = append(events, s.appendText(text)...)
		}
		if choice.Delta.Refusal != "" {
			if err := s.reserveStreamContent(choice.Delta.Refusal); err != nil {
				return nil, err
			}
			events = append(events, s.appendRefusal(choice.Delta.Refusal)...)
		}
		for _, call := range choice.Delta.ToolCalls {
			toolEvents, err := s.appendTool(call.Index, call.ID, call.Function.Name, call.Function.Arguments)
			if err != nil {
				return nil, err
			}
			events = append(events, toolEvents...)
		}
		if choice.FinishReason != nil && strings.TrimSpace(*choice.FinishReason) != "" {
			status, incomplete, err := responsesStatusFromFinishReason(*choice.FinishReason)
			if err != nil {
				return nil, err
			}
			s.status, s.incomplete = status, incomplete
			s.finishSeen = true
		}
	}
	return events, nil
}

func (s *chatResponsesStreamState) reserveStreamContent(delta string) error {
	if len(delta) > maxResponseBodySize-s.buffered {
		return &ProtocolError{cause: errors.New("Chat Completions stream content exceeds size limit")}
	}
	s.buffered += len(delta)
	return nil
}

func (s *chatResponsesStreamState) ensureStarted() []ResponsesStreamEvent {
	if s.started {
		return nil
	}
	s.started = true
	created := responseEnvelope(s.request, s.id, s.model, "in_progress", s.created, []any{}, ResponsesUsage{})
	created["usage"] = nil
	return []ResponsesStreamEvent{
		s.event("response.created", map[string]any{"response": created}),
		s.event("response.in_progress", map[string]any{"response": created}),
	}
}

func (s *chatResponsesStreamState) ensureMessage() []ResponsesStreamEvent {
	if s.message != nil {
		return nil
	}
	index := s.nextOutput
	s.nextOutput++
	s.message = &streamMessage{OutputIndex: index, ID: s.id + "_msg_0"}
	s.outputOrder = append(s.outputOrder, streamOutputRef{Kind: "message"})
	return []ResponsesStreamEvent{s.event("response.output_item.added", map[string]any{
		"output_index": index,
		"item": map[string]any{
			"id": s.message.ID, "type": "message", "status": "in_progress",
			"role": "assistant", "content": []any{},
		},
	})}
}

func (s *chatResponsesStreamState) appendText(delta string) []ResponsesStreamEvent {
	events := s.ensureMessage()
	if !s.message.TextStarted {
		s.message.TextStarted = true
		s.message.TextIndex = len(s.message.ContentOrder)
		s.message.ContentOrder = append(s.message.ContentOrder, "text")
		events = append(events, s.event("response.content_part.added", map[string]any{
			"item_id": s.message.ID, "output_index": s.message.OutputIndex, "content_index": s.message.TextIndex,
			"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}, "logprobs": []any{}},
		}))
	}
	s.message.Text.WriteString(delta)
	events = append(events, s.event("response.output_text.delta", map[string]any{
		"item_id": s.message.ID, "output_index": s.message.OutputIndex, "content_index": s.message.TextIndex,
		"delta": delta, "logprobs": []any{},
	}))
	return events
}

func (s *chatResponsesStreamState) appendRefusal(delta string) []ResponsesStreamEvent {
	events := s.ensureMessage()
	if !s.message.RefusalStart {
		s.message.RefusalStart = true
		s.message.RefusalIndex = len(s.message.ContentOrder)
		s.message.ContentOrder = append(s.message.ContentOrder, "refusal")
		events = append(events, s.event("response.content_part.added", map[string]any{
			"item_id": s.message.ID, "output_index": s.message.OutputIndex, "content_index": s.message.RefusalIndex,
			"part": map[string]any{"type": "refusal", "refusal": ""},
		}))
	}
	s.message.Refusal.WriteString(delta)
	events = append(events, s.event("response.refusal.delta", map[string]any{
		"item_id": s.message.ID, "output_index": s.message.OutputIndex, "content_index": s.message.RefusalIndex,
		"delta": delta,
	}))
	return events
}

func (s *chatResponsesStreamState) appendTool(index *int, id string, name string, arguments string) ([]ResponsesStreamEvent, error) {
	chatIndex := 0
	if index != nil {
		chatIndex = *index
	}
	tool := s.tools[chatIndex]
	events := make([]ResponsesStreamEvent, 0, 2)
	if tool == nil {
		outputIndex := s.nextOutput
		s.nextOutput++
		callID := strings.TrimSpace(id)
		if callID == "" {
			callID = fmt.Sprintf("%s_call_%d", s.id, chatIndex)
		}
		tool = &streamTool{
			ChatIndex: chatIndex, OutputIndex: outputIndex, ID: callID,
			CallID: callID, Name: strings.TrimSpace(name),
		}
		s.tools[chatIndex] = tool
		s.outputOrder = append(s.outputOrder, streamOutputRef{Kind: "tool", ToolIndex: chatIndex})
		events = append(events, s.event("response.output_item.added", map[string]any{
			"output_index": outputIndex,
			"item": map[string]any{
				"id": tool.ID, "type": "function_call", "status": "in_progress",
				"call_id": tool.CallID, "name": tool.Name, "arguments": "",
			},
		}))
	} else {
		if value := strings.TrimSpace(id); value != "" && value != tool.CallID {
			return nil, &ProtocolError{cause: errors.New("Chat Completions stream tool call ID changed")}
		}
		if value := strings.TrimSpace(name); value != "" && tool.Name != "" && value != tool.Name {
			return nil, &ProtocolError{cause: errors.New("Chat Completions stream tool call name changed")}
		}
	}
	if strings.TrimSpace(name) != "" {
		tool.Name = strings.TrimSpace(name)
	}
	if arguments != "" {
		if err := s.reserveStreamContent(arguments); err != nil {
			return nil, err
		}
		tool.Arguments.WriteString(arguments)
		events = append(events, s.event("response.function_call_arguments.delta", map[string]any{
			"item_id": tool.ID, "output_index": tool.OutputIndex, "delta": arguments,
		}))
	}
	return events, nil
}

func (s *chatResponsesStreamState) finalize() []ResponsesStreamEvent {
	if s.finalized {
		return nil
	}
	s.finalized = true
	events := make([]ResponsesStreamEvent, 0, 8)
	for _, ref := range s.outputOrder {
		switch ref.Kind {
		case "message":
			events = append(events, s.finalizeMessage()...)
		case "tool":
			events = append(events, s.finalizeTool(s.tools[ref.ToolIndex])...)
		}
	}
	final := responseEnvelope(s.request, s.id, s.model, s.status, s.created, s.finalOutput(), s.usage)
	if s.status == "completed" {
		final["completed_at"] = time.Now().Unix()
	}
	final["incomplete_details"] = s.incomplete
	eventType := "response.completed"
	if s.status == "incomplete" {
		eventType = "response.incomplete"
	}
	events = append(events, s.event(eventType, map[string]any{"response": final}))
	return events
}

func (s *chatResponsesStreamState) finalizeMessage() []ResponsesStreamEvent {
	if s.message == nil || s.message.Done {
		return nil
	}
	events := make([]ResponsesStreamEvent, 0, 6)
	content := make([]any, 0, len(s.message.ContentOrder))
	for _, kind := range s.message.ContentOrder {
		switch kind {
		case "text":
			text := s.message.Text.String()
			events = append(events, s.event("response.output_text.done", map[string]any{
				"item_id": s.message.ID, "output_index": s.message.OutputIndex,
				"content_index": s.message.TextIndex, "text": text, "logprobs": []any{},
			}))
			part := map[string]any{"type": "output_text", "text": text, "annotations": []any{}, "logprobs": []any{}}
			events = append(events, s.event("response.content_part.done", map[string]any{
				"item_id": s.message.ID, "output_index": s.message.OutputIndex,
				"content_index": s.message.TextIndex, "part": part,
			}))
			content = append(content, part)
		case "refusal":
			refusal := s.message.Refusal.String()
			events = append(events, s.event("response.refusal.done", map[string]any{
				"item_id": s.message.ID, "output_index": s.message.OutputIndex,
				"content_index": s.message.RefusalIndex, "refusal": refusal,
			}))
			part := map[string]any{"type": "refusal", "refusal": refusal}
			events = append(events, s.event("response.content_part.done", map[string]any{
				"item_id": s.message.ID, "output_index": s.message.OutputIndex,
				"content_index": s.message.RefusalIndex, "part": part,
			}))
			content = append(content, part)
		}
	}
	s.message.Done = true
	events = append(events, s.event("response.output_item.done", map[string]any{
		"output_index": s.message.OutputIndex,
		"item": map[string]any{
			"id": s.message.ID, "type": "message", "status": outputStatus(s.status),
			"role": "assistant", "content": content,
		},
	}))
	return events
}

func (s *chatResponsesStreamState) finalizeTool(tool *streamTool) []ResponsesStreamEvent {
	if tool == nil || tool.Done {
		return nil
	}
	tool.Done = true
	arguments := tool.Arguments.String()
	if strings.TrimSpace(arguments) == "" {
		arguments = "{}"
	}
	return []ResponsesStreamEvent{
		s.event("response.function_call_arguments.done", map[string]any{
			"item_id": tool.ID, "output_index": tool.OutputIndex, "name": tool.Name, "arguments": arguments,
		}),
		s.event("response.output_item.done", map[string]any{
			"output_index": tool.OutputIndex,
			"item": map[string]any{
				"id": tool.ID, "type": "function_call", "status": outputStatus(s.status),
				"call_id": tool.CallID, "name": tool.Name, "arguments": arguments,
			},
		}),
	}
}

func (s *chatResponsesStreamState) finalOutput() []any {
	output := make([]any, 0, len(s.outputOrder))
	for _, ref := range s.outputOrder {
		switch ref.Kind {
		case "message":
			if s.message == nil {
				continue
			}
			content := make([]any, 0, len(s.message.ContentOrder))
			for _, kind := range s.message.ContentOrder {
				switch kind {
				case "text":
					content = append(content, map[string]any{"type": "output_text", "text": s.message.Text.String(), "annotations": []any{}, "logprobs": []any{}})
				case "refusal":
					content = append(content, map[string]any{"type": "refusal", "refusal": s.message.Refusal.String()})
				}
			}
			output = append(output, map[string]any{
				"id": s.message.ID, "type": "message", "status": outputStatus(s.status),
				"role": "assistant", "content": content,
			})
		case "tool":
			tool := s.tools[ref.ToolIndex]
			if tool == nil {
				continue
			}
			arguments := tool.Arguments.String()
			if strings.TrimSpace(arguments) == "" {
				arguments = "{}"
			}
			output = append(output, map[string]any{
				"id": tool.ID, "type": "function_call", "status": outputStatus(s.status),
				"call_id": tool.CallID, "name": tool.Name, "arguments": arguments,
			})
		}
	}
	return output
}

func (s *chatResponsesStreamState) event(eventType string, fields map[string]any) ResponsesStreamEvent {
	s.sequence++
	payload := make(map[string]any, len(fields)+2)
	payload["type"] = eventType
	payload["sequence_number"] = s.sequence
	for name, value := range fields {
		payload[name] = value
	}
	data, _ := json.Marshal(payload)
	return ResponsesStreamEvent{Type: eventType, Data: data}
}

type streamRelayError struct {
	delivered bool
	cause     error
}

func (e *streamRelayError) Error() string {
	if e == nil || e.cause == nil {
		return "Responses stream failed"
	}
	return e.cause.Error()
}

func (e *streamRelayError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func streamNativeResponses(ctx context.Context, response *http.Response, callbacks ResponsesStreamCallbacks) (ResponsesResult, error) {
	defer response.Body.Close()
	result := ResponsesResult{StatusCode: response.StatusCode, Header: providerResponseHeaders(response.Header), Stream: true}
	if requestID := upstreamRequestID(response.Header); requestID != "" {
		result.Header.Set("X-Upstream-Request-ID", requestID)
	}
	delivered := false
	terminal := false
	err := readSSE(response.Body, func(frame sseFrame) error {
		if bytes.Equal(bytes.TrimSpace(frame.Data), []byte("[DONE]")) {
			return nil
		}
		var payload map[string]any
		if err := decodeJSON(frame.Data, &payload); err != nil {
			return &ProtocolError{cause: fmt.Errorf("decode Responses SSE event: %w", err)}
		}
		eventType, _ := payload["type"].(string)
		if strings.TrimSpace(eventType) == "" {
			eventType = strings.TrimSpace(frame.Event)
		}
		if eventType == "" {
			return &ProtocolError{cause: errors.New("Responses SSE event type is empty")}
		}
		isTerminal, err := applyNativeTerminalMetadata(eventType, payload, &result)
		if err != nil {
			return err
		}
		eventData, err := sanitizeNativeResponsesEvent(eventType, payload, frame.Data)
		if err != nil {
			return err
		}
		if !delivered {
			if err := callbacks.OnStart(result.Header.Clone()); err != nil {
				return err
			}
			delivered = true
		}
		if err := callbacks.OnEvent(ResponsesStreamEvent{Type: eventType, Data: eventData}); err != nil {
			return err
		}
		terminal = isTerminal
		if terminal {
			return errSSETerminal
		}
		return nil
	})
	if errors.Is(err, errSSETerminal) {
		err = nil
	}
	if err != nil {
		return result, &streamRelayError{delivered: delivered, cause: err}
	}
	if err := ctx.Err(); err != nil {
		return result, &streamRelayError{delivered: delivered, cause: err}
	}
	if !delivered {
		return result, &streamRelayError{cause: errors.New("provider returned an empty Responses stream")}
	}
	if !terminal {
		return result, &streamRelayError{delivered: true, cause: io.ErrUnexpectedEOF}
	}
	return result, nil
}

func applyNativeTerminalMetadata(eventType string, payload map[string]any, result *ResponsesResult) (bool, error) {
	expectedStatus := ""
	switch eventType {
	case "response.completed":
		expectedStatus = "completed"
	case "response.incomplete":
		expectedStatus = "incomplete"
	case "response.failed":
		expectedStatus = "failed"
	case "response.cancelled":
		expectedStatus = "cancelled"
	case "response.canceled":
		expectedStatus = "canceled"
	case "error":
		result.ResponseStatus = "failed"
		return true, nil
	default:
		return false, nil
	}
	response, ok := payload["response"].(map[string]any)
	if !ok {
		return false, &ProtocolError{cause: errors.New("Responses terminal event has no response object")}
	}
	responseID, _ := response["id"].(string)
	model, _ := response["model"].(string)
	status, _ := response["status"].(string)
	if strings.TrimSpace(responseID) == "" || strings.TrimSpace(model) == "" {
		return false, &ProtocolError{cause: errors.New("Responses terminal event metadata is incomplete")}
	}
	if strings.TrimSpace(status) != expectedStatus {
		return false, &ProtocolError{cause: errors.New("Responses terminal event status does not match its event type")}
	}
	result.ResponseID = strings.TrimSpace(responseID)
	result.Model = strings.TrimSpace(model)
	result.ResponseStatus = expectedStatus
	result.Usage = responsesUsageFromObject(response["usage"])
	return true, nil
}

func sanitizeNativeResponsesEvent(eventType string, payload map[string]any, original []byte) ([]byte, error) {
	sanitized := cloneObject(payload)
	switch eventType {
	case "response.failed", "response.cancelled", "response.canceled":
		if response, ok := sanitized["response"].(map[string]any); ok {
			response = cloneObject(response)
			response["error"] = stableResponsesProviderError()
			sanitized["response"] = response
		}
	case "error":
		sequence := sanitized["sequence_number"]
		sanitized = map[string]any{
			"type": "error", "code": "upstream_error", "param": nil,
			"message": "The model provider returned an error.",
		}
		if sequence != nil {
			sanitized["sequence_number"] = sequence
		}
	default:
		return append([]byte(nil), original...), nil
	}
	encoded, err := json.Marshal(sanitized)
	if err != nil {
		return nil, &ProtocolError{cause: fmt.Errorf("encode Responses SSE event: %w", err)}
	}
	return encoded, nil
}

func streamChatAsResponses(ctx context.Context, response *http.Response, request ResponsesRequest, model string, callbacks ResponsesStreamCallbacks) (ResponsesResult, error) {
	defer response.Body.Close()
	result := ResponsesResult{StatusCode: response.StatusCode, Header: providerResponseHeaders(response.Header), Stream: true}
	if requestID := upstreamRequestID(response.Header); requestID != "" {
		result.Header.Set("X-Upstream-Request-ID", requestID)
	}
	state := newChatResponsesStreamState(request, model)
	delivered := false
	seenChunk := false
	done := false
	send := func(events []ResponsesStreamEvent) error {
		if len(events) == 0 {
			return nil
		}
		if !delivered {
			if err := callbacks.OnStart(result.Header.Clone()); err != nil {
				return err
			}
			delivered = true
		}
		for _, event := range events {
			if err := callbacks.OnEvent(event); err != nil {
				return err
			}
		}
		return nil
	}
	err := readSSE(response.Body, func(frame sseFrame) error {
		if bytes.Equal(bytes.TrimSpace(frame.Data), []byte("[DONE]")) {
			done = true
			if !seenChunk {
				return errSSETerminal
			}
			if err := state.validateFinal(); err != nil {
				return err
			}
			if err := send(state.finalize()); err != nil {
				return err
			}
			return errSSETerminal
		}
		var chunk chatStreamChunk
		if err := decodeJSON(frame.Data, &chunk); err != nil {
			return &ProtocolError{cause: fmt.Errorf("decode Chat Completions SSE event: %w", err)}
		}
		if chunk.Error != nil && strings.TrimSpace(chunk.Error.Message) != "" {
			return apiErrorFromChatError(chunk.Error.Message, chunk.Error.Type, chunk.Error.Param, chunk.Error.Code)
		}
		seenChunk = true
		events, err := state.consume(chunk)
		if err != nil {
			return err
		}
		return send(events)
	})
	if errors.Is(err, errSSETerminal) {
		err = nil
	}
	if err != nil {
		return result, &streamRelayError{delivered: delivered, cause: err}
	}
	if err := ctx.Err(); err != nil {
		return result, &streamRelayError{delivered: delivered, cause: err}
	}
	if !seenChunk {
		return result, &streamRelayError{cause: errors.New("provider returned an empty Chat Completions stream")}
	}
	if !done {
		return result, &streamRelayError{delivered: delivered, cause: io.ErrUnexpectedEOF}
	}
	result.ResponseID = state.id
	result.ResponseStatus = state.status
	result.Model = state.model
	result.Usage = state.usage
	return result, nil
}

func (s *chatResponsesStreamState) validateFinal() error {
	if !s.finishSeen {
		return &ProtocolError{cause: errors.New("Chat Completions stream ended without finish_reason")}
	}
	for _, tool := range s.tools {
		if strings.TrimSpace(tool.Name) == "" {
			return &ProtocolError{cause: errors.New("Chat Completions stream tool call has no function name")}
		}
	}
	return nil
}

func responsesUsageFromObject(raw any) ResponsesUsage {
	usage, _ := raw.(map[string]any)
	if usage == nil {
		return ResponsesUsage{}
	}
	result := ResponsesUsage{}
	if value, ok := jsonNumberInt64(usage["input_tokens"]); ok {
		result.InputTokens = int(value)
	}
	if value, ok := jsonNumberInt64(usage["output_tokens"]); ok {
		result.OutputTokens = int(value)
	}
	if value, ok := jsonNumberInt64(usage["total_tokens"]); ok {
		result.TotalTokens = int(value)
	}
	if details, ok := usage["input_tokens_details"].(map[string]any); ok {
		if value, ok := jsonNumberInt64(details["cached_tokens"]); ok {
			result.CachedTokens = int(value)
		}
	}
	if details, ok := usage["output_tokens_details"].(map[string]any); ok {
		if value, ok := jsonNumberInt64(details["reasoning_tokens"]); ok {
			result.ReasoningTokens = int(value)
		}
	}
	if result.TotalTokens == 0 {
		result.TotalTokens = result.InputTokens + result.OutputTokens
	}
	return result
}

func providerResponseHeaders(source http.Header) http.Header {
	result := make(http.Header)
	for name, values := range source {
		lower := strings.ToLower(name)
		if lower == "content-type" || lower == "retry-after" || lower == "openai-processing-ms" || strings.HasPrefix(lower, "x-ratelimit-") {
			for _, value := range values {
				result.Add(name, value)
			}
		}
	}
	return result
}
