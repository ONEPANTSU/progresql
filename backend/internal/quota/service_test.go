package quota

import (
	"context"
	"math"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/subscription"
	"go.uber.org/zap"
)

// testService creates a minimal *Service for unit tests that only need calculateCostUSD.
func testService() *Service {
	return &Service{
		logger: zap.NewNop(),
	}
}

func almostEqual(a, b, epsilon float64) bool {
	return math.Abs(a-b) < epsilon
}

// ---------- IsModelTierAllowed tests (used by CheckRequest logic) ----------

func TestIsModelTierAllowed_FreePlan_BudgetAllowed(t *testing.T) {
	if !subscription.IsModelTierAllowed(subscription.PlanFree, "budget") {
		t.Fatal("expected budget tier to be allowed for free plan")
	}
}

func TestIsModelTierAllowed_FreePlan_PremiumDenied(t *testing.T) {
	if subscription.IsModelTierAllowed(subscription.PlanFree, "premium") {
		t.Fatal("expected premium tier to be denied for free plan")
	}
}

func TestIsModelTierAllowed_ProPlan_BudgetAllowed(t *testing.T) {
	if !subscription.IsModelTierAllowed(subscription.PlanPro, "budget") {
		t.Fatal("expected budget tier to be allowed for pro plan")
	}
}

func TestIsModelTierAllowed_ProPlan_PremiumAllowed(t *testing.T) {
	if !subscription.IsModelTierAllowed(subscription.PlanPro, "premium") {
		t.Fatal("expected premium tier to be allowed for pro plan")
	}
}

func TestIsModelTierAllowed_TrialNormalizesToFree(t *testing.T) {
	// "trial" normalizes to "free", so premium should be denied.
	if subscription.IsModelTierAllowed(subscription.NormalizePlan("trial"), "premium") {
		t.Fatal("expected premium tier to be denied for trial (normalized to free)")
	}
}

func TestIsModelTierAllowed_ProPlusNormalizesToPro(t *testing.T) {
	// "pro_plus" normalizes to "pro", so premium should be allowed.
	if !subscription.IsModelTierAllowed(subscription.NormalizePlan("pro_plus"), "premium") {
		t.Fatal("expected premium tier to be allowed for pro_plus (normalized to pro)")
	}
}

func TestIsModelTierAllowed_UnknownTierDenied(t *testing.T) {
	if subscription.IsModelTierAllowed(subscription.PlanPro, "ultra") {
		t.Fatal("expected unknown tier 'ultra' to be denied")
	}
}

// ---------- calculateCostUSD tests ----------

func TestCalculateCostUSD_KnownModel(t *testing.T) {
	// qwen/qwen3-coder: input $0.20/M, output $0.60/M
	// 1000 input + 500 output
	// Input cost: 1000 * 0.20 / 1_000_000 = 0.0002 USD
	// Output cost: 500 * 0.60 / 1_000_000 = 0.0003 USD
	// Total USD: 0.0005
	svc := testService()
	cost := svc.calculateCostUSD(context.Background(), "qwen/qwen3-coder", 1000, 500)
	expected := 0.0005
	if !almostEqual(cost, expected, 0.00001) {
		t.Fatalf("expected cost ~%.6f USD, got %.6f", expected, cost)
	}
}

func TestCalculateCostUSD_UnknownModel(t *testing.T) {
	svc := testService()
	cost := svc.calculateCostUSD(context.Background(), "unknown/model-xyz", 1000, 500)
	if cost != 0 {
		t.Fatalf("expected 0 for unknown model, got %f", cost)
	}
}

func TestCalculateCostUSD_ZeroTokens(t *testing.T) {
	svc := testService()
	cost := svc.calculateCostUSD(context.Background(), "qwen/qwen3-coder", 0, 0)
	if cost != 0 {
		t.Fatalf("expected 0 for zero tokens, got %f", cost)
	}
}

func TestCalculateCostUSD_PremiumModel(t *testing.T) {
	// openai/gpt-4.1: input $2.00/M, output $8.00/M
	// 10000 input + 2000 output
	// Input cost: 10000 * 2.00 / 1_000_000 = 0.02 USD
	// Output cost: 2000 * 8.00 / 1_000_000 = 0.016 USD
	// Total USD: 0.036
	svc := testService()
	cost := svc.calculateCostUSD(context.Background(), "openai/gpt-4.1", 10000, 2000)
	expected := 0.036
	if !almostEqual(cost, expected, 0.0001) {
		t.Fatalf("expected cost ~%.4f USD, got %.4f", expected, cost)
	}
}

func TestCalculateCostUSD_OnlyInputTokens(t *testing.T) {
	// qwen/qwen3-coder: input $0.20/M
	// 5000 input, 0 output
	// Input cost: 5000 * 0.20 / 1_000_000 = 0.001 USD
	svc := testService()
	cost := svc.calculateCostUSD(context.Background(), "qwen/qwen3-coder", 5000, 0)
	expected := 0.001
	if !almostEqual(cost, expected, 0.00001) {
		t.Fatalf("expected cost ~%.6f USD, got %.6f", expected, cost)
	}
}

func TestCalculateCostUSD_OnlyOutputTokens(t *testing.T) {
	// qwen/qwen3-coder: output $0.60/M
	// 0 input, 5000 output
	// Output cost: 5000 * 0.60 / 1_000_000 = 0.003 USD
	svc := testService()
	cost := svc.calculateCostUSD(context.Background(), "qwen/qwen3-coder", 0, 5000)
	expected := 0.003
	if !almostEqual(cost, expected, 0.00001) {
		t.Fatalf("expected cost ~%.6f USD, got %.6f", expected, cost)
	}
}

// ---------- LimitsForPlan tests ----------

func TestLimitsForPlan_Free(t *testing.T) {
	pl := subscription.LimitsForPlan(subscription.PlanFree)
	if pl.MaxRequestsPerMin != 10 {
		t.Errorf("MaxRequestsPerMin = %d, want 10", pl.MaxRequestsPerMin)
	}
	if pl.AutocompleteEnabled {
		t.Error("expected AutocompleteEnabled=false for free plan")
	}
	if pl.BalanceMarkupPct != 30 {
		t.Errorf("BalanceMarkupPct = %d, want 30", pl.BalanceMarkupPct)
	}
}

func TestLimitsForPlan_Pro(t *testing.T) {
	pl := subscription.LimitsForPlan(subscription.PlanPro)
	if pl.MaxRequestsPerMin != 60 {
		t.Errorf("MaxRequestsPerMin = %d, want 60", pl.MaxRequestsPerMin)
	}
	if !pl.AutocompleteEnabled {
		t.Error("expected AutocompleteEnabled=true for pro plan")
	}
	if pl.BalanceMarkupPct != 20 {
		t.Errorf("BalanceMarkupPct = %d, want 20", pl.BalanceMarkupPct)
	}
	if pl.MonthlyCreditsUSD != 15.0 {
		t.Errorf("MonthlyCreditsUSD = %f, want 15.0", pl.MonthlyCreditsUSD)
	}
}

func TestLimitsForPlan_UnknownFallsBackToFree(t *testing.T) {
	pl := subscription.LimitsForPlan("unknown_plan")
	freePl := subscription.LimitsForPlan(subscription.PlanFree)
	if pl.MaxRequestsPerMin != freePl.MaxRequestsPerMin {
		t.Errorf("unknown plan should fall back to free limits")
	}
}
