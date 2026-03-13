package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/tools"
)

func TestChatCompletion_Success(t *testing.T) {
	want := ChatResponse{
		ID:    "chatcmpl-test1",
		Model: "openai/gpt-4o",
		Choices: []Choice{{
			Index:        0,
			Message:      Message{Role: "assistant", Content: "Hello!"},
			FinishReason: "stop",
		}},
		Usage: Usage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify request
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("auth = %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content-type = %s", r.Header.Get("Content-Type"))
		}

		// Verify body is valid ChatRequest
		var req ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Model != "openai/gpt-4o" {
			t.Errorf("req.Model = %s", req.Model)
		}
		if req.Stream {
			t.Error("stream should be false for ChatCompletion")
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(want)
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "Hi"}},
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}

	if resp.ID != want.ID {
		t.Errorf("id = %s, want %s", resp.ID, want.ID)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("choices len = %d", len(resp.Choices))
	}
	if resp.Choices[0].Message.Content != "Hello!" {
		t.Errorf("content = %s", resp.Choices[0].Message.Content)
	}
	if resp.Usage.PromptTokens != 10 {
		t.Errorf("prompt_tokens = %d", resp.Usage.PromptTokens)
	}
	if resp.Usage.CompletionTokens != 5 {
		t.Errorf("completion_tokens = %d", resp.Usage.CompletionTokens)
	}
}

func TestChatCompletion_WithToolCalls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req ChatRequest
		json.NewDecoder(r.Body).Decode(&req)

		if len(req.Tools) != 1 {
			t.Errorf("tools len = %d, want 1", len(req.Tools))
		}

		resp := ChatResponse{
			ID:    "chatcmpl-tools",
			Model: "openai/gpt-4o",
			Choices: []Choice{{
				Message: Message{
					Role: "assistant",
					ToolCalls: []ToolCall{{
						ID:   "call_1",
						Type: "function",
						Function: FunctionCall{
							Name:      "list_tables",
							Arguments: `{"schema":"public"}`,
						},
					}},
				},
				FinishReason: "tool_calls",
			}},
			Usage: Usage{PromptTokens: 20, CompletionTokens: 10, TotalTokens: 30},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "list tables"}},
		Tools: []ToolDefinition{{
			Type: "function",
			Function: FunctionSchema{
				Name:        "list_tables",
				Description: "List tables",
				Parameters:  json.RawMessage(`{"type":"object"}`),
			},
		}},
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}

	tc := resp.Choices[0].Message.ToolCalls
	if len(tc) != 1 {
		t.Fatalf("tool_calls len = %d", len(tc))
	}
	if tc[0].Function.Name != "list_tables" {
		t.Errorf("tool name = %s", tc[0].Function.Name)
	}
}

func TestChatCompletion_APIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL), WithMaxRetries(0))
	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "test"}},
	})

	if err == nil {
		t.Fatal("expected error, got nil")
	}

	apiErr, ok := IsAPIError(err)
	if !ok {
		t.Fatalf("expected APIError, got %T: %v", err, err)
	}
	if apiErr.StatusCode != 429 {
		t.Errorf("status = %d, want 429", apiErr.StatusCode)
	}
}

func TestChatCompletion_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"internal error"}}`))
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL), WithMaxRetries(0))
	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "test"}},
	})

	apiErr, ok := IsAPIError(err)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("status = %d, want 500", apiErr.StatusCode)
	}
}

func TestChatCompletion_ContextCanceled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Block forever (context should cancel)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	client := NewClient("test-key", WithBaseURL(srv.URL))
	_, err := client.ChatCompletion(ctx, ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "test"}},
	})

	if err == nil {
		t.Fatal("expected error for canceled context")
	}
}

func TestToolsFromRegistry(t *testing.T) {
	reg := tools.NewRegistry()
	defs := reg.All()
	llmTools := ToolsFromRegistry(defs)

	if len(llmTools) != len(defs) {
		t.Fatalf("len = %d, want %d", len(llmTools), len(defs))
	}

	for _, tool := range llmTools {
		if tool.Type != "function" {
			t.Errorf("type = %s, want function", tool.Type)
		}
		if tool.Function.Name == "" {
			t.Error("function name is empty")
		}
		if tool.Function.Description == "" {
			t.Errorf("function %s has empty description", tool.Function.Name)
		}
		if len(tool.Function.Parameters) == 0 {
			t.Errorf("function %s has empty parameters", tool.Function.Name)
		}
	}
}

func TestChatCompletion_UsageParsing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := ChatResponse{
			ID:    "chatcmpl-usage",
			Model: "openai/gpt-4o",
			Choices: []Choice{{
				Message:      Message{Role: "assistant", Content: "ok"},
				FinishReason: "stop",
			}},
			Usage: Usage{PromptTokens: 100, CompletionTokens: 200, TotalTokens: 300},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient("test-key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "openai/gpt-4o",
		Messages: []Message{{Role: "user", Content: "test"}},
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}

	if resp.Usage.PromptTokens != 100 {
		t.Errorf("prompt_tokens = %d", resp.Usage.PromptTokens)
	}
	if resp.Usage.CompletionTokens != 200 {
		t.Errorf("completion_tokens = %d", resp.Usage.CompletionTokens)
	}
	if resp.Usage.TotalTokens != 300 {
		t.Errorf("total_tokens = %d", resp.Usage.TotalTokens)
	}
}

func TestAPIError_ErrorString(t *testing.T) {
	err := &APIError{StatusCode: 401, Body: "unauthorized"}
	want := "llm: API error 401: unauthorized"
	if err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
}

func TestNewClient_Defaults(t *testing.T) {
	client := NewClient("my-key")
	if client.apiKey != "my-key" {
		t.Errorf("apiKey = %s", client.apiKey)
	}
	if client.baseURL != defaultBaseURL {
		t.Errorf("baseURL = %s", client.baseURL)
	}
	if client.httpClient == nil {
		t.Error("httpClient is nil")
	}
}

func TestNewClient_WithOptions(t *testing.T) {
	hc := &http.Client{}
	client := NewClient("key", WithBaseURL("http://custom"), WithHTTPClient(hc))
	if client.baseURL != "http://custom" {
		t.Errorf("baseURL = %s", client.baseURL)
	}
	if client.httpClient != hc {
		t.Error("httpClient not set")
	}
}
