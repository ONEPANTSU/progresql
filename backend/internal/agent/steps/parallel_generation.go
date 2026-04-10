package steps

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
)

// ContextKeySQLCandidates is the key used to store the array of generated SQL candidates
// in PipelineContext.values for downstream steps (diagnostic_retry, seed_expansion, aggregation).
const ContextKeySQLCandidates = "sql_candidates"

// DefaultCandidatesCount is the default number of parallel SQL candidates to generate.
const DefaultCandidatesCount = 3

// candidateConfig defines prompt variation for each parallel LLM call.
type candidateConfig struct {
	temperature float64
	suffix      string // additional instruction appended to the prompt
}

// candidateConfigs returns N configs with varying temperatures and prompt styles.
func candidateConfigs(n int) []candidateConfig {
	// Base configs with distinct temperatures and prompt variations.
	base := []candidateConfig{
		{temperature: 0.2, suffix: "Prefer simple, straightforward SQL."},
		{temperature: 0.6, suffix: "Consider using CTEs or subqueries if they improve readability."},
		{temperature: 0.9, suffix: "Try a creative or alternative approach to solve the request."},
	}
	configs := make([]candidateConfig, n)
	for i := 0; i < n; i++ {
		configs[i] = base[i%len(base)]
	}
	return configs
}

// candidateResult holds the result from one parallel LLM call.
type candidateResult struct {
	index            int
	sql              string
	promptTokens     int
	completionTokens int
	model            string
	err              error
}

// ParallelSQLGenerationStep is step 2 of the generate_sql pipeline.
// It generates N SQL candidates in parallel via goroutines with varying temperatures.
type ParallelSQLGenerationStep struct {
	// CandidatesCount is the number of parallel candidates to generate.
	// If zero, DefaultCandidatesCount is used.
	CandidatesCount int
}

func (s *ParallelSQLGenerationStep) Name() string { return "parallel_sql_generation" }

func (s *ParallelSQLGenerationStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	// If SQL candidates were already generated (e.g. by schema_grounding for empty DB), skip.
	if _, ok := pctx.Get(ContextKeySQLCandidates); ok {
		pctx.Logger.Info("parallel_sql_generation skipped: candidates already set")
		return nil
	}

	val, ok := pctx.Get(ContextKeySchemaContext)
	if !ok {
		return fmt.Errorf("schema_context not found: schema_grounding step must run first")
	}
	schemaCtx, ok := val.(*SchemaContext)
	if !ok {
		return fmt.Errorf("schema_context has unexpected type")
	}

	n := s.CandidatesCount
	if n <= 0 {
		n = DefaultCandidatesCount
	}

	schemaDesc := buildSchemaDescription(schemaCtx)
	model := pctx.Model

	configs := candidateConfigs(n)

	pctx.Logger.Info("starting parallel SQL generation",
		zap.String("model", model),
		zap.Int("candidates_count", n),
		zap.Int("schema_tables", len(schemaCtx.Tables)),
	)

	// Launch N goroutines.
	var wg sync.WaitGroup
	results := make([]candidateResult, n)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int, cfg candidateConfig) {
			defer wg.Done()
			results[idx] = s.generateCandidate(ctx, pctx, model, schemaDesc, cfg, idx)
		}(i, configs[i])
	}

	wg.Wait()

	// Collect successful candidates.
	var candidates []string
	totalPrompt := 0
	totalCompletion := 0
	lastModel := ""

	for _, r := range results {
		totalPrompt += r.promptTokens
		totalCompletion += r.completionTokens
		if r.model != "" {
			lastModel = r.model
		}
		if r.err != nil {
			pctx.Logger.Warn("candidate generation failed",
				zap.Int("candidate_index", r.index),
				zap.Error(r.err),
			)
			continue
		}
		candidates = append(candidates, r.sql)
	}

	pctx.AddTokensDetailed(llm.Usage{
		PromptTokens:     totalPrompt,
		CompletionTokens: totalCompletion,
	})
	if lastModel != "" {
		pctx.ModelUsed = lastModel
	}

	if len(candidates) == 0 {
		return fmt.Errorf("all %d SQL candidate generations failed", n)
	}

	pctx.Logger.Info("parallel SQL generation completed",
		zap.Int("successful", len(candidates)),
		zap.Int("total", n),
		zap.Int("tokens", totalPrompt+totalCompletion),
	)

	pctx.Set(ContextKeySQLCandidates, candidates)
	// Also set the first candidate as the primary result for compatibility.
	pctx.Set(ContextKeySQLCandidate, candidates[0])
	pctx.Result.SQL = candidates[0]
	pctx.Result.Candidates = candidates

	return nil
}

// generateCandidate runs a single LLM call with the given config.
func (s *ParallelSQLGenerationStep) generateCandidate(
	ctx context.Context,
	pctx *agent.PipelineContext,
	model, schemaDesc string,
	cfg candidateConfig,
	idx int,
) candidateResult {
	userDescSection := ""
	if pctx.UserDescriptions != "" {
		userDescSection = fmt.Sprintf("\nUser-provided descriptions for database objects:\n%s\n\n", pctx.UserDescriptions)
	}

	prompt := fmt.Sprintf(
		"You are an expert PostgreSQL developer. Generate a single SQL query that answers the user's request.\n\n"+
			"IMPORTANT: The user's message may be in any language. Understand the request regardless of language. "+
			"SQL code must remain in standard SQL syntax (do not translate SQL keywords).\n\n"+
			"Rules:\n"+
			"- Use ONLY the tables and columns provided in the schema below\n"+
			"- Write valid PostgreSQL syntax\n"+
			"- Use appropriate JOINs when multiple tables are needed\n"+
			"- Add LIMIT 100 if the query could return many rows\n"+
			"- Return ONLY the SQL query, no explanations or markdown\n"+
			"- %s\n\n"+
			"%s"+
			"Database schema:\n%s\n\n"+
			"User request: %s",
		cfg.suffix,
		userDescSection,
		schemaDesc,
		pctx.UserMessage,
	)

	temp := cfg.temperature
	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
		Temperature: &temp,
	}

	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		return candidateResult{index: idx, err: fmt.Errorf("LLM candidate %d failed: %w", idx, err)}
	}

	if len(resp.Choices) == 0 {
		return candidateResult{index: idx, err: fmt.Errorf("LLM candidate %d returned no choices", idx)}
	}

	sql := strings.TrimSpace(resp.Choices[0].Message.Content)
	sql = stripThinkingTags(sql)
	sql = stripCodeFences(sql)
	sql = strings.TrimRight(sql, "; \n\t")
	sql = strings.TrimSpace(sql)

	if sql == "" {
		return candidateResult{index: idx, err: fmt.Errorf("LLM candidate %d returned empty SQL", idx)}
	}

	return candidateResult{
		index:            idx,
		sql:              sql,
		promptTokens:     resp.Usage.PromptTokens,
		completionTokens: resp.Usage.CompletionTokens,
		model:            resp.Model,
	}
}
