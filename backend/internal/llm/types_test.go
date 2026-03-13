package llm

import (
	"encoding/json"
	"testing"
)

func TestChatRequest_MarshalJSON(t *testing.T) {
	temp := 0.7
	req := ChatRequest{
		Model: "openai/gpt-4o",
		Messages: []Message{
			{Role: "system", Content: "You are a SQL expert."},
			{Role: "user", Content: "Explain joins"},
		},
		Temperature: &temp,
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded["model"] != "openai/gpt-4o" {
		t.Errorf("model = %v, want openai/gpt-4o", decoded["model"])
	}
	msgs := decoded["messages"].([]any)
	if len(msgs) != 2 {
		t.Errorf("messages len = %d, want 2", len(msgs))
	}
	if decoded["stream"] != nil {
		t.Errorf("stream should be omitted when false, got %v", decoded["stream"])
	}
}

func TestChatRequest_WithTools(t *testing.T) {
	req := ChatRequest{
		Model: "openai/gpt-4o",
		Messages: []Message{
			{Role: "user", Content: "list tables"},
		},
		Tools: []ToolDefinition{
			{
				Type: "function",
				Function: FunctionSchema{
					Name:        "list_tables",
					Description: "List all tables",
					Parameters:  json.RawMessage(`{"type":"object","properties":{"schema":{"type":"string"}}}`),
				},
			},
		},
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var roundtrip ChatRequest
	if err := json.Unmarshal(data, &roundtrip); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(roundtrip.Tools) != 1 {
		t.Fatalf("tools len = %d, want 1", len(roundtrip.Tools))
	}
	if roundtrip.Tools[0].Function.Name != "list_tables" {
		t.Errorf("tool name = %s, want list_tables", roundtrip.Tools[0].Function.Name)
	}
}

func TestChatResponse_Unmarshal(t *testing.T) {
	raw := `{
		"id": "chatcmpl-abc123",
		"object": "chat.completion",
		"model": "openai/gpt-4o",
		"choices": [{
			"index": 0,
			"message": {
				"role": "assistant",
				"content": "Here is the explanation."
			},
			"finish_reason": "stop"
		}],
		"usage": {
			"prompt_tokens": 50,
			"completion_tokens": 120,
			"total_tokens": 170
		}
	}`

	var resp ChatResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if resp.ID != "chatcmpl-abc123" {
		t.Errorf("id = %s", resp.ID)
	}
	if resp.Model != "openai/gpt-4o" {
		t.Errorf("model = %s", resp.Model)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("choices len = %d", len(resp.Choices))
	}
	if resp.Choices[0].Message.Content != "Here is the explanation." {
		t.Errorf("content = %s", resp.Choices[0].Message.Content)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Errorf("finish_reason = %s", resp.Choices[0].FinishReason)
	}
	if resp.Usage.PromptTokens != 50 {
		t.Errorf("prompt_tokens = %d", resp.Usage.PromptTokens)
	}
	if resp.Usage.CompletionTokens != 120 {
		t.Errorf("completion_tokens = %d", resp.Usage.CompletionTokens)
	}
	if resp.Usage.TotalTokens != 170 {
		t.Errorf("total_tokens = %d", resp.Usage.TotalTokens)
	}
}

func TestChatResponse_WithToolCalls(t *testing.T) {
	raw := `{
		"id": "chatcmpl-xyz",
		"object": "chat.completion",
		"model": "openai/gpt-4o",
		"choices": [{
			"index": 0,
			"message": {
				"role": "assistant",
				"tool_calls": [{
					"id": "call_abc",
					"type": "function",
					"function": {
						"name": "list_tables",
						"arguments": "{\"schema\":\"public\"}"
					}
				}]
			},
			"finish_reason": "tool_calls"
		}],
		"usage": {"prompt_tokens": 30, "completion_tokens": 15, "total_tokens": 45}
	}`

	var resp ChatResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	msg := resp.Choices[0].Message
	if len(msg.ToolCalls) != 1 {
		t.Fatalf("tool_calls len = %d", len(msg.ToolCalls))
	}
	tc := msg.ToolCalls[0]
	if tc.ID != "call_abc" {
		t.Errorf("tool_call id = %s", tc.ID)
	}
	if tc.Type != "function" {
		t.Errorf("tool_call type = %s", tc.Type)
	}
	if tc.Function.Name != "list_tables" {
		t.Errorf("function name = %s", tc.Function.Name)
	}
	if tc.Function.Arguments != `{"schema":"public"}` {
		t.Errorf("function args = %s", tc.Function.Arguments)
	}
}

func TestStreamChunk_Unmarshal(t *testing.T) {
	raw := `{
		"id": "chatcmpl-stream1",
		"object": "chat.completion.chunk",
		"model": "openai/gpt-4o",
		"choices": [{
			"index": 0,
			"delta": {
				"content": "SELECT "
			},
			"finish_reason": null
		}]
	}`

	var chunk StreamChunk
	if err := json.Unmarshal([]byte(raw), &chunk); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if chunk.ID != "chatcmpl-stream1" {
		t.Errorf("id = %s", chunk.ID)
	}
	if len(chunk.Choices) != 1 {
		t.Fatalf("choices len = %d", len(chunk.Choices))
	}
	if chunk.Choices[0].Delta.Content != "SELECT " {
		t.Errorf("delta content = %q", chunk.Choices[0].Delta.Content)
	}
	if chunk.Choices[0].FinishReason != nil {
		t.Errorf("finish_reason should be nil, got %v", *chunk.Choices[0].FinishReason)
	}
}

func TestStreamChunk_WithUsage(t *testing.T) {
	raw := `{
		"id": "chatcmpl-stream2",
		"object": "chat.completion.chunk",
		"model": "openai/gpt-4o",
		"choices": [{
			"index": 0,
			"delta": {},
			"finish_reason": "stop"
		}],
		"usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
	}`

	var chunk StreamChunk
	if err := json.Unmarshal([]byte(raw), &chunk); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	stop := "stop"
	if chunk.Choices[0].FinishReason == nil || *chunk.Choices[0].FinishReason != stop {
		t.Errorf("finish_reason = %v, want %q", chunk.Choices[0].FinishReason, stop)
	}
	if chunk.Usage == nil {
		t.Fatal("usage should be present")
	}
	if chunk.Usage.TotalTokens != 30 {
		t.Errorf("total_tokens = %d", chunk.Usage.TotalTokens)
	}
}

func TestMessage_ToolCallID(t *testing.T) {
	msg := Message{
		Role:       "tool",
		Content:    `{"tables":["users","orders"]}`,
		ToolCallID: "call_abc",
	}

	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Message
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.ToolCallID != "call_abc" {
		t.Errorf("tool_call_id = %s", decoded.ToolCallID)
	}
	if decoded.Role != "tool" {
		t.Errorf("role = %s", decoded.Role)
	}
}
