package steps

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// e2eLLMServer creates a mock LLM server that handles both streaming and non-streaming requests.
// Non-streaming returns SQL candidates; streaming returns explanation/aggregation.
func e2eLLMServer(t *testing.T) *httptest.Server {
	t.Helper()
	var callCount int64
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req llm.ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		if req.Stream {
			// Streaming → figure out what action is being performed by inspecting the prompt.
			prompt := ""
			for _, msg := range req.Messages {
				prompt += msg.Content + " "
			}

			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)

			if strings.Contains(prompt, "EXPLAIN") || strings.Contains(prompt, "explain") ||
				strings.Contains(prompt, "объясни") || strings.Contains(prompt, "Explain this SQL") {
				// explain_sql or improve_sql streaming
				fmt.Fprintf(w, "data: %s\n\n", makeStreamChunkJSON("This query "))
				fmt.Fprintf(w, "data: %s\n\n", makeStreamChunkJSON("performs a "))
				fmt.Fprintf(w, "data: %s\n\n", makeStreamChunkWithUsage("scan.\\n\\n```sql\\nSELECT u.id FROM users u LIMIT 50\\n```", 30, 20, 50))
			} else if strings.Contains(prompt, "analyze") || strings.Contains(prompt, "schema") && strings.Contains(prompt, "overview") {
				// analyze_schema streaming
				fmt.Fprintf(w, "data: %s\n\n", makeStreamChunkJSON("Schema has "))
				fmt.Fprintf(w, "data: %s\n\n", makeStreamChunkWithUsage("3 tables with FK relationships.", 40, 25, 65))
			} else {
				// generate_sql aggregation streaming
				fmt.Fprintf(w, "data: %s\n\n", makeStreamChunkJSON("Best candidate selected. "))
				fmt.Fprintf(w, "data: %s\n\n", makeStreamChunkWithUsage("```sql\\nSELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY COUNT(o.id) DESC LIMIT 10\\n```", 100, 50, 150))
			}

			fmt.Fprint(w, "data: [DONE]\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return
		}

		// Non-streaming → SQL generation or table selection.
		n := atomic.AddInt64(&callCount, 1)
		content := fmt.Sprintf("SELECT u.name FROM users u LIMIT 10 /* v%d */", n)

		// Check if this is a table selection request (schema grounding).
		prompt := ""
		for _, msg := range req.Messages {
			prompt += msg.Content + " "
		}
		if strings.Contains(prompt, "relevant tables") || strings.Contains(prompt, "Which tables") {
			content = `["users", "orders"]`
		}

		resp := llm.ChatResponse{
			ID:    "chatcmpl-test",
			Model: "test-model",
			Choices: []llm.Choice{{
				Index:        0,
				Message:      llm.Message{Role: "assistant", Content: content},
				FinishReason: "stop",
			}},
			Usage: llm.Usage{PromptTokens: 50, CompletionTokens: 10, TotalTokens: 60},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

// e2eToolHandler responds to all tool.call messages with realistic test data.
func e2eToolHandler(toolName string, args json.RawMessage) (any, bool) {
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
		return map[string]any{
			"functions": []any{},
		}, true
	default:
		return map[string]string{"error": "unknown tool"}, false
	}
}

// buildE2EPipeline creates a pipeline with all 4 actions registered, matching router.go.
func buildE2EPipeline(t *testing.T, llmClient *llm.Client) *agent.Pipeline {
	t.Helper()
	pipeline := agent.NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")
	pipeline.RegisterAction(agent.ActionExplainSQL, &ExplainSQLStep{})
	pipeline.RegisterAction(agent.ActionImproveSQL, &ImproveSQLStep{})
	pipeline.RegisterAction(agent.ActionAnalyzeSchema, &AnalyzeSchemaStep{})
	pipeline.RegisterAction(agent.ActionGenerateSQL,
		&SchemaGroundingStep{},
		&ParallelSQLGenerationStep{},
		&DiagnosticRetryStep{},
		&SeedExpansionStep{},
		&ResultAggregationStep{},
	)
	return pipeline
}

// TestE2E_AllFourActions tests the full cycle for all 4 actions through a single pipeline.
// This mirrors the real deployment: one pipeline, one session, 4 sequential actions.
func TestE2E_AllFourActions(t *testing.T) {
	mockLLM := e2eLLMServer(t)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pipeline := buildE2EPipeline(t, llmClient)

	t.Run("generate_sql", func(t *testing.T) {
		testE2EGenerateSQL(t, pipeline, session, client)
	})

	t.Run("explain_sql", func(t *testing.T) {
		testE2EExplainSQL(t, pipeline, session, client)
	})

	t.Run("improve_sql", func(t *testing.T) {
		testE2EImproveSQL(t, pipeline, session, client)
	})

	t.Run("analyze_schema", func(t *testing.T) {
		testE2EAnalyzeSchema(t, pipeline, session, client)
	})
}

func testE2EGenerateSQL(t *testing.T, pipeline *agent.Pipeline, session *websocket.Session, client *ws.Conn) {
	t.Helper()

	reqPayload := websocket.AgentRequestPayload{
		Action:      "generate_sql",
		UserMessage: "show top 10 users by order count",
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-e2e-generate", "", reqPayload)
	if err != nil {
		t.Fatal(err)
	}

	go pipeline.HandleMessage(session, env)

	// Handle tool calls + collect streams + get response.
	streams, resp := handleToolCalls(t, client, e2eToolHandler, 30*time.Second)

	// Verify streaming.
	if len(streams) == 0 {
		t.Error("expected agent.stream messages for generate_sql")
	}

	// Verify response.
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	var rp websocket.AgentResponsePayload
	if err := resp.DecodePayload(&rp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rp.Action != "generate_sql" {
		t.Errorf("expected action=generate_sql, got %q", rp.Action)
	}
	if rp.Result.SQL == "" {
		t.Error("expected non-empty SQL in generate_sql response")
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation in generate_sql response")
	}
	if len(rp.Result.Candidates) == 0 {
		t.Error("expected candidates in generate_sql response")
	}
	if len(rp.ToolCallsLog) < 4 {
		t.Errorf("expected at least 4 tool call log entries, got %d", len(rp.ToolCallsLog))
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("generate_sql: SQL=%q, candidates=%d, tokens=%d, tool_calls=%d",
		rp.Result.SQL, len(rp.Result.Candidates), rp.TokensUsed, len(rp.ToolCallsLog))
}

func testE2EExplainSQL(t *testing.T, pipeline *agent.Pipeline, session *websocket.Session, client *ws.Conn) {
	t.Helper()

	reqPayload := websocket.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocket.AgentRequestContext{
			SelectedSQL: "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name",
		},
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-e2e-explain", "", reqPayload)
	if err != nil {
		t.Fatal(err)
	}

	go pipeline.HandleMessage(session, env)

	// explain_sql has no tool calls, just streaming + response.
	streams, resp := handleToolCalls(t, client, e2eToolHandler, 30*time.Second)

	if len(streams) == 0 {
		t.Error("expected agent.stream messages for explain_sql")
	}

	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	var rp websocket.AgentResponsePayload
	if err := resp.DecodePayload(&rp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rp.Action != "explain_sql" {
		t.Errorf("expected action=explain_sql, got %q", rp.Action)
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation in explain_sql response")
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("explain_sql: explanation=%q, tokens=%d", rp.Result.Explanation, rp.TokensUsed)
}

func testE2EImproveSQL(t *testing.T, pipeline *agent.Pipeline, session *websocket.Session, client *ws.Conn) {
	t.Helper()

	reqPayload := websocket.AgentRequestPayload{
		Action: "improve_sql",
		Context: &websocket.AgentRequestContext{
			SelectedSQL: "SELECT * FROM users JOIN orders ON users.id = orders.user_id",
		},
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-e2e-improve", "", reqPayload)
	if err != nil {
		t.Fatal(err)
	}

	go pipeline.HandleMessage(session, env)

	// improve_sql dispatches explain_query tool, then streams LLM response.
	streams, resp := handleToolCalls(t, client, e2eToolHandler, 30*time.Second)

	if len(streams) == 0 {
		t.Error("expected agent.stream messages for improve_sql")
	}

	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	var rp websocket.AgentResponsePayload
	if err := resp.DecodePayload(&rp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rp.Action != "improve_sql" {
		t.Errorf("expected action=improve_sql, got %q", rp.Action)
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation in improve_sql response")
	}
	// improve_sql should have at least 1 tool call log (explain_query).
	if len(rp.ToolCallsLog) < 1 {
		t.Errorf("expected at least 1 tool call log entry for improve_sql, got %d", len(rp.ToolCallsLog))
	}
	// Verify explain_query was called.
	foundExplain := false
	for _, tc := range rp.ToolCallsLog {
		if tc.ToolName == "explain_query" {
			foundExplain = true
			break
		}
	}
	if !foundExplain {
		t.Error("expected explain_query in tool_calls_log for improve_sql")
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("improve_sql: explanation=%q, sql=%q, tokens=%d, tool_calls=%d",
		rp.Result.Explanation, rp.Result.SQL, rp.TokensUsed, len(rp.ToolCallsLog))
}

func testE2EAnalyzeSchema(t *testing.T, pipeline *agent.Pipeline, session *websocket.Session, client *ws.Conn) {
	t.Helper()

	reqPayload := websocket.AgentRequestPayload{
		Action: "analyze_schema",
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-e2e-analyze", "", reqPayload)
	if err != nil {
		t.Fatal(err)
	}

	go pipeline.HandleMessage(session, env)

	// analyze_schema dispatches list_schemas, list_tables, describe_table, then streams LLM.
	streams, resp := handleToolCalls(t, client, e2eToolHandler, 30*time.Second)

	if len(streams) == 0 {
		t.Error("expected agent.stream messages for analyze_schema")
	}

	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	var rp websocket.AgentResponsePayload
	if err := resp.DecodePayload(&rp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rp.Action != "analyze_schema" {
		t.Errorf("expected action=analyze_schema, got %q", rp.Action)
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation in analyze_schema response")
	}
	// analyze_schema should have tool calls: list_schemas + list_tables + describe_table * N.
	if len(rp.ToolCallsLog) < 3 {
		t.Errorf("expected at least 3 tool call log entries for analyze_schema, got %d", len(rp.ToolCallsLog))
	}
	// Verify expected tool sequence.
	expectedTools := map[string]bool{"list_schemas": false, "list_tables": false, "describe_table": false}
	for _, tc := range rp.ToolCallsLog {
		expectedTools[tc.ToolName] = true
	}
	for tool, found := range expectedTools {
		if !found {
			t.Errorf("expected %s in tool_calls_log for analyze_schema", tool)
		}
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("analyze_schema: explanation=%q, tokens=%d, tool_calls=%d",
		rp.Result.Explanation, rp.TokensUsed, len(rp.ToolCallsLog))
}

// TestE2E_SequentialActions verifies that multiple actions can run sequentially
// on the same session without interference (state isolation between requests).
func TestE2E_SequentialActions(t *testing.T) {
	mockLLM := e2eLLMServer(t)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pipeline := buildE2EPipeline(t, llmClient)

	// Run explain_sql first, then improve_sql — verify no cross-contamination.
	actions := []struct {
		action    string
		payload   websocket.AgentRequestPayload
		requestID string
	}{
		{
			action: "explain_sql",
			payload: websocket.AgentRequestPayload{
				Action: "explain_sql",
				Context: &websocket.AgentRequestContext{
					SelectedSQL: "SELECT 1",
				},
			},
			requestID: "req-seq-1",
		},
		{
			action: "improve_sql",
			payload: websocket.AgentRequestPayload{
				Action: "improve_sql",
				Context: &websocket.AgentRequestContext{
					SelectedSQL: "SELECT * FROM users",
				},
			},
			requestID: "req-seq-2",
		},
	}

	for _, a := range actions {
		env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, a.requestID, "", a.payload)
		if err != nil {
			t.Fatal(err)
		}

		go pipeline.HandleMessage(session, env)

		_, resp := handleToolCalls(t, client, e2eToolHandler, 30*time.Second)
		if resp.Type != websocket.TypeAgentResponse {
			t.Fatalf("%s: expected agent.response, got %s", a.action, resp.Type)
		}

		var rp websocket.AgentResponsePayload
		resp.DecodePayload(&rp)
		if rp.Action != a.action {
			t.Errorf("expected action=%s, got %s", a.action, rp.Action)
		}
		if rp.Result.Explanation == "" {
			t.Errorf("%s: expected non-empty explanation", a.action)
		}
	}
}
