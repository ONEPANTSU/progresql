package tools

import (
	"encoding/json"
	"testing"
)

func TestNewRegistry_AllToolsRegistered(t *testing.T) {
	r := NewRegistry()

	expectedTools := []string{
		ToolListSchemas,
		ToolListTables,
		ToolDescribeTable,
		ToolListIndexes,
		ToolExplainQuery,
		ToolExecuteQuery,
		ToolListFunctions,
	}

	all := r.All()
	if len(all) != len(expectedTools) {
		t.Fatalf("expected %d tools, got %d", len(expectedTools), len(all))
	}

	for _, name := range expectedTools {
		td, err := r.Get(name)
		if err != nil {
			t.Errorf("tool %q not found: %v", name, err)
			continue
		}
		if td.Name != name {
			t.Errorf("tool name mismatch: got %q, want %q", td.Name, name)
		}
		if td.Description == "" {
			t.Errorf("tool %q has empty description", name)
		}
		if len(td.Parameters) == 0 {
			t.Errorf("tool %q has no parameters schema", name)
		}
	}
}

func TestRegistry_Get_NotFound(t *testing.T) {
	r := NewRegistry()

	_, err := r.Get("nonexistent_tool")
	if err == nil {
		t.Fatal("expected error for unknown tool, got nil")
	}
}

func TestRegistry_Validate(t *testing.T) {
	r := NewRegistry()

	if !r.Validate(ToolListTables) {
		t.Error("expected list_tables to be valid")
	}
	if r.Validate("nonexistent_tool") {
		t.Error("expected nonexistent_tool to be invalid")
	}
}

func TestRegistry_Register_Custom(t *testing.T) {
	r := NewRegistry()

	custom := ToolDefinition{
		Name:        "custom_tool",
		Description: "A custom tool",
		Parameters:  json.RawMessage(`{"type":"object"}`),
	}
	r.Register(custom)

	td, err := r.Get("custom_tool")
	if err != nil {
		t.Fatalf("custom tool not found: %v", err)
	}
	if td.Description != "A custom tool" {
		t.Errorf("unexpected description: %q", td.Description)
	}

	// Should now have 8 tools
	if len(r.All()) != 8 {
		t.Errorf("expected 8 tools after custom registration, got %d", len(r.All()))
	}
}

func TestRegistry_ParametersAreValidJSON(t *testing.T) {
	r := NewRegistry()

	for _, td := range r.All() {
		var schema map[string]any
		if err := json.Unmarshal(td.Parameters, &schema); err != nil {
			t.Errorf("tool %q parameters are not valid JSON: %v", td.Name, err)
			continue
		}
		typ, ok := schema["type"]
		if !ok || typ != "object" {
			t.Errorf("tool %q parameters schema type should be 'object', got %v", td.Name, typ)
		}
	}
}

func TestRegistry_ToolConstants(t *testing.T) {
	// Ensure constants match expected string values.
	tests := map[string]string{
		ToolListSchemas:   "list_schemas",
		ToolListTables:    "list_tables",
		ToolDescribeTable: "describe_table",
		ToolListIndexes:   "list_indexes",
		ToolExplainQuery:  "explain_query",
		ToolExecuteQuery:  "execute_query",
		ToolListFunctions: "list_functions",
	}
	for got, want := range tests {
		if got != want {
			t.Errorf("constant mismatch: got %q, want %q", got, want)
		}
	}
}
