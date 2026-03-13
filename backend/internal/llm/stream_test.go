package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func sseResponse(chunks ...string) string {
	var b strings.Builder
	for _, c := range chunks {
		b.WriteString("data: ")
		b.WriteString(c)
		b.WriteString("\n\n")
	}
	b.WriteString("data: [DONE]\n\n")
	return b.String()
}

func TestChatCompletionStream_Success(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"chatcmpl-1","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}`,
		`{"id":"chatcmpl-1","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
		`{"id":"chatcmpl-1","model":"openai/gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	var chunks []StreamChunk
	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "Hi"}},
	}, func(chunk StreamChunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}

	if len(chunks) != 3 {
		t.Fatalf("chunks = %d, want 3", len(chunks))
	}

	if resp.Choices[0].Message.Content != "Hello world" {
		t.Errorf("content = %q, want %q", resp.Choices[0].Message.Content, "Hello world")
	}
	if resp.Usage.PromptTokens != 10 {
		t.Errorf("prompt_tokens = %d, want 10", resp.Usage.PromptTokens)
	}
	if resp.Usage.CompletionTokens != 5 {
		t.Errorf("completion_tokens = %d, want 5", resp.Usage.CompletionTokens)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Errorf("finish_reason = %q, want %q", resp.Choices[0].FinishReason, "stop")
	}
	if resp.ID != "chatcmpl-1" {
		t.Errorf("id = %q, want %q", resp.ID, "chatcmpl-1")
	}
	if resp.Model != "openai/gpt-4o" {
		t.Errorf("model = %q", resp.Model)
	}
}

func TestChatCompletionStream_ToolCalls(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"chatcmpl-2","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_tables","arguments":""}}]},"finish_reason":null}]}`,
		`{"id":"chatcmpl-2","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"sche"}}]},"finish_reason":null}]}`,
		`{"id":"chatcmpl-2","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ma\":\"public\"}"}}]},"finish_reason":null}]}`,
		`{"id":"chatcmpl-2","model":"openai/gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "list tables"}},
	}, nil)
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}

	tc := resp.Choices[0].Message.ToolCalls
	if len(tc) != 1 {
		t.Fatalf("tool_calls len = %d, want 1", len(tc))
	}
	if tc[0].ID != "call_1" {
		t.Errorf("tool_call id = %q", tc[0].ID)
	}
	if tc[0].Function.Name != "list_tables" {
		t.Errorf("tool_call name = %q", tc[0].Function.Name)
	}
	if tc[0].Function.Arguments != `{"schema":"public"}` {
		t.Errorf("tool_call args = %q", tc[0].Function.Arguments)
	}
	if resp.Choices[0].FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q", resp.Choices[0].FinishReason)
	}
}

func TestChatCompletionStream_MultipleToolCalls(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"chatcmpl-3","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"list_tables","arguments":"{}"}}]},"finish_reason":null}]}`,
		`{"id":"chatcmpl-3","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"list_schemas","arguments":"{}"}}]},"finish_reason":null}]}`,
		`{"id":"chatcmpl-3","model":"openai/gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "list all"}},
	}, nil)
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}

	tc := resp.Choices[0].Message.ToolCalls
	if len(tc) != 2 {
		t.Fatalf("tool_calls len = %d, want 2", len(tc))
	}
	if tc[0].Function.Name != "list_tables" {
		t.Errorf("tc[0] name = %q", tc[0].Function.Name)
	}
	if tc[1].Function.Name != "list_schemas" {
		t.Errorf("tc[1] name = %q", tc[1].Function.Name)
	}
}

func TestChatCompletionStream_DoneMarker(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"chatcmpl-4","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"done test"},"finish_reason":"stop"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "test"}},
	}, nil)
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}

	if resp.Choices[0].Message.Content != "done test" {
		t.Errorf("content = %q", resp.Choices[0].Message.Content)
	}
}

func TestChatCompletionStream_CallbackError(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"chatcmpl-5","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "test"}},
	}, func(chunk StreamChunk) error {
		return fmt.Errorf("abort")
	})

	if err == nil {
		t.Fatal("expected error from callback")
	}
	if !strings.Contains(err.Error(), "abort") {
		t.Errorf("error = %q, want to contain 'abort'", err.Error())
	}
}

func TestChatCompletionStream_APIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL), WithMaxRetries(0))
	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "test"}},
	}, nil)

	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := IsAPIError(err)
	if !ok {
		t.Fatalf("expected APIError, got %T: %v", err, err)
	}
	if apiErr.StatusCode != 429 {
		t.Errorf("status = %d, want 429", apiErr.StatusCode)
	}
}

func TestChatCompletionStream_ConcatenationComplete(t *testing.T) {
	// 10 chunks that together form a complete sentence
	chunks := make([]string, 10)
	words := []string{"The ", "quick ", "brown ", "fox ", "jumps ", "over ", "the ", "lazy ", "dog", "."}
	for i, w := range words {
		chunks[i] = fmt.Sprintf(`{"id":"chatcmpl-6","model":"test","choices":[{"index":0,"delta":{"content":"%s"},"finish_reason":null}]}`, w)
	}

	sseBody := sseResponse(chunks...)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	var received []string
	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "test"}},
	}, func(chunk StreamChunk) error {
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			received = append(received, chunk.Choices[0].Delta.Content)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}

	if len(received) != 10 {
		t.Errorf("received chunks = %d, want 10", len(received))
	}

	want := "The quick brown fox jumps over the lazy dog."
	if resp.Choices[0].Message.Content != want {
		t.Errorf("content = %q, want %q", resp.Choices[0].Message.Content, want)
	}
}

func TestChatCompletionStream_NilCallback(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"chatcmpl-7","model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "test"}},
	}, nil)
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	if resp.Choices[0].Message.Content != "ok" {
		t.Errorf("content = %q", resp.Choices[0].Message.Content)
	}
}

func TestChatCompletionStream_SSEComments(t *testing.T) {
	// SSE spec allows comments starting with ":"
	raw := ": this is a comment\n\ndata: {\"id\":\"chatcmpl-8\",\"model\":\"test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(raw))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "test"}},
	}, nil)
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	if resp.Choices[0].Message.Content != "hi" {
		t.Errorf("content = %q", resp.Choices[0].Message.Content)
	}
}

func TestChatCompletionStream_StreamTrue(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"chatcmpl-9","model":"test","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify stream=true in request body
		var req ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !req.Stream {
			t.Error("stream should be true for ChatCompletionStream")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "test"}},
	}, nil)
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
}
