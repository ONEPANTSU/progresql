package billing

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/balance"
	"github.com/onepantsu/progressql/backend/internal/metrics"
	"github.com/onepantsu/progressql/backend/internal/subscription"
)

// Creditor handles periodic credit operations:
// - Daily: expire Free users' credits and grant new daily credits ($0.03)
// - On subscription renewal: grant monthly Pro credits ($15)
type Creditor struct {
	db         *pgxpool.Pool
	balanceSvc *balance.Service
	logger     *zap.Logger
	stopCh     chan struct{}
}

// NewCreditor creates a new billing Creditor.
func NewCreditor(db *pgxpool.Pool, balanceSvc *balance.Service, logger *zap.Logger) *Creditor {
	return &Creditor{
		db:         db,
		balanceSvc: balanceSvc,
		logger:     logger,
		stopCh:     make(chan struct{}),
	}
}

// Start begins the daily credit ticker. It runs once immediately on startup
// (to handle missed runs) and then every hour, executing the daily job at 00:xx UTC.
func (c *Creditor) Start() {
	go c.loop()
}

// Stop gracefully stops the creditor loop.
func (c *Creditor) Stop() {
	close(c.stopCh)
}

func (c *Creditor) loop() {
	// Run immediately on startup.
	c.runDailyIfNeeded()

	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.runDailyIfNeeded()
		}
	}
}

// runDailyIfNeeded checks if the daily job should run (once per UTC day).
// Uses a lightweight check: only runs if the current UTC hour is 0 (midnight),
// or if Free users have no credits_period_start set for today.
func (c *Creditor) runDailyIfNeeded() {
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	c.processFreeUsers(today)
	c.processProRenewals(now)
}

// processFreeUsers expires yesterday's daily credits and grants new ones.
func (c *Creditor) processFreeUsers(today time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	limits := subscription.LimitsForPlan(subscription.PlanFree)
	dailyCredits := limits.DailyCreditsUSD

	// Find Free users whose credits_period_start is not today (need refresh).
	rows, err := c.db.Query(ctx,
		`SELECT id FROM users
		 WHERE COALESCE(plan, 'free') IN ('free', 'trial')
		   AND (credits_period_start IS NULL OR credits_period_start < $1)`,
		today)
	if err != nil {
		c.logger.Error("creditor: query free users failed", zap.Error(err))
		return
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			continue
		}
		userIDs = append(userIDs, id)
	}

	for _, uid := range userIDs {
		// Expire old daily credits.
		if err := c.balanceSvc.ExpireDailyCredits(ctx, uid, dailyCredits); err != nil {
			c.logger.Warn("creditor: expire daily credits failed",
				zap.String("user_id", uid), zap.Error(err))
		} else {
			metrics.CreditsExpiredTotal.WithLabelValues("free").Add(dailyCredits)
		}

		// Grant new daily credits.
		if err := c.balanceSvc.CreditSubscription(ctx, uid, dailyCredits,
			fmt.Sprintf("Daily free credits: $%.2f", dailyCredits)); err != nil {
			c.logger.Warn("creditor: grant daily credits failed",
				zap.String("user_id", uid), zap.Error(err))
			continue
		}
		metrics.CreditsGrantedTotal.WithLabelValues("free", "daily").Add(dailyCredits)

		// Update period markers.
		tomorrow := today.Add(24 * time.Hour)
		_, err := c.db.Exec(ctx,
			`UPDATE users SET credits_period_start = $1, credits_period_end = $2 WHERE id = $3`,
			today, tomorrow, uid)
		if err != nil {
			c.logger.Warn("creditor: update free period failed",
				zap.String("user_id", uid), zap.Error(err))
		}
	}

	if len(userIDs) > 0 {
		c.logger.Info("creditor: processed free users",
			zap.Int("count", len(userIDs)),
			zap.Float64("daily_credits", dailyCredits))
	}
}

// processProRenewals grants monthly credits to Pro users whose credit period has ended.
func (c *Creditor) processProRenewals(now time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Process both pro and pro_yearly users.
	for _, plan := range []subscription.Plan{subscription.PlanPro, subscription.PlanProYearly} {
		limits := subscription.LimitsForPlan(plan)
		monthlyCredits := limits.MonthlyCreditsUSD
		planStr := string(plan)

		rows, err := c.db.Query(ctx,
			`SELECT id FROM users
			 WHERE plan = $1
			   AND plan_expires_at > NOW()
			   AND (credits_period_end IS NULL OR credits_period_end <= $2)`,
			planStr, now)
		if err != nil {
			c.logger.Error("creditor: query pro users failed",
				zap.String("plan", planStr), zap.Error(err))
			continue
		}

		var userIDs []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				continue
			}
			userIDs = append(userIDs, id)
		}
		rows.Close()

		for _, uid := range userIDs {
			// No rollover: expire unused credits from the previous period before
			// granting new ones.
			if err := c.balanceSvc.ExpireDailyCredits(ctx, uid, monthlyCredits); err != nil {
				c.logger.Warn("creditor: expire pro credits failed",
					zap.String("user_id", uid), zap.Error(err))
			} else {
				metrics.CreditsExpiredTotal.WithLabelValues(planStr).Add(monthlyCredits)
			}

			if err := c.balanceSvc.CreditSubscription(ctx, uid, monthlyCredits,
				fmt.Sprintf("Pro monthly credits: $%.2f", monthlyCredits)); err != nil {
				c.logger.Warn("creditor: grant monthly credits failed",
					zap.String("user_id", uid), zap.Error(err))
				continue
			}
			metrics.CreditsGrantedTotal.WithLabelValues(planStr, "monthly").Add(monthlyCredits)

			// Set next period: 30 days from now.
			periodStart := now
			periodEnd := now.Add(30 * 24 * time.Hour)
			_, err := c.db.Exec(ctx,
				`UPDATE users SET credits_period_start = $1, credits_period_end = $2 WHERE id = $3`,
				periodStart, periodEnd, uid)
			if err != nil {
				c.logger.Warn("creditor: update pro period failed",
					zap.String("user_id", uid), zap.Error(err))
			}
		}

		if len(userIDs) > 0 {
			c.logger.Info("creditor: processed pro renewals",
				zap.String("plan", planStr),
				zap.Int("count", len(userIDs)),
				zap.Float64("monthly_credits", monthlyCredits))
		}
	}
}
