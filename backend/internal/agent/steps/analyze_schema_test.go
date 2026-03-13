package steps

import (
	"context"
	"encoding/json"
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

func buildAnalyzeContext(t *testing.T, session *websocket.Session, llmClient *llm.Client) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-analyze"
	pctx.Action = "analyze_schema"
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()
	return pctx
}

// handleToolCallsForAnalyze handles the tool.call sequence expected by analyze_schema:
// 1. list_schemas → reply with schemas
// 2. list_tables per schema → reply with tables
// 3. describe_table per table → reply with description
func handleToolCallsForAnalyze(
	t *testing.T,
	client *ws.Conn,
	schemas []string,
	tablesPerSchema map[string][]string,
) {
	t.Helper()

	// 1. list_schemas
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", env.Type)
	}
	var tc websocket.ToolCallPayload
	env.DecodePayload(&tc)
	if tc.ToolName != "list_schemas" {
		t.Fatalf("expected list_schemas, got %s", tc.ToolName)
	}
	sendToolResult(t, client, env.RequestID, env.CallID, true, schemas)

	// 2. list_tables for each schema
	for range schemas {
		env = readEnvelope(t, client)
		if env.Type != websocket.TypeToolCall {
			t.Fatalf("expected tool.call for list_tables, got %s", env.Type)
		}
		var ltc websocket.ToolCallPayload
		env.DecodePayload(&ltc)
		if ltc.ToolName != "list_tables" {
			t.Fatalf("expected list_tables, got %s", ltc.ToolName)
		}

		// Extract schema from arguments.
		var args map[string]string
		json.Unmarshal(ltc.Arguments, &args)
		schema := args["schema"]

		tables := tablesPerSchema[schema]
		sendToolResult(t, client, env.RequestID, env.CallID, true, tables)
	}

	// 3. describe_table for each table across all schemas
	totalTables := 0
	for _, tables := range tablesPerSchema {
		totalTables += len(tables)
	}
	for i := 0; i < totalTables; i++ {
		env = readEnvelope(t, client)
		if env.Type != websocket.TypeToolCall {
			t.Fatalf("table %d: expected tool.call for describe_table, got %s", i, env.Type)
		}
		var dtc websocket.ToolCallPayload
		env.DecodePayload(&dtc)
		if dtc.ToolName != "describe_table" {
			t.Fatalf("expected describe_table, got %s", dtc.ToolName)
		}
		sendToolResult(t, client, env.RequestID, env.CallID, true,
			map[string]any{"columns": []string{"id", "name"}, "indexes": []string{"pk_id"}})
	}
}

func TestAnalyzeSchema_Success(t *testing.T) {
	chunks := []string{
		makeStreamChunkJSON("The database has "),
		makeStreamChunkJSON("3 tables with "),
		makeStreamChunkWithUsage("proper relationships.", 50, 30, 80),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildAnalyzeContext(t, session, llmClient)

	errCh := make(chan error, 1)
	go func() {
		step := &AnalyzeSchemaStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	handleToolCallsForAnalyze(t, client, []string{"public"},
		map[string][]string{"public": {"users", "orders", "products"}})

	// Read 3 agent.stream messages.
	var deltas []string
	for i := 0; i < 3; i++ {
		env := readEnvelope(t, client)
		if env.Type != websocket.TypeAgentStream {
			t.Fatalf("chunk %d: expected agent.stream, got %s", i, env.Type)
		}
		var payload websocket.AgentStreamPayload
		env.DecodePayload(&payload)
		deltas = append(deltas, payload.Delta)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	full := strings.Join(deltas, "")
	expected := "The database has 3 tables with proper relationships."
	if full != expected {
		t.Errorf("expected %q, got %q", expected, full)
	}

	if pctx.Result.Explanation != expected {
		t.Errorf("expected explanation %q, got %q", expected, pctx.Result.Explanation)
	}

	if pctx.TokensUsed != 80 {
		t.Errorf("expected 80 tokens, got %d", pctx.TokensUsed)
	}

	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model test-model, got %s", pctx.ModelUsed)
	}

	// Verify tool calls were logged: list_schemas + list_tables + 3x describe_table = 5
	if len(pctx.ToolCallsLog) != 5 {
		t.Errorf("expected 5 tool calls logged, got %d", len(pctx.ToolCallsLog))
	}
}

func TestAnalyzeSchema_ListSchemasFails(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithMaxRetries(0))
	pctx := buildAnalyzeContext(t, session, llmClient)

	errCh := make(chan error, 1)
	go func() {
		step := &AnalyzeSchemaStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// list_schemas → error
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeToolCall {
		t.Fatalf("expected tool.call, got %s", env.Type)
	}
	sendToolResult(t, client, env.RequestID, env.CallID, false, nil)

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "list_schemas returned error") {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

func TestAnalyzeSchema_NoTables(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithMaxRetries(0))
	pctx := buildAnalyzeContext(t, session, llmClient)

	errCh := make(chan error, 1)
	go func() {
		step := &AnalyzeSchemaStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// list_schemas → ["public"]
	env := readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"public"})

	// list_tables → empty
	env = readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{})

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error for no tables")
		}
		if !strings.Contains(err.Error(), "no tables found") {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

func TestAnalyzeSchema_PartialDescribeFailure(t *testing.T) {
	chunks := []string{
		makeStreamChunkWithUsage("Analysis report.", 30, 20, 50),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildAnalyzeContext(t, session, llmClient)

	errCh := make(chan error, 1)
	go func() {
		step := &AnalyzeSchemaStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// list_schemas
	env := readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"public"})

	// list_tables
	env = readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"users", "broken_table"})

	// describe_table for users → success
	env = readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, true,
		map[string]any{"columns": []string{"id", "name"}})

	// describe_table for broken_table → error
	env = readEnvelope(t, client)
	sendToolResult(t, client, env.RequestID, env.CallID, false, nil)

	// Read agent.stream
	streamEnv := readEnvelope(t, client)
	if streamEnv.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", streamEnv.Type)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step should succeed with partial data: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	if pctx.Result.Explanation != "Analysis report." {
		t.Errorf("unexpected explanation: %q", pctx.Result.Explanation)
	}
}

func TestAnalyzeSchema_LLMError(t *testing.T) {
	// LLM server that returns 500.
	mockLLM := sseServer(t, nil) // will return [DONE] immediately with no chunks
	mockLLM.Close()              // close to force connection error

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildAnalyzeContext(t, session, llmClient)

	errCh := make(chan error, 1)
	go func() {
		step := &AnalyzeSchemaStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Respond to tool calls (1 schema, 1 table, 1 describe)
	env := readEnvelope(t, client) // list_schemas
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"public"})
	env = readEnvelope(t, client) // list_tables
	sendToolResult(t, client, env.RequestID, env.CallID, true, []string{"users"})
	env = readEnvelope(t, client) // describe_table
	sendToolResult(t, client, env.RequestID, env.CallID, true, map[string]any{"columns": []string{"id"}})

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error from LLM")
		}
		if !strings.Contains(err.Error(), "LLM analyze_schema failed") {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}
}

func TestAnalyzeSchema_Name(t *testing.T) {
	step := &AnalyzeSchemaStep{}
	if step.Name() != "analyze_schema" {
		t.Errorf("expected name 'analyze_schema', got %q", step.Name())
	}
}

func TestAnalyzeSchema_IntegrationWithPipeline(t *testing.T) {
	chunks := []string{
		makeStreamChunkJSON("Schema looks "),
		makeStreamChunkWithUsage("good.", 20, 10, 30),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	registry := tools.NewRegistry()

	p := agent.NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction(agent.ActionAnalyzeSchema, &AnalyzeSchemaStep{})

	reqPayload := websocket.AgentRequestPayload{
		Action: "analyze_schema",
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-analyze-pipe", "", reqPayload)

	go p.HandleMessage(session, env)

	// Handle tool calls: list_schemas → list_tables → describe_table
	toolEnv := readEnvelope(t, client) // list_schemas
	sendToolResult(t, client, toolEnv.RequestID, toolEnv.CallID, true, []string{"public"})
	toolEnv = readEnvelope(t, client) // list_tables
	sendToolResult(t, client, toolEnv.RequestID, toolEnv.CallID, true, []string{"users"})
	toolEnv = readEnvelope(t, client) // describe_table
	sendToolResult(t, client, toolEnv.RequestID, toolEnv.CallID, true,
		map[string]any{"columns": []string{"id", "name", "email"}})

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
	if respPayload.Action != "analyze_schema" {
		t.Errorf("expected action=analyze_schema, got %q", respPayload.Action)
	}
	if respPayload.Result.Explanation != "Schema looks good." {
		t.Errorf("expected explanation='Schema looks good.', got %q", respPayload.Result.Explanation)
	}
	if respPayload.TokensUsed != 30 {
		t.Errorf("expected tokens=30, got %d", respPayload.TokensUsed)
	}

	// Verify tool calls logged: list_schemas + list_tables + describe_table = 3
	if len(respPayload.ToolCallsLog) != 3 {
		t.Errorf("expected 3 tool calls, got %d", len(respPayload.ToolCallsLog))
	}
}

func TestAnalyzeSchema_MultipleSchemas(t *testing.T) {
	chunks := []string{
		makeStreamChunkWithUsage("Multi-schema analysis.", 40, 20, 60),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildAnalyzeContext(t, session, llmClient)

	errCh := make(chan error, 1)
	go func() {
		step := &AnalyzeSchemaStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	handleToolCallsForAnalyze(t, client,
		[]string{"public", "analytics"},
		map[string][]string{
			"public":    {"users"},
			"analytics": {"events"},
		},
	)

	// Read agent.stream
	streamEnv := readEnvelope(t, client)
	if streamEnv.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", streamEnv.Type)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("step failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
	}

	// 4 tool calls: list_schemas + 2x list_tables + 2x describe_table = 5
	if len(pctx.ToolCallsLog) != 5 {
		t.Errorf("expected 5 tool calls, got %d", len(pctx.ToolCallsLog))
	}
}

func TestParseSchemaNames(t *testing.T) {
	// String array.
	data, _ := json.Marshal([]string{"public", "analytics"})
	names := parseSchemaNames(data)
	if len(names) != 2 || names[0] != "public" || names[1] != "analytics" {
		t.Errorf("string array: expected [public, analytics], got %v", names)
	}

	// Object array with schema_name.
	data, _ = json.Marshal([]map[string]string{
		{"schema_name": "public"},
		{"schema_name": "test"},
	})
	names = parseSchemaNames(data)
	if len(names) != 2 || names[0] != "public" || names[1] != "test" {
		t.Errorf("object array: expected [public, test], got %v", names)
	}

	// Invalid data.
	names = parseSchemaNames(json.RawMessage(`"not_an_array"`))
	if names != nil {
		t.Errorf("invalid: expected nil, got %v", names)
	}
}
