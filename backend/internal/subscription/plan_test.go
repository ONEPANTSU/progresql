package subscription

import (
	"testing"
	"time"
)

func TestValidPlan(t *testing.T) {
	tests := []struct {
		plan Plan
		want bool
	}{
		{PlanFree, true},
		{PlanTrial, true},
		{PlanPro, true},
		{PlanProPlus, true},
		{PlanTeam, true},
		{Plan("enterprise"), false},
		{Plan(""), false},
	}
	for _, tt := range tests {
		if got := ValidPlan(tt.plan); got != tt.want {
			t.Errorf("ValidPlan(%q) = %v, want %v", tt.plan, got, tt.want)
		}
	}
}

func TestUserSubscription_IsActive(t *testing.T) {
	future := time.Now().Add(24 * time.Hour)
	past := time.Now().Add(-24 * time.Hour)

	tests := []struct {
		name string
		sub  UserSubscription
		want bool
	}{
		{"free plan always active", UserSubscription{Plan: PlanFree}, true},
		{"pro with future expiry", UserSubscription{Plan: PlanPro, ExpiresAt: &future}, true},
		{"pro with past expiry", UserSubscription{Plan: PlanPro, ExpiresAt: &past}, false},
		{"pro with nil expiry", UserSubscription{Plan: PlanPro, ExpiresAt: nil}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.sub.IsActive(); got != tt.want {
				t.Errorf("IsActive() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestUserSubscription_EffectivePlan(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour)
	future := time.Now().Add(24 * time.Hour)

	tests := []struct {
		name string
		sub  UserSubscription
		want Plan
	}{
		{"free plan", UserSubscription{Plan: PlanFree}, PlanFree},
		{"active pro", UserSubscription{Plan: PlanPro, ExpiresAt: &future}, PlanPro},
		{"expired pro falls back to free", UserSubscription{Plan: PlanPro, ExpiresAt: &past}, PlanFree},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.sub.EffectivePlan(); got != tt.want {
				t.Errorf("EffectivePlan() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestUserSubscription_Limits(t *testing.T) {
	sub := UserSubscription{Plan: PlanFree}
	limits := sub.Limits()
	if limits.MaxRequestsPerMin != 10 {
		t.Errorf("free plan MaxRequestsPerMin = %d, want 10", limits.MaxRequestsPerMin)
	}

	future := time.Now().Add(24 * time.Hour)
	sub = UserSubscription{Plan: PlanPro, ExpiresAt: &future}
	limits = sub.Limits()
	if limits.MaxRequestsPerMin != 60 {
		t.Errorf("pro plan MaxRequestsPerMin = %d, want 60", limits.MaxRequestsPerMin)
	}
}

func TestLimitsForPlan_UnknownFallsBackToFree(t *testing.T) {
	limits := LimitsForPlan(Plan("unknown"))
	freeLimits := DefaultLimits[PlanFree]
	if limits.MaxRequestsPerMin != freeLimits.MaxRequestsPerMin {
		t.Errorf("unknown plan should fall back to free limits")
	}
}

func TestDefaultLimits_AllPlansPresent(t *testing.T) {
	for _, p := range []Plan{PlanFree, PlanTrial, PlanPro, PlanProPlus, PlanTeam} {
		if _, ok := DefaultLimits[p]; !ok {
			t.Errorf("DefaultLimits missing plan %q", p)
		}
	}
}

func TestDefaultLimits_ProGreaterThanFree(t *testing.T) {
	free := DefaultLimits[PlanFree]
	pro := DefaultLimits[PlanPro]
	if pro.MaxRequestsPerMin <= free.MaxRequestsPerMin {
		t.Error("pro plan should have higher rate limit than free")
	}
	if pro.MaxTokensPerRequest <= free.MaxTokensPerRequest {
		t.Error("pro plan should have higher token limit than free")
	}
}

func TestQuotaLimitsForPlan_KnownPlans(t *testing.T) {
	tests := []struct {
		plan               Plan
		wantBudgetTokens   int64
		wantPremiumTokens  int64
		wantPeriod         string
		wantAutocomplete   bool
		wantBalanceEnabled bool
	}{
		{PlanFree, 50_000, 0, "daily", false, true},
		{PlanTrial, 500_000, 0, "daily", true, true},
		{PlanPro, 5_000_000, 200_000, "monthly", true, true},
		{PlanProPlus, 10_000_000, 1_500_000, "monthly", true, true},
	}
	for _, tt := range tests {
		t.Run(string(tt.plan), func(t *testing.T) {
			q := QuotaLimitsForPlan(tt.plan)
			if q.BudgetTokensLimit != tt.wantBudgetTokens {
				t.Errorf("BudgetTokensLimit = %d, want %d", q.BudgetTokensLimit, tt.wantBudgetTokens)
			}
			if q.PremiumTokensLimit != tt.wantPremiumTokens {
				t.Errorf("PremiumTokensLimit = %d, want %d", q.PremiumTokensLimit, tt.wantPremiumTokens)
			}
			if q.PeriodType != tt.wantPeriod {
				t.Errorf("PeriodType = %q, want %q", q.PeriodType, tt.wantPeriod)
			}
			if q.AutocompleteEnabled != tt.wantAutocomplete {
				t.Errorf("AutocompleteEnabled = %v, want %v", q.AutocompleteEnabled, tt.wantAutocomplete)
			}
			if q.BalanceEnabled != tt.wantBalanceEnabled {
				t.Errorf("BalanceEnabled = %v, want %v", q.BalanceEnabled, tt.wantBalanceEnabled)
			}
		})
	}
}

func TestQuotaLimitsForPlan_UnknownFallsBackToFree(t *testing.T) {
	q := QuotaLimitsForPlan(Plan("unknown"))
	freeQ := QuotaLimitsForPlan(PlanFree)
	if q.BudgetTokensLimit != freeQ.BudgetTokensLimit {
		t.Errorf("unknown plan should fall back to free quota limits")
	}
}

func TestDefaultLimits_TrialSameAsFreeRateLimits(t *testing.T) {
	free := DefaultLimits[PlanFree]
	trial := DefaultLimits[PlanTrial]
	if trial.MaxRequestsPerMin != free.MaxRequestsPerMin {
		t.Errorf("trial MaxRequestsPerMin = %d, want %d (same as free)", trial.MaxRequestsPerMin, free.MaxRequestsPerMin)
	}
	if trial.MaxSessionsConcurrent != free.MaxSessionsConcurrent {
		t.Errorf("trial MaxSessionsConcurrent = %d, want %d (same as free)", trial.MaxSessionsConcurrent, free.MaxSessionsConcurrent)
	}
	if trial.MaxTokensPerRequest != free.MaxTokensPerRequest {
		t.Errorf("trial MaxTokensPerRequest = %d, want %d (same as free)", trial.MaxTokensPerRequest, free.MaxTokensPerRequest)
	}
}

func TestDefaultLimits_ProPlusValues(t *testing.T) {
	pp := DefaultLimits[PlanProPlus]
	if pp.MaxRequestsPerMin != 120 {
		t.Errorf("pro_plus MaxRequestsPerMin = %d, want 120", pp.MaxRequestsPerMin)
	}
	if pp.MaxSessionsConcurrent != 5 {
		t.Errorf("pro_plus MaxSessionsConcurrent = %d, want 5", pp.MaxSessionsConcurrent)
	}
	if pp.MaxTokensPerRequest != 32768 {
		t.Errorf("pro_plus MaxTokensPerRequest = %d, want 32768", pp.MaxTokensPerRequest)
	}
}
