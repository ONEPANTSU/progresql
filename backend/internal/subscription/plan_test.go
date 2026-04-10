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
		{Plan("trial"), true},
		{PlanPro, true},
		{PlanProYearly, true},
		{Plan("pro_plus"), true},
		{Plan("team"), true},
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
		{"pro_yearly with future expiry", UserSubscription{Plan: PlanProYearly, ExpiresAt: &future}, true},
		{"pro_yearly with past expiry", UserSubscription{Plan: PlanProYearly, ExpiresAt: &past}, false},
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
		{"active pro_yearly", UserSubscription{Plan: PlanProYearly, ExpiresAt: &future}, PlanProYearly},
		{"expired pro_yearly falls back to free", UserSubscription{Plan: PlanProYearly, ExpiresAt: &past}, PlanFree},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.sub.EffectivePlan(); got != tt.want {
				t.Errorf("EffectivePlan() = %q, want %q", got, tt.want)
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

	sub = UserSubscription{Plan: PlanProYearly, ExpiresAt: &future}
	limits = sub.Limits()
	if limits.BalanceMarkupPct != 15 {
		t.Errorf("pro_yearly plan BalanceMarkupPct = %d, want 15", limits.BalanceMarkupPct)
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
	for _, p := range []Plan{PlanFree, PlanPro, PlanProYearly} {
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

func TestDefaultLimits_ProYearlyMarkup(t *testing.T) {
	pro := DefaultLimits[PlanPro]
	proYearly := DefaultLimits[PlanProYearly]
	if proYearly.BalanceMarkupPct >= pro.BalanceMarkupPct {
		t.Error("pro_yearly should have lower markup than monthly pro")
	}
}

func TestNormalizePlan_DeprecatedAliases(t *testing.T) {
	tests := []struct {
		input Plan
		want  Plan
	}{
		{Plan("trial"), PlanFree},
		{Plan("pro_plus"), PlanPro},
		{Plan("team"), PlanPro},
		{PlanFree, PlanFree},
		{PlanPro, PlanPro},
		{PlanProYearly, PlanProYearly},
		{Plan("unknown"), PlanFree},
	}
	for _, tt := range tests {
		t.Run(string(tt.input), func(t *testing.T) {
			if got := NormalizePlan(tt.input); got != tt.want {
				t.Errorf("NormalizePlan(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestIsModelTierAllowed(t *testing.T) {
	if !IsModelTierAllowed(PlanFree, "budget") {
		t.Error("free plan should allow budget tier")
	}
	if IsModelTierAllowed(PlanFree, "premium") {
		t.Error("free plan should not allow premium tier")
	}
	if !IsModelTierAllowed(PlanPro, "premium") {
		t.Error("pro plan should allow premium tier")
	}
	if !IsModelTierAllowed(PlanProYearly, "premium") {
		t.Error("pro_yearly plan should allow premium tier")
	}
}
