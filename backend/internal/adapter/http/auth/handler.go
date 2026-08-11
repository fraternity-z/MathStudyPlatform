package authhttp

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	authapp "mathstudy/backend/internal/application/auth"
	"mathstudy/backend/internal/domain/user"
	"mathstudy/backend/internal/platform/config"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/redact"
	"mathstudy/backend/internal/platform/securerand"
)

const (
	refreshCookieName = "refresh_token"
	csrfCookieName    = "csrf_token"
	csrfHeaderName    = "X-CSRF-Token"
	csrfTokenBytes    = 32
)

// Service is the auth application surface used by HTTP handlers.
type Service interface {
	Authenticate(context.Context, string, string) (authapp.AuthResult, error)
	Register(context.Context, string, string, string, string) (authapp.AuthResult, error)
	ChangePassword(context.Context, string, string, string) (bool, string, error)
	GetUserByID(context.Context, string) (user.User, bool, error)
	RefreshTokens(context.Context, authapp.RefreshPrincipal) (string, string, bool, error)
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
	DecodeRefreshToken(string) (authapp.RefreshPrincipal, string, bool)
	RevokeRefreshToken(context.Context, string) error
	RegistrationSettings(context.Context) (authapp.RegistrationSettings, error)
	SubmitPasswordReset(context.Context, string, string, string) (authapp.PasswordResetResult, error)
	PasswordResetStatus(context.Context, string, string) (authapp.PasswordResetStatus, error)
}

// CaptchaService is the pre-authentication human verification boundary.
type CaptchaService interface {
	NewChallenge(context.Context, string) (authapp.SliderCaptchaChallenge, error)
	Verify(context.Context, string, int, string) (string, bool, error)
	ConsumeProof(context.Context, string, string) (bool, error)
	ProofTTL() time.Duration
	IssueWindow() time.Duration
}

// Handler serves /auth endpoints.
type Handler struct {
	service       Service
	captcha       CaptchaService
	logger        *slog.Logger
	accessMaxAge  int
	refreshMaxAge int
	cookieSecure  bool
	cookiePath    string
	csrfPath      string
}

// NewHandler creates an auth HTTP handler with Python-compatible cookie behavior.
func NewHandler(cfg config.Config, logger *slog.Logger, service Service, captcha CaptchaService) (*Handler, error) {
	if service == nil {
		return nil, errors.New("auth service is nil")
	}
	if captcha == nil {
		return nil, errors.New("auth captcha service is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{
		service:       service,
		captcha:       captcha,
		logger:        logger,
		accessMaxAge:  int(cfg.JWTAccessTokenExpire / time.Second),
		refreshMaxAge: int(cfg.JWTRefreshTokenExpire / time.Second),
		cookieSecure:  cfg.Environment != "development",
		cookiePath:    cfg.APIV1Prefix + "/auth",
		csrfPath:      "/",
	}, nil
}

// Register attaches auth routes under prefix, for example /api/v1/auth.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/captcha", h.captchaChallenge)
	mux.HandleFunc("POST "+prefix+"/captcha/verify", h.verifyCaptcha)
	mux.HandleFunc("POST "+prefix+"/login", h.login)
	mux.HandleFunc("PUT "+prefix+"/change-password", h.changePassword)
	mux.HandleFunc("POST "+prefix+"/register", h.register)
	mux.HandleFunc("POST "+prefix+"/refresh", h.refresh)
	mux.HandleFunc("POST "+prefix+"/logout", h.logout)
	mux.HandleFunc("GET "+prefix+"/me", h.me)
	mux.HandleFunc("GET "+prefix+"/registration-status", h.registrationStatus)
	mux.HandleFunc("POST "+prefix+"/forgot-password", h.forgotPassword)
	mux.HandleFunc("GET "+prefix+"/forgot-password/status", h.forgotPasswordStatus)
}

type loginRequest struct {
	Username     string `json:"username"`
	Password     string `json:"password"`
	CaptchaToken string `json:"captcha_token"`
}

type verifyCaptchaRequest struct {
	CaptchaID string `json:"captcha_id"`
	Position  *int   `json:"position"`
}

type verifyCaptchaResponse struct {
	CaptchaToken string `json:"captcha_token"`
	ExpiresIn    int    `json:"expires_in"`
}

type registerRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

type changePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

type forgotPasswordRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Reason   string `json:"reason"`
}

type loginResponse struct {
	AccessToken string       `json:"access_token"`
	TokenType   string       `json:"token_type"`
	User        userResponse `json:"user"`
}

type refreshResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
}

type userResponse struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email"`
	Role     string `json:"role"`
}

type messageResponse struct {
	Message string `json:"message"`
}

type registrationStatusResponse struct {
	AllowStudent bool `json:"allow_student"`
	AllowTeacher bool `json:"allow_teacher"`
}

type forgotPasswordResponse struct {
	Success   bool    `json:"success"`
	Message   string  `json:"message"`
	RequestID *string `json:"request_id"`
}

type forgotPasswordStatusResponse struct {
	HasPending bool    `json:"has_pending"`
	Status     *string `json:"status"`
	CreatedAt  *string `json:"created_at"`
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var request loginRequest
	if !decodeRequest(w, r, &request) {
		return
	}
	verified, err := h.captcha.ConsumeProof(r.Context(), request.CaptchaToken, captchaClientKey(r))
	if err != nil {
		h.logger.Error("consume login captcha proof failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusServiceUnavailable, "CAPTCHA_UNAVAILABLE", "安全验证暂不可用，请稍后重试")
		return
	}
	if !verified {
		writeAuthError(w, http.StatusBadRequest, "CAPTCHA_REQUIRED", "请先完成滑块验证")
		return
	}
	result, err := h.service.Authenticate(r.Context(), request.Username, request.Password)
	if err != nil {
		h.logger.Error("login failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "登录失败，请稍后重试")
		return
	}
	if !result.Success {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeAuthError(w, http.StatusUnauthorized, "UNAUTHORIZED", result.Error)
		return
	}
	if !h.setAuthCookies(w, result.AccessToken, result.RefreshToken) {
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "登录成功但未能生成安全凭证，请稍后重试")
		return
	}
	httpjson.Write(w, http.StatusOK, loginResponse{
		AccessToken: result.AccessToken,
		TokenType:   "bearer",
		User:        toUserResponse(result.User),
	})
}

func (h *Handler) captchaChallenge(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	challenge, err := h.captcha.NewChallenge(r.Context(), captchaClientKey(r))
	if err == nil {
		httpjson.Write(w, http.StatusOK, challenge)
		return
	}
	if errors.Is(err, authapp.ErrCaptchaRateLimited) {
		retryAfter := int(h.captcha.IssueWindow() / time.Second)
		if retryAfter < 1 {
			retryAfter = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeAuthError(w, http.StatusTooManyRequests, "CAPTCHA_RATE_LIMITED", "验证码请求过于频繁，请稍后重试")
		return
	}
	h.logger.Error("create login captcha failed", "error", redact.String(err.Error()))
	writeAuthError(w, http.StatusServiceUnavailable, "CAPTCHA_UNAVAILABLE", "安全验证暂不可用，请稍后重试")
}

func (h *Handler) verifyCaptcha(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var request verifyCaptchaRequest
	if !decodeRequest(w, r, &request) {
		return
	}
	if strings.TrimSpace(request.CaptchaID) == "" || request.Position == nil {
		writeAuthError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "缺少 captcha_id 或 position")
		return
	}
	proof, verified, err := h.captcha.Verify(r.Context(), request.CaptchaID, *request.Position, captchaClientKey(r))
	if err != nil {
		h.logger.Error("verify login captcha failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusServiceUnavailable, "CAPTCHA_UNAVAILABLE", "安全验证暂不可用，请稍后重试")
		return
	}
	if !verified {
		writeAuthError(w, http.StatusBadRequest, "CAPTCHA_INVALID", "验证未通过，请重试")
		return
	}
	httpjson.Write(w, http.StatusOK, verifyCaptchaResponse{
		CaptchaToken: proof,
		ExpiresIn:    int(h.captcha.ProofTTL() / time.Second),
	})
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var request registerRequest
	if !decodeRequest(w, r, &request) {
		return
	}
	if strings.TrimSpace(request.Role) == "" {
		request.Role = string(user.RoleStudent)
	}
	result, err := h.service.Register(r.Context(), request.Username, request.Email, request.Password, request.Role)
	if err != nil {
		h.logger.Error("register failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "注册失败，请稍后重试")
		return
	}
	if !result.Success {
		writeAuthError(w, http.StatusBadRequest, "BAD_REQUEST", result.Error)
		return
	}
	if result.AccessToken == "" || result.RefreshToken == "" || result.User.ID == "" {
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "注册成功但未能生成登录凭证，请稍后重试")
		return
	}
	if !h.setAuthCookies(w, result.AccessToken, result.RefreshToken) {
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "注册成功但未能生成安全凭证，请稍后重试")
		return
	}
	httpjson.Write(w, http.StatusOK, loginResponse{
		AccessToken: result.AccessToken,
		TokenType:   "bearer",
		User:        toUserResponse(result.User),
	})
}

func (h *Handler) changePassword(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	var request changePasswordRequest
	if !decodeRequest(w, r, &request) {
		return
	}
	success, message, err := h.service.ChangePassword(r.Context(), principal.UserID, request.OldPassword, request.NewPassword)
	if err != nil {
		h.logger.Error("change password failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "密码修改失败，请稍后重试")
		return
	}
	if !success {
		writeAuthError(w, http.StatusBadRequest, "BAD_REQUEST", message)
		return
	}
	h.clearAuthCookies(w)
	httpjson.Write(w, http.StatusOK, messageResponse{Message: message})
}

func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(refreshCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeAuthError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Refresh token 不存在")
		return
	}
	if !h.requireCSRF(w, r) {
		return
	}
	principal, message, ok := h.service.DecodeRefreshToken(cookie.Value)
	if !ok {
		h.clearAuthCookies(w)
		w.Header().Set("WWW-Authenticate", "Bearer")
		if message == "" {
			message = "Refresh token 无效或已过期"
		}
		writeAuthError(w, http.StatusUnauthorized, "UNAUTHORIZED", message)
		return
	}
	accessToken, refreshToken, ok, err := h.service.RefreshTokens(r.Context(), principal)
	if err != nil {
		h.logger.Error("refresh token failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Token 刷新失败，请稍后重试")
		return
	}
	if !ok {
		h.clearAuthCookies(w)
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeAuthError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Refresh token 无效或已过期")
		return
	}
	if !h.setAuthCookies(w, accessToken, refreshToken) {
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Token 刷新失败，请稍后重试")
		return
	}
	httpjson.Write(w, http.StatusOK, refreshResponse{AccessToken: accessToken, TokenType: "bearer"})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(refreshCookieName); err == nil && strings.TrimSpace(cookie.Value) != "" {
		if !h.requireCSRF(w, r) {
			return
		}
		if err := h.service.RevokeRefreshToken(r.Context(), cookie.Value); err != nil {
			h.logger.Warn("revoke refresh token failed", "error", redact.String(err.Error()))
		}
	}
	h.clearAuthCookies(w)
	httpjson.Write(w, http.StatusOK, messageResponse{Message: "登出成功"})
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	account, ok, err := h.service.GetUserByID(r.Context(), principal.UserID)
	if err != nil {
		h.logger.Error("get current user failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取用户信息失败")
		return
	}
	if !ok {
		writeAuthError(w, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	httpjson.Write(w, http.StatusOK, toUserResponse(account))
}

func (h *Handler) registrationStatus(w http.ResponseWriter, r *http.Request) {
	settings, err := h.service.RegistrationSettings(r.Context())
	if err != nil {
		h.logger.Error("get registration status failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取注册状态失败")
		return
	}
	httpjson.Write(w, http.StatusOK, registrationStatusResponse{
		AllowStudent: settings.AllowStudent,
		AllowTeacher: settings.AllowTeacher,
	})
}

func (h *Handler) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var request forgotPasswordRequest
	if !decodeRequest(w, r, &request) {
		return
	}
	result, err := h.service.SubmitPasswordReset(r.Context(), request.Username, request.Email, request.Reason)
	if err != nil {
		h.logger.Error("submit password reset failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "提交失败，请稍后重试")
		return
	}
	httpjson.Write(w, http.StatusOK, forgotPasswordResponse{
		Success:   result.Success,
		Message:   result.Message,
		RequestID: result.RequestID,
	})
}

func (h *Handler) forgotPasswordStatus(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	email := r.URL.Query().Get("email")
	if username == "" || email == "" {
		writeAuthError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "缺少 username 或 email")
		return
	}
	status, err := h.service.PasswordResetStatus(r.Context(), username, email)
	if err != nil {
		h.logger.Error("get password reset status failed", "error", redact.String(err.Error()))
		writeAuthError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "查询失败，请稍后重试")
		return
	}
	var createdAt *string
	if status.CreatedAt != nil {
		value := status.CreatedAt.Format("2006-01-02T15:04:05.999999")
		createdAt = &value
	}
	httpjson.Write(w, http.StatusOK, forgotPasswordStatusResponse{
		HasPending: status.HasPending,
		Status:     status.Status,
		CreatedAt:  createdAt,
	})
}

func (h *Handler) requirePrincipal(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(w, r, h.service.DecodeActiveAccessToken, nil, "", writeAuthError)
}

func (h *Handler) setAuthCookies(w http.ResponseWriter, accessToken string, refreshToken string) bool {
	csrfToken, err := newCSRFToken()
	if err != nil {
		h.logger.Error("generate csrf token failed", "error", redact.String(err.Error()))
		return false
	}
	h.setUploadsAccessCookie(w, accessToken)
	h.setRefreshCookie(w, refreshToken)
	h.setCSRFCookie(w, csrfToken)
	return true
}

func (h *Handler) setUploadsAccessCookie(w http.ResponseWriter, value string) {
	// #nosec G124 -- the cookie is HttpOnly, path-scoped, and Secure outside local development.
	http.SetCookie(w, &http.Cookie{
		Name:     httpauth.UploadsAccessCookieName,
		Value:    value,
		Path:     httpauth.UploadsAccessCookiePath,
		MaxAge:   h.accessMaxAge,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) setRefreshCookie(w http.ResponseWriter, value string) {
	// #nosec G124 -- security attributes are explicit; Secure is environment-configurable for local HTTP.
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    value,
		Path:     h.cookiePath,
		MaxAge:   h.refreshMaxAge,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) setCSRFCookie(w http.ResponseWriter, value string) {
	// #nosec G124 -- double-submit CSRF cookies must be readable by the browser client.
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    value,
		Path:     h.csrfPath,
		MaxAge:   h.refreshMaxAge,
		HttpOnly: false,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) clearAuthCookies(w http.ResponseWriter) {
	// #nosec G124 -- deletion mirrors the path-scoped upload access cookie.
	http.SetCookie(w, &http.Cookie{
		Name:     httpauth.UploadsAccessCookieName,
		Value:    "",
		Path:     httpauth.UploadsAccessCookiePath,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	// #nosec G124 -- deletion mirrors the explicit refresh-cookie security attributes.
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     h.cookiePath,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	// #nosec G124 -- deletion mirrors the readable double-submit CSRF cookie.
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    "",
		Path:     h.csrfPath,
		MaxAge:   -1,
		HttpOnly: false,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) requireCSRF(w http.ResponseWriter, r *http.Request) bool {
	cookie, err := r.Cookie(csrfCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		writeAuthError(w, http.StatusForbidden, "CSRF_TOKEN_MISSING", "CSRF token 缺失")
		return false
	}
	header := strings.TrimSpace(r.Header.Get(csrfHeaderName))
	if header == "" || subtle.ConstantTimeCompare([]byte(header), []byte(cookie.Value)) != 1 {
		writeAuthError(w, http.StatusForbidden, "CSRF_TOKEN_INVALID", "CSRF token 无效")
		return false
	}
	return true
}

func newCSRFToken() (string, error) {
	return securerand.Hex(csrfTokenBytes)
}

func decodeRequest(w http.ResponseWriter, r *http.Request, target any) bool {
	return httpjson.DecodeStrictOrDetailError(w, r, 1<<20, target)
}

func toUserResponse(account user.User) userResponse {
	return userResponse{
		ID:       account.ID,
		Username: account.Username,
		Email:    account.Email,
		Role:     string(account.Role),
	}
}

func writeAuthError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}

func captchaClientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	remoteIP := net.ParseIP(host)
	if remoteIP != nil && (remoteIP.IsLoopback() || remoteIP.IsPrivate()) {
		forwarded := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP")))
		if forwarded != nil {
			return forwarded.String()
		}
	}
	if remoteIP != nil {
		return remoteIP.String()
	}
	if host != "" {
		return host
	}
	return "unknown"
}
