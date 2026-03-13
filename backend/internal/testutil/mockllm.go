// Package testutil provides reusable test infrastructure for the progressql backend.
// It includes mock LLM servers, tool handlers, and WebSocket test helpers.
package testutil

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/llm"
)

// MockLLMConfig configures a mock LLM server.
type MockLLMConfig struct {
	// FixedContent is the default response content for non-streaming requests.
	FixedContent string
	// StreamChunks is the list of content deltas for streaming requests.
	// If empty, streaming requests fall back to FixedContent.
	StreamChunks []string
	// PromptRouter is an optional function that returns custom content based on prompt text.
	// If it returns ("", false), the server uses FixedContent/StreamChunks.
	PromptRouter func(prompt string, streaming bool) (string, bool)
	// Model is the model name to return in responses (default "test-model").
	Model string
	// PromptTokens, CompletionTokens for usage tracking (defaults: 50, 10).
	PromptTokens     int
	CompletionTokens int
}

// NewMockLLMServer creates a configurable mock LLM server for testing.
// It handles both streaming and non-streaming requests in OpenAI-compatible format.
func NewMockLLMServer(t *testing.T, cfg MockLLMConfig) *httptest.Server {
	t.Helper()

	if cfg.Model == "" {
		cfg.Model = "test-model"
	}
	if cfg.PromptTokens == 0 {
		cfg.PromptTokens = 50
	}
	if cfg.CompletionTokens == 0 {
		cfg.CompletionTokens = 10
	}

	var callCount int64

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req llm.ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		// Extract full prompt text for routing.
		prompt := extractPrompt(req.Messages)

		if req.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)

			// Check prompt router first.
			if cfg.PromptRouter != nil {
				if content, ok := cfg.PromptRouter(prompt, true); ok {
					writeSSEChunkFull(w, content, cfg.Model, cfg.PromptTokens, cfg.CompletionTokens)
					fmt.Fprint(w, "data: [DONE]\n\n")
					flush(w)
					return
				}
			}

			// Use StreamChunks or fall back to FixedContent.
			chunks := cfg.StreamChunks
			if len(chunks) == 0 && cfg.FixedContent != "" {
				chunks = []string{cfg.FixedContent}
			}
			if len(chunks) == 0 {
				chunks = []string{"mock response"}
			}

			for i, chunk := range chunks {
				if i == len(chunks)-1 {
					// Last chunk includes usage.
					writeSSEChunkFull(w, chunk, cfg.Model, cfg.PromptTokens, cfg.CompletionTokens)
				} else {
					writeSSEChunkSimple(w, chunk, cfg.Model)
				}
			}

			fmt.Fprint(w, "data: [DONE]\n\n")
			flush(w)
			return
		}

		// Non-streaming response.
		n := atomic.AddInt64(&callCount, 1)

		content := cfg.FixedContent
		if content == "" {
			content = fmt.Sprintf("mock response v%d", n)
		}

		// Check prompt router.
		if cfg.PromptRouter != nil {
			if routedContent, ok := cfg.PromptRouter(prompt, false); ok {
				content = routedContent
			}
		}

		total := cfg.PromptTokens + cfg.CompletionTokens
		resp := llm.ChatResponse{
			ID:    fmt.Sprintf("chatcmpl-test-%d", n),
			Model: cfg.Model,
			Choices: []llm.Choice{{
				Index:        0,
				Message:      llm.Message{Role: "assistant", Content: content},
				FinishReason: "stop",
			}},
			Usage: llm.Usage{
				PromptTokens:     cfg.PromptTokens,
				CompletionTokens: cfg.CompletionTokens,
				TotalTokens:      total,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

// NewSimpleMockLLMServer creates a minimal mock LLM server that returns a fixed response.
func NewSimpleMockLLMServer(t *testing.T, content string) *httptest.Server {
	t.Helper()
	return NewMockLLMServer(t, MockLLMConfig{FixedContent: content})
}

// NewPipelineMockLLMServer creates a mock LLM server suitable for full pipeline testing.
// It handles both streaming (aggregation/explain steps) and non-streaming (SQL generation/table selection).
func NewPipelineMockLLMServer(t *testing.T) *httptest.Server {
	t.Helper()
	return NewMockLLMServer(t, MockLLMConfig{
		FixedContent: `SELECT u.name FROM users u LIMIT 10`,
		StreamChunks: []string{"Analysis: ", "the query ", "is optimal."},
		PromptRouter: func(prompt string, streaming bool) (string, bool) {
			lower := strings.ToLower(prompt)
			if !streaming {
				if strings.Contains(lower, "relevant tables") || strings.Contains(lower, "which tables") {
					return `["users", "orders"]`, true
				}
				return "", false
			}
			// Streaming responses.
			if strings.Contains(lower, "explain") || strings.Contains(lower, "optimiz") {
				return "This query performs a sequential scan.\\n\\n```sql\\nSELECT u.id FROM users u LIMIT 50\\n```", true
			}
			if strings.Contains(lower, "analyze") || strings.Contains(lower, "schema") {
				return "Schema has 3 tables with FK relationships.", true
			}
			return "", false
		},
	})
}

// ToolHandler returns mock data for tool.call requests. Suitable for most pipeline tests.
func ToolHandler(toolName string, _ json.RawMessage) (any, bool) {
	switch toolName {
	case "list_schemas":
		return []string{"public"}, true
	case "list_tables":
		return []string{"users", "orders", "products"}, true
	case "describe_table":
		return map[string]any{
			"columns": []map[string]string{
				{"name": "id", "type": "integer"},
				{"name": "name", "type": "text"},
				{"name": "email", "type": "text"},
			},
			"indexes":      []map[string]any{{"name": "users_pkey", "columns": []string{"id"}, "unique": true}},
			"foreign_keys": []any{},
		}, true
	case "list_indexes":
		return map[string]any{
			"indexes": []map[string]any{{"name": "users_pkey", "columns": []string{"id"}, "unique": true}},
		}, true
	case "explain_query":
		return map[string]any{
			"plan": "Seq Scan on users (cost=0.00..1.05 rows=5 width=68)",
		}, true
	case "execute_query":
		return map[string]any{
			"rows":    []map[string]any{{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}},
			"columns": []string{"id", "name"},
		}, true
	case "list_functions":
		return map[string]any{"functions": []any{}}, true
	default:
		return map[string]string{"error": "unknown tool: " + toolName}, false
	}
}

func extractPrompt(messages []llm.Message) string {
	var sb strings.Builder
	for _, msg := range messages {
		sb.WriteString(msg.Content)
		sb.WriteString(" ")
	}
	return sb.String()
}

func writeSSEChunkSimple(w http.ResponseWriter, content, model string) {
	chunk := fmt.Sprintf(
		`{"id":"chatcmpl-1","object":"chat.completion.chunk","model":"%s","choices":[{"index":0,"delta":{"content":"%s"},"finish_reason":null}]}`,
		model, content,
	)
	fmt.Fprintf(w, "data: %s\n\n", chunk)
}

func writeSSEChunkFull(w http.ResponseWriter, content, model string, prompt, completion int) {
	total := prompt + completion
	chunk := fmt.Sprintf(
		`{"id":"chatcmpl-1","object":"chat.completion.chunk","model":"%s","choices":[{"index":0,"delta":{"content":"%s"},"finish_reason":"stop"}],"usage":{"prompt_tokens":%d,"completion_tokens":%d,"total_tokens":%d}}`,
		model, content, prompt, completion, total,
	)
	fmt.Fprintf(w, "data: %s\n\n", chunk)
}

func flush(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}
