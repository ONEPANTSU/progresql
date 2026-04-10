package quota

import (
	"encoding/json"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/subscription"
)

func TestQuotaResponseShape(t *testing.T) {
	// Verify that quotaResponse JSON fields match the expected shape.
	resp := quotaResponse{
		Plan:                "free",
		AllowedModelTiers:   []string{"budget"},
		AutocompleteEnabled: false,
		BalanceMarkupPct:    30,
		MaxRequestsPerMin:   10,
		MaxTokensPerRequest: 16384,
		MonthlyCreditsUSD:   0,
		DailyCreditsUSD:     0.03,
		CreditsRollover:     false,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal quotaResponse: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	requiredKeys := []string{
		"plan", "allowed_model_tiers", "autocomplete_enabled",
		"balance_markup_pct", "max_requests_per_min", "max_tokens_per_request",
		"monthly_credits_usd", "daily_credits_usd", "credits_rollover",
	}
	for _, key := range requiredKeys {
		if _, ok := m[key]; !ok {
			t.Errorf("missing key %q in quotaResponse JSON", key)
		}
	}
}

func TestUsageResponseShape(t *testing.T) {
	// Verify that usageResponse JSON fields match the expected shape.
	resp := usageResponse{
		BalanceUSD:          10.5,
		BalanceRUB:          945.0,
		Plan:                "pro",
		CreditsIncludedUSD:  15.0,
		CreditsUsedUSD:      3.5,
		CreditsRemainingUSD: 11.5,
		PeriodStart:         "2026-04-01T00:00:00Z",
		PeriodEnd:           "2026-05-01T00:00:00Z",
		RequestsTotal:       42,
		TokensTotal:         150000,
		CostUSDTotal:        3.5,
		AvgCostPerReqUSD:    0.083,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal usageResponse: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	requiredKeys := []string{
		"balance_usd", "balance_rub", "plan",
		"credits_included_usd", "credits_used_usd", "credits_remaining_usd",
		"period_start", "period_end",
		"requests_total", "tokens_total", "cost_usd_total", "avg_cost_per_request_usd",
	}
	for _, key := range requiredKeys {
		if _, ok := m[key]; !ok {
			t.Errorf("missing key %q in usageResponse JSON", key)
		}
	}
}

func TestPlanLimitsMatch(t *testing.T) {
	// Verify resource limits for current plans.
	tests := []struct {
		plan          string
		wantReqPerMin int
		wantMaxTokens int
		wantMarkup    int
	}{
		{"free", 10, 16384, 30},
		{"trial", 10, 16384, 30},       // trial normalizes to free
		{"pro", 60, 32768, 20},
		{"pro_plus", 60, 32768, 20},    // pro_plus normalizes to pro
	}

	for _, tt := range tests {
		t.Run(tt.plan, func(t *testing.T) {
			pl := subscription.LimitsForPlan(subscription.Plan(tt.plan))
			if pl.MaxRequestsPerMin != tt.wantReqPerMin {
				t.Errorf("MaxRequestsPerMin = %d, want %d", pl.MaxRequestsPerMin, tt.wantReqPerMin)
			}
			if pl.MaxTokensPerRequest != tt.wantMaxTokens {
				t.Errorf("MaxTokensPerRequest = %d, want %d", pl.MaxTokensPerRequest, tt.wantMaxTokens)
			}
			if pl.BalanceMarkupPct != tt.wantMarkup {
				t.Errorf("BalanceMarkupPct = %d, want %d", pl.BalanceMarkupPct, tt.wantMarkup)
			}
		})
	}
}

func TestAllowedModelTiers(t *testing.T) {
	// Verify that plan limits contain the expected model tiers.
	tests := []struct {
		plan      string
		wantTiers []string
	}{
		{"free", []string{"budget"}},
		{"pro", []string{"budget", "premium"}},
	}

	for _, tt := range tests {
		t.Run(tt.plan, func(t *testing.T) {
			pl := subscription.LimitsForPlan(subscription.Plan(tt.plan))
			if len(pl.AllowedModelTiers) != len(tt.wantTiers) {
				t.Fatalf("AllowedModelTiers = %v, want %v", pl.AllowedModelTiers, tt.wantTiers)
			}
			for i, tier := range tt.wantTiers {
				if pl.AllowedModelTiers[i] != tier {
					t.Errorf("AllowedModelTiers[%d] = %q, want %q", i, pl.AllowedModelTiers[i], tier)
				}
			}
		})
	}
}

func TestModelPricingResponseShape(t *testing.T) {
	resp := modelPricingResponse{
		Models: []modelPricingInfo{
			{ID: "test/model", Name: "Test", Tier: "budget", InputPricePerM: 0.20, OutputPricePerM: 0.60},
		},
		UsdToRub: 90.0,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if _, ok := m["models"]; !ok {
		t.Error("missing 'models' key")
	}
	if _, ok := m["usd_to_rub"]; !ok {
		t.Error("missing 'usd_to_rub' key")
	}
}
