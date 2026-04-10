package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
)

// buildParallelGenContext creates a PipelineContext with schema context for parallel generation tests.
func buildParallelGenContext(t *testing.T, llmClient *llm.Client) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-parallel"
	pctx.Action = "generate_sql"
	pctx.UserMessage = "покажи топ 10 пользователей по количеству заказов"
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()

	sc := &SchemaContext{
		Tables: []TableInfo{
			{
				Schema:  "public",
				Table:   "users",
				Details: json.RawMessage(`{"columns":["id","name","email"]}`),
			},
			{
				Schema:  "public",
				Table:   "orders",
				Details: json.RawMessage(`{"columns":["id","user_id","total","created_at"],"foreign_keys":[{"column":"user_id","references":"users.id"}]}`),
			},
		},
	}
	pctx.Set(ContextKeySchemaContext, sc)
	return pctx
}

func TestParallelGeneration_Success(t *testing.T) {
	// Mock LLM server that returns different SQL per request (using atomic counter).
	var counter atomic.Int32
	responses := []string{
		"SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY COUNT(o.id) DESC LIMIT 10",
		"WITH order_counts AS (SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id) SELECT u.name, oc.cnt FROM users u JOIN order_counts oc ON u.id = oc.user_id ORDER BY oc.cnt DESC LIMIT 10",
		"SELECT u.name, COUNT(o.id) AS total_orders FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 0 ORDER BY total_orders DESC LIMIT 10",
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idx := int(counter.Add(1) - 1)
		content := responses[idx%len(responses)]
		resp := llm.ChatResponse{
			ID:    fmt.Sprintf("chatcmpl-%d", idx),
			Model: "test-model",
			Choices: []llm.Choice{
				{Index: 0, Message: llm.Message{Role: "assistant", Content: content}, FinishReason: "stop"},
			},
			Usage: llm.Usage{PromptTokens: 50, CompletionTokens: 10, TotalTokens: 60},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL))
	pctx := buildParallelGenContext(t, llmClient)

	step := &ParallelSQLGenerationStep{CandidatesCount: 3}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	// Verify 3 candidates generated.
	val, ok := pctx.Get(ContextKeySQLCandidates)
	if !ok {
		t.Fatal("sql_candidates not stored in context")
	}
	candidates := val.([]string)
	if len(candidates) != 3 {
		t.Fatalf("expected 3 candidates, got %d", len(candidates))
	}

	// All candidates should be non-empty and different.
	seen := make(map[string]bool)
	for i, c := range candidates {
		if c == "" {
			t.Errorf("candidate %d is empty", i)
		}
		seen[c] = true
	}
	if len(seen) < 2 {
		t.Errorf("expected at least 2 distinct candidates, got %d", len(seen))
	}

	// Verify Result fields.
	if pctx.Result.SQL == "" {
		t.Error("Result.SQL is empty")
	}
	if len(pctx.Result.Candidates) != 3 {
		t.Errorf("Result.Candidates length = %d, want 3", len(pctx.Result.Candidates))
	}

	// Verify tokens accumulated (60 * 3 = 180).
	if pctx.TokensUsed != 180 {
		t.Errorf("expected 180 tokens, got %d", pctx.TokensUsed)
	}

	// Verify model tracked.
	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model test-model, got %s", pctx.ModelUsed)
	}

	// Verify backward compatibility: ContextKeySQLCandidate also set.
	singleVal, ok := pctx.Get(ContextKeySQLCandidate)
	if !ok {
		t.Fatal("sql_candidate not stored for backward compat")
	}
	if singleVal.(string) != candidates[0] {
		t.Error("sql_candidate should equal first candidate")
	}
}

func TestParallelGeneration_AllFail(t *testing.T) {
	// LLM server unreachable — all 3 candidates fail.
	llmClient := llm.NewClient("test-key", llm.WithBaseURL("http://localhost:1"), llm.WithMaxRetries(0))
	pctx := buildParallelGenContext(t, llmClient)

	step := &ParallelSQLGenerationStep{CandidatesCount: 3}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error when all candidates fail")
	}
	if !strings.Contains(err.Error(), "all 3 SQL candidate generations failed") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestParallelGeneration_PartialFailure(t *testing.T) {
	// First request succeeds, second and third fail (server returns 500).
	var counter atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idx := int(counter.Add(1) - 1)
		if idx > 0 {
			w.WriteHeader(500)
			w.Write([]byte(`{"error":"internal"}`))
			return
		}
		resp := llm.ChatResponse{
			ID:    "chatcmpl-0",
			Model: "test-model",
			Choices: []llm.Choice{
				{Index: 0, Message: llm.Message{Role: "assistant", Content: "SELECT * FROM users LIMIT 10"}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 60},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithMaxRetries(0))
	pctx := buildParallelGenContext(t, llmClient)

	step := &ParallelSQLGenerationStep{CandidatesCount: 3}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("expected partial success, got error: %v", err)
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	candidates := val.([]string)
	if len(candidates) != 1 {
		t.Errorf("expected 1 successful candidate, got %d", len(candidates))
	}
	if candidates[0] != "SELECT * FROM users LIMIT 10" {
		t.Errorf("unexpected candidate: %q", candidates[0])
	}
}

func TestParallelGeneration_MissingSchemaContext(t *testing.T) {
	llmClient := llm.NewClient("test-key")
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.UserMessage = "test"
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	step := &ParallelSQLGenerationStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for missing schema context")
	}
	if !strings.Contains(err.Error(), "schema_context not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestParallelGeneration_DefaultCandidatesCount(t *testing.T) {
	var counter atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idx := int(counter.Add(1))
		resp := llm.ChatResponse{
			ID:    fmt.Sprintf("chatcmpl-%d", idx),
			Model: "test-model",
			Choices: []llm.Choice{
				{Index: 0, Message: llm.Message{Role: "assistant", Content: fmt.Sprintf("SELECT %d", idx)}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 20},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL))
	pctx := buildParallelGenContext(t, llmClient)

	// CandidatesCount = 0 → defaults to 3.
	step := &ParallelSQLGenerationStep{}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	candidates := val.([]string)
	if len(candidates) != DefaultCandidatesCount {
		t.Errorf("expected %d candidates (default), got %d", DefaultCandidatesCount, len(candidates))
	}
}

func TestParallelGeneration_CustomCandidatesCount(t *testing.T) {
	var counter atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idx := int(counter.Add(1))
		resp := llm.ChatResponse{
			ID:    fmt.Sprintf("chatcmpl-%d", idx),
			Model: "test-model",
			Choices: []llm.Choice{
				{Index: 0, Message: llm.Message{Role: "assistant", Content: fmt.Sprintf("SELECT %d", idx)}, FinishReason: "stop"},
			},
			Usage: llm.Usage{PromptTokens: 15, CompletionTokens: 5, TotalTokens: 20},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL))
	pctx := buildParallelGenContext(t, llmClient)

	step := &ParallelSQLGenerationStep{CandidatesCount: 5}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	candidates := val.([]string)
	if len(candidates) != 5 {
		t.Errorf("expected 5 candidates, got %d", len(candidates))
	}

	// Tokens: 20 * 5 = 100.
	if pctx.TokensUsed != 100 {
		t.Errorf("expected 100 tokens, got %d", pctx.TokensUsed)
	}
}

func TestParallelGeneration_DifferentTemperatures(t *testing.T) {
	// Verify each request gets a different temperature.
	var temps []float64
	var mu = &sync.Mutex{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req llm.ChatRequest
		json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		if req.Temperature != nil {
			temps = append(temps, *req.Temperature)
		}
		mu.Unlock()

		resp := llm.ChatResponse{
			Model:   "test-model",
			Choices: []llm.Choice{{Message: llm.Message{Role: "assistant", Content: "SELECT 1"}, FinishReason: "stop"}},
			Usage:   llm.Usage{TotalTokens: 10},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL))
	pctx := buildParallelGenContext(t, llmClient)

	step := &ParallelSQLGenerationStep{CandidatesCount: 3}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if len(temps) != 3 {
		t.Fatalf("expected 3 temperature values, got %d", len(temps))
	}

	// Sort to check we have distinct values.
	seen := make(map[float64]bool)
	for _, temp := range temps {
		seen[temp] = true
	}
	if len(seen) < 3 {
		t.Errorf("expected 3 distinct temperatures, got %d: %v", len(seen), temps)
	}
}

func TestParallelGeneration_StripCodeFences(t *testing.T) {
	srv := newMockLLMServer(t, "```sql\nSELECT * FROM users LIMIT 10\n```")
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL))
	pctx := buildParallelGenContext(t, llmClient)

	step := &ParallelSQLGenerationStep{CandidatesCount: 1}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	candidates := val.([]string)
	if candidates[0] != "SELECT * FROM users LIMIT 10" {
		t.Errorf("code fences not stripped: got %q", candidates[0])
	}
}

func TestCandidateConfigs(t *testing.T) {
	configs := candidateConfigs(3)
	if len(configs) != 3 {
		t.Fatalf("expected 3 configs, got %d", len(configs))
	}

	// Check all have non-empty suffix.
	for i, c := range configs {
		if c.suffix == "" {
			t.Errorf("config %d has empty suffix", i)
		}
		if c.temperature < 0 || c.temperature > 1 {
			t.Errorf("config %d temperature %f out of [0,1] range", i, c.temperature)
		}
	}

	// Check wrapping for N > 3.
	configs5 := candidateConfigs(5)
	if len(configs5) != 5 {
		t.Fatalf("expected 5 configs, got %d", len(configs5))
	}
	// 4th and 5th should wrap around to configs 0 and 1.
	if configs5[3].temperature != configs5[0].temperature {
		t.Errorf("expected wrapping: config[3].temp=%f != config[0].temp=%f", configs5[3].temperature, configs5[0].temperature)
	}
}
