package steps

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
)

func buildSeedContext(t *testing.T, llmClient *llm.Client, candidates []string) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-seed"
	pctx.Action = "generate_sql"
	pctx.UserMessage = "show top users"
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	pctx.Set(ContextKeySQLCandidates, candidates)

	sc := &SchemaContext{
		Tables: []TableInfo{
			{Schema: "public", Table: "users", Details: json.RawMessage(`{"columns":["id","name","email"]}`)},
			{Schema: "public", Table: "orders", Details: json.RawMessage(`{"columns":["id","user_id","total"]}`)},
		},
	}
	pctx.Set(ContextKeySchemaContext, sc)

	return pctx
}

func TestSeedExpansion_EnoughCandidates(t *testing.T) {
	// 3 valid candidates — seed expansion should be skipped.
	llmClient := llm.NewClient("test-key") // LLM should not be called
	candidates := []string{
		"SELECT * FROM users LIMIT 10",
		"SELECT name FROM users ORDER BY name",
		"SELECT COUNT(*) FROM orders",
	}
	pctx := buildSeedContext(t, llmClient, candidates)

	step := &SeedExpansionStep{}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	result := val.([]string)
	if len(result) != 3 {
		t.Errorf("expected 3 candidates unchanged, got %d", len(result))
	}
}

func TestSeedExpansion_OneCandidate_ExpandsToThree(t *testing.T) {
	// 1 valid candidate — LLM generates 2 variations.
	var llmCallCount atomic.Int32
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := llmCallCount.Add(1)
		sql := "SELECT id, name FROM users ORDER BY id"
		if n == 2 {
			sql = "WITH u AS (SELECT * FROM users) SELECT * FROM u LIMIT 10"
		}
		resp := llm.ChatResponse{
			Model: "test-model",
			Choices: []llm.Choice{
				{Message: llm.Message{Role: "assistant", Content: sql}, FinishReason: "stop"},
			},
			Usage: llm.Usage{PromptTokens: 20, CompletionTokens: 10, TotalTokens: 30},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(mockLLM.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users LIMIT 10"}
	pctx := buildSeedContext(t, llmClient, candidates)

	step := &SeedExpansionStep{}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if llmCallCount.Load() != 2 {
		t.Errorf("expected 2 LLM calls, got %d", llmCallCount.Load())
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	result := val.([]string)
	if len(result) != 3 {
		t.Fatalf("expected 3 candidates, got %d", len(result))
	}

	// First should be original.
	if result[0] != "SELECT * FROM users LIMIT 10" {
		t.Errorf("expected first candidate unchanged, got %q", result[0])
	}

	// Variations should be distinct from original.
	if result[1] == result[0] {
		t.Error("variation 1 should differ from original")
	}

	// Tokens tracked.
	if pctx.TokensUsed != 60 {
		t.Errorf("expected 60 tokens, got %d", pctx.TokensUsed)
	}
	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model test-model, got %q", pctx.ModelUsed)
	}
}

func TestSeedExpansion_ZeroCandidates_Error(t *testing.T) {
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Logger = zap.NewNop()
	pctx.Set(ContextKeySQLCandidates, []string{})

	step := &SeedExpansionStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for zero candidates")
	}
	if !strings.Contains(err.Error(), "no valid SQL candidates") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestSeedExpansion_MissingCandidates(t *testing.T) {
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Logger = zap.NewNop()

	step := &SeedExpansionStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for missing candidates")
	}
	if !strings.Contains(err.Error(), "sql_candidates not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestSeedExpansion_LLMFailure_PartialExpansion(t *testing.T) {
	// 1 candidate, LLM fails on both variations — still returns with 1 candidate (no error).
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	t.Cleanup(mockLLM.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users"}
	pctx := buildSeedContext(t, llmClient, candidates)

	step := &SeedExpansionStep{}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step should not fail when LLM variations fail: %v", err)
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	result := val.([]string)
	if len(result) != 1 {
		t.Errorf("expected 1 candidate (original only), got %d", len(result))
	}
}

func TestSeedExpansion_CustomMinCandidates(t *testing.T) {
	// Custom MinCandidates=5, 2 existing → needs 3 variations.
	var llmCallCount atomic.Int32
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := llmCallCount.Add(1)
		resp := llm.ChatResponse{
			Model: "test-model",
			Choices: []llm.Choice{
				{Message: llm.Message{Role: "assistant", Content: string(rune('A'+n-1)) + " variation SQL"}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 20},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(mockLLM.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users", "SELECT COUNT(*) FROM users"}
	pctx := buildSeedContext(t, llmClient, candidates)

	step := &SeedExpansionStep{MinCandidates: 5}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if llmCallCount.Load() != 3 {
		t.Errorf("expected 3 LLM calls, got %d", llmCallCount.Load())
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	result := val.([]string)
	if len(result) != 5 {
		t.Errorf("expected 5 candidates, got %d", len(result))
	}

	// First two should be originals.
	if result[0] != "SELECT * FROM users" || result[1] != "SELECT COUNT(*) FROM users" {
		t.Error("original candidates should be preserved")
	}
}

func TestSeedExpansion_CodeFencesStripped(t *testing.T) {
	// LLM returns SQL wrapped in code fences — should be stripped.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := llm.ChatResponse{
			Model: "test-model",
			Choices: []llm.Choice{
				{Message: llm.Message{Role: "assistant", Content: "```sql\nSELECT name FROM users;\n```"}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 25},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(mockLLM.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users"}
	pctx := buildSeedContext(t, llmClient, candidates)

	step := &SeedExpansionStep{MinCandidates: 2}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	result := val.([]string)
	if len(result) != 2 {
		t.Fatalf("expected 2 candidates, got %d", len(result))
	}
	if result[1] != "SELECT name FROM users" {
		t.Errorf("expected stripped SQL, got %q", result[1])
	}
}

func TestSeedExpansion_Name(t *testing.T) {
	step := &SeedExpansionStep{}
	if step.Name() != "seed_expansion" {
		t.Errorf("unexpected name: %q", step.Name())
	}
}

func TestSeedExpansion_ResultFieldsUpdated(t *testing.T) {
	// Verify Result.SQL and Result.Candidates are set correctly.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := llm.ChatResponse{
			Model: "test-model",
			Choices: []llm.Choice{
				{Message: llm.Message{Role: "assistant", Content: "SELECT id FROM users"}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 15},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(mockLLM.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users"}
	pctx := buildSeedContext(t, llmClient, candidates)

	step := &SeedExpansionStep{MinCandidates: 2}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.SQL != "SELECT * FROM users" {
		t.Errorf("Result.SQL should be first candidate, got %q", pctx.Result.SQL)
	}
	if len(pctx.Result.Candidates) != 2 {
		t.Errorf("expected 2 Result.Candidates, got %d", len(pctx.Result.Candidates))
	}
}
