package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
)

// AutoExecuteStep is the final step of the generate_sql pipeline.
// It automatically executes the chosen SQL query via the execute_query tool,
// then streams a human-friendly summarization of the results to the user.
type AutoExecuteStep struct{}

func (s *AutoExecuteStep) Name() string { return "auto_execute" }

func (s *AutoExecuteStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	// In safe mode, never auto-execute queries — the user must run them manually.
	if pctx.SecurityMode == agent.SecurityModeSafe {
		pctx.Logger.Info("auto_execute skipped: safe mode enabled")
		return nil
	}

	// Skip auto-execute for SQL blocked by security mode.
	if pctx.Result.SecurityBlocked {
		pctx.Logger.Info("auto_execute skipped: SQL blocked by security mode")
		return nil
	}

	// Skip auto-execute for SQL that failed EXPLAIN validation.
	if pctx.Result.ValidationError != "" {
		pctx.Logger.Info("auto_execute skipped: SQL has validation error",
			zap.String("validation_error", pctx.Result.ValidationError))
		return nil
	}

	sql := strings.TrimSpace(pctx.Result.SQL)
	if sql == "" {
		return nil
	}

	// In data mode, only auto-execute SELECT/WITH queries (read-only safety).
	// In execute mode, allow all queries including DDL (CREATE, ALTER, DROP, etc.).
	upper := strings.ToUpper(sql)
	if pctx.SecurityMode != agent.SecurityModeExecute {
		if !strings.HasPrefix(upper, "SELECT") && !strings.HasPrefix(upper, "WITH") {
			pctx.Logger.Info("auto_execute skipped: not a SELECT query (data mode)")
			return nil
		}
	}

	pctx.Logger.Info("auto-executing generated SQL", zap.String("sql", sql))

	args, _ := json.Marshal(map[string]any{
		"sql":   sql,
		"limit": 100,
	})

	result, err := pctx.DispatchTool(tools.ToolExecuteQuery, args)
	if err != nil {
		pctx.Logger.Warn("auto_execute tool dispatch failed", zap.Error(err))
		return nil
	}

	if !result.Success {
		pctx.Logger.Warn("auto_execute query failed", zap.String("error", result.Error))
		errResult, _ := json.Marshal(map[string]string{"error": result.Error})
		pctx.Result.QueryResult = errResult
		return nil
	}

	pctx.Result.QueryResult = result.Data

	pctx.Logger.Info("auto_execute completed", zap.Int("result_size", len(result.Data)))

	// Stream a summarization of the results to the user.
	return s.summarizeResults(ctx, pctx, sql, result.Data)
}

// summarizeResults sends the query results to the LLM for a streamed human-friendly summary.
// This replaces the dry result_aggregation explanation with an actual data-aware response.
func (s *AutoExecuteStep) summarizeResults(ctx context.Context, pctx *agent.PipelineContext, sql string, data json.RawMessage) error {
	// Truncate data for prompt (avoid token overflow).
	dataStr := string(data)
	if len(dataStr) > 4000 {
		dataStr = dataStr[:4000] + "... (truncated)"
	}

	prompt := fmt.Sprintf(
		"You are a PostgreSQL database assistant. The user asked a question, you generated a SQL query, "+
			"executed it, and got the results below. Now summarize the results in a clear, friendly way.\n\n"+
			"CRITICAL RULES:\n"+
			"- Respond in the same language as the user's message.\n"+
			"- Do NOT show the SQL query — the user doesn't need to see it.\n"+
			"- Summarize and explain what the data means. Be specific with numbers and names.\n"+
			"- For schema/structure questions, describe the entities, their purpose, and relationships.\n"+
			"- Keep it concise but informative.\n"+
			"- Do NOT use markdown tables — just explain in natural language with lists if needed.\n"+
			"- If there are many items, group or categorize them logically.\n\n"+
			"User question: %s\n\n"+
			"Query results (JSON):\n%s",
		pctx.UserMessage,
		dataStr,
	)

	req := llm.ChatRequest{
		Model: pctx.Model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	pctx.Logger.Info("streaming result summarization", zap.String("model", pctx.Model))

	resp, err := pctx.StreamLLM(ctx, req)
	if err != nil {
		pctx.Logger.Warn("result summarization failed, keeping original explanation", zap.Error(err))
		return nil
	}

	if len(resp.Choices) > 0 && resp.Choices[0].Message.Content != "" {
		// Replace the dry aggregation explanation with the data-aware summary.
		pctx.Result.Explanation = resp.Choices[0].Message.Content
	}

	return nil
}
