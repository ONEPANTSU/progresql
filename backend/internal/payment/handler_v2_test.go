package payment

import (
	"testing"
)

func TestResolvePlanPrice(t *testing.T) {
	tests := []struct {
		name     string
		plan     string
		expected float64
	}{
		{"pro plan price", "pro", 1999.0},
		{"pro_plus plan price", "pro_plus", 5999.0},
		{"empty defaults to pro", "", 1999.0},
		{"unknown defaults to pro", "unknown", 1999.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolvePlanPrice(tt.plan)
			if got != tt.expected {
				t.Errorf("resolvePlanPrice(%q) = %v, want %v", tt.plan, got, tt.expected)
			}
		})
	}
}

func TestParseOrderPayload(t *testing.T) {
	tests := []struct {
		name            string
		payload         string
		wantType        string
		wantPlan        string
		wantUserID      string
		wantAmount      float64
		wantErr         bool
	}{
		{
			name:       "subscription pro",
			payload:    "sub_pro_abc-123",
			wantType:   "subscription",
			wantPlan:   "pro",
			wantUserID: "abc-123",
		},
		{
			name:       "subscription pro_plus",
			payload:    "sub_pro_plus_abc-123",
			wantType:   "subscription",
			wantPlan:   "pro_plus",
			wantUserID: "abc-123",
		},
		{
			name:       "balance top-up",
			payload:    "bal_500.00_abc-123",
			wantType:   "balance_topup",
			wantAmount: 500.0,
			wantUserID: "abc-123",
		},
		{
			name:       "balance top-up 1000",
			payload:    "bal_1000.00_def-456",
			wantType:   "balance_topup",
			wantAmount: 1000.0,
			wantUserID: "def-456",
		},
		{
			name:       "legacy user_ format",
			payload:    "user_abc-123",
			wantType:   "subscription",
			wantPlan:   "pro",
			wantUserID: "abc-123",
		},
		{
			name:    "empty payload",
			payload: "",
			wantErr: true,
		},
		{
			name:    "invalid format",
			payload: "invalid",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := parseOrderPayload(tt.payload)
			if tt.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result.PaymentType != tt.wantType {
				t.Errorf("PaymentType = %q, want %q", result.PaymentType, tt.wantType)
			}
			if tt.wantPlan != "" && result.Plan != tt.wantPlan {
				t.Errorf("Plan = %q, want %q", result.Plan, tt.wantPlan)
			}
			if result.UserID != tt.wantUserID {
				t.Errorf("UserID = %q, want %q", result.UserID, tt.wantUserID)
			}
			if tt.wantAmount > 0 && result.Amount != tt.wantAmount {
				t.Errorf("Amount = %v, want %v", result.Amount, tt.wantAmount)
			}
		})
	}
}

func TestMinTopUpAmount(t *testing.T) {
	if MinBalanceTopUp != 100.0 {
		t.Errorf("MinBalanceTopUp = %v, want 100.0", MinBalanceTopUp)
	}
}

func TestMaxTopUpAmount(t *testing.T) {
	if MaxBalanceTopUp != 100000.0 {
		t.Errorf("MaxBalanceTopUp = %v, want 100000.0", MaxBalanceTopUp)
	}
}
