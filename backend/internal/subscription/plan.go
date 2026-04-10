package subscription

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Plan represents a subscription tier.
type Plan string

const (
	PlanFree      Plan = "free"
	PlanPro       Plan = "pro"
	PlanProYearly Plan = "pro_yearly"

	// Deprecated aliases — kept for backward compatibility with existing DB rows.
	PlanTrial   Plan = "free"
	PlanProPlus Plan = "pro"
	PlanTeam    Plan = "pro"
)

// PlanLimits defines resource and billing limits for a subscription plan.
type PlanLimits struct {
	MaxRequestsPerMin     int
	MaxSessionsConcurrent int
	MaxTokensPerRequest   int
	AllowedModelTiers     []string // "budget", "premium"
	AutocompleteEnabled   bool
	BalanceMarkupPct      int     // markup % on balance top-ups
	DailyCreditsUSD       float64 // daily free credits (Free plan)
	MonthlyCreditsUSD     float64 // monthly credits (Pro plan)
	CreditsRollover       bool    // whether unused credits carry over
}

// DefaultLimits returns the resource limits for each plan.
// Used as fallback when the DB-backed PlanLimitsStore is unavailable.
var DefaultLimits = map[Plan]PlanLimits{
	PlanFree: {
		MaxRequestsPerMin:     10,
		MaxSessionsConcurrent: 1,
		MaxTokensPerRequest:   16384,
		AllowedModelTiers:     []string{"budget"},
		AutocompleteEnabled:   false,
		BalanceMarkupPct:      30,
		DailyCreditsUSD:       0.03,
		MonthlyCreditsUSD:     0,
		CreditsRollover:       false,
	},
	PlanPro: {
		MaxRequestsPerMin:     60,
		MaxSessionsConcurrent: 5,
		MaxTokensPerRequest:   32768,
		AllowedModelTiers:     []string{"budget", "premium"},
		AutocompleteEnabled:   true,
		BalanceMarkupPct:      20,
		DailyCreditsUSD:       0,
		MonthlyCreditsUSD:     15.0,
		CreditsRollover:       false,
	},
	PlanProYearly: {
		MaxRequestsPerMin:     60,
		MaxSessionsConcurrent: 5,
		MaxTokensPerRequest:   32768,
		AllowedModelTiers:     []string{"budget", "premium"},
		AutocompleteEnabled:   true,
		BalanceMarkupPct:      15,
		DailyCreditsUSD:       0,
		MonthlyCreditsUSD:     15.0,
		CreditsRollover:       false,
	},
}

// ---------------------------------------------------------------------------
// PlanLimitsStore — loads plan limits from DB with in-memory cache.
// ---------------------------------------------------------------------------

// PlanLimitsStore loads plan limits from the plan_limits table and caches them
// in memory, refreshing every 5 minutes. Falls back to DefaultLimits on error.
type PlanLimitsStore struct {
	db     *pgxpool.Pool
	logger *zap.Logger
	cache  map[Plan]PlanLimits
	mu     sync.RWMutex
	stopCh chan struct{}
}

// NewPlanLimitsStore creates a new store. Call Start() to begin background refresh.
func NewPlanLimitsStore(db *pgxpool.Pool, logger *zap.Logger) *PlanLimitsStore {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &PlanLimitsStore{
		db:     db,
		logger: logger,
		cache:  make(map[Plan]PlanLimits),
		stopCh: make(chan struct{}),
	}
}

// Start loads limits immediately and starts a background goroutine that
// refreshes the cache every 5 minutes.
func (s *PlanLimitsStore) Start() {
	s.refresh()
	go s.loop()
}

// Stop signals the background goroutine to exit.
func (s *PlanLimitsStore) Stop() {
	close(s.stopCh)
}

// Get returns the cached limits for a plan. If the plan is not found in the
// cache it falls back to DefaultLimits, and ultimately to PlanFree defaults.
func (s *PlanLimitsStore) Get(plan Plan) PlanLimits {
	s.mu.RLock()
	if lim, ok := s.cache[plan]; ok {
		s.mu.RUnlock()
		return lim
	}
	s.mu.RUnlock()

	// Fallback to hardcoded defaults.
	if lim, ok := DefaultLimits[plan]; ok {
		return lim
	}
	return DefaultLimits[PlanFree]
}

func (s *PlanLimitsStore) loop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.refresh()
		}
	}
}

func (s *PlanLimitsStore) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rows, err := s.db.Query(ctx,
		`SELECT plan, max_requests_per_min, max_sessions_concurrent, max_tokens_per_request,
		        allowed_model_tiers, autocomplete_enabled, balance_markup_pct,
		        daily_credits_usd, monthly_credits_usd, credits_rollover
		 FROM plan_limits`)
	if err != nil {
		s.logger.Warn("plan_limits: failed to query", zap.Error(err))
		return
	}
	defer rows.Close()

	newCache := make(map[Plan]PlanLimits)
	for rows.Next() {
		var planStr string
		var lim PlanLimits
		if err := rows.Scan(
			&planStr,
			&lim.MaxRequestsPerMin,
			&lim.MaxSessionsConcurrent,
			&lim.MaxTokensPerRequest,
			&lim.AllowedModelTiers,
			&lim.AutocompleteEnabled,
			&lim.BalanceMarkupPct,
			&lim.DailyCreditsUSD,
			&lim.MonthlyCreditsUSD,
			&lim.CreditsRollover,
		); err != nil {
			s.logger.Warn("plan_limits: scan row failed", zap.Error(err))
			continue
		}
		newCache[Plan(planStr)] = lim
	}

	if len(newCache) > 0 {
		s.mu.Lock()
		s.cache = newCache
		s.mu.Unlock()
	}
}

// ---------------------------------------------------------------------------
// Global store instance
// ---------------------------------------------------------------------------

var globalStore *PlanLimitsStore

// SetPlanLimitsStore sets the global PlanLimitsStore used by LimitsForPlan.
func SetPlanLimitsStore(s *PlanLimitsStore) {
	globalStore = s
}

// LimitsForPlan returns limits for a given plan. It first checks the
// DB-backed store (if available), then falls back to DefaultLimits.
func LimitsForPlan(p Plan) PlanLimits {
	p = NormalizePlan(p)
	if globalStore != nil {
		return globalStore.Get(p)
	}
	if limits, ok := DefaultLimits[p]; ok {
		return limits
	}
	return DefaultLimits[PlanFree]
}

// NormalizePlan maps deprecated plan names to current ones.
func NormalizePlan(p Plan) Plan {
	switch p {
	case "pro_plus", "team":
		return PlanPro
	case "trial":
		return PlanFree
	case PlanFree, PlanPro, PlanProYearly:
		return p
	}
	if _, ok := DefaultLimits[p]; ok {
		return p
	}
	return PlanFree
}

// IsModelTierAllowed checks if a model tier is permitted for the plan.
func IsModelTierAllowed(p Plan, tier string) bool {
	limits := LimitsForPlan(p)
	for _, t := range limits.AllowedModelTiers {
		if t == tier {
			return true
		}
	}
	return false
}

// UserSubscription holds a user's subscription state.
type UserSubscription struct {
	Plan      Plan       `json:"plan"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// IsActive returns true if the subscription is currently active.
// Free plans are always active. Paid plans require a non-expired ExpiresAt.
func (s *UserSubscription) IsActive() bool {
	if s.Plan == PlanFree {
		return true
	}
	if s.ExpiresAt == nil {
		return false
	}
	return time.Now().Before(*s.ExpiresAt)
}

// EffectivePlan returns the user's active plan, falling back to free if expired.
func (s *UserSubscription) EffectivePlan() Plan {
	if s.IsActive() {
		return NormalizePlan(s.Plan)
	}
	return PlanFree
}

// Limits returns the resource limits for the user's effective plan.
func (s *UserSubscription) Limits() PlanLimits {
	return LimitsForPlan(s.EffectivePlan())
}

// ValidPlan checks if a plan string is a recognized plan.
func ValidPlan(p Plan) bool {
	switch p {
	case PlanFree, "trial", "pro", "pro_plus", "team", PlanProYearly:
		return true
	}
	return false
}

var (
	ErrInvalidPlan      = errors.New("invalid subscription plan")
	ErrPlanExpired      = errors.New("subscription plan has expired")
	ErrFeatureNotInPlan = errors.New("feature not available in current plan")
)
