package openaicompat

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	adminaiconfigapp "mathstudy/backend/internal/application/adminaiconfig"
	"mathstudy/backend/internal/platform/outbound"
)

// ResponsesRuntimeProvider supplies persisted model/channel routing for the public compatibility API.
type ResponsesRuntimeProvider interface {
	RuntimeConfigsForModel(context.Context, string) ([]adminaiconfigapp.RuntimeConfig, bool, error)
}

// ResponsesDispatcher relays Responses requests through the configured OpenAI-compatible channels.
type ResponsesDispatcher struct {
	provider ResponsesRuntimeProvider
	client   *http.Client
	cache    *EndpointCache
}

// NewResponsesDispatcher creates a Responses relay with the public-HTTPS outbound boundary.
func NewResponsesDispatcher(provider ResponsesRuntimeProvider, clients ...*http.Client) (*ResponsesDispatcher, error) {
	if provider == nil {
		return nil, errors.New("Responses runtime provider is nil")
	}
	var client *http.Client
	if len(clients) > 0 {
		client = clients[0]
	}
	if client == nil {
		client = outbound.NewPublicHTTPSClient(20 * time.Second)
		if transport, ok := client.Transport.(*http.Transport); ok {
			transport.MaxIdleConnsPerHost = 20
		}
	}
	return &ResponsesDispatcher{provider: provider, client: client, cache: defaultEndpointCache}, nil
}

// Relay selects a channel, adapts the protocol when required, and retries configured failures before downstream delivery.
func (d *ResponsesDispatcher) Relay(ctx context.Context, request ResponsesRequest, callbacks ResponsesStreamCallbacks) (ResponsesResult, error) {
	if d == nil || d.provider == nil || d.client == nil {
		return ResponsesResult{}, errors.New("Responses dispatcher is not configured")
	}
	if request.Stream {
		if err := validateStreamCallbacks(callbacks); err != nil {
			return ResponsesResult{}, err
		}
	}
	configs, ok, err := d.provider.RuntimeConfigsForModel(ctx, request.Model)
	if err != nil {
		return ResponsesResult{}, fmt.Errorf("load Responses runtime candidates: %w", err)
	}
	if !ok || len(configs) == 0 {
		return ResponsesResult{}, &APIError{
			Status: http.StatusNotFound, Type: "invalid_request_error", Code: "model_not_found",
			Param: "model", Message: fmt.Sprintf("The model %q does not exist or has no active channel.", request.Model),
		}
	}
	var lastResult ResponsesResult
	var lastErr error
	for index, runtime := range configs {
		if err := ctx.Err(); err != nil {
			return ResponsesResult{}, err
		}
		result, err := d.relayCandidate(ctx, request, runtime, callbacks)
		result.Attempts = index + 1
		result.LogicalModel = request.Model
		result.ChannelID = runtime.ChannelID
		result.ProviderCode = runtime.ProviderCode
		if err == nil {
			return result, nil
		}
		lastResult = result
		lastErr = err
		if streamWasDelivered(err) || index == len(configs)-1 || !retryableResponsesError(ctx, err, result.StatusCode) {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("Responses request has no usable channel")
	}
	return lastResult, lastErr
}

func (d *ResponsesDispatcher) relayCandidate(
	ctx context.Context,
	request ResponsesRequest,
	runtime adminaiconfigapp.RuntimeConfig,
	callbacks ResponsesStreamCallbacks,
) (ResponsesResult, error) {
	if err := validateRuntimeCapabilities(request, runtime.Capabilities); err != nil {
		return ResponsesResult{}, err
	}
	cacheKey := responsesRuntimeCacheKey(runtime)
	selected := d.cache.load(cacheKey)
	nativeUnsupported := false
	chatEnabled := capabilityEnabled(runtime.Capabilities, "chat_completions", true)
	if capabilityEnabled(runtime.Capabilities, "responses", true) && (selected != endpointChatCompletions || !chatEnabled) {
		result, unsupported, err := d.relayNativeResponses(ctx, request, runtime, callbacks)
		if err == nil {
			d.cache.store(cacheKey, endpointResponses)
			return result, nil
		}
		if streamWasDelivered(err) || !unsupported {
			return result, err
		}
		nativeUnsupported = true
	}
	if !chatEnabled {
		return ResponsesResult{}, &APIError{
			Status: http.StatusBadRequest, Type: "invalid_request_error", Code: "unsupported_endpoint",
			Param: "model", Message: "The selected channel supports neither Responses nor Chat Completions fallback for this model.",
		}
	}
	result, err := d.relayChatFallback(ctx, request, runtime, callbacks)
	if err == nil && nativeUnsupported {
		d.cache.store(cacheKey, endpointChatCompletions)
	}
	return result, err
}

func responsesRuntimeCacheKey(runtime adminaiconfigapp.RuntimeConfig) string {
	baseURL := strings.ToLower(strings.TrimRight(strings.TrimSpace(runtime.BaseURL), "/"))
	return baseURL + "\x00" + strings.TrimSpace(runtime.Model)
}

func (d *ResponsesDispatcher) relayNativeResponses(
	ctx context.Context,
	request ResponsesRequest,
	runtime adminaiconfigapp.RuntimeConfig,
	callbacks ResponsesStreamCallbacks,
) (ResponsesResult, bool, error) {
	body, err := request.bodyForModel(runtime.Model)
	if err != nil {
		return ResponsesResult{}, false, err
	}
	response, err := d.doProviderRequest(ctx, runtime, "responses", body, request.Stream)
	if err != nil {
		return ResponsesResult{}, false, err
	}
	requestID := upstreamRequestID(response.Header)
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		unsupported, inspectErr := endpointUnsupported(response)
		if inspectErr != nil {
			discardAndClose(response.Body)
			return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, false, inspectErr
		}
		if unsupported {
			discardAndClose(response.Body)
			return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, true, errors.New("Responses endpoint is not supported")
		}
		result, relayErr := providerErrorResult(response)
		result.UpstreamRequestID = requestID
		return result, false, relayErr
	}
	if request.Stream {
		result, streamErr := streamNativeResponses(ctx, response, callbacks)
		result.UpstreamRequestID = requestID
		return result, false, streamErr
	}
	defer response.Body.Close()
	body, err = io.ReadAll(io.LimitReader(response.Body, maxResponseBodySize+1))
	if err != nil {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, false, err
	}
	if len(body) > maxResponseBodySize {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, false, &ProtocolError{cause: errors.New("Responses response exceeds size limit")}
	}
	responseID, model, status, usage, err := extractResponsesMetadata(body)
	if err != nil {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, false, err
	}
	body, err = sanitizeResponsesFailure(body, status)
	if err != nil {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, false, err
	}
	return ResponsesResult{
		StatusCode: response.StatusCode, Header: providerResponseHeaders(response.Header), Body: body,
		ResponseID: responseID, ResponseStatus: status, UpstreamRequestID: requestID, Model: model, Usage: usage,
	}, false, nil
}

func (d *ResponsesDispatcher) relayChatFallback(
	ctx context.Context,
	request ResponsesRequest,
	runtime adminaiconfigapp.RuntimeConfig,
	callbacks ResponsesStreamCallbacks,
) (ResponsesResult, error) {
	body, err := responsesRequestToChat(request, runtime.Model)
	if err != nil {
		return ResponsesResult{}, err
	}
	response, err := d.doProviderRequest(ctx, runtime, "chat/completions", body, request.Stream)
	if err != nil {
		return ResponsesResult{}, err
	}
	requestID := upstreamRequestID(response.Header)
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		result, relayErr := providerErrorResult(response)
		result.UpstreamRequestID = requestID
		return result, relayErr
	}
	if request.Stream {
		result, streamErr := streamChatAsResponses(ctx, response, request, runtime.Model, callbacks)
		result.UpstreamRequestID = requestID
		return result, streamErr
	}
	defer response.Body.Close()
	chatBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBodySize+1))
	if err != nil {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, err
	}
	if len(chatBody) > maxResponseBodySize {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, &ProtocolError{cause: errors.New("Chat Completions response exceeds size limit")}
	}
	responseID := newResponsesID()
	responsesBody, usage, err := chatResponseToResponses(chatBody, request, responseID, runtime.Model)
	if err != nil {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, err
	}
	_, model, status, _, err := extractResponsesMetadata(responsesBody)
	if err != nil {
		return ResponsesResult{StatusCode: response.StatusCode, UpstreamRequestID: requestID}, err
	}
	return ResponsesResult{
		StatusCode: response.StatusCode, Header: providerResponseHeaders(response.Header), Body: responsesBody,
		ResponseID: responseID, ResponseStatus: status, UpstreamRequestID: requestID, Model: model, Usage: usage,
	}, nil
}

func (d *ResponsesDispatcher) doProviderRequest(
	ctx context.Context,
	runtime adminaiconfigapp.RuntimeConfig,
	endpointPath string,
	body []byte,
	stream bool,
) (*http.Response, error) {
	timeout := runtime.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	endpointURL, err := providerEndpointURL(runtime.BaseURL, endpointPath)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpointURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(runtime.APIKey))
	request.Header.Set("Content-Type", "application/json")
	if stream {
		request.Header.Set("Accept", "text/event-stream")
	} else {
		request.Header.Set("Accept", "application/json")
	}
	client := *d.client
	client.Timeout = timeout
	return client.Do(request)
}

func providerEndpointURL(baseURL string, endpointPath string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("provider base URL is invalid")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + strings.TrimLeft(endpointPath, "/")
	parsed.RawPath = ""
	return parsed.String(), nil
}

func providerErrorResult(response *http.Response) (ResponsesResult, error) {
	if response == nil {
		return ResponsesResult{}, errors.New("provider returned no response")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxErrorBodySize+1))
	if err != nil {
		return ResponsesResult{StatusCode: response.StatusCode}, err
	}
	if len(body) > maxErrorBodySize {
		body = body[:maxErrorBodySize]
	}
	result := ResponsesResult{
		StatusCode: response.StatusCode, Header: providerResponseHeaders(response.Header), Body: body,
	}
	return result, &APIError{
		Status: response.StatusCode, Type: "upstream_error", Code: "upstream_error",
		Message: fmt.Sprintf("Upstream provider returned HTTP %d.", response.StatusCode),
	}
}

func validateRuntimeCapabilities(request ResponsesRequest, capabilities map[string]any) error {
	if value, exists := request.raw["tools"]; exists {
		tools, _ := value.([]any)
		if len(tools) > 0 && !capabilityEnabled(capabilities, "tools", true) {
			return unsupportedResponsesParameter("tools", "The selected model does not support tools.")
		}
	}
	if value, exists := request.raw["temperature"]; exists && value != nil && !capabilityEnabled(capabilities, "temperature", true) {
		return unsupportedResponsesParameter("temperature", "The selected model does not support 'temperature'.")
	}
	return nil
}

func capabilityEnabled(capabilities map[string]any, name string, defaultValue bool) bool {
	if capabilities == nil {
		return defaultValue
	}
	value, exists := capabilities[name]
	if !exists {
		return defaultValue
	}
	enabled, ok := value.(bool)
	if !ok {
		return defaultValue
	}
	return enabled
}

func streamWasDelivered(err error) bool {
	var streamErr *streamRelayError
	return errors.As(err, &streamErr) && streamErr.delivered
}

func retryableResponsesError(ctx context.Context, err error, status int) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ctx != nil && ctx.Err() == nil
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		if apiErr.Code == "unsupported_parameter" {
			return true
		}
		if status == 0 || (status >= http.StatusOK && status < http.StatusMultipleChoices) {
			status = apiErr.Status
		}
	}
	if IsProtocolError(err) && (status == 0 || (status >= http.StatusOK && status < http.StatusMultipleChoices)) {
		return true
	}
	if status != 0 {
		return status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound ||
			status == http.StatusRequestTimeout || status == http.StatusConflict || status == http.StatusTooManyRequests ||
			status >= http.StatusInternalServerError
	}
	var networkErr net.Error
	return errors.As(err, &networkErr)
}

func upstreamRequestID(header http.Header) string {
	for _, name := range []string{"x-request-id", "request-id", "x-correlation-id"} {
		if value := strings.TrimSpace(header.Get(name)); value != "" {
			return value
		}
	}
	return ""
}
