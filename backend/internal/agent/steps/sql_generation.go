package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
)

// ContextKeySQLCandidate is the key used to store the generated SQL candidate
// in PipelineContext.values for downstream steps.
const ContextKeySQLCandidate = "sql_candidate"

// SQLGenerationStep is step 2 of the generate_sql pipeline.
// It takes user_message + schema context from step 1 and generates one SQL candidate via LLM.
type SQLGenerationStep struct{}

func (s *SQLGenerationStep) Name() string { return "sql_generation" }

func (s *SQLGenerationStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	val, ok := pctx.Get(ContextKeySchemaContext)
	if !ok {
		return fmt.Errorf("schema_context not found: schema_grounding step must run first")
	}
	schemaCtx, ok := val.(*SchemaContext)
	if !ok {
		return fmt.Errorf("schema_context has unexpected type")
	}

	schemaDesc := buildSchemaDescription(schemaCtx)

	model := pctx.Model

	userDescSection := ""
	if pctx.UserDescriptions != "" {
		userDescSection = fmt.Sprintf("\nUser-provided descriptions for database objects:\n%s\n\n", pctx.UserDescriptions)
	}

	prompt := fmt.Sprintf(
		"You are an expert PostgreSQL developer. Generate a single SQL query that answers the user's request.\n\n"+
			"Rules:\n"+
			"- Use ONLY the tables and columns provided in the schema below\n"+
			"- Write valid PostgreSQL syntax\n"+
			"- Use appropriate JOINs when multiple tables are needed\n"+
			"- Add LIMIT 100 if the query could return many rows\n"+
			"- Return ONLY the SQL query, no explanations or markdown\n\n"+
			"%s"+
			"Database schema:\n%s\n\n"+
			"User request: %s",
		userDescSection,
		schemaDesc,
		pctx.UserMessage,
	)

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	pctx.Logger.Info("generating SQL candidate",
		zap.String("model", model),
		zap.Int("schema_tables", len(schemaCtx.Tables)),
	)

	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		return fmt.Errorf("LLM sql generation failed: %w", err)
	}

	pctx.AddTokens(resp.Usage.TotalTokens)
	pctx.ModelUsed = resp.Model

	if len(resp.Choices) == 0 {
		return fmt.Errorf("LLM returned no choices")
	}

	sql := strings.TrimSpace(resp.Choices[0].Message.Content)
	sql = stripThinkingTags(sql)
	sql = stripCodeFences(sql)
	sql = strings.TrimRight(sql, "; \n\t")
	sql = strings.TrimSpace(sql)

	if sql == "" {
		return fmt.Errorf("LLM returned empty SQL")
	}

	pctx.Logger.Info("SQL candidate generated",
		zap.String("sql", sql),
		zap.Int("tokens", resp.Usage.TotalTokens),
	)

	pctx.Set(ContextKeySQLCandidate, sql)
	pctx.Result.SQL = sql

	return nil
}

// buildSchemaDescription formats the schema context into a human-readable string for the LLM prompt.
func buildSchemaDescription(sc *SchemaContext) string {
	var sb strings.Builder
	for _, table := range sc.Tables {
		sb.WriteString(fmt.Sprintf("Table: %s.%s\n", table.Schema, table.Table))
		var details map[string]any
		if err := json.Unmarshal(table.Details, &details); err == nil {
			if cols, ok := details["columns"]; ok {
				colJSON, _ := json.MarshalIndent(cols, "  ", "  ")
				sb.WriteString(fmt.Sprintf("  Columns: %s\n", string(colJSON)))
			}
			if indexes, ok := details["indexes"]; ok {
				idxJSON, _ := json.MarshalIndent(indexes, "  ", "  ")
				sb.WriteString(fmt.Sprintf("  Indexes: %s\n", string(idxJSON)))
			}
			if fks, ok := details["foreign_keys"]; ok {
				fkJSON, _ := json.MarshalIndent(fks, "  ", "  ")
				sb.WriteString(fmt.Sprintf("  Foreign Keys: %s\n", string(fkJSON)))
			}
			if checks, ok := details["check_constraints"]; ok {
				checkJSON, _ := json.MarshalIndent(checks, "  ", "  ")
				sb.WriteString(fmt.Sprintf("  CHECK Constraints (allowed values): %s\n", string(checkJSON)))
			}
			if triggers, ok := details["triggers"]; ok {
				trigJSON, _ := json.MarshalIndent(triggers, "  ", "  ")
				sb.WriteString(fmt.Sprintf("  Triggers: %s\n", string(trigJSON)))
			}
			if keys, ok := details["key_constraints"]; ok {
				keyJSON, _ := json.MarshalIndent(keys, "  ", "  ")
				sb.WriteString(fmt.Sprintf("  Key Constraints (PK/UNIQUE): %s\n", string(keyJSON)))
			}
		} else {
			sb.WriteString(fmt.Sprintf("  Details: %s\n", string(table.Details)))
		}
		sb.WriteString("\n")
	}
	return sb.String()
}
