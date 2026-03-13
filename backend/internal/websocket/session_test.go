package websocket

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
)

// upgrader for test servers.
var testUpgrader = ws.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// setupTestSession creates a test HTTP server with a WebSocket endpoint,
// connects a client, and returns the Session, client conn, and cleanup func.
func setupTestSession(t *testing.T, onMessage MessageHandler) (*Session, *ws.Conn, func()) {
	t.Helper()

	hub := NewHub()
	var session *Session

	ready := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade error: %v", err)
		}
		session = NewSession("test-session", conn, hub, nil, onMessage)
		hub.Register(session)
		close(ready)
		session.Run()
	}))

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	client, _, err := ws.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}

	<-ready

	cleanup := func() {
		client.Close()
		server.Close()
	}

	return session, client, cleanup
}

func TestSession_SendAndReceive(t *testing.T) {
	session, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Send a message through the session's write channel.
	env, err := NewEnvelopeWithID(TypeAgentStream, "req-1", "", AgentStreamPayload{Delta: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if err := session.SendEnvelope(env); err != nil {
		t.Fatalf("SendEnvelope error: %v", err)
	}

	// Client should receive it.
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := client.ReadMessage()
	if err != nil {
		t.Fatalf("client read error: %v", err)
	}

	var got Envelope
	if err := json.Unmarshal(msg, &got); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if got.Type != TypeAgentStream {
		t.Errorf("expected type %q, got %q", TypeAgentStream, got.Type)
	}
	if got.RequestID != "req-1" {
		t.Errorf("expected request_id 'req-1', got %q", got.RequestID)
	}

	var payload AgentStreamPayload
	if err := got.DecodePayload(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Delta != "hello" {
		t.Errorf("expected delta 'hello', got %q", payload.Delta)
	}
}

func TestSession_ReadRouting(t *testing.T) {
	received := make(chan *Envelope, 1)
	session, client, cleanup := setupTestSession(t, func(env *Envelope) {
		received <- env
	})
	_ = session // keep linter happy

	defer cleanup()

	// Client sends an agent.request.
	payload := AgentRequestPayload{Action: "generate_sql", UserMessage: "show users"}
	env, _ := NewEnvelopeWithID(TypeAgentRequest, "req-42", "", payload)
	data, _ := env.Marshal()

	if err := client.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write error: %v", err)
	}

	select {
	case got := <-received:
		if got.Type != TypeAgentRequest {
			t.Errorf("expected type %q, got %q", TypeAgentRequest, got.Type)
		}
		if got.RequestID != "req-42" {
			t.Errorf("expected request_id 'req-42', got %q", got.RequestID)
		}
		var p AgentRequestPayload
		if err := got.DecodePayload(&p); err != nil {
			t.Fatal(err)
		}
		if p.Action != "generate_sql" {
			t.Errorf("expected action 'generate_sql', got %q", p.Action)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for message")
	}
}

func TestSession_ToolResultCorrelation(t *testing.T) {
	session, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Register a waiter for a tool result.
	ch := session.RegisterToolWaiter("call-123")

	// Client sends a tool.result with matching call_id.
	payload := ToolResultPayload{Success: true, Data: json.RawMessage(`{"tables":["users"]}`)}
	env, _ := NewEnvelopeWithID(TypeToolResult, "", "call-123", payload)
	data, _ := env.Marshal()

	if err := client.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write error: %v", err)
	}

	select {
	case result := <-ch:
		if result == nil {
			t.Fatal("expected non-nil result")
		}
		if result.CallID != "call-123" {
			t.Errorf("expected call_id 'call-123', got %q", result.CallID)
		}
		var p ToolResultPayload
		if err := result.DecodePayload(&p); err != nil {
			t.Fatal(err)
		}
		if !p.Success {
			t.Error("expected success=true")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for tool result")
	}
}

func TestSession_CloseUnblocksPendingToolWaiters(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	ch := session.RegisterToolWaiter("call-orphan")

	// Close the session — should unblock the waiter.
	session.Close()

	select {
	case result, ok := <-ch:
		if ok && result != nil {
			t.Error("expected closed channel or nil result")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout: Close() did not unblock pending tool waiter")
	}
}

func TestSession_SessionID(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	if session.SessionID() != "test-session" {
		t.Errorf("expected session_id 'test-session', got %q", session.SessionID())
	}
}

func TestSession_HubUnregisterOnClose(t *testing.T) {
	hub := NewHub()
	var session *Session
	ready := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		session = NewSession("hub-test", conn, hub, nil, nil)
		hub.Register(session)
		close(ready)
		session.Run()
	}))
	defer server.Close()

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	client, _, err := ws.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	<-ready

	if hub.Get("hub-test") == nil {
		t.Fatal("expected session to be in hub before close")
	}

	// Close client — triggers readPump to exit and unregister from hub.
	client.Close()

	// Wait for hub to reflect the removal.
	deadline := time.After(2 * time.Second)
	for {
		if hub.Get("hub-test") == nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("timeout: session not removed from hub after client close")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func TestSession_SendEnvelopeAfterClose(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	session.Close()

	env, _ := NewEnvelope(TypeAgentStream, AgentStreamPayload{Delta: "late"})
	err := session.SendEnvelope(env)
	if err != ErrSessionClosed {
		t.Errorf("expected ErrSessionClosed, got %v", err)
	}
}

func TestSession_AddAndGetHistory(t *testing.T) {
	s := &Session{history: nil}

	s.AddHistory("user", "show tables")
	s.AddHistory("assistant", "Here are the tables: users, orders")
	s.AddHistory("user", "show columns of users")

	history := s.GetHistory()
	if len(history) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(history))
	}
	if history[0].Role != "user" || history[0].Content != "show tables" {
		t.Errorf("unexpected first message: %+v", history[0])
	}
	if history[1].Role != "assistant" {
		t.Errorf("expected assistant role, got %s", history[1].Role)
	}
	if history[2].Content != "show columns of users" {
		t.Errorf("unexpected third message content: %s", history[2].Content)
	}
}

func TestSession_HistoryTrimToMax(t *testing.T) {
	s := &Session{history: nil}

	// Add more than MaxHistoryMessages.
	for i := 0; i < MaxHistoryMessages+5; i++ {
		s.AddHistory("user", strings.Repeat("x", i+1))
	}

	history := s.GetHistory()
	if len(history) != MaxHistoryMessages {
		t.Fatalf("expected %d messages, got %d", MaxHistoryMessages, len(history))
	}

	// The oldest messages should have been trimmed — first remaining message should have length 6.
	if len(history[0].Content) != 6 {
		t.Errorf("expected oldest message content length 6, got %d", len(history[0].Content))
	}
}

func TestSession_ClearHistory(t *testing.T) {
	s := &Session{history: nil}
	s.AddHistory("user", "hello")
	s.AddHistory("assistant", "hi")
	s.ClearHistory()

	history := s.GetHistory()
	if len(history) != 0 {
		t.Fatalf("expected empty history after clear, got %d", len(history))
	}
}

func TestSession_GetHistoryReturnsCopy(t *testing.T) {
	s := &Session{history: nil}
	s.AddHistory("user", "original")

	history := s.GetHistory()
	history[0].Content = "modified"

	// Original should be unmodified.
	original := s.GetHistory()
	if original[0].Content != "original" {
		t.Errorf("GetHistory did not return a copy: content was modified")
	}
}

func TestSession_HistoryConcurrent(t *testing.T) {
	s := &Session{history: nil}
	var wg sync.WaitGroup

	// 50 writers + 50 readers concurrently.
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(n int) {
			defer wg.Done()
			s.AddHistory("user", strings.Repeat("a", n+1))
		}(i)
		go func() {
			defer wg.Done()
			_ = s.GetHistory() // should not panic
		}()
	}

	wg.Wait()

	history := s.GetHistory()
	if len(history) > MaxHistoryMessages {
		t.Errorf("history exceeds max: %d", len(history))
	}
}

func TestSession_ConcurrentSendAndClose(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			env, _ := NewEnvelope(TypeAgentStream, AgentStreamPayload{Delta: "x"})
			_ = session.SendEnvelope(env) // should not panic
		}()
	}

	// Close mid-flight.
	session.Close()
	wg.Wait()
}
