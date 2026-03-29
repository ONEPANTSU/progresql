package quota

import (
	"math"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/subscription"
)

// ---------- determineQuotaAction tests ----------

func TestDetermineQuotaAction_FreeUser_BudgetModel_UnderLimit(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanFree, "budget",
		10_000, 50_000, // budgetUsed, budgetLimit
		0, 0, // premiumUsed, premiumLimit
		0, false, // balance, balanceEnabled
	)
	if !r.Allowed {
		t.Fatal("expected Allowed=true for free user under budget limit")
	}
	if r.UseBalance {
		t.Fatal("expected UseBalance=false")
	}
	if r.FallbackModelID != "" {
		t.Fatalf("expected no fallback, got %q", r.FallbackModelID)
	}
	if r.RemainingBudget != 40_000 {
		t.Fatalf("expected RemainingBudget=40000, got %d", r.RemainingBudget)
	}
}

func TestDetermineQuotaAction_FreeUser_BudgetModel_OverLimit(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanFree, "budget",
		50_000, 50_000,
		0, 0,
		0, false,
	)
	if r.Allowed {
		t.Fatal("expected Allowed=false for free user with exhausted budget")
	}
	if r.UseBalance {
		t.Fatal("expected UseBalance=false for free user")
	}
	if r.Reason == "" {
		t.Fatal("expected a reason when not allowed")
	}
}

func TestDetermineQuotaAction_FreeUser_PremiumModel_Fallback(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanFree, "premium",
		10_000, 50_000,
		0, 0,
		0, false,
	)
	if r.Allowed {
		t.Fatal("expected Allowed=false for free user requesting premium")
	}
	if r.FallbackModelID != DefaultBudgetFallbackModel {
		t.Fatalf("expected fallback to %q, got %q", DefaultBudgetFallbackModel, r.FallbackModelID)
	}
}

func TestDetermineQuotaAction_ProUser_BudgetModel_UnderLimit(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanPro, "budget",
		1_000_000, 5_000_000,
		0, 200_000,
		500.0, true,
	)
	if !r.Allowed {
		t.Fatal("expected Allowed=true")
	}
	if r.UseBalance {
		t.Fatal("expected UseBalance=false when under limit")
	}
	if r.RemainingBudget != 4_000_000 {
		t.Fatalf("expected RemainingBudget=4000000, got %d", r.RemainingBudget)
	}
}

func TestDetermineQuotaAction_ProUser_BudgetModel_OverLimit_HasBalance(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanPro, "budget",
		5_000_000, 5_000_000,
		0, 200_000,
		100.0, true,
	)
	if !r.Allowed {
		t.Fatal("expected Allowed=true when balance available")
	}
	if !r.UseBalance {
		t.Fatal("expected UseBalance=true when quota exhausted but has balance")
	}
}

func TestDetermineQuotaAction_ProUser_BudgetModel_OverLimit_ZeroBalance(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanPro, "budget",
		5_000_000, 5_000_000,
		0, 200_000,
		0, true,
	)
	if r.Allowed {
		t.Fatal("expected Allowed=false with zero balance")
	}
	if r.UseBalance {
		t.Fatal("expected UseBalance=false with zero balance")
	}
	if r.Reason == "" {
		t.Fatal("expected a reason when not allowed")
	}
}

func TestDetermineQuotaAction_ProUser_PremiumModel_UnderLimit(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanPro, "premium",
		1_000_000, 5_000_000,
		50_000, 200_000,
		500.0, true,
	)
	if !r.Allowed {
		t.Fatal("expected Allowed=true for pro user under premium limit")
	}
	if r.UseBalance {
		t.Fatal("expected UseBalance=false when under limit")
	}
	if r.RemainingPremium != 150_000 {
		t.Fatalf("expected RemainingPremium=150000, got %d", r.RemainingPremium)
	}
}

func TestDetermineQuotaAction_ProUser_PremiumModel_OverLimit_HasBalance(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanPro, "premium",
		1_000_000, 5_000_000,
		200_000, 200_000,
		100.0, true,
	)
	if !r.Allowed {
		t.Fatal("expected Allowed=true when balance available")
	}
	if !r.UseBalance {
		t.Fatal("expected UseBalance=true when premium quota exhausted but has balance")
	}
}

func TestDetermineQuotaAction_ProUser_PremiumModel_OverLimit_NoBalance(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanPro, "premium",
		1_000_000, 5_000_000,
		200_000, 200_000,
		0, true,
	)
	if r.Allowed && !r.UseBalance {
		// Should fallback
	}
	if r.FallbackModelID != DefaultBudgetFallbackModel {
		t.Fatalf("expected fallback to %q, got %q", DefaultBudgetFallbackModel, r.FallbackModelID)
	}
}

func TestDetermineQuotaAction_ProPlusUser_PremiumModel_UnderLimit(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanProPlus, "premium",
		2_000_000, 10_000_000,
		500_000, 1_500_000,
		1000.0, true,
	)
	if !r.Allowed {
		t.Fatal("expected Allowed=true for pro_plus user under premium limit")
	}
	if r.UseBalance {
		t.Fatal("expected UseBalance=false when under limit")
	}
	if r.RemainingPremium != 1_000_000 {
		t.Fatalf("expected RemainingPremium=1000000, got %d", r.RemainingPremium)
	}
}

func TestDetermineQuotaAction_TrialUser_PremiumModel_Fallback(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanTrial, "premium",
		100_000, 500_000,
		0, 0,
		0, false,
	)
	if r.Allowed {
		t.Fatal("expected Allowed=false for trial user requesting premium")
	}
	if r.FallbackModelID != DefaultBudgetFallbackModel {
		t.Fatalf("expected fallback to %q, got %q", DefaultBudgetFallbackModel, r.FallbackModelID)
	}
}

func TestDetermineQuotaAction_TrialUser_BudgetModel_UnderLimit(t *testing.T) {
	r := determineQuotaAction(
		subscription.PlanTrial, "budget",
		100_000, 500_000,
		0, 0,
		0, false,
	)
	if !r.Allowed {
		t.Fatal("expected Allowed=true for trial user under budget limit")
	}
	if r.RemainingBudget != 400_000 {
		t.Fatalf("expected RemainingBudget=400000, got %d", r.RemainingBudget)
	}
}

// ---------- calculateCostRUB tests ----------

func almostEqual(a, b, epsilon float64) bool {
	return math.Abs(a-b) < epsilon
}

func TestCalculateCostRUB_KnownModel(t *testing.T) {
	// qwen/qwen3-coder: input $0.20/M, output $0.60/M
	// 1000 input + 500 output, 0% markup
	// Input cost: 1000 * 0.20 / 1_000_000 = 0.0002 USD
	// Output cost: 500 * 0.60 / 1_000_000 = 0.0003 USD
	// Total USD: 0.0005
	// Total RUB: 0.0005 * 90 = 0.045
	cost := calculateCostRUB("qwen/qwen3-coder", 1000, 500, 0)
	expected := 0.045
	if !almostEqual(cost, expected, 0.0001) {
		t.Fatalf("expected cost ~%.4f RUB, got %.4f", expected, cost)
	}
}

func TestCalculateCostRUB_UnknownModel(t *testing.T) {
	cost := calculateCostRUB("unknown/model-xyz", 1000, 500, 0)
	if cost != 0 {
		t.Fatalf("expected 0 for unknown model, got %f", cost)
	}
}

func TestCalculateCostRUB_WithMarkup50(t *testing.T) {
	// Same as above but 50% markup
	// 0.045 * 1.50 = 0.0675
	cost := calculateCostRUB("qwen/qwen3-coder", 1000, 500, 50)
	expected := 0.0675
	if !almostEqual(cost, expected, 0.0001) {
		t.Fatalf("expected cost ~%.4f RUB, got %.4f", expected, cost)
	}
}

func TestCalculateCostRUB_WithMarkup25(t *testing.T) {
	// 0.045 * 1.25 = 0.05625
	cost := calculateCostRUB("qwen/qwen3-coder", 1000, 500, 25)
	expected := 0.05625
	if !almostEqual(cost, expected, 0.0001) {
		t.Fatalf("expected cost ~%.5f RUB, got %.5f", expected, cost)
	}
}
