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
const ContextKeyGroundingPlan = "grounding_plan"

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

type GroundingPlan struct {
	RelevantTables  []string               `json:"relevant_tables"`
	RelevantColumns []string               `json:"relevant_columns"`
	Joins           []GroundingJoin        `json:"joins"`
	Filters         []GroundingFilter      `json:"filters"`
	Aggregations    []GroundingAggregation `json:"aggregations"`
	Ordering        []GroundingOrdering    `json:"ordering"`
	Ambiguities     []string               `json:"ambiguities"`
	Confidence      float64                `json:"confidence"`
}

type GroundingJoin struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"`
}

type GroundingFilter struct {
	Column    string `json:"column"`
	Operation string `json:"operation"`
	Reason    string `json:"reason"`
}

type GroundingAggregation struct {
	Expression string   `json:"expression"`
	GroupBy    []string `json:"group_by"`
	Reason     string   `json:"reason"`
}

type GroundingOrdering struct {
	Expression string `json:"expression"`
	Reason     string `json:"reason"`
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

	groundingPlan := s.buildLLMGroundingPlan(ctx, pctx, &schemaCtx)
	if groundingPlan == nil {
		heuristic := buildHeuristicGroundingPlan(&schemaCtx, pctx.UserMessage, pctx.UserDescriptions)
		groundingPlan = &heuristic
	}

	// Step 5: Store the enriched schema context for downstream steps.
	pctx.Set(ContextKeySchemaContext, &schemaCtx)
	pctx.Set(ContextKeyGroundingPlan, *groundingPlan)

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

	userDescSection := ""
	if pctx.UserDescriptions != "" {
		userDescSection = fmt.Sprintf("\nUser-provided descriptions for database objects:\n%s\n", pctx.UserDescriptions)
	}

	prompt := fmt.Sprintf(
		"You are a database expert. Given the user's request and the list of available tables, "+
			"return ONLY a JSON array of table names that are relevant to answering the request. "+
			"Return at most 10 tables. Do not include any explanation, just the JSON array.\n\n"+
			"IMPORTANT: The user's message may be in any language. Understand the request regardless of language.\n\n"+
			"User request: %s\n%s\n"+
			"Available tables: %s",
		pctx.UserMessage,
		userDescSection,
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

func (s *SchemaGroundingStep) buildLLMGroundingPlan(ctx context.Context, pctx *agent.PipelineContext, sc *SchemaContext) *GroundingPlan {
	if pctx.LLMClient == nil {
		pctx.Logger.Warn("LLM grounding plan skipped: client unavailable")
		return nil
	}

	model := pctx.Model
	userDescSection := "None"
	if strings.TrimSpace(pctx.UserDescriptions) != "" {
		userDescSection = pctx.UserDescriptions
	}
	prompt := fmt.Sprintf(
		"You are a PostgreSQL schema-grounding planner. Build a schema-oriented reasoning plan before SQL generation.\n"+
			"Return ONLY strict JSON matching this shape, with no markdown or explanations:\n"+
			"{\"relevant_tables\":[\"public.orders\"],\"relevant_columns\":[\"public.orders.id\"],\"joins\":[{\"from\":\"public.orders.customer_id\",\"to\":\"public.customers.id\",\"reason\":\"...\"}],\"filters\":[{\"column\":\"public.orders.created_at\",\"operation\":\"date range\",\"reason\":\"...\"}],\"aggregations\":[{\"expression\":\"COUNT(*)\",\"group_by\":[\"public.orders.status\"],\"reason\":\"...\"}],\"ordering\":[{\"expression\":\"COUNT(*) DESC\",\"reason\":\"...\"}],\"ambiguities\":[\"...\"],\"confidence\":0.82}\n\n"+
			"Rules:\n"+
			"- Use only tables and columns from the selected schema description.\n"+
			"- Prefer known foreign keys for joins.\n"+
			"- If a request is ambiguous, add ambiguity notes and choose conservative defaults.\n"+
			"- Confidence must be a number from 0 to 1.\n\n"+
			"User request:\n%s\n\n"+
			"User-provided descriptions:\n%s\n\n"+
			"Selected schema description:\n%s",
		pctx.UserMessage,
		userDescSection,
		buildSchemaDescription(sc),
	)

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}
	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		pctx.Logger.Warn("LLM grounding plan failed, using heuristic fallback", zap.Error(err))
		return nil
	}

	pctx.AddTokensDetailed(resp.Usage)
	pctx.ModelUsed = resp.Model
	if len(resp.Choices) == 0 {
		pctx.Logger.Warn("LLM grounding plan returned no choices, using heuristic fallback")
		return nil
	}

	content := strings.TrimSpace(resp.Choices[0].Message.Content)
	content = stripThinkingTags(content)
	content = stripCodeFences(content)

	var plan GroundingPlan
	if err := json.Unmarshal([]byte(content), &plan); err != nil {
		pctx.Logger.Warn("LLM grounding plan JSON parse failed, using heuristic fallback", zap.Error(err))
		return nil
	}

	validated, warnings := validateGroundingPlan(plan, sc)
	for _, warning := range warnings {
		pctx.Logger.Warn("LLM grounding plan item discarded", zap.String("reason", warning))
	}
	if validated == nil {
		pctx.Logger.Warn("LLM grounding plan invalid after validation, using heuristic fallback")
		return nil
	}
	return validated
}

func buildHeuristicGroundingPlan(sc *SchemaContext, userMessage, userDescriptions string) GroundingPlan {
	plan := GroundingPlan{}
	msg := strings.ToLower(userMessage + "\n" + userDescriptions)
	for _, table := range sc.Tables {
		fullName := table.Schema + "." + table.Table
		plan.RelevantTables = append(plan.RelevantTables, fullName)
		var details struct {
			Columns     []any `json:"columns"`
			ForeignKeys []struct {
				Columns           []string `json:"columns"`
				Column            string   `json:"column"`
				ReferencedTable   string   `json:"referenced_table"`
				ReferencedColumns []string `json:"referenced_columns"`
			} `json:"foreign_keys"`
		}
		if err := json.Unmarshal(table.Details, &details); err != nil {
			plan.Ambiguities = append(plan.Ambiguities, "Could not parse details for "+fullName)
			continue
		}
		for _, raw := range details.Columns {
			name := ""
			switch col := raw.(type) {
			case string:
				name = col
			case map[string]any:
				if v, ok := col["name"].(string); ok {
					name = v
				} else if v, ok := col["column_name"].(string); ok {
					name = v
				}
			}
			if name == "" {
				continue
			}
			qualified := fullName + "." + name
			plan.RelevantColumns = append(plan.RelevantColumns, qualified)
			lower := strings.ToLower(name)
			if strings.Contains(msg, lower) {
				plan.Filters = append(plan.Filters, GroundingFilter{
					Column:    qualified,
					Operation: "possible filter",
					Reason:    "column name appears in the user request or descriptions",
				})
			}
			if strings.Contains(lower, "count") || strings.Contains(lower, "total") || strings.Contains(lower, "amount") || strings.Contains(lower, "sum") {
				plan.Aggregations = append(plan.Aggregations, GroundingAggregation{
					Expression: qualified,
					Reason:     "column name suggests a measurable value",
				})
			}
		}
		for _, fk := range details.ForeignKeys {
			if fk.ReferencedTable != "" {
				column := fk.Column
				if column == "" && len(fk.Columns) > 0 {
					column = fk.Columns[0]
				}
				refColumn := ""
				if len(fk.ReferencedColumns) > 0 {
					refColumn = "." + fk.ReferencedColumns[0]
				}
				plan.Joins = append(plan.Joins, GroundingJoin{
					From:   fullName + "." + column,
					To:     fk.ReferencedTable + refColumn,
					Reason: "known foreign key relationship",
				})
			}
		}
	}
	if len(plan.Filters) == 0 {
		plan.Ambiguities = append(plan.Ambiguities, "No explicit filter columns matched the user request.")
	}
	if plan.Confidence == 0 {
		plan.Confidence = 0.5
	}
	return plan
}

func validateGroundingPlan(plan GroundingPlan, sc *SchemaContext) (*GroundingPlan, []string) {
	if plan.Confidence < 0.35 {
		return nil, []string{"confidence below threshold"}
	}

	tables, columns := schemaNameSets(sc)
	var warnings []string
	validated := GroundingPlan{
		Ambiguities: plan.Ambiguities,
		Confidence:  plan.Confidence,
	}

	for _, table := range uniqueStrings(plan.RelevantTables) {
		if tables[table] {
			validated.RelevantTables = append(validated.RelevantTables, table)
		} else {
			warnings = append(warnings, "unknown table "+table)
		}
	}

	for _, column := range uniqueStrings(plan.RelevantColumns) {
		if columns[column] {
			validated.RelevantColumns = append(validated.RelevantColumns, column)
		} else {
			warnings = append(warnings, "unknown column "+column)
		}
	}

	for _, join := range plan.Joins {
		if !columns[join.From] {
			warnings = append(warnings, "unknown join source "+join.From)
			continue
		}
		if !columns[join.To] {
			warnings = append(warnings, "unknown join target "+join.To)
			continue
		}
		validated.Joins = append(validated.Joins, join)
	}

	for _, filter := range plan.Filters {
		if !columns[filter.Column] {
			warnings = append(warnings, "unknown filter column "+filter.Column)
			continue
		}
		validated.Filters = append(validated.Filters, filter)
	}

	for _, agg := range plan.Aggregations {
		var groupBy []string
		for _, column := range uniqueStrings(agg.GroupBy) {
			if columns[column] {
				groupBy = append(groupBy, column)
			} else {
				warnings = append(warnings, "unknown aggregation group_by column "+column)
			}
		}
		agg.GroupBy = groupBy
		validated.Aggregations = append(validated.Aggregations, agg)
	}

	validated.Ordering = plan.Ordering
	if len(validated.RelevantTables) == 0 && len(validated.RelevantColumns) == 0 && len(validated.Joins) == 0 &&
		len(validated.Filters) == 0 && len(validated.Aggregations) == 0 {
		return nil, append(warnings, "grounding plan empty after validation")
	}

	return &validated, warnings
}

func schemaNameSets(sc *SchemaContext) (map[string]bool, map[string]bool) {
	tables := make(map[string]bool)
	columns := make(map[string]bool)
	for _, table := range sc.Tables {
		fullName := table.Schema + "." + table.Table
		tables[fullName] = true
		for _, column := range extractColumnNames(table.Details) {
			columns[fullName+"."+column] = true
		}
	}
	return tables, columns
}

func extractColumnNames(details json.RawMessage) []string {
	var parsed struct {
		Columns []any `json:"columns"`
	}
	if err := json.Unmarshal(details, &parsed); err != nil {
		return nil
	}
	var names []string
	for _, raw := range parsed.Columns {
		switch col := raw.(type) {
		case string:
			names = append(names, col)
		case map[string]any:
			if v, ok := col["name"].(string); ok {
				names = append(names, v)
			} else if v, ok := col["column_name"].(string); ok {
				names = append(names, v)
			}
		}
	}
	return names
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	var out []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func buildGroundingPlanDescription(plan GroundingPlan) string {
	var b strings.Builder
	writeList := func(label string, values []string) {
		if len(values) == 0 {
			return
		}
		b.WriteString(label)
		b.WriteString(":\n")
		for _, value := range values {
			b.WriteString("- ")
			b.WriteString(value)
			b.WriteString("\n")
		}
	}
	writeList("Use these tables first", plan.RelevantTables)
	writeList("Prefer these columns", plan.RelevantColumns)
	if len(plan.Joins) > 0 {
		b.WriteString("Use these joins:\n")
		for _, join := range plan.Joins {
			fmt.Fprintf(&b, "- %s -> %s", join.From, join.To)
			if join.Reason != "" {
				fmt.Fprintf(&b, " (%s)", join.Reason)
			}
			b.WriteString("\n")
		}
	}
	if len(plan.Filters) > 0 {
		b.WriteString("Apply these filters if relevant:\n")
		for _, filter := range plan.Filters {
			fmt.Fprintf(&b, "- %s", filter.Column)
			if filter.Operation != "" {
				fmt.Fprintf(&b, " [%s]", filter.Operation)
			}
			if filter.Reason != "" {
				fmt.Fprintf(&b, " (%s)", filter.Reason)
			}
			b.WriteString("\n")
		}
	}
	if len(plan.Aggregations) > 0 {
		b.WriteString("Aggregations expected:\n")
		for _, agg := range plan.Aggregations {
			fmt.Fprintf(&b, "- %s", agg.Expression)
			if len(agg.GroupBy) > 0 {
				fmt.Fprintf(&b, " GROUP BY %s", strings.Join(agg.GroupBy, ", "))
			}
			if agg.Reason != "" {
				fmt.Fprintf(&b, " (%s)", agg.Reason)
			}
			b.WriteString("\n")
		}
	}
	if len(plan.Ordering) > 0 {
		b.WriteString("Ordering preferences:\n")
		for _, ordering := range plan.Ordering {
			fmt.Fprintf(&b, "- %s", ordering.Expression)
			if ordering.Reason != "" {
				fmt.Fprintf(&b, " (%s)", ordering.Reason)
			}
			b.WriteString("\n")
		}
	}
	writeList("Ambiguities to resolve conservatively", plan.Ambiguities)
	if plan.Confidence > 0 {
		fmt.Fprintf(&b, "Grounding confidence: %.2f\n", plan.Confidence)
	}
	return strings.TrimSpace(b.String())
}
