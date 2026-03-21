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

// ContextKeySchemaContext is the key used to store the enriched schema context
// in PipelineContext.values for downstream steps.
const ContextKeySchemaContext = "schema_context"

// SchemaGroundingStep is step 1 of the generate_sql pipeline.
// It discovers relevant tables via tool calls and builds an enriched schema context.
type SchemaGroundingStep struct{}

func (s *SchemaGroundingStep) Name() string { return "schema_grounding" }

// TableInfo holds the description of a single table returned by describe_table.
type TableInfo struct {
	Schema  string          `json:"schema"`
	Table   string          `json:"table"`
	Details json.RawMessage `json:"details"`
}

// SchemaContext is the enriched context built by this step, stored in PipelineContext
// and consumed by downstream steps (SQL generation, etc.).
type SchemaContext struct {
	Tables []TableInfo `json:"tables"`
}

func (s *SchemaGroundingStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	// Step 1: Call list_tables to get all tables in the public schema.
	tablesArg, _ := json.Marshal(map[string]string{"schema": "public"})
	result, err := pctx.DispatchTool(tools.ToolListTables, tablesArg)
	if err != nil {
		return fmt.Errorf("list_tables failed: %w", err)
	}
	if !result.Success {
		if agent.IsDBNotConnectedMessage(result.Error) {
			return agent.NewDatabaseNotConnectedError("list_tables")
		}
		return fmt.Errorf("list_tables returned error: %s", result.Error)
	}

	// Parse the list of table names from the tool result.
	tableNames, err := parseTableNames(result.Data)
	if err != nil {
		// Treat parse errors on valid but empty responses as empty database.
		pctx.Logger.Warn("parse list_tables result failed, treating as empty", zap.Error(err))
		tableNames = nil
	}

	if len(tableNames) == 0 {
		return s.handleEmptyDatabase(ctx, pctx)
	}

	pctx.Logger.Info("tables discovered", zap.Int("count", len(tableNames)))

	// Step 2: Determine relevant tables using LLM.
	relevant, err := s.selectRelevantTables(ctx, pctx, tableNames)
	if err != nil {
		return fmt.Errorf("select relevant tables: %w", err)
	}

	pctx.Logger.Info("relevant tables selected",
		zap.Int("total", len(tableNames)),
		zap.Int("relevant", len(relevant)),
		zap.Strings("tables", relevant),
	)

	// Step 3: Call describe_table for each relevant table.
	var schemaCtx SchemaContext
	for _, tableName := range relevant {
		descArg, _ := json.Marshal(map[string]string{
			"schema": "public",
			"table":  tableName,
		})
		descResult, err := pctx.DispatchTool(tools.ToolDescribeTable, descArg)
		if err != nil {
			pctx.Logger.Warn("describe_table failed, skipping",
				zap.String("table", tableName),
				zap.Error(err),
			)
			continue
		}
		if !descResult.Success {
			pctx.Logger.Warn("describe_table returned error, skipping",
				zap.String("table", tableName),
				zap.String("error", descResult.Error),
			)
			continue
		}

		schemaCtx.Tables = append(schemaCtx.Tables, TableInfo{
			Schema:  "public",
			Table:   tableName,
			Details: descResult.Data,
		})
	}

	if len(schemaCtx.Tables) == 0 {
		return fmt.Errorf("no table descriptions obtained for relevant tables")
	}

	// Step 4: Store the enriched schema context for downstream steps.
	pctx.Set(ContextKeySchemaContext, &schemaCtx)

	return nil
}

// handleEmptyDatabase streams a helpful LLM response when the database has no tables.
// Sets SkipRemaining to bypass all subsequent pipeline steps.
func (s *SchemaGroundingStep) handleEmptyDatabase(ctx context.Context, pctx *agent.PipelineContext) error {
	pctx.Logger.Info("database is empty, no tables found — generating helpful response")

	model := pctx.Model

	prompt := "You are a PostgreSQL database assistant. The user is connected to a database, " +
		"but the database is completely empty — there are no tables, views, or other objects.\n\n" +
		"The user asked: " + pctx.UserMessage + "\n\n" +
		"Respond helpfully. Tell the user that the database is empty and has no tables yet. " +
		"Suggest that they can create tables using CREATE TABLE statements, " +
		"or import an existing schema. Be brief and friendly.\n\n" +
		"IMPORTANT: Always respond in the same language as the user's message. " +
		"If the user writes in Russian, respond in Russian. If in English, respond in English."

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	resp, err := pctx.StreamLLM(ctx, req)
	if err != nil {
		// Fallback: static bilingual message if LLM is unavailable.
		pctx.Logger.Warn("LLM unavailable for empty-database response, using fallback", zap.Error(err))
		pctx.Result.Explanation = "База данных пуста — в ней нет таблиц. " +
			"Вы можете создать таблицы с помощью CREATE TABLE или импортировать существующую схему.\n\n" +
			"The database is empty — there are no tables. " +
			"You can create tables using CREATE TABLE or import an existing schema."
		pctx.SkipRemaining = true
		return nil
	}

	if len(resp.Choices) > 0 && resp.Choices[0].Message.Content != "" {
		pctx.Result.Explanation = resp.Choices[0].Message.Content
	} else {
		pctx.Result.Explanation = "База данных пуста — в ней нет таблиц. " +
			"Вы можете создать таблицы с помощью CREATE TABLE или импортировать существующую схему.\n\n" +
			"The database is empty — there are no tables. " +
			"You can create tables using CREATE TABLE or import an existing schema."
	}

	pctx.SkipRemaining = true
	return nil
}

// selectRelevantTables uses the LLM to pick which tables are relevant to the user's message.
// If the table count is small (<=5), all tables are considered relevant to save an LLM call.
func (s *SchemaGroundingStep) selectRelevantTables(
	ctx context.Context,
	pctx *agent.PipelineContext,
	tableNames []string,
) ([]string, error) {
	// For small schemas, just use all tables — no need for an LLM call.
	if len(tableNames) <= 5 {
		return tableNames, nil
	}

	model := pctx.Model

	prompt := fmt.Sprintf(
		"You are a database expert. Given the user's request and the list of available tables, "+
			"return ONLY a JSON array of table names that are relevant to answering the request. "+
			"Return at most 10 tables. Do not include any explanation, just the JSON array.\n\n"+
			"IMPORTANT: The user's message may be in any language. Understand the request regardless of language.\n\n"+
			"User request: %s\n\n"+
			"Available tables: %s",
		pctx.UserMessage,
		strings.Join(tableNames, ", "),
	)

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		// Fallback: if LLM fails, use all tables (capped at 10).
		pctx.Logger.Warn("LLM table selection failed, using all tables", zap.Error(err))
		if len(tableNames) > 10 {
			return tableNames[:10], nil
		}
		return tableNames, nil
	}

	pctx.AddTokens(resp.Usage.TotalTokens)
	pctx.ModelUsed = resp.Model

	if len(resp.Choices) == 0 {
		return tableNames, nil
	}

	content := strings.TrimSpace(resp.Choices[0].Message.Content)
	// Strip thinking tags and markdown code fences if present.
	content = stripThinkingTags(content)
	content = stripCodeFences(content)

	var selected []string
	if err := json.Unmarshal([]byte(content), &selected); err != nil {
		pctx.Logger.Warn("failed to parse LLM table selection, using all tables",
			zap.String("content", content),
			zap.Error(err),
		)
		if len(tableNames) > 10 {
			return tableNames[:10], nil
		}
		return tableNames, nil
	}

	// Validate that selected tables exist in the original list.
	nameSet := make(map[string]bool, len(tableNames))
	for _, n := range tableNames {
		nameSet[n] = true
	}
	var validated []string
	for _, sel := range selected {
		if nameSet[sel] {
			validated = append(validated, sel)
		}
	}

	if len(validated) == 0 {
		// LLM returned nonsense — fall back to all tables.
		if len(tableNames) > 10 {
			return tableNames[:10], nil
		}
		return tableNames, nil
	}

	return validated, nil
}

// parseTableNames extracts table names from the list_tables tool result.
// It supports both a plain JSON array of strings and an array of objects with a "table_name" field.
func parseTableNames(data json.RawMessage) ([]string, error) {
	// Try wrapped format: {"tables":[{"name":"...","type":"..."}]}
	var wrapped struct {
		Tables []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"tables"`
	}
	if err := json.Unmarshal(data, &wrapped); err == nil && len(wrapped.Tables) > 0 {
		var names []string
		for _, t := range wrapped.Tables {
			names = append(names, t.Name)
		}
		return names, nil
	}

	// Try array of objects with table_name field.
	var objects []map[string]any
	if err := json.Unmarshal(data, &objects); err == nil && len(objects) > 0 {
		var names []string
		for _, obj := range objects {
			if name, ok := obj["table_name"].(string); ok {
				names = append(names, name)
			} else if name, ok := obj["name"].(string); ok {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			return names, nil
		}
	}

	// Try plain array of strings.
	var names []string
	if err := json.Unmarshal(data, &names); err == nil {
		return names, nil
	}

	return nil, fmt.Errorf("unexpected list_tables format: %s", string(data))
}

// stripThinkingTags removes <think>...</think> blocks that reasoning models
// (e.g. Qwen, DeepSeek) prepend to their responses before the actual content.
// Handles both <think>...</think> and partial/unclosed <think> tags.
func stripThinkingTags(s string) string {
	s = strings.TrimSpace(s)
	for {
		openIdx := strings.Index(s, "<think>")
		if openIdx == -1 {
			break
		}
		closeIdx := strings.Index(s, "</think>")
		if closeIdx != -1 && closeIdx > openIdx {
			// Remove the full <think>...</think> block.
			s = s[:openIdx] + s[closeIdx+len("</think>"):]
		} else {
			// Unclosed <think> — remove from <think> to end.
			s = s[:openIdx]
		}
		s = strings.TrimSpace(s)
	}
	return strings.TrimSpace(s)
}

// stripCodeFences removes markdown code block fences from a string.
// Handles ```json, ```sql, ```<any-lang>, and bare ``` fences.
func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		// Strip opening fence with optional language tag (e.g., ```json, ```sql).
		idx := strings.Index(s, "\n")
		if idx != -1 {
			s = s[idx+1:]
		} else {
			s = strings.TrimPrefix(s, "```")
		}
	}
	if strings.HasSuffix(s, "```") {
		s = strings.TrimSuffix(s, "```")
	}
	return strings.TrimSpace(s)
}
