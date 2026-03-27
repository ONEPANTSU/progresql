/*
* Created on Mar 27, 2026
* Test file for Name() methods of pipeline steps
* File path: internal/agent/steps/steps_name_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package steps

import (
	"testing"
)

func TestSQLGenerationStep_Name(t *testing.T) {
	step := &SQLGenerationStep{}
	if step.Name() != "sql_generation" {
		t.Errorf("expected 'sql_generation', got %q", step.Name())
	}
}

func TestExplainSQLStep_Name(t *testing.T) {
	step := &ExplainSQLStep{}
	if step.Name() != "explain_sql" {
		t.Errorf("expected 'explain_sql', got %q", step.Name())
	}
}

func TestImproveSQLStep_Name(t *testing.T) {
	step := &ImproveSQLStep{}
	if step.Name() != "improve_sql" {
		t.Errorf("expected 'improve_sql', got %q", step.Name())
	}
}

func TestSchemaGroundingStep_Name(t *testing.T) {
	step := &SchemaGroundingStep{}
	if step.Name() != "schema_grounding" {
		t.Errorf("expected 'schema_grounding', got %q", step.Name())
	}
}

func TestIntentDetectionStep_Name(t *testing.T) {
	step := &IntentDetectionStep{}
	if step.Name() != "intent_detection" {
		t.Errorf("expected 'intent_detection', got %q", step.Name())
	}
}

func TestParallelSQLGenerationStep_Name(t *testing.T) {
	step := &ParallelSQLGenerationStep{}
	if step.Name() != "parallel_sql_generation" {
		t.Errorf("expected 'parallel_sql_generation', got %q", step.Name())
	}
}

func TestDiagnosticRetryStep_Name(t *testing.T) {
	step := &DiagnosticRetryStep{}
	if step.Name() != "diagnostic_retry" {
		t.Errorf("expected 'diagnostic_retry', got %q", step.Name())
	}
}
