package openaicompat

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func responsesRequestToChat(request ResponsesRequest, model string) ([]byte, error) {
	if err := validateChatFallbackFields(request.raw); err != nil {
		return nil, err
	}
	messages := make([]any, 0, 8)
	if request.instructions != nil {
		content, err := responsesContentToChat(request.instructions, "system")
		if err != nil {
			return nil, err
		}
		if content != nil {
			messages = append(messages, map[string]any{"role": "system", "content": content})
		}
	}
	inputMessages, err := responsesInputToChatMessages(request.input)
	if err != nil {
		return nil, err
	}
	messages = append(messages, inputMessages...)
	if len(messages) == 0 {
		return nil, invalidResponsesRequest("input", "Field 'input' contains no usable messages.")
	}
	chat := map[string]any{
		"model":    strings.TrimSpace(model),
		"messages": messages,
		"stream":   request.Stream,
	}
	if request.Stream {
		chat["stream_options"] = map[string]any{"include_usage": true}
	}
	copyFields(chat, request.raw, "temperature", "top_p", "parallel_tool_calls", "service_tier", "user")
	if value, exists := request.raw["max_output_tokens"]; exists {
		if IsReasoningModel(model) {
			chat["max_completion_tokens"] = value
		} else {
			chat["max_tokens"] = value
		}
	}
	if value, exists := request.raw["tools"]; exists {
		converted, err := responsesToolsToChat(value)
		if err != nil {
			return nil, err
		}
		chat["tools"] = converted
	}
	if value, exists := request.raw["tool_choice"]; exists {
		chat["tool_choice"] = responsesToolChoiceToChat(value)
	}
	if value, exists := request.raw["reasoning"]; exists && value != nil {
		reasoning, _ := value.(map[string]any)
		if effort, exists := reasoning["effort"]; exists {
			chat["reasoning_effort"] = effort
		}
	}
	if value, exists := request.raw["text"]; exists && value != nil {
		text, _ := value.(map[string]any)
		if format, exists := text["format"]; exists {
			chat["response_format"] = responsesTextFormatToChat(format)
		}
	}
	body, err := json.Marshal(chat)
	if err != nil {
		return nil, &ProtocolError{cause: fmt.Errorf("encode Chat Completions request: %w", err)}
	}
	return body, nil
}

func validateChatFallbackFields(raw map[string]any) error {
	supported := map[string]bool{
		"model": true, "input": true, "instructions": true, "stream": true,
		"tools": true, "tool_choice": true, "temperature": true, "top_p": true,
		"max_output_tokens": true, "parallel_tool_calls": true,
		"service_tier": true, "user": true, "reasoning": true,
		"text": true,
	}
	for name, value := range raw {
		if supported[name] || isEmptyResponsesValue(value) {
			continue
		}
		return unsupportedResponsesParameter(name, fmt.Sprintf("Field %q is not supported by this channel's Chat Completions fallback.", name))
	}
	if value, exists := raw["reasoning"]; exists && value != nil {
		reasoning, ok := value.(map[string]any)
		if !ok {
			return invalidResponsesRequest("reasoning", "Field 'reasoning' must be an object.")
		}
		for name, item := range reasoning {
			if name != "effort" && !isEmptyResponsesValue(item) {
				return unsupportedResponsesParameter("reasoning."+name, fmt.Sprintf("Field %q is not supported by this channel's Chat Completions fallback.", "reasoning."+name))
			}
		}
	}
	if value, exists := raw["text"]; exists && value != nil {
		text, ok := value.(map[string]any)
		if !ok {
			return invalidResponsesRequest("text", "Field 'text' must be an object.")
		}
		for name, item := range text {
			if name != "format" && !isEmptyResponsesValue(item) {
				return unsupportedResponsesParameter("text."+name, fmt.Sprintf("Field %q is not supported by this channel's Chat Completions fallback.", "text."+name))
			}
		}
	}
	return nil
}

func isEmptyResponsesValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case bool:
		return !typed
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

func responsesInputToChatMessages(input any) ([]any, error) {
	if text, ok := input.(string); ok {
		return []any{map[string]any{"role": "user", "content": text}}, nil
	}
	items, ok := input.([]any)
	if !ok {
		return nil, invalidResponsesRequest("input", "Field 'input' must be a string or an array of input items.")
	}
	messages := make([]any, 0, len(items))
	pendingToolCalls := make([]any, 0, 2)
	flushToolCalls := func() {
		if len(pendingToolCalls) == 0 {
			return
		}
		messages = append(messages, map[string]any{
			"role": "assistant", "content": nil, "tool_calls": pendingToolCalls,
		})
		pendingToolCalls = make([]any, 0, 2)
	}
	for _, rawItem := range items {
		item, ok := rawItem.(map[string]any)
		if !ok {
			return nil, invalidResponsesRequest("input", "Each input item must be an object.")
		}
		typeName, _ := item["type"].(string)
		role, _ := item["role"].(string)
		if typeName == "" && role != "" {
			typeName = "message"
		}
		switch typeName {
		case "message":
			flushToolCalls()
			role = strings.TrimSpace(role)
			if role == "developer" {
				role = "system"
			}
			if role != "system" && role != "user" && role != "assistant" {
				return nil, invalidResponsesRequest("input", fmt.Sprintf("Input message role %q cannot be represented by Chat Completions.", role))
			}
			content, err := responsesContentToChat(item["content"], role)
			if err != nil {
				return nil, err
			}
			messages = append(messages, map[string]any{"role": role, "content": content})
		case "function_call":
			callID, _ := item["call_id"].(string)
			if strings.TrimSpace(callID) == "" {
				callID, _ = item["id"].(string)
			}
			name, _ := item["name"].(string)
			if strings.TrimSpace(callID) == "" || strings.TrimSpace(name) == "" {
				return nil, invalidResponsesRequest("input", "Function call input items require 'call_id' and 'name'.")
			}
			arguments := messageText(item["arguments"])
			if arguments == "" {
				arguments = "{}"
			}
			pendingToolCalls = append(pendingToolCalls, map[string]any{
				"id": callID, "type": "function",
				"function": map[string]any{"name": name, "arguments": arguments},
			})
		case "function_call_output":
			flushToolCalls()
			callID, _ := item["call_id"].(string)
			if strings.TrimSpace(callID) == "" {
				return nil, invalidResponsesRequest("input", "Function call output items require 'call_id'.")
			}
			messages = append(messages, map[string]any{
				"role": "tool", "tool_call_id": callID, "content": messageText(item["output"]),
			})
		default:
			return nil, unsupportedResponsesParameter("input", fmt.Sprintf("Input item type %q is not supported by this channel's Chat Completions fallback.", typeName))
		}
	}
	flushToolCalls()
	return messages, nil
}

func responsesContentToChat(raw any, role string) (any, error) {
	switch content := raw.(type) {
	case nil:
		return nil, nil
	case string:
		return content, nil
	case []any:
		parts := make([]any, 0, len(content))
		for _, rawPart := range content {
			part, ok := rawPart.(map[string]any)
			if !ok {
				return nil, invalidResponsesRequest("input", "Input content parts must be objects.")
			}
			typeName, _ := part["type"].(string)
			switch typeName {
			case "input_text", "output_text", "text":
				text, ok := part["text"].(string)
				if !ok {
					return nil, invalidResponsesRequest("input", "Text content parts require a string 'text' field.")
				}
				parts = append(parts, map[string]any{"type": "text", "text": text})
			case "input_image":
				if role != "user" {
					return nil, unsupportedResponsesParameter("input", "Image content is only supported in user messages by the Chat Completions fallback.")
				}
				imageURL, ok := part["image_url"].(string)
				if !ok || strings.TrimSpace(imageURL) == "" {
					return nil, unsupportedResponsesParameter("input", "Image content requires a non-empty 'image_url' for the Chat Completions fallback.")
				}
				image := map[string]any{"url": imageURL}
				if detail, exists := part["detail"]; exists {
					image["detail"] = detail
				}
				parts = append(parts, map[string]any{"type": "image_url", "image_url": image})
			default:
				return nil, unsupportedResponsesParameter("input", fmt.Sprintf("Content part type %q is not supported by this channel's Chat Completions fallback.", typeName))
			}
		}
		return parts, nil
	default:
		return nil, invalidResponsesRequest("input", "Message content must be a string or an array of content parts.")
	}
}

func responsesToolsToChat(raw any) (any, error) {
	tools, ok := raw.([]any)
	if !ok {
		return nil, invalidResponsesRequest("tools", "Field 'tools' must be an array.")
	}
	converted := make([]any, 0, len(tools))
	for _, rawTool := range tools {
		tool, ok := rawTool.(map[string]any)
		if !ok {
			return nil, invalidResponsesRequest("tools", "Each tool must be an object.")
		}
		typeName, _ := tool["type"].(string)
		if typeName != "function" {
			return nil, unsupportedResponsesParameter("tools", fmt.Sprintf("Tool type %q is not supported by this channel's Chat Completions fallback.", typeName))
		}
		name, _ := tool["name"].(string)
		if strings.TrimSpace(name) == "" {
			return nil, invalidResponsesRequest("tools", "Function tools require 'name'.")
		}
		function := map[string]any{"name": name}
		copyFields(function, tool, "description", "parameters", "strict")
		converted = append(converted, map[string]any{"type": "function", "function": function})
	}
	return converted, nil
}

func responsesToolChoiceToChat(raw any) any {
	choice, ok := raw.(map[string]any)
	if !ok || choice["type"] != "function" {
		return raw
	}
	return map[string]any{
		"type":     "function",
		"function": map[string]any{"name": choice["name"]},
	}
}

func responsesTextFormatToChat(raw any) any {
	format, ok := raw.(map[string]any)
	if !ok || format["type"] != "json_schema" {
		return raw
	}
	schema := map[string]any{}
	copyFields(schema, format, "name", "description", "schema", "strict")
	return map[string]any{"type": "json_schema", "json_schema": schema}
}

type chatCompletionResponse struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Message struct {
			Content   any    `json:"content"`
			Refusal   string `json:"refusal"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *chatUsage `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Param   string `json:"param"`
		Code    any    `json:"code"`
	} `json:"error"`
}

type chatUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	PromptDetails    *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

func chatResponseToResponses(body []byte, request ResponsesRequest, responseID string, fallbackModel string) ([]byte, ResponsesUsage, error) {
	var chat chatCompletionResponse
	if err := decodeJSON(body, &chat); err != nil {
		return nil, ResponsesUsage{}, &ProtocolError{cause: fmt.Errorf("decode Chat Completions response: %w", err)}
	}
	if chat.Error != nil && strings.TrimSpace(chat.Error.Message) != "" {
		return nil, ResponsesUsage{}, apiErrorFromChatError(chat.Error.Message, chat.Error.Type, chat.Error.Param, chat.Error.Code)
	}
	if len(chat.Choices) == 0 {
		return nil, ResponsesUsage{}, &ProtocolError{cause: errors.New("Chat Completions response contains no choices")}
	}
	if strings.TrimSpace(responseID) == "" {
		responseID = newResponsesID()
	}
	choice := chat.Choices[0]
	status, incomplete, err := responsesStatusFromFinishReason(choice.FinishReason)
	if err != nil {
		return nil, ResponsesUsage{}, err
	}
	output := make([]any, 0, 1+len(choice.Message.ToolCalls))
	content := make([]any, 0, 2)
	if text := chatMessageText(choice.Message.Content); text != "" {
		content = append(content, map[string]any{
			"type": "output_text", "text": text, "annotations": []any{}, "logprobs": []any{},
		})
	}
	if refusal := strings.TrimSpace(choice.Message.Refusal); refusal != "" {
		content = append(content, map[string]any{"type": "refusal", "refusal": refusal})
	}
	if len(content) > 0 || len(choice.Message.ToolCalls) == 0 {
		output = append(output, map[string]any{
			"id": responseID + "_msg_0", "type": "message", "status": outputStatus(status),
			"role": "assistant", "content": content,
		})
	}
	for index, toolCall := range choice.Message.ToolCalls {
		callID := strings.TrimSpace(toolCall.ID)
		if callID == "" {
			callID = fmt.Sprintf("%s_call_%d", responseID, index)
		}
		if strings.TrimSpace(toolCall.Function.Name) == "" {
			return nil, ResponsesUsage{}, &ProtocolError{cause: errors.New("Chat Completions tool call has no function name")}
		}
		arguments := toolCall.Function.Arguments
		if strings.TrimSpace(arguments) == "" {
			arguments = "{}"
		}
		output = append(output, map[string]any{
			"id": callID, "type": "function_call", "status": outputStatus(status),
			"call_id": callID, "name": toolCall.Function.Name, "arguments": arguments,
		})
	}
	model := strings.TrimSpace(chat.Model)
	if model == "" {
		model = strings.TrimSpace(fallbackModel)
	}
	usage := responsesUsageFromChat(chat.Usage)
	now := time.Now().Unix()
	created := chat.Created
	if created == 0 {
		created = now
	}
	response := responseEnvelope(request, responseID, model, status, created, output, usage)
	if status == "completed" {
		response["completed_at"] = now
	}
	response["incomplete_details"] = incomplete
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, ResponsesUsage{}, &ProtocolError{cause: fmt.Errorf("encode Responses response: %w", err)}
	}
	return encoded, usage, nil
}

func responseEnvelope(request ResponsesRequest, id string, model string, status string, created int64, output []any, usage ResponsesUsage) map[string]any {
	response := map[string]any{
		"id": id, "object": "response", "created_at": created, "status": status,
		"completed_at": nil, "error": nil, "incomplete_details": nil, "instructions": nil,
		"max_output_tokens": nil, "model": model, "output": output,
		"parallel_tool_calls": true, "previous_response_id": nil, "reasoning": nil,
		"store": false, "temperature": 1, "text": map[string]any{"format": map[string]any{"type": "text"}},
		"tool_choice": "auto", "tools": []any{}, "top_p": 1, "truncation": "disabled",
		"usage": responsesUsageObject(usage), "user": nil, "metadata": map[string]any{},
	}
	copyFields(response, request.raw, "instructions", "max_output_tokens", "parallel_tool_calls", "previous_response_id", "reasoning", "store", "temperature", "text", "tool_choice", "tools", "top_p", "truncation", "user", "metadata", "service_tier")
	return response
}

func responsesStatusFromFinishReason(reason string) (string, any, error) {
	switch strings.TrimSpace(reason) {
	case "stop", "tool_calls", "function_call":
		return "completed", nil, nil
	case "length":
		return "incomplete", map[string]any{"reason": "max_output_tokens"}, nil
	case "content_filter":
		return "incomplete", map[string]any{"reason": "content_filter"}, nil
	default:
		return "", nil, &ProtocolError{cause: fmt.Errorf("Chat Completions response has invalid finish_reason %q", strings.TrimSpace(reason))}
	}
}

func outputStatus(responseStatus string) string {
	if responseStatus == "incomplete" {
		return "incomplete"
	}
	return "completed"
}

func chatMessageText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var result strings.Builder
		for _, rawPart := range value {
			part, _ := rawPart.(map[string]any)
			if text, _ := part["text"].(string); text != "" {
				result.WriteString(text)
			}
		}
		return result.String()
	default:
		return ""
	}
}

func responsesUsageFromChat(usage *chatUsage) ResponsesUsage {
	if usage == nil {
		return ResponsesUsage{}
	}
	result := ResponsesUsage{
		InputTokens: usage.PromptTokens, OutputTokens: usage.CompletionTokens,
		TotalTokens: usage.TotalTokens,
	}
	if result.TotalTokens == 0 {
		result.TotalTokens = result.InputTokens + result.OutputTokens
	}
	if usage.PromptDetails != nil {
		result.CachedTokens = usage.PromptDetails.CachedTokens
	}
	if usage.CompletionDetails != nil {
		result.ReasoningTokens = usage.CompletionDetails.ReasoningTokens
	}
	return result
}

func responsesUsageObject(usage ResponsesUsage) any {
	if usage.InputTokens == 0 && usage.OutputTokens == 0 && usage.TotalTokens == 0 {
		return nil
	}
	return map[string]any{
		"input_tokens":          usage.InputTokens,
		"input_tokens_details":  map[string]any{"cached_tokens": usage.CachedTokens},
		"output_tokens":         usage.OutputTokens,
		"output_tokens_details": map[string]any{"reasoning_tokens": usage.ReasoningTokens},
		"total_tokens":          usage.TotalTokens,
	}
}

func apiErrorFromChatError(_ string, _ string, _ string, _ any) *APIError {
	return &APIError{
		Status: 502, Type: "upstream_error", Code: "upstream_error",
		Message: "The model provider returned an error.",
	}
}

func stableResponsesProviderError() map[string]any {
	return map[string]any{
		"code": "upstream_error", "message": "The model provider returned an error.",
	}
}

func sanitizeResponsesFailure(body []byte, status string) ([]byte, error) {
	switch strings.TrimSpace(status) {
	case "failed", "cancelled", "canceled":
	default:
		return body, nil
	}
	var payload map[string]any
	if err := decodeJSON(body, &payload); err != nil {
		return nil, &ProtocolError{cause: fmt.Errorf("decode failed Responses response: %w", err)}
	}
	payload["error"] = stableResponsesProviderError()
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, &ProtocolError{cause: fmt.Errorf("encode failed Responses response: %w", err)}
	}
	return encoded, nil
}

func extractResponsesMetadata(body []byte) (string, string, string, ResponsesUsage, error) {
	var payload struct {
		ID     string `json:"id"`
		Model  string `json:"model"`
		Status string `json:"status"`
		Usage  *struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
			TotalTokens  int `json:"total_tokens"`
			InputDetails *struct {
				CachedTokens int `json:"cached_tokens"`
			} `json:"input_tokens_details"`
			OutputDetails *struct {
				ReasoningTokens int `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	}
	if err := decodeJSON(body, &payload); err != nil {
		return "", "", "", ResponsesUsage{}, &ProtocolError{cause: fmt.Errorf("decode Responses response: %w", err)}
	}
	if strings.TrimSpace(payload.ID) == "" {
		return "", "", "", ResponsesUsage{}, &ProtocolError{cause: errors.New("Responses response ID is empty")}
	}
	if strings.TrimSpace(payload.Model) == "" {
		return "", "", "", ResponsesUsage{}, &ProtocolError{cause: errors.New("Responses response model is empty")}
	}
	switch strings.TrimSpace(payload.Status) {
	case "completed", "incomplete", "failed", "cancelled", "canceled":
	default:
		return "", "", "", ResponsesUsage{}, &ProtocolError{cause: errors.New("Responses response status is invalid")}
	}
	usage := ResponsesUsage{}
	if payload.Usage != nil {
		usage.InputTokens = payload.Usage.InputTokens
		usage.OutputTokens = payload.Usage.OutputTokens
		usage.TotalTokens = payload.Usage.TotalTokens
		if payload.Usage.InputDetails != nil {
			usage.CachedTokens = payload.Usage.InputDetails.CachedTokens
		}
		if payload.Usage.OutputDetails != nil {
			usage.ReasoningTokens = payload.Usage.OutputDetails.ReasoningTokens
		}
		if usage.TotalTokens == 0 {
			usage.TotalTokens = usage.InputTokens + usage.OutputTokens
		}
	}
	return payload.ID, payload.Model, payload.Status, usage, nil
}

func newResponsesID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return "resp_" + hex.EncodeToString(value[:])
	}
	return fmt.Sprintf("resp_%x", time.Now().UTC().UnixNano())
}
