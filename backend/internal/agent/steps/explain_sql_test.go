package steps

import (
	"context"
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

// sseServer creates a test HTTP server that returns SSE chunks.
func sseServer(t *testing.T, chunks []string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, chunk := range chunks {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))
}

func makeStreamChunkJSON(content string) string {
	return fmt.Sprintf(`{"id":"resp-1","model":"test-model","choices":[{"index":0,"delta":{"content":"%s"},"finish_reason":null}]}`, content)
}

func makeStreamChunkWithUsage(content string, promptTokens, completionTokens, totalTokens int) string {
	return fmt.Sprintf(`{"id":"resp-1","model":"test-model","choices":[{"index":0,"delta":{"content":"%s"},"finish_reason":"stop"}],"usage":{"prompt_tokens":%d,"completion_tokens":%d,"total_tokens":%d}}`,
		content, promptTokens, completionTokens, totalTokens)
}

func buildExplainSQLContext(t *testing.T, session *websocket.Session, llmClient *llm.Client, sql string) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-explain"
	pctx.Action = "explain_sql"
	pctx.SelectedSQL = sql
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()
	return pctx
}

func TestExplainSQL_Success(t *testing.T) {
	chunks := []string{
		makeStreamChunkJSON("This query "),
		makeStreamChunkJSON("selects all "),
		makeStreamChunkWithUsage("users.", 20, 10, 30),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildExplainSQLContext(t, session, llmClient, "SELECT * FROM users")

	errCh := make(chan error, 1)
	go func() {
		step := &ExplainSQLStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

	// Read 3 agent.stream messages.
	var deltas []string
	for i := 0; i < 3; i++ {
		env := readEnvelope(t, client)
		if env.Type != websocket.TypeAgentStream {
			t.Fatalf("chunk %d: expected agent.stream, got %s", i, env.Type)
		}
		if env.RequestID != "req-explain" {
			t.Fatalf("chunk %d: expected request_id=req-explain, got %s", i, env.RequestID)
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

	// Verify streaming deltas.
	full := strings.Join(deltas, "")
	if full != "This query selects all users." {
		t.Errorf("expected 'This query selects all users.', got %q", full)
	}

	// Verify explanation stored in result.
	if pctx.Result.Explanation != "This query selects all users." {
		t.Errorf("expected explanation 'This query selects all users.', got %q", pctx.Result.Explanation)
	}

	// Verify tokens tracked.
	if pctx.TokensUsed != 30 {
		t.Errorf("expected 30 tokens, got %d", pctx.TokensUsed)
	}

	// Verify model tracked.
	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model test-model, got %s", pctx.ModelUsed)
	}
}

func TestExplainSQL_MissingSelectedSQL(t *testing.T) {
	llmClient := llm.NewClient("test-key")
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.Action = "explain_sql"
	pctx.SelectedSQL = "" // deliberately empty
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	step := &ExplainSQLStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for missing selected_sql")
	}
	if !strings.Contains(err.Error(), "selected_sql is required") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestExplainSQL_LLMError(t *testing.T) {
	// LLM server that returns 500.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildExplainSQLContext(t, session, llmClient, "SELECT 1")

	step := &ExplainSQLStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error from LLM")
	}
	if !strings.Contains(err.Error(), "LLM explain_sql failed") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestExplainSQL_CustomModel(t *testing.T) {
	chunks := []string{
		makeStreamChunkWithUsage("Explanation here.", 15, 8, 23),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildExplainSQLContext(t, session, llmClient, "SELECT COUNT(*) FROM orders")
	pctx.Model = "anthropic/claude-3-haiku"

	errCh := make(chan error, 1)
	go func() {
		step := &ExplainSQLStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

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

	if pctx.Result.Explanation != "Explanation here." {
		t.Errorf("unexpected explanation: %q", pctx.Result.Explanation)
	}
}

func TestExplainSQL_IntegrationWithPipeline(t *testing.T) {
	// Full pipeline test: agent.request → explain_sql step → agent.stream + agent.response.
	chunks := []string{
		makeStreamChunkJSON("The query "),
		makeStreamChunkWithUsage("works.", 10, 5, 15),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	registry := tools.NewRegistry()

	p := agent.NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction(agent.ActionExplainSQL, &ExplainSQLStep{})

	reqPayload := websocket.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocket.AgentRequestContext{
			SelectedSQL: "SELECT u.name FROM users u JOIN orders o ON u.id = o.user_id",
		},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-explain-pipe", "", reqPayload)

	go p.HandleMessage(session, env)

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
	if respPayload.Action != "explain_sql" {
		t.Errorf("expected action=explain_sql, got %q", respPayload.Action)
	}
	if respPayload.Result.Explanation != "The query works." {
		t.Errorf("expected explanation='The query works.', got %q", respPayload.Result.Explanation)
	}
	if respPayload.TokensUsed != 15 {
		t.Errorf("expected tokens=15, got %d", respPayload.TokensUsed)
	}
	if respPayload.ModelUsed != "test-model" {
		t.Errorf("expected model=test-model, got %q", respPayload.ModelUsed)
	}
}

func TestExplainSQL_InvalidAction_ReturnsError(t *testing.T) {
	// Pipeline with explain_sql registered, but request with unknown action.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key")
	registry := tools.NewRegistry()

	p := agent.NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction(agent.ActionExplainSQL, &ExplainSQLStep{})

	reqPayload := websocket.AgentRequestPayload{
		Action:      "unknown_action",
		UserMessage: "test",
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-unknown", "", reqPayload)

	go p.HandleMessage(session, env)

	// Read agent.error.
	errEnv := readEnvelope(t, client)
	if errEnv.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", errEnv.Type)
	}
	var errPayload websocket.AgentErrorPayload
	errEnv.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeInvalidRequest {
		t.Errorf("expected code=invalid_request, got %q", errPayload.Code)
	}
}
