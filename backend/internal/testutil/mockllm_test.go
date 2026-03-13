package testutil

import (
	"context"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/llm"
)

func TestNewSimpleMockLLMServer(t *testing.T) {
	server := NewSimpleMockLLMServer(t, "hello world")
	defer server.Close()

	client := llm.NewClient("test-key", llm.WithBaseURL(server.URL), llm.WithMaxRetries(0))
	resp, err := client.ChatCompletion(context.Background(), llm.ChatRequest{
		Model:    "test",
		Messages: []llm.Message{{Role: "user", Content: "test"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Choices) == 0 {
		t.Fatal("expected at least one choice")
	}
	if resp.Choices[0].Message.Content != "hello world" {
		t.Errorf("expected 'hello world', got %q", resp.Choices[0].Message.Content)
	}
	if resp.Usage.TotalTokens != 60 {
		t.Errorf("expected 60 total tokens, got %d", resp.Usage.TotalTokens)
	}
	if resp.Model != "test-model" {
		t.Errorf("expected model 'test-model', got %q", resp.Model)
	}
}

func TestNewMockLLMServer_PromptRouter(t *testing.T) {
	server := NewMockLLMServer(t, MockLLMConfig{
		FixedContent: "default response",
		PromptRouter: func(prompt string, streaming bool) (string, bool) {
			if !streaming && prompt == "special " {
				return "routed response", true
			}
			return "", false
		},
	})
	defer server.Close()

	client := llm.NewClient("test-key", llm.WithBaseURL(server.URL), llm.WithMaxRetries(0))

	// Default response.
	resp, err := client.ChatCompletion(context.Background(), llm.ChatRequest{
		Model:    "test",
		Messages: []llm.Message{{Role: "user", Content: "normal"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Choices[0].Message.Content != "default response" {
		t.Errorf("expected default, got %q", resp.Choices[0].Message.Content)
	}

	// Routed response.
	resp, err = client.ChatCompletion(context.Background(), llm.ChatRequest{
		Model:    "test",
		Messages: []llm.Message{{Role: "user", Content: "special"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Choices[0].Message.Content != "routed response" {
		t.Errorf("expected routed, got %q", resp.Choices[0].Message.Content)
	}
}

func TestNewMockLLMServer_Streaming(t *testing.T) {
	server := NewMockLLMServer(t, MockLLMConfig{
		StreamChunks: []string{"chunk1 ", "chunk2 ", "chunk3"},
	})
	defer server.Close()

	client := llm.NewClient("test-key", llm.WithBaseURL(server.URL), llm.WithMaxRetries(0))

	var deltas []string
	resp, err := client.ChatCompletionStream(context.Background(), llm.ChatRequest{
		Model:    "test",
		Messages: []llm.Message{{Role: "user", Content: "test"}},
	}, func(chunk llm.StreamChunk) error {
		if len(chunk.Choices) > 0 {
			deltas = append(deltas, chunk.Choices[0].Delta.Content)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(deltas) != 3 {
		t.Errorf("expected 3 deltas, got %d", len(deltas))
	}
	if resp.Usage.TotalTokens != 60 {
		t.Errorf("expected 60 total tokens, got %d", resp.Usage.TotalTokens)
	}
}

func TestToolHandler_AllTools(t *testing.T) {
	tools := []string{
		"list_schemas", "list_tables", "describe_table",
		"list_indexes", "explain_query", "execute_query", "list_functions",
	}
	for _, tool := range tools {
		data, success := ToolHandler(tool, nil)
		if !success {
			t.Errorf("tool %q: expected success", tool)
		}
		if data == nil {
			t.Errorf("tool %q: expected non-nil data", tool)
		}
	}

	// Unknown tool.
	_, success := ToolHandler("unknown_tool", nil)
	if success {
		t.Error("expected unknown tool to fail")
	}
}
