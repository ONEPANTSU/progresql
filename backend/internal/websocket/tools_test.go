package websocket

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
)

func TestToolDispatcher_DispatchSuccess(t *testing.T) {
	session, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	dispatcher := NewToolDispatcher(session).WithMaxRetries(0)

	args, _ := json.Marshal(map[string]string{"schema": "public"})

	// Client goroutine: read tool.call, reply with tool.result.
	go func() {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, msg, err := client.ReadMessage()
		if err != nil {
			t.Errorf("client read error: %v", err)
			return
		}

		var env Envelope
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Errorf("unmarshal error: %v", err)
			return
		}
		if env.Type != TypeToolCall {
			t.Errorf("expected type %q, got %q", TypeToolCall, env.Type)
			return
		}
		if env.CallID == "" {
			t.Error("expected non-empty call_id")
			return
		}

		var payload ToolCallPayload
		if err := env.DecodePayload(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
			return
		}
		if payload.ToolName != "list_tables" {
			t.Errorf("expected tool_name 'list_tables', got %q", payload.ToolName)
		}

		// Respond with tool.result.
		resultData, _ := json.Marshal(map[string][]string{"tables": {"users", "orders"}})
		resultPayload := ToolResultPayload{Success: true, Data: resultData}
		resultEnv, _ := NewEnvelopeWithID(TypeToolResult, env.RequestID, env.CallID, resultPayload)
		data, _ := resultEnv.Marshal()
		if err := client.WriteMessage(ws.TextMessage, data); err != nil {
			t.Errorf("client write error: %v", err)
		}
	}()

	result, err := dispatcher.Dispatch("req-1", "list_tables", args)
	if err != nil {
		t.Fatalf("Dispatch error: %v", err)
	}
	if !result.Success {
		t.Error("expected success=true")
	}
	if result.CallID == "" {
		t.Error("expected non-empty CallID in result")
	}

	var data map[string][]string
	if err := json.Unmarshal(result.Data, &data); err != nil {
		t.Fatalf("unmarshal data: %v", err)
	}
	if len(data["tables"]) != 2 {
		t.Errorf("expected 2 tables, got %d", len(data["tables"]))
	}
}

func TestToolDispatcher_DispatchTimeout(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Use short timeout for fast test.
	dispatcher := NewToolDispatcher(session).WithTimeout(200 * time.Millisecond).WithMaxRetries(0)

	args, _ := json.Marshal(map[string]string{"sql": "SELECT 1"})

	start := time.Now()
	_, err := dispatcher.Dispatch("req-timeout", "explain_query", args)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}

	if !IsToolTimeout(err) {
		t.Fatalf("expected ToolTimeoutError, got: %v", err)
	}

	timeoutErr := err.(*ToolTimeoutError)
	if timeoutErr.ToolName != "explain_query" {
		t.Errorf("expected tool_name 'explain_query', got %q", timeoutErr.ToolName)
	}
	if timeoutErr.Timeout != 200*time.Millisecond {
		t.Errorf("expected timeout 200ms, got %v", timeoutErr.Timeout)
	}

	// Should have taken approximately 200ms.
	if elapsed < 150*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Errorf("expected ~200ms timeout, got %v", elapsed)
	}
}

func TestToolDispatcher_RetryOnTimeout(t *testing.T) {
	session, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Short timeout, 1 retry. Client responds on the 2nd tool.call.
	dispatcher := NewToolDispatcher(session).WithTimeout(200 * time.Millisecond).WithMaxRetries(1)

	args, _ := json.Marshal(map[string]string{"sql": "SELECT 1"})

	callCount := 0
	go func() {
		for i := 0; i < 2; i++ {
			_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
			_, msg, err := client.ReadMessage()
			if err != nil {
				return
			}

			var env Envelope
			if err := json.Unmarshal(msg, &env); err != nil {
				return
			}
			callCount++

			if callCount == 1 {
				// First call: don't respond → timeout
				continue
			}

			// Second call: respond successfully.
			resultData, _ := json.Marshal(map[string]string{"plan": "Seq Scan"})
			resultPayload := ToolResultPayload{Success: true, Data: resultData}
			resultEnv, _ := NewEnvelopeWithID(TypeToolResult, env.RequestID, env.CallID, resultPayload)
			data, _ := resultEnv.Marshal()
			_ = client.WriteMessage(ws.TextMessage, data)
		}
	}()

	result, err := dispatcher.Dispatch("req-retry", "explain_query", args)
	if err != nil {
		t.Fatalf("expected success after retry, got error: %v", err)
	}
	if !result.Success {
		t.Error("expected success=true")
	}
	if callCount != 2 {
		t.Errorf("expected 2 tool.call attempts, got %d", callCount)
	}
}

func TestToolDispatcher_RetryExhausted(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Short timeout, 1 retry. Nobody responds → both timeout.
	dispatcher := NewToolDispatcher(session).WithTimeout(100 * time.Millisecond).WithMaxRetries(1)

	args, _ := json.Marshal(map[string]string{"sql": "SELECT 1"})

	start := time.Now()
	_, err := dispatcher.Dispatch("req-exhaust", "explain_query", args)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error after retries exhausted, got nil")
	}
	if !IsToolTimeout(err) {
		t.Fatalf("expected ToolTimeoutError, got: %v", err)
	}

	// Should have waited ~200ms total (2 attempts × 100ms).
	if elapsed < 150*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Errorf("expected ~200ms total, got %v", elapsed)
	}
}

func TestToolDispatcher_NoRetryOnNonTimeout(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	dispatcher := NewToolDispatcher(session).WithTimeout(200 * time.Millisecond).WithMaxRetries(1)

	args, _ := json.Marshal(map[string]string{"sql": "SELECT 1"})

	// Close session immediately to cause a non-timeout error.
	go func() {
		time.Sleep(50 * time.Millisecond)
		session.Close()
	}()

	_, err := dispatcher.Dispatch("req-noretry", "explain_query", args)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// Should NOT be a timeout error — session closed errors are not retried.
	if IsToolTimeout(err) {
		t.Error("expected non-timeout error, but got ToolTimeoutError")
	}
}

func TestToolDispatcher_CustomTimeout(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	dispatcher := NewToolDispatcher(session).WithTimeout(300 * time.Millisecond).WithMaxRetries(0)

	args, _ := json.Marshal(map[string]string{"sql": "SELECT 1"})

	start := time.Now()
	_, err := dispatcher.Dispatch("req-custom", "explain_query", args)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error")
	}

	if !IsToolTimeout(err) {
		t.Fatalf("expected ToolTimeoutError, got: %v", err)
	}

	if elapsed < 250*time.Millisecond || elapsed > 600*time.Millisecond {
		t.Errorf("expected ~300ms timeout, got %v", elapsed)
	}
}

func TestToolDispatcher_DefaultTimeout(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	dispatcher := NewToolDispatcher(session)

	if dispatcher.timeout != DefaultToolCallTimeout {
		t.Errorf("expected default timeout %v, got %v", DefaultToolCallTimeout, dispatcher.timeout)
	}
	if dispatcher.maxRetries != 1 {
		t.Errorf("expected default maxRetries 1, got %d", dispatcher.maxRetries)
	}
}

func TestToolDispatcher_ConcurrentDispatch(t *testing.T) {
	session, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	// Client goroutine: read tool.calls and reply to each.
	go func() {
		for i := 0; i < 3; i++ {
			_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
			_, msg, err := client.ReadMessage()
			if err != nil {
				return
			}

			var env Envelope
			if err := json.Unmarshal(msg, &env); err != nil {
				return
			}

			// Echo back as tool.result with the call_id.
			resultData, _ := json.Marshal(map[string]string{"call_id": env.CallID})
			resultPayload := ToolResultPayload{Success: true, Data: resultData}
			resultEnv, _ := NewEnvelopeWithID(TypeToolResult, env.RequestID, env.CallID, resultPayload)
			data, _ := resultEnv.Marshal()
			_ = client.WriteMessage(ws.TextMessage, data)
		}
	}()

	dispatcher := NewToolDispatcher(session).WithMaxRetries(0)

	var wg sync.WaitGroup
	results := make([]*ToolCallResult, 3)
	errors := make([]error, 3)

	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			args, _ := json.Marshal(map[string]string{"schema": "public"})
			results[idx], errors[idx] = dispatcher.Dispatch("req-concurrent", "list_tables", args)
		}(i)
	}
	wg.Wait()

	// All 3 should succeed with correct correlation.
	callIDs := make(map[string]bool)
	for i := 0; i < 3; i++ {
		if errors[i] != nil {
			t.Fatalf("dispatch %d error: %v", i, errors[i])
		}
		if !results[i].Success {
			t.Errorf("dispatch %d: expected success", i)
		}
		// Each call_id should be unique.
		if callIDs[results[i].CallID] {
			t.Errorf("duplicate call_id: %s", results[i].CallID)
		}
		callIDs[results[i].CallID] = true

		// Verify the echoed call_id matches.
		var data map[string]string
		if err := json.Unmarshal(results[i].Data, &data); err != nil {
			t.Fatalf("unmarshal data: %v", err)
		}
		if data["call_id"] != results[i].CallID {
			t.Errorf("correlation mismatch: result.CallID=%s, echoed=%s", results[i].CallID, data["call_id"])
		}
	}
}

func TestToolDispatcher_DispatchErrorResult(t *testing.T) {
	session, client, cleanup := setupTestSession(t, nil)
	defer cleanup()

	dispatcher := NewToolDispatcher(session).WithMaxRetries(0)

	// Client replies with error tool.result.
	go func() {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, msg, err := client.ReadMessage()
		if err != nil {
			return
		}

		var env Envelope
		if err := json.Unmarshal(msg, &env); err != nil {
			return
		}

		resultPayload := ToolResultPayload{Success: false, Error: "table not found"}
		resultEnv, _ := NewEnvelopeWithID(TypeToolResult, env.RequestID, env.CallID, resultPayload)
		data, _ := resultEnv.Marshal()
		_ = client.WriteMessage(ws.TextMessage, data)
	}()

	args, _ := json.Marshal(map[string]string{"schema": "nonexistent"})
	result, err := dispatcher.Dispatch("req-err", "list_tables", args)
	if err != nil {
		t.Fatalf("Dispatch error: %v", err)
	}
	if result.Success {
		t.Error("expected success=false")
	}
	if result.Error != "table not found" {
		t.Errorf("expected error 'table not found', got %q", result.Error)
	}
}

func TestToolDispatcher_SessionClosedDuringWait(t *testing.T) {
	session, _, cleanup := setupTestSession(t, nil)
	defer cleanup()

	dispatcher := NewToolDispatcher(session).WithMaxRetries(0)

	// Close session after a short delay.
	go func() {
		time.Sleep(200 * time.Millisecond)
		session.Close()
	}()

	args, _ := json.Marshal(map[string]string{"sql": "SELECT 1"})
	_, err := dispatcher.Dispatch("req-close", "explain_query", args)
	if err == nil {
		t.Fatal("expected error when session closed, got nil")
	}
}

func TestIsToolTimeout(t *testing.T) {
	timeout := &ToolTimeoutError{CallID: "abc", ToolName: "test", Timeout: 15 * time.Second}
	if !IsToolTimeout(timeout) {
		t.Error("expected IsToolTimeout=true for ToolTimeoutError")
	}
	if IsToolTimeout(ErrSessionClosed) {
		t.Error("expected IsToolTimeout=false for ErrSessionClosed")
	}
}

func TestToolTimeoutError_Message(t *testing.T) {
	err := &ToolTimeoutError{CallID: "abc", ToolName: "test", Timeout: 5 * time.Second}
	msg := err.Error()
	if msg == "" {
		t.Error("expected non-empty error message")
	}
	// Should mention the timeout duration.
	if !containsString(msg, "5s") {
		t.Errorf("error message should mention timeout duration, got: %s", msg)
	}
}

func containsString(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstr(s, substr))
}

func containsSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
