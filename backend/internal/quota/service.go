package quota

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/exchange"
	"github.com/onepantsu/progressql/backend/internal/models"
	"github.com/onepantsu/progressql/backend/internal/subscription"
)

// RequestCheckResult tells the caller what to do with the incoming request.
type RequestCheckResult struct {
	Allowed    bool    // whether the request can proceed
	BalanceUSD float64 // current balance in USD
	Reason     string  // human-readable reason if not allowed
}

// UsageInfo provides current billing data for the dashboard.
type UsageInfo struct {
	BalanceUSD         float64   `json:"balance_usd"`
	Plan               string    `json:"plan"`
	CreditsIncludedUSD float64   `json:"credits_included_usd"`
	CreditsUsedUSD     float64   `json:"credits_used_usd"`
	PeriodStart        time.Time `json:"period_start"`
	PeriodEnd          time.Time `json:"period_end"`
	RequestsTotal      int       `json:"requests_total"`
	TokensTotal        int64     `json:"tokens_total"`
	CostUSDTotal       float64   `json:"cost_usd_total"`
}

// UsageRecord represents a single token usage entry.
type UsageRecord struct {
	ID               string    `json:"id"`
	Model            string    `json:"model"`
	PromptTokens     int       `json:"prompt_tokens"`
	CompletionTokens int       `json:"completion_tokens"`
	TotalTokens      int       `json:"total_tokens"`
	CostUSD          float64   `json:"cost_usd"`
	Action           string    `json:"action"`
	CreatedAt        time.Time `json:"created_at"`
}

// UsageStats provides aggregate statistics.
type UsageStats struct {
	TotalRequests    int     `json:"total_requests"`
	TotalTokens      int64   `json:"total_tokens"`
	TotalCostUSD     float64 `json:"total_cost_usd"`
	AvgTokensPerReq  int64   `json:"avg_tokens_per_request"`
	AvgCostPerReqUSD float64 `json:"avg_cost_per_request_usd"`
}

// Service handles billing checks and balance deduction.
type Service struct {
	db        *pgxpool.Pool
	logger    *zap.Logger
	modelsSvc *models.Service
	rateSvc   *exchange.RateService
}

// NewService creates a new quota Service.
func NewService(db *pgxpool.Pool, logger *zap.Logger, modelsSvc *models.Service, rateSvc *exchange.RateService) *Service {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Service{db: db, logger: logger, modelsSvc: modelsSvc, rateSvc: rateSvc}
}

// CheckRequest checks if a user can make a request with the given model tier.
//
// Logic:
//  1. Get user plan from DB.
//  2. Check if model tier is allowed for the plan.
//  3. Check if balance > 0.
func (s *Service) CheckRequest(ctx context.Context, userID string, modelTier string) (*RequestCheckResult, error) {
	var planStr string
	var balance float64
	err := s.db.QueryRow(ctx,
		`SELECT CASE WHEN COALESCE(plan,'free') NOT IN ('free','trial')
		              AND plan_expires_at IS NOT NULL
		              AND plan_expires_at < NOW()
		         THEN 'free' ELSE COALESCE(plan,'free') END,
		        COALESCE(balance, 0)
		 FROM users WHERE id = $1`, userID).Scan(&planStr, &balance)
	if err != nil {
		return nil, fmt.Errorf("quota: fetch user: %w", err)
	}

	plan := subscription.NormalizePlan(subscription.Plan(planStr))
	result := &RequestCheckResult{BalanceUSD: balance}

	// Check model tier access.
	if !subscription.IsModelTierAllowed(plan, modelTier) {
		result.Allowed = false
		result.Reason = "Upgrade to Pro to use premium models"
		return result, nil
	}

	// Check balance.
	if balance <= 0 {
		result.Allowed = false
		result.Reason = "Insufficient balance. Top up to continue."
		return result, nil
	}

	result.Allowed = true
	return result, nil
}

// ChargeRequest deducts the cost of a completed request from the user's balance.
// It first consumes remaining plan credits (credits_included - credits_used_usd)
// before touching the user's topped-up balance.
// Returns the cost in USD that was charged.
func (s *Service) ChargeRequest(ctx context.Context, userID string, modelID string, inputTokens int, outputTokens int) (float64, error) {
	costUSD := s.calculateCostUSD(ctx, modelID, inputTokens, outputTokens)
	if costUSD <= 0 {
		return 0, nil
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("quota: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock and read balance, plan, and credits_used_usd.
	var currentBalance float64
	var creditsUsed float64
	var planStr string
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(balance, 0),
		        COALESCE(credits_used_usd, 0),
		        CASE WHEN COALESCE(plan,'free') NOT IN ('free','trial')
		              AND plan_expires_at IS NOT NULL
		              AND plan_expires_at < NOW()
		         THEN 'free' ELSE COALESCE(plan,'free') END
		 FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&currentBalance, &creditsUsed, &planStr)
	if err != nil {
		return 0, fmt.Errorf("quota: lock balance: %w", err)
	}

	// Determine how much of the cost is covered by remaining plan credits.
	plan := subscription.NormalizePlan(subscription.Plan(planStr))
	limits := subscription.LimitsForPlan(plan)
	var creditsIncluded float64
	if limits.MonthlyCreditsUSD > 0 {
		creditsIncluded = limits.MonthlyCreditsUSD
	} else {
		creditsIncluded = limits.DailyCreditsUSD
	}

	creditsRemaining := creditsIncluded - creditsUsed
	if creditsRemaining < 0 {
		creditsRemaining = 0
	}

	// Split the charge: credits absorb first, then topped-up balance.
	coveredByCredits := costUSD
	if coveredByCredits > creditsRemaining {
		coveredByCredits = creditsRemaining
	}
	coveredByBalance := costUSD - coveredByCredits

	newBalance := currentBalance - coveredByBalance
	if newBalance < 0 {
		newBalance = 0
	}

	_, err = tx.Exec(ctx,
		`UPDATE users SET balance = $1, credits_used_usd = credits_used_usd + $2 WHERE id = $3`,
		newBalance, costUSD, userID)
	if err != nil {
		return 0, fmt.Errorf("quota: update balance: %w", err)
	}

	// Record balance transaction (only if real balance was touched).
	_, _ = tx.Exec(ctx, "SAVEPOINT bt_insert")
	txType := "model_charge"
	chargeAmount := -costUSD
	if coveredByBalance > 0 {
		chargeAmount = -coveredByBalance
	} else {
		chargeAmount = 0 // fully covered by credits — no balance change
	}
	_, btErr := tx.Exec(ctx,
		`INSERT INTO balance_transactions (id, user_id, amount, balance_after, tx_type, model_id, tokens_input, tokens_output, description)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
		userID, chargeAmount, newBalance, txType, modelID, inputTokens, outputTokens,
		fmt.Sprintf("AI request: %s, %d in + %d out tokens", modelID, inputTokens, outputTokens),
	)
	if btErr != nil {
		s.logger.Warn("failed to record balance transaction", zap.Error(btErr))
		_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT bt_insert")
	} else {
		_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT bt_insert")
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("quota: commit tx: %w", err)
	}

	return costUSD, nil
}

// GetUsage returns current billing info for the user dashboard.
func (s *Service) GetUsage(ctx context.Context, userID string) (*UsageInfo, error) {
	var planStr string
	var balance, creditsUsed float64
	var periodStart, periodEnd *time.Time
	err := s.db.QueryRow(ctx,
		`SELECT CASE WHEN COALESCE(plan,'free') NOT IN ('free','trial')
		              AND plan_expires_at IS NOT NULL
		              AND plan_expires_at < NOW()
		         THEN 'free' ELSE COALESCE(plan,'free') END,
		        COALESCE(balance, 0),
		        COALESCE(credits_used_usd, 0),
		        credits_period_start,
		        credits_period_end
		 FROM users WHERE id = $1`, userID).Scan(&planStr, &balance, &creditsUsed, &periodStart, &periodEnd)
	if err != nil {
		return nil, fmt.Errorf("quota: usage fetch: %w", err)
	}

	plan := subscription.NormalizePlan(subscription.Plan(planStr))
	limits := subscription.LimitsForPlan(plan)

	// Determine included credits.
	var creditsIncluded float64
	if limits.MonthlyCreditsUSD > 0 {
		creditsIncluded = limits.MonthlyCreditsUSD
	} else {
		creditsIncluded = limits.DailyCreditsUSD
	}

	// Set default period if not set.
	now := time.Now().UTC()
	pStart := now
	pEnd := now
	if periodStart != nil {
		pStart = *periodStart
	}
	if periodEnd != nil {
		pEnd = *periodEnd
	}

	// Get aggregate stats for current period.
	var reqTotal int
	var tokensTotal int64
	var costTotal float64
	_ = s.db.QueryRow(ctx,
		`SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_usd), 0)
		 FROM token_usage
		 WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
		userID, pStart, pEnd).Scan(&reqTotal, &tokensTotal, &costTotal)

	return &UsageInfo{
		BalanceUSD:         balance,
		Plan:               string(plan),
		CreditsIncludedUSD: creditsIncluded,
		CreditsUsedUSD:     creditsUsed,
		PeriodStart:        pStart,
		PeriodEnd:          pEnd,
		RequestsTotal:      reqTotal,
		TokensTotal:        tokensTotal,
		CostUSDTotal:       costTotal,
	}, nil
}

// GetUsageHistory returns paginated token usage history with aggregate statistics.
func (s *Service) GetUsageHistory(ctx context.Context, userID string, limit, offset int) ([]UsageRecord, *UsageStats, int, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	var total int
	err := s.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM token_usage WHERE user_id = $1`, userID,
	).Scan(&total)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("quota: count usage: %w", err)
	}

	if total == 0 {
		return []UsageRecord{}, &UsageStats{}, 0, nil
	}

	var stats UsageStats
	err = s.db.QueryRow(ctx,
		`SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_usd), 0)
		 FROM token_usage WHERE user_id = $1`, userID,
	).Scan(&stats.TotalRequests, &stats.TotalTokens, &stats.TotalCostUSD)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("quota: stats: %w", err)
	}

	if stats.TotalRequests > 0 {
		stats.AvgTokensPerReq = stats.TotalTokens / int64(stats.TotalRequests)
		stats.AvgCostPerReqUSD = stats.TotalCostUSD / float64(stats.TotalRequests)
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, action, created_at
		   FROM token_usage
		  WHERE user_id = $1
		  ORDER BY created_at DESC
		  LIMIT $2 OFFSET $3`,
		userID, limit, offset,
	)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("quota: query usage: %w", err)
	}
	defer rows.Close()

	var records []UsageRecord
	for rows.Next() {
		var r UsageRecord
		if err := rows.Scan(
			&r.ID, &r.Model, &r.PromptTokens, &r.CompletionTokens,
			&r.TotalTokens, &r.CostUSD, &r.Action, &r.CreatedAt,
		); err != nil {
			return nil, nil, 0, fmt.Errorf("quota: scan row: %w", err)
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, 0, fmt.Errorf("quota: iterate rows: %w", err)
	}

	return records, &stats, total, nil
}

// calculateCostUSD calculates the cost in USD for given tokens on a model.
func (s *Service) calculateCostUSD(ctx context.Context, modelID string, inputTokens, outputTokens int) float64 {
	var inputPricePerM, outputPricePerM float64

	if s.modelsSvc != nil {
		m := s.modelsSvc.FindByID(ctx, modelID)
		if m != nil {
			inputPricePerM = m.InputPricePerM
			outputPricePerM = m.OutputPricePerM
		}
	}

	if inputPricePerM == 0 && outputPricePerM == 0 {
		cm := findModel(modelID)
		if cm == nil {
			return 0
		}
		inputPricePerM = cm.InputPricePerM
		outputPricePerM = cm.OutputPricePerM
	}

	return float64(inputTokens)*inputPricePerM/1_000_000.0 + float64(outputTokens)*outputPricePerM/1_000_000.0
}

// findModel looks up a model by ID from the default model list.
func findModel(modelID string) *config.ModelInfo {
	for _, m := range config.DefaultModels() {
		if m.ID == modelID {
			return &m
		}
	}
	return nil
}
