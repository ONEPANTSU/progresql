package tools

import (
	"encoding/json"
	"testing"
)

func TestToolDefinition_JSONRoundTrip(t *testing.T) {
	td := ToolDefinition{
		Name:        "list_tables",
		Description: "List all tables",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"schema":{"type":"string"}}}`),
	}

	data, err := json.Marshal(td)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded ToolDefinition
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Name != td.Name {
		t.Errorf("name: got %q, want %q", decoded.Name, td.Name)
	}
	if decoded.Description != td.Description {
		t.Errorf("description: got %q, want %q", decoded.Description, td.Description)
	}
}

func TestDescribeTableArgs_JSON(t *testing.T) {
	args := DescribeTableArgs{Schema: "public", Table: "users"}
	data, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded DescribeTableArgs
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Schema != "public" || decoded.Table != "users" {
		t.Errorf("got %+v", decoded)
	}
}

func TestExecuteQueryArgs_JSON(t *testing.T) {
	args := ExecuteQueryArgs{SQL: "SELECT 1", Limit: 100}
	data, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded ExecuteQueryArgs
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.SQL != "SELECT 1" || decoded.Limit != 100 {
		t.Errorf("got %+v", decoded)
	}
}

func TestDescribeTableResult_JSON(t *testing.T) {
	defaultVal := "now()"
	result := DescribeTableResult{
		Columns: []ColumnInfo{
			{Name: "id", Type: "integer", Nullable: false},
			{Name: "created_at", Type: "timestamp", Nullable: false, Default: &defaultVal},
		},
		Indexes: []IndexInfo{
			{Name: "users_pkey", Columns: []string{"id"}, Unique: true},
		},
		ForeignKeys: []ForeignKeyInfo{
			{Name: "fk_org", Columns: []string{"org_id"}, ReferencedTable: "orgs", ReferencedCols: []string{"id"}},
		},
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded DescribeTableResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(decoded.Columns) != 2 {
		t.Fatalf("expected 2 columns, got %d", len(decoded.Columns))
	}
	if decoded.Columns[1].Default == nil || *decoded.Columns[1].Default != "now()" {
		t.Error("default value not preserved")
	}
	if len(decoded.Indexes) != 1 || decoded.Indexes[0].Name != "users_pkey" {
		t.Error("indexes not preserved")
	}
	if len(decoded.ForeignKeys) != 1 || decoded.ForeignKeys[0].ReferencedTable != "orgs" {
		t.Error("foreign keys not preserved")
	}
}
