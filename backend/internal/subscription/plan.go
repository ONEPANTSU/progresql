package subscription

import (
	"errors"
	"time"
)

// Plan represents a subscription tier.
type Plan string

const (
	PlanFree    Plan = "free"
	PlanPro     Plan = "pro"
	PlanTeam    Plan = "team"
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
	PlanPro: {
		MaxRequestsPerMin:     60,
		MaxSessionsConcurrent: 5,
		MaxTokensPerRequest:   16384,
	},
	PlanTeam: {
		MaxRequestsPerMin:     120,
		MaxSessionsConcurrent: 20,
		MaxTokensPerRequest:   32768,
	},
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
	case PlanFree, PlanPro, PlanTeam:
		return true
	}
	return false
}

var (
	ErrInvalidPlan      = errors.New("invalid subscription plan")
	ErrPlanExpired      = errors.New("subscription plan has expired")
	ErrFeatureNotInPlan = errors.New("feature not available in current plan")
)
