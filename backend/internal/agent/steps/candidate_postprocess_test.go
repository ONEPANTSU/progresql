package steps

import (
	"encoding/json"
	"testing"
)

func TestPostprocessCandidateSQLRejectsPlaceholders(t *testing.T) {
	tests := []string{
		"SELECT * FROM orders WHERE year = {{year}}",
		"SELECT * FROM users WHERE state = <state>",
		"SELECT * FROM users WHERE id = :user_id",
	}
	for _, sql := range tests {
		t.Run(sql, func(t *testing.T) {
			_, status := postprocessCandidateSQL(sql, nil)
			if status.Valid {
				t.Fatalf("expected placeholder candidate to be invalid")
			}
		})
	}
}

func TestPostprocessCandidateSQLRepairsSchemaNames(t *testing.T) {
	sc := &SchemaContext{Tables: []TableInfo{{
		Schema:  "public",
		Table:   "users",
		Details: json.RawMessage(`{"columns":[{"name":"id"},{"name":"email"}]}`),
	}}}
	got, status := postprocessCandidateSQL("SELECT u.emali FROM usres u", sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != "SELECT u.email FROM users u" {
		t.Fatalf("unexpected repair: %q", got)
	}
}

func TestValidateSQLSyntaxRejectsUnbalancedParens(t *testing.T) {
	if err := ValidateSQLSyntax("SELECT (1"); err == nil {
		t.Fatal("expected syntax error")
	}
}

func TestPostprocessCandidateSQLAllowsPostgresCast(t *testing.T) {
	_, status := postprocessCandidateSQL("SELECT created_at::date FROM users", nil)
	if !status.Valid {
		t.Fatalf("expected postgres cast to be valid, got %s", status.Error)
	}
}
