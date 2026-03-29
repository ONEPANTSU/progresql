package subscription

import (
	"errors"
	"time"
)

// Plan represents a subscription tier.
type Plan string

const (
	PlanFree    Plan = "free"
	PlanTrial   Plan = "trial"
	PlanPro     Plan = "pro"
	PlanProPlus Plan = "pro_plus"
	PlanTeam    Plan = "team" // keep for backward compat
)

// PlanLimits defines resource limits for a subscription plan.
type PlanLimits struct {
	// MaxRequestsPerMin is the maximum AI requests per minute.
	MaxRequestsPerMin int
	// MaxSessionsConcurrent is the maximum concurrent WebSocket sessions.
	MaxSessionsConcurrent int
	// MaxTokensPerRequest is the maximum tokens per single LLM request.
	MaxTokensPerRequest int
	// AllowedModels lists model IDs available to this plan. Empty means all models.
	AllowedModels []string
}

// DefaultLimits returns the resource limits for each plan.
var DefaultLimits = map[Plan]PlanLimits{
	PlanFree: {
		MaxRequestsPerMin:     10,
		MaxSessionsConcurrent: 1,
		MaxTokensPerRequest:   4096,
	},
	PlanTrial: {
		MaxRequestsPerMin:     10,
		MaxSessionsConcurrent: 1,
		MaxTokensPerRequest:   4096,
	},
	PlanPro: {
		MaxRequestsPerMin:     60,
		MaxSessionsConcurrent: 5,
		MaxTokensPerRequest:   16384,
	},
	PlanProPlus: {
		MaxRequestsPerMin:     120,
		MaxSessionsConcurrent: 5,
		MaxTokensPerRequest:   32768,
	},
	PlanTeam: {
		MaxRequestsPerMin:     120,
		MaxSessionsConcurrent: 20,
		MaxTokensPerRequest:   32768,
	},
}

// QuotaLimits defines token-quota constraints for a subscription plan.
type QuotaLimits struct {
	BudgetTokensLimit   int64  // max budget tokens per period
	PremiumTokensLimit  int64  // max premium tokens per period (included free)
	PeriodType          string // "daily" or "monthly"
	AutocompleteEnabled bool
	BalanceMarkupPct    int  // 0 = no balance access, 50 = Pro, 25 = ProPlus
	BalanceEnabled      bool // whether user can use balance at all
}

var defaultQuotaLimits = map[Plan]QuotaLimits{
	PlanFree: {
		BudgetTokensLimit:   50_000,
		PremiumTokensLimit:  0,
		PeriodType:          "daily",
		AutocompleteEnabled: false,
		BalanceMarkupPct:    0,
		BalanceEnabled:      false,
	},
	PlanTrial: {
		BudgetTokensLimit:   500_000,
		PremiumTokensLimit:  0,
		PeriodType:          "daily",
		AutocompleteEnabled: true,
		BalanceMarkupPct:    0,
		BalanceEnabled:      false,
	},
	PlanPro: {
		BudgetTokensLimit:   5_000_000,
		PremiumTokensLimit:  200_000,
		PeriodType:          "monthly",
		AutocompleteEnabled: true,
		BalanceMarkupPct:    50,
		BalanceEnabled:      true,
	},
	PlanProPlus: {
		BudgetTokensLimit:   10_000_000,
		PremiumTokensLimit:  1_500_000,
		PeriodType:          "monthly",
		AutocompleteEnabled: true,
		BalanceMarkupPct:    25,
		BalanceEnabled:      true,
	},
}

// QuotaLimitsForPlan returns the token-quota limits for the given plan.
// Falls back to PlanFree quota if the plan is unknown.
func QuotaLimitsForPlan(p Plan) QuotaLimits {
	if q, ok := defaultQuotaLimits[p]; ok {
		return q
	}
	return defaultQuotaLimits[PlanFree]
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
		return s.Plan
	}
	return PlanFree
}

// Limits returns the resource limits for the user's effective plan.
func (s *UserSubscription) Limits() PlanLimits {
	return LimitsForPlan(s.EffectivePlan())
}

// LimitsForPlan returns limits for a given plan. Falls back to free if unknown.
func LimitsForPlan(p Plan) PlanLimits {
	if limits, ok := DefaultLimits[p]; ok {
		return limits
	}
	return DefaultLimits[PlanFree]
}

// ValidPlan checks if a plan string is a recognized plan.
func ValidPlan(p Plan) bool {
	switch p {
	case PlanFree, PlanTrial, PlanPro, PlanProPlus, PlanTeam:
		return true
	}
	return false
}

var (
	ErrInvalidPlan      = errors.New("invalid subscription plan")
	ErrPlanExpired      = errors.New("subscription plan has expired")
	ErrFeatureNotInPlan = errors.New("feature not available in current plan")
)
