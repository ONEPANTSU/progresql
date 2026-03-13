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

// intentLLMServer returns a mock that handles both non-streaming (classification)
// and streaming (conversational response) requests.
func intentLLMServer(t *testing.T, classifyResult string, streamChunks []string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req llm.ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		if req.Stream {
			// Streaming: conversational response.
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			for _, chunk := range streamChunks {
				fmt.Fprintf(w, "data: %s\n\n", chunk)
			}
			fmt.Fprint(w, "data: [DONE]\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return
		}

		// Non-streaming: classification.
		resp := llm.ChatResponse{
			ID:    "chatcmpl-classify",
			Model: "test-model",
			Choices: []llm.Choice{{
				Index:        0,
				Message:      llm.Message{Role: "assistant", Content: classifyResult},
				FinishReason: "stop",
			}},
			Usage: llm.Usage{PromptTokens: 20, CompletionTokens: 1, TotalTokens: 21},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

func buildIntentContext(t *testing.T, session *websocket.Session, llmClient *llm.Client, msg string) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-intent"
	pctx.Action = "generate_sql"
	pctx.UserMessage = msg
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()
	return pctx
}

func TestIntentDetection_SQLIntent(t *testing.T) {
	mockLLM := intentLLMServer(t, "sql", nil)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildIntentContext(t, session, llmClient, "show me all users who placed orders")

	step := &IntentDetectionStep{}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}

	// Should NOT skip remaining steps.
	if pctx.SkipRemaining {
		t.Error("expected SkipRemaining=false for SQL intent")
	}

	// Intent should be stored.
	intentVal, ok := pctx.Get(ContextKeyIntent)
	if !ok {
		t.Fatal("intent not stored in context")
	}
	if intentVal != IntentSQL {
		t.Errorf("expected intent=sql, got %v", intentVal)
	}

	// Tokens from classification should be tracked.
	if pctx.TokensUsed != 21 {
		t.Errorf("expected 21 tokens, got %d", pctx.TokensUsed)
	}
}

func TestIntentDetection_ConversationalIntent(t *testing.T) {
	chunks := []string{
		makeStreamChunkJSON("Hello! I'm your "),
		makeStreamChunkJSON("PostgreSQL assistant. "),
		makeStreamChunkWithUsage("How can I help?", 15, 10, 25),
	}
	mockLLM := intentLLMServer(t, "conversational", chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildIntentContext(t, session, llmClient, "hello")

	errCh := make(chan error, 1)
	go func() {
		step := &IntentDetectionStep{}
		errCh <- step.Execute(context.Background(), pctx)
	}()

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

	// Should skip remaining steps.
	if !pctx.SkipRemaining {
		t.Error("expected SkipRemaining=true for conversational intent")
	}

	// Verify streaming content.
	full := strings.Join(deltas, "")
	if full != "Hello! I'm your PostgreSQL assistant. How can I help?" {
		t.Errorf("unexpected streaming content: %q", full)
	}

	// Verify explanation stored.
	if pctx.Result.Explanation != full {
		t.Errorf("expected explanation=%q, got %q", full, pctx.Result.Explanation)
	}

	// Tokens: 21 (classification) + 25 (streaming) = 46.
	if pctx.TokensUsed != 46 {
		t.Errorf("expected 46 tokens, got %d", pctx.TokensUsed)
	}

	// Intent stored.
	intentVal, _ := pctx.Get(ContextKeyIntent)
	if intentVal != IntentConversational {
		t.Errorf("expected intent=conversational, got %v", intentVal)
	}
}

func TestIntentDetection_EmptyMessage(t *testing.T) {
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-test"
	pctx.UserMessage = ""
	pctx.LLMClient = llm.NewClient("test-key")
	pctx.Logger = zap.NewNop()

	step := &IntentDetectionStep{}
	err := step.Execute(context.Background(), pctx)
	if err == nil {
		t.Fatal("expected error for empty message")
	}
	if !strings.Contains(err.Error(), "user_message is required") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestIntentDetection_ClassificationFailure_DefaultsToSQL(t *testing.T) {
	// LLM server that returns 500.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildIntentContext(t, session, llmClient, "hello")

	step := &IntentDetectionStep{}
	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("expected no error on classification failure, got: %v", err)
	}

	// Should default to SQL intent (pipeline continues).
	if pctx.SkipRemaining {
		t.Error("expected SkipRemaining=false when classification fails")
	}

	intentVal, _ := pctx.Get(ContextKeyIntent)
	if intentVal != IntentSQL {
		t.Errorf("expected intent=sql on failure, got %v", intentVal)
	}
}

func TestIntentDetection_Name(t *testing.T) {
	step := &IntentDetectionStep{}
	if step.Name() != "intent_detection" {
		t.Errorf("expected name=intent_detection, got %q", step.Name())
	}
}

func TestIntentDetection_PipelineSkipsStepsAfterConversational(t *testing.T) {
	// Full pipeline test: intent_detection (conversational) should skip schema_grounding.
	chunks := []string{
		makeStreamChunkWithUsage("Hi there!", 10, 5, 15),
	}
	mockLLM := intentLLMServer(t, "conversational", chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	registry := tools.NewRegistry()

	p := agent.NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction(agent.ActionGenerateSQL,
		&IntentDetectionStep{},
		&SchemaGroundingStep{}, // should NOT execute
	)

	reqPayload := websocket.AgentRequestPayload{
		Action:      "generate_sql",
		UserMessage: "thanks",
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-skip-test", "", reqPayload)

	go p.HandleMessage(session, env)

	// Read agent.stream chunk.
	streamEnv := readEnvelope(t, client)
	if streamEnv.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", streamEnv.Type)
	}

	// Read agent.response (no tool.call for list_tables = schema_grounding was skipped).
	respEnv := readEnvelope(t, client)
	if respEnv.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", respEnv.Type)
	}

	var respPayload websocket.AgentResponsePayload
	respEnv.DecodePayload(&respPayload)
	if respPayload.Result.Explanation != "Hi there!" {
		t.Errorf("expected explanation='Hi there!', got %q", respPayload.Result.Explanation)
	}
	// No tool calls should have been made (schema_grounding was skipped).
	if len(respPayload.ToolCallsLog) != 0 {
		t.Errorf("expected 0 tool calls, got %d", len(respPayload.ToolCallsLog))
	}
}
