package quota

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/subscription"
)

const (
	// DefaultBudgetFallbackModel is the model used when a premium request
	// must be downgraded to budget tier.
	DefaultBudgetFallbackModel = "qwen/qwen3-coder"

	// UsdToRUB is a fixed conversion rate used for balance cost calculations.
	UsdToRUB = 90.0
)

// QuotaCheckResult tells the caller what to do with the incoming request.
type QuotaCheckResult struct {
	Allowed          bool    // whether the request can proceed
	UseBalance       bool    // if true, charge from balance instead of quota
	FallbackModelID  string  // non-empty means must use this model instead
	RemainingBudget  int64   // tokens left in budget quota
	RemainingPremium int64   // tokens left in premium quota
	Balance          float64 // current balance in RUB
	Reason           string  // human-readable reason if not allowed
}

// UsageInfo provides current usage data for the dashboard.
type UsageInfo struct {
	BudgetTokensUsed   int64     `json:"budget_tokens_used"`
	BudgetTokensLimit  int64     `json:"budget_tokens_limit"`
	PremiumTokensUsed  int64     `json:"premium_tokens_used"`
	PremiumTokensLimit int64     `json:"premium_tokens_limit"`
	PeriodStart        time.Time `json:"period_start"`
	PeriodEnd          time.Time `json:"period_end"`
	Balance            float64   `json:"balance"`
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

// quotaPeriod represents a row in the token_quotas table.
type quotaPeriod struct {
	ID               string
	UserID           string
	PeriodStart      time.Time
	PeriodEnd        time.Time
	BudgetTokensUsed int64
	PremiumTokensUsed int64
}

// Service handles quota checking and token deduction.
type Service struct {
	db     *pgxpool.Pool
	logger *zap.Logger
}

// NewService creates a new quota Service.
func NewService(db *pgxpool.Pool, logger *zap.Logger) *Service {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Service{db: db, logger: logger}
}

// CheckQuota checks if a user can make a request with the given model tier.
//
// Logic:
//  1. Get user plan and balance from the database.
//  2. Get or create the current quota period (daily for Free/Trial, monthly for Pro/ProPlus).
//  3. Determine the action using pure logic (see determineQuotaAction).
func (s *Service) CheckQuota(ctx context.Context, userID string, modelTier string, estimatedTokens int) (*QuotaCheckResult, error) {
	// 1. Get user plan and balance.
	var planStr string
	var balance float64
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(u.plan, 'free'), COALESCE(u.balance, 0)
		 FROM users u WHERE u.id = $1`, userID).Scan(&planStr, &balance)
	if err != nil {
		return nil, fmt.Errorf("quota: fetch user plan: %w", err)
	}

	plan := subscription.Plan(planStr)
	quotaLimits := subscription.QuotaLimitsForPlan(plan)

	// 2. Get or create current quota period.
	period, err := s.getOrCreateQuotaPeriod(ctx, userID, plan)
	if err != nil {
		return nil, fmt.Errorf("quota: get period: %w", err)
	}

	// 3. Determine action.
	result := determineQuotaAction(
		plan, modelTier,
		period.BudgetTokensUsed, quotaLimits.BudgetTokensLimit,
		period.PremiumTokensUsed, quotaLimits.PremiumTokensLimit,
		balance, quotaLimits.BalanceEnabled,
	)
	result.Balance = balance
	return result, nil
}

// DeductTokens records token usage and deducts from quota or balance.
// Called AFTER a successful LLM call with actual token counts.
func (s *Service) DeductTokens(ctx context.Context, userID string, modelID string, modelTier string, inputTokens int, outputTokens int) error {
	totalTokens := inputTokens + outputTokens

	// Get user plan for markup rate.
	var planStr string
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(plan, 'free') FROM users WHERE id = $1`, userID).Scan(&planStr)
	if err != nil {
		return fmt.Errorf("quota: deduct fetch plan: %w", err)
	}

	plan := subscription.Plan(planStr)
	quotaLimits := subscription.QuotaLimitsForPlan(plan)

	// Get current period.
	period, err := s.getOrCreateQuotaPeriod(ctx, userID, plan)
	if err != nil {
		return fmt.Errorf("quota: deduct get period: %w", err)
	}

	// Begin transaction for atomic update.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("quota: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Determine which column to update and whether we are over quota.
	var column string
	var currentUsed, limit int64
	if modelTier == "premium" {
		column = "premium_tokens_used"
		currentUsed = period.PremiumTokensUsed
		limit = quotaLimits.PremiumTokensLimit
	} else {
		column = "budget_tokens_used"
		currentUsed = period.BudgetTokensUsed
		limit = quotaLimits.BudgetTokensLimit
	}

	// Update token_quotas.
	_, err = tx.Exec(ctx,
		fmt.Sprintf(`UPDATE token_quotas SET %s = %s + $1 WHERE id = $2`, column, column),
		totalTokens, period.ID,
	)
	if err != nil {
		return fmt.Errorf("quota: update tokens: %w", err)
	}

	// If over quota, charge from balance.
	overQuotaTokens := (currentUsed + int64(totalTokens)) - limit
	if overQuotaTokens > 0 && quotaLimits.BalanceEnabled {
		// Only charge for the tokens that exceed the quota.
		chargeableInput := inputTokens
		chargeableOutput := outputTokens
		if overQuotaTokens < int64(totalTokens) {
			// Partial overage: approximate proportional split.
			ratio := float64(overQuotaTokens) / float64(totalTokens)
			chargeableInput = int(float64(inputTokens) * ratio)
			chargeableOutput = int(float64(outputTokens) * ratio)
		}

		costRUB := calculateCostRUB(modelID, chargeableInput, chargeableOutput, quotaLimits.BalanceMarkupPct)
		if costRUB > 0 {
			// Deduct from balance using SELECT ... FOR UPDATE to prevent races.
			var currentBalance float64
			err = tx.QueryRow(ctx,
				`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&currentBalance)
			if err != nil {
				return fmt.Errorf("quota: lock balance: %w", err)
			}

			newBalance := currentBalance - costRUB
			if newBalance < 0 {
				newBalance = 0
			}

			_, err = tx.Exec(ctx,
				`UPDATE users SET balance = $1 WHERE id = $2`, newBalance, userID)
			if err != nil {
				return fmt.Errorf("quota: update balance: %w", err)
			}

			// Record balance transaction.
			_, err = tx.Exec(ctx,
				`INSERT INTO balance_transactions (id, user_id, amount, type, description)
				 VALUES (gen_random_uuid(), $1, $2, 'deduction', $3)`,
				userID, -costRUB,
				fmt.Sprintf("Token usage: %s, %d input + %d output tokens", modelID, chargeableInput, chargeableOutput),
			)
			if err != nil {
				s.logger.Warn("failed to record balance transaction", zap.Error(err))
				// Non-fatal: continue with commit.
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("quota: commit tx: %w", err)
	}

	return nil
}

// GetUsage returns current usage info for the user dashboard.
func (s *Service) GetUsage(ctx context.Context, userID string) (*UsageInfo, error) {
	var planStr string
	var balance float64
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(plan, 'free'), COALESCE(balance, 0)
		 FROM users WHERE id = $1`, userID).Scan(&planStr, &balance)
	if err != nil {
		return nil, fmt.Errorf("quota: usage fetch plan: %w", err)
	}

	plan := subscription.Plan(planStr)
	quotaLimits := subscription.QuotaLimitsForPlan(plan)

	period, err := s.getOrCreateQuotaPeriod(ctx, userID, plan)
	if err != nil {
		return nil, fmt.Errorf("quota: usage get period: %w", err)
	}

	return &UsageInfo{
		BudgetTokensUsed:   period.BudgetTokensUsed,
		BudgetTokensLimit:  quotaLimits.BudgetTokensLimit,
		PremiumTokensUsed:  period.PremiumTokensUsed,
		PremiumTokensLimit: quotaLimits.PremiumTokensLimit,
		PeriodStart:        period.PeriodStart,
		PeriodEnd:          period.PeriodEnd,
		Balance:            balance,
	}, nil
}

// GetUsageHistory returns paginated token usage history with aggregate statistics.
// Queries the token_usage table for the given user. Returns the page of records,
// aggregate stats, total count, and any error.
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

	// Get total count.
	var total int
	err := s.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM token_usage WHERE user_id = $1`, userID,
	).Scan(&total)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("quota: count usage records for user %s: %w", userID, err)
	}

	if total == 0 {
		return []UsageRecord{}, &UsageStats{}, 0, nil
	}

	// Get aggregate stats.
	var stats UsageStats
	err = s.db.QueryRow(ctx,
		`SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_usd), 0)
		 FROM token_usage WHERE user_id = $1`, userID,
	).Scan(&stats.TotalRequests, &stats.TotalTokens, &stats.TotalCostUSD)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("quota: stats for user %s: %w", userID, err)
	}

	// Calculate averages (avoid division by zero).
	if stats.TotalRequests > 0 {
		stats.AvgTokensPerReq = stats.TotalTokens / int64(stats.TotalRequests)
		stats.AvgCostPerReqUSD = stats.TotalCostUSD / float64(stats.TotalRequests)
	}

	// Fetch page.
	rows, err := s.db.Query(ctx,
		`SELECT id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, action, created_at
		   FROM token_usage
		  WHERE user_id = $1
		  ORDER BY created_at DESC
		  LIMIT $2 OFFSET $3`,
		userID, limit, offset,
	)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("quota: query usage records for user %s: %w", userID, err)
	}
	defer rows.Close()

	var records []UsageRecord
	for rows.Next() {
		var r UsageRecord
		if err := rows.Scan(
			&r.ID, &r.Model, &r.PromptTokens, &r.CompletionTokens,
			&r.TotalTokens, &r.CostUSD, &r.Action, &r.CreatedAt,
		); err != nil {
			return nil, nil, 0, fmt.Errorf("quota: scan usage record row: %w", err)
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, 0, fmt.Errorf("quota: iterate usage record rows: %w", err)
	}

	return records, &stats, total, nil
}

// getOrCreateQuotaPeriod finds the current active quota period or creates one.
// For daily plans: period is the current UTC day.
// For monthly plans: period is a 30-day window from subscription start.
func (s *Service) getOrCreateQuotaPeriod(ctx context.Context, userID string, plan subscription.Plan) (*quotaPeriod, error) {
	quotaLimits := subscription.QuotaLimitsForPlan(plan)
	now := time.Now().UTC()

	var periodStart, periodEnd time.Time
	if quotaLimits.PeriodType == "daily" {
		periodStart = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		periodEnd = periodStart.Add(24 * time.Hour)
	} else {
		// Monthly: 30-day periods. Find the current window.
		// Look for the user's subscription start date, default to start of current month.
		var subStart time.Time
		err := s.db.QueryRow(ctx,
			`SELECT COALESCE(created_at, NOW())
			 FROM users WHERE id = $1`, userID).Scan(&subStart)
		if err != nil {
			// Fallback to start of current month.
			subStart = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		}

		// Calculate which 30-day period we are in.
		daysSinceStart := int(now.Sub(subStart).Hours() / 24)
		periodIndex := daysSinceStart / 30
		periodStart = subStart.Add(time.Duration(periodIndex*30*24) * time.Hour)
		periodEnd = periodStart.Add(30 * 24 * time.Hour)
	}

	// Try to find an existing period.
	var p quotaPeriod
	err := s.db.QueryRow(ctx,
		`SELECT id, user_id, period_start, period_end, budget_tokens_used, premium_tokens_used
		 FROM token_quotas
		 WHERE user_id = $1 AND period_start = $2 AND period_end = $3`,
		userID, periodStart, periodEnd,
	).Scan(&p.ID, &p.UserID, &p.PeriodStart, &p.PeriodEnd, &p.BudgetTokensUsed, &p.PremiumTokensUsed)

	if err == nil {
		return &p, nil
	}

	// Create a new period.
	err = s.db.QueryRow(ctx,
		`INSERT INTO token_quotas (id, user_id, period_start, period_end, budget_tokens_used, premium_tokens_used)
		 VALUES (gen_random_uuid(), $1, $2, $3, 0, 0)
		 ON CONFLICT (user_id, period_start) DO UPDATE SET period_end = EXCLUDED.period_end
		 RETURNING id, user_id, period_start, period_end, budget_tokens_used, premium_tokens_used`,
		userID, periodStart, periodEnd,
	).Scan(&p.ID, &p.UserID, &p.PeriodStart, &p.PeriodEnd, &p.BudgetTokensUsed, &p.PremiumTokensUsed)

	if err != nil {
		// Race condition: another goroutine inserted the row first. Re-fetch.
		err = s.db.QueryRow(ctx,
			`SELECT id, user_id, period_start, period_end, budget_tokens_used, premium_tokens_used
			 FROM token_quotas
			 WHERE user_id = $1 AND period_start = $2 AND period_end = $3`,
			userID, periodStart, periodEnd,
		).Scan(&p.ID, &p.UserID, &p.PeriodStart, &p.PeriodEnd, &p.BudgetTokensUsed, &p.PremiumTokensUsed)
		if err != nil {
			return nil, fmt.Errorf("quota: re-fetch period: %w", err)
		}
	}

	return &p, nil
}

// determineQuotaAction is the pure decision logic extracted for testability.
// It takes all relevant state and returns the quota check result.
func determineQuotaAction(
	plan subscription.Plan,
	modelTier string,
	budgetUsed, budgetLimit int64,
	premiumUsed, premiumLimit int64,
	balance float64,
	balanceEnabled bool,
) *QuotaCheckResult {
	result := &QuotaCheckResult{
		RemainingBudget:  max64(budgetLimit-budgetUsed, 0),
		RemainingPremium: max64(premiumLimit-premiumUsed, 0),
		Balance:          balance,
	}

	if modelTier == "premium" {
		// Check if the plan has any premium quota at all.
		if premiumLimit <= 0 {
			// No premium access for this plan. Fallback to budget.
			result.Allowed = false
			result.FallbackModelID = DefaultBudgetFallbackModel
			result.Reason = "Premium models are not available on your plan"
			return result
		}

		// Premium quota still available.
		if premiumUsed < premiumLimit {
			result.Allowed = true
			return result
		}

		// Premium quota exhausted. Try balance.
		if balanceEnabled && balance > 0 {
			result.Allowed = true
			result.UseBalance = true
			return result
		}

		// No balance available. Try fallback to budget model if budget quota remains.
		if budgetUsed < budgetLimit {
			result.Allowed = false
			result.FallbackModelID = DefaultBudgetFallbackModel
			result.Reason = "Premium quota exhausted"
			return result
		}

		// Both premium and budget quotas exhausted, no balance.
		result.Allowed = false
		result.Reason = "All quotas exhausted"
		return result
	}

	// Budget tier model.
	if budgetUsed < budgetLimit {
		result.Allowed = true
		return result
	}

	// Budget quota exhausted. Try balance.
	if balanceEnabled && balance > 0 {
		result.Allowed = true
		result.UseBalance = true
		return result
	}

	result.Allowed = false
	result.Reason = "Budget quota exhausted"
	return result
}

// calculateCostRUB calculates the cost in RUB for given tokens on a model, with markup.
// Formula: (inputTokens * inputPricePerToken + outputTokens * outputPricePerToken) * USD_TO_RUB * (1 + markup/100)
// Returns 0 if the model is unknown.
func calculateCostRUB(modelID string, inputTokens, outputTokens int, markupPct int) float64 {
	model := findModel(modelID)
	if model == nil {
		return 0
	}

	inputPricePerToken := model.InputPricePerM / 1_000_000.0
	outputPricePerToken := model.OutputPricePerM / 1_000_000.0

	costUSD := float64(inputTokens)*inputPricePerToken + float64(outputTokens)*outputPricePerToken
	costRUB := costUSD * UsdToRUB

	if markupPct > 0 {
		costRUB *= 1.0 + float64(markupPct)/100.0
	}

	return costRUB
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

// max64 returns the greater of two int64 values.
func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
