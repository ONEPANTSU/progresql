package subscription

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type mockResolver struct {
	subs map[string]*UserSubscription
}

func (m *mockResolver) GetSubscription(userID string) (*UserSubscription, error) {
	if sub, ok := m.subs[userID]; ok {
		return sub, nil
	}
	return nil, ErrInvalidPlan
}

func TestChecker_CheckModelTier_Allowed(t *testing.T) {
	c := NewChecker(nil)
	sub := &UserSubscription{Plan: PlanFree}
	if err := c.CheckModelTier(sub, "budget"); err != nil {
		t.Errorf("expected nil, got %v", err)
	}
}

func TestChecker_CheckModelTier_Restricted(t *testing.T) {
	c := NewChecker(nil)
	future := time.Now().Add(24 * time.Hour)
	sub := &UserSubscription{Plan: PlanPro, ExpiresAt: &future}

	// Override limits to test restricted tiers.
	origLimits := DefaultLimits[PlanPro]
	DefaultLimits[PlanPro] = PlanLimits{
		MaxRequestsPerMin:     60,
		MaxSessionsConcurrent: 5,
		MaxTokensPerRequest:   16384,
		AllowedModelTiers:     []string{"budget", "premium"},
	}
	defer func() { DefaultLimits[PlanPro] = origLimits }()

	if err := c.CheckModelTier(sub, "budget"); err != nil {
		t.Errorf("budget tier should be allowed, got %v", err)
	}
	if err := c.CheckModelTier(sub, "ultra"); err != ErrFeatureNotInPlan {
		t.Errorf("ultra tier should be blocked, got %v", err)
	}
}

func TestSubscriptionFromContext(t *testing.T) {
	sub := &UserSubscription{Plan: PlanPro}
	ctx := context.WithValue(context.Background(), SubscriptionContextKey, sub)
	got := SubscriptionFromContext(ctx)
	if got == nil || got.Plan != PlanPro {
		t.Error("expected PlanPro from context")
	}
}

func TestSubscriptionFromContext_Nil(t *testing.T) {
	got := SubscriptionFromContext(context.Background())
	if got != nil {
		t.Error("expected nil from empty context")
	}
}

type testUserIDKey struct{}

func TestMiddleware_ResolvesSubscription(t *testing.T) {
	future := time.Now().Add(24 * time.Hour)
	resolver := &mockResolver{
		subs: map[string]*UserSubscription{
			"user-1": {Plan: PlanPro, ExpiresAt: &future},
		},
	}

	extractor := func(ctx context.Context) string {
		v, _ := ctx.Value(testUserIDKey{}).(string)
		return v
	}

	mw := Middleware(resolver, extractor)

	var gotSub *UserSubscription
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSub = SubscriptionFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/test", nil)
	req = req.WithContext(context.WithValue(req.Context(), testUserIDKey{}, "user-1"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if gotSub == nil || gotSub.Plan != PlanPro {
		t.Error("expected PlanPro from middleware")
	}
}

func TestMiddleware_FallsBackToFree(t *testing.T) {
	resolver := &mockResolver{subs: map[string]*UserSubscription{}}
	extractor := func(ctx context.Context) string { return "unknown-user" }

	mw := Middleware(resolver, extractor)

	var gotSub *UserSubscription
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSub = SubscriptionFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if gotSub == nil || gotSub.Plan != PlanFree {
		t.Error("expected free plan fallback")
	}
}

func TestMiddleware_NoUserID(t *testing.T) {
	extractor := func(ctx context.Context) string { return "" }
	mw := Middleware(nil, extractor)

	var gotSub *UserSubscription
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSub = SubscriptionFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if gotSub == nil || gotSub.Plan != PlanFree {
		t.Error("expected free plan when no userID")
	}
}
