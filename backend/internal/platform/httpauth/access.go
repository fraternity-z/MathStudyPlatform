package httpauth

import (
	"context"
	"log/slog"
	"net/http"

	"mathstudy/backend/internal/platform/redact"
)

const (
	unauthorizedCode    = "UNAUTHORIZED"
	unauthorizedMessage = "未认证，请先登录"
	forbiddenCode       = "FORBIDDEN"
	// UploadsAccessCookieName scopes browser access tokens to local upload reads.
	UploadsAccessCookieName = "uploads_access_token"
	// UploadsAccessCookiePath prevents the upload access token from reaching API routes.
	UploadsAccessCookiePath = "/uploads/"
)

// RequireBearerAccessContext validates a bearer token against current server-side account state.
func RequireBearerAccessContext[T any](
	w http.ResponseWriter,
	r *http.Request,
	decode func(context.Context, string) (T, bool, error),
	allow func(T) bool,
	forbiddenMessage string,
	writeError func(http.ResponseWriter, int, string, string),
	onDecodeError ...func(error),
) (T, bool) {
	var zero T
	token, ok := BearerToken(r)
	if !ok {
		writeBearerUnauthorized(w, writeError)
		return zero, false
	}

	principal, ok, err := decode(r.Context(), token)
	if err != nil {
		if len(onDecodeError) > 0 && onDecodeError[0] != nil {
			onDecodeError[0](err)
		} else {
			slog.Default().Error("validate active access token failed", "error", redact.String(err.Error()))
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "验证登录状态失败，请稍后重试")
		return zero, false
	}
	if !ok {
		writeBearerUnauthorized(w, writeError)
		return zero, false
	}
	if allow != nil && !allow(principal) {
		writeError(w, http.StatusForbidden, forbiddenCode, forbiddenMessage)
		return zero, false
	}
	return principal, true
}

func writeBearerUnauthorized(w http.ResponseWriter, writeError func(http.ResponseWriter, int, string, string)) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	writeError(w, http.StatusUnauthorized, unauthorizedCode, unauthorizedMessage)
}
