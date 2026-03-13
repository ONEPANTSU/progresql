package websocket

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"go.uber.org/zap"
)

// newTestServer creates an httptest.Server with the WebSocket handler wired up.
func newTestServer(hub *Hub, jwtSvc *auth.JWTService, onMsg MessageHandler) *httptest.Server {
	log := zap.NewNop()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/", HandleWebSocket(hub, jwtSvc, log, onMsg))
	return httptest.NewServer(mux)
}

// wsURL converts an httptest.Server URL to a WebSocket URL for the given session.
func wsURL(server *httptest.Server, sessionID, token string) string {
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/" + sessionID + "?token=" + token
	return url
}

func TestHandleWebSocket_Success(t *testing.T) {
	hub := NewHub()
	jwtSvc := auth.NewJWTService("test-secret")

	// Register a placeholder (simulating POST /api/v1/sessions)
	sessionID := "sess-001"
	hub.Register(&mockConn{id: sessionID})

	// Generate a valid JWT
	token, err := jwtSvc.GenerateToken(sessionID)
	if err != nil {
		t.Fatalf("failed to generate token: %v", err)
	}

	msgReceived := make(chan *Envelope, 1)
	server := newTestServer(hub, jwtSvc, func(env *Envelope) {
		msgReceived <- env
	})
	defer server.Close()

	// Connect via WebSocket
	conn, resp, err := ws.DefaultDialer.Dial(wsURL(server, sessionID, token), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101, got %d", resp.StatusCode)
	}

	// The Hub should now have a real Session instead of the placeholder
	registered := hub.Get(sessionID)
	if registered == nil {
		t.Fatal("expected session in hub after connect")
	}
	if _, ok := registered.(*Session); !ok {
		t.Error("expected hub entry to be *Session, not placeholder")
	}

	// Send a message and verify the onMessage callback fires
	env, _ := NewEnvelope(TypeAgentRequest, nil)
	data, _ := env.Marshal()
	if err := conn.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	select {
	case got := <-msgReceived:
		if got.Type != TypeAgentRequest {
			t.Errorf("expected type %q, got %q", TypeAgentRequest, got.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for message callback")
	}
}

func TestHandleWebSocket_InvalidToken(t *testing.T) {
	hub := NewHub()
	jwtSvc := auth.NewJWTService("test-secret")

	sessionID := "sess-002"
	hub.Register(&mockConn{id: sessionID})

	server := newTestServer(hub, jwtSvc, nil)
	defer server.Close()

	// Try to connect with an invalid token
	_, resp, err := ws.DefaultDialer.Dial(wsURL(server, sessionID, "bad-token"), nil)
	if err == nil {
		t.Fatal("expected dial to fail with invalid token")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestHandleWebSocket_MissingToken(t *testing.T) {
	hub := NewHub()
	jwtSvc := auth.NewJWTService("test-secret")

	sessionID := "sess-003"
	hub.Register(&mockConn{id: sessionID})

	server := newTestServer(hub, jwtSvc, nil)
	defer server.Close()

	// Connect without token query param
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/" + sessionID
	_, resp, err := ws.DefaultDialer.Dial(url, nil)
	if err == nil {
		t.Fatal("expected dial to fail without token")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestHandleWebSocket_NonexistentSession(t *testing.T) {
	hub := NewHub()
	jwtSvc := auth.NewJWTService("test-secret")

	// Generate a valid token but don't register any session
	token, _ := jwtSvc.GenerateToken("some-session")

	server := newTestServer(hub, jwtSvc, nil)
	defer server.Close()

	_, resp, err := ws.DefaultDialer.Dial(wsURL(server, "nonexistent-session", token), nil)
	if err == nil {
		t.Fatal("expected dial to fail for nonexistent session")
	}
	if resp != nil && resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestHandleWebSocket_MissingSessionID(t *testing.T) {
	hub := NewHub()
	jwtSvc := auth.NewJWTService("test-secret")

	server := newTestServer(hub, jwtSvc, nil)
	defer server.Close()

	// Connect to /ws/ without a session_id
	token, _ := jwtSvc.GenerateToken("x")
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/?token=" + token
	_, resp, err := ws.DefaultDialer.Dial(url, nil)
	if err == nil {
		t.Fatal("expected dial to fail for missing session_id")
	}
	if resp != nil && resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}
