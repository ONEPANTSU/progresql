/*
* Created on Mar 27, 2026
* Test file for session.go extra coverage
* File path: internal/websocket/session_extra_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package websocket

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
)

// ── Session getters/setters ───────────────────────────────────────────────────

func TestSession_ModelGetSet(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	if session.Model() != "" {
		t.Errorf("expected empty model initially, got %q", session.Model())
	}

	session.SetModel("qwen/qwen3-coder")
	if session.Model() != "qwen/qwen3-coder" {
		t.Errorf("expected 'qwen/qwen3-coder', got %q", session.Model())
	}
}

func TestSession_UserIDGetSet(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	if session.UserID() != "" {
		t.Errorf("expected empty userID initially, got %q", session.UserID())
	}

	session.SetUserID("user-42")
	if session.UserID() != "user-42" {
		t.Errorf("expected 'user-42', got %q", session.UserID())
	}
}

func TestSession_SetMessageHandler(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	called := make(chan struct{}, 1)
	session.SetMessageHandler(func(env *Envelope) {
		called <- struct{}{}
	})

	// Verify the handler is callable (it replaces the nil handler).
	if session.onMessage == nil {
		t.Error("expected onMessage handler to be set")
	}
}

// ── RegisterCancel / UnregisterCancel ────────────────────────────────────────

func TestSession_RegisterCancel(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	cancel := context.CancelFunc(func() {})

	session.RegisterCancel("req-cancel-1", cancel)

	session.cancelFuncsMu.Lock()
	_, ok := session.cancelFuncs["req-cancel-1"]
	session.cancelFuncsMu.Unlock()

	if !ok {
		t.Error("expected cancel func to be registered")
	}
}

func TestSession_UnregisterCancel(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	cancel := context.CancelFunc(func() {})
	session.RegisterCancel("req-cancel-2", cancel)
	session.UnregisterCancel("req-cancel-2")

	session.cancelFuncsMu.Lock()
	_, ok := session.cancelFuncs["req-cancel-2"]
	session.cancelFuncsMu.Unlock()

	if ok {
		t.Error("expected cancel func to be removed after UnregisterCancel")
	}
}

// ── handleAgentCancel ─────────────────────────────────────────────────────────

func TestSession_HandleAgentCancel_CancelsRequest(t *testing.T) {
	session, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Register a real cancel function.
	ctx, cancel := context.WithCancel(context.Background())
	session.RegisterCancel("req-to-cancel", cancel)

	// Client sends agent.cancel.
	env, err := NewEnvelopeWithID(TypeAgentCancel, "req-to-cancel", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := env.Marshal()
	if err := client.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write error: %v", err)
	}

	// Give session time to process the cancel.
	select {
	case <-ctx.Done():
		// Context was cancelled — correct behaviour.
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for context to be cancelled")
	}
}

func TestSession_HandleAgentCancel_MissingRequestID(t *testing.T) {
	// When agent.cancel has an empty request_id the session should log a warning
	// and not panic.
	_, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	env := &Envelope{
		Type:      TypeAgentCancel,
		RequestID: "", // empty — triggers the "missing request_id" log path
		Payload:   []byte(`null`),
	}
	data, _ := env.Marshal()
	if err := client.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write error: %v", err)
	}

	// No panic expected; just give the session time to process.
	time.Sleep(50 * time.Millisecond)
}

func TestSession_HandleAgentCancel_NoActiveRequest(t *testing.T) {
	// When agent.cancel targets a request that has no active cancel func,
	// the session logs a warning but does not panic.
	_, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	env, _ := NewEnvelopeWithID(TypeAgentCancel, "nonexistent-req", "", nil)
	data, _ := env.Marshal()
	if err := client.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write error: %v", err)
	}

	// Just ensure no panic.
	time.Sleep(50 * time.Millisecond)
}

// ── Send (buffer-full / closed paths) ────────────────────────────────────────

func TestSession_Send_ClosedSession(t *testing.T) {
	// Build a Session directly without a running write pump.
	// We close it and then try to Send — should return false.
	hub := NewHub()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := ws.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		sess := NewSession("send-test", conn, hub, nil, nil)
		hub.Register(sess)
		// Close immediately without calling Run().
		sess.Close()
		// Now try to send — should return false.
		if sess.Send([]byte("test")) {
			t.Error("expected Send to return false on closed session")
		}
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := ws.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	// Wait a moment for the handler to run.
	time.Sleep(50 * time.Millisecond)
}

// ── Hub.SetUserID ─────────────────────────────────────────────────────────────

func TestHub_SetUserID(t *testing.T) {
	hub := NewHub()

	hub.SetUserID("session-x", "user-abc")

	got := hub.GetUserID("session-x")
	if got != "user-abc" {
		t.Errorf("expected 'user-abc', got %q", got)
	}
}

func TestHub_SetUserID_Overwrite(t *testing.T) {
	hub := NewHub()

	hub.SetUserID("session-y", "user-first")
	hub.SetUserID("session-y", "user-second")

	got := hub.GetUserID("session-y")
	if got != "user-second" {
		t.Errorf("expected 'user-second', got %q", got)
	}
}

// ── ToolDispatcher.WithLogger ─────────────────────────────────────────────────

func TestToolDispatcher_WithLogger(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	d := NewToolDispatcher(session)

	// WithLogger(nil) should be a no-op (logger stays as zap.NewNop).
	d2 := d.WithLogger(nil)
	if d2 != d {
		t.Error("expected same dispatcher returned from WithLogger(nil)")
	}
}

// ── errSessionClosed ──────────────────────────────────────────────────────────

func TestErrSessionClosed_Error(t *testing.T) {
	err := ErrSessionClosed
	if err.Error() != "session closed" {
		t.Errorf("expected 'session closed', got %q", err.Error())
	}
}

// ── sendError (via invalid incoming message) ──────────────────────────────────

func TestSession_SendError_InvalidMessage(t *testing.T) {
	// setupTestSession starts a running session (readPump + writePump).
	// Sending invalid JSON triggers readPump → sendError → client receives TypeAgentError.
	_, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Send non-JSON bytes — ParseEnvelope will fail, triggering sendError.
	if err := client.WriteMessage(ws.TextMessage, []byte("not-json!!!")); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Expect an agent.error envelope back.
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := client.ReadMessage()
	if err != nil {
		t.Fatalf("expected error response from session, got: %v", err)
	}

	var env Envelope
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("failed to parse response envelope: %v", err)
	}
	if env.Type != TypeAgentError {
		t.Errorf("expected TypeAgentError, got %q", env.Type)
	}
}

// ── Send buffer-full path ─────────────────────────────────────────────────────

func TestSession_Send_BufferFull(t *testing.T) {
	// Create a session WITHOUT calling Run() so the writePump won't drain messages.
	hub := NewHub()
	ready := make(chan struct{})
	doneCh := make(chan struct{})
	var sess *Session

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _ := testUpgrader.Upgrade(w, r, nil)
		sess = NewSession("buf-full", conn, hub, nil, nil)
		hub.Register(sess)
		close(ready)
		<-doneCh // keep alive until test is done
	}))
	defer server.Close()
	defer close(doneCh)

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	client, _, err := ws.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	<-ready

	msg := []byte("fill")
	// Fill all 64 slots without a running writePump to drain them.
	for i := 0; i < sendBufferSize; i++ {
		sess.Send(msg)
	}

	// Buffer is now full — next Send should return false (buffer-full drop path).
	if sess.Send(msg) {
		t.Error("expected Send to return false when buffer is full")
	}
}

// ── handleToolResult missing call_id ─────────────────────────────────────────

func TestSession_HandleToolResult_MissingCallID(t *testing.T) {
	// Sending a tool.result with empty call_id exercises the early-return warn path.
	_, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	env := &Envelope{
		Type:   TypeToolResult,
		CallID: "", // missing — triggers "tool.result missing call_id" warning
		Payload: []byte(`{}`),
	}
	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := client.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Give the session time to process the message without panicking.
	time.Sleep(50 * time.Millisecond)
}

// ── handleToolResult no waiter ────────────────────────────────────────────────

func TestSession_HandleToolResult_NoWaiter(t *testing.T) {
	// A tool.result for a call_id with no registered waiter exercises the
	// "no waiter for tool.result" warning path.
	_, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	env := &Envelope{
		Type:    TypeToolResult,
		CallID:  "nonexistent-call-id",
		Payload: []byte(`{}`),
	}
	data, _ := env.Marshal()
	if err := client.WriteMessage(ws.TextMessage, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
}
