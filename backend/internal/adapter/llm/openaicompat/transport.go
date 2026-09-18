package openaicompat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

const (
	maxRequestBodySize  = 8 << 20
	maxResponseBodySize = 16 << 20
	maxErrorBodySize    = 1 << 20
)

type endpoint uint8

const (
	endpointUnknown endpoint = iota
	endpointChatCompletions
	endpointResponses
)

// ProtocolPreference controls which OpenAI-compatible endpoint is tried first.
type ProtocolPreference uint8

const (
	ProtocolAuto ProtocolPreference = iota
	ProtocolResponsesFirst
)

// EndpointCache remembers the successful protocol for a base URL and model.
type EndpointCache struct {
	values sync.Map
}

// NewEndpointCache creates an isolated endpoint cache.
func NewEndpointCache() *EndpointCache {
	return &EndpointCache{}
}

func (c *EndpointCache) load(key string) endpoint {
	if c == nil {
		return endpointUnknown
	}
	value, ok := c.values.Load(key)
	if !ok {
		return endpointUnknown
	}
	selected, ok := value.(endpoint)
	if !ok {
		return endpointUnknown
	}
	return selected
}

func (c *EndpointCache) store(key string, selected endpoint) {
	if c != nil && key != "" && selected != endpointUnknown {
		c.values.Store(key, selected)
	}
}

var defaultEndpointCache = NewEndpointCache()

// ProtocolError reports an invalid automatic protocol conversion.
type ProtocolError struct {
	cause error
}

func (e *ProtocolError) Error() string {
	if e == nil || e.cause == nil {
		return "OpenAI protocol conversion failed"
	}
	return "OpenAI protocol conversion failed: " + e.cause.Error()
}

func (e *ProtocolError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// IsProtocolError reports whether err came from the automatic endpoint adapter.
func IsProtocolError(err error) bool {
	var protocolErr *ProtocolError
	return errors.As(err, &protocolErr)
}

// Transport automatically selects Chat Completions or Responses for non-streaming requests.
type Transport struct {
	base       http.RoundTripper
	cache      *EndpointCache
	preference ProtocolPreference
}

// NewTransport wraps base with the process-wide endpoint cache.
func NewTransport(base http.RoundTripper) *Transport {
	return NewTransportWithCache(base, defaultEndpointCache)
}

// NewTransportWithCache wraps base with an explicit cache.
func NewTransportWithCache(base http.RoundTripper, cache *EndpointCache) *Transport {
	return newTransport(base, cache, ProtocolAuto)
}

func newTransport(base http.RoundTripper, cache *EndpointCache, preference ProtocolPreference) *Transport {
	if base == nil {
		base = http.DefaultTransport
	}
	if cache == nil {
		cache = NewEndpointCache()
	}
	return &Transport{base: base, cache: cache, preference: preference}
}

// WrapClient clones client and installs automatic endpoint routing.
func WrapClient(client *http.Client) *http.Client {
	return wrapClient(client, ProtocolAuto)
}

// WrapClientForProvider clones client and applies the provider's preferred OpenAI protocol.
// OpenAI channels try Responses first; other compatible providers retain automatic routing.
func WrapClientForProvider(client *http.Client, providerCode string) *http.Client {
	preference := ProtocolAuto
	switch strings.ToLower(strings.TrimSpace(providerCode)) {
	case "openai", "openai-responses":
		preference = ProtocolResponsesFirst
	}
	return wrapClient(client, preference)
}

// ProviderClient supports channel-specific routing without sharing mutable client settings.
type ProviderClient struct {
	*http.Client
}

// NewProviderClient creates a client for administrator-managed channels.
func NewProviderClient(client *http.Client) *ProviderClient {
	return &ProviderClient{Client: WrapClient(client)}
}

// DoForProvider sends a request using the channel's protocol preference.
func (c *ProviderClient) DoForProvider(request *http.Request, providerCode string) (*http.Response, error) {
	return WrapClientForProvider(c.Client, providerCode).Do(request)
}

func wrapClient(client *http.Client, preference ProtocolPreference) *http.Client {
	if client == nil {
		client = &http.Client{}
	}
	cloned := *client
	base := cloned.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	if wrapped, ok := base.(*Transport); ok {
		if wrapped.preference != preference {
			cloned.Transport = newTransport(wrapped.base, wrapped.cache, preference)
		}
	} else {
		cloned.Transport = newTransport(base, defaultEndpointCache, preference)
	}
	return &cloned
}

// RoundTrip implements http.RoundTripper.
func (t *Transport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request == nil {
		return nil, errors.New("OpenAI transport request is nil")
	}
	if request.Method != http.MethodPost || !isChatCompletionsPath(request.URL.Path) || request.Body == nil {
		return t.base.RoundTrip(request)
	}
	body, err := readLimited(request.Body, maxRequestBodySize)
	if err != nil {
		return nil, &ProtocolError{cause: fmt.Errorf("read chat request: %w", err)}
	}
	chatRequest := cloneRequest(request, request.URL, body)
	model, streaming, err := inspectChatRequest(body)
	if err != nil {
		return nil, &ProtocolError{cause: err}
	}
	if streaming {
		return t.base.RoundTrip(chatRequest)
	}
	cacheKey := endpointCacheKey(request.URL, model)
	if t.preference == ProtocolResponsesFirst {
		cacheKey += "\x00responses-first"
	}
	selected := t.cache.load(cacheKey)
	if selected == endpointResponses || (selected == endpointUnknown && (t.preference == ProtocolResponsesFirst || IsReasoningModel(model))) {
		return t.tryResponsesFirst(chatRequest, body, cacheKey)
	}
	return t.tryChatFirst(chatRequest, body, cacheKey)
}

func (t *Transport) tryChatFirst(request *http.Request, body []byte, cacheKey string) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	unsupported, err := endpointUnsupported(response)
	if err != nil {
		return nil, &ProtocolError{cause: err}
	}
	if !unsupported {
		if isSuccess(response.StatusCode) {
			t.cache.store(cacheKey, endpointChatCompletions)
		}
		return response, nil
	}
	discardAndClose(response.Body)
	return t.roundTripResponses(request, body, cacheKey)
}

func (t *Transport) tryResponsesFirst(request *http.Request, body []byte, cacheKey string) (*http.Response, error) {
	response, err := t.roundTripResponses(request, body, cacheKey)
	if err != nil {
		return nil, err
	}
	unsupported, inspectErr := endpointUnsupported(response)
	if inspectErr != nil {
		return nil, &ProtocolError{cause: inspectErr}
	}
	if !unsupported {
		return response, nil
	}
	discardAndClose(response.Body)
	chatResponse, err := t.base.RoundTrip(cloneRequest(request, request.URL, body))
	if err != nil {
		return nil, err
	}
	if isSuccess(chatResponse.StatusCode) {
		t.cache.store(cacheKey, endpointChatCompletions)
	}
	return chatResponse, nil
}

func (t *Transport) roundTripResponses(request *http.Request, chatBody []byte, cacheKey string) (*http.Response, error) {
	responsesBody, err := chatRequestToResponses(chatBody)
	if err != nil {
		return nil, &ProtocolError{cause: err}
	}
	responsesURL := responsesEndpointURL(request.URL)
	responsesRequest := cloneRequest(request, responsesURL, responsesBody)
	responsesRequest.Header.Set("Accept", "application/json")
	response, err := t.base.RoundTrip(responsesRequest)
	if err != nil {
		return nil, err
	}
	if !isSuccess(response.StatusCode) {
		return response, nil
	}
	converted, err := responsesResponseToChat(response)
	if err != nil {
		discardAndClose(response.Body)
		return nil, &ProtocolError{cause: err}
	}
	t.cache.store(cacheKey, endpointResponses)
	return converted, nil
}

func inspectChatRequest(body []byte) (string, bool, error) {
	var payload struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err := decodeJSON(body, &payload); err != nil {
		return "", false, fmt.Errorf("decode chat request: %w", err)
	}
	model := strings.TrimSpace(payload.Model)
	if model == "" {
		return "", false, errors.New("chat request model is empty")
	}
	return model, payload.Stream, nil
}

// IsReasoningModel reports whether the model belongs to a reasoning family restricted by the upstream SDK.
func IsReasoningModel(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	if index := strings.LastIndexByte(model, '/'); index >= 0 {
		model = model[index+1:]
	}
	if hasReasoningModelPrefix(model) {
		return true
	}
	if index := strings.LastIndexByte(model, ':'); index >= 0 {
		return hasReasoningModelPrefix(model[index+1:])
	}
	return false
}

func hasReasoningModelPrefix(model string) bool {
	return strings.HasPrefix(model, "gpt-5") ||
		strings.HasPrefix(model, "o1") ||
		strings.HasPrefix(model, "o3") ||
		strings.HasPrefix(model, "o4")
}

func endpointUnsupported(response *http.Response) (bool, error) {
	if response == nil {
		return false, errors.New("provider returned no response")
	}
	switch response.StatusCode {
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusGone, http.StatusNotImplemented:
		return true, nil
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		body, err := readLimited(response.Body, maxErrorBodySize)
		if err != nil {
			return false, fmt.Errorf("read provider error response: %w", err)
		}
		response.Body = io.NopCloser(bytes.NewReader(body))
		response.ContentLength = int64(len(body))
		return explicitEndpointUnsupported(strings.ToLower(providerErrorText(body))), nil
	default:
		return false, nil
	}
}

func explicitEndpointUnsupported(text string) bool {
	text = strings.ToLower(text)
	for _, parameter := range []string{"parameter", "field", "temperature", "top_p", "max_tokens", "max_completion_tokens", "max_output_tokens", "response_format", "tool_choice"} {
		if strings.Contains(text, parameter) {
			return false
		}
	}
	mentionsProtocol := strings.Contains(text, "responses api") || strings.Contains(text, "/responses") || strings.Contains(text, "chat completions") || strings.Contains(text, "chat/completions")
	unsupported := strings.Contains(text, "not supported") ||
		strings.Contains(text, "does not support") ||
		strings.Contains(text, "doesn't support") ||
		strings.Contains(text, "unsupported") ||
		strings.Contains(text, "not implemented") ||
		strings.Contains(text, "not available") ||
		strings.Contains(text, "unknown")
	exclusiveSubject := strings.Contains(text, "model is only") ||
		strings.Contains(text, "model only") ||
		strings.Contains(text, "model can only") ||
		strings.Contains(text, "model must use") ||
		strings.Contains(text, "model requires") ||
		strings.Contains(text, "endpoint is only") ||
		strings.Contains(text, "endpoint only") ||
		strings.Contains(text, "route is only") ||
		strings.Contains(text, "route only")
	if mentionsProtocol && (exclusiveSubject || unsupported) {
		return true
	}
	mentionsRoute := strings.Contains(text, "endpoint") || strings.Contains(text, "route") || strings.Contains(text, "path")
	if !mentionsRoute || !unsupported {
		return false
	}
	return true
}

func providerErrorText(body []byte) string {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return string(body)
	}
	parts := make([]string, 0, 4)
	collectProviderErrorStrings(payload, &parts)
	if len(parts) == 0 {
		return string(body)
	}
	return strings.Join(parts, " ")
}

func collectProviderErrorStrings(value any, parts *[]string) {
	switch typed := value.(type) {
	case string:
		if text := strings.TrimSpace(typed); text != "" {
			*parts = append(*parts, text)
		}
	case []any:
		for _, item := range typed {
			collectProviderErrorStrings(item, parts)
		}
	case map[string]any:
		for _, item := range typed {
			collectProviderErrorStrings(item, parts)
		}
	}
}

func endpointCacheKey(value *url.URL, model string) string {
	if value == nil {
		return ""
	}
	path := strings.TrimSuffix(strings.TrimRight(value.EscapedPath(), "/"), "/chat/completions")
	return strings.ToLower(value.Scheme+"://"+value.Host) + path + "\x00" + strings.TrimSpace(model)
}

func responsesEndpointURL(value *url.URL) *url.URL {
	cloned := *value
	path := strings.TrimRight(cloned.Path, "/")
	cloned.Path = strings.TrimSuffix(path, "/chat/completions") + "/responses"
	cloned.RawPath = ""
	return &cloned
}

func isChatCompletionsPath(path string) bool {
	return strings.HasSuffix(strings.TrimRight(path, "/"), "/chat/completions")
}

func cloneRequest(request *http.Request, target *url.URL, body []byte) *http.Request {
	cloned := request.Clone(request.Context())
	cloned.URL = target
	cloned.Body = io.NopCloser(bytes.NewReader(body))
	cloned.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(body)), nil
	}
	cloned.ContentLength = int64(len(body))
	cloned.Header = request.Header.Clone()
	cloned.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	return cloned
}

func readLimited(reader io.ReadCloser, limit int64) ([]byte, error) {
	if reader == nil {
		return nil, errors.New("body is empty")
	}
	defer reader.Close()
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("body exceeds %d bytes", limit)
	}
	return body, nil
}

func discardAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 64<<10))
	_ = body.Close()
}

func isSuccess(status int) bool {
	return status >= http.StatusOK && status < http.StatusMultipleChoices
}
