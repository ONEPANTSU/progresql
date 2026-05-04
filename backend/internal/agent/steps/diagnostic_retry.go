package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/security"
	"github.com/onepantsu/progressql/backend/internal/tools"
)

// DefaultMaxRetries is the default number of retry attempts per candidate.
const DefaultMaxRetries = 2

// DiagnosticRetryStep is step 3 of the generate_sql pipeline.
// For each SQL candidate it calls explain_query tool to validate the SQL.
// If EXPLAIN fails, it retries SQL generation with the error context up to MaxRetries times.
// Candidates that remain invalid after all retries are discarded.
type DiagnosticRetryStep struct {
	// MaxRetries is the maximum number of retry attempts per candidate.
	// If zero, DefaultMaxRetries is used.
	MaxRetries int
}

func (s *DiagnosticRetryStep) Name() string { return "diagnostic_retry" }

func (s *DiagnosticRetryStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	val, ok := pctx.Get(ContextKeySQLCandidates)
	if !ok {
		return fmt.Errorf("sql_candidates not found: parallel_sql_generation step must run first")
	}
	candidates, ok := val.([]string)
	if !ok {
		return fmt.Errorf("sql_candidates has unexpected type")
	}

	if len(candidates) == 0 {
		return fmt.Errorf("no SQL candidates to validate")
	}

	candidates, blockedCandidates := filterSecurityBlockedCandidates(pctx, candidates)
	if len(blockedCandidates) > 0 {
		pctx.Logger.Info("diagnostic_retry removed security-blocked candidates",
			zap.String("security_mode", pctx.SecurityMode),
			zap.Int("blocked", len(blockedCandidates)),
			zap.Int("remaining", len(candidates)),
		)
	}
	if len(candidates) == 0 {
		pctx.Set(ContextKeySQLCandidates, []string{})
		pctx.Result.Candidates = blockedCandidates
		pctx.Result.SecurityBlocked = true
		pctx.Result.Explanation = "SQL candidates were blocked by the current security mode."
		return nil
	}

	// In execute mode, skip EXPLAIN validation entirely — DDL statements
	// (CREATE TABLE, CREATE SCHEMA, etc.) cannot be EXPLAINed and would
	// incorrectly fail validation. Execute mode trusts the generated SQL.
	if pctx.SecurityMode == agent.SecurityModeExecute {
		pctx.Logger.Info("diagnostic_retry skipped: execute mode enabled")
		pctx.Set(ContextKeySQLCandidates, candidates)
		pctx.Set(ContextKeySQLCandidate, candidates[0])
		pctx.Result.SQL = candidates[0]
		pctx.Result.Candidates = candidates
		return nil
	}

	maxRetries := s.MaxRetries
	if maxRetries <= 0 {
		maxRetries = DefaultMaxRetries
	}

	// Read schema context for retry generation prompts.
	var schemaDesc string
	if scVal, ok := pctx.Get(ContextKeySchemaContext); ok {
		if sc, ok := scVal.(*SchemaContext); ok {
			schemaDesc = buildSchemaDescription(sc)
		}
	}

	model := pctx.Model
	schemaCtx := getSchemaContext(pctx)

	pctx.Logger.Info("starting diagnostic retry",
		zap.Int("candidates", len(candidates)),
		zap.Int("max_retries", maxRetries),
	)

	var validated []string

	for i, sql := range candidates {
		validSQL, err := s.validateCandidate(ctx, pctx, sql, i, maxRetries, model, schemaDesc, schemaCtx)
		if err != nil {
			pctx.Logger.Warn("candidate discarded after retries",
				zap.Int("candidate_index", i),
				zap.Error(err),
			)
			continue
		}
		validated = append(validated, validSQL)
	}

	pctx.Logger.Info("diagnostic retry completed",
		zap.Int("validated", len(validated)),
		zap.Int("total", len(candidates)),
	)

	if len(validated) == 0 {
		// All candidates failed EXPLAIN validation. Instead of failing the pipeline,
		// keep the first candidate SQL with the validation error so the user can see it.
		bestSQL := candidates[0]
		var bestError string

		explainArgs, _ := json.Marshal(tools.ExplainQueryArgs{SQL: bestSQL})
		result, err := pctx.DispatchTool(tools.ToolExplainQuery, explainArgs)
		if err != nil {
			bestError = err.Error()
		} else if !result.Success {
			bestError = result.Error
		}
		if bestError == "" {
			bestError = "SQL validation failed after retries"
		}

		fields := append(sqlLogFields(bestSQL), zap.String("last_error", bestError))
		pctx.Logger.Warn("all candidates failed EXPLAIN, sending best-effort SQL with error", fields...)
		pctx.Set(ContextKeySQLCandidates, []string{bestSQL})
		pctx.Set(ContextKeySQLCandidate, bestSQL)
		pctx.Result.SQL = bestSQL
		pctx.Result.Candidates = []string{bestSQL}
		pctx.Result.ValidationError = bestError
		return nil
	}

	// Update candidates in context.
	pctx.Set(ContextKeySQLCandidates, validated)
	pctx.Set(ContextKeySQLCandidate, validated[0])
	pctx.Result.SQL = validated[0]
	pctx.Result.Candidates = validated

	return nil
}

// validateCandidate runs EXPLAIN on the SQL and retries generation if it fails.
func (s *DiagnosticRetryStep) validateCandidate(
	ctx context.Context,
	pctx *agent.PipelineContext,
	sql string,
	candidateIndex int,
	maxRetries int,
	model string,
	schemaDesc string,
	schemaCtx *SchemaContext,
) (string, error) {
	currentSQL := sql

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			pctx.Logger.Info("retrying candidate",
				zap.Int("candidate_index", candidateIndex),
				zap.Int("attempt", attempt),
			)
		}

		processedSQL, status := postprocessCandidateSQL(currentSQL, schemaCtx)
		if !status.Valid {
			if attempt == maxRetries {
				return "", fmt.Errorf("candidate postprocess failed after %d retries: %s", maxRetries, status.Error)
			}
			newSQL, retryErr := s.regenerateSQL(ctx, pctx, currentSQL, status.Error, model, schemaDesc, candidateIndex)
			if retryErr != nil {
				return "", fmt.Errorf("retry generation failed: %w", retryErr)
			}
			currentSQL = newSQL
			continue
		}
		currentSQL = processedSQL

		// Call explain_query tool.
		explainArgs, _ := json.Marshal(tools.ExplainQueryArgs{SQL: currentSQL})
		result, err := pctx.DispatchTool(tools.ToolExplainQuery, explainArgs)

		if err != nil {
			// Tool dispatch error (e.g., timeout) — treat as validation failure.
			if attempt == maxRetries {
				return "", fmt.Errorf("explain_query dispatch failed after %d retries: %w", maxRetries, err)
			}
			// Retry with generic error context.
			newSQL, retryErr := s.regenerateSQL(ctx, pctx, currentSQL, err.Error(), model, schemaDesc, candidateIndex)
			if retryErr != nil {
				return "", fmt.Errorf("retry generation failed: %w", retryErr)
			}
			currentSQL = newSQL
			continue
		}

		if result.Success {
			// EXPLAIN succeeded — candidate is valid.
			pctx.Logger.Debug("candidate validated via EXPLAIN",
				zap.Int("candidate_index", candidateIndex),
				zap.Int("attempts", attempt+1),
			)
			return currentSQL, nil
		}

		// EXPLAIN returned an error (invalid SQL).
		explainError := result.Error
		pctx.Logger.Info("EXPLAIN failed for candidate",
			zap.Int("candidate_index", candidateIndex),
			zap.String("error", explainError),
			zap.Int("attempt", attempt),
		)

		if attempt == maxRetries {
			return "", fmt.Errorf("EXPLAIN failed after %d retries: %s", maxRetries, explainError)
		}

		// Regenerate SQL with error context.
		newSQL, retryErr := s.regenerateSQL(ctx, pctx, currentSQL, explainError, model, schemaDesc, candidateIndex)
		if retryErr != nil {
			return "", fmt.Errorf("retry generation failed: %w", retryErr)
		}
		currentSQL = newSQL
	}

	// Should not reach here, but just in case.
	return "", fmt.Errorf("validation failed for candidate %d", candidateIndex)
}

func filterSecurityBlockedCandidates(pctx *agent.PipelineContext, candidates []string) ([]string, []string) {
	if pctx.SecurityMode == agent.SecurityModeExecute {
		return candidates, nil
	}
	var safe []string
	var blocked []string
	for _, sql := range candidates {
		if err := security.CheckSQLWithSecurityMode(sql, pctx.SecurityMode); err != nil {
			blocked = append(blocked, sql)
			continue
		}
		safe = append(safe, sql)
	}
	return safe, blocked
}

func getSchemaContext(pctx *agent.PipelineContext) *SchemaContext {
	if scVal, ok := pctx.Get(ContextKeySchemaContext); ok {
		if sc, ok := scVal.(*SchemaContext); ok {
			return sc
		}
	}
	return nil
}

// regenerateSQL asks the LLM to fix the SQL based on the error from EXPLAIN.
func (s *DiagnosticRetryStep) regenerateSQL(
	ctx context.Context,
	pctx *agent.PipelineContext,
	failedSQL string,
	errorMsg string,
	model string,
	schemaDesc string,
	candidateIndex int,
) (string, error) {
	prompt := fmt.Sprintf(
		"You are an expert PostgreSQL developer. The following SQL query failed validation:\n\n"+
			"```sql\n%s\n```\n\n"+
			"Error:\n%s\n\n",
		failedSQL, errorMsg,
	)

	if schemaDesc != "" {
		prompt += fmt.Sprintf("Database schema:\n%s\n\n", schemaDesc)
	}

	prompt += "Fix the SQL query to resolve this error. Return ONLY the corrected SQL query, no explanations or markdown."

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		return "", fmt.Errorf("LLM retry for candidate %d failed: %w", candidateIndex, err)
	}

	pctx.AddTokensDetailed(resp.Usage)
	if resp.Model != "" {
		pctx.ModelUsed = resp.Model
	}

	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("LLM retry returned no choices")
	}

	sql := strings.TrimSpace(resp.Choices[0].Message.Content)
	sql = stripThinkingTags(sql)
	sql = stripCodeFences(sql)
	sql = strings.TrimRight(sql, "; \n\t")
	sql = strings.TrimSpace(sql)

	if sql == "" {
		return "", fmt.Errorf("LLM retry returned empty SQL")
	}

	pctx.Logger.Info("regenerated SQL candidate",
		zap.Int("candidate_index", candidateIndex),
		zap.String("new_sql", sql),
	)

	return sql, nil
}
