package subscription

import (
	"time"
)

// SubscriptionWarning indicates the urgency of an upcoming or past expiration.
type SubscriptionWarning string

const (
	// WarningNone means no warning — subscription is fine or far from expiring.
	WarningNone SubscriptionWarning = ""
	// WarningExpiringSoon means the subscription expires within 3 days.
	WarningExpiringSoon SubscriptionWarning = "expiring_soon"
	// WarningExpired means the subscription has already expired.
	WarningExpired SubscriptionWarning = "expired"
)

// CheckWarning determines the subscription warning level for a user.
// It checks both plan_expires_at (for paid plans) and trial_ends_at.
//
// Returns:
//   - "expired" if the relevant expiration time has passed
//   - "expiring_soon" if it expires within 3 days
//   - "" (empty) if no warning is needed
func CheckWarning(plan string, planExpiresAt, trialEndsAt *time.Time) SubscriptionWarning {
	now := time.Now()

	// For paid plans, check plan_expires_at.
	if plan != "" && plan != string(PlanFree) {
		if planExpiresAt != nil {
			return checkExpiry(now, *planExpiresAt)
		}
		// Paid plan with no expiry — no warning.
		return WarningNone
	}

	// For free plans, check trial_ends_at.
	if trialEndsAt != nil {
		return checkExpiry(now, *trialEndsAt)
	}

	// Free plan with no trial — no warning.
	return WarningNone
}

// checkExpiry returns the warning level based on how close now is to expiresAt.
func checkExpiry(now, expiresAt time.Time) SubscriptionWarning {
	if now.After(expiresAt) {
		return WarningExpired
	}
	if expiresAt.Sub(now) <= 3*24*time.Hour {
		return WarningExpiringSoon
	}
	return WarningNone
}

// DaysUntilExpiry returns the number of days until the expiration time.
// Returns 0 if already expired, negative values are clamped to 0.
func DaysUntilExpiry(expiresAt time.Time) int {
	remaining := time.Until(expiresAt)
	if remaining <= 0 {
		return 0
	}
	return int(remaining.Hours() / 24)
}
