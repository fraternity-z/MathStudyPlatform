package conversation

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"mathstudy/backend/internal/application/messageattachment"
	"mathstudy/backend/internal/domain/user"
)

var (
	ErrForbidden    = errors.New("conversation forbidden")
	ErrNotFound     = errors.New("conversation not found")
	ErrConflict     = errors.New("conversation conflict")
	ErrInvalidInput = errors.New("conversation invalid input")
)

const (
	maxIdentifierRunes        = 36
	maxSubjectRunes           = 200
	maxMessageRunes           = 10000
	maxListSearchRunes        = 200
	maxContactSearchRunes     = 100
	minContactSearchTermRunes = 2
	maxPageNumber             = 10000
	maxPageSize               = 100
)

// Repository is the persistence surface required by conversation use cases.
type Repository interface {
	// ListConversations returns paginated conversations for a user.
	// Role-based: students see their conversations with teachers, teachers see theirs with students.
	ListConversations(ctx context.Context, userID string, role user.Role, search string, status string, className string, page, pageSize int) ([]ConversationItem, int, error)
	// GetConversation returns full conversation detail with messages.
	GetConversation(ctx context.Context, conversationID string, userID string, page, pageSize int) (ConversationDetail, bool, error)
	SearchMessages(ctx context.Context, conversationID, userID, search string, page, pageSize int) ([]Message, int, bool, error)
	// AcknowledgeConversationRead marks messages through a server-provided message cutoff.
	AcknowledgeConversationRead(ctx context.Context, conversationID string, userID string, throughMessageID string) (bool, error)
	// CreateConversation creates a new conversation between a student and teacher.
	CreateConversation(ctx context.Context, creatorID string, creatorRole user.Role, targetID string, subject string, initialMessage string, attachments []messageattachment.Attachment) (ConversationDetail, error)
	// SendMessage adds a message to a conversation.
	SendMessage(ctx context.Context, conversationID string, senderID string, senderRole string, text string, attachments []messageattachment.Attachment) (Message, error)
	// ArchiveConversation archives a conversation for one participant.
	ArchiveConversation(ctx context.Context, conversationID string, userID string, role user.Role) (bool, error)
	// ListTeacherContacts returns teachers the student can message.
	ListTeacherContacts(ctx context.Context, studentID string) ([]Contact, error)
	// ListStudentContacts returns students the teacher can message.
	ListStudentContacts(ctx context.Context, teacherID string) ([]Contact, error)
	// SearchContacts searches all users by ID or display name, filtered by role.
	SearchContacts(ctx context.Context, query string, role user.Role) ([]Contact, error)
}

// Message is a single message in a conversation.
type Message struct {
	ID              string                         `json:"id"`
	From            string                         `json:"from"`
	Text            string                         `json:"text"`
	Time            time.Time                      `json:"time"`
	ReadByRecipient *bool                          `json:"read_by_recipient,omitempty"`
	Attachments     []messageattachment.Attachment `json:"attachments"`
}

// Contact is a user available to start a conversation with.
type Contact struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Scope       string `json:"scope"`
}

// ConversationItem is a list-level view of a conversation.
type ConversationItem struct {
	ID           string    `json:"id"`
	StudentID    string    `json:"student_id,omitempty"`
	TeacherID    string    `json:"teacher_id,omitempty"`
	StudentName  string    `json:"student_name,omitempty"`
	TeacherName  string    `json:"teacher_name,omitempty"`
	ClassName    string    `json:"class_name,omitempty"`
	Scope        string    `json:"scope,omitempty"`
	LastMessage  string    `json:"last_message"`
	LastTime     time.Time `json:"last_time"`
	Unread       int       `json:"unread"`
	PendingReply bool      `json:"pending_reply,omitempty"`
	Archived     bool      `json:"archived"`
}

// ConversationDetail includes full message history.
type ConversationDetail struct {
	ConversationItem
	Messages             []Message `json:"messages"`
	MessagesTotal        int       `json:"messages_total"`
	MessagesPage         int       `json:"messages_page"`
	MessagesSize         int       `json:"messages_page_size"`
	ReadThroughMessageID string    `json:"read_through_message_id,omitempty"`
}

// ListResponse is the paginated list response.
type ListResponse struct {
	Items    []ConversationItem `json:"items"`
	Total    int                `json:"total"`
	Page     int                `json:"page"`
	PageSize int                `json:"page_size"`
}

// MessageSearchResponse contains one page of matching messages, in chronological order.
type MessageSearchResponse struct {
	Messages []Message `json:"messages"`
	Total    int       `json:"total"`
	Page     int       `json:"page"`
	PageSize int       `json:"page_size"`
}

// Service implements conversation business logic.
type Service struct {
	repo Repository
}

// NewService creates a conversation service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("conversation repository is nil")
	}
	return &Service{repo: repo}, nil
}

// ListConversations returns the user's conversation list.
func (s *Service) ListConversations(ctx context.Context, userID string, role user.Role, search string, status string, className string, page int, pageSize int) (ListResponse, error) {
	if role != user.RoleStudent && role != user.RoleTeacher {
		return ListResponse{}, ErrForbidden
	}
	search = strings.TrimSpace(search)
	status = strings.TrimSpace(status)
	className = strings.TrimSpace(className)
	if page < 1 || page > maxPageNumber || pageSize < 1 || pageSize > maxPageSize ||
		utf8.RuneCountInString(search) > maxListSearchRunes || utf8.RuneCountInString(className) > maxSubjectRunes ||
		!validText(search) || !validText(className) || !validConversationFilters(role, status, className) {
		return ListResponse{}, ErrInvalidInput
	}
	items, total, err := s.repo.ListConversations(ctx, userID, role, search, status, className, page, pageSize)
	if err != nil {
		return ListResponse{}, err
	}
	return ListResponse{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// GetConversation returns a single conversation with messages.
func (s *Service) GetConversation(ctx context.Context, userID string, conversationID string, page, pageSize int) (ConversationDetail, error) {
	conversationID = strings.TrimSpace(conversationID)
	if !validIdentifier(conversationID) || page < 1 || page > maxPageNumber || pageSize < 1 || pageSize > maxPageSize {
		return ConversationDetail{}, ErrInvalidInput
	}
	detail, found, err := s.repo.GetConversation(ctx, conversationID, userID, page, pageSize)
	if err != nil {
		return ConversationDetail{}, err
	}
	if !found {
		return ConversationDetail{}, ErrNotFound
	}
	return detail, nil
}

func (s *Service) SearchMessages(ctx context.Context, userID, conversationID, search string, page, pageSize int) (MessageSearchResponse, error) {
	conversationID = strings.TrimSpace(conversationID)
	search = strings.TrimSpace(search)
	if !validIdentifier(conversationID) || search == "" || !validText(search) || utf8.RuneCountInString(search) > maxListSearchRunes ||
		page < 1 || page > maxPageNumber || pageSize < 1 || pageSize > maxPageSize {
		return MessageSearchResponse{}, ErrInvalidInput
	}
	messages, total, found, err := s.repo.SearchMessages(ctx, conversationID, userID, search, page, pageSize)
	if err != nil {
		return MessageSearchResponse{}, err
	}
	if !found {
		return MessageSearchResponse{}, ErrNotFound
	}
	return MessageSearchResponse{Messages: messages, Total: total, Page: page, PageSize: pageSize}, nil
}

// AcknowledgeConversationRead marks only messages at or before a cutoff returned by GetConversation.
func (s *Service) AcknowledgeConversationRead(ctx context.Context, userID string, conversationID string, throughMessageID string) error {
	conversationID = strings.TrimSpace(conversationID)
	throughMessageID = strings.TrimSpace(throughMessageID)
	if !validIdentifier(conversationID) || !validIdentifier(throughMessageID) {
		return ErrInvalidInput
	}
	ok, err := s.repo.AcknowledgeConversationRead(ctx, conversationID, userID, throughMessageID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// CreateConversation creates a new student-teacher conversation.
func (s *Service) CreateConversation(ctx context.Context, creatorID string, creatorRole user.Role, targetID string, subject string, initialMessage string, attachments []messageattachment.Attachment) (ConversationDetail, error) {
	targetID = strings.TrimSpace(targetID)
	subject = strings.TrimSpace(subject)
	initialMessage = strings.TrimSpace(initialMessage)
	normalizedAttachments, err := messageattachment.Normalize(attachments)
	if err != nil || (creatorRole != user.RoleStudent && creatorRole != user.RoleTeacher) || !validIdentifier(targetID) ||
		utf8.RuneCountInString(subject) > maxSubjectRunes || utf8.RuneCountInString(initialMessage) > maxMessageRunes ||
		!validText(subject) || !validText(initialMessage) {
		return ConversationDetail{}, ErrInvalidInput
	}
	return s.repo.CreateConversation(ctx, creatorID, creatorRole, targetID, subject, initialMessage, normalizedAttachments)
}

// SendMessage sends a message in an existing conversation.
func (s *Service) SendMessage(ctx context.Context, conversationID string, senderID string, senderRole string, text string, attachments []messageattachment.Attachment) (Message, error) {
	conversationID = strings.TrimSpace(conversationID)
	text = strings.TrimSpace(text)
	normalizedAttachments, err := messageattachment.Normalize(attachments)
	if !validIdentifier(conversationID) || (senderRole != string(user.RoleStudent) && senderRole != string(user.RoleTeacher)) ||
		err != nil || (text == "" && len(normalizedAttachments) == 0) ||
		utf8.RuneCountInString(text) > maxMessageRunes || !validText(text) {
		return Message{}, ErrInvalidInput
	}
	return s.repo.SendMessage(ctx, conversationID, senderID, senderRole, text, normalizedAttachments)
}

// ArchiveConversation archives a conversation for the requesting participant.
func (s *Service) ArchiveConversation(ctx context.Context, conversationID string, userID string, role user.Role) error {
	if role != user.RoleStudent && role != user.RoleTeacher {
		return ErrForbidden
	}
	conversationID = strings.TrimSpace(conversationID)
	if !validIdentifier(conversationID) {
		return ErrInvalidInput
	}
	ok, err := s.repo.ArchiveConversation(ctx, conversationID, userID, role)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// ListTeacherContacts returns teachers available for messaging.
func (s *Service) ListTeacherContacts(ctx context.Context, studentID string) ([]Contact, error) {
	return s.repo.ListTeacherContacts(ctx, studentID)
}

// ListStudentContacts returns students available for messaging.
func (s *Service) ListStudentContacts(ctx context.Context, teacherID string) ([]Contact, error) {
	return s.repo.ListStudentContacts(ctx, teacherID)
}

// SearchContacts searches all users by ID or display name, filtered by role.
func (s *Service) SearchContacts(ctx context.Context, query string, role user.Role) ([]Contact, error) {
	query = strings.TrimSpace(query)
	if role != user.RoleStudent && role != user.RoleTeacher {
		return nil, ErrForbidden
	}
	if utf8.RuneCountInString(query) > maxContactSearchRunes || meaningfulRunes(query) < minContactSearchTermRunes || !validText(query) {
		return nil, ErrInvalidInput
	}
	return s.repo.SearchContacts(ctx, query, role)
}

func validIdentifier(value string) bool {
	return value != "" && utf8.RuneCountInString(value) <= maxIdentifierRunes && validText(value)
}

func validText(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, '\x00')
}

func meaningfulRunes(value string) int {
	count := 0
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			count++
		}
	}
	return count
}

func validStatusFilter(status string) bool {
	switch status {
	case "", "全部", "未读", "待回复":
		return true
	default:
		return false
	}
}

func validConversationFilters(role user.Role, status string, className string) bool {
	if !validStatusFilter(status) {
		return false
	}
	if role == user.RoleStudent {
		return (status == "" || status == "全部") && className == ""
	}
	return true
}
