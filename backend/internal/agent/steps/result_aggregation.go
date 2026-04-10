package steps

import (
	"context"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
)

// ResultAggregationStep is step 5 of the generate_sql pipeline.
// It sends all SQL candidates to the LLM, which selects the best one
// with a justification. The response is streamed to the client.
type ResultAggregationStep struct{}

func (s *ResultAggregationStep) Name() string { return "result_aggregation" }

func (s *ResultAggregationStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	val, ok := pctx.Get(ContextKeySQLCandidates)
	if !ok {
		return fmt.Errorf("sql_candidates not found: previous steps must run first")
	}
	candidates, ok := val.([]string)
	if !ok {
		return fmt.Errorf("sql_candidates has unexpected type")
	}

	if len(candidates) == 0 {
		return fmt.Errorf("no SQL candidates for aggregation")
	}

	// Single candidate — no need for LLM selection.
	if len(candidates) == 1 {
		pctx.Logger.Info("single candidate, skipping LLM selection")
		pctx.Result.SQL = candidates[0]
		pctx.Result.Candidates = candidates
		if pctx.Result.ValidationError == "" && !pctx.Result.SecurityBlocked {
			pctx.Result.Explanation = "Only one candidate was generated."
		}
		return nil
	}

	model := pctx.Model

	prompt := buildAggregationPrompt(candidates, pctx.UserMessage)

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	pctx.Logger.Info("starting result aggregation",
		zap.String("model", model),
		zap.Int("candidates", len(candidates)),
	)

	// Use non-streaming call — candidate evaluation is internal, not user-facing.
	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		return fmt.Errorf("LLM result aggregation failed: %w", err)
	}
	pctx.AddTokensDetailed(resp.Usage)
	pctx.ModelUsed = resp.Model

	if len(resp.Choices) == 0 {
		return fmt.Errorf("LLM returned no choices for aggregation")
	}

	content := stripThinkingTags(resp.Choices[0].Message.Content)
	if content == "" {
		return fmt.Errorf("LLM returned empty aggregation response")
	}

	// Extract the chosen SQL from the response.
	chosenSQL := extractChosenSQL(content, candidates)

	pctx.Result.SQL = chosenSQL
	pctx.Result.Explanation = content
	pctx.Result.Candidates = candidates

	pctx.Logger.Info("result aggregation completed",
		zap.Int("explanation_length", len(content)),
		zap.Int("sql_length", len(chosenSQL)),
	)

	return nil
}

// buildAggregationPrompt constructs the LLM prompt for selecting the best SQL candidate.
// The prompt instructs the LLM to produce a short, user-friendly explanation
// (no mention of "candidates") and the chosen SQL in a code block.
func buildAggregationPrompt(candidates []string, userMessage string) string {
	var b strings.Builder

	b.WriteString("You are an expert PostgreSQL assistant. You are given multiple SQL query candidates that attempt to answer a user's request. ")
	b.WriteString("Select the BEST candidate (or combine the best parts) and present it to the user.\n\n")
	b.WriteString("CRITICAL RULES:\n")
	b.WriteString("- Do NOT mention candidates, candidate numbers, or the selection process. The user does not know multiple queries were generated.\n")
	b.WriteString("- Write a short, friendly explanation of the chosen query as if YOU wrote it. Explain what the query does.\n")
	b.WriteString("- Always respond in the same language as the user's message. If in Russian, respond in Russian. If in English, respond in English.\n")
	b.WriteString("- Output the final SQL inside a ```sql code block at the END of your response.\n\n")

	b.WriteString("User request: ")
	b.WriteString(userMessage)
	b.WriteString("\n\n")

	b.WriteString("SQL candidates (internal, do not expose to user):\n")
	for i, c := range candidates {
		fmt.Fprintf(&b, "\n--- Candidate %d ---\n```sql\n%s\n```\n", i+1, c)
	}

	return b.String()
}

// extractChosenSQL extracts the final SQL from the LLM response.
// It looks for the last ```sql code block. If none found, falls back to the first candidate.
func extractChosenSQL(content string, candidates []string) string {
	sql := extractLastSQLBlock(content)
	if sql != "" {
		return sql
	}
	// Fallback: return first candidate.
	if len(candidates) > 0 {
		return candidates[0]
	}
	return ""
}

// extractLastSQLBlock finds the last ```sql ... ``` block in the content.
func extractLastSQLBlock(content string) string {
	lastIdx := strings.LastIndex(content, "```sql")
	if lastIdx == -1 {
		lastIdx = strings.LastIndex(content, "```SQL")
	}
	if lastIdx == -1 {
		return ""
	}

	start := lastIdx + len("```sql")
	// Skip optional newline after ```sql
	if start < len(content) && content[start] == '\n' {
		start++
	}

	rest := content[start:]
	endIdx := strings.Index(rest, "```")
	if endIdx == -1 {
		return ""
	}

	sql := strings.TrimSpace(rest[:endIdx])
	sql = strings.TrimRight(sql, "; \n\t")
	sql = strings.TrimSpace(sql)
	return sql
}
