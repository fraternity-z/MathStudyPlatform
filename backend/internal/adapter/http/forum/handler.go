// Package forumhttp exposes the global forum HTTP API.
package forumhttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	authapp "mathstudy/backend/internal/application/auth"
	forumapp "mathstudy/backend/internal/application/forum"
	"mathstudy/backend/internal/application/messageattachment"
	"mathstudy/backend/internal/domain/user"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/httpquery"
	"mathstudy/backend/internal/platform/ratelimit"
	"mathstudy/backend/internal/platform/redact"
)

const (
	maxJSONBodyBytes = 1 << 20
	maxPageNumber    = 10000
)

type Service interface {
	ListBoards(context.Context, user.Role) ([]forumapp.Board, error)
	ListPosts(context.Context, string, user.Role, forumapp.ListPostsFilter) (forumapp.ListPostsResponse, error)
	GetPost(context.Context, string, string, user.Role, bool) (forumapp.PostDetail, error)
	CreatePost(context.Context, string, user.Role, forumapp.CreatePostInput) (forumapp.PostDetail, error)
	UpdatePost(context.Context, string, string, user.Role, forumapp.UpdatePostInput) (forumapp.PostDetail, error)
	DeletePost(context.Context, string, string, user.Role) error
	RestorePost(context.Context, string, user.Role) error
	HardDeletePost(context.Context, string, user.Role) error
	CreateReply(context.Context, string, string, user.Role, forumapp.CreateReplyInput) (forumapp.Reply, error)
	UpdateReply(context.Context, string, string, string, user.Role, forumapp.UpdateReplyInput) (forumapp.Reply, error)
	DeleteReply(context.Context, string, string, string, user.Role) error
	SetPostLike(context.Context, string, string, user.Role, bool) (forumapp.InteractionResult, error)
	SetPostFavorite(context.Context, string, string, user.Role, bool) (forumapp.InteractionResult, error)
	AcceptReply(context.Context, string, string, string, user.Role) (forumapp.PostDetail, error)
	SetFeatured(context.Context, string, string, user.Role, bool) (forumapp.PostDetail, error)
	CreateReport(context.Context, string, string, string, string, string, user.Role) (forumapp.Report, error)
	ListNotifications(context.Context, string, user.Role, bool, int, int) (forumapp.ListNotificationsResponse, error)
	MarkNotificationRead(context.Context, string, string, user.Role) error
	MarkPostNotificationsRead(context.Context, string, string, user.Role) (int, error)
	MarkAllNotificationsRead(context.Context, string, user.Role) (int, error)
	ListUnreadNotificationPostIDs(context.Context, string, user.Role) ([]string, error)
	ListReports(context.Context, user.Role, string, int, int) (forumapp.ListReportsResponse, error)
	ResolveReport(context.Context, string, user.Role, string, string) (forumapp.Report, error)
}

type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

type Handler struct {
	service       Service
	auth          Authenticator
	logger        *slog.Logger
	writeLimiter  *ratelimit.Limiter
	searchLimiter *ratelimit.Limiter
}

type Option func(*Handler)

func WithRateLimits(writeLimiter, searchLimiter *ratelimit.Limiter) Option {
	return func(handler *Handler) {
		handler.writeLimiter = writeLimiter
		handler.searchLimiter = searchLimiter
	}
}

func NewHandler(logger *slog.Logger, service Service, auth Authenticator, options ...Option) (*Handler, error) {
	if service == nil {
		return nil, errors.New("forum service is nil")
	}
	if auth == nil {
		return nil, errors.New("forum authenticator is nil")
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

func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/boards", h.listBoards)
	mux.HandleFunc("GET "+prefix+"/posts", h.listPosts)
	mux.HandleFunc("POST "+prefix+"/posts", h.createPost)
	mux.HandleFunc("GET "+prefix+"/posts/{id}", h.getPost)
	mux.HandleFunc("PATCH "+prefix+"/posts/{id}", h.updatePost)
	mux.HandleFunc("DELETE "+prefix+"/posts/{id}", h.deletePost)
	mux.HandleFunc("POST "+prefix+"/posts/{id}/restore", h.restorePost)
	mux.HandleFunc("DELETE "+prefix+"/posts/{id}/permanent", h.hardDeletePost)
	mux.HandleFunc("POST "+prefix+"/posts/{id}/replies", h.createReply)
	mux.HandleFunc("PATCH "+prefix+"/posts/{id}/replies/{reply_id}", h.updateReply)
	mux.HandleFunc("DELETE "+prefix+"/posts/{id}/replies/{reply_id}", h.deleteReply)
	mux.HandleFunc("POST "+prefix+"/posts/{id}/replies/{reply_id}/accept", h.acceptReply)
	mux.HandleFunc("POST "+prefix+"/posts/{id}/like", h.likePost)
	mux.HandleFunc("DELETE "+prefix+"/posts/{id}/like", h.unlikePost)
	mux.HandleFunc("POST "+prefix+"/posts/{id}/favorite", h.favoritePost)
	mux.HandleFunc("DELETE "+prefix+"/posts/{id}/favorite", h.unfavoritePost)
	mux.HandleFunc("POST "+prefix+"/posts/{id}/feature", h.featurePost)
	mux.HandleFunc("DELETE "+prefix+"/posts/{id}/feature", h.unfeaturePost)
	mux.HandleFunc("POST "+prefix+"/reports", h.createReport)
	mux.HandleFunc("GET "+prefix+"/notifications", h.listNotifications)
	mux.HandleFunc("GET "+prefix+"/notifications/unread-post-ids", h.listUnreadNotificationPostIDs)
	mux.HandleFunc("PUT "+prefix+"/notifications/read-all", h.markAllNotificationsRead)
	mux.HandleFunc("PUT "+prefix+"/notifications/posts/{post_id}/read", h.markPostNotificationsRead)
	mux.HandleFunc("PUT "+prefix+"/notifications/{id}/read", h.markNotificationRead)
	mux.HandleFunc("GET "+prefix+"/moderation/reports", h.listReports)
	mux.HandleFunc("PUT "+prefix+"/moderation/reports/{id}", h.resolveReport)
}

func (h *Handler) listBoards(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok {
		return
	}
	items, err := h.service.ListBoards(r.Context(), principal.Role)
	if err != nil {
		h.handleError(w, "list forum boards failed", err, "获取论坛板块失败")
		return
	}
	httpjson.Write(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) listPosts(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	page, ok := parseBoundedInt(w, query.Get("page"), 1, 1, maxPageNumber, "page")
	if !ok {
		return
	}
	pageSize, ok := parseBoundedInt(w, query.Get("page_size"), 20, 1, 100, "page_size")
	if !ok {
		return
	}
	search := query.Get("search")
	if strings.TrimSpace(search) != "" && !h.allowSearch(w, r, principal.UserID) {
		return
	}
	boardSlug := query.Get("board")
	if boardSlug == "" {
		boardSlug = query.Get("category")
	}
	response, err := h.service.ListPosts(r.Context(), principal.UserID, principal.Role, forumapp.ListPostsFilter{
		Search: search, BoardSlug: boardSlug, Type: forumapp.PostType(query.Get("type")),
		Status: query.Get("status"), Sort: query.Get("sort"), Scope: query.Get("scope"),
		Page: page, PageSize: pageSize,
	})
	if err != nil {
		h.handleError(w, "list forum posts failed", err, "获取帖子列表失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) getPost(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok {
		return
	}
	incrementView := principal.Role != user.RoleAdmin
	if raw := strings.TrimSpace(r.URL.Query().Get("increment_view")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			writeForumError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "increment_view 参数格式无效")
			return
		}
		incrementView = incrementView && parsed
	}
	response, err := h.service.GetPost(r.Context(), principal.UserID, r.PathValue("id"), principal.Role, incrementView)
	if err != nil {
		h.handleError(w, "get forum post failed", err, "获取帖子失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

type createPostRequest struct {
	BoardID         string                         `json:"board_id"`
	BoardSlug       string                         `json:"board_slug"`
	Category        string                         `json:"category"`
	Type            forumapp.PostType              `json:"type"`
	Title           string                         `json:"title"`
	Content         string                         `json:"content"`
	Attachments     []messageattachment.Attachment `json:"attachments"`
	Tags            []string                       `json:"tags"`
	KnowledgeNodeID string                         `json:"knowledge_node_id"`
}

func (h *Handler) createPost(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var request createPostRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &request) {
		return
	}
	if request.BoardSlug == "" {
		request.BoardSlug = request.Category
	}
	response, err := h.service.CreatePost(r.Context(), principal.UserID, principal.Role, forumapp.CreatePostInput{
		BoardID: request.BoardID, BoardSlug: request.BoardSlug, Type: request.Type,
		Title: request.Title, Content: request.Content, Attachments: request.Attachments,
		Tags: request.Tags, KnowledgeNodeID: request.KnowledgeNodeID,
	})
	if err != nil {
		h.handleError(w, "create forum post failed", err, "发布帖子失败")
		return
	}
	httpjson.Write(w, http.StatusCreated, response)
}

type updatePostRequest struct {
	BoardID         *string                         `json:"board_id"`
	BoardSlug       *string                         `json:"board_slug"`
	Category        *string                         `json:"category"`
	Type            *forumapp.PostType              `json:"type"`
	Title           *string                         `json:"title"`
	Content         *string                         `json:"content"`
	Attachments     *[]messageattachment.Attachment `json:"attachments"`
	Tags            *[]string                       `json:"tags"`
	KnowledgeNodeID *string                         `json:"knowledge_node_id"`
}

func (h *Handler) updatePost(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var request updatePostRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &request) {
		return
	}
	if request.BoardSlug == nil {
		request.BoardSlug = request.Category
	}
	response, err := h.service.UpdatePost(r.Context(), principal.UserID, r.PathValue("id"), principal.Role, forumapp.UpdatePostInput{
		BoardID: request.BoardID, BoardSlug: request.BoardSlug, Type: request.Type,
		Title: request.Title, Content: request.Content, Attachments: request.Attachments,
		Tags: request.Tags, KnowledgeNodeID: request.KnowledgeNodeID,
	})
	if err != nil {
		h.handleError(w, "update forum post failed", err, "更新帖子失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) deletePost(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	if err := h.service.DeletePost(r.Context(), principal.UserID, r.PathValue("id"), principal.Role); err != nil {
		h.handleError(w, "hide forum post failed", err, "设置帖子不可见失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) restorePost(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if ok && principal.Role != user.RoleAdmin {
		h.handleError(w, "restore forum post forbidden", forumapp.ErrForbidden, "恢复帖子可见需要管理员权限")
		return
	}
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	if err := h.service.RestorePost(r.Context(), r.PathValue("id"), principal.Role); err != nil {
		h.handleError(w, "restore forum post failed", err, "恢复帖子可见失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) hardDeletePost(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if ok && principal.Role != user.RoleAdmin {
		h.handleError(w, "hard delete forum post forbidden", forumapp.ErrForbidden, "永久删除帖子需要管理员权限")
		return
	}
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	if err := h.service.HardDeletePost(r.Context(), r.PathValue("id"), principal.Role); err != nil {
		h.handleError(w, "hard delete forum post failed", err, "永久删除帖子失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type createReplyRequest struct {
	ParentReplyID  string                         `json:"parent_reply_id"`
	Content        string                         `json:"content"`
	Attachments    []messageattachment.Attachment `json:"attachments"`
	MentionUserIDs []string                       `json:"mention_user_ids"`
}

func (h *Handler) createReply(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var request createReplyRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &request) {
		return
	}
	response, err := h.service.CreateReply(r.Context(), principal.UserID, r.PathValue("id"), principal.Role, forumapp.CreateReplyInput{
		ParentReplyID: request.ParentReplyID, Content: request.Content,
		Attachments: request.Attachments, MentionUserIDs: request.MentionUserIDs,
	})
	if err != nil {
		h.handleError(w, "create forum reply failed", err, "发布回复失败")
		return
	}
	httpjson.Write(w, http.StatusCreated, response)
}

type updateReplyRequest struct {
	Content     *string                         `json:"content"`
	Attachments *[]messageattachment.Attachment `json:"attachments"`
}

func (h *Handler) updateReply(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var request updateReplyRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &request) {
		return
	}
	response, err := h.service.UpdateReply(r.Context(), principal.UserID, r.PathValue("id"), r.PathValue("reply_id"), principal.Role, forumapp.UpdateReplyInput{
		Content: request.Content, Attachments: request.Attachments,
	})
	if err != nil {
		h.handleError(w, "update forum reply failed", err, "更新回复失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) deleteReply(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	if err := h.service.DeleteReply(r.Context(), principal.UserID, r.PathValue("id"), r.PathValue("reply_id"), principal.Role); err != nil {
		h.handleError(w, "delete forum reply failed", err, "删除回复失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) likePost(w http.ResponseWriter, r *http.Request) {
	h.toggleLike(w, r, true)
}

func (h *Handler) unlikePost(w http.ResponseWriter, r *http.Request) {
	h.toggleLike(w, r, false)
}

func (h *Handler) toggleLike(w http.ResponseWriter, r *http.Request, active bool) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	response, err := h.service.SetPostLike(r.Context(), principal.UserID, r.PathValue("id"), principal.Role, active)
	if err != nil {
		h.handleError(w, "toggle forum post like failed", err, "更新点赞失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) favoritePost(w http.ResponseWriter, r *http.Request) {
	h.toggleFavorite(w, r, true)
}

func (h *Handler) unfavoritePost(w http.ResponseWriter, r *http.Request) {
	h.toggleFavorite(w, r, false)
}

func (h *Handler) toggleFavorite(w http.ResponseWriter, r *http.Request, active bool) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	response, err := h.service.SetPostFavorite(r.Context(), principal.UserID, r.PathValue("id"), principal.Role, active)
	if err != nil {
		h.handleError(w, "toggle forum post favorite failed", err, "更新收藏失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) acceptReply(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	response, err := h.service.AcceptReply(r.Context(), principal.UserID, r.PathValue("id"), r.PathValue("reply_id"), principal.Role)
	if err != nil {
		h.handleError(w, "accept forum answer failed", err, "采纳回答失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) featurePost(w http.ResponseWriter, r *http.Request) {
	h.toggleFeature(w, r, true)
}

func (h *Handler) unfeaturePost(w http.ResponseWriter, r *http.Request) {
	h.toggleFeature(w, r, false)
}

func (h *Handler) toggleFeature(w http.ResponseWriter, r *http.Request, active bool) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	response, err := h.service.SetFeatured(r.Context(), principal.UserID, r.PathValue("id"), principal.Role, active)
	if err != nil {
		h.handleError(w, "toggle featured forum post failed", err, "更新精选状态失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

type createReportRequest struct {
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail"`
}

func (h *Handler) createReport(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var request createReportRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &request) {
		return
	}
	response, err := h.service.CreateReport(r.Context(), principal.UserID, request.TargetType, request.TargetID, request.Reason, request.Detail, principal.Role)
	if err != nil {
		h.handleError(w, "create forum report failed", err, "提交举报失败")
		return
	}
	httpjson.Write(w, http.StatusCreated, response)
}

func (h *Handler) listNotifications(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	page, ok := parseBoundedInt(w, query.Get("page"), 1, 1, maxPageNumber, "page")
	if !ok {
		return
	}
	pageSize, ok := parseBoundedInt(w, query.Get("page_size"), 20, 1, 100, "page_size")
	if !ok {
		return
	}
	unreadOnly := query.Get("unread_only") == "true"
	response, err := h.service.ListNotifications(r.Context(), principal.UserID, principal.Role, unreadOnly, page, pageSize)
	if err != nil {
		h.handleError(w, "list forum notifications failed", err, "获取论坛互动失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) markNotificationRead(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	if err := h.service.MarkNotificationRead(r.Context(), principal.UserID, r.PathValue("id"), principal.Role); err != nil {
		h.handleError(w, "mark forum notification read failed", err, "标记论坛互动已读失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) markPostNotificationsRead(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	count, err := h.service.MarkPostNotificationsRead(r.Context(), principal.UserID, r.PathValue("post_id"), principal.Role)
	if err != nil {
		h.handleError(w, "mark forum post notifications read failed", err, "标记帖子互动已读失败")
		return
	}
	httpjson.Write(w, http.StatusOK, map[string]int{"updated_count": count})
}

func (h *Handler) listUnreadNotificationPostIDs(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok {
		return
	}
	items, err := h.service.ListUnreadNotificationPostIDs(r.Context(), principal.UserID, principal.Role)
	if err != nil {
		h.handleError(w, "list unread forum notification post ids failed", err, "获取未读帖子失败")
		return
	}
	httpjson.Write(w, http.StatusOK, map[string][]string{"post_ids": items})
}

func (h *Handler) markAllNotificationsRead(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	count, err := h.service.MarkAllNotificationsRead(r.Context(), principal.UserID, principal.Role)
	if err != nil {
		h.handleError(w, "mark all forum notifications read failed", err, "全部标记已读失败")
		return
	}
	httpjson.Write(w, http.StatusOK, map[string]int{"updated_count": count})
}

func (h *Handler) listReports(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	page, ok := parseBoundedInt(w, query.Get("page"), 1, 1, maxPageNumber, "page")
	if !ok {
		return
	}
	pageSize, ok := parseBoundedInt(w, query.Get("page_size"), 20, 1, 100, "page_size")
	if !ok {
		return
	}
	response, err := h.service.ListReports(r.Context(), principal.Role, query.Get("status"), page, pageSize)
	if err != nil {
		h.handleError(w, "list forum reports failed", err, "获取论坛举报失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

type resolveReportRequest struct {
	Status string `json:"status"`
}

func (h *Handler) resolveReport(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireForumUser(w, r)
	if !ok || !h.allowWrite(w, r, principal.UserID) {
		return
	}
	var request resolveReportRequest
	if !httpjson.DecodeStrictOrBadRequest(w, r, maxJSONBodyBytes, &request) {
		return
	}
	response, err := h.service.ResolveReport(r.Context(), principal.UserID, principal.Role, r.PathValue("id"), request.Status)
	if err != nil {
		h.handleError(w, "resolve forum report failed", err, "处理论坛举报失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) requireForumUser(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken,
		func(principal authapp.Principal) bool {
			return authapp.HasAnyRole(principal, user.RoleStudent, user.RoleTeacher, user.RoleAdmin)
		},
		"权限不足，需要登录后访问论坛", writeForumError,
		func(err error) { h.logError("validate active access token failed", err) },
	)
}

func (h *Handler) allowWrite(w http.ResponseWriter, r *http.Request, userID string) bool {
	if h.writeLimiter == nil || h.writeLimiter.Allow(r.Context(), userID) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeForumError(w, http.StatusTooManyRequests, "RATE_LIMITED", "论坛操作过于频繁，请稍后重试")
	return false
}

func (h *Handler) allowSearch(w http.ResponseWriter, r *http.Request, userID string) bool {
	if h.searchLimiter == nil || h.searchLimiter.Allow(r.Context(), userID) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeForumError(w, http.StatusTooManyRequests, "RATE_LIMITED", "论坛搜索过于频繁，请稍后重试")
	return false
}

func (h *Handler) handleError(w http.ResponseWriter, logMessage string, err error, fallback string) {
	switch {
	case errors.Is(err, forumapp.ErrInvalidInput):
		writeForumError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请求参数长度或格式无效")
	case errors.Is(err, forumapp.ErrForbidden):
		writeForumError(w, http.StatusForbidden, "FORBIDDEN", "无权执行该论坛操作")
	case errors.Is(err, forumapp.ErrNotFound):
		writeForumError(w, http.StatusNotFound, "NOT_FOUND", "论坛内容不存在")
	case errors.Is(err, forumapp.ErrConflict):
		writeForumError(w, http.StatusConflict, "CONFLICT", "请勿重复提交")
	default:
		h.logError(logMessage, err)
		writeForumError(w, http.StatusInternalServerError, "INTERNAL_ERROR", fallback)
	}
}

func (h *Handler) logError(message string, err error) {
	h.logger.Error(message, "error", redact.String(err.Error()))
}

func parseBoundedInt(w http.ResponseWriter, raw string, fallback, minValue, maxValue int, name string) (int, bool) {
	value, err := httpquery.BoundedInt(raw, fallback, minValue, maxValue)
	if err != nil {
		writeForumError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", name+" 参数超出范围")
		return 0, false
	}
	return value, true
}

func writeForumError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}
