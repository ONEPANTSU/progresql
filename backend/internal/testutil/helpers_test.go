/*
* Created on Mar 27, 2026
* Test file for helpers.go
* File path: internal/testutil/helpers_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package testutil

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
	"github.com/onepantsu/progressql/backend/internal/llm"
	websocketpkg "github.com/onepantsu/progressql/backend/internal/websocket"
)

// ── NewTestConfig ─────────────────────────────────────────────────────────────

func TestNewTestConfig(t *testing.T) {
	cfg := NewTestConfig("http://localhost:9999")
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.JWTSecret == "" {
		t.Error("expected non-empty JWTSecret")
	}
	if cfg.HTTPBaseURL != "http://localhost:9999" {
		t.Errorf("expected HTTPBaseURL='http://localhost:9999', got %q", cfg.HTTPBaseURL)
	}
	if cfg.ServerPort != "0" {
		t.Errorf("expected ServerPort='0', got %q", cfg.ServerPort)
	}
	if len(cfg.AvailableModels) == 0 {
		t.Error("expected non-empty AvailableModels")
	}
}

// ── NopLogger ─────────────────────────────────────────────────────────────────

func TestNopLogger(t *testing.T) {
	logger := NopLogger()
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	// Verify it does not panic on use.
	logger.Info("test message")
	logger.Error("test error")
	logger.Debug("test debug")
}

// ── NewPipelineMockLLMServer ──────────────────────────────────────────────────

func TestNewPipelineMockLLMServer(t *testing.T) {
	server := NewPipelineMockLLMServer(t)
	defer server.Close()

	if server == nil {
		t.Fatal("expected non-nil pipeline mock server")
	}
	if server.URL == "" {
		t.Error("expected non-empty server URL")
	}

	client := llm.NewClient("test-key", llm.WithBaseURL(server.URL), llm.WithMaxRetries(0))

	// Test non-streaming SQL generation path.
	resp, err := client.ChatCompletion(context.Background(), llm.ChatRequest{
		Model:    "test",
		Messages: []llm.Message{{Role: "user", Content: "generate SQL query"}},
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if len(resp.Choices) == 0 {
		t.Fatal("expected at least one choice")
	}
}

func TestNewPipelineMockLLMServer_TableSelection(t *testing.T) {
	server := NewPipelineMockLLMServer(t)
	defer server.Close()

	client := llm.NewClient("test-key", llm.WithBaseURL(server.URL), llm.WithMaxRetries(0))

	// "relevant tables" prompt should be routed to return JSON array.
	resp, err := client.ChatCompletion(context.Background(), llm.ChatRequest{
		Model:    "test",
		Messages: []llm.Message{{Role: "user", Content: "which tables are relevant for this query?"}},
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if len(resp.Choices) == 0 {
		t.Fatal("expected at least one choice")
	}
	if !strings.Contains(resp.Choices[0].Message.Content, "users") {
		t.Errorf("expected table names in response, got %q", resp.Choices[0].Message.Content)
	}
}

// ── ObtainJWT ─────────────────────────────────────────────────────────────────

func TestObtainJWT(t *testing.T) {
	// Create a minimal HTTP server that returns a valid JWT response.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/token" && r.Method == http.MethodPost {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{
				"token":      "test-jwt-token-abc123",
				"expires_at": time.Now().Add(24 * time.Hour).Format(time.RFC3339),
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	token := ObtainJWT(t, server.URL)
	if token != "test-jwt-token-abc123" {
		t.Errorf("expected token 'test-jwt-token-abc123', got %q", token)
	}
}

// ── CreateSession ─────────────────────────────────────────────────────────────

func TestCreateSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/sessions" && r.Method == http.MethodPost {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{
				"session_id": "session-abc-123",
				"ws_url":     "ws://localhost/ws/session-abc-123",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	sessionID, wsURL := CreateSession(t, server.URL, "test-jwt")
	if sessionID != "session-abc-123" {
		t.Errorf("expected sessionID 'session-abc-123', got %q", sessionID)
	}
	if wsURL == "" {
		t.Error("expected non-empty wsURL")
	}
}

// ── ConnectWebSocket ──────────────────────────────────────────────────────────

var wsUpgrader = ws.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

func TestConnectWebSocket(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/ws/") {
			conn, err := wsUpgrader.Upgrade(w, r, nil)
			if err != nil {
				t.Errorf("ws upgrade: %v", err)
				return
			}
			defer conn.Close()
			// Echo any received message.
			for {
				mt, msg, err := conn.ReadMessage()
				if err != nil {
					return
				}
				conn.WriteMessage(mt, msg)
			}
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	conn := ConnectWebSocket(t, server.URL, "session-xyz", "token-xyz")
	defer conn.Close()

	if conn == nil {
		t.Fatal("expected non-nil ws connection")
	}
}

// ── SendToolResult ────────────────────────────────────────────────────────────

func TestSendToolResult(t *testing.T) {
	done := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("ws server read: %v", err)
			close(done)
			return
		}
		// Verify we received a valid envelope.
		if len(msg) == 0 {
			t.Error("expected non-empty message")
		}
		close(done)
	}))
	defer server.Close()

	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	dialer := ws.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.Dial(wsURL+"/ws/test", nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close()

	SendToolResult(t, conn, "req-1", "call-1", true, map[string]string{"result": "ok"})

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for server to receive message")
	}
}

// ── SendAgentRequest ──────────────────────────────────────────────────────────

func TestSendAgentRequest(t *testing.T) {
	done := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("ws server read: %v", err)
			close(done)
			return
		}
		if len(msg) == 0 {
			t.Error("expected non-empty message")
		}
		close(done)
	}))
	defer server.Close()

	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	dialer := ws.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.Dial(wsURL+"/ws/test", nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close()

	SendAgentRequest(t, conn, "req-2", websocketpkg.AgentRequestPayload{
		UserMessage: "show all tables",
	})

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for server to receive message")
	}
}

// ── ReadEnvelope ─────────────────────────────────────────────────────────────

func TestReadEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		// Send a valid agent.stream envelope.
		env, _ := websocketpkg.NewEnvelopeWithID(
			websocketpkg.TypeAgentStream,
			"req-read",
			"",
			websocketpkg.AgentStreamPayload{Delta: "hello"},
		)
		raw, _ := env.Marshal()
		conn.WriteMessage(ws.TextMessage, raw)
	}))
	defer server.Close()

	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	dialer := ws.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.Dial(wsURL+"/ws/test", nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close()

	env := ReadEnvelope(t, conn)
	if env == nil {
		t.Fatal("expected non-nil envelope")
	}
	if env.Type != websocketpkg.TypeAgentStream {
		t.Errorf("expected TypeAgentStream, got %q", env.Type)
	}
}

// ── HandleToolCalls ───────────────────────────────────────────────────────────

func TestHandleToolCalls_AgentResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		// Send a stream then a final agent.response.
		streamEnv, _ := websocketpkg.NewEnvelopeWithID(
			websocketpkg.TypeAgentStream,
			"req-hc",
			"",
			websocketpkg.AgentStreamPayload{Delta: "partial"},
		)
		raw, _ := streamEnv.Marshal()
		conn.WriteMessage(ws.TextMessage, raw)

		respEnv, _ := websocketpkg.NewEnvelopeWithID(
			websocketpkg.TypeAgentResponse,
			"req-hc",
			"",
			websocketpkg.AgentResponsePayload{Action: "final answer"},
		)
		raw, _ = respEnv.Marshal()
		conn.WriteMessage(ws.TextMessage, raw)
	}))
	defer server.Close()

	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	dialer := ws.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.Dial(wsURL+"/ws/test", nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close()

	streams, response := HandleToolCalls(t, conn,
		func(name string, args json.RawMessage) (any, bool) {
			return nil, false
		},
		10*time.Second,
	)

	if len(streams) != 1 || streams[0] != "partial" {
		t.Errorf("expected streams=['partial'], got %v", streams)
	}
	if response == nil {
		t.Fatal("expected non-nil response envelope")
	}
	if response.Type != websocketpkg.TypeAgentResponse {
		t.Errorf("expected TypeAgentResponse, got %q", response.Type)
	}
}

func TestHandleToolCalls_WithToolCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		// Send a tool.call.
		toolEnv, _ := websocketpkg.NewEnvelopeWithID(
			websocketpkg.TypeToolCall,
			"req-tc",
			"call-001",
			websocketpkg.ToolCallPayload{
				ToolName:  "list_tables",
				Arguments: json.RawMessage(`{}`),
			},
		)
		raw, _ := toolEnv.Marshal()
		conn.WriteMessage(ws.TextMessage, raw)

		// Wait for tool result, then send final response.
		conn.ReadMessage() // consume the tool result

		respEnv, _ := websocketpkg.NewEnvelopeWithID(
			websocketpkg.TypeAgentResponse,
			"req-tc",
			"",
			websocketpkg.AgentResponsePayload{Action: "done"},
		)
		raw, _ = respEnv.Marshal()
		conn.WriteMessage(ws.TextMessage, raw)
	}))
	defer server.Close()

	wsURL := strings.Replace(server.URL, "http://", "ws://", 1)
	dialer := ws.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.Dial(wsURL+"/ws/test", nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close()

	_, response := HandleToolCalls(t, conn, ToolHandler, 10*time.Second)
	if response == nil {
		t.Fatal("expected non-nil response")
	}
}

// ── FullConnect ───────────────────────────────────────────────────────────────

func TestFullConnect(t *testing.T) {
	// Mock server that handles JWT auth, session creation, and WebSocket upgrade.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/auth/token":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{
				"token":      "test-full-connect-jwt",
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339),
			})

		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{
				"session_id": "full-connect-session",
				"ws_url":     "ws://placeholder/ws/full-connect-session",
			})

		case strings.HasPrefix(r.URL.Path, "/ws/"):
			conn, err := wsUpgrader.Upgrade(w, r, nil)
			if err != nil {
				t.Errorf("ws upgrade: %v", err)
				return
			}
			defer conn.Close()
			// Keep the connection alive briefly.
			conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			conn.ReadMessage() //nolint: errcheck

		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	conn, sessionID := FullConnect(t, server.URL)
	defer conn.Close()

	if conn == nil {
		t.Fatal("expected non-nil WebSocket connection from FullConnect")
	}
	if sessionID != "full-connect-session" {
		t.Errorf("expected sessionID='full-connect-session', got %q", sessionID)
	}
}

// ── NewPipelineMockLLMServer — streaming path ────────────────────────────────

func TestNewPipelineMockLLMServer_StreamingPath(t *testing.T) {
	server := NewPipelineMockLLMServer(t)
	defer server.Close()

	client := llm.NewClient("test-key", llm.WithBaseURL(server.URL), llm.WithMaxRetries(0))

	var chunks []string
	_, err := client.ChatCompletionStream(context.Background(), llm.ChatRequest{
		Model:  "test-model",
		Stream: true,
		Messages: []llm.Message{{Role: "user", Content: "analyze schema for this query"}},
	}, func(chunk llm.StreamChunk) error {
		for _, ch := range chunk.Choices {
			if ch.Delta.Content != "" {
				chunks = append(chunks, ch.Delta.Content)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	if len(chunks) == 0 {
		t.Error("expected at least one streaming chunk")
	}
}

func TestNewPipelineMockLLMServer_ExplainPath(t *testing.T) {
	server := NewPipelineMockLLMServer(t)
	defer server.Close()

	client := llm.NewClient("test-key", llm.WithBaseURL(server.URL), llm.WithMaxRetries(0))

	var content string
	_, err := client.ChatCompletionStream(context.Background(), llm.ChatRequest{
		Model:  "test-model",
		Stream: true,
		Messages: []llm.Message{{Role: "user", Content: "explain this query"}},
	}, func(chunk llm.StreamChunk) error {
		for _, ch := range chunk.Choices {
			content += ch.Delta.Content
		}
		return nil
	})
	if err != nil {
		t.Fatalf("ChatCompletionStream explain: %v", err)
	}
	if content == "" {
		t.Error("expected non-empty streaming content for explain path")
	}
}
