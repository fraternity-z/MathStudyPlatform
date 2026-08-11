package teacherhttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	authapp "mathstudy/backend/internal/application/auth"
	teacherapp "mathstudy/backend/internal/application/teacher"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/httpquery"
	"mathstudy/backend/internal/platform/redact"
)

const maxStudentListPage = 100

// Service is the teacher application surface used by HTTP handlers.
type Service interface {
	GetDashboardStats(context.Context, string) (teacherapp.DashboardStats, error)
	GetStudentsStats(context.Context, string) (teacherapp.StudentsStats, error)
	ListStudents(context.Context, string, teacherapp.StudentListFilter) (teacherapp.StudentListResponse, error)
	GetAnalytics(context.Context, string, string) (teacherapp.AnalyticsResponse, error)
	GetClassAnalytics(context.Context, string, string) (teacherapp.ClassAnalyticsResponse, error)
	GetStudentDetail(context.Context, string, string) (teacherapp.StudentDetailResponse, error)
}

// Authenticator validates access tokens against current account state.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// Handler serves /teacher endpoints.
type Handler struct {
	service Service
	auth    Authenticator
	logger  *slog.Logger
}

// NewHandler creates a teacher HTTP handler.
func NewHandler(logger *slog.Logger, service Service, auth Authenticator) (*Handler, error) {
	if service == nil {
		return nil, errors.New("teacher service is nil")
	}
	if auth == nil {
		return nil, errors.New("teacher authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{service: service, auth: auth, logger: logger}, nil
}

// Register attaches teacher routes under prefix, for example /api/v1/teacher.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/dashboard/stats", h.dashboardStats)
	mux.HandleFunc("GET "+prefix+"/students/stats", h.studentsStats)
	mux.HandleFunc("GET "+prefix+"/students", h.students)
	mux.HandleFunc("GET "+prefix+"/analytics", h.analytics)
	mux.HandleFunc("GET "+prefix+"/classes/{class_id}/analytics", h.classAnalytics)
	mux.HandleFunc("GET "+prefix+"/students/{student_id}/detail", h.studentDetail)
}

func (h *Handler) dashboardStats(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetDashboardStats(r.Context(), principal.UserID)
	if err != nil {
		h.logTeacherError("get teacher dashboard stats failed", err)
		writeTeacherError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取教师工作台统计失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) studentsStats(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetStudentsStats(r.Context(), principal.UserID)
	if err != nil {
		h.logTeacherError("get teacher students stats failed", err)
		writeTeacherError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取学生管理统计失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) students(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	page, ok := parsePositiveIntQuery(w, query.Get("page"), 1, "page")
	if !ok {
		return
	}
	if page > maxStudentListPage {
		writeTeacherError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "page 必须在 1 到 100 之间")
		return
	}
	pageSize, ok := parsePositiveIntQuery(w, query.Get("page_size"), 20, "page_size")
	if !ok {
		return
	}
	if pageSize > 100 {
		writeTeacherError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "page_size 必须在 1 到 100 之间")
		return
	}
	response, err := h.service.ListStudents(r.Context(), principal.UserID, teacherapp.StudentListFilter{
		ClassID:  query.Get("class_id"),
		Search:   query.Get("search"),
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		if errors.Is(err, teacherapp.ErrBadRequest) {
			writeTeacherError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "分页参数超出范围")
			return
		}
		h.logTeacherError("list teacher students failed", err)
		writeTeacherError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取学生列表失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) analytics(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	timeRange := r.URL.Query().Get("time_range")
	if timeRange == "" {
		timeRange = "week"
	}
	if !validTimeRange(timeRange) {
		writeTeacherError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "time_range 必须是 today、week、month 或 semester")
		return
	}
	response, err := h.service.GetAnalytics(r.Context(), principal.UserID, timeRange)
	if err != nil {
		if errors.Is(err, teacherapp.ErrBadRequest) {
			writeTeacherError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "time_range 必须是 today、week、month 或 semester")
			return
		}
		h.logTeacherError("get teacher analytics failed", err)
		writeTeacherError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取教师数据分析失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) classAnalytics(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetClassAnalytics(r.Context(), principal.UserID, r.PathValue("class_id"))
	if err != nil {
		if errors.Is(err, teacherapp.ErrNotFound) {
			writeTeacherError(w, http.StatusNotFound, "NOT_FOUND", "班级不存在或无权限访问")
			return
		}
		h.logTeacherError("get class analytics failed", err)
		writeTeacherError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取班级分析失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) studentDetail(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetStudentDetail(r.Context(), principal.UserID, r.PathValue("student_id"))
	if err != nil {
		if errors.Is(err, teacherapp.ErrNotFound) {
			writeTeacherError(w, http.StatusNotFound, "NOT_FOUND", "学生不存在或无权限访问")
			return
		}
		if errors.Is(err, teacherapp.ErrStudentNotFound) {
			writeTeacherError(w, http.StatusNotFound, "NOT_FOUND", "学生不存在")
			return
		}
		h.logTeacherError("get student detail failed", err)
		writeTeacherError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取学生详情失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) requireTeacher(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, authapp.IsTeacherOrAdmin,
		"权限不足，需要教师权限", writeTeacherError,
	)
}

func (h *Handler) logTeacherError(message string, err error) {
	h.logger.Error(message, "error", redact.String(err.Error()))
}

func parsePositiveIntQuery(w http.ResponseWriter, raw string, fallback int, name string) (int, bool) {
	if strings.TrimSpace(raw) == "" {
		return fallback, true
	}
	value, err := httpquery.Int(raw, fallback)
	if err != nil {
		writeTeacherError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", name+" 必须是整数")
		return 0, false
	}
	if value < 1 {
		writeTeacherError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", name+" 必须大于等于 1")
		return 0, false
	}
	return value, true
}

func validTimeRange(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "today", "week", "month", "semester":
		return true
	default:
		return false
	}
}

func writeTeacherError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}
