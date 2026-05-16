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

func TestPostprocessCandidateSQLPreservesSchemaQualifiedTables(t *testing.T) {
	sc := &SchemaContext{Tables: []TableInfo{
		{
			Schema:  "public",
			Table:   "races",
			Details: json.RawMessage(`{"columns":[{"name":"raceid"},{"name":"year"},{"name":"circuitid"}]}`),
		},
		{
			Schema:  "public",
			Table:   "circuits",
			Details: json.RawMessage(`{"columns":[{"name":"circuitid"},{"name":"location"}]}`),
		},
	}}

	sql := "SELECT DISTINCT r.year FROM public.races r JOIN public.circuits c ON r.circuitid = c.circuitid WHERE c.location ILIKE '%Shanghai%' ORDER BY r.year"
	got, status := postprocessCandidateSQL(sql, sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != sql {
		t.Fatalf("schema-qualified table names should be preserved, got %q", got)
	}
}

func TestPostprocessCandidateSQLRepairsSchemaQualifiedTableOnlyInTableReference(t *testing.T) {
	sc := f1SchemaContext()

	got, status := postprocessCandidateSQL("SELECT * FROM public.circuts c", sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != "SELECT * FROM public.circuits c" {
		t.Fatalf("expected schema-qualified table repair, got %q", got)
	}

	got, status = postprocessCandidateSQL("SELECT * FROM public . circuts c", sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != "SELECT * FROM public . circuits c" {
		t.Fatalf("expected spaced schema-qualified table repair, got %q", got)
	}

	sql := "SELECT public.race_count() FROM public.races"
	got, status = postprocessCandidateSQL(sql, sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != sql {
		t.Fatalf("schema-qualified function calls should not be repaired, got %q", got)
	}
}

func TestPostprocessCandidateSQLRepairsColumnsOnlyForKnownQualifiers(t *testing.T) {
	sc := f1SchemaContext()

	got, status := postprocessCandidateSQL("SELECT r.yaer FROM public.races r", sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != "SELECT r.year FROM public.races r" {
		t.Fatalf("expected alias-qualified column repair, got %q", got)
	}

	sql := "SELECT unknown.yaer FROM public.races r"
	got, status = postprocessCandidateSQL(sql, sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != sql {
		t.Fatalf("unknown qualifiers should not be repaired, got %q", got)
	}
}

func TestPostprocessCandidateSQLDoesNotRepairCTENamesAsTables(t *testing.T) {
	sc := f1SchemaContext()
	sql := "WITH reces AS (SELECT 1 AS year) SELECT * FROM reces"
	got, status := postprocessCandidateSQL(sql, sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != sql {
		t.Fatalf("CTE table references should not be repaired, got %q", got)
	}
}

func TestPostprocessCandidateSQLPrefersAliasOverSchemaName(t *testing.T) {
	sc := f1SchemaContext()
	got, status := postprocessCandidateSQL("SELECT public.yaer FROM public.races public", sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != "SELECT public.year FROM public.races public" {
		t.Fatalf("alias named like a schema should qualify columns, got %q", got)
	}
}

func TestPostprocessCandidateSQLPreservesQuotedIdentifiers(t *testing.T) {
	sc := f1SchemaContext()
	sql := `SELECT "r"."yaer" FROM public."races" "r"`
	got, status := postprocessCandidateSQL(sql, sc)
	if !status.Valid {
		t.Fatalf("expected valid candidate, got %s", status.Error)
	}
	if got != sql {
		t.Fatalf("quoted identifiers should not be repaired, got %q", got)
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

func f1SchemaContext() *SchemaContext {
	return &SchemaContext{Tables: []TableInfo{
		{
			Schema:  "public",
			Table:   "races",
			Details: json.RawMessage(`{"columns":[{"name":"raceid"},{"name":"year"},{"name":"circuitid"}]}`),
		},
		{
			Schema:  "public",
			Table:   "circuits",
			Details: json.RawMessage(`{"columns":[{"name":"circuitid"},{"name":"location"}]}`),
		},
	}}
}
