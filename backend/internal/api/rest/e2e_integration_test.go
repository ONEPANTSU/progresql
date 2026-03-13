package rest

import (
	"bytes"
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

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/llm"
	websocketpkg "github.com/onepantsu/progressql/backend/internal/websocket"
)

// --- Mock LLM server ---

func e2eMockLLMServer(t *testing.T) *httptest.Server {
	t.Helper()
	var callCount int64
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req llm.ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		if req.Stream {
			prompt := ""
			for _, msg := range req.Messages {
				prompt += msg.Content + " "
			}
			promptLower := strings.ToLower(prompt)

			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)

			if strings.Contains(promptLower, "explain") && (strings.Contains(promptLower, "sql query") || strings.Contains(promptLower, "optimiz") || strings.Contains(promptLower, "improvement")) {
				writeSSEChunk(w, "This query ")
				writeSSEChunkWithUsage(w, "performs a scan.\\n\\n```sql\\nSELECT u.id FROM users u LIMIT 50\\n```", 30, 20, 50)
			} else if strings.Contains(promptLower, "analyze") || (strings.Contains(promptLower, "schema") && strings.Contains(promptLower, "overview")) {
				writeSSEChunk(w, "Schema has ")
				writeSSEChunkWithUsage(w, "3 tables with FK relationships.", 40, 25, 65)
			} else {
				writeSSEChunk(w, "Best candidate. ")
				writeSSEChunkWithUsage(w, "```sql\\nSELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY COUNT(o.id) DESC LIMIT 10\\n```", 100, 50, 150)
			}

			fmt.Fprint(w, "data: [DONE]\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return
		}

		// Non-streaming: SQL generation or table selection.
		n := atomic.AddInt64(&callCount, 1)
		content := fmt.Sprintf("SELECT u.name FROM users u LIMIT 10 /* v%d */", n)

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

func writeSSEChunk(w http.ResponseWriter, content string) {
	chunk := fmt.Sprintf(`{"id":"chatcmpl-1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"content":"%s"},"finish_reason":null}]}`, content)
	fmt.Fprintf(w, "data: %s\n\n", chunk)
}

func writeSSEChunkWithUsage(w http.ResponseWriter, content string, prompt, completion, total int) {
	chunk := fmt.Sprintf(`{"id":"chatcmpl-1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"content":"%s"},"finish_reason":"stop"}],"usage":{"prompt_tokens":%d,"completion_tokens":%d,"total_tokens":%d}}`, content, prompt, completion, total)
	fmt.Fprintf(w, "data: %s\n\n", chunk)
}

// --- Tool call handler ---

func e2eHandleToolCall(toolName string, _ json.RawMessage) (any, bool) {
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
		return map[string]any{"functions": []any{}}, true
	default:
		return map[string]string{"error": "unknown tool"}, false
	}
}

// --- WebSocket message helpers ---

func wsReadEnvelope(t *testing.T, conn *ws.Conn) *websocketpkg.Envelope {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	env, err := websocketpkg.ParseEnvelope(msg)
	if err != nil {
		t.Fatalf("parse envelope: %v", err)
	}
	return env
}

func wsSendToolResult(t *testing.T, conn *ws.Conn, requestID, callID string, success bool, data any) {
	t.Helper()
	dataJSON, _ := json.Marshal(data)
	payload := websocketpkg.ToolResultPayload{
		Success: success,
		Data:    dataJSON,
	}
	env, err := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeToolResult, requestID, callID, payload)
	if err != nil {
		t.Fatalf("create tool result: %v", err)
	}
	raw, _ := env.Marshal()
	if err := conn.WriteMessage(ws.TextMessage, raw); err != nil {
		t.Fatalf("ws write: %v", err)
	}
}

// wsHandleToolCalls reads messages, responds to tool.calls, collects streams, returns response.
func wsHandleToolCalls(
	t *testing.T,
	conn *ws.Conn,
	toolHandler func(string, json.RawMessage) (any, bool),
	timeout time.Duration,
) (streams []string, response *websocketpkg.Envelope) {
	t.Helper()
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline)
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		env, err := websocketpkg.ParseEnvelope(msg)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}

		switch env.Type {
		case websocketpkg.TypeToolCall:
			var tc websocketpkg.ToolCallPayload
			env.DecodePayload(&tc)
			data, success := toolHandler(tc.ToolName, tc.Arguments)
			wsSendToolResult(t, conn, env.RequestID, env.CallID, success, data)

		case websocketpkg.TypeAgentStream:
			var sp websocketpkg.AgentStreamPayload
			env.DecodePayload(&sp)
			streams = append(streams, sp.Delta)

		case websocketpkg.TypeAgentResponse:
			return streams, env

		case websocketpkg.TypeAgentError:
			var ep websocketpkg.AgentErrorPayload
			env.DecodePayload(&ep)
			t.Fatalf("agent.error: code=%s message=%s", ep.Code, ep.Message)
		}
	}

	t.Fatal("timed out waiting for agent.response")
	return nil, nil
}

// --- Helper: start full server ---

// startE2EServer creates a full HTTP server with mock LLM and returns all pieces needed for testing.
func startE2EServer(t *testing.T) (serverURL string, cleanup func()) {
	t.Helper()

	mockLLM := e2eMockLLMServer(t)

	cfg := &config.Config{
		ServerPort:       "0", // unused — httptest picks a random port
		JWTSecret:        "test-e2e-jwt-secret-256bits!!",
		OpenRouterAPIKey: "test-openrouter-key",
		Version:          "0.1.0-e2e",
		LogLevel:         "error",
		Environment:      "test",
		RateLimitPerMin:  0, // no rate limiting in tests
	}

	// Override LLM base URL to point to mock.
	hub := websocketpkg.NewHub()
	log := zap.NewNop()

	// Build router manually to inject mock LLM URL.
	// We need to call NewRouter but override the LLM client URL.
	// Since NewRouter creates LLM client internally from config, we set HTTPBaseURL.
	cfg.HTTPBaseURL = mockLLM.URL

	router := NewRouter(cfg, log, hub, testUserStore(t), nil)

	server := httptest.NewServer(router)

	return server.URL, func() {
		server.Close()
		mockLLM.Close()
	}
}

// --- Helper: auth + session + ws connect ---

func e2eObtainJWT(t *testing.T, serverURL string) string {
	t.Helper()
	resp, err := http.Post(serverURL+"/api/v1/auth/token", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("auth/token request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("auth/token: expected 200, got %d", resp.StatusCode)
	}

	var result authTokenResponse
	json.NewDecoder(resp.Body).Decode(&result)
	if result.Token == "" {
		t.Fatal("auth/token returned empty token")
	}
	return result.Token
}

func e2eCreateSession(t *testing.T, serverURL, jwt string) (sessionID, wsURL string) {
	t.Helper()
	body, _ := json.Marshal(createSessionRequest{
		Model:     "test-model",
		DBContext: dbContext{DBName: "testdb", DBVersion: "16.0"},
	})
	req, _ := http.NewRequest(http.MethodPost, serverURL+"/api/v1/sessions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+jwt)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("sessions request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("sessions: expected 201, got %d", resp.StatusCode)
	}

	var result createSessionResponse
	json.NewDecoder(resp.Body).Decode(&result)
	if result.SessionID == "" {
		t.Fatal("sessions returned empty session_id")
	}
	return result.SessionID, result.WSURL
}

func e2eConnectWebSocket(t *testing.T, serverURL, sessionID, jwt string) *ws.Conn {
	t.Helper()
	// Convert http:// to ws://
	wsURL := strings.Replace(serverURL, "http://", "ws://", 1)
	wsURL = fmt.Sprintf("%s/ws/%s?token=%s", wsURL, sessionID, jwt)

	dialer := ws.Dialer{
		HandshakeTimeout: 5 * time.Second,
	}
	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		body := ""
		if resp != nil {
			b := make([]byte, 1024)
			n, _ := resp.Body.Read(b)
			body = string(b[:n])
		}
		t.Fatalf("ws dial: %v (body: %s)", err, body)
	}
	return conn
}

// ============================================================================
// E2E Integration Tests
// ============================================================================

// TestE2EIntegration_HealthEndpoint verifies the health check endpoint works.
func TestE2EIntegration_HealthEndpoint(t *testing.T) {
	serverURL, cleanup := startE2EServer(t)
	defer cleanup()

	resp, err := http.Get(serverURL + "/api/v1/health")
	if err != nil {
		t.Fatalf("health request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result healthResponse
	json.NewDecoder(resp.Body).Decode(&result)
	if result.Status != "ok" {
		t.Errorf("expected status=ok, got %q", result.Status)
	}
	if result.Version != "0.1.0-e2e" {
		t.Errorf("expected version=0.1.0-e2e, got %q", result.Version)
	}
}

// TestE2EIntegration_AuthFlow verifies JWT authentication flow.
func TestE2EIntegration_AuthFlow(t *testing.T) {
	serverURL, cleanup := startE2EServer(t)
	defer cleanup()

	t.Run("valid_api_key", func(t *testing.T) {
		jwt := e2eObtainJWT(t, serverURL)
		if jwt == "" {
			t.Fatal("expected non-empty JWT")
		}
	})

	t.Run("invalid_api_key", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"api_key": "wrong-key"})
		resp, err := http.Post(serverURL+"/api/v1/auth/token", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", resp.StatusCode)
		}
	})
}

// TestE2EIntegration_SessionCreation verifies session creation with JWT.
func TestE2EIntegration_SessionCreation(t *testing.T) {
	serverURL, cleanup := startE2EServer(t)
	defer cleanup()

	t.Run("valid_jwt", func(t *testing.T) {
		jwt := e2eObtainJWT(t, serverURL)
		sessionID, wsURL := e2eCreateSession(t, serverURL, jwt)
		if sessionID == "" {
			t.Fatal("expected non-empty session_id")
		}
		if wsURL == "" {
			t.Fatal("expected non-empty ws_url")
		}
		if !strings.Contains(wsURL, sessionID) {
			t.Errorf("ws_url should contain session_id: %s", wsURL)
		}
	})

	t.Run("no_jwt", func(t *testing.T) {
		body, _ := json.Marshal(createSessionRequest{Model: "test"})
		resp, err := http.Post(serverURL+"/api/v1/sessions", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", resp.StatusCode)
		}
	})
}

// TestE2EIntegration_WebSocketConnect verifies WebSocket upgrade with JWT.
func TestE2EIntegration_WebSocketConnect(t *testing.T) {
	serverURL, cleanup := startE2EServer(t)
	defer cleanup()

	jwt := e2eObtainJWT(t, serverURL)
	sessionID, _ := e2eCreateSession(t, serverURL, jwt)

	t.Run("valid_connect", func(t *testing.T) {
		conn := e2eConnectWebSocket(t, serverURL, sessionID, jwt)
		defer conn.Close()
		// Connection successful — session is active.
	})

	t.Run("invalid_token", func(t *testing.T) {
		wsURL := strings.Replace(serverURL, "http://", "ws://", 1)
		wsURL = fmt.Sprintf("%s/ws/%s?token=%s", wsURL, sessionID, "invalid-jwt")
		_, resp, err := ws.DefaultDialer.Dial(wsURL, nil)
		if err == nil {
			t.Fatal("expected dial to fail with invalid token")
		}
		if resp != nil && resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", resp.StatusCode)
		}
	})

	t.Run("nonexistent_session", func(t *testing.T) {
		wsURL := strings.Replace(serverURL, "http://", "ws://", 1)
		wsURL = fmt.Sprintf("%s/ws/%s?token=%s", wsURL, "nonexistent-id", jwt)
		_, resp, err := ws.DefaultDialer.Dial(wsURL, nil)
		if err == nil {
			t.Fatal("expected dial to fail with nonexistent session")
		}
		if resp != nil && resp.StatusCode != http.StatusNotFound {
			t.Errorf("expected 404, got %d", resp.StatusCode)
		}
	})
}

// TestE2EIntegration_FullCycle_AllFourActions tests the complete flow:
// auth → session → WebSocket → all 4 agent actions.
// This is the core E2E test validating the full client + backend integration.
func TestE2EIntegration_FullCycle_AllFourActions(t *testing.T) {
	serverURL, cleanup := startE2EServer(t)
	defer cleanup()

	// Step 1: Authenticate.
	jwt := e2eObtainJWT(t, serverURL)

	// Step 2: Create session.
	sessionID, _ := e2eCreateSession(t, serverURL, jwt)

	// Step 3: Connect WebSocket.
	conn := e2eConnectWebSocket(t, serverURL, sessionID, jwt)
	defer conn.Close()

	// Step 4: Run all 4 agent actions.
	t.Run("generate_sql", func(t *testing.T) {
		e2eRunGenerateSQL(t, conn)
	})

	t.Run("explain_sql", func(t *testing.T) {
		e2eRunExplainSQL(t, conn)
	})

	t.Run("improve_sql", func(t *testing.T) {
		e2eRunImproveSQL(t, conn)
	})

	t.Run("analyze_schema", func(t *testing.T) {
		e2eRunAnalyzeSchema(t, conn)
	})
}

func e2eRunGenerateSQL(t *testing.T, conn *ws.Conn) {
	t.Helper()

	reqPayload := websocketpkg.AgentRequestPayload{
		Action:      "generate_sql",
		UserMessage: "show top 10 users by order count",
	}
	env, _ := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeAgentRequest, "e2e-gen-1", "", reqPayload)
	raw, _ := env.Marshal()
	conn.WriteMessage(ws.TextMessage, raw)

	streams, resp := wsHandleToolCalls(t, conn, e2eHandleToolCall, 30*time.Second)

	if len(streams) == 0 {
		t.Error("expected agent.stream messages")
	}

	var rp websocketpkg.AgentResponsePayload
	resp.DecodePayload(&rp)

	if rp.Action != "generate_sql" {
		t.Errorf("action: expected generate_sql, got %q", rp.Action)
	}
	if rp.Result.SQL == "" {
		t.Error("expected non-empty SQL")
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation")
	}
	if len(rp.Result.Candidates) == 0 {
		t.Error("expected candidates")
	}
	if len(rp.ToolCallsLog) < 4 {
		t.Errorf("expected at least 4 tool calls, got %d", len(rp.ToolCallsLog))
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("generate_sql OK: SQL=%q, candidates=%d, tokens=%d, tools=%d",
		rp.Result.SQL, len(rp.Result.Candidates), rp.TokensUsed, len(rp.ToolCallsLog))
}

func e2eRunExplainSQL(t *testing.T, conn *ws.Conn) {
	t.Helper()

	reqPayload := websocketpkg.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name",
		},
	}
	env, _ := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeAgentRequest, "e2e-explain-1", "", reqPayload)
	raw, _ := env.Marshal()
	conn.WriteMessage(ws.TextMessage, raw)

	streams, resp := wsHandleToolCalls(t, conn, e2eHandleToolCall, 30*time.Second)

	if len(streams) == 0 {
		t.Error("expected agent.stream messages")
	}

	var rp websocketpkg.AgentResponsePayload
	resp.DecodePayload(&rp)

	if rp.Action != "explain_sql" {
		t.Errorf("action: expected explain_sql, got %q", rp.Action)
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation")
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("explain_sql OK: explanation=%q, tokens=%d", rp.Result.Explanation, rp.TokensUsed)
}

func e2eRunImproveSQL(t *testing.T, conn *ws.Conn) {
	t.Helper()

	reqPayload := websocketpkg.AgentRequestPayload{
		Action: "improve_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT * FROM users JOIN orders ON users.id = orders.user_id",
		},
	}
	env, _ := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeAgentRequest, "e2e-improve-1", "", reqPayload)
	raw, _ := env.Marshal()
	conn.WriteMessage(ws.TextMessage, raw)

	streams, resp := wsHandleToolCalls(t, conn, e2eHandleToolCall, 30*time.Second)

	if len(streams) == 0 {
		t.Error("expected agent.stream messages")
	}

	var rp websocketpkg.AgentResponsePayload
	resp.DecodePayload(&rp)

	if rp.Action != "improve_sql" {
		t.Errorf("action: expected improve_sql, got %q", rp.Action)
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation")
	}
	// improve_sql should have at least 1 tool call (explain_query).
	foundExplain := false
	for _, tc := range rp.ToolCallsLog {
		if tc.ToolName == "explain_query" {
			foundExplain = true
			break
		}
	}
	if !foundExplain {
		t.Error("expected explain_query in tool_calls_log")
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("improve_sql OK: explanation=%q, sql=%q, tokens=%d, tools=%d",
		rp.Result.Explanation, rp.Result.SQL, rp.TokensUsed, len(rp.ToolCallsLog))
}

func e2eRunAnalyzeSchema(t *testing.T, conn *ws.Conn) {
	t.Helper()

	reqPayload := websocketpkg.AgentRequestPayload{
		Action: "analyze_schema",
	}
	env, _ := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeAgentRequest, "e2e-analyze-1", "", reqPayload)
	raw, _ := env.Marshal()
	conn.WriteMessage(ws.TextMessage, raw)

	streams, resp := wsHandleToolCalls(t, conn, e2eHandleToolCall, 30*time.Second)

	if len(streams) == 0 {
		t.Error("expected agent.stream messages")
	}

	var rp websocketpkg.AgentResponsePayload
	resp.DecodePayload(&rp)

	if rp.Action != "analyze_schema" {
		t.Errorf("action: expected analyze_schema, got %q", rp.Action)
	}
	if rp.Result.Explanation == "" {
		t.Error("expected non-empty explanation")
	}
	// analyze_schema should have list_schemas + list_tables + describe_table calls.
	expectedTools := map[string]bool{"list_schemas": false, "list_tables": false, "describe_table": false}
	for _, tc := range rp.ToolCallsLog {
		expectedTools[tc.ToolName] = true
	}
	for tool, found := range expectedTools {
		if !found {
			t.Errorf("expected %s in tool_calls_log", tool)
		}
	}
	if rp.TokensUsed == 0 {
		t.Error("expected non-zero tokens_used")
	}
	if rp.ModelUsed == "" {
		t.Error("expected non-empty model_used")
	}

	t.Logf("analyze_schema OK: explanation=%q, tokens=%d, tools=%d",
		rp.Result.Explanation, rp.TokensUsed, len(rp.ToolCallsLog))
}

// TestE2EIntegration_MetricsEndpoint verifies metrics are collected after agent requests.
func TestE2EIntegration_MetricsEndpoint(t *testing.T) {
	serverURL, cleanup := startE2EServer(t)
	defer cleanup()

	// Run one request through the full cycle.
	jwt := e2eObtainJWT(t, serverURL)
	sessionID, _ := e2eCreateSession(t, serverURL, jwt)
	conn := e2eConnectWebSocket(t, serverURL, sessionID, jwt)
	defer conn.Close()

	// Send explain_sql (simplest action).
	reqPayload := websocketpkg.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT 1",
		},
	}
	env, _ := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeAgentRequest, "e2e-metrics-1", "", reqPayload)
	raw, _ := env.Marshal()
	conn.WriteMessage(ws.TextMessage, raw)
	wsHandleToolCalls(t, conn, e2eHandleToolCall, 30*time.Second)

	// Check metrics endpoint.
	resp, err := http.Get(serverURL + "/api/v1/metrics")
	if err != nil {
		t.Fatalf("metrics request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var metricsResult map[string]any
	json.NewDecoder(resp.Body).Decode(&metricsResult)

	totalRequests, ok := metricsResult["total_requests"].(float64)
	if !ok || totalRequests < 1 {
		t.Errorf("expected total_requests >= 1, got %v", metricsResult["total_requests"])
	}
	totalTokens, ok := metricsResult["total_tokens"].(float64)
	if !ok || totalTokens < 1 {
		t.Errorf("expected total_tokens >= 1, got %v", metricsResult["total_tokens"])
	}

	t.Logf("metrics OK: total_requests=%v, total_tokens=%v", totalRequests, totalTokens)
}

// TestE2EIntegration_InvalidActionError verifies that an invalid action returns agent.error.
func TestE2EIntegration_InvalidActionError(t *testing.T) {
	serverURL, cleanup := startE2EServer(t)
	defer cleanup()

	jwt := e2eObtainJWT(t, serverURL)
	sessionID, _ := e2eCreateSession(t, serverURL, jwt)
	conn := e2eConnectWebSocket(t, serverURL, sessionID, jwt)
	defer conn.Close()

	reqPayload := websocketpkg.AgentRequestPayload{
		Action: "nonexistent_action",
	}
	env, _ := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeAgentRequest, "e2e-invalid-1", "", reqPayload)
	raw, _ := env.Marshal()
	conn.WriteMessage(ws.TextMessage, raw)

	// Should receive agent.error.
	errEnv := wsReadEnvelope(t, conn)
	if errEnv.Type != websocketpkg.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", errEnv.Type)
	}

	var ep websocketpkg.AgentErrorPayload
	errEnv.DecodePayload(&ep)
	if ep.Code != websocketpkg.ErrCodeInvalidRequest {
		t.Errorf("expected code=%s, got %s", websocketpkg.ErrCodeInvalidRequest, ep.Code)
	}
	if ep.Message == "" {
		t.Error("expected non-empty error message")
	}

	t.Logf("invalid action error OK: code=%s, message=%s", ep.Code, ep.Message)
}
