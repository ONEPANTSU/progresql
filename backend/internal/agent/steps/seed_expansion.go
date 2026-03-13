package steps

import (
	"context"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
)

// DefaultMinCandidates is the minimum number of candidates after seed expansion.
const DefaultMinCandidates = 3

// SeedExpansionStep is step 4 of the generate_sql pipeline.
// If valid candidates after diagnostic retry are fewer than MinCandidates,
// it generates additional variations via LLM based on existing valid candidates.
// If zero valid candidates remain, it returns an error.
type SeedExpansionStep struct {
	// MinCandidates is the target minimum number of candidates.
	// If zero, DefaultMinCandidates is used.
	MinCandidates int
}

func (s *SeedExpansionStep) Name() string { return "seed_expansion" }

func (s *SeedExpansionStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	val, ok := pctx.Get(ContextKeySQLCandidates)
	if !ok {
		return fmt.Errorf("sql_candidates not found: diagnostic_retry step must run first")
	}
	candidates, ok := val.([]string)
	if !ok {
		return fmt.Errorf("sql_candidates has unexpected type")
	}

	if len(candidates) == 0 {
		return fmt.Errorf("no valid SQL candidates for seed expansion")
	}

	minCandidates := s.MinCandidates
	if minCandidates <= 0 {
		minCandidates = DefaultMinCandidates
	}

	if len(candidates) >= minCandidates {
		pctx.Logger.Info("seed expansion skipped: enough candidates",
			zap.Int("candidates", len(candidates)),
			zap.Int("min_required", minCandidates),
		)
		return nil
	}

	needed := minCandidates - len(candidates)

	pctx.Logger.Info("starting seed expansion",
		zap.Int("existing", len(candidates)),
		zap.Int("needed", needed),
		zap.Int("target", minCandidates),
	)

	model := pctx.Model

	var schemaDesc string
	if scVal, ok := pctx.Get(ContextKeySchemaContext); ok {
		if sc, ok := scVal.(*SchemaContext); ok {
			schemaDesc = buildSchemaDescription(sc)
		}
	}

	for i := 0; i < needed; i++ {
		variation, err := s.generateVariation(ctx, pctx, candidates, model, schemaDesc, i)
		if err != nil {
			pctx.Logger.Warn("seed expansion variation failed",
				zap.Int("variation_index", i),
				zap.Error(err),
			)
			continue
		}
		candidates = append(candidates, variation)
	}

	pctx.Logger.Info("seed expansion completed",
		zap.Int("total_candidates", len(candidates)),
	)

	pctx.Set(ContextKeySQLCandidates, candidates)
	pctx.Set(ContextKeySQLCandidate, candidates[0])
	pctx.Result.SQL = candidates[0]
	pctx.Result.Candidates = candidates

	return nil
}

func (s *SeedExpansionStep) generateVariation(
	ctx context.Context,
	pctx *agent.PipelineContext,
	existingCandidates []string,
	model string,
	schemaDesc string,
	variationIndex int,
) (string, error) {
	existingList := ""
	for i, c := range existingCandidates {
		existingList += fmt.Sprintf("\nCandidate %d:\n```sql\n%s\n```\n", i+1, c)
	}

	prompt := fmt.Sprintf(
		"You are an expert PostgreSQL developer. Generate an alternative SQL query that achieves the same goal as the existing candidates but uses a different approach.\n\n"+
			"Existing candidates:%s\n"+
			"User request: %s\n\n",
		existingList,
		pctx.UserMessage,
	)

	if schemaDesc != "" {
		prompt += fmt.Sprintf("Database schema:\n%s\n\n", schemaDesc)
	}

	strategies := []string{
		"Use a different JOIN strategy or subquery approach.",
		"Optimize for readability using CTEs (WITH clauses).",
		"Use window functions or aggregate functions differently.",
	}
	prompt += fmt.Sprintf("Strategy: %s\n", strategies[variationIndex%len(strategies)])
	prompt += "Return ONLY the SQL query, no explanations or markdown."

	temp := 0.7
	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
		Temperature: &temp,
	}

	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		return "", fmt.Errorf("LLM variation %d failed: %w", variationIndex, err)
	}

	pctx.AddTokens(resp.Usage.TotalTokens)
	if resp.Model != "" {
		pctx.ModelUsed = resp.Model
	}

	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("LLM variation %d returned no choices", variationIndex)
	}

	sql := strings.TrimSpace(resp.Choices[0].Message.Content)
	sql = stripThinkingTags(sql)
	sql = stripCodeFences(sql)
	sql = strings.TrimRight(sql, "; \n\t")
	sql = strings.TrimSpace(sql)

	if sql == "" {
		return "", fmt.Errorf("LLM variation %d returned empty SQL", variationIndex)
	}

	pctx.Logger.Info("generated seed expansion variation",
		zap.Int("variation_index", variationIndex),
		zap.String("sql", sql),
	)

	return sql, nil
}
