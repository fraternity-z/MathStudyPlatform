package uploadhttp

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"

	authapp "mathstudy/backend/internal/application/auth"
	uploadapp "mathstudy/backend/internal/application/upload"
	"mathstudy/backend/internal/domain/user"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/ratelimit"
	"mathstudy/backend/internal/platform/redact"
	"mathstudy/backend/internal/platform/uploadpath"
)

const (
	multipartMemory        = 32 << 20
	uploadRateLimitWindow  = time.Minute
	uploadRateLimitMax     = 60
	uploadRateLimitMaxKeys = 500
)

// Service is the upload application surface used by HTTP handlers.
type Service interface {
	SaveImage(context.Context, io.Reader, uploadapp.FileMeta) (uploadapp.Response, error)
	SaveResourceFile(context.Context, io.Reader, uploadapp.FileMeta) (uploadapp.Response, error)
	SaveMessageFile(context.Context, io.Reader, uploadapp.FileMeta) (uploadapp.Response, error)
}

// Authenticator validates access tokens against current account state.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// LocalUploadAccessStore owns local-upload ownership and object-level access decisions.
type LocalUploadAccessStore interface {
	RecordLocalUpload(context.Context, string, string) error
	CanAccessLocalUpload(context.Context, string, string) (bool, error)
}

// Handler serves /upload endpoints.
type Handler struct {
	service      Service
	auth         Authenticator
	logger       *slog.Logger
	limiter      *ratelimit.Limiter
	downloadRoot string
	localAccess  LocalUploadAccessStore
}

// Option customizes the upload HTTP handler.
type Option func(*Handler) error

// WithRedisRateLimit shares upload limits across API instances.
func WithRedisRateLimit(client *goredis.Client, maxLocalKeys int) Option {
	return func(handler *Handler) error {
		limiter, err := ratelimit.New(
			client,
			"msp:upload",
			uploadRateLimitMax,
			uploadRateLimitWindow,
			maxLocalKeys,
			handler.logger,
		)
		if err != nil {
			return err
		}
		handler.limiter = limiter
		return nil
	}
}

// WithProtectedLocalDownloads enables authenticated local upload reads.
func WithProtectedLocalDownloads(root string, access LocalUploadAccessStore) Option {
	return func(handler *Handler) error {
		if access == nil {
			return errors.New("upload attachment access checker is nil")
		}
		if strings.TrimSpace(root) == "" {
			return errors.New("upload download root is empty")
		}
		absoluteRoot, err := filepath.Abs(root)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(absoluteRoot, 0o750); err != nil {
			return err
		}
		handler.downloadRoot = absoluteRoot
		handler.localAccess = access
		return nil
	}
}

// NewHandler creates an upload HTTP handler.
func NewHandler(logger *slog.Logger, service Service, auth Authenticator, options ...Option) (*Handler, error) {
	if service == nil {
		return nil, errors.New("upload service is nil")
	}
	if auth == nil {
		return nil, errors.New("upload authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	handler := &Handler{service: service, auth: auth, logger: logger, limiter: newUploadRateLimiter(uploadRateLimitMax, uploadRateLimitWindow)}
	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(handler); err != nil {
			return nil, err
		}
	}
	return handler, nil
}

// Register attaches upload routes under prefix, for example /api/v1/upload.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/image", h.image)
	mux.HandleFunc("POST "+prefix+"/resource", h.resource)
	mux.HandleFunc("POST "+prefix+"/message-file", h.messageFile)
	if h.downloadRoot != "" {
		mux.Handle("/uploads/", http.StripPrefix("/uploads/", h.downloads()))
	}
}

func (h *Handler) image(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !h.allowUpload(w, r, principal) {
		return
	}
	h.upload(w, r, principal, uploadapp.MaxImageSize, h.service.SaveImage, "上传图片失败")
}

func (h *Handler) resource(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireTeacher(w, r)
	if !ok {
		return
	}
	if !h.allowUpload(w, r, principal) {
		return
	}
	h.upload(w, r, principal, uploadapp.MaxResourceSize, h.service.SaveResourceFile, "上传资源文件失败")
}

func (h *Handler) messageFile(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireMessageFileUploader(w, r)
	if !ok {
		return
	}
	if !h.allowUpload(w, r, principal) {
		return
	}
	h.upload(w, r, principal, uploadapp.MaxMessageFileSize, h.service.SaveMessageFile, "上传消息文件失败")
}

func (h *Handler) downloads() http.Handler {
	fs := http.Dir(h.downloadRoot)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeUploadError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method not allowed")
			return
		}
		principal, ok := h.requireDownloadPrincipal(w, r)
		if !ok {
			return
		}
		cleanPath, ok := uploadpath.CleanServablePath(r.URL.Path)
		if !ok {
			writeUploadError(w, http.StatusNotFound, "NOT_FOUND", "uploaded file not found")
			return
		}
		localURL := "/uploads/" + cleanPath
		allowed, err := h.localAccess.CanAccessLocalUpload(r.Context(), principal.UserID, localURL)
		if err != nil {
			h.logger.Error("check uploaded attachment access failed", "error", redact.String(err.Error()))
			writeUploadError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "校验文件访问权限失败")
			return
		}
		if !allowed {
			writeUploadError(w, http.StatusNotFound, "NOT_FOUND", "uploaded file not found")
			return
		}
		file, err := fs.Open(cleanPath)
		if err != nil {
			writeUploadError(w, http.StatusNotFound, "NOT_FOUND", "uploaded file not found")
			return
		}
		defer file.Close()
		stat, err := file.Stat()
		if err != nil || stat.IsDir() {
			writeUploadError(w, http.StatusNotFound, "NOT_FOUND", "uploaded file not found")
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Vary", "Cookie, Authorization")
		if uploadpath.IsDocumentKey(cleanPath) {
			w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": stat.Name()}))
		}
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), file)
	})
}

func (h *Handler) requireDownloadPrincipal(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	token, ok := httpauth.BearerToken(r)
	if !ok {
		cookie, err := r.Cookie(httpauth.UploadsAccessCookieName)
		if err == nil && strings.TrimSpace(cookie.Value) != "" {
			token, ok = cookie.Value, true
		}
	}
	if !ok {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeUploadError(w, http.StatusUnauthorized, "UNAUTHORIZED", "未认证，请先登录")
		return authapp.Principal{}, false
	}
	principal, active, err := h.auth.DecodeActiveAccessToken(r.Context(), token)
	if err != nil {
		h.logger.Error("validate upload access token failed", "error", redact.String(err.Error()))
		writeUploadError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "验证登录状态失败，请稍后重试")
		return authapp.Principal{}, false
	}
	if !active {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeUploadError(w, http.StatusUnauthorized, "UNAUTHORIZED", "未认证，请先登录")
		return authapp.Principal{}, false
	}
	return principal, true
}

func (h *Handler) upload(w http.ResponseWriter, r *http.Request, principal authapp.Principal, maxSize int64, save func(context.Context, io.Reader, uploadapp.FileMeta) (uploadapp.Response, error), fallback string) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSize+multipartMemory)
	// #nosec G120 -- MaxBytesReader bounds the complete multipart request body.
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeUploadError(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", "文件大小超过限制")
			return
		}
		writeUploadError(w, http.StatusBadRequest, "BAD_REQUEST", "请求体不是有效 multipart/form-data")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeUploadError(w, http.StatusBadRequest, "BAD_REQUEST", "缺少上传文件 file")
		return
	}
	defer file.Close()
	response, err := save(r.Context(), file, uploadapp.FileMeta{
		ContentType: header.Header.Get("Content-Type"),
		Size:        header.Size,
	})
	if err != nil {
		h.writeServiceError(w, err, fallback)
		return
	}
	if uploadpath.IsLocalPath(response.URL) {
		if h.localAccess == nil {
			h.removeUnregisteredLocalUpload(response.URL)
			h.logger.Error("record local upload owner failed", "error", "local upload access store is not configured")
			writeUploadError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "保存文件访问权限失败")
			return
		}
		if err := h.localAccess.RecordLocalUpload(r.Context(), principal.UserID, response.URL); err != nil {
			if cleanupErr := h.removeUnregisteredLocalUpload(response.URL); cleanupErr != nil {
				h.logger.Error("remove unregistered local upload failed", "error", redact.String(cleanupErr.Error()))
			}
			h.logger.Error("record local upload owner failed", "error", redact.String(err.Error()))
			writeUploadError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "保存文件访问权限失败")
			return
		}
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) removeUnregisteredLocalUpload(localURL string) error {
	if h.downloadRoot == "" || !uploadpath.IsLocalPath(localURL) {
		return nil
	}
	key, ok := uploadpath.CleanServablePath(strings.TrimPrefix(localURL, "/uploads/"))
	if !ok {
		return nil
	}
	target := filepath.Join(h.downloadRoot, filepath.FromSlash(key))
	relative, err := filepath.Rel(h.downloadRoot, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return errors.New("unregistered local upload path escapes download root")
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (h *Handler) requirePrincipal(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(w, r, h.auth.DecodeActiveAccessToken, nil, "", writeUploadError)
}

func (h *Handler) requireTeacher(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, authapp.IsTeacherOrAdmin,
		"权限不足，需要教师权限", writeUploadError,
	)
}

func (h *Handler) requireMessageFileUploader(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken,
		func(principal authapp.Principal) bool {
			return authapp.IsStudent(principal) || principal.Role == user.RoleTeacher
		},
		"权限不足，仅学生或教师可以上传消息文件", writeUploadError,
	)
}

func (h *Handler) allowUpload(w http.ResponseWriter, r *http.Request, principal authapp.Principal) bool {
	if h.limiter == nil || h.limiter.Allow(r.Context(), uploadRateKey(r, principal)) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeUploadError(w, http.StatusTooManyRequests, "RATE_LIMITED", "上传过于频繁，请稍后重试")
	return false
}

func (h *Handler) writeServiceError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, uploadapp.ErrInvalidContentType):
		writeUploadError(w, http.StatusUnsupportedMediaType, "INVALID_CONTENT_TYPE", "不支持的文件类型")
	case errors.Is(err, uploadapp.ErrFileTooLarge):
		writeUploadError(w, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", "文件大小超过限制")
	default:
		h.logger.Error("upload failed", "error", redact.String(err.Error()))
		writeUploadError(w, http.StatusInternalServerError, "INTERNAL_ERROR", fallback)
	}
}

func writeUploadError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}

func uploadRateKey(r *http.Request, principal authapp.Principal) string {
	if strings.TrimSpace(principal.UserID) != "" {
		return "user:" + principal.UserID
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		host = r.RemoteAddr
	}
	if host == "" {
		host = "unknown"
	}
	return "ip:" + host
}

func newUploadRateLimiter(limit int, window time.Duration) *ratelimit.Limiter {
	if limit <= 0 {
		limit = uploadRateLimitMax
	}
	if window <= 0 {
		window = uploadRateLimitWindow
	}
	limiter, err := ratelimit.New(nil, "msp:upload", limit, window, uploadRateLimitMaxKeys, nil)
	if err != nil {
		panic(err)
	}
	return limiter
}
