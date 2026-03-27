package rest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/testutil"
	websocketpkg "github.com/onepantsu/progressql/backend/internal/websocket"
)

func testUserStore(t *testing.T) *auth.UserStore {
	t.Helper()
	return auth.NewUserStore(nil)
}

// startTestServer creates a test server using testutil infrastructure.
func startTestServer(t *testing.T) (serverURL string, cleanup func()) {
	t.Helper()
	mockLLM := testutil.NewPipelineMockLLMServer(t)
	cfg := testutil.NewTestConfig(mockLLM.URL)
	hub := websocketpkg.NewHub()
	router := NewRouter(cfg, zap.NewNop(), hub, testUserStore(t), nil)
	server := httptest.NewServer(router)
	return server.URL, func() {
		server.Close()
		mockLLM.Close()
	}
}

// TestAPI_ModelsEndpoint verifies GET /api/v1/models returns model list with is_default flag.
func TestAPI_ModelsEndpoint(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	t.Run("returns_model_list", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/v1/models")
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
			t.Errorf("expected application/json, got %q", ct)
		}

		var body struct {
			Models []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				Provider  string `json:"provider"`
				IsDefault bool   `json:"is_default"`
			} `json:"models"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}

		if len(body.Models) == 0 {
			t.Fatal("expected non-empty models list")
		}

		// Exactly one model should be marked as default.
		defaultCount := 0
		for _, m := range body.Models {
			if m.IsDefault {
				defaultCount++
				if m.ID != "qwen/qwen3-coder" {
					t.Errorf("expected default model=qwen/qwen3-coder, got %q", m.ID)
				}
			}
			if m.ID == "" || m.Name == "" || m.Provider == "" {
				t.Errorf("model has empty fields: %+v", m)
			}
		}
		if defaultCount != 1 {
			t.Errorf("expected exactly 1 default model, got %d", defaultCount)
		}
	})

	t.Run("has_cors_headers", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, serverURL+"/api/v1/models", nil)
		req.Header.Set("Origin", "http://localhost:3000")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()

		if acao := resp.Header.Get("Access-Control-Allow-Origin"); acao != "http://localhost:3000" {
			t.Errorf("expected CORS origin, got %q", acao)
		}
	})
}

// TestAPI_CORSHeaders verifies that CORS headers are set correctly.
func TestAPI_CORSHeaders(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	t.Run("preflight_options", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodOptions, serverURL+"/api/v1/health", nil)
		req.Header.Set("Origin", "http://localhost:3000")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusNoContent {
			t.Errorf("expected 204, got %d", resp.StatusCode)
		}
		if acao := resp.Header.Get("Access-Control-Allow-Origin"); acao != "http://localhost:3000" {
			t.Errorf("expected ACAO=http://localhost:3000, got %q", acao)
		}
		if acam := resp.Header.Get("Access-Control-Allow-Methods"); acam == "" {
			t.Error("expected Access-Control-Allow-Methods to be set")
		}
	})

	t.Run("cors_on_get", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, serverURL+"/api/v1/health", nil)
		req.Header.Set("Origin", "http://localhost:5173")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		if acao := resp.Header.Get("Access-Control-Allow-Origin"); acao != "http://localhost:5173" {
			t.Errorf("expected ACAO=http://localhost:5173, got %q", acao)
		}
	})

	t.Run("no_cors_without_origin", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/v1/health")
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()

		if acao := resp.Header.Get("Access-Control-Allow-Origin"); acao != "" {
			t.Errorf("expected no ACAO header without Origin, got %q", acao)
		}
	})
}

// TestAPI_AuthTokenValidation tests the auth token endpoint.
func TestAPI_AuthTokenValidation(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	t.Run("issues_jwt_without_api_key", func(t *testing.T) {
		resp, err := http.Post(serverURL+"/api/v1/auth/token", "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("expected 200, got %d", resp.StatusCode)
		}
	})

	t.Run("jwt_contains_unique_session_id", func(t *testing.T) {
		// Two tokens should have different session_ids.
		jwt1 := testutil.ObtainJWT(t, serverURL)
		jwt2 := testutil.ObtainJWT(t, serverURL)
		if jwt1 == jwt2 {
			t.Error("expected different JWTs for different requests")
		}
	})
}

// TestAPI_SessionModelPassthrough verifies that the model from session creation
// is passed through to the pipeline context.
func TestAPI_SessionModelPassthrough(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	jwt := testutil.ObtainJWT(t, serverURL)

	// Create session with specific model.
	body, _ := json.Marshal(map[string]any{
		"model":      "anthropic/claude-sonnet-4",
		"db_context": map[string]string{"db_name": "testdb", "db_version": "16.0"},
	})
	req, _ := http.NewRequest(http.MethodPost, serverURL+"/api/v1/sessions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+jwt)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}

	var result createSessionResponse
	json.NewDecoder(resp.Body).Decode(&result)
	if result.SessionID == "" {
		t.Fatal("expected session_id")
	}
	if !strings.Contains(result.WSURL, result.SessionID) {
		t.Error("ws_url should contain session_id")
	}
}

// TestAPI_MultipleSessions verifies that multiple concurrent sessions work independently.
func TestAPI_MultipleSessions(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	const numSessions = 3
	var wg sync.WaitGroup
	sessionIDs := make([]string, numSessions)
	conns := make([]*ws.Conn, numSessions)

	// Create sessions concurrently.
	for i := 0; i < numSessions; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			conn, sid := testutil.FullConnect(t, serverURL)
			sessionIDs[idx] = sid
			conns[idx] = conn
		}(i)
	}
	wg.Wait()

	// Verify all sessions are unique.
	seen := make(map[string]bool)
	for _, sid := range sessionIDs {
		if seen[sid] {
			t.Errorf("duplicate session_id: %s", sid)
		}
		seen[sid] = true
	}

	// Clean up connections.
	for _, conn := range conns {
		if conn != nil {
			conn.Close()
		}
	}
}

// TestAPI_ToolCallCorrelation verifies that tool.call and tool.result are properly
// correlated via call_id through the full API stack.
func TestAPI_ToolCallCorrelation(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	conn, _ := testutil.FullConnect(t, serverURL)
	defer conn.Close()

	// Send explain_sql — this triggers streaming without tool calls.
	testutil.SendAgentRequest(t, conn, "corr-test-1", websocketpkg.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT 1",
		},
	})

	streams, resp := testutil.HandleToolCalls(t, conn, testutil.ToolHandler, 30*time.Second)
	if len(streams) == 0 {
		t.Error("expected streaming chunks")
	}
	if resp.Type != websocketpkg.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	if resp.RequestID != "corr-test-1" {
		t.Errorf("expected request_id=corr-test-1, got %q", resp.RequestID)
	}
}

// TestAPI_ToolCallDispatchAndResult tests the full tool.call → tool.result cycle
// through the real API stack, verifying call_id correlation.
func TestAPI_ToolCallDispatchAndResult(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	conn, _ := testutil.FullConnect(t, serverURL)
	defer conn.Close()

	// Send improve_sql — this triggers at least one tool.call (explain_query).
	testutil.SendAgentRequest(t, conn, "tool-test-1", websocketpkg.AgentRequestPayload{
		Action: "improve_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT * FROM users",
		},
	})

	// Manually handle messages to verify tool.call has proper call_id.
	deadline := time.Now().Add(30 * time.Second)
	var seenToolCallIDs []string

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
			if env.CallID == "" {
				t.Error("tool.call must have non-empty call_id")
			}
			if env.RequestID != "tool-test-1" {
				t.Errorf("tool.call request_id: expected tool-test-1, got %q", env.RequestID)
			}
			seenToolCallIDs = append(seenToolCallIDs, env.CallID)

			var tc websocketpkg.ToolCallPayload
			env.DecodePayload(&tc)
			data, success := testutil.ToolHandler(tc.ToolName, tc.Arguments)
			testutil.SendToolResult(t, conn, env.RequestID, env.CallID, success, data)

		case websocketpkg.TypeAgentStream:
			// Skip streaming chunks.

		case websocketpkg.TypeAgentResponse:
			var rp websocketpkg.AgentResponsePayload
			env.DecodePayload(&rp)

			if len(seenToolCallIDs) == 0 {
				t.Error("expected at least one tool.call before agent.response")
			}

			// Verify each tool call is logged.
			for _, tc := range rp.ToolCallsLog {
				if tc.CallID == "" {
					t.Error("tool_calls_log entry has empty call_id")
				}
			}
			return

		case websocketpkg.TypeAgentError:
			var ep websocketpkg.AgentErrorPayload
			env.DecodePayload(&ep)
			t.Fatalf("unexpected agent.error: code=%s message=%s", ep.Code, ep.Message)
		}
	}
	t.Fatal("timed out")
}

// TestAPI_InvalidActionReturnsError verifies that unknown actions return agent.error
// with the correct error code.
func TestAPI_InvalidActionReturnsError(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	conn, _ := testutil.FullConnect(t, serverURL)
	defer conn.Close()

	testutil.SendAgentRequest(t, conn, "err-test-1", websocketpkg.AgentRequestPayload{
		Action: "nonexistent_action",
	})

	env := testutil.ReadEnvelope(t, conn)
	if env.Type != websocketpkg.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", env.Type)
	}

	var ep websocketpkg.AgentErrorPayload
	env.DecodePayload(&ep)
	if ep.Code != websocketpkg.ErrCodeInvalidRequest {
		t.Errorf("expected code=%s, got %s", websocketpkg.ErrCodeInvalidRequest, ep.Code)
	}
}

// TestAPI_RateLimiting verifies that rate limiting works through the full API stack.
func TestAPI_RateLimiting(t *testing.T) {
	mockLLM := testutil.NewPipelineMockLLMServer(t)
	defer mockLLM.Close()

	cfg := testutil.NewTestConfig(mockLLM.URL)
	cfg.RateLimitPerMin = 2 // Allow only 2 requests per minute.

	hub := websocketpkg.NewHub()
	router := NewRouter(cfg, zap.NewNop(), hub, testUserStore(t), nil)
	server := httptest.NewServer(router)
	defer server.Close()

	conn, _ := testutil.FullConnect(t, server.URL)
	defer conn.Close()

	// First 2 requests should succeed.
	for i := 0; i < 2; i++ {
		testutil.SendAgentRequest(t, conn, fmt.Sprintf("rate-%d", i), websocketpkg.AgentRequestPayload{
			Action: "explain_sql",
			Context: &websocketpkg.AgentRequestContext{
				SelectedSQL: "SELECT 1",
			},
		})
		_, resp := testutil.HandleToolCalls(t, conn, testutil.ToolHandler, 30*time.Second)
		if resp.Type != websocketpkg.TypeAgentResponse {
			t.Fatalf("request %d: expected agent.response, got %s", i, resp.Type)
		}
	}

	// 3rd request should be rate limited.
	testutil.SendAgentRequest(t, conn, "rate-blocked", websocketpkg.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT 1",
		},
	})

	env := testutil.ReadEnvelope(t, conn)
	if env.Type != websocketpkg.TypeAgentError {
		t.Fatalf("expected agent.error for rate limit, got %s", env.Type)
	}
	var ep websocketpkg.AgentErrorPayload
	env.DecodePayload(&ep)
	if ep.Code != websocketpkg.ErrCodeRateLimited {
		t.Errorf("expected code=%s, got %s", websocketpkg.ErrCodeRateLimited, ep.Code)
	}
}

// TestAPI_WebSocketRejectsInvalidToken verifies WebSocket upgrade is rejected with invalid JWT.
func TestAPI_WebSocketRejectsInvalidToken(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	jwt := testutil.ObtainJWT(t, serverURL)
	sessionID, _ := testutil.CreateSession(t, serverURL, jwt)

	wsURL := strings.Replace(serverURL, "http://", "ws://", 1)

	t.Run("invalid_token", func(t *testing.T) {
		url := fmt.Sprintf("%s/ws/%s?token=%s", wsURL, sessionID, "bad-jwt")
		_, resp, err := ws.DefaultDialer.Dial(url, nil)
		if err == nil {
			t.Fatal("expected error for invalid token")
		}
		if resp != nil && resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", resp.StatusCode)
		}
	})

	t.Run("missing_token", func(t *testing.T) {
		url := fmt.Sprintf("%s/ws/%s", wsURL, sessionID)
		_, resp, err := ws.DefaultDialer.Dial(url, nil)
		if err == nil {
			t.Fatal("expected error for missing token")
		}
		if resp != nil && resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", resp.StatusCode)
		}
	})

	t.Run("nonexistent_session", func(t *testing.T) {
		url := fmt.Sprintf("%s/ws/%s?token=%s", wsURL, "nonexistent-session", jwt)
		_, resp, err := ws.DefaultDialer.Dial(url, nil)
		if err == nil {
			t.Fatal("expected error for nonexistent session")
		}
		if resp != nil && resp.StatusCode != http.StatusNotFound {
			t.Errorf("expected 404, got %d", resp.StatusCode)
		}
	})
}

// TestAPI_ConversationHistory tests that multi-turn conversations work through the API.
func TestAPI_ConversationHistory(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	conn, _ := testutil.FullConnect(t, serverURL)
	defer conn.Close()

	// Turn 1: explain_sql.
	testutil.SendAgentRequest(t, conn, "hist-1", websocketpkg.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT 1",
		},
	})
	_, resp1 := testutil.HandleToolCalls(t, conn, testutil.ToolHandler, 30*time.Second)
	if resp1.Type != websocketpkg.TypeAgentResponse {
		t.Fatalf("turn 1: expected agent.response, got %s", resp1.Type)
	}

	// Turn 2: another explain_sql on same session — should have history context.
	testutil.SendAgentRequest(t, conn, "hist-2", websocketpkg.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT 2",
		},
	})
	_, resp2 := testutil.HandleToolCalls(t, conn, testutil.ToolHandler, 30*time.Second)
	if resp2.Type != websocketpkg.TypeAgentResponse {
		t.Fatalf("turn 2: expected agent.response, got %s", resp2.Type)
	}

	// Verify both responses are valid.
	var rp1, rp2 websocketpkg.AgentResponsePayload
	resp1.DecodePayload(&rp1)
	resp2.DecodePayload(&rp2)

	if rp1.Result.Explanation == "" {
		t.Error("turn 1: expected explanation")
	}
	if rp2.Result.Explanation == "" {
		t.Error("turn 2: expected explanation")
	}
	if rp1.TokensUsed == 0 {
		t.Error("turn 1: expected tokens")
	}
	if rp2.TokensUsed == 0 {
		t.Error("turn 2: expected tokens")
	}
}

// TestAPI_MetricsCollected verifies that metrics are populated after requests.
func TestAPI_MetricsCollected(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	// Run a request.
	conn, _ := testutil.FullConnect(t, serverURL)
	testutil.SendAgentRequest(t, conn, "metrics-1", websocketpkg.AgentRequestPayload{
		Action: "explain_sql",
		Context: &websocketpkg.AgentRequestContext{
			SelectedSQL: "SELECT 1",
		},
	})
	testutil.HandleToolCalls(t, conn, testutil.ToolHandler, 30*time.Second)
	conn.Close()

	// Check metrics.
	resp, err := http.Get(serverURL + "/api/v1/metrics")
	if err != nil {
		t.Fatalf("metrics request: %v", err)
	}
	defer resp.Body.Close()

	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)

	if total, ok := m["total_requests"].(float64); !ok || total < 1 {
		t.Errorf("expected total_requests >= 1, got %v", m["total_requests"])
	}
	if tokens, ok := m["total_tokens"].(float64); !ok || tokens < 1 {
		t.Errorf("expected total_tokens >= 1, got %v", m["total_tokens"])
	}
	if uptime, ok := m["uptime_seconds"].(float64); !ok || uptime < 0 {
		t.Errorf("expected uptime_seconds >= 0, got %v", m["uptime_seconds"])
	}
}

// TestAPI_AllFourActionsViaTestutil runs all 4 agent actions using testutil helpers
// to verify the reusable test infrastructure works correctly.
func TestAPI_AllFourActionsViaTestutil(t *testing.T) {
	serverURL, cleanup := startTestServer(t)
	defer cleanup()

	conn, _ := testutil.FullConnect(t, serverURL)
	defer conn.Close()

	actions := []struct {
		name          string
		payload       websocketpkg.AgentRequestPayload
		requireStream bool
	}{
		{
			name: "generate_sql",
			payload: websocketpkg.AgentRequestPayload{
				Action:      "generate_sql",
				UserMessage: "show all users",
			},
			// generate_sql in safe mode (single candidate) does not stream.
			requireStream: false,
		},
		{
			name: "explain_sql",
			payload: websocketpkg.AgentRequestPayload{
				Action: "explain_sql",
				Context: &websocketpkg.AgentRequestContext{
					SelectedSQL: "SELECT * FROM users",
				},
			},
			requireStream: true,
		},
		{
			name: "improve_sql",
			payload: websocketpkg.AgentRequestPayload{
				Action: "improve_sql",
				Context: &websocketpkg.AgentRequestContext{
					SelectedSQL: "SELECT * FROM users",
				},
			},
			requireStream: true,
		},
		{
			name: "analyze_schema",
			payload: websocketpkg.AgentRequestPayload{
				Action: "analyze_schema",
			},
			requireStream: true,
		},
	}

	for _, tc := range actions {
		t.Run(tc.name, func(t *testing.T) {
			testutil.SendAgentRequest(t, conn, "all-"+tc.name, tc.payload)
			streams, resp := testutil.HandleToolCalls(t, conn, testutil.ToolHandler, 30*time.Second)

			if resp.Type != websocketpkg.TypeAgentResponse {
				t.Fatalf("expected agent.response, got %s", resp.Type)
			}
			if tc.requireStream && len(streams) == 0 {
				t.Error("expected streaming chunks")
			}

			var rp websocketpkg.AgentResponsePayload
			resp.DecodePayload(&rp)

			if rp.Action != tc.name {
				t.Errorf("expected action=%s, got %s", tc.name, rp.Action)
			}
			if rp.TokensUsed == 0 {
				t.Error("expected non-zero tokens")
			}
			if rp.ModelUsed == "" {
				t.Error("expected model_used")
			}
		})
	}
}
