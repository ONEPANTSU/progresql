package steps

import (
	"context"
	"fmt"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
)

// ExplainSQLStep takes SQL from context.selected_sql and sends it to the LLM
// for explanation with streaming support.
type ExplainSQLStep struct{}

func (s *ExplainSQLStep) Name() string { return "explain_sql" }

func (s *ExplainSQLStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	sql := pctx.SelectedSQL
	if sql == "" {
		return fmt.Errorf("selected_sql is required for explain_sql action")
	}

	model := pctx.Model

	userDescSection := ""
	if pctx.UserDescriptions != "" {
		userDescSection = fmt.Sprintf("\nUser-provided descriptions for database objects:\n%s\n\n", pctx.UserDescriptions)
	}

	// Determine response language from client setting.
	respLang := "English"
	if pctx.Language == "ru" {
		respLang = "Russian"
	}

	prompt := fmt.Sprintf(
		"You are an expert PostgreSQL developer and teacher. Explain the following SQL query in clear, structured way.\n\n"+
			"RESPONSE LANGUAGE: %s. Write all explanations in %s. SQL code must remain in standard SQL syntax.\n\n"+
			"%s"+
			"Cover:\n"+
			"- What the query does (high-level purpose)\n"+
			"- How it works step by step (JOINs, WHERE, GROUP BY, subqueries, etc.)\n"+
			"- Any potential performance considerations\n"+
			"- Suggestions for improvement if applicable\n\n"+
			"User message: %s\n\n"+
			"SQL:\n```sql\n%s\n```",
		respLang, respLang,
		userDescSection,
		pctx.UserMessage,
		sql,
	)

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	pctx.Logger.Info("explaining SQL",
		zap.String("model", model),
		zap.Int("sql_length", len(sql)),
	)

	resp, err := pctx.StreamLLM(ctx, req)
	if err != nil {
		return fmt.Errorf("LLM explain_sql failed: %w", err)
	}

	if len(resp.Choices) == 0 {
		return fmt.Errorf("LLM returned no choices")
	}

	explanation := resp.Choices[0].Message.Content
	if explanation == "" {
		return fmt.Errorf("LLM returned empty explanation")
	}

	pctx.Result.Explanation = explanation

	pctx.Logger.Info("SQL explanation generated",
		zap.Int("explanation_length", len(explanation)),
		zap.Int("tokens", pctx.TokensUsed),
	)

	return nil
}
