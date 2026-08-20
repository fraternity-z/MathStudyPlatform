package exercisehttp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"

	airiskapp "mathstudy/backend/internal/application/airisk"
	authapp "mathstudy/backend/internal/application/auth"
	exerciseapp "mathstudy/backend/internal/application/exercise"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/httpjson"
	"mathstudy/backend/internal/platform/httpquery"
	"mathstudy/backend/internal/platform/ptrutil"
	"mathstudy/backend/internal/platform/ratelimit"
	"mathstudy/backend/internal/platform/redact"
)

// Service is the exercise application surface used by HTTP handlers.
type Service interface {
	GetNextExercise(context.Context, string, exerciseapp.NextQuery) (*exerciseapp.ExerciseResponse, error)
	GenerateExercise(context.Context, string, exerciseapp.GenerateExerciseRequest) (*exerciseapp.ExerciseResponse, error)
	PreflightSubmit(context.Context, string, exerciseapp.SubmitRequest) (exerciseapp.SubmitResponse, bool, error)
	SubmitAnswer(context.Context, string, exerciseapp.SubmitRequest) (exerciseapp.SubmitResponse, error)
	GetExercise(context.Context, string, string) (exerciseapp.ExerciseDetailResponse, error)
	GetSolution(context.Context, string, string, string, string, *int64, string, string) (exerciseapp.SolutionResponse, error)
}

// Authenticator validates access tokens against current account state.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// AIRequestGuard applies AI-only access, content, and concurrency controls.
type AIRequestGuard interface {
	Acquire(context.Context, string, string, string, bool) (airiskapp.Lease, error)
}

// Handler serves /exercise endpoints.
type Handler struct {
	service    Service
	auth       Authenticator
	logger     *slog.Logger
	limiter    *ratelimit.Limiter
	ocrLimiter *ratelimit.Limiter
	guard      AIRequestGuard
}

const (
	generationRateLimitMax          = 10
	generationRateLimitWindow       = time.Minute
	generationRateLimitLocalMaxKeys = 500
	ocrRateLimitMax                 = 10
	ocrRateLimitWindow              = time.Minute
)

// Option customizes the exercise HTTP handler.
type Option func(*Handler) error

// WithRedisRateLimit shares exercise generation limits across API instances.
func WithRedisRateLimit(client *goredis.Client, maxLocalKeys int) Option {
	return func(handler *Handler) error {
		limiter, err := ratelimit.New(
			client,
			"msp:exercise_generation",
			generationRateLimitMax,
			generationRateLimitWindow,
			maxLocalKeys,
			handler.logger,
		)
		if err != nil {
			return err
		}
		handler.limiter = limiter
		ocrLimiter, err := ratelimit.New(
			client,
			"msp:exercise_ocr",
			ocrRateLimitMax,
			ocrRateLimitWindow,
			maxLocalKeys,
			handler.logger,
		)
		if err != nil {
			return err
		}
		handler.ocrLimiter = ocrLimiter
		return nil
	}
}

// WithAIRequestGuard enables student AI controls for AI-backed exercise operations.
func WithAIRequestGuard(guard AIRequestGuard) Option {
	return func(handler *Handler) error {
		handler.guard = guard
		return nil
	}
}

// NewHandler creates an exercise HTTP handler.
func NewHandler(logger *slog.Logger, service Service, auth Authenticator, options ...Option) (*Handler, error) {
	if service == nil {
		return nil, errors.New("exercise service is nil")
	}
	if auth == nil {
		return nil, errors.New("exercise authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	handler := &Handler{
		service:    service,
		auth:       auth,
		logger:     logger,
		limiter:    newGenerationRateLimiter(generationRateLimitMax, generationRateLimitWindow),
		ocrLimiter: newOCRRateLimiter(ocrRateLimitMax, ocrRateLimitWindow),
	}
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

// Register attaches exercise routes under prefix, for example /api/v1/exercise.
func (h *Handler) Register(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/next", h.next)
	mux.HandleFunc("POST "+prefix+"/generate", h.generate)
	mux.HandleFunc("POST "+prefix+"/submit", h.submit)
	mux.HandleFunc("GET "+prefix+"/{exercise_id}/solution", h.solution)
	mux.HandleFunc("GET "+prefix+"/{exercise_id}", h.detail)
}

type submitRequest struct {
	ExerciseID         string   `json:"exercise_id"`
	DailyAssignmentID  string   `json:"daily_assignment_id"`
	ReviewTaskID       string   `json:"review_task_id"`
	ReviewTaskRevision *int64   `json:"review_task_revision"`
	OriginalAttemptID  string   `json:"original_attempt_id"`
	SubmissionID       string   `json:"submission_id"`
	AnswerText         *string  `json:"answer_text"`
	AnswerImageURL     *string  `json:"answer_image_url"`
	AnswerSteps        []string `json:"answer_steps"`
	TimeSpentSeconds   int      `json:"time_spent_seconds"`
}

type generateRequest struct {
	ConceptID    string   `json:"concept_id"`
	Difficulty   *float64 `json:"difficulty"`
	QuestionType string   `json:"question_type"`
}

func (h *Handler) next(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	query, ok := parseNextQuery(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetNextExercise(r.Context(), principal.UserID, query)
	if err != nil {
		h.writeExerciseError(w, err, "获取练习题失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) generate(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requireStudent(w, r)
	if !ok {
		return
	}
	var request generateRequest
	if !decodeRequest(w, r, &request) {
		return
	}
	request.ConceptID = strings.TrimSpace(request.ConceptID)
	if request.ConceptID == "" || len(request.ConceptID) > 36 {
		writeExerciseError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请选择有效的知识点")
		return
	}
	if request.Difficulty == nil || *request.Difficulty < 0 || *request.Difficulty > 1 {
		writeExerciseError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "difficulty 必须在 0 到 1 之间")
		return
	}
	request.QuestionType = strings.ToLower(strings.TrimSpace(request.QuestionType))
	if request.QuestionType == "" {
		request.QuestionType = exerciseapp.QuestionTypeMultipleChoice
	}
	if request.QuestionType != exerciseapp.QuestionTypeMultipleChoice && request.QuestionType != exerciseapp.QuestionTypeShortAnswer {
		writeExerciseError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "question_type 必须是 multiple_choice 或 short_answer")
		return
	}
	lease, ok := h.acquireAILease(w, r, principal.UserID, "exercise_generate", "")
	if !ok {
		return
	}
	defer releaseAILease(lease)
	if h.limiter != nil && !h.limiter.Allow(r.Context(), principal.UserID) {
		w.Header().Set("Retry-After", strconv.Itoa(int(generationRateLimitWindow/time.Second)))
		writeExerciseError(w, http.StatusTooManyRequests, "RATE_LIMITED", "AI 出题过于频繁，请稍后重试")
		return
	}
	response, err := h.service.GenerateExercise(r.Context(), principal.UserID, exerciseapp.GenerateExerciseRequest{
		ConceptID:    request.ConceptID,
		Difficulty:   *request.Difficulty,
		QuestionType: request.QuestionType,
	})
	if err != nil {
		switch {
		case errors.Is(err, exerciseapp.ErrNotFound):
			writeExerciseError(w, http.StatusNotFound, "NOT_FOUND", "所选知识点不存在")
		case errors.Is(err, exerciseapp.ErrBadRequest):
			writeExerciseError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "生成参数无效")
		default:
			h.writeExerciseError(w, err, "生成练习题失败")
		}
		return
	}
	httpjson.Write(w, http.StatusCreated, response)
}

func (h *Handler) submit(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	var request submitRequest
	if !decodeRequest(w, r, &request) {
		return
	}
	answerText := ptrutil.ValueOrZero(request.AnswerText)
	answerImageURL := ptrutil.ValueOrZero(request.AnswerImageURL)
	if strings.TrimSpace(answerText) == "" && strings.TrimSpace(answerImageURL) == "" {
		writeExerciseError(w, http.StatusBadRequest, "BAD_REQUEST", "请提供文本答案或答案图片")
		return
	}
	applicationRequest := exerciseapp.SubmitRequest{
		ExerciseID:         request.ExerciseID,
		DailyAssignmentID:  strings.TrimSpace(request.DailyAssignmentID),
		ReviewTaskID:       strings.TrimSpace(request.ReviewTaskID),
		ReviewTaskRevision: request.ReviewTaskRevision,
		OriginalAttemptID:  strings.TrimSpace(request.OriginalAttemptID),
		SubmissionID:       strings.TrimSpace(request.SubmissionID),
		AnswerText:         answerText,
		AnswerImageURL:     answerImageURL,
		AnswerSteps:        request.AnswerSteps,
		TimeSpentSeconds:   request.TimeSpentSeconds,
	}
	cached, found, err := h.service.PreflightSubmit(r.Context(), principal.UserID, applicationRequest)
	if err != nil {
		h.writeSubmitError(w, err)
		return
	}
	if found {
		httpjson.Write(w, http.StatusOK, cached)
		return
	}
	content := strings.TrimSpace(answerText + "\n" + strings.Join(request.AnswerSteps, "\n"))
	lease, ok := h.acquireAILease(w, r, principal.UserID, "exercise_submit", content)
	if !ok {
		return
	}
	defer releaseAILease(lease)
	if strings.TrimSpace(answerText) == "" && h.ocrLimiter != nil && !h.ocrLimiter.Allow(r.Context(), principal.UserID) {
		w.Header().Set("Retry-After", strconv.Itoa(int(ocrRateLimitWindow/time.Second)))
		writeExerciseError(w, http.StatusTooManyRequests, "OCR_RATE_LIMITED", "图片答案识别请求过于频繁，请稍后重试")
		return
	}
	response, err := h.service.SubmitAnswer(r.Context(), principal.UserID, applicationRequest)
	if err != nil {
		h.writeSubmitError(w, err)
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) writeSubmitError(w http.ResponseWriter, err error) {
	if errors.Is(err, exerciseapp.ErrBadRequest) {
		writeExerciseError(w, http.StatusBadRequest, "BAD_REQUEST", "提交失败，请检查输入后重试")
		return
	}
	h.writeExerciseError(w, err, "提交答案失败")
}

func (h *Handler) detail(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	response, err := h.service.GetExercise(r.Context(), principal.UserID, r.PathValue("exercise_id"))
	if err != nil {
		if errors.Is(err, exerciseapp.ErrNotFound) {
			writeExerciseError(w, http.StatusNotFound, "NOT_FOUND", "题目不存在或无权访问")
			return
		}
		h.writeExerciseError(w, err, "获取题目详情失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func (h *Handler) solution(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	dailyAssignmentID := strings.TrimSpace(r.URL.Query().Get("daily_assignment_id"))
	reviewTaskID := strings.TrimSpace(r.URL.Query().Get("review_task_id"))
	originalAttemptID := strings.TrimSpace(r.URL.Query().Get("original_attempt_id"))
	solutionAttemptID := strings.TrimSpace(r.URL.Query().Get("attempt_id"))
	reviewTaskRevision, ok := parseReviewTaskRevision(w, reviewTaskID, r.URL.Query().Get("review_task_revision"))
	if !ok {
		return
	}
	lease, ok := h.acquireAILease(w, r, principal.UserID, "exercise_solution", "")
	if !ok {
		return
	}
	defer releaseAILease(lease)
	response, err := h.service.GetSolution(
		r.Context(),
		principal.UserID,
		r.PathValue("exercise_id"),
		dailyAssignmentID,
		reviewTaskID,
		reviewTaskRevision,
		originalAttemptID,
		solutionAttemptID,
	)
	if err != nil {
		if errors.Is(err, exerciseapp.ErrNotFound) {
			writeExerciseError(w, http.StatusNotFound, "NOT_FOUND", "题目不存在或无权访问")
			return
		}
		h.writeExerciseError(w, err, "获取题目解析失败")
		return
	}
	httpjson.Write(w, http.StatusOK, response)
}

func parseReviewTaskRevision(w http.ResponseWriter, reviewTaskID string, rawRevision string) (*int64, bool) {
	rawRevision = strings.TrimSpace(rawRevision)
	if reviewTaskID == "" && rawRevision == "" {
		return nil, true
	}
	if reviewTaskID == "" || rawRevision == "" {
		writeExerciseError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "复习任务 ID 和 revision 必须同时提供")
		return nil, false
	}
	revision, err := strconv.ParseInt(rawRevision, 10, 64)
	if err != nil || revision < 0 {
		writeExerciseError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "review_task_revision 必须是非负整数")
		return nil, false
	}
	return &revision, true
}

func (h *Handler) acquireAILease(w http.ResponseWriter, r *http.Request, studentID, source, content string) (airiskapp.Lease, bool) {
	if h.guard == nil {
		return nil, true
	}
	lease, err := h.guard.Acquire(r.Context(), studentID, source, content, false)
	if err != nil {
		h.writeExerciseError(w, err, "AI 请求暂不可用")
		return nil, false
	}
	return lease, true
}

func (h *Handler) requirePrincipal(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(w, r, h.auth.DecodeActiveAccessToken, nil, "", writeExerciseError)
}

func (h *Handler) requireStudent(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, authapp.IsStudent,
		"权限不足，需要学生身份", writeExerciseError,
	)
}

func (h *Handler) writeExerciseError(w http.ResponseWriter, err error, fallback string) {
	if errors.Is(err, context.Canceled) {
		h.logger.Debug("exercise request canceled")
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		writeExerciseError(w, http.StatusGatewayTimeout, "REQUEST_TIMEOUT", "请求处理超时，请稍后重试")
		return
	}
	if writeAIRiskError(w, err) {
		return
	}
	if errors.Is(err, exerciseapp.ErrAIGenerationTimeout) {
		writeExerciseError(w, http.StatusGatewayTimeout, "AI_GENERATION_TIMEOUT", "AI 出题处理超时，请稍后重试")
		return
	}
	if errors.Is(err, exerciseapp.ErrAIGenerationUnavailable) {
		writeExerciseError(w, http.StatusServiceUnavailable, "AI_GENERATION_UNAVAILABLE", "AI 出题服务暂不可用，请稍后重试")
		return
	}
	if errors.Is(err, exerciseapp.ErrOCRUnavailable) {
		writeExerciseError(w, http.StatusServiceUnavailable, "OCR_UNAVAILABLE", "图片答案识别服务暂不可用，请稍后重试或改用文本答案")
		return
	}
	if errors.Is(err, exerciseapp.ErrOCRUnreadable) {
		writeExerciseError(w, http.StatusUnprocessableEntity, "OCR_UNREADABLE", "未能识别出清晰答案，请重新拍摄或改用文本答案")
		return
	}
	if errors.Is(err, exerciseapp.ErrOCRTimeout) {
		writeExerciseError(w, http.StatusGatewayTimeout, "OCR_TIMEOUT", "图片答案识别超时，请稍后重试")
		return
	}
	if errors.Is(err, exerciseapp.ErrAnswerParseFailed) {
		writeExerciseError(w, http.StatusUnprocessableEntity, "ANSWER_PARSE_FAILED", "答案格式无法安全解析，请检查后重试")
		return
	}
	if errors.Is(err, exerciseapp.ErrMathUnsupported) {
		writeExerciseError(w, http.StatusUnprocessableEntity, "MATH_UNSUPPORTED", "当前题型暂不支持自动判定，请补充步骤或联系教师")
		return
	}
	if errors.Is(err, exerciseapp.ErrMathSolverInvalidResult) {
		writeExerciseError(w, http.StatusBadGateway, "MATH_SOLVER_INVALID_RESPONSE", "数学判题服务返回异常，请稍后重试")
		return
	}
	if errors.Is(err, exerciseapp.ErrMathSolverUnavailable) {
		writeExerciseError(w, http.StatusServiceUnavailable, "MATH_SOLVER_UNAVAILABLE", "数学判题服务暂不可用，请稍后重试")
		return
	}
	if errors.Is(err, exerciseapp.ErrMathSolverTimeout) {
		writeExerciseError(w, http.StatusGatewayTimeout, "MATH_SOLVER_TIMEOUT", "数学判题服务处理超时，请稍后重试")
		return
	}
	if errors.Is(err, exerciseapp.ErrExerciseChanged) {
		writeExerciseError(w, http.StatusConflict, "EXERCISE_CHANGED", "题目已更新，请重新加载后提交")
		return
	}
	if errors.Is(err, exerciseapp.ErrDailyAssignmentInvalid) {
		writeExerciseError(w, http.StatusConflict, "DAILY_ASSIGNMENT_INVALID", "每日一题任务已失效，请重新加载")
		return
	}
	if errors.Is(err, exerciseapp.ErrDailyAssignmentClosed) {
		writeExerciseError(w, http.StatusConflict, "DAILY_ASSIGNMENT_COMPLETED", "该每日一题已完成，无需重复提交")
		return
	}
	if errors.Is(err, exerciseapp.ErrReviewTaskStale) {
		writeExerciseError(w, http.StatusConflict, "REVIEW_TASK_STALE", "复习任务已更新，请重新加载")
		return
	}
	if errors.Is(err, exerciseapp.ErrReviewNotDue) {
		writeExerciseError(w, http.StatusConflict, "REVIEW_NOT_DUE", "这道题还未到复习时间")
		return
	}
	if errors.Is(err, exerciseapp.ErrMistakeRecordArchived) {
		writeExerciseError(w, http.StatusConflict, "MISTAKE_RECORD_ARCHIVED", "这条错题记录已归档，请返回错题本")
		return
	}
	if errors.Is(err, exerciseapp.ErrSubmissionConflict) {
		writeExerciseError(w, http.StatusConflict, "SUBMISSION_ID_CONFLICT", "提交标识已用于其他答案，请重新提交")
		return
	}
	if errors.Is(err, exerciseapp.ErrForbidden) {
		writeExerciseError(w, http.StatusForbidden, "FORBIDDEN", "请先加入班级后再开始练习")
		return
	}
	if errors.Is(err, exerciseapp.ErrBadRequest) {
		writeExerciseError(w, http.StatusBadRequest, "BAD_REQUEST", fallback)
		return
	}
	h.logger.Error("exercise request failed", "error", redact.String(err.Error()))
	writeExerciseError(w, http.StatusInternalServerError, "INTERNAL_ERROR", fallback)
}

func writeAIRiskError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, airiskapp.ErrAccessBlocked):
		writeExerciseError(w, http.StatusForbidden, "AI_ACCESS_BLOCKED", err.Error())
	case errors.Is(err, airiskapp.ErrContentBlocked):
		writeExerciseError(w, http.StatusUnprocessableEntity, "AI_CONTENT_BLOCKED", err.Error())
	case errors.Is(err, airiskapp.ErrQuotaExceeded):
		writeExerciseError(w, http.StatusTooManyRequests, "AI_DAILY_QUOTA_EXCEEDED", err.Error())
	case errors.Is(err, airiskapp.ErrConcurrencyExceeded):
		writeExerciseError(w, http.StatusTooManyRequests, "AI_CONCURRENCY_LIMIT", err.Error())
	case errors.Is(err, airiskapp.ErrUnavailable):
		writeExerciseError(w, http.StatusServiceUnavailable, "AI_GUARD_UNAVAILABLE", "AI 风控服务暂不可用，请稍后重试")
	default:
		return false
	}
	return true
}

func releaseAILease(lease airiskapp.Lease) {
	if lease == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = lease.Release(ctx)
}

func parseNextQuery(w http.ResponseWriter, r *http.Request) (exerciseapp.NextQuery, bool) {
	query := r.URL.Query()
	var difficulty *float64
	if raw := query.Get("difficulty"); raw != "" {
		parsed, err := httpquery.BoundedFloat(raw, 0, 0, 1)
		if err != nil {
			writeExerciseError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "difficulty 必须在 0 到 1 之间")
			return exerciseapp.NextQuery{}, false
		}
		difficulty = &parsed
	}
	return exerciseapp.NextQuery{ConceptID: query.Get("concept_id"), Difficulty: difficulty}, true
}

func decodeRequest(w http.ResponseWriter, r *http.Request, target any) bool {
	return httpjson.DecodeStrictOrDetailError(w, r, 1<<20, target)
}

func writeExerciseError(w http.ResponseWriter, status int, code, message string) {
	httpjson.WriteDetailError(w, status, code, message)
}

func newGenerationRateLimiter(limit int, window time.Duration) *ratelimit.Limiter {
	if limit <= 0 {
		limit = generationRateLimitMax
	}
	if window <= 0 {
		window = generationRateLimitWindow
	}
	limiter, err := ratelimit.New(nil, "msp:exercise_generation", limit, window, generationRateLimitLocalMaxKeys, nil)
	if err != nil {
		panic(err)
	}
	return limiter
}

func newOCRRateLimiter(limit int, window time.Duration) *ratelimit.Limiter {
	if limit <= 0 {
		limit = ocrRateLimitMax
	}
	if window <= 0 {
		window = ocrRateLimitWindow
	}
	limiter, err := ratelimit.New(nil, "msp:exercise_ocr", limit, window, generationRateLimitLocalMaxKeys, nil)
	if err != nil {
		panic(err)
	}
	return limiter
}
