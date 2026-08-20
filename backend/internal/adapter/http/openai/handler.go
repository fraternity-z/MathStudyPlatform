package openaihttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"mathstudy/backend/internal/adapter/llm/openaicompat"
	airiskapp "mathstudy/backend/internal/application/airisk"
	authapp "mathstudy/backend/internal/application/auth"
	"mathstudy/backend/internal/platform/httpauth"
	"mathstudy/backend/internal/platform/ratelimit"
	"mathstudy/backend/internal/platform/redact"
)

const maxResponsesRequestBody = 8 << 20

// Authenticator validates access tokens against current account state.
type Authenticator interface {
	DecodeActiveAccessToken(context.Context, string) (authapp.Principal, bool, error)
}

// AIRequestGuard applies the existing student AI access, content, and concurrency controls.
type AIRequestGuard interface {
	Acquire(context.Context, string, string, string, bool) (airiskapp.Lease, error)
	RecordSuccessfulReply(context.Context, string) error
}

// ResponsesService is the OpenAI-compatible Responses relay surface.
type ResponsesService interface {
	Relay(context.Context, openaicompat.ResponsesRequest, openaicompat.ResponsesStreamCallbacks) (openaicompat.ResponsesResult, error)
}

// UsageObserver records provider-reported usage without exposing request identities as metric labels.
type UsageObserver interface {
	ObserveOpenAIResponsesUsage(int, int)
}

// Handler serves the OpenAI-compatible /v1/responses endpoint.
type Handler struct {
	service ResponsesService
	auth    Authenticator
	guard   AIRequestGuard
	limiter *ratelimit.Limiter
	usage   UsageObserver
	logger  *slog.Logger
}

// NewHandler creates the OpenAI-compatible HTTP adapter.
func NewHandler(
	logger *slog.Logger,
	service ResponsesService,
	auth Authenticator,
	guard AIRequestGuard,
	limiter *ratelimit.Limiter,
	observers ...UsageObserver,
) (*Handler, error) {
	if service == nil {
		return nil, errors.New("OpenAI Responses service is nil")
	}
	if auth == nil {
		return nil, errors.New("OpenAI Responses authenticator is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	var usage UsageObserver
	if len(observers) > 0 {
		usage = observers[0]
	}
	return &Handler{service: service, auth: auth, guard: guard, limiter: limiter, usage: usage, logger: logger}, nil
}

// Register attaches the standard OpenAI Responses path.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/responses", h.responses)
	mux.HandleFunc("/v1/responses", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "", "Method not allowed. Use POST for this endpoint.")
	})
}

func (h *Handler) responses(w http.ResponseWriter, r *http.Request) {
	principal, ok := h.requirePrincipal(w, r)
	if !ok {
		return
	}
	if h.limiter != nil && !h.limiter.Allow(r.Context(), principal.UserID) {
		w.Header().Set("Retry-After", "60")
		writeOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "rate_limit_exceeded", "", "Responses requests are too frequent. Please retry later.")
		return
	}
	body, err := readRequestBody(w, r)
	if err != nil {
		if errors.Is(err, errRequestBodyTooLarge) {
			writeOpenAIError(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "request_too_large", "", "Request body exceeds the size limit.")
			return
		}
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "invalid_json", "", "Request body must be valid JSON.")
		return
	}
	request, err := openaicompat.ParseResponsesRequest(body)
	if err != nil {
		h.writeRelayError(w, err, false)
		return
	}
	lease, ok := h.acquireAILease(w, r, principal.UserID, request.ModerationText())
	if !ok {
		return
	}
	defer releaseAILease(lease)

	stream := &responsesSSEWriter{response: w}
	usageRecorded := false
	recordUsage := func() {
		if usageRecorded || h.guard == nil {
			return
		}
		usageRecorded = true
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Second)
		defer cancel()
		if err := h.guard.RecordSuccessfulReply(ctx, principal.UserID); err != nil {
			h.logger.Error(
				"record delivered OpenAI Responses usage failed",
				"model", request.Model,
				"error", redact.String(err.Error()),
			)
		}
	}
	callbacks := openaicompat.ResponsesStreamCallbacks{}
	if request.Stream {
		callbacks.OnStart = stream.start
		callbacks.OnEvent = func(event openaicompat.ResponsesStreamEvent) error {
			if err := stream.writeEvent(event); err != nil {
				return err
			}
			if isSuccessfulResponsesStatus(strings.TrimPrefix(event.Type, "response.")) {
				recordUsage()
			}
			return nil
		}
	}
	result, err := h.service.Relay(r.Context(), request, callbacks)
	if err != nil {
		if errors.Is(err, context.Canceled) || stream.err != nil {
			h.logger.Debug("OpenAI Responses request canceled", "model", request.Model)
			return
		}
		if stream.started {
			h.logger.Warn(
				"OpenAI Responses stream interrupted",
				"model", request.Model,
				"channel_id", result.ChannelID,
				"attempts", result.Attempts,
				"error", redact.String(err.Error()),
			)
			_ = stream.writeEvent(openaicompat.ResponsesStreamEvent{
				Type: "error",
				Data: mustJSON(map[string]any{
					"type": "error", "code": "stream_error", "param": nil,
					"message": "The response stream was interrupted.",
				}),
			})
			return
		}
		copyResponseHeaders(w.Header(), result.Header)
		if result.UpstreamRequestID != "" {
			w.Header().Set("X-Upstream-Request-ID", result.UpstreamRequestID)
		}
		h.logger.Warn(
			"OpenAI Responses request failed",
			"model", request.Model,
			"channel_id", result.ChannelID,
			"attempts", result.Attempts,
			"error", redact.String(err.Error()),
		)
		h.writeRelayError(w, err, false)
		return
	}
	h.logCompletion(result)
	if request.Stream {
		return
	}
	copyResponseHeaders(w.Header(), result.Header)
	if result.UpstreamRequestID != "" {
		w.Header().Set("X-Upstream-Request-ID", result.UpstreamRequestID)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	status := result.StatusCode
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	written, err := w.Write(result.Body)
	if err != nil || written != len(result.Body) {
		if err == nil {
			err = io.ErrShortWrite
		}
		h.logger.Debug("write OpenAI Responses body failed", "model", request.Model, "error", redact.String(err.Error()))
		return
	}
	if isSuccessfulResponsesStatus(result.ResponseStatus) {
		if err := http.NewResponseController(w).Flush(); err != nil {
			h.logger.Debug("flush OpenAI Responses body failed", "model", request.Model, "error", redact.String(err.Error()))
			return
		}
		recordUsage()
	}
}

func (h *Handler) requirePrincipal(w http.ResponseWriter, r *http.Request) (authapp.Principal, bool) {
	return httpauth.RequireBearerAccessContext(
		w, r, h.auth.DecodeActiveAccessToken, nil, "", func(w http.ResponseWriter, status int, code string, message string) {
			typeName := "invalid_request_error"
			if status >= http.StatusInternalServerError {
				typeName = "server_error"
			}
			writeOpenAIError(w, status, typeName, strings.ToLower(code), "", message)
		},
		func(err error) {
			h.logger.Error("validate OpenAI Responses access token failed", "error", redact.String(err.Error()))
		},
	)
}

func (h *Handler) acquireAILease(w http.ResponseWriter, r *http.Request, userID string, content string) (airiskapp.Lease, bool) {
	if h.guard == nil {
		return nil, true
	}
	lease, err := h.guard.Acquire(r.Context(), userID, "openai_responses", content, true)
	if err == nil {
		return lease, true
	}
	h.writeAIGuardError(w, err)
	return nil, false
}

func (h *Handler) writeAIGuardError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, airiskapp.ErrAccessBlocked):
		writeOpenAIError(w, http.StatusForbidden, "permission_error", "ai_access_blocked", "", err.Error())
	case errors.Is(err, airiskapp.ErrContentBlocked):
		writeOpenAIError(w, http.StatusUnprocessableEntity, "invalid_request_error", "ai_content_blocked", "input", err.Error())
	case errors.Is(err, airiskapp.ErrQuotaExceeded):
		writeOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "ai_daily_quota_exceeded", "", err.Error())
	case errors.Is(err, airiskapp.ErrConcurrencyExceeded):
		writeOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "ai_concurrency_limit", "", err.Error())
	case errors.Is(err, airiskapp.ErrUnavailable):
		writeOpenAIError(w, http.StatusServiceUnavailable, "server_error", "ai_guard_unavailable", "", "AI risk control is temporarily unavailable.")
	default:
		h.logger.Error("apply OpenAI Responses AI guard failed", "error", redact.String(err.Error()))
		writeOpenAIError(w, http.StatusInternalServerError, "server_error", "internal_error", "", "Failed to authorize the AI request.")
	}
}

func isSuccessfulResponsesStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "incomplete":
		return true
	default:
		return false
	}
}

func (h *Handler) writeRelayError(w http.ResponseWriter, err error, started bool) {
	if started || errors.Is(err, context.Canceled) {
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		writeOpenAIError(w, http.StatusGatewayTimeout, "server_error", "request_timeout", "", "The request timed out.")
		return
	}
	var apiErr *openaicompat.APIError
	if errors.As(err, &apiErr) {
		status := apiErr.Status
		if status <= 0 {
			status = http.StatusBadGateway
		}
		if (status == http.StatusUnauthorized || status == http.StatusForbidden) && apiErr.Type == "upstream_error" {
			status = http.StatusBadGateway
		}
		writeOpenAIError(w, status, apiErr.Type, apiErr.Code, apiErr.Param, apiErr.Message)
		return
	}
	h.logger.Error("OpenAI Responses relay failed", "error", redact.String(err.Error()))
	writeOpenAIError(w, http.StatusBadGateway, "server_error", "upstream_error", "", "The model provider request failed.")
}

func (h *Handler) logCompletion(result openaicompat.ResponsesResult) {
	if h.usage != nil {
		h.usage.ObserveOpenAIResponsesUsage(result.Usage.InputTokens, result.Usage.OutputTokens)
	}
	h.logger.Info(
		"OpenAI Responses request finished",
		"response_id", result.ResponseID,
		"response_status", result.ResponseStatus,
		"upstream_request_id", result.UpstreamRequestID,
		"logical_model", result.LogicalModel,
		"model", result.Model,
		"channel_id", result.ChannelID,
		"provider", result.ProviderCode,
		"attempts", result.Attempts,
		"stream", result.Stream,
		"input_tokens", result.Usage.InputTokens,
		"output_tokens", result.Usage.OutputTokens,
		"total_tokens", result.Usage.TotalTokens,
	)
}

type responsesSSEWriter struct {
	response http.ResponseWriter
	started  bool
	err      error
}

func (w *responsesSSEWriter) start(headers http.Header) error {
	if w == nil {
		return errors.New("Responses SSE writer is nil")
	}
	if w.err != nil {
		return w.err
	}
	if w.started {
		return nil
	}
	copyResponseHeaders(w.response.Header(), headers)
	w.response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.response.Header().Set("Cache-Control", "no-cache")
	w.response.Header().Set("Connection", "keep-alive")
	w.response.Header().Set("X-Accel-Buffering", "no")
	w.response.WriteHeader(http.StatusOK)
	w.started = true
	return nil
}

func (w *responsesSSEWriter) writeEvent(event openaicompat.ResponsesStreamEvent) error {
	if w == nil {
		return errors.New("Responses SSE writer is nil")
	}
	if w.err != nil {
		return w.err
	}
	if !w.started {
		if err := w.start(nil); err != nil {
			return err
		}
	}
	eventType := strings.TrimSpace(event.Type)
	if eventType == "" || strings.ContainsAny(eventType, "\r\n") {
		w.err = errors.New("Responses SSE event type is invalid")
		return w.err
	}
	if _, err := fmt.Fprintf(w.response, "event: %s\n", eventType); err != nil {
		w.err = err
		return err
	}
	lines := strings.Split(string(event.Data), "\n")
	for _, line := range lines {
		if _, err := fmt.Fprintf(w.response, "data: %s\n", line); err != nil {
			w.err = err
			return err
		}
	}
	if _, err := io.WriteString(w.response, "\n"); err != nil {
		w.err = err
		return err
	}
	if err := http.NewResponseController(w.response).Flush(); err != nil {
		w.err = err
		return err
	}
	return nil
}

func copyResponseHeaders(destination http.Header, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func writeOpenAIError(w http.ResponseWriter, status int, typeName string, code string, param string, message string) {
	if strings.TrimSpace(typeName) == "" {
		typeName = "server_error"
	}
	payload := map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    typeName,
			"param":   nil,
			"code":    code,
		},
	}
	if strings.TrimSpace(param) != "" {
		payload["error"].(map[string]any)["param"] = param
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

var errRequestBodyTooLarge = errors.New("Responses request body is too large")

func readRequestBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, errors.New("request body is empty")
	}
	defer r.Body.Close()
	reader := http.MaxBytesReader(w, r.Body, maxResponsesRequestBody)
	body, err := io.ReadAll(reader)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			return nil, errRequestBodyTooLarge
		}
		return nil, err
	}
	return body, nil
}

func releaseAILease(lease airiskapp.Lease) {
	if lease == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = lease.Release(ctx)
}

func mustJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}
