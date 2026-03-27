package steps

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
	"go.uber.org/zap"
)

// buildSQLGenContext creates a PipelineContext with schema context already set (simulating step 1 done).
func buildSQLGenContext(t *testing.T, llmClient *llm.Client) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-sqlgen"
	pctx.Action = "generate_sql"
	pctx.UserMessage = "покажи топ 10 пользователей по количеству заказов"
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()

	// Simulate schema_grounding output.
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

func TestSQLGeneration_Success(t *testing.T) {
	expectedSQL := "SELECT u.name, COUNT(o.id) AS order_count FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY order_count DESC LIMIT 10"
	llmSrv := newMockLLMServer(t, expectedSQL)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))

	pctx := buildSQLGenContext(t, llmClient)
	step := &SQLGenerationStep{}

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	// Verify SQL stored in result.
	if pctx.Result.SQL != expectedSQL {
		t.Errorf("expected SQL %q, got %q", expectedSQL, pctx.Result.SQL)
	}

	// Verify SQL stored in context for downstream steps.
	val, ok := pctx.Get(ContextKeySQLCandidate)
	if !ok {
		t.Fatal("sql_candidate not stored in pipeline context")
	}
	if val.(string) != expectedSQL {
		t.Errorf("context SQL mismatch: got %q", val.(string))
	}

	// Verify tokens tracked.
	if pctx.TokensUsed != 60 {
		t.Errorf("expected 60 tokens, got %d", pctx.TokensUsed)
	}

	// Verify model tracked.
	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model test-model, got %s", pctx.ModelUsed)
	}
}

func TestSQLGeneration_StripCodeFences(t *testing.T) {
	// LLM wraps SQL in markdown code fences.
	llmSrv := newMockLLMServer(t, "```sql\nSELECT * FROM users LIMIT 10\n```")
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))

	pctx := buildSQLGenContext(t, llmClient)
	step := &SQLGenerationStep{}

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.SQL != "SELECT * FROM users LIMIT 10" {
		t.Errorf("code fences not stripped: got %q", pctx.Result.SQL)
	}
}

func TestSQLGeneration_StripTrailingSemicolon(t *testing.T) {
	llmSrv := newMockLLMServer(t, "SELECT * FROM users;")
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))

	pctx := buildSQLGenContext(t, llmClient)
	step := &SQLGenerationStep{}

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if strings.HasSuffix(pctx.Result.SQL, ";") {
		t.Errorf("trailing semicolon not stripped: got %q", pctx.Result.SQL)
	}
	if pctx.Result.SQL != "SELECT * FROM users" {
		t.Errorf("unexpected SQL: got %q", pctx.Result.SQL)
	}
}

func TestSQLGeneration_MissingSchemaContext(t *testing.T) {
	llmClient := llm.NewClient("test-key")
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.UserMessage = "test"
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()
	// Deliberately NOT setting schema_context.

	step := &SQLGenerationStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for missing schema context")
	}
	if !strings.Contains(err.Error(), "schema_context not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestSQLGeneration_LLMError(t *testing.T) {
	// LLM server that's unreachable.
	llmClient := llm.NewClient("test-key", llm.WithBaseURL("http://localhost:1"))

	pctx := buildSQLGenContext(t, llmClient)
	step := &SQLGenerationStep{}

	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for LLM failure")
	}
	if !strings.Contains(err.Error(), "LLM sql generation failed") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestSQLGeneration_EmptyLLMResponse(t *testing.T) {
	// LLM returns empty content.
	llmSrv := newMockLLMServer(t, "")
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))

	pctx := buildSQLGenContext(t, llmClient)
	step := &SQLGenerationStep{}

	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for empty SQL")
	}
	if !strings.Contains(err.Error(), "LLM returned empty SQL") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestSQLGeneration_CustomModel(t *testing.T) {
	llmSrv := newMockLLMServer(t, "SELECT 1")
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))

	pctx := buildSQLGenContext(t, llmClient)
	pctx.Model = "anthropic/claude-3-haiku"
	step := &SQLGenerationStep{}

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.SQL != "SELECT 1" {
		t.Errorf("unexpected SQL: %q", pctx.Result.SQL)
	}
}

func TestSQLGeneration_IntegrationWithSchemaGrounding(t *testing.T) {
	// Full integration: schema_grounding feeds into sql_generation.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	// LLM returns SQL for the generation step.
	llmSrv := newMockLLMServer(t, "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name")
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))
	pctx := buildPipelineContext(t, session, llmClient)

	errCh := make(chan error, 1)
	go func() {
		// Run both steps sequentially.
		step1 := &SchemaGroundingStep{}
		if err := step1.Execute(context.Background(), pctx); err != nil {
			errCh <- err
			return
		}
		step2 := &SQLGenerationStep{}
		errCh <- step2.Execute(context.Background(), pctx)
	}()

	// Step 1: Respond to list_schemas.
	schemasEnv := readEnvelope(t, client)
	sendToolResult(t, client, schemasEnv.RequestID, schemasEnv.CallID, true, []string{"public"})

	// Step 2: Respond to list_tables.
	env := readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"users", "orders"})

	// Step 3: Respond to describe_table for each table.
	for i := 0; i < 2; i++ {
		desc := readEnvelope(t, client)
		sendToolResult(t, client, desc.RequestID, desc.CallID, true,
			map[string]any{"columns": []string{"id", "name"}})
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("pipeline failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	// Verify both steps produced results.
	if _, ok := pctx.Get(ContextKeySchemaContext); !ok {
		t.Error("schema_context not set")
	}
	if _, ok := pctx.Get(ContextKeySQLCandidate); !ok {
		t.Error("sql_candidate not set")
	}
	if pctx.Result.SQL == "" {
		t.Error("result SQL is empty")
	}
}

func TestBuildSchemaDescription(t *testing.T) {
	sc := &SchemaContext{
		Tables: []TableInfo{
			{
				Schema:  "public",
				Table:   "users",
				Details: json.RawMessage(`{"columns":["id","name"],"indexes":["idx_users_name"]}`),
			},
		},
	}

	desc := buildSchemaDescription(sc)
	if !strings.Contains(desc, "Table: public.users") {
		t.Error("missing table header")
	}
	if !strings.Contains(desc, "Columns:") {
		t.Error("missing columns section")
	}
	if !strings.Contains(desc, "Indexes:") {
		t.Error("missing indexes section")
	}
}

func TestBuildSchemaDescription_InvalidJSON(t *testing.T) {
	sc := &SchemaContext{
		Tables: []TableInfo{
			{
				Schema:  "public",
				Table:   "users",
				Details: json.RawMessage(`not valid json`),
			},
		},
	}

	desc := buildSchemaDescription(sc)
	if !strings.Contains(desc, "Details: not valid json") {
		t.Errorf("expected raw details fallback, got: %s", desc)
	}
}
