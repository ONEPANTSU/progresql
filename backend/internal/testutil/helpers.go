package testutil

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	websocketpkg "github.com/onepantsu/progressql/backend/internal/websocket"
)

// ServerSetup holds all components of a test server instance.
type ServerSetup struct {
	ServerURL string
	Config    *config.Config
	Hub       *websocketpkg.Hub
	Cleanup   func()
}

// NewTestConfig creates a config suitable for testing with the given mock LLM URL.
func NewTestConfig(mockLLMURL string) *config.Config {
	return &config.Config{
		ServerPort:       "0",
		JWTSecret:        "test-jwt-secret-256bits!!!!!!!!",
		OpenRouterAPIKey: "test-openrouter-key",
		Version:          "0.1.0-test",
		LogLevel:         "error",
		Environment:      "test",
		RateLimitPerMin:  0,
		HTTPBaseURL:      mockLLMURL,
		HTTPModel:        "qwen/qwen3-coder",
		AvailableModels:  config.DefaultModels(),
	}
}

// ObtainJWT requests a JWT token from the test server.
func ObtainJWT(t *testing.T, serverURL string) string {
	t.Helper()
	resp, err := http.Post(serverURL+"/api/v1/auth/token", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatalf("auth/token request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("auth/token: expected 200, got %d", resp.StatusCode)
	}

	var result struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if result.Token == "" {
		t.Fatal("auth/token returned empty token")
	}
	return result.Token
}

// CreateSession creates an agent session and returns the session ID and WS URL.
func CreateSession(t *testing.T, serverURL, jwt string) (sessionID, wsURL string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"model":      "test-model",
		"db_context": map[string]string{"db_name": "testdb", "db_version": "16.0"},
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

	var result struct {
		SessionID string `json:"session_id"`
		WSURL     string `json:"ws_url"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if result.SessionID == "" {
		t.Fatal("sessions returned empty session_id")
	}
	return result.SessionID, result.WSURL
}

// ConnectWebSocket establishes a WebSocket connection to the test server.
func ConnectWebSocket(t *testing.T, serverURL, sessionID, jwt string) *ws.Conn {
	t.Helper()
	wsURL := strings.Replace(serverURL, "http://", "ws://", 1)
	wsURL = fmt.Sprintf("%s/ws/%s?token=%s", wsURL, sessionID, jwt)

	dialer := ws.Dialer{HandshakeTimeout: 5 * time.Second}
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

// FullConnect performs the full auth → session → WebSocket connect flow.
func FullConnect(t *testing.T, serverURL string) (conn *ws.Conn, sessionID string) {
	t.Helper()
	jwt := ObtainJWT(t, serverURL)
	sessionID, _ = CreateSession(t, serverURL, jwt)
	conn = ConnectWebSocket(t, serverURL, sessionID, jwt)
	return conn, sessionID
}

// ReadEnvelope reads and parses a single WebSocket message as an Envelope.
func ReadEnvelope(t *testing.T, conn *ws.Conn) *websocketpkg.Envelope {
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

// SendToolResult sends a tool.result back over the WebSocket.
func SendToolResult(t *testing.T, conn *ws.Conn, requestID, callID string, success bool, data any) {
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

// SendAgentRequest sends an agent.request envelope over the WebSocket.
func SendAgentRequest(t *testing.T, conn *ws.Conn, requestID string, payload websocketpkg.AgentRequestPayload) {
	t.Helper()
	env, err := websocketpkg.NewEnvelopeWithID(websocketpkg.TypeAgentRequest, requestID, "", payload)
	if err != nil {
		t.Fatalf("create agent request: %v", err)
	}
	raw, _ := env.Marshal()
	if err := conn.WriteMessage(ws.TextMessage, raw); err != nil {
		t.Fatalf("ws write: %v", err)
	}
}

// HandleToolCalls reads WS messages, handles tool.calls, collects streams, and returns the final response.
func HandleToolCalls(
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
			SendToolResult(t, conn, env.RequestID, env.CallID, success, data)

		case websocketpkg.TypeAgentStream:
			var sp websocketpkg.AgentStreamPayload
			env.DecodePayload(&sp)
			streams = append(streams, sp.Delta)

		case websocketpkg.TypeAgentResponse:
			return streams, env

		case websocketpkg.TypeAgentError:
			return streams, env
		}
	}

	t.Fatal("timed out waiting for agent.response")
	return nil, nil
}

// NopLogger returns a no-op zap logger for testing.
func NopLogger() *zap.Logger {
	return zap.NewNop()
}
