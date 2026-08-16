package mistakehttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	authapp "mathstudy/backend/internal/application/auth"
	mistakeapp "mathstudy/backend/internal/application/mistake"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/httpquery"
	"mathstudy/backend/internal/platform/redact"
)

// Service is the mistake application surface used by HTTP handlers.
type Service interface {
	GetMistakes(context.Context, string, mistakeapp.ListQuery) (mistakeapp.MistakeListResponse, error)
	GetStatistics(context.Context, string, string) (mistakeapp.StatisticsResponse, error)
	GetMistakeDetail(context.Context, string, string) (mistakeapp.DetailResponse, error)
	MarkAsMastered(context.Context, string, string) (mistakeapp.MarkAsMasteredResponse, error)
	DeleteMistake(context.Context, string, string) (mistakeapp.DeleteResponse, error)
	GetReviewExercise(context.Context, string, string, string) (mistakeapp.ReviewExerciseResponse, error)
	GetReviewExerciseByAttempt(context.Context, string, string) (mistakeapp.ReviewExerciseResponse, error)
	GetReviewTasks(context.Context, string, mistakeapp.ReviewTaskQuery) (mistakeapp.ReviewTaskListResponse, error)
}

// Authenticator validates access tokens against current account state.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// Handler serves /mistakes endpoints.
type Handler struct {
	service Service
	auth    Authenticator
	logger  *slog.Logger
}

// NewHandler creates a mistake HTTP handler.
func NewHandler(logger *slog.Logger, service Service, auth Authenticator) (*Handler, error) {
	if service == nil {
		return nil, errors.New("mistake service is nil")
	}
	if auth == nil {
		return nil, errors.New("mistake authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{service: service, auth: auth, logger: logger}, nil
}

// Register attaches mistake routes under prefix, for example /api/v1/mistakes.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix, h.list)
	mux.HandleFunc("GET "+prefix+"/statistics", h.statistics)
	mux.HandleFunc("GET "+prefix+"/review/next", h.reviewNext)
	mux.HandleFunc("GET "+prefix+"/review-tasks", h.reviewTasks)
	mux.HandleFunc("GET "+prefix+"/{attempt_id}/review", h.reviewByAttempt)
	mux.HandleFunc("GET "+prefix+"/{attempt_id}", h.detail)
	mux.HandleFunc("POST "+prefix+"/{attempt_id}/master", h.markAsMastered)
	mux.HandleFunc("DELETE "+prefix+"/{attempt_id}", h.delete)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	query, ok := parseListQuery(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetMistakes(r.Context(), principal.UserID, query)
	if err != nil {
		h.logMistakeError("get mistake list failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "查询错题列表失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) statistics(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	timeRange := r.URL.Query().Get("time_range")
	if timeRange == "" {
		timeRange = "month"
	}
	response, err := h.service.GetStatistics(r.Context(), principal.UserID, timeRange)
	if err != nil {
		h.logMistakeError("get mistake statistics failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "查询错题统计失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) detail(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetMistakeDetail(r.Context(), principal.UserID, r.PathValue("attempt_id"))
	if err != nil {
		if errors.Is(err, mistakeapp.ErrNotFound) {
			writeMistakeError(w, http.StatusNotFound, "NOT_FOUND", "错题记录不存在")
			return
		}
		h.logMistakeError("get mistake detail failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "查询错题详情失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) markAsMastered(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	response, err := h.service.MarkAsMastered(r.Context(), principal.UserID, r.PathValue("attempt_id"))
	if err != nil {
		if errors.Is(err, mistakeapp.ErrNotFound) {
			writeMistakeError(w, http.StatusNotFound, "NOT_FOUND", "错题记录不存在")
			return
		}
		if errors.Is(err, mistakeapp.ErrProfileNotFound) {
			writeMistakeError(w, http.StatusNotFound, "NOT_FOUND", "学生画像不存在")
			return
		}
		if errors.Is(err, mistakeapp.ErrMasteryVerificationRequired) {
			writeMistakeError(w, http.StatusConflict, "VERIFICATION_REQUIRED", "请先完成复习验证，掌握度只由真实作答更新")
			return
		}
		h.logMistakeError("mark mistake as mastered failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "标记已掌握失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	response, err := h.service.DeleteMistake(r.Context(), principal.UserID, r.PathValue("attempt_id"))
	if err != nil {
		if errors.Is(err, mistakeapp.ErrNotFound) {
			writeMistakeError(w, http.StatusNotFound, "NOT_FOUND", "错题记录不存在")
			return
		}
		if errors.Is(err, mistakeapp.ErrDailyAttemptLocked) {
			writeMistakeError(w, http.StatusConflict, "DAILY_ATTEMPT_LOCKED", "每日一题作答记录不能删除")
			return
		}
		h.logMistakeError("delete mistake failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除错题失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) reviewNext(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	response, err := h.service.GetReviewExercise(r.Context(), principal.UserID, query.Get("focus_concept"), query.Get("focus_error_type"))
	if err != nil {
		if errors.Is(err, mistakeapp.ErrNotFound) {
			writeMistakeError(w, http.StatusNotFound, "NOT_FOUND", "没有可复习的错题")
			return
		}
		h.logMistakeError("get review exercise failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取复习题目失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) reviewByAttempt(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetReviewExerciseByAttempt(r.Context(), principal.UserID, r.PathValue("attempt_id"))
	if err != nil {
		if errors.Is(err, mistakeapp.ErrReviewNotDue) {
			writeMistakeError(w, http.StatusConflict, "REVIEW_NOT_DUE", "这道题还未到复习时间")
			return
		}
		if errors.Is(err, mistakeapp.ErrNotFound) {
			writeMistakeError(w, http.StatusNotFound, "NOT_FOUND", "错题记录不存在或不可重做")
			return
		}
		h.logMistakeError("get mistake review exercise failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取错题重做内容失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) reviewTasks(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	pagination, err := httpquery.Pagination(r.URL.Query(), 20, 100)
	if err != nil {
		writeMistakePaginationError(w, err)
		return
	}
	query := r.URL.Query()
	stage, ok := parseStageQuery(w, query.Get("stage"))
	if !ok {
		return
	}
	errorCountMin, ok := parseNonNegativeIntQuery(w, query.Get("error_count_min"), "error_count_min")
	if !ok {
		return
	}
	response, err := h.service.GetReviewTasks(r.Context(), principal.UserID, mistakeapp.ReviewTaskQuery{
		View:          query.Get("view"),
		Page:          pagination.Page,
		PageSize:      pagination.PageSize,
		ConceptID:     query.Get("concept_id"),
		ErrorType:     query.Get("error_type"),
		TaskID:        query.Get("task_id"),
		DueStatus:     query.Get("due_status"),
		Stage:         stage,
		ErrorCountMin: errorCountMin,
		Status:        firstNonEmptyQueryValue(query.Get("status"), query.Get("review_status")),
		SortBy:        query.Get("sort_by"),
		SortOrder:     query.Get("sort_order"),
	})
	if err != nil {
		h.logMistakeError("get mistake review tasks failed", err)
		writeMistakeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "查询复习任务失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) requirePrincipal(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, authapp.IsStudent,
		"权限不足，需要学生身份", writeMistakeError,
	)
}

func (h *Handler) logMistakeError(message string, err error) {
	h.logger.Error(message, "error", redact.String(err.Error()))
}

func parseListQuery(w http.ResponseWriter, r *http.Request) (mistakeapp.ListQuery, bool) {
	query := r.URL.Query()
	pagination, err := httpquery.Pagination(query, 20, 100)
	if err != nil {
		writeMistakePaginationError(w, err)
		return mistakeapp.ListQuery{}, false
	}
	difficultyMin, ok := parseFloatQuery(w, query.Get("difficulty_min"), 0.0, "difficulty_min")
	if !ok {
		return mistakeapp.ListQuery{}, false
	}
	difficultyMax, ok := parseFloatQuery(w, query.Get("difficulty_max"), 1.0, "difficulty_max")
	if !ok {
		return mistakeapp.ListQuery{}, false
	}
	dateFrom, ok := parseOptionalTimeQuery(w, query.Get("date_from"), "开始时间格式错误，请使用 ISO 8601 格式")
	if !ok {
		return mistakeapp.ListQuery{}, false
	}
	dateTo, ok := parseOptionalTimeQuery(w, query.Get("date_to"), "结束时间格式错误，请使用 ISO 8601 格式")
	if !ok {
		return mistakeapp.ListQuery{}, false
	}
	if difficultyMin < 0 || difficultyMin > 1 || difficultyMax < 0 || difficultyMax > 1 {
		writeMistakeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "difficulty 必须在 0 到 1 之间")
		return mistakeapp.ListQuery{}, false
	}
	masteryStatus := query.Get("mastery_status")
	if masteryStatus == "" {
		masteryStatus = "all"
	}
	sortBy := query.Get("sort_by")
	if sortBy == "" {
		sortBy = "time"
	}
	sortOrder := query.Get("sort_order")
	if sortOrder == "" {
		sortOrder = "desc"
	}
	stage, ok := parseStageQuery(w, query.Get("stage"))
	if !ok {
		return mistakeapp.ListQuery{}, false
	}
	errorCountMin, ok := parseNonNegativeIntQuery(w, query.Get("error_count_min"), "error_count_min")
	if !ok {
		return mistakeapp.ListQuery{}, false
	}
	return mistakeapp.ListQuery{
		Page:          pagination.Page,
		PageSize:      pagination.PageSize,
		ErrorType:     query.Get("error_type"),
		ConceptID:     query.Get("concept_id"),
		DifficultyMin: difficultyMin,
		DifficultyMax: difficultyMax,
		DateFrom:      dateFrom,
		DateTo:        dateTo,
		MasteryStatus: masteryStatus,
		ReviewStatus:  firstNonEmptyQueryValue(query.Get("review_status"), query.Get("status")),
		DueStatus:     query.Get("due_status"),
		Stage:         stage,
		ErrorCountMin: errorCountMin,
		SortBy:        sortBy,
		SortOrder:     sortOrder,
	}, true
}

func parseStageQuery(w http.ResponseWriter, value string) (*int, bool) {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" || value == "all" || value == "-1" {
		return nil, true
	}
	parsed, err := httpquery.Int(value, 0)
	if err != nil || parsed < 0 || parsed > 3 {
		writeMistakeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "stage 必须是 all、-1 或 0 到 3 之间的整数")
		return nil, false
	}
	return &parsed, true
}

func parseNonNegativeIntQuery(w http.ResponseWriter, value string, name string) (int, bool) {
	parsed, err := httpquery.Int(strings.TrimSpace(value), 0)
	if err != nil || parsed < 0 || parsed > 1_000_000 {
		writeMistakeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", name+" 必须是 0 到 1000000 之间的整数")
		return 0, false
	}
	return parsed, true
}

func firstNonEmptyQueryValue(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func writeMistakePaginationError(w http.ResponseWriter, err error) {
	writeMistakeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", httpquery.PaginationErrorMessage(err, 100))
}

func parseFloatQuery(w http.ResponseWriter, value string, fallback float64, name string) (float64, bool) {
	parsed, err := httpquery.Float(value, fallback)
	if err != nil {
		writeMistakeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", name+" 必须是数字")
		return 0, false
	}
	return parsed, true
}

func parseOptionalTimeQuery(w http.ResponseWriter, value string, message string) (*time.Time, bool) {
	parsed, err := httpquery.OptionalTime(
		value,
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999",
		"2006-01-02T15:04:05",
		"2006-01-02",
	)
	if err != nil {
		writeMistakeError(w, http.StatusBadRequest, "BAD_REQUEST", message)
		return nil, false
	}
	return parsed, true
}

func writeMistakeError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}
