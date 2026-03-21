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

	ws "github.com/gorilla/websocket"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// --- test helpers ---

// wsDialer creates a test WebSocket server + client pair.
func wsDialer(t *testing.T, hub *websocket.Hub) (*websocket.Session, *ws.Conn) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := ws.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade: %v", err)
		}
		sess := websocket.NewSession("test-session", c, hub, zap.NewNop(), nil)
		hub.Register(sess)
		sess.Run()
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := ws.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	var session *websocket.Session
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c := hub.Get("test-session"); c != nil {
			if s, ok := c.(*websocket.Session); ok {
				session = s
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if session == nil {
		t.Fatal("session not registered in hub")
	}
	return session, client
}

// readEnvelope reads and parses one WebSocket message from the client connection.
func readEnvelope(t *testing.T, client *ws.Conn) *websocket.Envelope {
	t.Helper()
	client.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := client.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	env, err := websocket.ParseEnvelope(msg)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return env
}

// sendToolResult sends a tool.result reply for a given call_id.
func sendToolResult(t *testing.T, client *ws.Conn, requestID, callID string, success bool, data any) {
	t.Helper()
	dataJSON, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	payload := websocket.ToolResultPayload{
		Success: success,
		Data:    dataJSON,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeToolResult, requestID, callID, payload)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	raw, err := env.Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := client.WriteMessage(ws.TextMessage, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// newMockLLMServer creates a test HTTP server that returns a fixed LLM response.
func newMockLLMServer(t *testing.T, responseContent string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := llm.ChatResponse{
			ID:    "chatcmpl-test",
			Model: "test-model",
			Choices: []llm.Choice{
				{
					Index:        0,
					Message:      llm.Message{Role: "assistant", Content: responseContent},
					FinishReason: "stop",
				},
			},
			Usage: llm.Usage{PromptTokens: 50, CompletionTokens: 10, TotalTokens: 60},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func buildPipelineContext(t *testing.T, session *websocket.Session, llmClient *llm.Client) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Action = "generate_sql"
	pctx.UserMessage = "покажи заказы пользователей"
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()
	return pctx
}

// --- tests ---

func TestSchemaGrounding_SmallSchema_SkipsLLM(t *testing.T) {
	// With <=5 tables, LLM is not called for table selection.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	// LLM server not needed for small schemas, but provide one that would fail.
	llmClient := llm.NewClient("test-key", llm.WithBaseURL("http://localhost:1"))
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	// Run step in background.
	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Client receives tool.call for list_tables.
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", env.Type)
	}
	var tc websocket.ToolCallPayload
	env.DecodePayload(&tc)
	if tc.ToolName != "list_tables" {
		t.Fatalf("expected list_tables, got %s", tc.ToolName)
	}

	// Reply with 3 tables (<=5, so LLM won't be called).
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"users", "orders", "products"})

	// Client receives describe_table for each of the 3 tables.
	for i := 0; i < 3; i++ {
		desc := readEnvelope(t, client)
		if desc.Type != websocket.TypeToolCall {
			t.Fatalf("expected tool.call, got %s", desc.Type)
		}
		var dtc websocket.ToolCallPayload
		desc.DecodePayload(&dtc)
		if dtc.ToolName != "describe_table" {
			t.Fatalf("expected describe_table, got %s", dtc.ToolName)
		}

		sendToolResult(t, client, desc.RequestID, desc.CallID, true,
			map[string]any{"columns": []string{"id", "name"}})
	}

	// Wait for step to complete.
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}

	// Verify schema context was stored.
	val, ok := pctx.Get(ContextKeySchemaContext)
	if !ok {
		t.Fatal("schema_context not stored in pipeline context")
	}
	sc := val.(*SchemaContext)
	if len(sc.Tables) != 3 {
		t.Fatalf("expected 3 tables, got %d", len(sc.Tables))
	}

	// Verify tool calls were logged.
	if len(pctx.ToolCallsLog) != 4 { // 1 list_tables + 3 describe_table
		t.Errorf("expected 4 tool call log entries, got %d", len(pctx.ToolCallsLog))
	}
}

func TestSchemaGrounding_LargeSchema_UsesLLM(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	// Mock LLM that returns ["users", "orders"] as relevant tables.
	llmSrv := newMockLLMServer(t, `["users", "orders"]`)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Respond to list_tables with 8 tables (>5, triggers LLM selection).
	env := readEnvelope(t, client)
	tables := []string{"users", "orders", "products", "categories", "reviews", "inventory", "payments", "shipping"}
	sendToolResult(t, client, env.RequestID, env.CallID, true, tables)

	// LLM selected ["users", "orders"], so expect 2 describe_table calls.
	for i := 0; i < 2; i++ {
		desc := readEnvelope(t, client)
		if desc.Type != websocket.TypeToolCall {
			t.Fatalf("expected tool.call, got %s", desc.Type)
		}
		sendToolResult(t, client, desc.RequestID, desc.CallID, true,
			map[string]any{"columns": []string{"id", "name"}})
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}

	val, ok := pctx.Get(ContextKeySchemaContext)
	if !ok {
		t.Fatal("schema_context not stored")
	}
	sc := val.(*SchemaContext)
	if len(sc.Tables) != 2 {
		t.Fatalf("expected 2 tables, got %d", len(sc.Tables))
	}

	// Verify tokens were tracked from LLM call.
	if pctx.TokensUsed != 60 {
		t.Errorf("expected 60 tokens, got %d", pctx.TokensUsed)
	}
}

func TestSchemaGrounding_ListTablesFails(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key")
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Respond to list_tables with error.
	env := readEnvelope(t, client)
	payload := websocket.ToolResultPayload{
		Success: false,
		Error:   "connection refused",
	}
	errEnv, _ := websocket.NewEnvelopeWithID(websocket.TypeToolResult, env.RequestID, env.CallID, payload)
	raw, _ := errEnv.Marshal()
	client.WriteMessage(ws.TextMessage, raw)

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !strings.Contains(err.Error(), "list_tables returned error") {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}
}

func TestSchemaGrounding_DescribeTablePartialFailure(t *testing.T) {
	// If one describe_table fails, the step should still succeed with the remaining tables.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL("http://localhost:1"))
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Reply to list_tables with 2 tables.
	env := readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"users", "orders"})

	// First describe_table succeeds.
	desc1 := readEnvelope(t, client)
	sendToolResult(t, client, desc1.RequestID, desc1.CallID, true,
		map[string]any{"columns": []string{"id"}})

	// Second describe_table fails.
	desc2 := readEnvelope(t, client)
	failPayload := websocket.ToolResultPayload{Success: false, Error: "table not found"}
	failEnv, _ := websocket.NewEnvelopeWithID(websocket.TypeToolResult, desc2.RequestID, desc2.CallID, failPayload)
	raw, _ := failEnv.Marshal()
	client.WriteMessage(ws.TextMessage, raw)

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step should succeed with partial results: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}

	val, ok := pctx.Get(ContextKeySchemaContext)
	if !ok {
		t.Fatal("schema_context not stored")
	}
	sc := val.(*SchemaContext)
	if len(sc.Tables) != 1 {
		t.Fatalf("expected 1 table (partial success), got %d", len(sc.Tables))
	}
}

func TestSchemaGrounding_LLMReturnsCodeFencedJSON(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	// LLM returns JSON wrapped in code fences.
	llmSrv := newMockLLMServer(t, "```json\n[\"users\", \"orders\"]\n```")
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(llmSrv.URL))
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// 8 tables to trigger LLM.
	env := readEnvelope(t, client)
	tables := []string{"users", "orders", "products", "categories", "reviews", "inventory", "payments", "shipping"}
	sendToolResult(t, client, env.RequestID, env.CallID, true, tables)

	// Expect 2 describe_table calls.
	for i := 0; i < 2; i++ {
		desc := readEnvelope(t, client)
		sendToolResult(t, client, desc.RequestID, desc.CallID, true,
			map[string]any{"columns": []string{"id"}})
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}

	val, _ := pctx.Get(ContextKeySchemaContext)
	sc := val.(*SchemaContext)
	if len(sc.Tables) != 2 {
		t.Fatalf("expected 2 tables, got %d", len(sc.Tables))
	}
}

// --- unit tests for utility functions ---

func TestParseTableNames_StringArray(t *testing.T) {
	data := json.RawMessage(`["users", "orders", "products"]`)
	names, err := parseTableNames(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 3 || names[0] != "users" {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestParseTableNames_ObjectArray(t *testing.T) {
	data := json.RawMessage(`[{"table_name":"users","table_type":"BASE TABLE"},{"table_name":"orders","table_type":"BASE TABLE"}]`)
	names, err := parseTableNames(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "users" || names[1] != "orders" {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestParseTableNames_InvalidJSON(t *testing.T) {
	data := json.RawMessage(`"not an array"`)
	_, err := parseTableNames(data)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestStripCodeFences(t *testing.T) {
	tests := []struct {
		input, expected string
	}{
		{`["a"]`, `["a"]`},
		{"```json\n[\"a\"]\n```", `["a"]`},
		{"```\n[\"a\"]\n```", `["a"]`},
		{"  ```json\n[\"a\"]\n```  ", `["a"]`},
	}
	for _, tt := range tests {
		got := stripCodeFences(tt.input)
		if got != tt.expected {
			t.Errorf("stripCodeFences(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestStripThinkingTags(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"no thinking tags", "SELECT * FROM users", "SELECT * FROM users"},
		{"thinking before SQL", "<think>\nLet me analyze the schema...\n</think>\nSELECT * FROM users", "SELECT * FROM users"},
		{"thinking before code fence", "<think>\nAnalyzing...\n</think>\n```sql\nSELECT 1\n```", "```sql\nSELECT 1\n```"},
		{"unclosed think tag", "<think>\nThis is reasoning...", ""},
		{"empty after strip", "<think>reasoning</think>", ""},
		{"multiple think blocks", "<think>first</think>\nSELECT 1\n<think>second</think>", "SELECT 1"},
		{"no content in think", "<think></think>\nSELECT 1", "SELECT 1"},
		{"think tag mid-content", "SELECT <think>hmm</think>* FROM users", "SELECT * FROM users"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripThinkingTags(tt.input)
			if got != tt.expected {
				t.Errorf("stripThinkingTags() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestSchemaGrounding_ObjectTableFormat(t *testing.T) {
	// Test that list_tables returning objects with table_name field works.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL("http://localhost:1"))
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Reply with object format.
	env := readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true,
		[]map[string]string{
			{"table_name": "users", "table_type": "BASE TABLE"},
			{"table_name": "orders", "table_type": "BASE TABLE"},
		})

	// 2 describe_table calls.
	for i := 0; i < 2; i++ {
		desc := readEnvelope(t, client)
		sendToolResult(t, client, desc.RequestID, desc.CallID, true,
			map[string]any{"columns": []string{"id"}})
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}

	val, _ := pctx.Get(ContextKeySchemaContext)
	sc := val.(*SchemaContext)
	if len(sc.Tables) != 2 {
		t.Fatalf("expected 2 tables, got %d", len(sc.Tables))
	}
}

func TestSchemaGrounding_NoTablesFound(t *testing.T) {
	// When the database is empty (no tables), the step should respond with a helpful
	// message and set SkipRemaining, instead of returning an error.
	chunks := []string{
		makeStreamChunkWithUsage("The database is empty.", 20, 10, 30),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	env := readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{})

	// Drain agent.stream messages sent to the WebSocket client.
	for {
		client.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, err := client.ReadMessage()
		if err != nil {
			break
		}
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("expected no error for empty database, got: %v", err)
		}
		if !pctx.SkipRemaining {
			t.Error("expected SkipRemaining to be true")
		}
		if pctx.Result.Explanation == "" {
			t.Error("expected non-empty Explanation for empty database response")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}
}

func TestSchemaGrounding_DBNotConnected(t *testing.T) {
	// When list_tables returns "No database connection", the step should return
	// a DatabaseNotConnectedError instead of a generic error.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key")
	pctx := buildPipelineContext(t, session, llmClient)

	step := &SchemaGroundingStep{}

	errCh := make(chan error, 1)
	go func() {
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Respond to list_tables with "No database connection" error.
	env := readEnvelope(t, client)
	payload := websocket.ToolResultPayload{
		Success: false,
		Error:   "No database connection",
	}
	errEnv, _ := websocket.NewEnvelopeWithID(websocket.TypeToolResult, env.RequestID, env.CallID, payload)
	raw, _ := errEnv.Marshal()
	client.WriteMessage(ws.TextMessage, raw)

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !agent.IsDatabaseNotConnected(err) {
			t.Errorf("expected DatabaseNotConnectedError, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step timed out")
	}
}

// Ensure unused import doesn't cause compile error.
var _ = fmt.Sprintf
