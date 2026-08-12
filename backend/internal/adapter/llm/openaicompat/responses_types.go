package openaicompat

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
)

const maxResponsesOutputTokens = math.MaxInt32 / 2

// APIError is an OpenAI-compatible public error with an HTTP status.
type APIError struct {
	Status  int
	Type    string
	Code    string
	Param   string
	Message string
	cause   error
}

func (e *APIError) Error() string {
	if e == nil {
		return "OpenAI-compatible request failed"
	}
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return "OpenAI-compatible request failed"
}

func (e *APIError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func invalidResponsesRequest(param string, message string) *APIError {
	return &APIError{
		Status:  http.StatusBadRequest,
		Type:    "invalid_request_error",
		Code:    "invalid_request",
		Param:   param,
		Message: message,
	}
}

func unsupportedResponsesParameter(param string, message string) *APIError {
	return &APIError{
		Status:  http.StatusBadRequest,
		Type:    "invalid_request_error",
		Code:    "unsupported_parameter",
		Param:   param,
		Message: message,
	}
}

// ResponsesRequest is a validated Responses API request.
type ResponsesRequest struct {
	Model        string
	Stream       bool
	raw          map[string]any
	input        any
	instructions any
}

// ParseResponsesRequest validates the supported public Responses request fields.
func ParseResponsesRequest(body []byte) (ResponsesRequest, error) {
	var raw map[string]any
	if err := decodeJSON(body, &raw); err != nil {
		return ResponsesRequest{}, invalidResponsesRequest("", "Request body must be valid JSON.")
	}
	if raw == nil {
		return ResponsesRequest{}, invalidResponsesRequest("", "Request body must be a JSON object.")
	}
	if err := validateResponsesTopLevelFields(raw); err != nil {
		return ResponsesRequest{}, err
	}
	model, _ := raw["model"].(string)
	model = strings.TrimSpace(model)
	if model == "" {
		return ResponsesRequest{}, invalidResponsesRequest("model", "Field 'model' is required.")
	}
	if len([]rune(model)) > 100 {
		return ResponsesRequest{}, invalidResponsesRequest("model", "Field 'model' must not exceed 100 characters.")
	}
	input, exists := raw["input"]
	if !exists || input == nil {
		return ResponsesRequest{}, invalidResponsesRequest("input", "Field 'input' is required.")
	}
	if err := validateResponsesInput(input); err != nil {
		return ResponsesRequest{}, err
	}
	stream := false
	if value, exists := raw["stream"]; exists {
		parsed, ok := value.(bool)
		if !ok {
			return ResponsesRequest{}, invalidResponsesRequest("stream", "Field 'stream' must be a boolean.")
		}
		stream = parsed
	}
	if value, exists := raw["temperature"]; exists && value != nil {
		parsed, ok := jsonNumberFloat64(value)
		if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 || parsed > 2 {
			return ResponsesRequest{}, invalidResponsesRequest("temperature", "Field 'temperature' must be between 0 and 2.")
		}
	}
	if value, exists := raw["max_output_tokens"]; exists && value != nil {
		parsed, ok := jsonNumberInt64(value)
		if !ok || parsed <= 0 || parsed > maxResponsesOutputTokens {
			return ResponsesRequest{}, invalidResponsesRequest("max_output_tokens", fmt.Sprintf("Field 'max_output_tokens' must be between 1 and %d.", maxResponsesOutputTokens))
		}
	}
	if value, exists := raw["instructions"]; exists && value != nil {
		if err := validateResponsesInstructions(value); err != nil {
			return ResponsesRequest{}, err
		}
	}
	if value, exists := raw["tools"]; exists && value != nil {
		tools, ok := value.([]any)
		if !ok {
			return ResponsesRequest{}, invalidResponsesRequest("tools", "Field 'tools' must be an array.")
		}
		for _, rawTool := range tools {
			tool, ok := rawTool.(map[string]any)
			if !ok {
				return ResponsesRequest{}, invalidResponsesRequest("tools", "Each tool must be an object.")
			}
			typeName, _ := tool["type"].(string)
			if strings.TrimSpace(typeName) != "function" {
				return ResponsesRequest{}, unsupportedResponsesParameter("tools", "Only function tools are supported by this endpoint.")
			}
			name, _ := tool["name"].(string)
			if strings.TrimSpace(name) == "" {
				return ResponsesRequest{}, invalidResponsesRequest("tools", "Function tools require 'name'.")
			}
		}
	}
	if value, exists := raw["tool_choice"]; exists && value != nil {
		if err := validateResponsesToolChoice(value); err != nil {
			return ResponsesRequest{}, err
		}
	}
	if value, exists := raw["background"]; exists && !isEmptyResponsesValue(value) {
		return ResponsesRequest{}, unsupportedResponsesParameter("background", "Background responses are not supported because this service does not expose response retrieval endpoints.")
	}
	if value, exists := raw["store"]; exists {
		store, ok := value.(bool)
		if !ok {
			return ResponsesRequest{}, invalidResponsesRequest("store", "Field 'store' must be a boolean.")
		}
		if store {
			return ResponsesRequest{}, unsupportedResponsesParameter("store", "Stored responses are not supported because this service does not expose response retrieval endpoints.")
		}
	}
	if value, exists := raw["previous_response_id"]; exists && !isEmptyResponsesValue(value) {
		return ResponsesRequest{}, unsupportedResponsesParameter("previous_response_id", "Field 'previous_response_id' is not supported across routed channels.")
	}
	if value, exists := raw["conversation"]; exists && !isEmptyResponsesValue(value) {
		return ResponsesRequest{}, unsupportedResponsesParameter("conversation", "Field 'conversation' is not supported across routed channels.")
	}
	if value, exists := raw["prompt"]; exists && !isEmptyResponsesValue(value) {
		return ResponsesRequest{}, unsupportedResponsesParameter("prompt", "Reusable provider prompts are not supported across routed channels.")
	}
	if err := rejectUnreviewedResponsesContent(input); err != nil {
		return ResponsesRequest{}, err
	}
	if err := rejectUnreviewedResponsesContent(raw["instructions"]); err != nil {
		return ResponsesRequest{}, err
	}
	return ResponsesRequest{
		Model:        model,
		Stream:       stream,
		raw:          raw,
		input:        input,
		instructions: raw["instructions"],
	}, nil
}

func validateResponsesTopLevelFields(raw map[string]any) error {
	supported := map[string]bool{
		"model": true, "input": true, "instructions": true, "stream": true,
		"tools": true, "tool_choice": true, "temperature": true, "top_p": true,
		"max_output_tokens": true, "max_tool_calls": true, "parallel_tool_calls": true,
		"service_tier": true, "user": true, "reasoning": true, "text": true,
		"metadata": true, "include": true, "prompt": true, "prompt_cache_key": true,
		"safety_identifier": true, "stream_options": true, "top_logprobs": true,
		"truncation": true, "store": true, "background": true,
		"previous_response_id": true, "conversation": true,
	}
	for name := range raw {
		if !supported[name] {
			return unsupportedResponsesParameter(name, fmt.Sprintf("Field %q is not supported by this Responses compatibility endpoint.", name))
		}
	}
	return nil
}

func rejectUnreviewedResponsesContent(value any) error {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if err := rejectUnreviewedResponsesContent(item); err != nil {
				return err
			}
		}
	case map[string]any:
		typeName, _ := typed["type"].(string)
		switch strings.ToLower(strings.TrimSpace(typeName)) {
		case "input_file", "input_audio", "audio":
			return unsupportedResponsesParameter("input", "File and audio input are not supported by this endpoint's content review boundary.")
		}
		for _, item := range typed {
			if err := rejectUnreviewedResponsesContent(item); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateResponsesInput(input any) error {
	switch value := input.(type) {
	case string:
		if strings.TrimSpace(value) == "" {
			return invalidResponsesRequest("input", "Field 'input' must not be empty.")
		}
		return nil
	case []any:
		if len(value) == 0 {
			return invalidResponsesRequest("input", "Field 'input' must not be empty.")
		}
		for _, item := range value {
			if err := validateResponsesInputItem(item); err != nil {
				return err
			}
		}
		return nil
	default:
		return invalidResponsesRequest("input", "Field 'input' must be a string or an array of input items.")
	}
}

func validateResponsesInstructions(value any) error {
	switch typed := value.(type) {
	case string:
		return nil
	case []any:
		for _, part := range typed {
			if err := validateResponsesContentPart(part, "instructions", false); err != nil {
				return err
			}
		}
		return nil
	default:
		return invalidResponsesRequest("instructions", "Field 'instructions' must be a string or an array of content parts.")
	}
}

func validateResponsesInputItem(raw any) error {
	item, ok := raw.(map[string]any)
	if !ok {
		return invalidResponsesRequest("input", "Each input item must be an object.")
	}
	typeName, _ := item["type"].(string)
	role, _ := item["role"].(string)
	if strings.TrimSpace(typeName) == "" && strings.TrimSpace(role) != "" {
		typeName = "message"
	}
	switch strings.TrimSpace(typeName) {
	case "message":
		switch strings.TrimSpace(role) {
		case "user", "assistant", "system", "developer":
		default:
			return invalidResponsesRequest("input", "Input message role must be user, assistant, system, or developer.")
		}
		content, exists := item["content"]
		if !exists {
			return invalidResponsesRequest("input", "Input messages require 'content'.")
		}
		return validateResponsesMessageContent(content, strings.TrimSpace(role))
	case "function_call":
		callID, _ := item["call_id"].(string)
		if strings.TrimSpace(callID) == "" {
			callID, _ = item["id"].(string)
		}
		name, _ := item["name"].(string)
		if strings.TrimSpace(callID) == "" || strings.TrimSpace(name) == "" {
			return invalidResponsesRequest("input", "Function call input items require 'call_id' and 'name'.")
		}
		if arguments, exists := item["arguments"]; exists {
			if _, ok := arguments.(string); !ok {
				return invalidResponsesRequest("input", "Function call 'arguments' must be a JSON string.")
			}
		}
		return nil
	case "function_call_output":
		callID, _ := item["call_id"].(string)
		if strings.TrimSpace(callID) == "" {
			return invalidResponsesRequest("input", "Function call output items require 'call_id'.")
		}
		if _, ok := item["output"].(string); !ok {
			return unsupportedResponsesParameter("input", "Function call output must be a string for this endpoint.")
		}
		return nil
	default:
		return unsupportedResponsesParameter("input", fmt.Sprintf("Input item type %q is not supported by this endpoint.", typeName))
	}
}

func validateResponsesMessageContent(content any, role string) error {
	switch typed := content.(type) {
	case string:
		return nil
	case []any:
		if len(typed) == 0 {
			return invalidResponsesRequest("input", "Input message content must not be empty.")
		}
		for _, part := range typed {
			if err := validateResponsesContentPart(part, "input", role == "user"); err != nil {
				return err
			}
		}
		return nil
	default:
		return invalidResponsesRequest("input", "Input message content must be a string or an array of content parts.")
	}
}

func validateResponsesContentPart(raw any, param string, allowImage bool) error {
	part, ok := raw.(map[string]any)
	if !ok {
		return invalidResponsesRequest(param, "Content parts must be objects.")
	}
	typeName, _ := part["type"].(string)
	switch strings.TrimSpace(typeName) {
	case "input_text", "output_text", "text":
		if _, ok := part["text"].(string); !ok {
			return invalidResponsesRequest(param, "Text content parts require a string 'text' field.")
		}
		return nil
	case "input_image":
		if !allowImage {
			return unsupportedResponsesParameter(param, "Image content is only supported in user messages.")
		}
		imageURL, ok := part["image_url"].(string)
		if !ok || strings.TrimSpace(imageURL) == "" {
			return unsupportedResponsesParameter(param, "Image content requires a non-empty 'image_url'; provider file references are not supported.")
		}
		return nil
	case "refusal":
		if _, ok := part["refusal"].(string); !ok {
			return invalidResponsesRequest(param, "Refusal content parts require a string 'refusal' field.")
		}
		return nil
	case "input_file", "input_audio", "audio":
		return unsupportedResponsesParameter(param, "File and audio input are not supported by this endpoint's content review boundary.")
	default:
		return unsupportedResponsesParameter(param, fmt.Sprintf("Content part type %q is not supported by this endpoint.", typeName))
	}
}

func validateResponsesToolChoice(value any) error {
	switch typed := value.(type) {
	case string:
		switch strings.TrimSpace(typed) {
		case "auto", "none", "required":
			return nil
		default:
			return unsupportedResponsesParameter("tool_choice", "Field 'tool_choice' must be auto, none, required, or a named function.")
		}
	case map[string]any:
		typeName, _ := typed["type"].(string)
		name, _ := typed["name"].(string)
		if strings.TrimSpace(typeName) != "function" || strings.TrimSpace(name) == "" {
			return unsupportedResponsesParameter("tool_choice", "Named tool choices must identify a function by name.")
		}
		return nil
	default:
		return invalidResponsesRequest("tool_choice", "Field 'tool_choice' must be a string or an object.")
	}
}

func jsonNumberFloat64(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	default:
		return 0, false
	}
}

func jsonNumberInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case float64:
		parsed := int64(typed)
		return parsed, float64(parsed) == typed
	default:
		return 0, false
	}
}

// ModerationText returns bounded textual request content for the existing AI guard.
func (r ResponsesRequest) ModerationText() string {
	parts := make([]string, 0, 8)
	collectResponsesText(r.instructions, &parts)
	collectResponsesText(r.input, &parts)
	collectResponsesText(r.raw["tools"], &parts)
	collectResponsesText(r.raw["text"], &parts)
	text := strings.Join(parts, "\n")
	const maxRunes = 32 << 10
	runes := []rune(text)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes])
	}
	return text
}

func collectResponsesText(value any, parts *[]string) {
	switch typed := value.(type) {
	case string:
		if text := strings.TrimSpace(typed); text != "" {
			*parts = append(*parts, text)
		}
	case []any:
		for _, item := range typed {
			collectResponsesText(item, parts)
		}
	case map[string]any:
		for _, name := range []string{"text", "content", "output", "arguments", "refusal", "description", "name", "title"} {
			if item, exists := typed[name]; exists {
				collectResponsesText(item, parts)
			}
		}
		if item, exists := typed["variables"]; exists {
			collectResponsesNestedText(item, parts)
		}
		for _, name := range []string{"parameters", "schema"} {
			if item, exists := typed[name]; exists {
				collectResponsesSchemaText(item, parts)
			}
		}
	}
}

func collectResponsesSchemaText(value any, parts *[]string) {
	schema, ok := value.(map[string]any)
	if !ok {
		return
	}
	for _, name := range []string{"description", "title", "enum", "const", "default", "examples"} {
		if item, exists := schema[name]; exists {
			collectResponsesNestedText(item, parts)
		}
	}
	for _, name := range []string{"properties", "definitions", "$defs"} {
		properties, _ := schema[name].(map[string]any)
		for propertyName, property := range properties {
			if text := strings.TrimSpace(propertyName); text != "" {
				*parts = append(*parts, text)
			}
			collectResponsesSchemaText(property, parts)
		}
	}
	if items, exists := schema["items"]; exists {
		collectResponsesSchemaText(items, parts)
	}
	for _, name := range []string{"allOf", "anyOf", "oneOf"} {
		items, _ := schema[name].([]any)
		for _, item := range items {
			collectResponsesSchemaText(item, parts)
		}
	}
}

func collectResponsesNestedText(value any, parts *[]string) {
	switch typed := value.(type) {
	case string:
		if text := strings.TrimSpace(typed); text != "" {
			*parts = append(*parts, text)
		}
	case []any:
		for _, item := range typed {
			collectResponsesNestedText(item, parts)
		}
	case map[string]any:
		for name, item := range typed {
			if text := strings.TrimSpace(name); text != "" {
				*parts = append(*parts, text)
			}
			collectResponsesNestedText(item, parts)
		}
	}
}

func (r ResponsesRequest) bodyForModel(model string) ([]byte, error) {
	payload := cloneObject(r.raw)
	payload["model"] = strings.TrimSpace(model)
	if _, exists := payload["store"]; !exists {
		payload["store"] = false
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &ProtocolError{cause: fmt.Errorf("encode Responses request: %w", err)}
	}
	return body, nil
}

func cloneObject(source map[string]any) map[string]any {
	cloned := make(map[string]any, len(source))
	for name, value := range source {
		cloned[name] = value
	}
	return cloned
}

// ResponsesUsage is the normalized token metadata returned by either protocol.
type ResponsesUsage struct {
	InputTokens     int
	OutputTokens    int
	TotalTokens     int
	CachedTokens    int
	ReasoningTokens int
}

// ResponsesResult contains the relay result and provider metadata used for logging.
type ResponsesResult struct {
	StatusCode        int
	Header            http.Header
	Body              []byte
	Stream            bool
	ResponseID        string
	ResponseStatus    string
	UpstreamRequestID string
	LogicalModel      string
	Model             string
	ChannelID         string
	ProviderCode      string
	Attempts          int
	Usage             ResponsesUsage
}

// ResponsesStreamEvent is one Responses API SSE event.
type ResponsesStreamEvent struct {
	Type string
	Data []byte
}

// ResponsesStreamCallbacks decouples the relay from net/http response encoding.
type ResponsesStreamCallbacks struct {
	OnStart func(http.Header) error
	OnEvent func(ResponsesStreamEvent) error
}

func validateStreamCallbacks(callbacks ResponsesStreamCallbacks) error {
	if callbacks.OnStart == nil || callbacks.OnEvent == nil {
		return errors.New("Responses stream callbacks are incomplete")
	}
	return nil
}
