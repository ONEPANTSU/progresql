package subscription

import (
	"context"
	"net/http"
)

// contextKey is an unexported type for context keys in this package.
type contextKey string

// SubscriptionContextKey is the context key for storing the user's subscription.
const SubscriptionContextKey contextKey = "subscription"

// PlanResolver looks up a user's subscription by user ID.
// Implementations may read from a database, file store, or in-memory cache.
type PlanResolver interface {
	GetSubscription(userID string) (*UserSubscription, error)
}

// Checker validates subscription plans against resource limits.
type Checker struct {
	resolver PlanResolver
}

// NewChecker creates a Checker with the given PlanResolver.
func NewChecker(resolver PlanResolver) *Checker {
	return &Checker{resolver: resolver}
}

// CheckModelTier verifies that the user's plan allows the requested model tier.
func (c *Checker) CheckModelTier(sub *UserSubscription, modelTier string) error {
	if IsModelTierAllowed(sub.EffectivePlan(), modelTier) {
		return nil
	}
	return ErrFeatureNotInPlan
}

// SubscriptionFromContext extracts the UserSubscription from the request context.
// Returns nil if no subscription is present.
func SubscriptionFromContext(ctx context.Context) *UserSubscription {
	sub, _ := ctx.Value(SubscriptionContextKey).(*UserSubscription)
	return sub
}

// Middleware returns HTTP middleware that resolves the user's subscription
// and adds it to the request context. Requires auth claims with UserID
// to be present (should be chained after auth middleware).
//
// userIDExtractor is a function that extracts the user ID from the request context.
// If userID is empty or not found, the request proceeds with a free plan.
func Middleware(resolver PlanResolver, userIDExtractor func(ctx context.Context) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userID := userIDExtractor(r.Context())

			var sub *UserSubscription
			if userID != "" && resolver != nil {
				resolved, err := resolver.GetSubscription(userID)
				if err == nil && resolved != nil {
					sub = resolved
				}
			}
			if sub == nil {
				sub = &UserSubscription{Plan: PlanFree}
			}

			ctx := context.WithValue(r.Context(), SubscriptionContextKey, sub)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
