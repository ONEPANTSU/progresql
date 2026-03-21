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

// AnalyzeSchemaStep calls list_schemas, list_tables, and describe_table for all
// tables, then sends the collected schema dump to the LLM for analysis.
// The LLM produces a structured report covering relationships, indexes,
// potential problems and recommendations.
type AnalyzeSchemaStep struct{}

func (s *AnalyzeSchemaStep) Name() string { return "analyze_schema" }

func (s *AnalyzeSchemaStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	// Step 1: list_schemas
	schemasResult, err := pctx.DispatchTool(tools.ToolListSchemas, json.RawMessage(`{}`))
	if err != nil {
		return fmt.Errorf("list_schemas failed: %w", err)
	}
	if !schemasResult.Success {
		if agent.IsDBNotConnectedMessage(schemasResult.Error) {
			return agent.NewDatabaseNotConnectedError("list_schemas")
		}
		return fmt.Errorf("list_schemas returned error: %s", schemasResult.Error)
	}

	schemas := parseSchemaNames(schemasResult.Data)
	if len(schemas) == 0 {
		schemas = []string{"public"}
	}

	pctx.Logger.Info("schemas discovered", zap.Int("count", len(schemas)), zap.Strings("schemas", schemas))

	// Step 2: list_tables for each schema.
	type schemaTable struct {
		Schema string
		Table  string
	}
	var allTables []schemaTable

	for _, schema := range schemas {
		tablesArg, _ := json.Marshal(map[string]string{"schema": schema})
		tablesResult, err := pctx.DispatchTool(tools.ToolListTables, tablesArg)
		if err != nil {
			pctx.Logger.Warn("list_tables failed, skipping schema",
				zap.String("schema", schema), zap.Error(err))
			continue
		}
		if !tablesResult.Success {
			pctx.Logger.Warn("list_tables returned error, skipping schema",
				zap.String("schema", schema), zap.String("error", tablesResult.Error))
			continue
		}

		tableNames, err := parseTableNames(tablesResult.Data)
		if err != nil {
			pctx.Logger.Warn("parse list_tables failed, skipping schema",
				zap.String("schema", schema), zap.Error(err))
			continue
		}
		for _, t := range tableNames {
			allTables = append(allTables, schemaTable{Schema: schema, Table: t})
		}
	}

	if len(allTables) == 0 {
		return s.handleEmptyDatabase(ctx, pctx)
	}

	pctx.Logger.Info("tables discovered", zap.Int("count", len(allTables)))

	// Step 3: describe_table for each table.
	var descriptions []string
	for _, st := range allTables {
		descArg, _ := json.Marshal(map[string]string{
			"schema": st.Schema,
			"table":  st.Table,
		})
		descResult, err := pctx.DispatchTool(tools.ToolDescribeTable, descArg)
		if err != nil {
			pctx.Logger.Warn("describe_table failed, skipping",
				zap.String("table", st.Table), zap.Error(err))
			continue
		}
		if !descResult.Success {
			pctx.Logger.Warn("describe_table returned error, skipping",
				zap.String("table", st.Table), zap.String("error", descResult.Error))
			continue
		}
		descriptions = append(descriptions, fmt.Sprintf("## %s.%s\n%s", st.Schema, st.Table, string(descResult.Data)))
	}

	if len(descriptions) == 0 {
		return fmt.Errorf("no table descriptions obtained")
	}

	// Step 4: Send schema dump to LLM for analysis with streaming.
	model := pctx.Model

	schemaDump := strings.Join(descriptions, "\n\n")

	userDescSection := ""
	if pctx.UserDescriptions != "" {
		userDescSection = fmt.Sprintf("\nUser-provided descriptions for database objects:\n%s\n\n", pctx.UserDescriptions)
	}

	prompt := fmt.Sprintf(
		"You are an expert PostgreSQL database architect. Analyze the following database schema dump.\n\n"+
			"IMPORTANT: Always respond in the same language as the user's message. "+
			"If the user writes in Russian, respond in Russian. If in English, respond in English. "+
			"SQL code and technical terms (table names, column names) must remain as-is.\n\n"+
			"%s"+
			"User message: %s\n\n"+
			"Provide a structured report covering:\n"+
			"1. Overview: number of tables, schemas, general purpose of the database\n"+
			"2. Table relationships: foreign keys, join paths, relationship types (1:1, 1:N, M:N)\n"+
			"3. Indexing analysis: existing indexes, missing indexes for common query patterns\n"+
			"4. Potential issues: naming inconsistencies, missing constraints, normalization problems\n"+
			"5. Recommendations: specific actionable improvements\n\n"+
			"Schema dump:\n%s",
		userDescSection,
		pctx.UserMessage,
		schemaDump,
	)

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	pctx.Logger.Info("analyzing schema",
		zap.String("model", model),
		zap.Int("tables", len(descriptions)),
	)

	resp, err := pctx.StreamLLM(ctx, req)
	if err != nil {
		return fmt.Errorf("LLM analyze_schema failed: %w", err)
	}

	if len(resp.Choices) == 0 {
		return fmt.Errorf("LLM returned no choices")
	}

	explanation := resp.Choices[0].Message.Content
	if explanation == "" {
		return fmt.Errorf("LLM returned empty analysis")
	}

	pctx.Result.Explanation = explanation

	pctx.Logger.Info("schema analysis generated",
		zap.Int("explanation_length", len(explanation)),
		zap.Int("tokens", pctx.TokensUsed),
	)

	return nil
}

// handleEmptyDatabase streams a helpful LLM response when the database has no tables.
func (s *AnalyzeSchemaStep) handleEmptyDatabase(ctx context.Context, pctx *agent.PipelineContext) error {
	pctx.Logger.Info("database is empty, no tables found — generating helpful response")

	model := pctx.Model

	prompt := "You are a PostgreSQL database assistant. The user is connected to a database, " +
		"but the database is completely empty — there are no tables, views, or other objects in any schema.\n\n" +
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

	return nil
}

// parseSchemaNames extracts schema names from the list_schemas tool result.
// Supports both a plain JSON array of strings and an array of objects with a "schema_name" field.
func parseSchemaNames(data json.RawMessage) []string {
	// Try array of objects with schema_name field.
	var objects []map[string]any
	if err := json.Unmarshal(data, &objects); err == nil && len(objects) > 0 {
		var names []string
		for _, obj := range objects {
			if name, ok := obj["schema_name"].(string); ok {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			return names
		}
	}

	// Try plain array of strings.
	var names []string
	if err := json.Unmarshal(data, &names); err == nil {
		return names
	}

	return nil
}
