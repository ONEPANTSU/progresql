package subscription

import (
	"time"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// UserStoreResolver adapts auth.UserStore to the PlanResolver interface.
type UserStoreResolver struct {
	store *auth.UserStore
}

// NewUserStoreResolver creates a resolver backed by the given UserStore.
func NewUserStoreResolver(store *auth.UserStore) *UserStoreResolver {
	return &UserStoreResolver{store: store}
}

// GetSubscription returns the subscription for the given user.
// If the user has no plan set, returns a free plan.
func (r *UserStoreResolver) GetSubscription(userID string) (*UserSubscription, error) {
	user, err := r.store.GetByID(userID)
	if err != nil {
		return nil, err
	}

	plan := Plan(user.Plan)
	if !ValidPlan(plan) {
		plan = PlanFree
	}

	sub := &UserSubscription{Plan: plan}
	if user.PlanExpiresAt != nil {
		t, err := time.Parse(time.RFC3339, *user.PlanExpiresAt)
		if err == nil {
			sub.ExpiresAt = &t
		}
	}

	return sub, nil
}
