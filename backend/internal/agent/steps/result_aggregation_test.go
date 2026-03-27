package steps

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

func buildAggregationContext(t *testing.T, session *websocket.Session, llmClient *llm.Client, candidates []string) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-agg"
	pctx.Action = "generate_sql"
	pctx.UserMessage = "show top 10 users by orders"
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()
	pctx.Set(ContextKeySQLCandidates, candidates)
	return pctx
}

func TestResultAggregation_Success(t *testing.T) {
	// 3 candidates, LLM returns explanation + chosen SQL in code block (non-streaming).
	responseContent := "Candidate 2 is the best because it uses a proper JOIN.\n\n```sql\nSELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY COUNT(o.id) DESC LIMIT 10\n```"

	mockLLM := newMockLLMServer(t, responseContent)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{
		"SELECT * FROM users LIMIT 10",
		"SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY COUNT(o.id) DESC LIMIT 10",
		"WITH user_orders AS (SELECT user_id, COUNT(*) as cnt FROM orders GROUP BY user_id) SELECT u.name, uo.cnt FROM users u JOIN user_orders uo ON u.id = uo.user_id ORDER BY uo.cnt DESC LIMIT 10",
	}
	pctx := buildAggregationContext(t, session, llmClient, candidates)

	step := &ResultAggregationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	// Verify explanation stored.
	if pctx.Result.Explanation != responseContent {
		t.Errorf("unexpected explanation: %q", pctx.Result.Explanation)
	}

	// Verify chosen SQL extracted from code block.
	expectedSQL := "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY COUNT(o.id) DESC LIMIT 10"
	if pctx.Result.SQL != expectedSQL {
		t.Errorf("expected SQL %q, got %q", expectedSQL, pctx.Result.SQL)
	}

	// Verify all candidates preserved.
	if len(pctx.Result.Candidates) != 3 {
		t.Errorf("expected 3 candidates, got %d", len(pctx.Result.Candidates))
	}

	// Verify tokens tracked.
	if pctx.TokensUsed != 60 {
		t.Errorf("expected 60 tokens, got %d", pctx.TokensUsed)
	}

	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model test-model, got %q", pctx.ModelUsed)
	}
}

func TestResultAggregation_SingleCandidate_SkipsLLM(t *testing.T) {
	// 1 candidate — no LLM call, returns immediately.
	llmClient := llm.NewClient("test-key") // LLM should not be called
	candidates := []string{"SELECT * FROM users LIMIT 10"}
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-agg-single"
	pctx.UserMessage = "show users"
	pctx.Logger = zap.NewNop()
	pctx.Set(ContextKeySQLCandidates, candidates)
	pctx.LLMClient = llmClient

	step := &ResultAggregationStep{}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.SQL != "SELECT * FROM users LIMIT 10" {
		t.Errorf("expected first candidate as SQL, got %q", pctx.Result.SQL)
	}
	if len(pctx.Result.Candidates) != 1 {
		t.Errorf("expected 1 candidate, got %d", len(pctx.Result.Candidates))
	}
	if pctx.Result.Explanation != "Only one candidate was generated." {
		t.Errorf("unexpected explanation: %q", pctx.Result.Explanation)
	}
}

func TestResultAggregation_MissingCandidates(t *testing.T) {
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Logger = zap.NewNop()

	step := &ResultAggregationStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for missing candidates")
	}
	if !strings.Contains(err.Error(), "sql_candidates not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestResultAggregation_EmptyCandidates(t *testing.T) {
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Logger = zap.NewNop()
	pctx.Set(ContextKeySQLCandidates, []string{})

	step := &ResultAggregationStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for empty candidates")
	}
	if !strings.Contains(err.Error(), "no SQL candidates") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestResultAggregation_LLMError(t *testing.T) {
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users", "SELECT name FROM users"}
	pctx := buildAggregationContext(t, session, llmClient, candidates)

	step := &ResultAggregationStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error from LLM")
	}
	if !strings.Contains(err.Error(), "LLM result aggregation failed") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestResultAggregation_NoSQLBlock_FallsBackToFirstCandidate(t *testing.T) {
	// LLM response without ```sql block — should fall back to first candidate.
	mockLLM := newMockLLMServer(t, "Candidate 1 is best because it is simple and correct.")
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users LIMIT 10", "SELECT name FROM users"}
	pctx := buildAggregationContext(t, session, llmClient, candidates)

	step := &ResultAggregationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	// Should fallback to first candidate.
	if pctx.Result.SQL != "SELECT * FROM users LIMIT 10" {
		t.Errorf("expected fallback to first candidate, got %q", pctx.Result.SQL)
	}
}

func TestResultAggregation_Name(t *testing.T) {
	step := &ResultAggregationStep{}
	if step.Name() != "result_aggregation" {
		t.Errorf("unexpected name: %q", step.Name())
	}
}

func TestResultAggregation_CustomModel(t *testing.T) {
	mockLLM := newMockLLMServer(t, "Best is candidate 1.\n```sql\nSELECT * FROM users\n```")
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	candidates := []string{"SELECT * FROM users", "SELECT name FROM users"}
	pctx := buildAggregationContext(t, session, llmClient, candidates)
	pctx.Model = "anthropic/claude-3-haiku"

	step := &ResultAggregationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.SQL != "SELECT * FROM users" {
		t.Errorf("expected extracted SQL, got %q", pctx.Result.SQL)
	}
}

func TestExtractLastSQLBlock(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "single sql block",
			content: "Here is the SQL:\n```sql\nSELECT * FROM users\n```",
			want:    "SELECT * FROM users",
		},
		{
			name:    "multiple sql blocks picks last",
			content: "Bad:\n```sql\nSELECT 1\n```\nBetter:\n```sql\nSELECT * FROM users LIMIT 10\n```",
			want:    "SELECT * FROM users LIMIT 10",
		},
		{
			name:    "strips semicolon",
			content: "```sql\nSELECT * FROM users;\n```",
			want:    "SELECT * FROM users",
		},
		{
			name:    "no sql block",
			content: "The best candidate is number 2.",
			want:    "",
		},
		{
			name:    "SQL uppercase tag",
			content: "```SQL\nSELECT name FROM users\n```",
			want:    "SELECT name FROM users",
		},
		{
			name:    "unclosed block",
			content: "```sql\nSELECT * FROM users",
			want:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractLastSQLBlock(tt.content)
			if got != tt.want {
				t.Errorf("extractLastSQLBlock() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuildAggregationPrompt(t *testing.T) {
	candidates := []string{"SELECT * FROM users", "SELECT name FROM users"}
	prompt := buildAggregationPrompt(candidates, "show users")

	if !strings.Contains(prompt, "show users") {
		t.Error("prompt should contain user message")
	}
	if !strings.Contains(prompt, "Candidate 1") {
		t.Error("prompt should contain Candidate 1")
	}
	if !strings.Contains(prompt, "Candidate 2") {
		t.Error("prompt should contain Candidate 2")
	}
	if !strings.Contains(prompt, "SELECT * FROM users") {
		t.Error("prompt should contain first candidate SQL")
	}
	if !strings.Contains(prompt, "```sql code block") {
		t.Error("prompt should instruct to output SQL in code block")
	}
}

// Verify that unused import json is not included — just make sure the file compiles.
var _ = json.Marshal
