package subscription

import (
	"testing"
	"time"
)

func TestCheckWarning_FreePlan_NoTrial(t *testing.T) {
	w := CheckWarning("free", nil, nil)
	if w != WarningNone {
		t.Errorf("expected no warning, got %q", w)
	}
}

func TestCheckWarning_FreePlan_TrialActive(t *testing.T) {
	future := time.Now().Add(10 * 24 * time.Hour)
	w := CheckWarning("free", nil, &future)
	if w != WarningNone {
		t.Errorf("expected no warning for trial 10 days out, got %q", w)
	}
}

func TestCheckWarning_FreePlan_TrialExpiringSoon_3Days(t *testing.T) {
	soon := time.Now().Add(2 * 24 * time.Hour)
	w := CheckWarning("free", nil, &soon)
	if w != WarningExpiringSoon {
		t.Errorf("expected expiring_soon, got %q", w)
	}
}

func TestCheckWarning_FreePlan_TrialExpiringSoon_1Day(t *testing.T) {
	soon := time.Now().Add(12 * time.Hour)
	w := CheckWarning("free", nil, &soon)
	if w != WarningExpiringSoon {
		t.Errorf("expected expiring_soon, got %q", w)
	}
}

func TestCheckWarning_FreePlan_TrialExpired(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour)
	w := CheckWarning("free", nil, &past)
	if w != WarningExpired {
		t.Errorf("expected expired, got %q", w)
	}
}

func TestCheckWarning_ProPlan_Active(t *testing.T) {
	future := time.Now().Add(30 * 24 * time.Hour)
	w := CheckWarning("pro", &future, nil)
	if w != WarningNone {
		t.Errorf("expected no warning for pro plan 30 days out, got %q", w)
	}
}

func TestCheckWarning_ProPlan_ExpiringSoon(t *testing.T) {
	soon := time.Now().Add(1 * 24 * time.Hour)
	w := CheckWarning("pro", &soon, nil)
	if w != WarningExpiringSoon {
		t.Errorf("expected expiring_soon for pro plan, got %q", w)
	}
}

func TestCheckWarning_ProPlan_Expired(t *testing.T) {
	past := time.Now().Add(-2 * time.Hour)
	w := CheckWarning("pro", &past, nil)
	if w != WarningExpired {
		t.Errorf("expected expired for pro plan, got %q", w)
	}
}

func TestCheckWarning_ProPlan_NoExpiry(t *testing.T) {
	// Paid plan without expiration — should be no warning.
	w := CheckWarning("pro", nil, nil)
	if w != WarningNone {
		t.Errorf("expected no warning for pro plan without expiry, got %q", w)
	}
}

func TestCheckWarning_EmptyPlan_TrialExpiringSoon(t *testing.T) {
	// Empty plan treated as free.
	soon := time.Now().Add(2 * 24 * time.Hour)
	w := CheckWarning("", nil, &soon)
	if w != WarningExpiringSoon {
		t.Errorf("expected expiring_soon for empty plan, got %q", w)
	}
}

func TestCheckWarning_ExactBoundary_3Days(t *testing.T) {
	// Exactly 3 days — should be expiring_soon (boundary is <=).
	exactly3 := time.Now().Add(3 * 24 * time.Hour)
	w := CheckWarning("free", nil, &exactly3)
	if w != WarningExpiringSoon {
		t.Errorf("expected expiring_soon at exact 3-day boundary, got %q", w)
	}
}

func TestDaysUntilExpiry(t *testing.T) {
	tests := []struct {
		name     string
		expires  time.Time
		expected int
	}{
		{"10 days", time.Now().Add(10*24*time.Hour + 1*time.Hour), 10},
		{"1 day", time.Now().Add(36 * time.Hour), 1},
		{"expired", time.Now().Add(-1 * time.Hour), 0},
		{"0 days (hours left)", time.Now().Add(5 * time.Hour), 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DaysUntilExpiry(tt.expires)
			if got != tt.expected {
				t.Errorf("DaysUntilExpiry: expected %d, got %d", tt.expected, got)
			}
		})
	}
}

func TestWarningConstants(t *testing.T) {
	if WarningNone != "" {
		t.Error("WarningNone should be empty string")
	}
	if WarningExpiringSoon != "expiring_soon" {
		t.Errorf("WarningExpiringSoon = %q, want expiring_soon", WarningExpiringSoon)
	}
	if WarningExpired != "expired" {
		t.Errorf("WarningExpired = %q, want expired", WarningExpired)
	}
}
