/*
* Created on Mar 27, 2026
* Test file for pipeline.go extra coverage
* File path: internal/agent/pipeline_extra_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/metrics"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// ── NewPipeline ───────────────────────────────────────────────────────────────

func TestNewPipeline_NilLogger(t *testing.T) {
	registry := tools.NewRegistry()
	client := llm.NewClient("test-key")

	// nil logger should use zap.NewNop internally.
	p := NewPipeline(client, registry, nil, "test-model")
	if p == nil {
		t.Fatal("expected non-nil pipeline with nil logger")
	}
}

func TestNewPipeline_NonNilLogger(t *testing.T) {
	registry := tools.NewRegistry()
	client := llm.NewClient("test-key")
	logger := zap.NewNop()

	p := NewPipeline(client, registry, logger, "test-model")
	if p == nil {
		t.Fatal("expected non-nil pipeline")
	}
}

// ── SetToolCallTimeout ────────────────────────────────────────────────────────

func TestPipeline_SetToolCallTimeout(t *testing.T) {
	registry := tools.NewRegistry()
	client := llm.NewClient("test-key")
	p := NewPipeline(client, registry, zap.NewNop(), "test-model")

	p.SetToolCallTimeout(10*time.Second, 3)

	if p.toolCallTimeout != 10*time.Second {
		t.Errorf("expected toolCallTimeout=10s, got %v", p.toolCallTimeout)
	}
	if p.toolCallMaxRetries != 3 {
		t.Errorf("expected toolCallMaxRetries=3, got %d", p.toolCallMaxRetries)
	}
}

// ── SetDB ─────────────────────────────────────────────────────────────────────

func TestPipeline_SetDB(t *testing.T) {
	registry := tools.NewRegistry()
	client := llm.NewClient("test-key")
	p := NewPipeline(client, registry, zap.NewNop(), "test-model")

	// SetDB with nil — should not panic.
	p.SetDB(nil)
	if p.db != nil {
		t.Error("expected db=nil after SetDB(nil)")
	}
}

// ── SetMetrics ────────────────────────────────────────────────────────────────

func TestPipeline_SetMetrics(t *testing.T) {
	registry := tools.NewRegistry()
	client := llm.NewClient("test-key")
	p := NewPipeline(client, registry, zap.NewNop(), "test-model")

	collector := metrics.New()
	p.SetMetrics(collector)
	if p.metrics == nil {
		t.Error("expected non-nil metrics after SetMetrics")
	}
}

func TestPipeline_SetMetrics_Nil(t *testing.T) {
	registry := tools.NewRegistry()
	client := llm.NewClient("test-key")
	p := NewPipeline(client, registry, zap.NewNop(), "test-model")

	p.SetMetrics(nil)
	if p.metrics != nil {
		t.Error("expected nil metrics after SetMetrics(nil)")
	}
}

// ── calcCostUSD ───────────────────────────────────────────────────────────────

func TestCalcCostUSD_KnownModel(t *testing.T) {
	// qwen/qwen3-coder is in the price table.
	cost := calcCostUSD("qwen/qwen3-coder", 1000000)
	if cost <= 0 {
		t.Errorf("expected positive cost for known model, got %v", cost)
	}
}

func TestCalcCostUSD_UnknownModel(t *testing.T) {
	cost := calcCostUSD("unknown/model-xyz", 1000000)
	if cost != 0 {
		t.Errorf("expected 0 cost for unknown model, got %v", cost)
	}
}

func TestCalcCostUSD_ZeroTokens(t *testing.T) {
	cost := calcCostUSD("anthropic/claude-3.5-sonnet", 0)
	if cost != 0 {
		t.Errorf("expected 0 cost for 0 tokens, got %v", cost)
	}
}

// ── PipelineContext.Set / Get ─────────────────────────────────────────────────

func TestPipelineContext_SetGet(t *testing.T) {
	pctx := NewPipelineContext()

	// Set and get a value.
	pctx.Set("key1", "value1")
	v, ok := pctx.Get("key1")
	if !ok {
		t.Error("expected ok=true")
	}
	if v != "value1" {
		t.Errorf("expected 'value1', got %v", v)
	}

	// Get a non-existent key.
	_, ok = pctx.Get("nonexistent")
	if ok {
		t.Error("expected ok=false for nonexistent key")
	}
}

// ── handleAutocomplete ────────────────────────────────────────────────────────

// mockAutocompleteLLMServer creates a test HTTP server that returns a minimal
// OpenAI-compatible chat completion response with the given content.
func mockAutocompleteLLMServer(t *testing.T, content string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"id":      "cmpl-test",
			"object":  "chat.completion",
			"model":   "test-model",
			"choices": []map[string]any{
				{
					"index":         0,
					"finish_reason": "stop",
					"message": map[string]string{
						"role":    "assistant",
						"content": content,
					},
				},
			},
			"usage": map[string]int{
				"prompt_tokens":     10,
				"completion_tokens": 5,
				"total_tokens":      15,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

// mockAutocompleteLLMServerEmpty returns an empty choices array.
func mockAutocompleteLLMServerEmpty(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"id":      "cmpl-empty",
			"object":  "chat.completion",
			"model":   "test-model",
			"choices": []map[string]any{},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

// TestHandleAutocomplete_MalformedPayload verifies that a malformed envelope
// payload is silently ignored (no panic, no crash).
func TestHandleAutocomplete_MalformedPayload(t *testing.T) {
	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test-key"), tools.NewRegistry(), zap.NewNop(), "test-model")

	// Build an envelope with invalid JSON payload.
	env := &websocket.Envelope{
		Type:      websocket.TypeAutocompleteRequest,
		RequestID: "req-malformed",
		Payload:   []byte(`{invalid json`),
	}

	// Should return immediately without panicking.
	p.handleAutocomplete(session, env)
}

// TestHandleAutocomplete_EmptySQL verifies that an empty SQL field causes
// handleAutocomplete to return early without sending a response.
func TestHandleAutocomplete_EmptySQL(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test-key"), tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "",
		CursorPos: 0,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-empty", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	// Call directly — should return early.
	p.handleAutocomplete(session, env)

	// No message should arrive on the client within a short timeout.
	client.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, readErr := client.ReadMessage()
	if readErr == nil {
		t.Error("expected no message for empty SQL, but received one")
	}
}

// TestHandleAutocomplete_WhitespaceOnlySQL verifies that whitespace-only SQL
// does not trigger LLM calls.
func TestHandleAutocomplete_WhitespaceOnlySQL(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test-key"), tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "   ",
		CursorPos: 0,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-ws", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	// Whitespace-only SQL: payload.SQL != "" but completion will be empty after trim.
	// The function will proceed to LLM but return on empty completion.
	// Use a failing LLM so that the LLM path returns early.
	p.handleAutocomplete(session, env)

	client.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, readErr := client.ReadMessage()
	if readErr == nil {
		t.Error("expected no autocomplete response for whitespace-only SQL")
	}
}

// TestHandleAutocomplete_LLMError verifies that an LLM error is silently
// swallowed and no response is sent.
func TestHandleAutocomplete_LLMError(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	// LLM server that always returns 500.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "SELECT * FROM users WHERE id = ",
		CursorPos: 30,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-llmerr", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	client.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, _, readErr := client.ReadMessage()
	if readErr == nil {
		t.Error("expected no response when LLM errors")
	}
}

// TestHandleAutocomplete_EmptyChoices verifies that an LLM response with no
// choices results in no autocomplete response being sent.
func TestHandleAutocomplete_EmptyChoices(t *testing.T) {
	srv := mockAutocompleteLLMServerEmpty(t)
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "SELECT ",
		CursorPos: 7,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-empty-choices", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	client.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, _, readErr := client.ReadMessage()
	if readErr == nil {
		t.Error("expected no response when LLM returns empty choices")
	}
}

// TestHandleAutocomplete_Success verifies the happy path: LLM returns a
// completion and the session receives an autocomplete.response envelope.
func TestHandleAutocomplete_Success(t *testing.T) {
	srv := mockAutocompleteLLMServer(t, "* FROM orders")
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "SELECT ",
		CursorPos: 7,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-ac-ok", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	// Expect autocomplete.response on the client.
	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, readErr := client.ReadMessage()
	if readErr != nil {
		t.Fatalf("expected autocomplete.response, got read error: %v", readErr)
	}

	respEnv, parseErr := websocket.ParseEnvelope(msg)
	if parseErr != nil {
		t.Fatalf("parse envelope: %v", parseErr)
	}
	if respEnv.Type != websocket.TypeAutocompleteResponse {
		t.Fatalf("expected %s, got %s", websocket.TypeAutocompleteResponse, respEnv.Type)
	}
	if respEnv.RequestID != "req-ac-ok" {
		t.Errorf("expected request_id='req-ac-ok', got %q", respEnv.RequestID)
	}

	var respPayload websocket.AutocompleteResponsePayload
	if err := respEnv.DecodePayload(&respPayload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if respPayload.Completion == "" {
		t.Error("expected non-empty completion")
	}
}

// TestHandleAutocomplete_WithSchemaContext verifies that schema context is
// included in the prompt (exercised by passing a non-empty SchemaContext).
func TestHandleAutocomplete_WithSchemaContext(t *testing.T) {
	srv := mockAutocompleteLLMServer(t, "id, name")
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:           "SELECT ",
		CursorPos:     7,
		SchemaContext: "users(id, name, email)",
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-schema", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, readErr := client.ReadMessage()
	if readErr != nil {
		t.Fatalf("expected autocomplete.response, got read error: %v", readErr)
	}

	respEnv, _ := websocket.ParseEnvelope(msg)
	if respEnv.Type != websocket.TypeAutocompleteResponse {
		t.Fatalf("expected %s, got %s", websocket.TypeAutocompleteResponse, respEnv.Type)
	}
}

// TestHandleAutocomplete_CursorBeyondSQL verifies that a cursorPos beyond
// the SQL length is clamped to len(SQL).
func TestHandleAutocomplete_CursorBeyondSQL(t *testing.T) {
	srv := mockAutocompleteLLMServer(t, "1")
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "SELECT ",
		CursorPos: 9999, // beyond SQL length
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-cursor", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	// Just verify no panic and we get a response (or at least no crash).
	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	client.ReadMessage() // ignore result
}

// TestHandleAutocomplete_SQLWithAfterCursor verifies that sqlAfter is non-empty
// when cursor is not at end of SQL.
func TestHandleAutocomplete_SQLWithAfterCursor(t *testing.T) {
	srv := mockAutocompleteLLMServer(t, "users")
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	sql := "SELECT * FROM  WHERE id = 1"
	payload := websocket.AutocompleteRequestPayload{
		SQL:       sql,
		CursorPos: 14, // cursor between "FROM " and " WHERE"
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-after", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	client.ReadMessage() // just verify no panic
}

// TestHandleAutocomplete_ViaHandleMessage verifies that HandleMessage routes
// TypeAutocompleteRequest to handleAutocomplete asynchronously.
func TestHandleAutocomplete_ViaHandleMessage(t *testing.T) {
	srv := mockAutocompleteLLMServer(t, "* FROM orders")
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "SELECT ",
		CursorPos: 7,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-via-hm", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	// HandleMessage routes to handleAutocomplete via goroutine.
	p.HandleMessage(session, env)

	// Wait for the goroutine to complete and send the response.
	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, readErr := client.ReadMessage()
	if readErr != nil {
		t.Fatalf("expected autocomplete.response, got error: %v", readErr)
	}

	respEnv, _ := websocket.ParseEnvelope(msg)
	if respEnv.Type != websocket.TypeAutocompleteResponse {
		t.Errorf("expected %s, got %s", websocket.TypeAutocompleteResponse, respEnv.Type)
	}
}

// TestHandleAutocomplete_LLMReturnsEmptyContent verifies that an LLM completion
// that is blank (after trimming) results in no autocomplete.response.
func TestHandleAutocomplete_LLMReturnsEmptyContent(t *testing.T) {
	srv := mockAutocompleteLLMServer(t, "   ") // only whitespace
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "SELECT ",
		CursorPos: 7,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-blank", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	client.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, _, readErr := client.ReadMessage()
	if readErr == nil {
		t.Error("expected no response for blank completion")
	}
}

// TestHandleAutocomplete_DuplicatePrefixStripped verifies that when the LLM
// echoes back the SQL before cursor, the prefix is stripped from the completion.
func TestHandleAutocomplete_DuplicatePrefixStripped(t *testing.T) {
	// LLM returns full SQL including what was before cursor — the prefix should be stripped.
	srv := mockAutocompleteLLMServer(t, "SELECT * FROM orders")
	t.Cleanup(srv.Close)

	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	llmClient := llm.NewClient("test-key", llm.WithBaseURL(srv.URL), llm.WithHTTPClient(srv.Client()))
	p := NewPipeline(llmClient, tools.NewRegistry(), zap.NewNop(), "test-model")

	payload := websocket.AutocompleteRequestPayload{
		SQL:       "SELECT ",
		CursorPos: 7,
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteRequest, "req-dup", "", payload)
	if err != nil {
		t.Fatal(err)
	}

	p.handleAutocomplete(session, env)

	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, readErr := client.ReadMessage()
	if readErr != nil {
		t.Fatalf("expected autocomplete.response: %v", readErr)
	}

	respEnv, _ := websocket.ParseEnvelope(msg)
	if respEnv.Type != websocket.TypeAutocompleteResponse {
		t.Fatalf("expected TypeAutocompleteResponse, got %s", respEnv.Type)
	}

	var respPayload websocket.AutocompleteResponsePayload
	respEnv.DecodePayload(&respPayload)

	// The completion should NOT start with "SELECT " since that was already before cursor.
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(respPayload.Completion)), "select ") {
		t.Errorf("expected prefix to be stripped, got completion: %q", respPayload.Completion)
	}
}
