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

// multiModeLLMServer creates a mock LLM server that handles both streaming and
// non-streaming requests. Non-streaming returns SQL candidates; streaming returns
// an aggregation response with a chosen SQL in a code block.
func multiModeLLMServer(t *testing.T, candidateSQL string, aggregationChunks []string) *httptest.Server {
	t.Helper()
	var callCount int64
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req llm.ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		if req.Stream {
			// Streaming request → result aggregation step.
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			for _, chunk := range aggregationChunks {
				fmt.Fprintf(w, "data: %s\n\n", chunk)
			}
			fmt.Fprint(w, "data: [DONE]\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return
		}

		// Non-streaming → parallel SQL generation or diagnostic retry.
		n := atomic.AddInt64(&callCount, 1)
		sql := fmt.Sprintf("%s /* v%d */", candidateSQL, n)
		resp := llm.ChatResponse{
			ID:    "chatcmpl-test",
			Model: "test-model",
			Choices: []llm.Choice{{
				Index:        0,
				Message:      llm.Message{Role: "assistant", Content: sql},
				FinishReason: "stop",
			}},
			Usage: llm.Usage{PromptTokens: 50, CompletionTokens: 10, TotalTokens: 60},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

// handleToolCalls reads messages from client WebSocket, responds to tool.call
// messages with the provided handler, collects agent.stream deltas, and returns
// the final agent.response envelope.
func handleToolCalls(
	t *testing.T,
	client *ws.Conn,
	toolHandler func(toolName string, args json.RawMessage) (any, bool),
	timeout time.Duration,
) (streams []string, response *websocket.Envelope) {
	t.Helper()
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		client.SetReadDeadline(deadline)
		_, msg, err := client.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		env, err := websocket.ParseEnvelope(msg)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}

		switch env.Type {
		case websocket.TypeToolCall:
			var tc websocket.ToolCallPayload
			env.DecodePayload(&tc)
			data, success := toolHandler(tc.ToolName, tc.Arguments)
			sendToolResult(t, client, env.RequestID, env.CallID, success, data)

		case websocket.TypeAgentStream:
			var sp websocket.AgentStreamPayload
			env.DecodePayload(&sp)
			streams = append(streams, sp.Delta)

		case websocket.TypeAgentResponse:
			return streams, env

		case websocket.TypeAgentError:
			var ep websocket.AgentErrorPayload
			env.DecodePayload(&ep)
			t.Fatalf("received agent.error: code=%s message=%s", ep.Code, ep.Message)
		}
	}

	t.Fatal("timed out waiting for agent.response")
	return nil, nil
}

func TestFullGenerateSQLPipeline(t *testing.T) {
	// Mock LLM: non-streaming returns SQL candidates, streaming returns aggregation.
	chosenSQL := "SELECT u.name, COUNT(o.id) AS order_count FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY order_count DESC LIMIT 10"
	aggregationChunks := []string{
		makeStreamChunkJSON("Candidate 1 is best. "),
		makeStreamChunkWithUsage(
			fmt.Sprintf("```sql\\n%s\\n```", strings.ReplaceAll(chosenSQL, `"`, `\"`)),
			100, 50, 150,
		),
	}
	mockLLM := multiModeLLMServer(t, "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY COUNT(o.id) DESC LIMIT 10", aggregationChunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))

	// Build and register pipeline.
	pipeline := agent.NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")
	pipeline.RegisterAction(agent.ActionGenerateSQL,
		&SchemaGroundingStep{},
		&ParallelSQLGenerationStep{},
		&DiagnosticRetryStep{},
		&SeedExpansionStep{},
		&ResultAggregationStep{},
	)

	// Create agent.request envelope.
	reqPayload := websocket.AgentRequestPayload{
		Action:      "generate_sql",
		UserMessage: "show top 10 users by order count",
	}
	env, err := websocket.NewEnvelope(websocket.TypeAgentRequest, reqPayload)
	if err != nil {
		t.Fatal(err)
	}

	// Run pipeline in background.
	go pipeline.HandleMessage(session, env)

	// Handle all tool.call messages from the pipeline.
	toolHandler := func(toolName string, args json.RawMessage) (any, bool) {
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
				},
				"indexes":      []string{},
				"foreign_keys": []string{},
			}, true
		case "explain_query":
			return map[string]any{
				"plan": "Seq Scan on users (cost=0.00..1.03 rows=3 width=36)",
			}, true
		default:
			return map[string]string{"error": "unknown tool"}, false
		}
	}

	// Note: result aggregation now uses non-streaming LLM, so no agent.stream messages expected.
	_, resp := handleToolCalls(t, client, toolHandler, 30*time.Second)

	// Verify agent.response.
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	var rp websocket.AgentResponsePayload
	if err := resp.DecodePayload(&rp); err != nil {
		t.Fatalf("decode response payload: %v", err)
	}

	// Should have SQL in the result.
	if rp.Result.SQL == "" {
		t.Error("expected non-empty SQL in response")
	}

	// Should have explanation.
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation in response")
	}

	// Should have candidates.
	if len(rp.Result.Candidates) == 0 {
		t.Error("expected candidates in response")
	}

	// Should have tool_calls_log (list_tables + describe_table*3 + explain_query*3 = 7).
	if len(rp.ToolCallsLog) < 4 {
		t.Errorf("expected at least 4 tool call log entries, got %d", len(rp.ToolCallsLog))
	}

	// Should report tokens used and model.
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}
}

func TestFullGenerateSQLPipeline_ListTablesFails(t *testing.T) {
	// If list_tables tool returns "No database connection", the pipeline should send
	// a friendly agent.response (not agent.error) with a DB-not-connected explanation.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL("http://localhost:1"), llm.WithMaxRetries(0))

	pipeline := agent.NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")
	pipeline.RegisterAction(agent.ActionGenerateSQL,
		&SchemaGroundingStep{},
		&ParallelSQLGenerationStep{},
		&DiagnosticRetryStep{},
		&SeedExpansionStep{},
		&ResultAggregationStep{},
	)

	reqPayload := websocket.AgentRequestPayload{
		Action:      "generate_sql",
		UserMessage: "show users",
	}
	env, _ := websocket.NewEnvelope(websocket.TypeAgentRequest, reqPayload)

	go pipeline.HandleMessage(session, env)

	// Step 1: Respond to list_schemas with success.
	schemasEnv := readEnvelope(t, client)
	if schemasEnv.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call for list_schemas, got %s", schemasEnv.Type)
	}
	sendToolResult(t, client, schemasEnv.RequestID, schemasEnv.CallID, true, []string{"public"})

	// Step 2: Read the tool.call for list_tables and respond with "No database connection" failure.
	tcEnv := readEnvelope(t, client)
	if tcEnv.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", tcEnv.Type)
	}

	failPayload := websocket.ToolResultPayload{
		Success: false,
		Error:   "No database connection",
	}
	failEnv, _ := websocket.NewEnvelopeWithID(websocket.TypeToolResult, tcEnv.RequestID, tcEnv.CallID, failPayload)
	raw, _ := failEnv.Marshal()
	client.WriteMessage(ws.TextMessage, raw)

	// Expect agent.response with a friendly DB-not-connected message (not agent.error).
	respEnv := readEnvelope(t, client)
	if respEnv.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response for DB-not-connected, got %s", respEnv.Type)
	}
	var rp websocket.AgentResponsePayload
	respEnv.DecodePayload(&rp)
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation in DB-not-connected response")
	}
}

func TestFullGenerateSQLPipeline_StepOrder(t *testing.T) {
	// Verify that the 5 steps run in correct order by tracking tool call sequence.
	chosenSQL := "SELECT 1"
	aggregationChunks := []string{
		makeStreamChunkWithUsage(
			fmt.Sprintf("```sql\\n%s\\n```", chosenSQL),
			50, 20, 70,
		),
	}
	mockLLM := multiModeLLMServer(t, "SELECT u.id FROM users u LIMIT 10", aggregationChunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))

	pipeline := agent.NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")
	pipeline.RegisterAction(agent.ActionGenerateSQL,
		&SchemaGroundingStep{},
		&ParallelSQLGenerationStep{},
		&DiagnosticRetryStep{},
		&SeedExpansionStep{},
		&ResultAggregationStep{},
	)

	reqPayload := websocket.AgentRequestPayload{
		Action:      "generate_sql",
		UserMessage: "show users",
	}
	env, _ := websocket.NewEnvelope(websocket.TypeAgentRequest, reqPayload)

	go pipeline.HandleMessage(session, env)

	// Track the order of tool calls.
	var toolCallOrder []string

	toolHandler := func(toolName string, args json.RawMessage) (any, bool) {
		toolCallOrder = append(toolCallOrder, toolName)
		switch toolName {
		case "list_schemas":
			return []string{"public"}, true
		case "list_tables":
			return []string{"users", "orders"}, true
		case "describe_table":
			return map[string]any{"columns": []map[string]string{{"name": "id", "type": "int"}}}, true
		case "explain_query":
			return map[string]any{"plan": "Seq Scan"}, true
		default:
			return nil, false
		}
	}

	_, resp := handleToolCalls(t, client, toolHandler, 30*time.Second)
	if resp == nil {
		t.Fatal("no response received")
	}

	// Verify tool call order: list_schemas first, then list_tables, then describe_tables, then explain_queries.
	if len(toolCallOrder) < 5 {
		t.Fatalf("expected at least 5 tool calls, got %d: %v", len(toolCallOrder), toolCallOrder)
	}

	// First call must be list_schemas (schema grounding).
	if toolCallOrder[0] != "list_schemas" {
		t.Errorf("first tool call should be list_schemas, got %s", toolCallOrder[0])
	}

	// Second call must be list_tables (schema grounding).
	if toolCallOrder[1] != "list_tables" {
		t.Errorf("second tool call should be list_tables, got %s", toolCallOrder[1])
	}

	// After list_tables, describe_table calls come next (schema grounding).
	listTablesIdx := 1
	describeEnd := listTablesIdx + 1
	for describeEnd < len(toolCallOrder) && toolCallOrder[describeEnd] == "describe_table" {
		describeEnd++
	}
	describeCount := describeEnd - listTablesIdx - 1
	if describeCount < 1 {
		t.Error("expected at least 1 describe_table call after list_tables")
	}

	// After describe_table calls, explain_query calls come (diagnostic retry).
	for i := describeEnd; i < len(toolCallOrder); i++ {
		if toolCallOrder[i] != "explain_query" {
			t.Errorf("expected explain_query at index %d, got %s", i, toolCallOrder[i])
		}
	}
}
