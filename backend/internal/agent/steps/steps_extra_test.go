/*
* Created on Mar 27, 2026
* Test file for extra coverage in agent steps utility functions
* File path: internal/agent/steps/steps_extra_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package steps

import (
	"encoding/json"
	"testing"
)

// ── parseTableNames — wrapped {tables:[{name:...}]} format ───────────────────

func TestParseTableNames_WrappedTablesFormat(t *testing.T) {
	// {"tables":[{"name":"users","type":"BASE TABLE"},{"name":"orders","type":"BASE TABLE"}]}
	data := json.RawMessage(`{"tables":[{"name":"users","type":"BASE TABLE"},{"name":"orders","type":"BASE TABLE"}]}`)
	names, err := parseTableNames(data)
	if err != nil {
		t.Fatalf("parseTableNames wrapped: %v", err)
	}
	if len(names) != 2 {
		t.Fatalf("expected 2 names, got %d: %v", len(names), names)
	}
	if names[0] != "users" {
		t.Errorf("expected names[0]='users', got %q", names[0])
	}
	if names[1] != "orders" {
		t.Errorf("expected names[1]='orders', got %q", names[1])
	}
}

func TestParseTableNames_ObjectWithNameField(t *testing.T) {
	// Object array using "name" field instead of "table_name".
	data := json.RawMessage(`[{"name":"products","type":"BASE TABLE"}]`)
	names, err := parseTableNames(data)
	if err != nil {
		t.Fatalf("parseTableNames name field: %v", err)
	}
	if len(names) != 1 || names[0] != "products" {
		t.Errorf("expected ['products'], got %v", names)
	}
}

func TestParseTableNames_EmptyArray(t *testing.T) {
	data := json.RawMessage(`[]`)
	names, err := parseTableNames(data)
	if err != nil {
		t.Fatalf("parseTableNames empty array: %v", err)
	}
	if len(names) != 0 {
		t.Errorf("expected empty names, got %v", names)
	}
}

// ── stripCodeFences — no-newline branch ──────────────────────────────────────

func TestStripCodeFences_NoNewline(t *testing.T) {
	// Input starts with ``` but has no newline — the else branch should trim prefix.
	input := "```json"
	got := stripCodeFences(input)
	// Should strip the ``` prefix (no newline path).
	if got == "```json" {
		t.Errorf("expected prefix stripped for no-newline fence, got %q", got)
	}
}

func TestStripCodeFences_WithTrailingFence(t *testing.T) {
	// String with trailing ``` should be trimmed.
	input := "SELECT * FROM users\n```"
	got := stripCodeFences(input)
	if got != "SELECT * FROM users" {
		t.Errorf("expected trailing fence removed, got %q", got)
	}
}

func TestStripCodeFences_NoFence(t *testing.T) {
	input := "SELECT * FROM users"
	got := stripCodeFences(input)
	if got != "SELECT * FROM users" {
		t.Errorf("expected unchanged, got %q", got)
	}
}

// ── extractLastSQLBlock — from result_aggregation.go ─────────────────────────

func TestExtractLastSQLBlock_WithCodeFence(t *testing.T) {
	input := "Some explanation\n```sql\nSELECT * FROM users\n```\nMore text\n```sql\nSELECT 1\n```"
	got := extractLastSQLBlock(input)
	if got != "SELECT 1" {
		t.Errorf("expected 'SELECT 1', got %q", got)
	}
}

func TestExtractLastSQLBlock_NoCodeFence(t *testing.T) {
	// No SQL code fence — returns empty string (function only extracts fenced SQL).
	input := "SELECT * FROM users"
	got := extractLastSQLBlock(input)
	_ = got // result may be empty — just verify no panic
}

func TestExtractLastSQLBlock_Empty(t *testing.T) {
	got := extractLastSQLBlock("")
	if got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}
