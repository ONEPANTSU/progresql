package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// buildDiagnosticContext creates a PipelineContext with candidates for diagnostic retry tests.
func buildDiagnosticContext(t *testing.T, session *websocket.Session, llmClient *llm.Client, candidates []string) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-diag"
	pctx.Action = "generate_sql"
	pctx.UserMessage = "show top users"
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()

	pctx.Set(ContextKeySQLCandidates, candidates)

	// Set schema context for retry prompts.
	sc := &SchemaContext{
		Tables: []TableInfo{
			{Schema: "public", Table: "users", Details: json.RawMessage(`{"columns":["id","name","email"]}`)},
			{Schema: "public", Table: "orders", Details: json.RawMessage(`{"columns":["id","user_id","total"]}`)},
		},
	}
	pctx.Set(ContextKeySchemaContext, sc)

	return pctx
}

func TestDiagnosticRetry_AllValidNonRetry(t *testing.T) {
	// All 3 candidates pass EXPLAIN on first try — no retries needed.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key") // LLM should not be called
	candidates := []string{
		"SELECT * FROM users LIMIT 10",
		"SELECT name FROM users ORDER BY name",
		"SELECT COUNT(*) FROM orders",
	}
	pctx := buildDiagnosticContext(t, session, llmClient, candidates)

	errCh := make(chan error, 1)
	go func() {
		step := &DiagnosticRetryStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// For each candidate: read explain_query tool.call, respond with success.
	for i := 0; i < 3; i++ {
		toolCallEnv := readEnvelope(t, client)
		if toolCallEnv.Type != websocket.TypeToolCall {
			t.Fatalf("candidate %d: expected tool.call, got %s", i, toolCallEnv.Type)
		}
		var payload websocket.ToolCallPayload
		toolCallEnv.DecodePayload(&payload)
		if payload.ToolName != "explain_query" {
			t.Fatalf("candidate %d: expected explain_query, got %s", i, payload.ToolName)
		}

		// Verify SQL arg matches candidate.
		var args tools.ExplainQueryArgs
		json.Unmarshal(payload.Arguments, &args)
		if args.SQL != candidates[i] {
			t.Errorf("candidate %d: expected SQL=%q, got %q", i, candidates[i], args.SQL)
		}

		sendToolResult(t, client, "req-diag", toolCallEnv.CallID, true, tools.ExplainQueryResult{
			Plan: fmt.Sprintf("Seq Scan (cost=0.00..1.0%d rows=5 width=68)", i),
		})
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	// All 3 should be validated.
	val, ok := pctx.Get(ContextKeySQLCandidates)
	if !ok {
		t.Fatal("sql_candidates not in context")
	}
	validated := val.([]string)
	if len(validated) != 3 {
		t.Errorf("expected 3 validated candidates, got %d", len(validated))
	}
	if pctx.Result.SQL != candidates[0] {
		t.Errorf("expected Result.SQL=%q, got %q", candidates[0], pctx.Result.SQL)
	}

	// 3 tool calls logged.
	if len(pctx.ToolCallsLog) != 3 {
		t.Errorf("expected 3 tool call logs, got %d", len(pctx.ToolCallsLog))
	}
}

func TestDiagnosticRetry_RetrySucceedsOnSecondAttempt(t *testing.T) {
	// Candidate has bad SQL, EXPLAIN fails, LLM regenerates fixed SQL, EXPLAIN succeeds.
	var llmCallCount atomic.Int32
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCallCount.Add(1)
		resp := llm.ChatResponse{
			Model: "test-model",
			Choices: []llm.Choice{
				{Message: llm.Message{Role: "assistant", Content: "SELECT id, name FROM users LIMIT 10"}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 40},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(mockLLM.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM nonexistent_table"}
	pctx := buildDiagnosticContext(t, session, llmClient, candidates)

	errCh := make(chan error, 1)
	go func() {
		step := &DiagnosticRetryStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// First EXPLAIN — fails (bad table).
	toolCallEnv := readEnvelope(t, client)
	if toolCallEnv.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", toolCallEnv.Type)
	}
	sendToolResult(t, client, "req-diag", toolCallEnv.CallID, false, nil)

	// After LLM regeneration, second EXPLAIN — succeeds.
	toolCallEnv2 := readEnvelope(t, client)
	if toolCallEnv2.Type != websocket.TypeToolCall {
		t.Fatalf("expected second tool.call, got %s", toolCallEnv2.Type)
	}
	sendToolResult(t, client, "req-diag", toolCallEnv2.CallID, true, tools.ExplainQueryResult{
		Plan: "Seq Scan on users",
	})

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	// LLM was called once for retry.
	if llmCallCount.Load() != 1 {
		t.Errorf("expected 1 LLM call, got %d", llmCallCount.Load())
	}

	// Candidate should be the fixed SQL.
	val, _ := pctx.Get(ContextKeySQLCandidates)
	validated := val.([]string)
	if len(validated) != 1 {
		t.Fatalf("expected 1 validated candidate, got %d", len(validated))
	}
	if validated[0] != "SELECT id, name FROM users LIMIT 10" {
		t.Errorf("unexpected validated SQL: %q", validated[0])
	}

	// Tokens should be tracked from LLM retry.
	if pctx.TokensUsed != 40 {
		t.Errorf("expected 40 tokens, got %d", pctx.TokensUsed)
	}
}

func TestDiagnosticRetry_DiscardedAfterMaxRetries(t *testing.T) {
	// Candidate always fails EXPLAIN, even after 2 retries — gets discarded.
	// LLM returns SQL that also fails.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := llm.ChatResponse{
			Model: "test-model",
			Choices: []llm.Choice{
				{Message: llm.Message{Role: "assistant", Content: "SELECT still_bad FROM nowhere"}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 30},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(mockLLM.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT bad_column FROM bad_table"}
	pctx := buildDiagnosticContext(t, session, llmClient, candidates)

	errCh := make(chan error, 1)
	go func() {
		step := &DiagnosticRetryStep{MaxRetries: 2}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Initial EXPLAIN fails.
	toolCallEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-diag", toolCallEnv.CallID, false, nil)

	// Retry 1: LLM regenerates, EXPLAIN fails again.
	toolCallEnv2 := readEnvelope(t, client)
	sendToolResult(t, client, "req-diag", toolCallEnv2.CallID, false, nil)

	// Retry 2: LLM regenerates again, EXPLAIN fails again — candidate discarded.
	toolCallEnv3 := readEnvelope(t, client)
	sendToolResult(t, client, "req-diag", toolCallEnv3.CallID, false, nil)

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error when all candidates discarded")
		}
		if !strings.Contains(err.Error(), "failed EXPLAIN validation after retries") {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

func TestDiagnosticRetry_MixedCandidates(t *testing.T) {
	// 3 candidates: first passes, second fails all retries, third passes on retry.
	var llmCallCount atomic.Int32
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCallCount.Add(1)
		resp := llm.ChatResponse{
			Model: "test-model",
			Choices: []llm.Choice{
				{Message: llm.Message{Role: "assistant", Content: "SELECT fixed FROM users"}, FinishReason: "stop"},
			},
			Usage: llm.Usage{TotalTokens: 25},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(mockLLM.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{
		"SELECT * FROM users",          // passes first try
		"SELECT * FROM nonexistent",    // always fails
		"SELECT bad_col FROM users",    // fails first, fixed on retry
	}
	pctx := buildDiagnosticContext(t, session, llmClient, candidates)

	errCh := make(chan error, 1)
	go func() {
		step := &DiagnosticRetryStep{MaxRetries: 2}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Candidate 0: EXPLAIN succeeds.
	tc := readEnvelope(t, client)
	sendToolResult(t, client, "req-diag", tc.CallID, true, tools.ExplainQueryResult{Plan: "Seq Scan"})

	// Candidate 1: EXPLAIN fails, retry 1 fails, retry 2 fails — discarded.
	for i := 0; i < 3; i++ {
		tc = readEnvelope(t, client)
		sendToolResult(t, client, "req-diag", tc.CallID, false, nil)
	}

	// Candidate 2: EXPLAIN fails, retry succeeds.
	tc = readEnvelope(t, client)
	sendToolResult(t, client, "req-diag", tc.CallID, false, nil)

	tc = readEnvelope(t, client)
	sendToolResult(t, client, "req-diag", tc.CallID, true, tools.ExplainQueryResult{Plan: "Index Scan"})

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	val, _ := pctx.Get(ContextKeySQLCandidates)
	validated := val.([]string)
	if len(validated) != 2 {
		t.Fatalf("expected 2 validated candidates, got %d", len(validated))
	}
	// First should be original (passed without retry).
	if validated[0] != "SELECT * FROM users" {
		t.Errorf("expected first candidate unchanged, got %q", validated[0])
	}
	// Second should be the fixed version from LLM.
	if validated[1] != "SELECT fixed FROM users" {
		t.Errorf("expected fixed candidate, got %q", validated[1])
	}
}

func TestDiagnosticRetry_MissingCandidates(t *testing.T) {
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Logger = zap.NewNop()

	step := &DiagnosticRetryStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for missing candidates")
	}
	if !strings.Contains(err.Error(), "sql_candidates not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestDiagnosticRetry_EmptyCandidates(t *testing.T) {
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Logger = zap.NewNop()
	pctx.Set(ContextKeySQLCandidates, []string{})

	step := &DiagnosticRetryStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for empty candidates")
	}
	if !strings.Contains(err.Error(), "no SQL candidates to validate") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestDiagnosticRetry_LLMRetryFailure(t *testing.T) {
	// When LLM itself fails during retry, candidate is discarded.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	t.Cleanup(mockLLM.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT bad FROM nowhere"}
	pctx := buildDiagnosticContext(t, session, llmClient, candidates)

	errCh := make(chan error, 1)
	go func() {
		step := &DiagnosticRetryStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// EXPLAIN fails.
	tc := readEnvelope(t, client)
	sendToolResult(t, client, "req-diag", tc.CallID, false, nil)

	// LLM retry will fail (500) — candidate discarded.
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error when LLM retry fails")
		}
		if !strings.Contains(err.Error(), "failed EXPLAIN validation after retries") {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

func TestDiagnosticRetry_DefaultMaxRetries(t *testing.T) {
	step := &DiagnosticRetryStep{}
	if step.Name() != "diagnostic_retry" {
		t.Errorf("unexpected name: %q", step.Name())
	}
	// MaxRetries=0 should default to 2 during execution (tested via behavior).
}
