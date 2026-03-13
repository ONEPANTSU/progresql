package agent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

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

func TestStreamLLM_ForwardsChunksToClient(t *testing.T) {
	// Set up SSE mock server with 3 chunks.
	chunks := []string{
		makeStreamChunkJSON("Hello"),
		makeStreamChunkJSON(", "),
		makeStreamChunkWithUsage("world!", 10, 5, 15),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	registry := tools.NewRegistry()

	pctx := NewPipelineContext()
	pctx.RequestID = "stream-req-1"
	pctx.Session = session
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = registry
	pctx.Logger = zap.NewNop()

	req := llm.ChatRequest{
		Model:    "test-model",
		Messages: []llm.Message{{Role: "user", Content: "test"}},
	}

	// Run StreamLLM in a goroutine.
	errCh := make(chan error, 1)
	var resp *llm.ChatResponse
	go func() {
		var err error
		resp, err = pctx.StreamLLM(context.Background(), req)
		errCh <- err
	}()

	// Read 3 agent.stream messages from client.
	var deltas []string
	for i := 0; i < 3; i++ {
		env := readEnvelope(t, client)
		if env.Type != websocket.TypeAgentStream {
			t.Fatalf("chunk %d: expected agent.stream, got %s", i, env.Type)
		}
		if env.RequestID != "stream-req-1" {
			t.Fatalf("chunk %d: expected request_id=stream-req-1, got %s", i, env.RequestID)
		}
		var payload websocket.AgentStreamPayload
		if err := env.DecodePayload(&payload); err != nil {
			t.Fatalf("chunk %d: decode: %v", i, err)
		}
		deltas = append(deltas, payload.Delta)
	}

	// Wait for StreamLLM to finish.
	if err := <-errCh; err != nil {
		t.Fatalf("StreamLLM error: %v", err)
	}

	// Verify delta concatenation.
	full := strings.Join(deltas, "")
	if full != "Hello, world!" {
		t.Errorf("expected 'Hello, world!', got %q", full)
	}

	// Verify aggregated response.
	if resp == nil {
		t.Fatal("expected non-nil response")
	}
	if len(resp.Choices) == 0 || resp.Choices[0].Message.Content != "Hello, world!" {
		t.Errorf("expected aggregated content 'Hello, world!', got %q", resp.Choices[0].Message.Content)
	}

	// Verify tokens tracked.
	if pctx.TokensUsed != 15 {
		t.Errorf("expected tokens=15, got %d", pctx.TokensUsed)
	}
	if pctx.ModelUsed != "test-model" {
		t.Errorf("expected model=test-model, got %q", pctx.ModelUsed)
	}
}

func TestStreamLLM_EmptyDeltaNotForwarded(t *testing.T) {
	// Mix of empty and non-empty deltas.
	chunks := []string{
		`{"id":"r","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
		makeStreamChunkJSON("content"),
		`{"id":"r","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))

	pctx := NewPipelineContext()
	pctx.RequestID = "stream-req-2"
	pctx.Session = session
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	req := llm.ChatRequest{
		Model:    "m",
		Messages: []llm.Message{{Role: "user", Content: "test"}},
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := pctx.StreamLLM(context.Background(), req)
		errCh <- err
	}()

	// Should only receive 1 agent.stream (the non-empty one).
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", env.Type)
	}
	var payload websocket.AgentStreamPayload
	env.DecodePayload(&payload)
	if payload.Delta != "content" {
		t.Errorf("expected delta='content', got %q", payload.Delta)
	}

	if err := <-errCh; err != nil {
		t.Fatalf("StreamLLM error: %v", err)
	}
}

func TestStreamLLM_LLMError_ReturnsError(t *testing.T) {
	// SSE server that returns 500.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))

	pctx := NewPipelineContext()
	pctx.RequestID = "stream-req-3"
	pctx.Session = session
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	req := llm.ChatRequest{
		Model:    "m",
		Messages: []llm.Message{{Role: "user", Content: "test"}},
	}

	_, err := pctx.StreamLLM(context.Background(), req)
	if err == nil {
		t.Fatal("expected error from LLM 500")
	}
	if !strings.Contains(err.Error(), "LLM streaming failed") {
		t.Errorf("expected 'LLM streaming failed' in error, got %q", err.Error())
	}
}

func TestStreamLLM_IntegrationWithPipeline(t *testing.T) {
	// Test that a pipeline step can use StreamLLM and client receives
	// agent.stream chunks followed by agent.response.
	chunks := []string{
		makeStreamChunkJSON("SELECT "),
		makeStreamChunkWithUsage("1", 5, 3, 8),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	registry := tools.NewRegistry()

	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	streamStep := &mockStep{
		name: "stream_step",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			req := llm.ChatRequest{
				Model:    "test-model",
				Messages: []llm.Message{{Role: "user", Content: "generate SQL"}},
			}
			resp, err := pctx.StreamLLM(ctx, req)
			if err != nil {
				return err
			}
			pctx.Result.SQL = resp.Choices[0].Message.Content
			return nil
		},
	}

	p.RegisterAction("stream_action", streamStep)

	reqPayload := websocket.AgentRequestPayload{
		Action:      "stream_action",
		UserMessage: "test",
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-stream", "", reqPayload)

	go p.HandleMessage(session, env)

	// Read 2 agent.stream chunks.
	for i := 0; i < 2; i++ {
		streamEnv := readEnvelope(t, client)
		if streamEnv.Type != websocket.TypeAgentStream {
			t.Fatalf("chunk %d: expected agent.stream, got %s", i, streamEnv.Type)
		}
		if streamEnv.RequestID != "req-stream" {
			t.Fatalf("chunk %d: expected request_id=req-stream, got %s", i, streamEnv.RequestID)
		}
	}

	// Read agent.response.
	respEnv := readEnvelope(t, client)
	if respEnv.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", respEnv.Type)
	}

	var respPayload websocket.AgentResponsePayload
	respEnv.DecodePayload(&respPayload)
	if respPayload.Result.SQL != "SELECT 1" {
		t.Errorf("expected SQL='SELECT 1', got %q", respPayload.Result.SQL)
	}
	if respPayload.TokensUsed != 8 {
		t.Errorf("expected tokens=8, got %d", respPayload.TokensUsed)
	}
}

func TestStreamLLM_NoChoices_SkipsForwarding(t *testing.T) {
	// Chunk with no choices should not be forwarded.
	chunks := []string{
		`{"id":"r","model":"m","choices":[]}`,
		makeStreamChunkWithUsage("done", 1, 1, 2),
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))

	pctx := NewPipelineContext()
	pctx.RequestID = "stream-req-nc"
	pctx.Session = session
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	req := llm.ChatRequest{
		Model:    "m",
		Messages: []llm.Message{{Role: "user", Content: "test"}},
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := pctx.StreamLLM(context.Background(), req)
		errCh <- err
	}()

	// Only the "done" chunk should arrive.
	env := readEnvelope(t, client)
	if env.Type != websocket.TypeAgentStream {
		t.Fatalf("expected agent.stream, got %s", env.Type)
	}
	var payload websocket.AgentStreamPayload
	env.DecodePayload(&payload)
	if payload.Delta != "done" {
		t.Errorf("expected delta='done', got %q", payload.Delta)
	}

	// Verify no more messages arrive within a short window.
	client.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, err := client.ReadMessage()
	if err == nil {
		t.Error("expected no more messages, but got one")
	}

	if err := <-errCh; err != nil {
		t.Fatalf("StreamLLM error: %v", err)
	}
}

func TestStreamLLM_SessionClosed_ReturnsError(t *testing.T) {
	// Many chunks to ensure the callback fires after session close.
	var chunks []string
	for i := 0; i < 20; i++ {
		chunks = append(chunks, makeStreamChunkJSON(fmt.Sprintf("chunk%d", i)))
	}
	mockLLM := sseServer(t, chunks)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	// Close both client and session to ensure SendEnvelope fails.
	client.Close()
	session.Close()
	time.Sleep(100 * time.Millisecond)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))

	pctx := NewPipelineContext()
	pctx.RequestID = "stream-close"
	pctx.Session = session
	pctx.LLMClient = llmClient
	pctx.Logger = zap.NewNop()

	req := llm.ChatRequest{
		Model:    "m",
		Messages: []llm.Message{{Role: "user", Content: "test"}},
	}

	_, err := pctx.StreamLLM(context.Background(), req)
	if err == nil {
		t.Fatal("expected error when session is closed")
	}
}
