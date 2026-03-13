package websocket

import (
	"encoding/json"
	"testing"
)

func TestAgentRequest_MarshalUnmarshal(t *testing.T) {
	payload := AgentRequestPayload{
		Action:      "generate_sql",
		UserMessage: "покажи топ 10 пользователей",
		Context: &AgentRequestContext{
			SelectedSQL: "SELECT * FROM users",
			ActiveTable: "users",
		},
	}

	env, err := NewEnvelopeWithID(TypeAgentRequest, "req-123", "", &payload)
	if err != nil {
		t.Fatalf("NewEnvelopeWithID: %v", err)
	}

	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	parsed, err := ParseEnvelope(data)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}

	if parsed.Type != TypeAgentRequest {
		t.Errorf("Type = %q, want %q", parsed.Type, TypeAgentRequest)
	}
	if parsed.RequestID != "req-123" {
		t.Errorf("RequestID = %q, want %q", parsed.RequestID, "req-123")
	}

	var decoded AgentRequestPayload
	if err := parsed.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if decoded.Action != "generate_sql" {
		t.Errorf("Action = %q, want %q", decoded.Action, "generate_sql")
	}
	if decoded.UserMessage != "покажи топ 10 пользователей" {
		t.Errorf("UserMessage mismatch")
	}
	if decoded.Context == nil {
		t.Fatal("Context is nil")
	}
	if decoded.Context.SelectedSQL != "SELECT * FROM users" {
		t.Errorf("SelectedSQL = %q, want %q", decoded.Context.SelectedSQL, "SELECT * FROM users")
	}
	if decoded.Context.ActiveTable != "users" {
		t.Errorf("ActiveTable = %q, want %q", decoded.Context.ActiveTable, "users")
	}
}

func TestToolResult_MarshalUnmarshal(t *testing.T) {
	tableData := map[string]any{
		"tables": []string{"users", "orders", "products"},
	}
	rawData, _ := json.Marshal(tableData)

	payload := ToolResultPayload{
		Success: true,
		Data:    rawData,
	}

	env, err := NewEnvelopeWithID(TypeToolResult, "", "call-456", &payload)
	if err != nil {
		t.Fatalf("NewEnvelopeWithID: %v", err)
	}

	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	parsed, err := ParseEnvelope(data)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}

	if parsed.Type != TypeToolResult {
		t.Errorf("Type = %q, want %q", parsed.Type, TypeToolResult)
	}
	if parsed.CallID != "call-456" {
		t.Errorf("CallID = %q, want %q", parsed.CallID, "call-456")
	}

	var decoded ToolResultPayload
	if err := parsed.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if !decoded.Success {
		t.Error("Success = false, want true")
	}

	var decodedData map[string]any
	if err := json.Unmarshal(decoded.Data, &decodedData); err != nil {
		t.Fatalf("Unmarshal data: %v", err)
	}
	tables, ok := decodedData["tables"].([]any)
	if !ok || len(tables) != 3 {
		t.Errorf("tables length = %d, want 3", len(tables))
	}
}

func TestToolCall_MarshalUnmarshal(t *testing.T) {
	args, _ := json.Marshal(map[string]string{"schema": "public"})
	payload := ToolCallPayload{
		ToolName:  "list_tables",
		Arguments: args,
	}

	env, err := NewEnvelopeWithID(TypeToolCall, "req-789", "call-101", &payload)
	if err != nil {
		t.Fatalf("NewEnvelopeWithID: %v", err)
	}

	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	parsed, err := ParseEnvelope(data)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}

	if parsed.Type != TypeToolCall {
		t.Errorf("Type = %q, want %q", parsed.Type, TypeToolCall)
	}

	var decoded ToolCallPayload
	if err := parsed.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if decoded.ToolName != "list_tables" {
		t.Errorf("ToolName = %q, want %q", decoded.ToolName, "list_tables")
	}
}

func TestAgentStream_MarshalUnmarshal(t *testing.T) {
	payload := AgentStreamPayload{
		Delta: "SELECT u.name, COUNT(o.id)",
	}

	env, err := NewEnvelopeWithID(TypeAgentStream, "req-stream-1", "", &payload)
	if err != nil {
		t.Fatalf("NewEnvelopeWithID: %v", err)
	}

	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	parsed, err := ParseEnvelope(data)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}

	if parsed.Type != TypeAgentStream {
		t.Errorf("Type = %q, want %q", parsed.Type, TypeAgentStream)
	}

	var decoded AgentStreamPayload
	if err := parsed.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if decoded.Delta != "SELECT u.name, COUNT(o.id)" {
		t.Errorf("Delta = %q, want %q", decoded.Delta, "SELECT u.name, COUNT(o.id)")
	}
}

func TestAgentResponse_MarshalUnmarshal(t *testing.T) {
	payload := AgentResponsePayload{
		Action: "generate_sql",
		Result: AgentResult{
			SQL:         "SELECT * FROM users ORDER BY created_at DESC LIMIT 10",
			Explanation: "Fetches the 10 most recent users",
			Candidates:  []string{"SELECT * FROM users LIMIT 10", "SELECT * FROM users ORDER BY id DESC LIMIT 10"},
		},
		ToolCallsLog: []ToolCallLogEntry{
			{CallID: "c1", ToolName: "list_tables", Success: true},
			{CallID: "c2", ToolName: "describe_table", Success: true},
		},
		ModelUsed:  "anthropic/claude-3.5-sonnet",
		TokensUsed: 1500,
	}

	env, err := NewEnvelopeWithID(TypeAgentResponse, "req-final", "", &payload)
	if err != nil {
		t.Fatalf("NewEnvelopeWithID: %v", err)
	}

	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	parsed, err := ParseEnvelope(data)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}

	if parsed.Type != TypeAgentResponse {
		t.Errorf("Type = %q, want %q", parsed.Type, TypeAgentResponse)
	}

	var decoded AgentResponsePayload
	if err := parsed.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if decoded.Action != "generate_sql" {
		t.Errorf("Action = %q, want %q", decoded.Action, "generate_sql")
	}
	if decoded.Result.SQL != "SELECT * FROM users ORDER BY created_at DESC LIMIT 10" {
		t.Errorf("SQL mismatch")
	}
	if len(decoded.Result.Candidates) != 2 {
		t.Errorf("Candidates length = %d, want 2", len(decoded.Result.Candidates))
	}
	if len(decoded.ToolCallsLog) != 2 {
		t.Errorf("ToolCallsLog length = %d, want 2", len(decoded.ToolCallsLog))
	}
	if decoded.ModelUsed != "anthropic/claude-3.5-sonnet" {
		t.Errorf("ModelUsed = %q", decoded.ModelUsed)
	}
	if decoded.TokensUsed != 1500 {
		t.Errorf("TokensUsed = %d, want 1500", decoded.TokensUsed)
	}
}

func TestAgentError_MarshalUnmarshal(t *testing.T) {
	payload := AgentErrorPayload{
		Code:    ErrCodeToolTimeout,
		Message: "tool.call timed out after 10 seconds",
	}

	env, err := NewEnvelopeWithID(TypeAgentError, "req-err-1", "", &payload)
	if err != nil {
		t.Fatalf("NewEnvelopeWithID: %v", err)
	}

	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	parsed, err := ParseEnvelope(data)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}

	if parsed.Type != TypeAgentError {
		t.Errorf("Type = %q, want %q", parsed.Type, TypeAgentError)
	}

	var decoded AgentErrorPayload
	if err := parsed.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if decoded.Code != ErrCodeToolTimeout {
		t.Errorf("Code = %q, want %q", decoded.Code, ErrCodeToolTimeout)
	}
	if decoded.Message != "tool.call timed out after 10 seconds" {
		t.Errorf("Message mismatch")
	}
}

func TestRouteByType(t *testing.T) {
	// Simulate routing by parsing JSON and dispatching based on type field.
	messages := []struct {
		json     string
		wantType string
	}{
		{`{"type":"agent.request","request_id":"r1","payload":{"action":"generate_sql"}}`, TypeAgentRequest},
		{`{"type":"tool.result","call_id":"c1","payload":{"success":true}}`, TypeToolResult},
		{`{"type":"tool.call","call_id":"c2","payload":{"tool_name":"list_tables"}}`, TypeToolCall},
		{`{"type":"agent.stream","request_id":"r2","payload":{"delta":"chunk"}}`, TypeAgentStream},
		{`{"type":"agent.response","request_id":"r3","payload":{"action":"explain_sql","result":{}}}`, TypeAgentResponse},
		{`{"type":"agent.error","request_id":"r4","payload":{"code":"llm_error","message":"fail"}}`, TypeAgentError},
	}

	for _, msg := range messages {
		env, err := ParseEnvelope([]byte(msg.json))
		if err != nil {
			t.Fatalf("ParseEnvelope(%s): %v", msg.json, err)
		}
		if env.Type != msg.wantType {
			t.Errorf("Type = %q, want %q", env.Type, msg.wantType)
		}
	}
}

func TestParseEnvelope_InvalidJSON(t *testing.T) {
	_, err := ParseEnvelope([]byte("not json"))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestNewEnvelope(t *testing.T) {
	payload := AgentErrorPayload{Code: ErrCodeInvalidRequest, Message: "bad action"}
	env, err := NewEnvelope(TypeAgentError, &payload)
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	if env.Type != TypeAgentError {
		t.Errorf("Type = %q, want %q", env.Type, TypeAgentError)
	}
	if env.RequestID != "" {
		t.Errorf("RequestID should be empty, got %q", env.RequestID)
	}
}

func TestToolResultPayload_WithError(t *testing.T) {
	payload := ToolResultPayload{
		Success: false,
		Error:   "connection refused",
	}

	env, err := NewEnvelopeWithID(TypeToolResult, "", "call-err", &payload)
	if err != nil {
		t.Fatalf("NewEnvelopeWithID: %v", err)
	}

	data, err := env.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	parsed, err := ParseEnvelope(data)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}

	var decoded ToolResultPayload
	if err := parsed.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if decoded.Success {
		t.Error("Success = true, want false")
	}
	if decoded.Error != "connection refused" {
		t.Errorf("Error = %q, want %q", decoded.Error, "connection refused")
	}
}
