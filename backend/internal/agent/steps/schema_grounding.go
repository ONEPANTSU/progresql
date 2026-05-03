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
	// Step 1: Discover all schemas.
	schemasResult, err := pctx.DispatchTool(tools.ToolListSchemas, json.RawMessage(`{}`))
	if err != nil {
		return fmt.Errorf("list_schemas failed: %w", err)
	}

	schemas := []string{"public"}
	if schemasResult.Success {
		parsed := parseSchemaNames(schemasResult.Data)
		if len(parsed) > 0 {
			schemas = parsed
		}
	}

	// Step 2: Call list_tables for each schema and collect all tables with their schema prefix.
	var tableNames []string // "schema.table" format for LLM

	for _, schema := range schemas {
		tablesArg, _ := json.Marshal(map[string]string{"schema": schema})
		result, err := pctx.DispatchTool(tools.ToolListTables, tablesArg)
		if err != nil {
			pctx.Logger.Warn("list_tables failed for schema, skipping", zap.String("schema", schema), zap.Error(err))
			continue
		}
		if !result.Success {
			if agent.IsDBNotConnectedMessage(result.Error) {
				return agent.NewDatabaseNotConnectedError("list_tables")
			}
			pctx.Logger.Warn("list_tables error for schema, skipping", zap.String("schema", schema), zap.String("error", result.Error))
			continue
		}

		names, err := parseTableNames(result.Data)
		if err != nil {
			pctx.Logger.Warn("parse list_tables failed for schema", zap.String("schema", schema), zap.Error(err))
			continue
		}

		for _, name := range names {
			tableNames = append(tableNames, schema+"."+name)
		}
	}

	if len(tableNames) == 0 {
		return s.handleEmptyDatabase(ctx, pctx)
	}

	pctx.Logger.Info("tables discovered", zap.Int("count", len(tableNames)), zap.Strings("schemas", schemas))

	// Step 3: Determine relevant tables using LLM.
	relevant, err := s.selectRelevantTables(ctx, pctx, tableNames)
	if err != nil {
		return fmt.Errorf("select relevant tables: %w", err)
	}

	pctx.Logger.Info("relevant tables selected",
		zap.Int("total", len(tableNames)),
		zap.Int("relevant", len(relevant)),
		zap.Strings("tables", relevant),
	)

	// Step 4: Call describe_table for each relevant table.
	var schemaCtx SchemaContext
	for _, fullName := range relevant {
		// Parse "schema.table" format
		schema := "public"
		tableName := fullName
		if parts := strings.SplitN(fullName, ".", 2); len(parts) == 2 {
			schema = parts[0]
			tableName = parts[1]
		}
		descArg, _ := json.Marshal(map[string]string{
			"schema": schema,
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
			Schema:  schema,
			Table:   tableName,
			Details: descResult.Data,
		})
	}

	if len(schemaCtx.Tables) == 0 {
		return fmt.Errorf("no table descriptions obtained for relevant tables")
	}

	// Step 5: Store the enriched schema context for downstream steps.
	pctx.Set(ContextKeySchemaContext, &schemaCtx)

	return nil
}

// handleEmptyDatabase streams a helpful LLM response when the database has no tables.
// In safe/data modes, sets SkipRemaining to bypass all subsequent pipeline steps.
// In execute mode, generates SQL (e.g. CREATE TABLE) and allows auto-execute.
func (s *SchemaGroundingStep) handleEmptyDatabase(ctx context.Context, pctx *agent.PipelineContext) error {
	pctx.Logger.Info("database is empty, no tables found",
		zap.String("security_mode", pctx.SecurityMode))

	model := pctx.Model

	// In execute mode, let the LLM generate DDL and allow auto-execute to run it.
	if pctx.SecurityMode == agent.SecurityModeExecute {
		prompt := "You are a PostgreSQL database assistant. The user is connected to a database, " +
			"but the database is completely empty — there are no tables, views, or other objects.\n\n" +
			"The user asked: " + pctx.UserMessage + "\n\n" +
			"You are in Execute Mode — you have full access to create tables and modify the schema.\n" +
			"Generate the SQL that fulfills the user's request. Return ONLY the SQL query, no explanations or markdown.\n" +
			"If the user asks to create a table, generate a CREATE TABLE statement.\n\n" +
			"IMPORTANT: Always respond in the same language as the user's message."

		req := llm.ChatRequest{
			Model: model,
			Messages: pctx.MessagesWithHistory(
				llm.Message{Role: "user", Content: prompt},
			),
		}

		resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
		if err != nil {
			return fmt.Errorf("LLM sql generation for empty database failed: %w", err)
		}
		pctx.AddTokensDetailed(resp.Usage)
		pctx.ModelUsed = resp.Model

		if len(resp.Choices) == 0 {
			return fmt.Errorf("LLM returned no choices for empty database")
		}

		sql := strings.TrimSpace(resp.Choices[0].Message.Content)
		sql = stripThinkingTags(sql)
		sql = stripCodeFences(sql)
		sql = strings.TrimRight(sql, "; \n\t")
		sql = strings.TrimSpace(sql)

		if sql == "" {
			return fmt.Errorf("LLM returned empty SQL for empty database")
		}

		pctx.Logger.Info("generated SQL for empty database", sqlLogFields(sql)...)
		pctx.Result.SQL = sql
		pctx.Result.Candidates = []string{sql}
		pctx.Set(ContextKeySQLCandidates, []string{sql})
		pctx.Set(ContextKeySQLCandidate, sql)
		// Provide empty schema context so downstream steps don't fail.
		pctx.Set(ContextKeySchemaContext, &SchemaContext{})
		return nil
	}

	// Safe/data modes: stream a helpful response and skip remaining steps.
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

	pctx.AddTokensDetailed(resp.Usage)
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
