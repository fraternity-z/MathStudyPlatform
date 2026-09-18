package openaicompat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func chatRequestToResponses(body []byte) ([]byte, error) {
	var chat map[string]any
	if err := decodeJSON(body, &chat); err != nil {
		return nil, fmt.Errorf("decode chat request: %w", err)
	}
	messages, ok := chat["messages"].([]any)
	if !ok || len(messages) == 0 {
		return nil, errors.New("chat request messages are missing")
	}
	input, err := responsesInput(messages)
	if err != nil {
		return nil, err
	}
	responses := map[string]any{
		"model":  chat["model"],
		"input":  input,
		"stream": false,
	}
	copyFields(responses, chat, "temperature", "top_p", "parallel_tool_calls", "store", "metadata", "service_tier")
	if value, exists := chat["max_completion_tokens"]; exists {
		responses["max_output_tokens"] = value
	} else if value, exists := chat["max_tokens"]; exists {
		responses["max_output_tokens"] = value
	}
	if tools, exists := chat["tools"]; exists {
		responses["tools"] = responsesTools(tools)
	}
	if toolChoice, exists := chat["tool_choice"]; exists {
		responses["tool_choice"] = responsesToolChoice(toolChoice)
	}
	if effort, exists := chat["reasoning_effort"]; exists {
		responses["reasoning"] = map[string]any{"effort": effort}
	}
	if format, exists := chat["response_format"]; exists {
		if text := responsesTextFormat(format); text != nil {
			responses["text"] = map[string]any{"format": text}
		}
	}
	encoded, err := json.Marshal(responses)
	if err != nil {
		return nil, fmt.Errorf("encode Responses request: %w", err)
	}
	return encoded, nil
}

func responsesInput(messages []any) ([]any, error) {
	input := make([]any, 0, len(messages))
	for messageIndex, rawMessage := range messages {
		message, ok := rawMessage.(map[string]any)
		if !ok {
			return nil, errors.New("chat request contains an invalid message")
		}
		role, _ := message["role"].(string)
		role = strings.TrimSpace(role)
		if role == "" {
			return nil, errors.New("chat request message role is empty")
		}
		if role == "tool" {
			callID, _ := message["tool_call_id"].(string)
			if strings.TrimSpace(callID) == "" {
				return nil, errors.New("tool message call ID is empty")
			}
			input = append(input, map[string]any{
				"type":    "function_call_output",
				"call_id": callID,
				"output":  messageText(message["content"]),
			})
			continue
		}
		content, err := responsesMessageContent(role, message["content"])
		if err != nil {
			return nil, err
		}
		if content != nil {
			input = append(input, map[string]any{"role": role, "content": content})
		}
		if role == "assistant" {
			if functionCall, ok := message["function_call"].(map[string]any); ok {
				input = append(input, responsesFunctionCall(fmt.Sprintf("call_legacy_%d", messageIndex), functionCall))
			}
			if toolCalls, ok := message["tool_calls"].([]any); ok {
				for _, rawToolCall := range toolCalls {
					toolCall, ok := rawToolCall.(map[string]any)
					if !ok {
						continue
					}
					function, ok := toolCall["function"].(map[string]any)
					if !ok {
						continue
					}
					callID, _ := toolCall["id"].(string)
					input = append(input, responsesFunctionCall(callID, function))
				}
			}
		}
	}
	if len(input) == 0 {
		return nil, errors.New("chat request contains no usable messages")
	}
	return input, nil
}

func responsesMessageContent(role string, raw any) (any, error) {
	switch value := raw.(type) {
	case nil:
		return nil, nil
	case string:
		if value == "" {
			return nil, nil
		}
		return value, nil
	case []any:
		parts := make([]any, 0, len(value))
		for _, rawPart := range value {
			part, ok := rawPart.(map[string]any)
			if !ok {
				return nil, errors.New("chat request contains an invalid content part")
			}
			typeName, _ := part["type"].(string)
			switch typeName {
			case "text":
				outputType := "input_text"
				if role == "assistant" {
					outputType = "output_text"
				}
				parts = append(parts, map[string]any{"type": outputType, "text": part["text"]})
			case "image_url":
				image, ok := part["image_url"].(map[string]any)
				if !ok {
					return nil, errors.New("chat image content is invalid")
				}
				converted := map[string]any{"type": "input_image", "image_url": image["url"]}
				if detail, exists := image["detail"]; exists {
					converted["detail"] = detail
				}
				parts = append(parts, converted)
			default:
				return nil, fmt.Errorf("chat content type %q is not supported by Responses", typeName)
			}
		}
		if len(parts) == 0 {
			return nil, nil
		}
		return parts, nil
	default:
		return nil, errors.New("chat request message content is invalid")
	}
}

func responsesFunctionCall(callID string, function map[string]any) map[string]any {
	result := map[string]any{
		"type":      "function_call",
		"name":      function["name"],
		"arguments": function["arguments"],
	}
	if strings.TrimSpace(callID) != "" {
		result["call_id"] = callID
	}
	return result
}

func responsesTools(raw any) any {
	tools, ok := raw.([]any)
	if !ok {
		return raw
	}
	converted := make([]any, 0, len(tools))
	for _, rawTool := range tools {
		tool, ok := rawTool.(map[string]any)
		if !ok || tool["type"] != "function" {
			converted = append(converted, rawTool)
			continue
		}
		function, ok := tool["function"].(map[string]any)
		if !ok {
			converted = append(converted, rawTool)
			continue
		}
		flat := map[string]any{"type": "function"}
		copyFields(flat, function, "name", "description", "parameters", "strict")
		converted = append(converted, flat)
	}
	return converted
}

func responsesToolChoice(raw any) any {
	choice, ok := raw.(map[string]any)
	if !ok || choice["type"] != "function" {
		return raw
	}
	function, ok := choice["function"].(map[string]any)
	if !ok {
		return raw
	}
	return map[string]any{"type": "function", "name": function["name"]}
}

func responsesTextFormat(raw any) any {
	format, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	if format["type"] != "json_schema" {
		return format
	}
	schema, ok := format["json_schema"].(map[string]any)
	if !ok {
		return format
	}
	converted := map[string]any{"type": "json_schema"}
	copyFields(converted, schema, "name", "description", "schema", "strict")
	return converted
}

func responsesResponseToChat(response *http.Response) (*http.Response, error) {
	body, err := readLimited(response.Body, maxResponseBodySize)
	if err != nil {
		return nil, fmt.Errorf("read Responses response: %w", err)
	}
	body, err = responsesJSONBody(body, response.Header.Get("Content-Type"))
	if err != nil {
		return nil, err
	}
	var payload responsesResponse
	if err := decodeJSON(body, &payload); err != nil {
		return nil, fmt.Errorf("decode Responses response: %w", err)
	}
	if (len(payload.Error) > 0 && string(payload.Error) != "null") ||
		(payload.Status != "" && payload.Status != "completed" && payload.Status != "incomplete") {
		return nil, errors.New("Responses request did not complete successfully")
	}
	if payload.ID == "" && len(payload.Output) == 0 && payload.OutputText == "" {
		return nil, errors.New("Responses response is missing its result")
	}
	chatBody, err := payload.chatCompletion()
	if err != nil {
		return nil, err
	}
	converted := *response
	converted.Body = io.NopCloser(bytes.NewReader(chatBody))
	converted.ContentLength = int64(len(chatBody))
	converted.Header = response.Header.Clone()
	if converted.Header == nil {
		converted.Header = make(http.Header)
	}
	converted.Header.Del("Content-Encoding")
	converted.Header.Del("Transfer-Encoding")
	converted.Header.Set("Content-Type", "application/json")
	converted.Header.Set("Content-Length", strconv.Itoa(len(chatBody)))
	converted.TransferEncoding = nil
	converted.Uncompressed = false
	return &converted, nil
}

func responsesJSONBody(body []byte, contentType string) ([]byte, error) {
	trimmed := bytes.TrimSpace(body)
	isSSE := strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "text/event-stream") ||
		bytes.HasPrefix(trimmed, []byte("event:")) || bytes.HasPrefix(trimmed, []byte("data:"))
	if !isSSE {
		return body, nil
	}
	var terminal []byte
	err := readSSE(bytes.NewReader(body), func(frame sseFrame) error {
		if bytes.Equal(bytes.TrimSpace(frame.Data), []byte("[DONE]")) {
			return nil
		}
		var event map[string]any
		if err := decodeJSON(frame.Data, &event); err != nil {
			return &ProtocolError{cause: fmt.Errorf("decode Responses SSE event: %w", err)}
		}
		eventType, _ := event["type"].(string)
		if strings.TrimSpace(eventType) == "" {
			eventType = strings.TrimSpace(frame.Event)
		}
		switch eventType {
		case "response.completed", "response.incomplete":
			responseObject, ok := event["response"].(map[string]any)
			if !ok {
				return &ProtocolError{cause: errors.New("Responses SSE terminal event has no response object")}
			}
			encoded, err := json.Marshal(responseObject)
			if err != nil {
				return &ProtocolError{cause: errors.New("encode Responses SSE terminal response")}
			}
			terminal = encoded
		case "response.failed", "response.cancelled", "response.canceled", "error":
			return &ProtocolError{cause: errors.New("provider returned a failed Responses SSE terminal event")}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(terminal) == 0 {
		return nil, &ProtocolError{cause: errors.New("Responses SSE ended without a terminal response event")}
	}
	return terminal, nil
}

type responsesResponse struct {
	ID                string            `json:"id"`
	CreatedAt         int64             `json:"created_at"`
	Model             string            `json:"model"`
	Status            string            `json:"status"`
	Error             json.RawMessage   `json:"error"`
	Output            []json.RawMessage `json:"output"`
	OutputText        string            `json:"output_text"`
	SystemFingerprint string            `json:"system_fingerprint"`
	Usage             *responsesUsage   `json:"usage"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
}

type responsesUsage struct {
	InputTokens        int `json:"input_tokens"`
	OutputTokens       int `json:"output_tokens"`
	TotalTokens        int `json:"total_tokens"`
	InputTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func (r responsesResponse) chatCompletion() ([]byte, error) {
	if strings.TrimSpace(r.ID) == "" {
		return nil, errors.New("Responses response ID is empty")
	}
	var content strings.Builder
	refusals := make([]string, 0)
	toolCalls := make([]any, 0)
	for _, rawItem := range r.Output {
		var item struct {
			Type      string            `json:"type"`
			ID        string            `json:"id"`
			CallID    string            `json:"call_id"`
			Name      string            `json:"name"`
			Arguments json.RawMessage   `json:"arguments"`
			Content   []json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(rawItem, &item); err != nil {
			return nil, errors.New("Responses output item is invalid")
		}
		switch item.Type {
		case "message":
			for _, rawPart := range item.Content {
				var part struct {
					Type    string `json:"type"`
					Text    string `json:"text"`
					Refusal string `json:"refusal"`
				}
				if err := json.Unmarshal(rawPart, &part); err != nil {
					return nil, errors.New("Responses message content is invalid")
				}
				switch part.Type {
				case "output_text":
					content.WriteString(part.Text)
				case "refusal":
					if strings.TrimSpace(part.Refusal) != "" {
						refusals = append(refusals, part.Refusal)
					}
				}
			}
		case "function_call":
			arguments := rawArguments(item.Arguments)
			callID := strings.TrimSpace(item.CallID)
			if callID == "" {
				callID = strings.TrimSpace(item.ID)
			}
			if callID == "" || strings.TrimSpace(item.Name) == "" {
				return nil, errors.New("Responses function call is incomplete")
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   callID,
				"type": "function",
				"function": map[string]any{
					"name":      item.Name,
					"arguments": arguments,
				},
			})
		}
	}
	if content.Len() == 0 {
		content.WriteString(r.OutputText)
	}
	text := content.String()
	if text == "" && len(toolCalls) == 0 && len(refusals) == 0 {
		return nil, errors.New("Responses response contains no assistant output")
	}
	message := map[string]any{"role": "assistant"}
	if text == "" {
		message["content"] = nil
	} else {
		message["content"] = text
	}
	if len(refusals) > 0 {
		message["refusal"] = strings.Join(refusals, "\n")
	}
	finishReason := r.finishReason(len(toolCalls) > 0)
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	chat := map[string]any{
		"id":      r.ID,
		"object":  "chat.completion",
		"created": r.CreatedAt,
		"model":   r.Model,
		"choices": []any{map[string]any{
			"index":         0,
			"message":       message,
			"finish_reason": finishReason,
		}},
	}
	if r.SystemFingerprint != "" {
		chat["system_fingerprint"] = r.SystemFingerprint
	}
	if r.Usage != nil {
		chat["usage"] = r.Usage.chatUsage()
	}
	encoded, err := json.Marshal(chat)
	if err != nil {
		return nil, fmt.Errorf("encode Chat Completions response: %w", err)
	}
	return encoded, nil
}

func (r responsesResponse) finishReason(hasTools bool) string {
	if hasTools {
		return "tool_calls"
	}
	if r.IncompleteDetails != nil {
		switch r.IncompleteDetails.Reason {
		case "max_output_tokens":
			return "length"
		case "content_filter":
			return "content_filter"
		}
	}
	if r.Status == "incomplete" {
		return "length"
	}
	return "stop"
}

func (u responsesUsage) chatUsage() map[string]any {
	usage := map[string]any{
		"prompt_tokens":     u.InputTokens,
		"completion_tokens": u.OutputTokens,
		"total_tokens":      u.TotalTokens,
	}
	if u.InputTokensDetails != nil {
		usage["prompt_tokens_details"] = map[string]any{"cached_tokens": u.InputTokensDetails.CachedTokens}
	}
	if u.OutputTokensDetails != nil {
		usage["completion_tokens_details"] = map[string]any{"reasoning_tokens": u.OutputTokensDetails.ReasoningTokens}
	}
	return usage
}

func rawArguments(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "{}"
	}
	var value string
	if err := json.Unmarshal(raw, &value); err == nil {
		return value
	}
	return string(raw)
}

func messageText(raw any) string {
	switch value := raw.(type) {
	case string:
		return value
	case nil:
		return ""
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

func copyFields(destination map[string]any, source map[string]any, names ...string) {
	for _, name := range names {
		if value, exists := source[name]; exists {
			destination[name] = value
		}
	}
}

func decodeJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains trailing data")
		}
		return err
	}
	return nil
}
