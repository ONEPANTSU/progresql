/*
* Created on Mar 27, 2026
* Test file for auto_execute.go
* File path: internal/agent/steps/auto_execute_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package steps

import (
	"context"
	"testing"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
)

// ── AutoExecuteStep.Name ──────────────────────────────────────────────────────

func TestAutoExecuteStep_Name(t *testing.T) {
	step := &AutoExecuteStep{}
	if step.Name() != "auto_execute" {
		t.Errorf("expected name 'auto_execute', got %q", step.Name())
	}
}

// ── AutoExecuteStep.Execute — safe mode skips ─────────────────────────────────

func TestAutoExecuteStep_SafeMode_Skips(t *testing.T) {
	step := &AutoExecuteStep{}
	pctx := agent.NewPipelineContext()
	pctx.SecurityMode = agent.SecurityModeSafe
	pctx.Logger = zap.NewNop()
	pctx.Result.SQL = "SELECT 1"

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("expected nil error in safe mode, got %v", err)
	}
	// QueryResult should remain empty (no execution).
	if pctx.Result.QueryResult != nil {
		t.Error("expected nil QueryResult in safe mode")
	}
}

func TestAutoExecuteStep_SecurityBlocked_Skips(t *testing.T) {
	step := &AutoExecuteStep{}
	pctx := agent.NewPipelineContext()
	pctx.SecurityMode = agent.SecurityModeData
	pctx.Logger = zap.NewNop()
	pctx.Result.SQL = "DROP TABLE users"
	pctx.Result.SecurityBlocked = true

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("expected nil error when security blocked, got %v", err)
	}
	if pctx.Result.QueryResult != nil {
		t.Error("expected nil QueryResult when security blocked")
	}
}

func TestAutoExecuteStep_ValidationError_Skips(t *testing.T) {
	step := &AutoExecuteStep{}
	pctx := agent.NewPipelineContext()
	pctx.SecurityMode = agent.SecurityModeData
	pctx.Logger = zap.NewNop()
	pctx.Result.SQL = "SELECT * FROM nonexistent"
	pctx.Result.ValidationError = "table does not exist"

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("expected nil error when validation error, got %v", err)
	}
	if pctx.Result.QueryResult != nil {
		t.Error("expected nil QueryResult when validation error")
	}
}

func TestAutoExecuteStep_EmptySQL_Skips(t *testing.T) {
	step := &AutoExecuteStep{}
	pctx := agent.NewPipelineContext()
	pctx.SecurityMode = agent.SecurityModeData
	pctx.Logger = zap.NewNop()
	pctx.Result.SQL = "   " // whitespace only

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("expected nil error for empty SQL, got %v", err)
	}
	if pctx.Result.QueryResult != nil {
		t.Error("expected nil QueryResult for empty SQL")
	}
}

func TestAutoExecuteStep_DataMode_NonSelectSkips(t *testing.T) {
	// In data mode, only SELECT/WITH queries are auto-executed.
	// INSERT statements should be skipped.
	step := &AutoExecuteStep{}
	pctx := agent.NewPipelineContext()
	pctx.SecurityMode = agent.SecurityModeData
	pctx.Logger = zap.NewNop()
	pctx.Result.SQL = "INSERT INTO users (name) VALUES ('test')"

	err := step.Execute(context.Background(), pctx)
	if err != nil {
		t.Fatalf("expected nil error for INSERT in data mode, got %v", err)
	}
	if pctx.Result.QueryResult != nil {
		t.Error("expected nil QueryResult for INSERT in data mode")
	}
}
