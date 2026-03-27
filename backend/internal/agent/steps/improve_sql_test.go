package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

func buildImproveSQLContext(t *testing.T, session *websocket.Session, llmClient *llm.Client, sql string) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-improve"
	pctx.Action = "improve_sql"
	pctx.SelectedSQL = sql
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()
	return pctx
}

func TestImproveSQL_Success(t *testing.T) {
	// LLM returns improvement explanation + improved SQL.
	llmResponse := "1. Added index hint\n2. Optimized JOIN order\n\n```sql\nSELECT u.id, u.name FROM users u INNER JOIN orders o ON u.id = o.user_id LIMIT 100\n```"
	chunks := []string{
		makeStreamChunkJSON("1. Added index hint\\n"),
		makeStreamChunkJSON("2. Optimized JOIN order\\n\\n```sql\\n"),
		makeStreamChunkWithUsage("SELECT u.id, u.name FROM users u INNER JOIN orders o ON u.id = o.user_id LIMIT 100\\n```", 30, 20, 50),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildImproveSQLContext(t, session, llmClient, "SELECT * FROM users JOIN orders ON users.id = orders.user_id")

	errCh := make(chan error, 1)
	go func() {
		step := &ImproveSQLStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Step 0: schema context gathering calls list_schemas first.
	schemasEnv := readEnvelope(t, client)
	if schemasEnv.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call for list_schemas, got %s", schemasEnv.Type)
	}
	var schemasPayload websocket.ToolCallPayload
	schemasEnv.DecodePayload(&schemasPayload)
	if schemasPayload.ToolName != "list_schemas" {
		t.Fatalf("expected list_schemas, got %s", schemasPayload.ToolName)
	}
	sendToolResult(t, client, "req-improve", schemasEnv.CallID, true, []string{"public"})

	// Read tool.call for explain_query.
	toolCallEnv := readEnvelope(t, client)
	if toolCallEnv.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", toolCallEnv.Type)
	}
	var toolPayload websocket.ToolCallPayload
	toolCallEnv.DecodePayload(&toolPayload)
	if toolPayload.ToolName != "explain_query" {
		t.Fatalf("expected explain_query tool, got %s", toolPayload.ToolName)
	}

	// Send tool.result with query plan.
	sendToolResult(t, client, "req-improve", toolCallEnv.CallID, true, tools.ExplainQueryResult{
		Plan: "Seq Scan on users  (cost=0.00..1.05 rows=5 width=68)",
	})

	// Read 3 agent.stream messages.
	for i := 0; i < 3; i++ {
		env := readEnvelope(t, client)
		if env.Type != websocket.TypeAgentStream {
			t.Fatalf("chunk %d: expected agent.stream, got %s", i, env.Type)
		}
		if env.RequestID != "req-improve" {
			t.Fatalf("chunk %d: expected request_id=req-improve, got %s", i, env.RequestID)
		}
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	// Verify explanation is set.
	if pctx.Result.Explanation == "" {
		t.Error("expected non-empty explanation")
	}

	// Verify tokens tracked.
	if pctx.TokensUsed != 50 {
		t.Errorf("expected 50 tokens, got %d", pctx.TokensUsed)
	}

	// Verify model tracked.
	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model test-model, got %s", pctx.ModelUsed)
	}

	// Verify tool calls logged: list_schemas + explain_query = 2.
	if len(pctx.ToolCallsLog) != 2 {
		t.Fatalf("expected 2 tool call log entries, got %d", len(pctx.ToolCallsLog))
	}
	if pctx.ToolCallsLog[1].ToolName != "explain_query" {
		t.Errorf("expected explain_query in log at index 1, got %s", pctx.ToolCallsLog[1].ToolName)
	}

	_ = llmResponse // used for documentation
}

func TestImproveSQL_MissingSelectedSQL(t *testing.T) {
	llmClient := llm.NewClient("test-key")
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Action = "improve_sql"
	pctx.SelectedSQL = ""
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	step := &ImproveSQLStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for missing selected_sql")
	}
	if !strings.Contains(err.Error(), "selected_sql is required") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestImproveSQL_ExplainToolFailure_StillSendsToLLM(t *testing.T) {
	// Even if explain_query returns an error, we should still send SQL to LLM.
	chunks := []string{
		makeStreamChunkWithUsage("The query looks fine as-is.", 15, 10, 25),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildImproveSQLContext(t, session, llmClient, "SELECT 1")

	errCh := make(chan error, 1)
	go func() {
		step := &ImproveSQLStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Step 0: Respond to list_schemas.
	schemasEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-improve", schemasEnv.CallID, true, []string{"public"})

	// Read tool.call for explain_query.
	toolCallEnv := readEnvelope(t, client)
	if toolCallEnv.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", toolCallEnv.Type)
	}

	// Send tool.result with error.
	sendToolResult(t, client, "req-improve", toolCallEnv.CallID, false, nil)

	// Read 1 agent.stream message.
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", env.Type)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	if pctx.Result.Explanation != "The query looks fine as-is." {
		t.Errorf("unexpected explanation: %q", pctx.Result.Explanation)
	}
}

func TestImproveSQL_LLMError(t *testing.T) {
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildImproveSQLContext(t, session, llmClient, "SELECT * FROM users")

	errCh := make(chan error, 1)
	go func() {
		step := &ImproveSQLStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Step 0: Respond to list_schemas.
	schemasEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-improve", schemasEnv.CallID, true, []string{"public"})

	// Read and respond to tool.call for explain_query.
	toolCallEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-improve", toolCallEnv.CallID, true, tools.ExplainQueryResult{
		Plan: "Seq Scan on users",
	})

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error from LLM")
		}
		if !strings.Contains(err.Error(), "LLM improve_sql failed") {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

func TestImproveSQL_IntegrationWithPipeline(t *testing.T) {
	chunks := []string{
		makeStreamChunkJSON("Improvements:\\n"),
		makeStreamChunkWithUsage("```sql\\nSELECT id FROM users\\n```", 10, 5, 15),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	registry := tools.NewRegistry()

	p := agent.NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction(agent.ActionImproveSQL, &ImproveSQLStep{})

	reqPayload := websocket.AgentRequestPayload{
		Action: "improve_sql",
		Context: &websocket.AgentRequestContext{
			SelectedSQL: "SELECT * FROM users",
		},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-pipe", "", reqPayload)

	go p.HandleMessage(session, env)

	// Step 0: Respond to list_schemas.
	schemasEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-pipe", schemasEnv.CallID, true, []string{"public"})

	// Read tool.call for explain_query.
	toolCallEnv := readEnvelope(t, client)
	if toolCallEnv.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", toolCallEnv.Type)
	}

	// Send tool.result.
	sendToolResult(t, client, "req-pipe", toolCallEnv.CallID, true, tools.ExplainQueryResult{
		Plan: "Seq Scan on users  (cost=0.00..1.05 rows=5 width=68)",
	})

	// Read 2 agent.stream chunks.
	for i := 0; i < 2; i++ {
		streamEnv := readEnvelope(t, client)
		if streamEnv.Type != websocket.TypeAgentStream {
			t.Fatalf("chunk %d: expected agent.stream, got %s", i, streamEnv.Type)
		}
	}

	// Read agent.response.
	respEnv := readEnvelope(t, client)
	if respEnv.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", respEnv.Type)
	}

	var respPayload websocket.AgentResponsePayload
	respEnv.DecodePayload(&respPayload)
	if respPayload.Action != "improve_sql" {
		t.Errorf("expected action=improve_sql, got %q", respPayload.Action)
	}
	if respPayload.Result.Explanation == "" {
		t.Error("expected non-empty explanation")
	}
	if respPayload.TokensUsed != 15 {
		t.Errorf("expected tokens=15, got %d", respPayload.TokensUsed)
	}
	if respPayload.ModelUsed != "test-model" {
		t.Errorf("expected model=test-model, got %q", respPayload.ModelUsed)
	}
	// Verify tool call log: list_schemas + explain_query = 2.
	if len(respPayload.ToolCallsLog) != 2 {
		t.Fatalf("expected 2 tool call log entries, got %d", len(respPayload.ToolCallsLog))
	}
	if respPayload.ToolCallsLog[1].ToolName != "explain_query" {
		t.Errorf("expected explain_query in tool_calls_log at index 1, got %s", respPayload.ToolCallsLog[1].ToolName)
	}
}

func TestImproveSQL_CustomModel(t *testing.T) {
	chunks := []string{
		makeStreamChunkWithUsage("Optimized.", 10, 5, 15),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildImproveSQLContext(t, session, llmClient, "SELECT COUNT(*) FROM orders")
	pctx.Model = "anthropic/claude-3-haiku"

	errCh := make(chan error, 1)
	go func() {
		step := &ImproveSQLStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Step 0: Respond to list_schemas.
	schemasEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-improve", schemasEnv.CallID, true, []string{"public"})

	// Respond to tool.call for explain_query.
	toolCallEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-improve", toolCallEnv.CallID, true, tools.ExplainQueryResult{
		Plan: "Aggregate  (cost=1.05..1.06 rows=1 width=8)",
	})

	// Read agent.stream.
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", env.Type)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	if pctx.Result.Explanation != "Optimized." {
		t.Errorf("unexpected explanation: %q", pctx.Result.Explanation)
	}
}

func TestExtractSQLFromResponse(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "single sql block",
			content: "Here is the improved query:\n```sql\nSELECT id FROM users\n```",
			want:    "SELECT id FROM users",
		},
		{
			name:    "multiple sql blocks returns last",
			content: "Original:\n```sql\nSELECT * FROM users\n```\nImproved:\n```sql\nSELECT id, name FROM users\n```",
			want:    "SELECT id, name FROM users",
		},
		{
			name:    "no sql block",
			content: "The query is already optimal.",
			want:    "",
		},
		{
			name:    "sql with trailing semicolon",
			content: "```sql\nSELECT 1;\n```",
			want:    "SELECT 1",
		},
		{
			name:    "unclosed block",
			content: "```sql\nSELECT 1",
			want:    "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractSQLFromResponse(tt.content)
			if got != tt.want {
				t.Errorf("extractSQLFromResponse() = %q, want %q", got, tt.want)
			}
		})
	}
}

// Verify explain_query args are marshaled correctly.
func TestImproveSQL_ExplainQueryArgs(t *testing.T) {
	chunks := []string{
		makeStreamChunkWithUsage("Done.", 5, 5, 10),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	testSQL := "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name"
	pctx := buildImproveSQLContext(t, session, llmClient, testSQL)

	errCh := make(chan error, 1)
	go func() {
		step := &ImproveSQLStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Step 0: Respond to list_schemas.
	schemasEnv := readEnvelope(t, client)
	sendToolResult(t, client, "req-improve", schemasEnv.CallID, true, []string{"public"})

	// Read tool.call and verify the SQL argument.
	toolCallEnv := readEnvelope(t, client)
	var toolPayload websocket.ToolCallPayload
	toolCallEnv.DecodePayload(&toolPayload)

	var args map[string]string
	if err := json.Unmarshal(toolPayload.Arguments, &args); err != nil {
		t.Fatalf("unmarshal args: %v", err)
	}
	if args["sql"] != testSQL {
		t.Errorf("expected sql=%q, got %q", testSQL, args["sql"])
	}

	// Respond and let it finish.
	sendToolResult(t, client, "req-improve", toolCallEnv.CallID, true, tools.ExplainQueryResult{
		Plan: "Hash Join",
	})

	// Drain stream messages.
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", env.Type)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

// Suppress unused import warnings.
var _ = fmt.Sprintf
