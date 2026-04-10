package subscription

import (
	"errors"
	"time"
)

// Plan represents a subscription tier.
type Plan string

const (
	PlanFree Plan = "free"
	PlanPro  Plan = "pro"

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
}

// LimitsForPlan returns limits for a given plan. Falls back to free if unknown.
func LimitsForPlan(p Plan) PlanLimits {
	// Normalize deprecated plans.
	p = NormalizePlan(p)
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
	case PlanFree, "trial", "pro", "pro_plus", "team":
		return true
	}
	return false
}

var (
	ErrInvalidPlan      = errors.New("invalid subscription plan")
	ErrPlanExpired      = errors.New("subscription plan has expired")
	ErrFeatureNotInPlan = errors.New("feature not available in current plan")
)
