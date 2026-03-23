package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ws "github.com/gorilla/websocket"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/ratelimit"
	"github.com/onepantsu/progressql/backend/internal/security"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// --- helpers ---

// mockStep is a test Step implementation.
type mockStep struct {
	name string
	fn   func(ctx context.Context, pctx *PipelineContext) error
}

func (m *mockStep) Name() string { return m.name }

func (m *mockStep) Execute(ctx context.Context, pctx *PipelineContext) error {
	return m.fn(ctx, pctx)
}

// wsDialer creates a test WebSocket server + client pair, returning
// the Session (server side) and the client ws.Conn.
func wsDialer(t *testing.T, hub *websocket.Hub, onMessage websocket.MessageHandler) (*websocket.Session, *ws.Conn) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := ws.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade: %v", err)
		}
		sess := websocket.NewSession("test-session", c, hub, zap.NewNop(), onMessage)
		hub.Register(sess)
		sess.Run()
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := ws.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	// Wait for session to register in hub.
	var session *websocket.Session
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c := hub.Get("test-session"); c != nil {
			if s, ok := c.(*websocket.Session); ok {
				session = s
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if session == nil {
		t.Fatal("session not registered in hub")
	}
	return session, client
}

func readEnvelope(t *testing.T, client *ws.Conn) *websocket.Envelope {
	t.Helper()
	client.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := client.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	env, err := websocket.ParseEnvelope(msg)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return env
}

// --- tests ---

func TestPipeline_TwoMockSteps(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")

	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	step1 := &mockStep{
		name: "step1",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			pctx.Set("step1_ran", true)
			pctx.Result.Explanation = "step1 done"
			return nil
		},
	}
	step2 := &mockStep{
		name: "step2",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			v, ok := pctx.Get("step1_ran")
			if !ok || !v.(bool) {
				return errors.New("step1 did not run")
			}
			pctx.Result.SQL = "SELECT 1"
			pctx.ModelUsed = "test-model"
			pctx.TokensUsed = 42
			return nil
		},
	}

	p.RegisterAction("test_action", step1, step2)

	// Send agent.request.
	reqPayload := websocket.AgentRequestPayload{
		Action:      "test_action",
		UserMessage: "hello",
	}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-1", "", reqPayload)
	if err != nil {
		t.Fatal(err)
	}

	go p.HandleMessage(session, env)

	// Read agent.response.
	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	if resp.RequestID != "req-1" {
		t.Fatalf("expected request_id=req-1, got %s", resp.RequestID)
	}

	var respPayload websocket.AgentResponsePayload
	if err := resp.DecodePayload(&respPayload); err != nil {
		t.Fatal(err)
	}
	if respPayload.Result.SQL != "SELECT 1" {
		t.Errorf("expected SQL='SELECT 1', got %q", respPayload.Result.SQL)
	}
	if respPayload.Result.Explanation != "step1 done" {
		t.Errorf("expected explanation='step1 done', got %q", respPayload.Result.Explanation)
	}
	if respPayload.ModelUsed != "test-model" {
		t.Errorf("expected model=test-model, got %q", respPayload.ModelUsed)
	}
	if respPayload.TokensUsed != 42 {
		t.Errorf("expected tokens=42, got %d", respPayload.TokensUsed)
	}
}

func TestPipeline_StepError_SendsAgentError(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	failStep := &mockStep{
		name: "fail",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			return errors.New("something went wrong")
		},
	}
	neverStep := &mockStep{
		name: "never",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			t.Error("this step should not run")
			return nil
		},
	}

	p.RegisterAction("fail_action", failStep, neverStep)

	reqPayload := websocket.AgentRequestPayload{Action: "fail_action"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-err", "", reqPayload)

	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}
	if resp.RequestID != "req-err" {
		t.Fatalf("expected request_id=req-err, got %s", resp.RequestID)
	}

	var errPayload websocket.AgentErrorPayload
	if err := resp.DecodePayload(&errPayload); err != nil {
		t.Fatal(err)
	}
	if errPayload.Code != websocket.ErrCodeInvalidRequest {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeInvalidRequest, errPayload.Code)
	}
	if errPayload.Message != "something went wrong" {
		t.Errorf("expected message='something went wrong', got %q", errPayload.Message)
	}
}

func TestPipeline_UnknownAction(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	reqPayload := websocket.AgentRequestPayload{Action: "nonexistent"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-unk", "", reqPayload)

	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	var errPayload websocket.AgentErrorPayload
	resp.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeInvalidRequest {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeInvalidRequest, errPayload.Code)
	}
	if !strings.Contains(errPayload.Message, "unknown action") {
		t.Errorf("expected message containing 'unknown action', got %q", errPayload.Message)
	}
}

func TestPipeline_ContextPassedBetweenSteps(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("ctx_test",
		&mockStep{
			name: "set_context",
			fn: func(ctx context.Context, pctx *PipelineContext) error {
				if pctx.UserMessage != "test message" {
					return errors.New("user_message not passed")
				}
				if pctx.SelectedSQL != "SELECT 1" {
					return errors.New("selected_sql not passed")
				}
				pctx.Set("data", []string{"a", "b"})
				return nil
			},
		},
		&mockStep{
			name: "read_context",
			fn: func(ctx context.Context, pctx *PipelineContext) error {
				v, ok := pctx.Get("data")
				if !ok {
					return errors.New("data not found in context")
				}
				data := v.([]string)
				if len(data) != 2 || data[0] != "a" {
					return errors.New("unexpected data")
				}
				pctx.Result.Explanation = "context works"
				return nil
			},
		},
	)

	reqPayload := websocket.AgentRequestPayload{
		Action:      "ctx_test",
		UserMessage: "test message",
		Context:     &websocket.AgentRequestContext{SelectedSQL: "SELECT 1"},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-ctx", "", reqPayload)

	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}

	var respPayload websocket.AgentResponsePayload
	resp.DecodePayload(&respPayload)
	if respPayload.Result.Explanation != "context works" {
		t.Errorf("expected 'context works', got %q", respPayload.Result.Explanation)
	}
}

func TestPipeline_ToolCallLogTracked(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("log_test",
		&mockStep{
			name: "log_tools",
			fn: func(ctx context.Context, pctx *PipelineContext) error {
				pctx.AddToolCallLog("call-1", "list_tables", true)
				pctx.AddToolCallLog("call-2", "describe_table", false)
				pctx.AddTokens(100)
				pctx.AddTokens(50)
				return nil
			},
		},
	)

	reqPayload := websocket.AgentRequestPayload{Action: "log_test"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-log", "", reqPayload)

	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}

	var respPayload websocket.AgentResponsePayload
	resp.DecodePayload(&respPayload)

	if len(respPayload.ToolCallsLog) != 2 {
		t.Fatalf("expected 2 tool call log entries, got %d", len(respPayload.ToolCallsLog))
	}
	if respPayload.ToolCallsLog[0].ToolName != "list_tables" || !respPayload.ToolCallsLog[0].Success {
		t.Error("first log entry mismatch")
	}
	if respPayload.ToolCallsLog[1].ToolName != "describe_table" || respPayload.ToolCallsLog[1].Success {
		t.Error("second log entry mismatch")
	}
	if respPayload.TokensUsed != 150 {
		t.Errorf("expected tokens=150, got %d", respPayload.TokensUsed)
	}
}

func TestPipeline_InvalidPayload(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	// Send envelope with invalid payload JSON.
	env := &websocket.Envelope{
		Type:      websocket.TypeAgentRequest,
		RequestID: "req-bad",
		Payload:   json.RawMessage(`{invalid json`),
	}

	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	var errPayload websocket.AgentErrorPayload
	resp.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeInvalidRequest {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeInvalidRequest, errPayload.Code)
	}
}

func TestPipeline_IgnoresNonAgentRequest(t *testing.T) {
	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	// Should not panic or do anything with non-agent.request type.
	env := &websocket.Envelope{Type: websocket.TypeToolResult}
	p.HandleMessage(nil, env) // session is nil — would panic if code tried to use it
}

func TestPipeline_GeneratesRequestIDIfMissing(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("id_test", &mockStep{
		name: "noop",
		fn:   func(ctx context.Context, pctx *PipelineContext) error { return nil },
	})

	reqPayload := websocket.AgentRequestPayload{Action: "id_test"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "", "", reqPayload)

	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	if resp.RequestID == "" {
		t.Error("expected auto-generated request_id, got empty")
	}
}

// wsDialerWithLogger is like wsDialer but accepts a custom logger.
func wsDialerWithLogger(t *testing.T, hub *websocket.Hub, log *zap.Logger, onMessage websocket.MessageHandler) (*websocket.Session, *ws.Conn) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := ws.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade: %v", err)
		}
		sess := websocket.NewSession("audit-session", c, hub, log, onMessage)
		hub.Register(sess)
		sess.Run()
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := ws.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	var session *websocket.Session
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c := hub.Get("audit-session"); c != nil {
			if s, ok := c.(*websocket.Session); ok {
				session = s
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if session == nil {
		t.Fatal("session not registered in hub")
	}
	return session, client
}

func TestPipeline_AuditLog_Success(t *testing.T) {
	core, logs := observer.New(zapcore.InfoLevel)
	log := zap.New(core)

	hub := websocket.NewHub()
	session, client := wsDialerWithLogger(t, hub, log, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), log, "test-model")

	p.RegisterAction("audit_test", &mockStep{
		name: "audit_step",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			pctx.AddToolCallLog("call-1", "list_tables", true)
			pctx.AddToolCallLog("call-2", "describe_table", true)
			pctx.ModelUsed = "test-model"
			pctx.TokensUsed = 200
			pctx.Result.SQL = "SELECT 1"
			return nil
		},
	})

	reqPayload := websocket.AgentRequestPayload{Action: "audit_test"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-audit", "", reqPayload)

	go p.HandleMessage(session, env)

	// Consume response.
	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}

	// Wait briefly for the audit log to be emitted after response send.
	time.Sleep(100 * time.Millisecond)

	// Find audit log entry.
	var auditEntry observer.LoggedEntry
	found := false
	for _, entry := range logs.All() {
		for _, f := range entry.ContextMap() {
			if f == "agent_request" {
				auditEntry = entry
				found = true
				break
			}
		}
	}
	if !found {
		t.Fatal("audit log entry not found")
	}

	// Verify all required fields.
	ctx := auditEntry.ContextMap()

	if ctx["session_id"] != "audit-session" {
		t.Errorf("expected session_id=audit-session, got %v", ctx["session_id"])
	}
	if ctx["request_id"] != "req-audit" {
		t.Errorf("expected request_id=req-audit, got %v", ctx["request_id"])
	}
	if ctx["action"] != "audit_test" {
		t.Errorf("expected action=audit_test, got %v", ctx["action"])
	}
	if ctx["model"] != "test-model" {
		t.Errorf("expected model=test-model, got %v", ctx["model"])
	}
	if v, ok := ctx["tokens"].(int64); !ok || v != 200 {
		t.Errorf("expected tokens=200, got %v", ctx["tokens"])
	}
	if v, ok := ctx["tool_calls"].(int64); !ok || v != 2 {
		t.Errorf("expected tool_calls=2, got %v", ctx["tool_calls"])
	}
	if v, ok := ctx["duration_ms"].(int64); !ok || v < 0 {
		t.Errorf("expected duration_ms >= 0, got %v", ctx["duration_ms"])
	}

	// Should be info level (no error).
	if auditEntry.Level != zapcore.InfoLevel {
		t.Errorf("expected info level for success, got %s", auditEntry.Level)
	}

	// No error field.
	if _, hasErr := ctx["error"]; hasErr {
		t.Error("expected no error field on success")
	}
}

func TestPipeline_AuditLog_StepError(t *testing.T) {
	core, logs := observer.New(zapcore.DebugLevel)
	log := zap.New(core)

	hub := websocket.NewHub()
	session, client := wsDialerWithLogger(t, hub, log, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), log, "test-model")

	p.RegisterAction("fail_audit", &mockStep{
		name: "fail_step",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			pctx.AddToolCallLog("call-1", "list_tables", true)
			pctx.TokensUsed = 50
			return errors.New("step exploded")
		},
	})

	reqPayload := websocket.AgentRequestPayload{Action: "fail_audit"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-fail-audit", "", reqPayload)

	go p.HandleMessage(session, env)

	// Consume error response.
	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	time.Sleep(100 * time.Millisecond)

	// Find audit log entry with error.
	var auditEntry observer.LoggedEntry
	found := false
	for _, entry := range logs.All() {
		ctx := entry.ContextMap()
		if ctx["audit"] == "agent_request" && entry.Level == zapcore.ErrorLevel {
			auditEntry = entry
			found = true
			break
		}
	}
	if !found {
		t.Fatal("audit error log entry not found")
	}

	ctx := auditEntry.ContextMap()

	if ctx["session_id"] != "audit-session" {
		t.Errorf("expected session_id=audit-session, got %v", ctx["session_id"])
	}
	if ctx["action"] != "fail_audit" {
		t.Errorf("expected action=fail_audit, got %v", ctx["action"])
	}
	if ctx["error"] != "step exploded" {
		t.Errorf("expected error='step exploded', got %v", ctx["error"])
	}
	if v, ok := ctx["tool_calls"].(int64); !ok || v != 1 {
		t.Errorf("expected tool_calls=1, got %v", ctx["tool_calls"])
	}
	if v, ok := ctx["tokens"].(int64); !ok || v != 50 {
		t.Errorf("expected tokens=50, got %v", ctx["tokens"])
	}
}

func TestPipeline_AuditLog_UnknownAction(t *testing.T) {
	core, logs := observer.New(zapcore.DebugLevel)
	log := zap.New(core)

	hub := websocket.NewHub()
	session, client := wsDialerWithLogger(t, hub, log, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), log, "test-model")

	reqPayload := websocket.AgentRequestPayload{Action: "nonexistent_action"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-unk-audit", "", reqPayload)

	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	time.Sleep(100 * time.Millisecond)

	// Find audit log entry for unknown action.
	found := false
	for _, entry := range logs.All() {
		ctx := entry.ContextMap()
		if ctx["audit"] == "agent_request" && entry.Level == zapcore.ErrorLevel {
			if ctx["action"] != "nonexistent_action" {
				t.Errorf("expected action=nonexistent_action, got %v", ctx["action"])
			}
			if _, hasErr := ctx["error"]; !hasErr {
				t.Error("expected error field")
			}
			found = true
			break
		}
	}
	if !found {
		t.Fatal("audit log entry for unknown action not found")
	}
}

func TestPipeline_AuditLog_ToolNames(t *testing.T) {
	core, logs := observer.New(zapcore.InfoLevel)
	log := zap.New(core)

	hub := websocket.NewHub()
	session, client := wsDialerWithLogger(t, hub, log, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), log, "test-model")

	p.RegisterAction("tools_audit", &mockStep{
		name: "multi_tools",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			pctx.AddToolCallLog("c1", "list_schemas", true)
			pctx.AddToolCallLog("c2", "list_tables", true)
			pctx.AddToolCallLog("c3", "describe_table", false)
			return nil
		},
	})

	reqPayload := websocket.AgentRequestPayload{Action: "tools_audit"}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-tools", "", reqPayload)

	go p.HandleMessage(session, env)

	readEnvelope(t, client)
	time.Sleep(100 * time.Millisecond)

	// Find audit and check tool_names array.
	for _, entry := range logs.All() {
		ctx := entry.ContextMap()
		if ctx["audit"] == "agent_request" {
			// Verify tool_names contains all 3 tool names.
			toolNames, ok := ctx["tool_names"]
			if !ok {
				t.Fatal("expected tool_names field in audit log")
			}
			names, ok := toolNames.([]interface{})
			if !ok {
				t.Fatalf("expected tool_names to be []interface{}, got %T", toolNames)
			}
			if len(names) != 3 {
				t.Fatalf("expected 3 tool names, got %d", len(names))
			}
			expected := []string{"list_schemas", "list_tables", "describe_table"}
			for i, n := range names {
				if n != expected[i] {
					t.Errorf("tool_names[%d]: expected %s, got %v", i, expected[i], n)
				}
			}
			return
		}
	}
	t.Fatal("audit log entry not found")
}

func TestPipeline_ErrorCode_ToolTimeout(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("timeout_test", &mockStep{
		name: "timeout_step",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			// Wrap a ToolTimeoutError like real steps do.
			inner := &websocket.ToolTimeoutError{CallID: "call-1", ToolName: "list_tables"}
			return fmt.Errorf("list_tables failed: %w", inner)
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-timeout", "", websocket.AgentRequestPayload{Action: "timeout_test"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	var errPayload websocket.AgentErrorPayload
	resp.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeToolTimeout {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeToolTimeout, errPayload.Code)
	}
}

func TestPipeline_ErrorCode_LLMError(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("llm_err_test", &mockStep{
		name: "llm_err_step",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			// Wrap an APIError like real steps do.
			inner := &llm.APIError{StatusCode: 500, Body: "internal server error"}
			return fmt.Errorf("LLM streaming failed: %w", inner)
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-llm-err", "", websocket.AgentRequestPayload{Action: "llm_err_test"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	var errPayload websocket.AgentErrorPayload
	resp.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeLLMError {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeLLMError, errPayload.Code)
	}
}

func TestPipeline_ErrorCode_SQLBlocked(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("sql_blocked_test", &mockStep{
		name: "sql_blocked_step",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			// Simulate a step that checks SQL and finds it blocked.
			err := security.CheckSQL("DROP TABLE users")
			return fmt.Errorf("sql validation: %w", err)
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-sql-blocked", "", websocket.AgentRequestPayload{Action: "sql_blocked_test"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	var errPayload websocket.AgentErrorPayload
	resp.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeSQLBlocked {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeSQLBlocked, errPayload.Code)
	}
}

func TestPipeline_ErrorCode_InvalidRequest(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("invalid_test", &mockStep{
		name: "invalid_step",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			return errors.New("missing required field")
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-invalid", "", websocket.AgentRequestPayload{Action: "invalid_test"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	var errPayload websocket.AgentErrorPayload
	resp.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeInvalidRequest {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeInvalidRequest, errPayload.Code)
	}
}

func TestPipeline_RateLimited(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")
	p.SetRateLimiter(ratelimit.New(2, time.Minute))

	p.RegisterAction("rate_test", &mockStep{
		name: "noop",
		fn:   func(ctx context.Context, pctx *PipelineContext) error { return nil },
	})

	// First two requests should succeed.
	for i := 0; i < 2; i++ {
		env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, fmt.Sprintf("req-%d", i), "", websocket.AgentRequestPayload{Action: "rate_test"})
		go p.HandleMessage(session, env)
		resp := readEnvelope(t, client)
		if resp.Type != websocket.TypeAgentResponse {
			t.Fatalf("request %d: expected agent.response, got %s", i, resp.Type)
		}
	}

	// Third request should be rate limited.
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-blocked", "", websocket.AgentRequestPayload{Action: "rate_test"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentError {
		t.Fatalf("expected agent.error, got %s", resp.Type)
	}

	var errPayload websocket.AgentErrorPayload
	resp.DecodePayload(&errPayload)
	if errPayload.Code != websocket.ErrCodeRateLimited {
		t.Errorf("expected code=%s, got %s", websocket.ErrCodeRateLimited, errPayload.Code)
	}
}

func TestPipeline_ModelFromSession(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	// Set the model on the session (simulating what HandleWebSocket does after reading from Hub).
	session.SetModel("qwen/qwen3-coder")

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	var capturedModel string
	p.RegisterAction("check_model", &mockStep{
		name: "capture_model",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedModel = pctx.Model
			return nil
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-model", "", websocket.AgentRequestPayload{Action: "check_model"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	if capturedModel != "qwen/qwen3-coder" {
		t.Errorf("expected pctx.Model='qwen/qwen3-coder', got %q", capturedModel)
	}
}

func TestPipeline_ModelFallsBackToDefault(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	// Do NOT set model on session — should fall back to pipeline's defaultModel.

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	var capturedModel string
	p.RegisterAction("check_model", &mockStep{
		name: "capture_model",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedModel = pctx.Model
			return nil
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-empty-model", "", websocket.AgentRequestPayload{Action: "check_model"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}
	if capturedModel != "test-model" {
		t.Errorf("expected pctx.Model='test-model' (pipeline default), got %q", capturedModel)
	}
}

func TestPipeline_NoRateLimiter(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")
	// No rate limiter set — should handle unlimited requests.

	p.RegisterAction("unlimited", &mockStep{
		name: "noop",
		fn:   func(ctx context.Context, pctx *PipelineContext) error { return nil },
	})

	for i := 0; i < 5; i++ {
		env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, fmt.Sprintf("req-%d", i), "", websocket.AgentRequestPayload{Action: "unlimited"})
		go p.HandleMessage(session, env)
		resp := readEnvelope(t, client)
		if resp.Type != websocket.TypeAgentResponse {
			t.Fatalf("request %d: expected agent.response, got %s", i, resp.Type)
		}
	}
}

func TestPipeline_DBNotConnected_SendsFriendlyResponse(t *testing.T) {
	// When a step returns DatabaseNotConnectedError, the pipeline should send
	// agent.response with a friendly explanation instead of agent.error.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("test_action", &mockStep{
		name: "db_check",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			return NewDatabaseNotConnectedError("list_tables")
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-db", "", websocket.AgentRequestPayload{Action: "test_action"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}

	var payload websocket.AgentResponsePayload
	if err := resp.DecodePayload(&payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}

	if payload.Result.Explanation == "" {
		t.Error("expected non-empty explanation in response")
	}
	// The fallback message (LLM unavailable in tests) should contain bilingual text.
	if !strings.Contains(payload.Result.Explanation, "SQL") {
		t.Errorf("expected friendly message about SQL/database, got: %s", payload.Result.Explanation)
	}
}

func TestPipeline_DBNotConnected_WrappedError(t *testing.T) {
	// Wrapped DatabaseNotConnectedError should also trigger the friendly response.
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	p := NewPipeline(llm.NewClient("test"), tools.NewRegistry(), zap.NewNop(), "test-model")

	p.RegisterAction("test_action", &mockStep{
		name: "db_check",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			return fmt.Errorf("step failed: %w", NewDatabaseNotConnectedError("list_schemas"))
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-db2", "", websocket.AgentRequestPayload{Action: "test_action"})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}

	var payload websocket.AgentResponsePayload
	if err := resp.DecodePayload(&payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}

	// The fallback message (LLM unavailable in tests) should contain bilingual text.
	if !strings.Contains(payload.Result.Explanation, "SQL") {
		t.Errorf("expected friendly message about SQL/database, got: %s", payload.Result.Explanation)
	}
}

// TestPipeline_ConversationHistoryStoredInSession verifies that after a successful
// agent.request, the user message and assistant response are stored in the session history.
func TestPipeline_ConversationHistoryStoredInSession(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")

	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction("test_action", &mockStep{
		name: "mock",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			pctx.Result.Explanation = "here are your tables"
			pctx.Result.SQL = "SELECT * FROM users"
			return nil
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-hist1", "", websocket.AgentRequestPayload{
		Action:      "test_action",
		UserMessage: "show me all users",
	})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}

	// Check history was stored in session.
	history := session.GetHistory()
	if len(history) != 2 {
		t.Fatalf("expected 2 history messages, got %d", len(history))
	}
	if history[0].Role != "user" || history[0].Content != "show me all users" {
		t.Errorf("unexpected user history: %+v", history[0])
	}
	if history[1].Role != "assistant" {
		t.Errorf("expected assistant role, got %s", history[1].Role)
	}
	if !strings.Contains(history[1].Content, "SELECT * FROM users") {
		t.Errorf("expected SQL in assistant history, got: %s", history[1].Content)
	}
}

// TestPipeline_ConversationHistoryPassedToSteps verifies that conversation history
// from previous requests is available in PipelineContext.ConversationHistory.
func TestPipeline_ConversationHistoryPassedToSteps(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")

	// Pre-populate session history (simulating a prior turn).
	session.AddHistory("user", "show tables")
	session.AddHistory("assistant", "Here are the tables: users, orders")

	var capturedHistory []llm.Message

	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction("test_action", &mockStep{
		name: "capture",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedHistory = pctx.ConversationHistory
			pctx.Result.Explanation = "done"
			return nil
		},
	})

	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-hist2", "", websocket.AgentRequestPayload{
		Action:      "test_action",
		UserMessage: "show columns of users",
	})
	go p.HandleMessage(session, env)

	resp := readEnvelope(t, client)
	if resp.Type != websocket.TypeAgentResponse {
		t.Fatalf("expected agent.response, got %s", resp.Type)
	}

	// Verify the step received the prior conversation history.
	if len(capturedHistory) != 2 {
		t.Fatalf("expected 2 history messages in pctx, got %d", len(capturedHistory))
	}
	if capturedHistory[0].Role != "user" || capturedHistory[0].Content != "show tables" {
		t.Errorf("unexpected first history message: %+v", capturedHistory[0])
	}
	if capturedHistory[1].Role != "assistant" || capturedHistory[1].Content != "Here are the tables: users, orders" {
		t.Errorf("unexpected second history message: %+v", capturedHistory[1])
	}
}

// TestPipeline_ConversationHistoryMultiTurn verifies that sequential requests
// accumulate history correctly.
func TestPipeline_ConversationHistoryMultiTurn(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")

	var turnHistoryLengths []int

	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")
	p.RegisterAction("test_action", &mockStep{
		name: "track",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			turnHistoryLengths = append(turnHistoryLengths, len(pctx.ConversationHistory))
			pctx.Result.Explanation = "response for: " + pctx.UserMessage
			return nil
		},
	})

	// Send 3 sequential requests.
	for i, msg := range []string{"first", "second", "third"} {
		env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, fmt.Sprintf("req-%d", i), "", websocket.AgentRequestPayload{
			Action:      "test_action",
			UserMessage: msg,
		})
		p.HandleMessage(session, env)

		resp := readEnvelope(t, client)
		if resp.Type != websocket.TypeAgentResponse {
			t.Fatalf("turn %d: expected agent.response, got %s", i, resp.Type)
		}
	}

	// Verify history growth: 0, 2, 4 (each turn adds user+assistant = 2 messages).
	expected := []int{0, 2, 4}
	if len(turnHistoryLengths) != 3 {
		t.Fatalf("expected 3 turns, got %d", len(turnHistoryLengths))
	}
	for i, exp := range expected {
		if turnHistoryLengths[i] != exp {
			t.Errorf("turn %d: expected %d history messages, got %d", i, exp, turnHistoryLengths[i])
		}
	}

	// Final session history should have 6 messages (3 user + 3 assistant).
	finalHistory := session.GetHistory()
	if len(finalHistory) != 6 {
		t.Fatalf("expected 6 final history messages, got %d", len(finalHistory))
	}
}

// TestPipeline_MessagesWithHistory verifies the helper method.
func TestPipeline_MessagesWithHistory(t *testing.T) {
	pctx := NewPipelineContext()

	// Without history, should return system prompt + input messages.
	msgs := pctx.MessagesWithHistory(llm.Message{Role: "user", Content: "hello"})
	// system prompt + 1 user message = 2
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (system + user), got %d", len(msgs))
	}
	if msgs[0].Role != "system" {
		t.Errorf("expected first message to be system prompt, got role=%s", msgs[0].Role)
	}
	if msgs[1].Content != "hello" {
		t.Errorf("expected user message, got: %s", msgs[1].Content)
	}

	// With history, should prepend system + history before new messages.
	pctx.ConversationHistory = []llm.Message{
		{Role: "user", Content: "prev question"},
		{Role: "assistant", Content: "prev answer"},
	}
	msgs = pctx.MessagesWithHistory(llm.Message{Role: "user", Content: "new question"})
	// system + 2 history + 1 new = 4
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages (system + 2 history + 1 new), got %d", len(msgs))
	}
	if msgs[0].Role != "system" {
		t.Errorf("expected system prompt first, got role=%s", msgs[0].Role)
	}
	if msgs[1].Content != "prev question" {
		t.Errorf("expected history second, got: %s", msgs[1].Content)
	}
	if msgs[3].Content != "new question" {
		t.Errorf("expected new message last, got: %s", msgs[3].Content)
	}
}

func TestPipeline_SecurityMode_DefaultsToSafe(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")
	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	var capturedMode string
	step := &mockStep{
		name: "check_security_mode",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedMode = pctx.SecurityMode
			return nil
		},
	}
	p.RegisterAction("test", step)

	// Send request WITHOUT security_mode or safe_mode in context — should default to "safe".
	reqPayload := websocket.AgentRequestPayload{
		Action:      "test",
		UserMessage: "hello",
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-1", "", reqPayload)
	go p.HandleMessage(session, env)

	readEnvelope(t, client)
	if capturedMode != "safe" {
		t.Errorf("SecurityMode should default to 'safe' when not specified, got %q", capturedMode)
	}
}

func TestPipeline_SecurityMode_FromSecurityModeField(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")
	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	var capturedMode string
	step := &mockStep{
		name: "check_security_mode",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedMode = pctx.SecurityMode
			return nil
		},
	}
	p.RegisterAction("test", step)

	dataMode := "data"
	reqPayload := websocket.AgentRequestPayload{
		Action:      "test",
		UserMessage: "hello",
		Context: &websocket.AgentRequestContext{
			SecurityMode: &dataMode,
		},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-1", "", reqPayload)
	go p.HandleMessage(session, env)

	readEnvelope(t, client)
	if capturedMode != "data" {
		t.Errorf("SecurityMode should be 'data' when explicitly set, got %q", capturedMode)
	}
}

func TestPipeline_SecurityMode_ExecuteMode(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")
	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	var capturedMode string
	step := &mockStep{
		name: "check_security_mode",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedMode = pctx.SecurityMode
			return nil
		},
	}
	p.RegisterAction("test", step)

	executeMode := "execute"
	reqPayload := websocket.AgentRequestPayload{
		Action:      "test",
		UserMessage: "hello",
		Context: &websocket.AgentRequestContext{
			SecurityMode: &executeMode,
		},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-1", "", reqPayload)
	go p.HandleMessage(session, env)

	readEnvelope(t, client)
	if capturedMode != "execute" {
		t.Errorf("SecurityMode should be 'execute' when explicitly set, got %q", capturedMode)
	}
}

func TestPipeline_SecurityMode_BackwardCompat_SafeModeTrue(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")
	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	var capturedMode string
	step := &mockStep{
		name: "check_security_mode",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedMode = pctx.SecurityMode
			return nil
		},
	}
	p.RegisterAction("test", step)

	// Old client sends safe_mode=true, should map to SecurityMode="safe".
	safeModeTrue := true
	reqPayload := websocket.AgentRequestPayload{
		Action:      "test",
		UserMessage: "hello",
		Context: &websocket.AgentRequestContext{
			SafeMode: &safeModeTrue,
		},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-1", "", reqPayload)
	go p.HandleMessage(session, env)

	readEnvelope(t, client)
	if capturedMode != "safe" {
		t.Errorf("SecurityMode should be 'safe' when old safe_mode=true, got %q", capturedMode)
	}
}

func TestPipeline_SecurityMode_BackwardCompat_SafeModeFalse(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")
	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	var capturedMode string
	step := &mockStep{
		name: "check_security_mode",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedMode = pctx.SecurityMode
			return nil
		},
	}
	p.RegisterAction("test", step)

	// Old client sends safe_mode=false, should map to SecurityMode="execute".
	safeModeFalse := false
	reqPayload := websocket.AgentRequestPayload{
		Action:      "test",
		UserMessage: "hello",
		Context: &websocket.AgentRequestContext{
			SafeMode: &safeModeFalse,
		},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-1", "", reqPayload)
	go p.HandleMessage(session, env)

	readEnvelope(t, client)
	if capturedMode != "execute" {
		t.Errorf("SecurityMode should be 'execute' when old safe_mode=false, got %q", capturedMode)
	}
}

func TestPipeline_SecurityMode_NewFieldTakesPriority(t *testing.T) {
	hub := websocket.NewHub()
	session, client := wsDialer(t, hub, nil)

	registry := tools.NewRegistry()
	llmClient := llm.NewClient("test-key")
	p := NewPipeline(llmClient, registry, zap.NewNop(), "test-model")

	var capturedMode string
	step := &mockStep{
		name: "check_security_mode",
		fn: func(ctx context.Context, pctx *PipelineContext) error {
			capturedMode = pctx.SecurityMode
			return nil
		},
	}
	p.RegisterAction("test", step)

	// Both fields set — SecurityMode should take priority.
	safeModeTrue := true
	dataMode := "data"
	reqPayload := websocket.AgentRequestPayload{
		Action:      "test",
		UserMessage: "hello",
		Context: &websocket.AgentRequestContext{
			SafeMode:     &safeModeTrue,
			SecurityMode: &dataMode,
		},
	}
	env, _ := websocket.NewEnvelopeWithID(websocket.TypeAgentRequest, "req-1", "", reqPayload)
	go p.HandleMessage(session, env)

	readEnvelope(t, client)
	if capturedMode != "data" {
		t.Errorf("SecurityMode should be 'data' (new field priority), got %q", capturedMode)
	}
}
