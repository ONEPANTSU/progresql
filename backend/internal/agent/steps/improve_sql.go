package steps

import (
	"context"
	"encoding/json"
	"fmt"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
)

// ImproveSQLStep takes SQL from context.selected_sql, runs explain_query tool
// to get the query plan, then sends both to LLM for optimization with streaming.
type ImproveSQLStep struct{}

func (s *ImproveSQLStep) Name() string { return "improve_sql" }

func (s *ImproveSQLStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	sql := pctx.SelectedSQL
	if sql == "" {
		return fmt.Errorf("selected_sql is required for improve_sql action")
	}

	model := pctx.Model

	// Step 1: Call explain_query tool to get the query plan.
	explainArgs, _ := json.Marshal(tools.ExplainQueryArgs{SQL: sql})
	result, err := pctx.DispatchTool(tools.ToolExplainQuery, explainArgs)
	if err != nil {
		return fmt.Errorf("explain_query failed: %w", err)
	}

	var queryPlan string
	if result.Success {
		var explainResult tools.ExplainQueryResult
		if err := json.Unmarshal(result.Data, &explainResult); err == nil {
			queryPlan = explainResult.Plan
		}
	} else {
		if agent.IsDBNotConnectedMessage(result.Error) {
			return agent.NewDatabaseNotConnectedError("explain_query")
		}
		queryPlan = fmt.Sprintf("EXPLAIN failed: %s", result.Error)
	}

	pctx.Logger.Info("query plan obtained",
		zap.Int("plan_length", len(queryPlan)),
		zap.Bool("success", result.Success),
	)

	// Step 2: Send SQL + plan to LLM for optimization with streaming.
	userDescSection := ""
	if pctx.UserDescriptions != "" {
		userDescSection = fmt.Sprintf("\nUser-provided descriptions for database objects:\n%s\n\n", pctx.UserDescriptions)
	}

	prompt := fmt.Sprintf(
		"You are an expert PostgreSQL performance engineer. Analyze the following SQL query and its EXPLAIN plan, then provide an optimized version.\n\n"+
			"IMPORTANT: Always respond in the same language as the user's message. "+
			"If the user writes in Russian, explain in Russian. If in English, explain in English. "+
			"SQL code must remain in standard SQL syntax.\n\n"+
			"%s"+
			"Original SQL:\n```sql\n%s\n```\n\n"+
			"EXPLAIN output:\n```\n%s\n```\n\n"+
			"Provide your response in the following format:\n"+
			"1. First, list the specific improvements you made (as a numbered list)\n"+
			"2. Then provide the improved SQL query inside a ```sql code block\n\n"+
			"Focus on:\n"+
			"- Query performance (index usage, join order, avoiding sequential scans)\n"+
			"- Readability and best practices\n"+
			"- Correct use of PostgreSQL-specific features\n"+
			"If the query is already optimal, explain why and return it unchanged.",
		userDescSection, sql, queryPlan,
	)

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	pctx.Logger.Info("improving SQL",
		zap.String("model", model),
		zap.Int("sql_length", len(sql)),
	)

	resp, err := pctx.StreamLLM(ctx, req)
	if err != nil {
		return fmt.Errorf("LLM improve_sql failed: %w", err)
	}

	if len(resp.Choices) == 0 {
		return fmt.Errorf("LLM returned no choices")
	}

	content := stripThinkingTags(resp.Choices[0].Message.Content)
	if content == "" {
		return fmt.Errorf("LLM returned empty response")
	}

	// Store full explanation (includes improvements list + SQL).
	pctx.Result.Explanation = content

	// Try to extract the improved SQL from the response.
	if improvedSQL := extractSQLFromResponse(content); improvedSQL != "" {
		pctx.Result.SQL = improvedSQL
	}

	pctx.Logger.Info("SQL improvement generated",
		zap.Int("explanation_length", len(content)),
		zap.Bool("has_sql", pctx.Result.SQL != ""),
		zap.Int("tokens", pctx.TokensUsed),
	)

	return nil
}

// extractSQLFromResponse extracts the last SQL code block from LLM response.
// Returns empty string if no SQL block found.
func extractSQLFromResponse(content string) string {
	// Find the last ```sql ... ``` block, as the improved SQL is typically at the end.
	const sqlStart = "```sql"
	const blockEnd = "```"

	lastIdx := lastIndex(content, sqlStart)
	if lastIdx == -1 {
		return ""
	}

	start := lastIdx + len(sqlStart)
	rest := content[start:]

	endIdx := indexOf(rest, blockEnd)
	if endIdx == -1 {
		return ""
	}

	sql := rest[:endIdx]
	sql = trimSQL(sql)
	return sql
}

func lastIndex(s, substr string) int {
	idx := -1
	offset := 0
	for {
		i := indexOf(s[offset:], substr)
		if i == -1 {
			break
		}
		idx = offset + i
		offset = idx + len(substr)
	}
	return idx
}

func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

func trimSQL(sql string) string {
	// Trim whitespace and trailing semicolons.
	result := sql
	for len(result) > 0 && (result[0] == '\n' || result[0] == '\r' || result[0] == ' ' || result[0] == '\t') {
		result = result[1:]
	}
	for len(result) > 0 {
		last := result[len(result)-1]
		if last == '\n' || last == '\r' || last == ' ' || last == '\t' || last == ';' {
			result = result[:len(result)-1]
		} else {
			break
		}
	}
	return result
}
