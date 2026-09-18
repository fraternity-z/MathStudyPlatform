package openaicompat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

// responsesStreamToChat keeps the SDK-facing Chat stream while consuming native
// Responses increments. The pipe applies backpressure and propagates read errors.
func responsesStreamToChat(ctx context.Context, response *http.Response) *http.Response {
	reader, writer := io.Pipe()
	var closeOnce sync.Once
	closeUpstream := func() { closeOnce.Do(func() { _ = response.Body.Close() }) }
	body := &chatStreamBody{PipeReader: reader, closeUpstream: closeUpstream}
	stop := context.AfterFunc(ctx, func() {
		closeUpstream()
		_ = writer.CloseWithError(ctx.Err())
	})
	go func() {
		defer stop()
		defer closeUpstream()
		state := &responsesChatStream{writer: writer, items: make(map[int]*responsesChatItem)}
		err := readSSE(response.Body, state.consume)
		if errors.Is(err, errSSETerminal) {
			err = nil
		} else if err == nil {
			err = io.ErrUnexpectedEOF
		}
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		if err != nil {
			err = &ProtocolError{cause: err}
		}
		closeUpstream()
		_ = writer.CloseWithError(err)
	}()
	converted := *response
	converted.Body = body
	converted.ContentLength = -1
	converted.Header = response.Header.Clone()
	if converted.Header == nil {
		converted.Header = make(http.Header)
	}
	converted.Header.Del("Content-Length")
	converted.Header.Del("Content-Encoding")
	converted.Header.Del("Transfer-Encoding")
	converted.Header.Set("Content-Type", "text/event-stream")
	converted.TransferEncoding = nil
	converted.Uncompressed = false
	return &converted
}

type chatStreamBody struct {
	*io.PipeReader
	closeUpstream func()
}

func (b *chatStreamBody) Close() error {
	err := b.PipeReader.Close()
	b.closeUpstream()
	return err
}

type responsesChatStream struct {
	writer    io.Writer
	response  responsesResponse
	items     map[int]*responsesChatItem
	toolCount int
	buffered  int
	hasOutput bool
}

type responsesChatItem struct {
	id        string
	kind      string
	callID    string
	name      string
	toolIndex int
	parts     map[int]*responsesChatPart
	arguments strings.Builder
}

type responsesChatPart struct {
	kind string
	text strings.Builder
}

type responsesChatEvent struct {
	Type         string              `json:"type"`
	OutputIndex  int                 `json:"output_index"`
	ContentIndex int                 `json:"content_index"`
	ItemID       string              `json:"item_id"`
	Delta        string              `json:"delta"`
	Response     responsesResponse   `json:"response"`
	Item         responsesChatOutput `json:"item"`
}

type responsesChatOutput struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	CallID    string `json:"call_id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	Content   []struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Refusal string `json:"refusal"`
	} `json:"content"`
}

func (s *responsesChatStream) consume(frame sseFrame) error {
	if strings.TrimSpace(string(frame.Data)) == "[DONE]" {
		return io.ErrUnexpectedEOF // Only a Responses terminal event completes the stream.
	}
	var event responsesChatEvent
	if err := decodeJSON(frame.Data, &event); err != nil {
		return errors.New("invalid Responses stream event")
	}
	if event.Type == "" {
		event.Type = frame.Event
	} else if frame.Event != "" && frame.Event != event.Type {
		return errors.New("Responses stream event type mismatch")
	}
	switch event.Type {
	case "response.created", "response.in_progress":
		return s.setResponse(event.Response)
	case "response.output_item.added", "response.output_item.done":
		return s.outputItem(event.OutputIndex, event.Item)
	case "response.output_text.delta", "response.refusal.delta":
		kind := "output_text"
		if event.Type == "response.refusal.delta" {
			kind = "refusal"
		}
		item, err := s.item(event.OutputIndex, event.ItemID, "message")
		if err != nil {
			return err
		}
		return s.text(item, event.ContentIndex, kind, event.Delta, false)
	case "response.function_call_arguments.delta":
		item, err := s.item(event.OutputIndex, event.ItemID, "function_call")
		if err != nil {
			return err
		}
		return s.arguments(item, event.Delta, false)
	case "response.completed", "response.incomplete":
		if event.Response.Status != strings.TrimPrefix(event.Type, "response.") ||
			(len(event.Response.Error) > 0 && string(event.Response.Error) != "null") {
			return errors.New("Responses terminal event status is invalid")
		}
		if err := s.setResponse(event.Response); err != nil {
			return err
		}
		finalItems := 0
		for index, raw := range event.Response.Output {
			var item responsesChatOutput
			if err := decodeJSON(raw, &item); err != nil {
				return errors.New("invalid Responses terminal output")
			}
			if err := s.outputItem(index, item); err != nil {
				return err
			}
			if item.Type == "message" || item.Type == "function_call" {
				finalItems++
				for partIndex := range s.items[index].parts {
					if partIndex >= len(item.Content) {
						return errors.New("Responses terminal output is missing streamed content")
					}
				}
			}
		}
		if finalItems != len(s.items) {
			return errors.New("Responses terminal output is missing streamed items")
		}
		if !s.hasOutput {
			return errors.New("Responses stream contains no assistant output")
		}
		if err := s.chunk(map[string]any{}, s.response.finishReason(s.toolCount > 0)); err != nil {
			return err
		}
		if _, err := io.WriteString(s.writer, "data: [DONE]\n\n"); err != nil {
			return err
		}
		return errSSETerminal
	case "response.failed", "response.cancelled", "response.canceled", "error":
		return errors.New("provider returned a failed Responses stream event")
	case "":
		return errors.New("Responses stream event type is empty")
	default:
		return nil
	}
}

func (s *responsesChatStream) setResponse(response responsesResponse) error {
	if response.ID == "" || response.Model == "" ||
		(s.response.ID != "" && (s.response.ID != response.ID || s.response.Model != response.Model)) {
		return errors.New("Responses stream metadata is missing or inconsistent")
	}
	s.response = response
	return nil
}

func (s *responsesChatStream) item(index int, id, kind string) (*responsesChatItem, error) {
	if index < 0 || index > maxResponseBodySize || id == "" {
		return nil, errors.New("Responses stream output item is invalid")
	}
	item := s.items[index]
	if item == nil {
		if err := s.reserve(id); err != nil {
			return nil, err
		}
		item = &responsesChatItem{id: id, kind: kind, parts: make(map[int]*responsesChatPart)}
		s.items[index] = item
	}
	if item.id != id || item.kind != kind {
		return nil, errors.New("Responses stream output item changed")
	}
	return item, nil
}

func (s *responsesChatStream) outputItem(index int, output responsesChatOutput) error {
	if output.Type != "message" && output.Type != "function_call" {
		return nil
	}
	item, err := s.item(index, output.ID, output.Type)
	if err != nil {
		return err
	}
	if output.Type == "message" {
		for index, part := range output.Content {
			text := part.Text
			if part.Type == "refusal" {
				text = part.Refusal
			}
			if part.Type == "output_text" || part.Type == "refusal" {
				if err := s.text(item, index, part.Type, text, true); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if output.CallID == "" || output.Name == "" {
		return errors.New("Responses function call metadata is missing")
	}
	if item.callID == "" {
		item.callID, item.name, item.toolIndex = output.CallID, output.Name, s.toolCount
		s.toolCount++
		if err := s.reserve(output.CallID + output.Name); err != nil {
			return err
		}
		if err := s.chunk(map[string]any{"tool_calls": []any{map[string]any{
			"index": item.toolIndex, "id": item.callID, "type": "function",
			"function": map[string]any{"name": item.name, "arguments": ""},
		}}}, nil); err != nil {
			return err
		}
		s.hasOutput = true
	} else if item.callID != output.CallID || item.name != output.Name {
		return errors.New("Responses function call metadata changed")
	}
	return s.arguments(item, output.Arguments, true)
}

func (s *responsesChatStream) text(item *responsesChatItem, index int, kind, value string, snapshot bool) error {
	if index < 0 || index > maxResponseBodySize {
		return errors.New("Responses content index is invalid")
	}
	part := item.parts[index]
	if part == nil {
		part = &responsesChatPart{kind: kind}
		item.parts[index] = part
	}
	if part.kind != kind {
		return errors.New("Responses content type changed")
	}
	delta, err := s.append(&part.text, value, snapshot)
	if err != nil || delta == "" {
		return err
	}
	s.hasOutput = true
	payload := map[string]any{"content": delta}
	if kind == "refusal" {
		// Eino reads content only; preserve refusal text for the tutoring UI too.
		payload["refusal"] = delta
	}
	return s.chunk(payload, nil)
}

func (s *responsesChatStream) arguments(item *responsesChatItem, value string, snapshot bool) error {
	if item.callID == "" {
		return errors.New("Responses function arguments arrived before call metadata")
	}
	delta, err := s.append(&item.arguments, value, snapshot)
	if err != nil || delta == "" {
		return err
	}
	return s.chunk(map[string]any{"tool_calls": []any{map[string]any{
		"index": item.toolIndex, "function": map[string]any{"arguments": delta},
	}}}, nil)
}

func (s *responsesChatStream) append(text *strings.Builder, value string, snapshot bool) (string, error) {
	if snapshot {
		if !strings.HasPrefix(value, text.String()) {
			return "", errors.New("Responses final output does not match streamed content")
		}
		value = value[text.Len():]
	}
	if err := s.reserve(value); err != nil {
		return "", err
	}
	text.WriteString(value)
	return value, nil
}

func (s *responsesChatStream) reserve(value string) error {
	if len(value) > maxResponseBodySize-s.buffered {
		return errors.New("Responses stream content exceeds size limit")
	}
	s.buffered += len(value)
	return nil
}

func (s *responsesChatStream) chunk(delta map[string]any, finish any) error {
	if s.response.ID == "" {
		return errors.New("Responses stream output arrived before response metadata")
	}
	delta["role"] = "assistant"
	payload := map[string]any{
		"id": s.response.ID, "object": "chat.completion.chunk",
		"model": s.response.Model, "created": s.response.CreatedAt,
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
	}
	if finish != nil && s.response.Usage != nil {
		payload["usage"] = s.response.Usage.chatUsage()
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(s.writer, "data: %s\n\n", encoded)
	return err
}
