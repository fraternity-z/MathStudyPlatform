package conversationhttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	authapp "mathstudy/backend/internal/application/auth"
	conversationapp "mathstudy/backend/internal/application/conversation"
	"mathstudy/backend/internal/application/messageattachment"
	"mathstudy/backend/internal/domain/user"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/httpquery"
	"mathstudy/backend/internal/platform/ratelimit"
	"mathstudy/backend/internal/platform/redact"
)

// Service is the conversation application surface used by HTTP handlers.
type Service interface {
	ListConversations(ctx context.Context, userID string, role user.Role, search string, status string, className string, page int, pageSize int) (conversationapp.ListResponse, error)
	GetConversation(ctx context.Context, userID string, conversationID string, page int, pageSize int) (conversationapp.ConversationDetail, error)
	SearchMessages(context.Context, string, string, string, int, int) (conversationapp.MessageSearchResponse, error)
	AcknowledgeConversationRead(ctx context.Context, userID string, conversationID string, throughMessageID string) error
	CreateConversation(ctx context.Context, creatorID string, creatorRole user.Role, targetID string, subject string, initialMessage string, attachments []messageattachment.Attachment) (conversationapp.ConversationDetail, error)
	SendMessage(ctx context.Context, conversationID string, senderID string, senderRole string, text string, attachments []messageattachment.Attachment) (conversationapp.Message, error)
	ArchiveConversation(ctx context.Context, conversationID string, userID string, role user.Role) error
	ListTeacherContacts(ctx context.Context, studentID string) ([]conversationapp.Contact, error)
	ListStudentContacts(ctx context.Context, teacherID string) ([]conversationapp.Contact, error)
	SearchContacts(ctx context.Context, query string, role user.Role) ([]conversationapp.Contact, error)
}

// Authenticator decodes access tokens.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// Handler serves /conversations endpoints.
type Handler struct {
	service       Service
	auth          Authenticator
	logger        *slog.Logger
	writeLimiter  *ratelimit.Limiter
	searchLimiter *ratelimit.Limiter
}

// Option customizes the conversation HTTP handler.
type Option func(*Handler)

// WithRateLimits applies shared per-user message-center limits.
func WithRateLimits(writeLimiter *ratelimit.Limiter, searchLimiter *ratelimit.Limiter) Option {
	return func(handler *Handler) {
		handler.writeLimiter = writeLimiter
		handler.searchLimiter = searchLimiter
	}
}

// NewHandler creates a conversation HTTP handler.
func NewHandler(logger *slog.Logger, service Service, auth Authenticator, options ...Option) (*Handler, error) {
	if service == nil {
		return nil, errors.New("conversation service is nil")
	}
	if auth == nil {
		return nil, errors.New("conversation authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	handler := &Handler{service: service, auth: auth, logger: logger}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler, nil
}

// Register attaches conversation routes under prefix.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/contacts/teachers", h.listTeacherContacts)
	mux.HandleFunc("GET "+prefix+"/contacts/students", h.listStudentContacts)
	mux.HandleFunc("GET "+prefix+"/search-users", h.searchUsers)
	mux.HandleFunc("POST "+prefix, h.createConversation)
	mux.HandleFunc("GET "+prefix+"/{id}", h.getConversation)
	mux.HandleFunc("GET "+prefix, h.listConversations)
	mux.HandleFunc("PUT "+prefix+"/{id}/read", h.acknowledgeRead)
	mux.HandleFunc("POST "+prefix+"/{id}/messages", h.sendMessage)
	mux.HandleFunc("GET "+prefix+"/{id}/messages", h.searchMessages)
	mux.HandleFunc("PUT "+prefix+"/{id}/archive", h.archiveConversation)
}

const (
	maxJSONBodyBytes = 1 << 20
	maxPageNumber    = 10000
)

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func (h *Handler) listConversations(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	page, ok := parseBoundedInt(w, q.Get("page"), 1, 1, maxPageNumber, "page")
	if !ok {
		return
	}
	pageSize, ok := parseBoundedInt(w, q.Get("page_size"), 20, 1, 100, "page_size")
	if !ok {
		return
	}
	if strings.TrimSpace(q.Get("search")) != "" && !h.allowSearch(w, r, principal.UserID) {
		return
	}
	response, err := h.service.ListConversations(r.Context(), principal.UserID, principal.Role,
		q.Get("search"), q.Get("status"), q.Get("class_name"), page, pageSize)
	if err != nil {
		if errors.Is(err, conversationapp.ErrInvalidInput) {
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "筛选条件长度或格式无效")
			return
		}
		h.logError("list conversations failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取会话列表失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) getConversation(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	page, ok := parseBoundedInt(w, r.URL.Query().Get("messages_page"), 1, 1, maxPageNumber, "messages_page")
	if !ok {
		return
	}
	pageSize, ok := parseBoundedInt(w, r.URL.Query().Get("messages_page_size"), 50, 1, 100, "messages_page_size")
	if !ok {
		return
	}
	response, err := h.service.GetConversation(r.Context(), principal.UserID, r.PathValue("id"), page, pageSize)
	if err != nil {
		if errors.Is(err, conversationapp.ErrInvalidInput) {
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "会话 ID 无效")
			return
		}
		if errors.Is(err, conversationapp.ErrNotFound) {
			writeConvError(w, http.StatusNotFound, "NOT_FOUND", "会话不存在")
			return
		}
		h.logError("get conversation failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取会话失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) searchMessages(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	page, ok := parseBoundedInt(w, r.URL.Query().Get("page"), 1, 1, maxPageNumber, "page")
	if !ok {
		return
	}
	pageSize, ok := parseBoundedInt(w, r.URL.Query().Get("page_size"), 50, 1, 100, "page_size")
	if !ok || !h.allowSearch(w, r, principal.UserID) {
		return
	}
	response, err := h.service.SearchMessages(r.Context(), principal.UserID, r.PathValue("id"), r.URL.Query().Get("search"), page, pageSize)
	if err != nil {
		switch {
		case errors.Is(err, conversationapp.ErrInvalidInput):
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请输入 1 至 200 字的搜索内容")
		case errors.Is(err, conversationapp.ErrNotFound):
			writeConvError(w, http.StatusNotFound, "NOT_FOUND", "会话不存在")
		default:
			h.logError("search conversation messages failed", err)
			writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "搜索聊天记录失败")
		}
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

type acknowledgeReadRequest struct {
	ThroughMessageID string `json:"through_message_id"`
}

func (h *Handler) acknowledgeRead(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	if !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var req acknowledgeReadRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &req) {
		return
	}
	if strings.TrimSpace(req.ThroughMessageID) == "" {
		writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "through_message_id 不能为空")
		return
	}
	if err := h.service.AcknowledgeConversationRead(r.Context(), principal.UserID, r.PathValue("id"), req.ThroughMessageID); err != nil {
		if errors.Is(err, conversationapp.ErrInvalidInput) {
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "已读确认参数无效")
			return
		}
		if errors.Is(err, conversationapp.ErrNotFound) {
			writeConvError(w, http.StatusNotFound, "NOT_FOUND", "会话或消息不存在")
			return
		}
		h.logError("acknowledge conversation read failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "确认会话已读失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type createConversationRequest struct {
	TargetID       string                         `json:"target_id"`
	Subject        string                         `json:"subject"`
	InitialMessage string                         `json:"initial_message"`
	Attachments    []messageattachment.Attachment `json:"attachments"`
}

func (h *Handler) createConversation(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	if !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var req createConversationRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &req) {
		return
	}
	if strings.TrimSpace(req.TargetID) == "" {
		writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "target_id 不能为空")
		return
	}
	response, err := h.service.CreateConversation(r.Context(), principal.UserID, principal.Role, req.TargetID, req.Subject, req.InitialMessage, req.Attachments)
	if err != nil {
		if errors.Is(err, conversationapp.ErrInvalidInput) {
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "target_id、subject 或 initial_message 长度或格式无效")
			return
		}
		if errors.Is(err, conversationapp.ErrForbidden) {
			writeConvError(w, http.StatusForbidden, "FORBIDDEN", "目标用户无效或无权创建会话")
			return
		}
		if errors.Is(err, conversationapp.ErrConflict) {
			writeConvError(w, http.StatusConflict, "CONFLICT", "会话已存在")
			return
		}
		if errors.Is(err, conversationapp.ErrNotFound) {
			writeConvError(w, http.StatusNotFound, "NOT_FOUND", "会话创建后已不存在")
			return
		}
		h.logError("create conversation failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建会话失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

type sendMessageRequest struct {
	Text        string                         `json:"text"`
	Attachments []messageattachment.Attachment `json:"attachments"`
}

func (h *Handler) sendMessage(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	if !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var req sendMessageRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &req) {
		return
	}
	if strings.TrimSpace(req.Text) == "" && len(req.Attachments) == 0 {
		writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "消息文字和附件不能同时为空")
		return
	}
	senderRole := string(principal.Role)
	response, err := h.service.SendMessage(r.Context(), r.PathValue("id"), principal.UserID, senderRole, req.Text, req.Attachments)
	if err != nil {
		if errors.Is(err, conversationapp.ErrInvalidInput) {
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "消息长度或格式无效")
			return
		}
		if errors.Is(err, conversationapp.ErrNotFound) {
			writeConvError(w, http.StatusNotFound, "NOT_FOUND", "会话不存在或无权发送消息")
			return
		}
		h.logError("send message failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "发送消息失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) archiveConversation(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	if !h.allowWrite(w, r, principal.UserID) {
		return
	}
	if err := h.service.ArchiveConversation(r.Context(), r.PathValue("id"), principal.UserID, principal.Role); err != nil {
		if errors.Is(err, conversationapp.ErrInvalidInput) {
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "会话 ID 无效")
			return
		}
		if errors.Is(err, conversationapp.ErrForbidden) {
			writeConvError(w, http.StatusForbidden, "FORBIDDEN", "无权归档会话")
			return
		}
		if errors.Is(err, conversationapp.ErrNotFound) {
			writeConvError(w, http.StatusNotFound, "NOT_FOUND", "会话不存在")
			return
		}
		h.logError("archive conversation failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "归档会话失败")
		return
	}
	httpjson.Write(w, http.StatusOK, map[string]string{"status": "archived"})
}

func (h *Handler) listTeacherContacts(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireStudent(w, r)
	if !ok {
		return
	}
	contacts, err := h.service.ListTeacherContacts(r.Context(), principal.UserID)
	if err != nil {
		h.logError("list teacher contacts failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取联系人失败")
		return
	}
	if contacts == nil {
		contacts = []conversationapp.Contact{}
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"contacts": contacts})
}

func (h *Handler) listStudentContacts(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	contacts, err := h.service.ListStudentContacts(r.Context(), principal.UserID)
	if err != nil {
		h.logError("list student contacts failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取联系人失败")
		return
	}
	if contacts == nil {
		contacts = []conversationapp.Contact{}
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"contacts": contacts})
}

func (h *Handler) searchUsers(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageUser(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		httpjson.Write(w, http.StatusOK, map[string]any{"contacts": []conversationapp.Contact{}})
		return
	}
	if h.searchLimiter != nil && !h.searchLimiter.Allow(r.Context(), principal.UserID) {
		w.Header().Set("Retry-After", "60")
		writeConvError(w, http.StatusTooManyRequests, "RATE_LIMITED", "联系人搜索过于频繁，请稍后重试")
		return
	}
	contacts, err := h.service.SearchContacts(r.Context(), q, principal.Role)
	if err != nil {
		if errors.Is(err, conversationapp.ErrInvalidInput) {
			writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "搜索词至少包含 2 个文字或数字，且不能超过 100 个字符")
			return
		}
		h.logError("search users failed", err)
		writeConvError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "搜索用户失败")
		return
	}
	if contacts == nil {
		contacts = []conversationapp.Contact{}
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"contacts": contacts})
}

func (h *Handler) allowWrite(w http.ResponseWriter, r *http.Request, userID string) bool {
	if h.writeLimiter == nil || h.writeLimiter.Allow(r.Context(), userID) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeConvError(w, http.StatusTooManyRequests, "RATE_LIMITED", "消息操作过于频繁，请稍后重试")
	return false
}

func (h *Handler) allowSearch(w http.ResponseWriter, r *http.Request, userID string) bool {
	if h.searchLimiter == nil || h.searchLimiter.Allow(r.Context(), userID) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeConvError(w, http.StatusTooManyRequests, "RATE_LIMITED", "消息搜索过于频繁，请稍后重试")
	return false
}

func parseBoundedInt(w http.ResponseWriter, raw string, fallback int, minValue int, maxValue int, name string) (int, bool) {
	value, err := httpquery.BoundedInt(raw, fallback, minValue, maxValue)
	if err != nil {
		writeConvError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", name+" 参数超出范围")
		return 0, false
	}
	return value, true
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

func (h *Handler) requireMessageUser(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken,
		func(principal authapp.Principal) bool {
			return authapp.HasAnyRole(principal, user.RoleStudent, user.RoleTeacher)
		},
		"权限不足，仅学生或教师可以访问消息中心", writeConvError,
		func(err error) { h.logError("validate active access token failed", err) },
	)
}

func (h *Handler) requireStudent(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, authapp.IsStudent,
		"权限不足，需要学生权限", writeConvError,
		func(err error) { h.logError("validate active access token failed", err) },
	)
}

func (h *Handler) requireTeacher(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken,
		func(principal authapp.Principal) bool { return principal.Role == user.RoleTeacher },
		"权限不足，需要教师权限", writeConvError,
		func(err error) { h.logError("validate active access token failed", err) },
	)
}

func (h *Handler) logError(message string, err error) {
	h.logger.Error(message, "error", redact.String(err.Error()))
}

func writeConvError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}
