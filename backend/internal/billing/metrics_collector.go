package billing

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/metrics"
)

// MetricsCollector periodically queries the database to update Prometheus
// gauges for active users and total platform balance.
type MetricsCollector struct {
	db     *pgxpool.Pool
	logger *zap.Logger
	stopCh chan struct{}
}

// NewMetricsCollector creates a new MetricsCollector.
func NewMetricsCollector(db *pgxpool.Pool, logger *zap.Logger) *MetricsCollector {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &MetricsCollector{
		db:     db,
		logger: logger,
		stopCh: make(chan struct{}),
	}
}

// Start begins periodic collection. Runs immediately and then every minute.
func (c *MetricsCollector) Start() {
	go c.loop()
}

// Stop signals the collector to exit.
func (c *MetricsCollector) Stop() {
	close(c.stopCh)
}

func (c *MetricsCollector) loop() {
	c.collect()

	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.collect()
		}
	}
}

func (c *MetricsCollector) collect() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Active users by plan.
	rows, err := c.db.Query(ctx,
		`SELECT
			CASE
				WHEN COALESCE(plan, 'free') IN ('free', 'trial') THEN 'free'
				WHEN plan = 'pro_yearly' AND plan_expires_at > NOW() THEN 'pro_yearly'
				WHEN plan = 'pro' AND plan_expires_at > NOW() THEN 'pro'
				ELSE 'free'
			END AS effective_plan,
			COUNT(*) AS cnt
		 FROM users
		 GROUP BY effective_plan`)
	if err != nil {
		c.logger.Warn("metrics_collector: active users query failed", zap.Error(err))
	} else {
		// Reset to zero first to handle plans with no users.
		metrics.ActiveUsersGauge.WithLabelValues("free").Set(0)
		metrics.ActiveUsersGauge.WithLabelValues("pro").Set(0)
		metrics.ActiveUsersGauge.WithLabelValues("pro_yearly").Set(0)

		for rows.Next() {
			var plan string
			var count float64
			if err := rows.Scan(&plan, &count); err != nil {
				continue
			}
			metrics.ActiveUsersGauge.WithLabelValues(plan).Set(count)
		}
		rows.Close()
	}

	// Total platform balance.
	var totalBalance float64
	err = c.db.QueryRow(ctx,
		`SELECT COALESCE(SUM(balance), 0) FROM users`).Scan(&totalBalance)
	if err != nil {
		c.logger.Warn("metrics_collector: total balance query failed", zap.Error(err))
	} else {
		metrics.TotalBalanceUSD.Set(totalBalance)
	}
}
