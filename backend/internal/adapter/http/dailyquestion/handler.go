// Package dailyquestionhttp exposes student and teacher daily-question routes.
package dailyquestionhttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	airiskapp "mathstudy/backend/internal/application/airisk"
	authapp "mathstudy/backend/internal/application/auth"
	dailyquestionapp "mathstudy/backend/internal/application/dailyquestion"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/redact"
)

// Service is the daily-question application surface used by HTTP handlers.
type Service interface {
	GetToday(context.Context, string) (dailyquestionapp.TodayResponse, error)
	PrepareToday(context.Context, string) (dailyquestionapp.TodayResponse, error)
	GetHistory(context.Context, string, dailyquestionapp.HistoryQuery) (dailyquestionapp.HistoryResponse, error)
	GetDate(context.Context, string, string) (dailyquestionapp.TodayResponse, error)
	GetClassSettings(context.Context, string, string) (dailyquestionapp.ClassSettings, error)
	SetClassSettings(context.Context, string, string, *string, *bool) (dailyquestionapp.ClassSettings, error)
	GetClassUniformSchedule(context.Context, string, string) (dailyquestionapp.ClassUniformSchedule, error)
	ReplaceClassUniformSchedule(context.Context, string, string, int64, []string) (dailyquestionapp.ClassUniformSchedule, error)
	GetClassStatistics(context.Context, string, string, string) (dailyquestionapp.ClassStatistics, error)
	SendClassReminder(context.Context, string, string, string) (dailyquestionapp.ReminderResult, error)
}

// Authenticator validates access tokens against current account state.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// Handler serves /daily-question endpoints.
type Handler struct {
	service Service
	auth    Authenticator
	logger  *slog.Logger
}

// NewHandler creates a daily-question HTTP handler.
func NewHandler(logger *slog.Logger, service Service, auth Authenticator) (*Handler, error) {
	if service == nil {
		return nil, errors.New("daily question service is nil")
	}
	if auth == nil {
		return nil, errors.New("daily question authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{service: service, auth: auth, logger: logger}, nil
}

// Register attaches routes under prefix, for example /api/v1/daily-question.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/today", h.today)
	mux.HandleFunc("POST "+prefix+"/today/prepare", h.prepare)
	mux.HandleFunc("GET "+prefix+"/history", h.history)
	mux.HandleFunc("GET "+prefix+"/{date}", h.byDate)

	mux.HandleFunc("GET "+prefix+"/teacher/classes/{class_id}/settings", h.classSettings)
	mux.HandleFunc("PUT "+prefix+"/teacher/classes/{class_id}/settings", h.setClassSettings)
	mux.HandleFunc("GET "+prefix+"/teacher/classes/{class_id}/uniform-schedule", h.classUniformSchedule)
	mux.HandleFunc("PUT "+prefix+"/teacher/classes/{class_id}/uniform-schedule", h.replaceClassUniformSchedule)
	mux.HandleFunc("GET "+prefix+"/teacher/classes/{class_id}/statistics", h.classStatistics)
	mux.HandleFunc("POST "+prefix+"/teacher/classes/{class_id}/reminders", h.classReminder)
}

type classSettingsRequest struct {
	Strategy            *string `json:"strategy"`
	AutoReminderEnabled *bool   `json:"auto_reminder_enabled"`
}

type classReminderRequest struct {
	Date string `json:"date"`
}

type classUniformScheduleRequest struct {
	ScheduleVersion *int64   `json:"schedule_version"`
	ContentIDs      []string `json:"content_ids"`
}

func (h *Handler) today(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireStudent(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetToday(r.Context(), principal.UserID)
	if err != nil {
		h.writeServiceError(w, err, "获取今日一题失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) prepare(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireStudent(w, r)
	if !ok {
		return
	}
	response, err := h.service.PrepareToday(r.Context(), principal.UserID)
	if err != nil {
		h.writeServiceError(w, err, "准备今日一题失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) history(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireStudent(w, r)
	if !ok {
		return
	}
	query := dailyquestionapp.HistoryQuery{Month: strings.TrimSpace(r.URL.Query().Get("month"))}
	if rawDays := strings.TrimSpace(r.URL.Query().Get("days")); rawDays != "" {
		days, err := strconv.Atoi(rawDays)
		if err != nil || days < 1 {
			writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "days 必须是正整数")
			return
		}
		query.Days = days
	}
	response, err := h.service.GetHistory(r.Context(), principal.UserID, query)
	if err != nil {
		h.writeServiceError(w, err, "获取每日一题历史失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) byDate(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireStudent(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetDate(r.Context(), principal.UserID, r.PathValue("date"))
	if err != nil {
		h.writeServiceError(w, err, "获取每日一题失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) classSettings(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	classID := r.PathValue("class_id")
	if !dailyquestionapp.ValidIdentifier(classID) {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "class_id 无效")
		return
	}
	response, err := h.service.GetClassSettings(r.Context(), principal.UserID, classID)
	if err != nil {
		h.writeServiceError(w, err, "获取每日题策略失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) setClassSettings(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	classID := r.PathValue("class_id")
	if !dailyquestionapp.ValidIdentifier(classID) {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "class_id 无效")
		return
	}
	var request classSettingsRequest
	if !httpjson.DecodeStrictOrDetailError(w, r, 1<<20, &request) {
		return
	}
	if request.Strategy == nil && request.AutoReminderEnabled == nil {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "至少提供 strategy 或 auto_reminder_enabled")
		return
	}
	response, err := h.service.SetClassSettings(
		r.Context(),
		principal.UserID,
		classID,
		request.Strategy,
		request.AutoReminderEnabled,
	)
	if err != nil {
		h.writeServiceError(w, err, "保存每日题策略失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) classUniformSchedule(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	classID := r.PathValue("class_id")
	if !dailyquestionapp.ValidIdentifier(classID) {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "class_id 无效")
		return
	}
	response, err := h.service.GetClassUniformSchedule(r.Context(), principal.UserID, classID)
	if err != nil {
		h.writeServiceError(w, err, "获取班级统一题计划失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) replaceClassUniformSchedule(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	classID := r.PathValue("class_id")
	if !dailyquestionapp.ValidIdentifier(classID) {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "class_id 无效")
		return
	}
	var request classUniformScheduleRequest
	if !httpjson.DecodeStrictOrDetailError(w, r, 1<<20, &request) {
		return
	}
	if request.ScheduleVersion == nil || *request.ScheduleVersion < 0 || request.ContentIDs == nil || len(request.ContentIDs) > dailyquestionapp.MaxUniformScheduleItems {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "schedule_version 和 content_ids 无效")
		return
	}
	response, err := h.service.ReplaceClassUniformSchedule(
		r.Context(),
		principal.UserID,
		classID,
		*request.ScheduleVersion,
		request.ContentIDs,
	)
	if err != nil {
		h.writeServiceError(w, err, "保存班级统一题计划失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) classStatistics(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	classID := r.PathValue("class_id")
	if !dailyquestionapp.ValidIdentifier(classID) {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "class_id 无效")
		return
	}
	response, err := h.service.GetClassStatistics(
		r.Context(), principal.UserID, classID, r.URL.Query().Get("date"),
	)
	if err != nil {
		h.writeServiceError(w, err, "获取每日题班级统计失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) classReminder(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	classID := r.PathValue("class_id")
	if !dailyquestionapp.ValidIdentifier(classID) {
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "class_id 无效")
		return
	}
	var request classReminderRequest
	if r.ContentLength != 0 && !httpjson.DecodeStrictOrDetailError(w, r, 1<<20, &request) {
		return
	}
	response, err := h.service.SendClassReminder(r.Context(), principal.UserID, classID, request.Date)
	if err != nil {
		h.writeServiceError(w, err, "发送每日题提醒失败")
		return
	}
	status := http.StatusOK
	if response.Created {
		status = http.StatusCreated
	}
	httpjson.Write(w, status, response)
}

func (h *Handler) requireStudent(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, authapp.IsStudent,
		"权限不足，仅学生可以访问每日一题", writeDailyQuestionError,
	)
}

func (h *Handler) requireTeacher(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, authapp.IsTeacherOrAdmin,
		"权限不足，需要教师权限", writeDailyQuestionError,
	)
}

func (h *Handler) writeServiceError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, context.Canceled):
		h.logger.Debug("daily question request canceled")
		return
	case errors.Is(err, context.DeadlineExceeded):
		writeDailyQuestionError(w, http.StatusGatewayTimeout, "REQUEST_TIMEOUT", "请求处理超时，请稍后重试")
		return
	case errors.Is(err, dailyquestionapp.ErrNotFound):
		writeDailyQuestionError(w, http.StatusNotFound, "NOT_FOUND", "每日一题或班级不存在")
		return
	case errors.Is(err, dailyquestionapp.ErrInvalidDate), errors.Is(err, dailyquestionapp.ErrInvalidMonth),
		errors.Is(err, dailyquestionapp.ErrInvalidDays), errors.Is(err, dailyquestionapp.ErrInvalidStrategy):
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "日期、月份、天数或策略参数无效")
		return
	case errors.Is(err, dailyquestionapp.ErrInvalidContent):
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "题目参数无效")
		return
	case errors.Is(err, dailyquestionapp.ErrDuplicateQuestion):
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "DAILY_QUESTION_DUPLICATE", "每日题日程或学生历史题目中不能重复安排相同或高度相似的题目")
		return
	case errors.Is(err, dailyquestionapp.ErrSelectionLocked):
		writeDailyQuestionError(w, http.StatusConflict, "UNIFORM_QUESTION_LOCKED", "已有学生获得对应日期题目，不能删除、移动或更换")
		return
	case errors.Is(err, dailyquestionapp.ErrUniformScheduleChanged):
		writeDailyQuestionError(w, http.StatusConflict, "UNIFORM_SCHEDULE_CHANGED", "统一题日程已被其他页面修改，请刷新后重新操作")
		return
	case errors.Is(err, dailyquestionapp.ErrUniformQuestionNotAssigned):
		writeDailyQuestionError(w, http.StatusConflict, "UNIFORM_QUESTION_NOT_ASSIGNED", "今日没有可作答的班级统一题")
		return
	case errors.Is(err, dailyquestionapp.ErrStrategyChanged):
		writeDailyQuestionError(w, http.StatusConflict, "DAILY_QUESTION_STRATEGY_CHANGED", "班级分配策略刚刚发生变化，请重试")
		return
	case errors.Is(err, dailyquestionapp.ErrForbidden):
		writeDailyQuestionError(w, http.StatusForbidden, "FORBIDDEN", "无权访问该每日一题资源")
		return
	case errors.Is(err, dailyquestionapp.ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		writeDailyQuestionError(w, http.StatusTooManyRequests, "RATE_LIMITED", "AI 出题过于频繁，请稍后重试")
		return
	case errors.Is(err, dailyquestionapp.ErrReminderUnavailable):
		writeDailyQuestionError(w, http.StatusServiceUnavailable, "WECHAT_REMINDER_UNAVAILABLE", "微信公众号提醒尚未配置，暂时无法发送")
		return
	case writeAIRiskError(w, err):
		return
	default:
		h.logger.Error("daily question request failed", "error", redact.String(err.Error()))
		writeDailyQuestionError(w, http.StatusInternalServerError, "INTERNAL_ERROR", fallback)
	}
}

func writeAIRiskError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, airiskapp.ErrAccessBlocked):
		writeDailyQuestionError(w, http.StatusForbidden, "AI_ACCESS_BLOCKED", err.Error())
	case errors.Is(err, airiskapp.ErrContentBlocked):
		writeDailyQuestionError(w, http.StatusUnprocessableEntity, "AI_CONTENT_BLOCKED", err.Error())
	case errors.Is(err, airiskapp.ErrQuotaExceeded):
		writeDailyQuestionError(w, http.StatusTooManyRequests, "AI_DAILY_QUOTA_EXCEEDED", err.Error())
	case errors.Is(err, airiskapp.ErrConcurrencyExceeded):
		writeDailyQuestionError(w, http.StatusTooManyRequests, "AI_CONCURRENCY_LIMIT", err.Error())
	case errors.Is(err, airiskapp.ErrUnavailable):
		writeDailyQuestionError(w, http.StatusServiceUnavailable, "AI_GUARD_UNAVAILABLE", "AI 风控服务暂不可用，请稍后重试")
	default:
		return false
	}
	return true
}

func writeDailyQuestionError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}
