package quota

import (
	"testing"

	"github.com/onepantsu/progressql/backend/internal/subscription"
)

func TestUsageResponseFormat(t *testing.T) {
	// Test that quota limits match expected values for each plan.
	tests := []struct {
		plan                string
		wantBudgetLimit     int64
		wantPremiumLimit    int64
		wantPeriod          string
		wantAutocomplete    bool
		wantBalanceEnabled  bool
		wantBalanceMarkup   int
	}{
		{"free", 50_000, 0, "daily", false, false, 0},
		{"trial", 500_000, 0, "daily", true, false, 0},
		{"pro", 5_000_000, 200_000, "monthly", true, true, 50},
		{"pro_plus", 10_000_000, 1_500_000, "monthly", true, true, 25},
	}

	for _, tt := range tests {
		t.Run(tt.plan, func(t *testing.T) {
			ql := subscription.QuotaLimitsForPlan(subscription.Plan(tt.plan))
			if ql.BudgetTokensLimit != tt.wantBudgetLimit {
				t.Errorf("BudgetTokensLimit = %d, want %d", ql.BudgetTokensLimit, tt.wantBudgetLimit)
			}
			if ql.PremiumTokensLimit != tt.wantPremiumLimit {
				t.Errorf("PremiumTokensLimit = %d, want %d", ql.PremiumTokensLimit, tt.wantPremiumLimit)
			}
			if ql.PeriodType != tt.wantPeriod {
				t.Errorf("PeriodType = %q, want %q", ql.PeriodType, tt.wantPeriod)
			}
			if ql.AutocompleteEnabled != tt.wantAutocomplete {
				t.Errorf("AutocompleteEnabled = %v, want %v", ql.AutocompleteEnabled, tt.wantAutocomplete)
			}
			if ql.BalanceEnabled != tt.wantBalanceEnabled {
				t.Errorf("BalanceEnabled = %v, want %v", ql.BalanceEnabled, tt.wantBalanceEnabled)
			}
			if ql.BalanceMarkupPct != tt.wantBalanceMarkup {
				t.Errorf("BalanceMarkupPct = %d, want %d", ql.BalanceMarkupPct, tt.wantBalanceMarkup)
			}
		})
	}
}

func TestPlanLimitsMatch(t *testing.T) {
	// Verify resource limits.
	tests := []struct {
		plan           string
		wantReqPerMin  int
		wantMaxTokens  int
	}{
		{"free", 10, 4096},
		{"trial", 10, 4096},
		{"pro", 60, 16384},
		{"pro_plus", 120, 32768},
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
		})
	}
}
