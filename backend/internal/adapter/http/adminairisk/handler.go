package adminairiskhttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	airiskapp "mathstudy/backend/internal/application/airisk"
	authapp "mathstudy/backend/internal/application/auth"
	"mathstudy/backend/internal/domain/user"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/httpquery"
	"mathstudy/backend/internal/platform/redact"
)

const maxListPage = 100

// Service is the administrator AI risk-control application surface.
type Service interface {
	GetOverview(context.Context) (airiskapp.Overview, error)
	GetSettings(context.Context) (airiskapp.Settings, error)
	UpdateSettings(context.Context, airiskapp.UpdateSettingsRequest) (airiskapp.Settings, error)
	ListStudents(context.Context, airiskapp.StudentListFilter) (airiskapp.StudentListResponse, error)
	UpdateStudentAccess(context.Context, string, string, airiskapp.UpdateStudentAccessRequest) (airiskapp.StudentAccessResponse, error)
	ListRiskEvents(context.Context, airiskapp.EventListFilter) (airiskapp.EventListResponse, error)
}

// Authenticator decodes access tokens.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// Handler serves /admin/risk-control endpoints.
type Handler struct {
	service Service
	auth    Authenticator
	logger  *slog.Logger
}

// NewHandler creates an administrator AI risk-control handler.
func NewHandler(logger *slog.Logger, service Service, auth Authenticator) (*Handler, error) {
	if service == nil {
		return nil, errors.New("admin AI risk service is nil")
	}
	if auth == nil {
		return nil, errors.New("admin AI risk authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{service: service, auth: auth, logger: logger}, nil
}

// Register attaches risk-control routes under prefix.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/overview", h.overview)
	mux.HandleFunc("GET "+prefix+"/settings", h.getSettings)
	mux.HandleFunc("PUT "+prefix+"/settings", h.updateSettings)
	mux.HandleFunc("GET "+prefix+"/students", h.listStudents)
	mux.HandleFunc("PATCH "+prefix+"/students/{student_id}/access", h.updateStudentAccess)
	mux.HandleFunc("GET "+prefix+"/events", h.listEvents)
}

func (h *Handler) overview(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	response, err := h.service.GetOverview(r.Context())
	if err != nil {
		h.writeServiceError(w, err, "获取风控概览失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) getSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	response, err := h.service.GetSettings(r.Context())
	if err != nil {
		h.writeServiceError(w, err, "获取风控策略失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) updateSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	var request airiskapp.UpdateSettingsRequest
	if !httpjson.DecodeStrictOrDetailError(w, r, 1<<20, &request) {
		return
	}
	response, err := h.service.UpdateSettings(r.Context(), request)
	if err != nil {
		h.writeServiceError(w, err, "更新风控策略失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) listStudents(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	page, ok := boundedInt(w, r.URL.Query().Get("page"), 1, 1, maxListPage, "page")
	if !ok {
		return
	}
	pageSize, ok := boundedInt(w, r.URL.Query().Get("page_size"), 20, 1, 100, "page_size")
	if !ok {
		return
	}
	response, err := h.service.ListStudents(r.Context(), airiskapp.StudentListFilter{
		Page:     page,
		PageSize: pageSize,
		Search:   r.URL.Query().Get("search"),
		Status:   r.URL.Query().Get("status"),
	})
	if err != nil {
		h.writeServiceError(w, err, "获取学生 AI 使用状态失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) updateStudentAccess(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	var request airiskapp.UpdateStudentAccessRequest
	if !httpjson.DecodeStrictOrDetailError(w, r, 1<<20, &request) {
		return
	}
	response, err := h.service.UpdateStudentAccess(
		r.Context(),
		r.PathValue("student_id"),
		principal.UserID,
		request,
	)
	if err != nil {
		h.writeServiceError(w, err, "更新学生 AI 权限失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) listEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	page, ok := boundedInt(w, r.URL.Query().Get("page"), 1, 1, maxListPage, "page")
	if !ok {
		return
	}
	pageSize, ok := boundedInt(w, r.URL.Query().Get("page_size"), 20, 1, 100, "page_size")
	if !ok {
		return
	}
	response, err := h.service.ListRiskEvents(r.Context(), airiskapp.EventListFilter{
		Page:      page,
		PageSize:  pageSize,
		Search:    r.URL.Query().Get("search"),
		EventType: r.URL.Query().Get("event_type"),
	})
	if err != nil {
		h.writeServiceError(w, err, "获取风控事件失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w,
		r,
		h.auth.DecodeActiveAccessToken,
		func(principal authapp.Principal) bool { return principal.Role == user.RoleAdmin },
		"需要管理员权限",
		writeRiskError,
	)
}

func (h *Handler) writeServiceError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, airiskapp.ErrBadRequest):
		writeRiskError(w, http.StatusBadRequest, "BAD_REQUEST", redact.String(err.Error()))
	case errors.Is(err, airiskapp.ErrNotFound):
		writeRiskError(w, http.StatusNotFound, "NOT_FOUND", redact.String(err.Error()))
	default:
		h.logger.Error("admin AI risk request failed", "error", redact.String(err.Error()))
		writeRiskError(w, http.StatusInternalServerError, "INTERNAL_ERROR", fallback)
	}
}

func boundedInt(w http.ResponseWriter, value string, fallback, minValue, maxValue int, name string) (int, bool) {
	parsed, err := httpquery.BoundedInt(value, fallback, minValue, maxValue)
	if err != nil {
		writeRiskError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", name+" 参数超出范围")
		return 0, false
	}
	return parsed, true
}

func writeRiskError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}
