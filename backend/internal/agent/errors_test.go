package agent

import (
	"fmt"
	"testing"
)

func TestDatabaseNotConnectedError_Error(t *testing.T) {
	err := NewDatabaseNotConnectedError("list_tables")
	got := err.Error()
	want := "list_tables: database not connected"
	if got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestDatabaseNotConnectedError_ErrorNoTool(t *testing.T) {
	err := &DatabaseNotConnectedError{}
	got := err.Error()
	want := "database not connected"
	if got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestIsDatabaseNotConnected_Direct(t *testing.T) {
	err := NewDatabaseNotConnectedError("list_schemas")
	if !IsDatabaseNotConnected(err) {
		t.Error("IsDatabaseNotConnected should return true for direct error")
	}
}

func TestIsDatabaseNotConnected_Wrapped(t *testing.T) {
	inner := NewDatabaseNotConnectedError("describe_table")
	wrapped := fmt.Errorf("step failed: %w", inner)
	if !IsDatabaseNotConnected(wrapped) {
		t.Error("IsDatabaseNotConnected should return true for wrapped error")
	}
}

func TestIsDatabaseNotConnected_OtherError(t *testing.T) {
	err := fmt.Errorf("some other error")
	if IsDatabaseNotConnected(err) {
		t.Error("IsDatabaseNotConnected should return false for unrelated error")
	}
}

func TestIsDatabaseNotConnected_Nil(t *testing.T) {
	if IsDatabaseNotConnected(nil) {
		t.Error("IsDatabaseNotConnected should return false for nil")
	}
}

func TestIsDBNotConnectedMessage(t *testing.T) {
	tests := []struct {
		msg  string
		want bool
	}{
		{"No database connection", true},
		{"no database connection", true},
		{"Database not connected", true},
		{"MCP server not available", true},
		{"Electron API not available", true},
		{"table not found", false},
		{"connection refused", false},
		{"", false},
	}
	for _, tt := range tests {
		got := IsDBNotConnectedMessage(tt.msg)
		if got != tt.want {
			t.Errorf("IsDBNotConnectedMessage(%q) = %v, want %v", tt.msg, got, tt.want)
		}
	}
}
