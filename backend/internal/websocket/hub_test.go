package websocket

import (
	"fmt"
	"sync"
	"testing"
)

// mockConn implements the Conn interface for testing.
type mockConn struct {
	id     string
	closed bool
}

func (m *mockConn) SessionID() string { return m.id }
func (m *mockConn) Close() error      { m.closed = true; return nil }

func TestHub_RegisterAndGet(t *testing.T) {
	hub := NewHub()
	conn := &mockConn{id: "session-1"}

	hub.Register(conn)

	got := hub.Get("session-1")
	if got == nil {
		t.Fatal("expected to find connection, got nil")
	}
	if got.SessionID() != "session-1" {
		t.Errorf("expected session_id 'session-1', got %q", got.SessionID())
	}
}

func TestHub_GetNotFound(t *testing.T) {
	hub := NewHub()

	got := hub.Get("nonexistent")
	if got != nil {
		t.Errorf("expected nil for nonexistent session, got %v", got)
	}
}

func TestHub_Unregister(t *testing.T) {
	hub := NewHub()
	conn := &mockConn{id: "session-1"}
	hub.Register(conn)

	removed := hub.Unregister("session-1")
	if !removed {
		t.Error("expected Unregister to return true")
	}

	got := hub.Get("session-1")
	if got != nil {
		t.Error("expected nil after unregister, got connection")
	}
}

func TestHub_UnregisterNotFound(t *testing.T) {
	hub := NewHub()

	removed := hub.Unregister("nonexistent")
	if removed {
		t.Error("expected Unregister to return false for nonexistent session")
	}
}

func TestHub_Len(t *testing.T) {
	hub := NewHub()
	if hub.Len() != 0 {
		t.Errorf("expected 0 connections, got %d", hub.Len())
	}

	hub.Register(&mockConn{id: "s1"})
	hub.Register(&mockConn{id: "s2"})
	hub.Register(&mockConn{id: "s3"})

	if hub.Len() != 3 {
		t.Errorf("expected 3 connections, got %d", hub.Len())
	}

	hub.Unregister("s2")
	if hub.Len() != 2 {
		t.Errorf("expected 2 connections after unregister, got %d", hub.Len())
	}
}

func TestHub_All(t *testing.T) {
	hub := NewHub()
	hub.Register(&mockConn{id: "s1"})
	hub.Register(&mockConn{id: "s2"})

	all := hub.All()
	if len(all) != 2 {
		t.Fatalf("expected 2 connections, got %d", len(all))
	}

	ids := make(map[string]bool)
	for _, c := range all {
		ids[c.SessionID()] = true
	}
	if !ids["s1"] || !ids["s2"] {
		t.Errorf("expected sessions s1 and s2, got %v", ids)
	}
}

func TestHub_RegisterReplace(t *testing.T) {
	hub := NewHub()
	conn1 := &mockConn{id: "session-1"}
	conn2 := &mockConn{id: "session-1"}

	hub.Register(conn1)
	hub.Register(conn2)

	if hub.Len() != 1 {
		t.Errorf("expected 1 connection after replace, got %d", hub.Len())
	}

	got := hub.Get("session-1")
	if got != conn2 {
		t.Error("expected the replaced connection to be the new one")
	}
}

func TestHub_ConcurrentAccess(t *testing.T) {
	hub := NewHub()
	var wg sync.WaitGroup

	// Concurrently register 100 connections
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			conn := &mockConn{id: sprintf("session-%d", id)}
			hub.Register(conn)
		}(i)
	}
	wg.Wait()

	if hub.Len() != 100 {
		t.Errorf("expected 100 connections, got %d", hub.Len())
	}

	// Concurrently get and unregister
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			sid := sprintf("session-%d", id)
			hub.Get(sid)
			hub.Unregister(sid)
		}(i)
	}
	wg.Wait()

	if hub.Len() != 0 {
		t.Errorf("expected 0 connections after unregister all, got %d", hub.Len())
	}
}

func TestHub_CloseAll(t *testing.T) {
	hub := NewHub()
	c1 := &mockConn{id: "s1"}
	c2 := &mockConn{id: "s2"}
	c3 := &mockConn{id: "s3"}
	hub.Register(c1)
	hub.Register(c2)
	hub.Register(c3)

	closed := hub.CloseAll()
	if closed != 3 {
		t.Errorf("expected 3 closed, got %d", closed)
	}
	if hub.Len() != 0 {
		t.Errorf("expected 0 connections after CloseAll, got %d", hub.Len())
	}
	if !c1.closed || !c2.closed || !c3.closed {
		t.Error("expected all connections to be closed")
	}
}

func TestHub_CloseAllEmpty(t *testing.T) {
	hub := NewHub()
	closed := hub.CloseAll()
	if closed != 0 {
		t.Errorf("expected 0 closed on empty hub, got %d", closed)
	}
}

func TestHub_SetModelAndGetModel(t *testing.T) {
	hub := NewHub()
	conn := &mockConn{id: "s1"}
	hub.Register(conn)

	hub.SetModel("s1", "anthropic/claude-sonnet-4")
	got := hub.GetModel("s1")
	if got != "anthropic/claude-sonnet-4" {
		t.Errorf("expected model 'anthropic/claude-sonnet-4', got %q", got)
	}
}

func TestHub_GetModelNotSet(t *testing.T) {
	hub := NewHub()
	got := hub.GetModel("nonexistent")
	if got != "" {
		t.Errorf("expected empty string for unset model, got %q", got)
	}
}

func TestHub_UnregisterClearsModel(t *testing.T) {
	hub := NewHub()
	conn := &mockConn{id: "s1"}
	hub.Register(conn)
	hub.SetModel("s1", "openai/gpt-4o")

	hub.Unregister("s1")

	got := hub.GetModel("s1")
	if got != "" {
		t.Errorf("expected model cleared after Unregister, got %q", got)
	}
}

func TestHub_CloseAllClearsModels(t *testing.T) {
	hub := NewHub()
	c1 := &mockConn{id: "s1"}
	c2 := &mockConn{id: "s2"}
	hub.Register(c1)
	hub.Register(c2)
	hub.SetModel("s1", "model-a")
	hub.SetModel("s2", "model-b")

	hub.CloseAll()

	if hub.GetModel("s1") != "" || hub.GetModel("s2") != "" {
		t.Error("expected models cleared after CloseAll")
	}
}

func sprintf(format string, a ...any) string {
	return fmt.Sprintf(format, a...)
}
