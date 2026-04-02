/*
* Created on Mar 27, 2026
* Test file for user_store_resolver.go, notifier.go (extra coverage)
* File path: internal/subscription/subscription_extra_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package subscription

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// badPool returns a pgxpool that will fail on every query (connection refused).
// This lets us cover error paths in DB-dependent functions without a real database.
func badPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://x:x@127.0.0.1:9999/testdb?sslmode=disable")
	if err != nil {
		t.Skipf("could not create bad pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// ── UserStoreResolver ─────────────────────────────────────────────────────────

func TestUserStoreResolver_GetSubscription_FreePlan(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Alice", "alice@example.com", "P@ssw0rd123", false)

	resolver := NewUserStoreResolver(store)
	sub, err := resolver.GetSubscription(user.ID)
	if err != nil {
		t.Fatalf("GetSubscription: %v", err)
	}
	if sub.Plan != PlanFree {
		t.Errorf("expected PlanFree, got %q", sub.Plan)
	}
}

func TestUserStoreResolver_GetSubscription_ProPlan(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Bob", "bob@example.com", "P@ssw0rd123", false)

	exp := time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	store.SetPlan(user.ID, "pro", &exp)

	resolver := NewUserStoreResolver(store)
	sub, err := resolver.GetSubscription(user.ID)
	if err != nil {
		t.Fatalf("GetSubscription: %v", err)
	}
	if sub.Plan != PlanPro {
		t.Errorf("expected PlanPro, got %q", sub.Plan)
	}
	if sub.ExpiresAt == nil {
		t.Error("expected non-nil ExpiresAt")
	}
}

func TestUserStoreResolver_GetSubscription_UserNotFound(t *testing.T) {
	store := auth.NewUserStore(nil)
	resolver := NewUserStoreResolver(store)

	_, err := resolver.GetSubscription("nonexistent-id")
	if err == nil {
		t.Fatal("expected error for nonexistent user")
	}
}

func TestUserStoreResolver_GetSubscription_InvalidPlan_FallsBackToFree(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Carol", "carol@example.com", "P@ssw0rd123", false)
	// Set an unknown plan.
	store.SetPlan(user.ID, "unknown_plan", nil)

	resolver := NewUserStoreResolver(store)
	sub, err := resolver.GetSubscription(user.ID)
	if err != nil {
		t.Fatalf("GetSubscription: %v", err)
	}
	if sub.Plan != PlanFree {
		t.Errorf("expected fallback to PlanFree for invalid plan, got %q", sub.Plan)
	}
}

func TestNewUserStoreResolver(t *testing.T) {
	store := auth.NewUserStore(nil)
	resolver := NewUserStoreResolver(store)
	if resolver == nil {
		t.Fatal("expected non-nil resolver")
	}
}

// ── isMarketingNotification ───────────────────────────────────────────────────

func TestIsMarketingNotification(t *testing.T) {
	cases := []struct {
		notifType string
		expected  bool
	}{
		{"trial_expiry", false},
		{"plan_expiry", false},
		{"marketing_news", true},
		{"promo", true},
		{"", true},
	}
	for _, tc := range cases {
		got := isMarketingNotification(tc.notifType)
		if got != tc.expected {
			t.Errorf("isMarketingNotification(%q) = %v, want %v", tc.notifType, got, tc.expected)
		}
	}
}

// ── CheckUserWarning (extra cases) ────────────────────────────────────────────

func TestCheckUserWarning_FreePlan_ExpiredTrial(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour)
	u := expiringUser{
		Plan:        "free",
		TrialEndsAt: &past,
	}
	w := CheckUserWarning(u)
	if w != WarningExpired {
		t.Errorf("expected WarningExpired, got %q", w)
	}
}

func TestCheckUserWarning_FreePlan_TrialExpiringSoon(t *testing.T) {
	soon := time.Now().Add(2 * 24 * time.Hour)
	u := expiringUser{
		Plan:        "free",
		TrialEndsAt: &soon,
	}
	w := CheckUserWarning(u)
	if w != WarningExpiringSoon {
		t.Errorf("expected WarningExpiringSoon, got %q", w)
	}
}

func TestCheckUserWarning_FreePlan_NoTrial(t *testing.T) {
	u := expiringUser{Plan: "free"}
	w := CheckUserWarning(u)
	if w != WarningNone {
		t.Errorf("expected WarningNone, got %q", w)
	}
}

func TestCheckUserWarning_ProPlan_Expired(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour)
	u := expiringUser{
		Plan:          "pro",
		PlanExpiresAt: &past,
	}
	w := CheckUserWarning(u)
	if w != WarningExpired {
		t.Errorf("expected WarningExpired, got %q", w)
	}
}

func TestCheckUserWarning_ProPlan_ExpiringSoon(t *testing.T) {
	soon := time.Now().Add(1 * 24 * time.Hour)
	u := expiringUser{
		Plan:          "pro",
		PlanExpiresAt: &soon,
	}
	w := CheckUserWarning(u)
	if w != WarningExpiringSoon {
		t.Errorf("expected WarningExpiringSoon, got %q", w)
	}
}

func TestCheckUserWarning_ProPlan_NoExpiry(t *testing.T) {
	u := expiringUser{Plan: "pro"}
	w := CheckUserWarning(u)
	if w != WarningNone {
		t.Errorf("expected WarningNone (no expiry set), got %q", w)
	}
}

// ── DaysUntilExpiry ──────────────────────────────────────────────────────────

func TestDaysUntilExpiry_Future(t *testing.T) {
	future := time.Now().Add(5 * 24 * time.Hour)
	days := DaysUntilExpiry(future)
	if days < 4 || days > 5 {
		t.Errorf("expected ~5 days, got %d", days)
	}
}

func TestDaysUntilExpiry_Past(t *testing.T) {
	past := time.Now().Add(-24 * time.Hour)
	days := DaysUntilExpiry(past)
	if days != 0 {
		t.Errorf("expected 0 for past expiry, got %d", days)
	}
}

func TestDaysUntilExpiry_JustExpired(t *testing.T) {
	just := time.Now().Add(-1 * time.Millisecond)
	days := DaysUntilExpiry(just)
	if days != 0 {
		t.Errorf("expected 0 for just-expired, got %d", days)
	}
}

// ── NewPGNotificationStore ────────────────────────────────────────────────────

func TestNewPGNotificationStore(t *testing.T) {
	store := NewPGNotificationStore(nil, nil)
	if store == nil {
		t.Fatal("expected non-nil PGNotificationStore")
	}
}

// ── sendNotification — email error path ───────────────────────────────────────

// mockErrorEmailSender returns an error on SendTrialExpiryEmail.
type mockErrorEmailSender struct {
	configured bool
}

func (m *mockErrorEmailSender) IsConfigured() bool { return m.configured }
func (m *mockErrorEmailSender) SendTrialExpiryEmail(_ string, _ int) error {
	return fmt.Errorf("smtp error")
}

func TestNotifier_SendNotification_EmailError_KeepsRecord(t *testing.T) {
	emailSvc := &mockErrorEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(emailSvc, updater, store)

	past := time.Now().Add(-1 * time.Hour)
	u := expiringUser{
		ID:          "user-email-err",
		Email:       "err@example.com",
		Plan:        "free",
		TrialEndsAt: &past,
	}

	n.sendNotification(u, "trial_expiry", 0)

	// After email failure the notification record is kept to prevent
	// retry-flooding the SMTP server on every notifier cycle.
	if !store.AlreadyNotified(u.ID, "trial_expiry", 0) {
		t.Error("expected notification record kept after email error to prevent retry spam")
	}
}

func TestNotifier_SendNotification_AlreadyNotified_Skips(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()

	// Pre-record the notification.
	store.RecordNotification("user-dup", "trial_expiry", 0)

	n := newTestNotifier(email, updater, store)
	past := time.Now().Add(-1 * time.Hour)
	u := expiringUser{
		ID:          "user-dup",
		Email:       "dup@example.com",
		Plan:        "free",
		TrialEndsAt: &past,
	}

	n.sendNotification(u, "trial_expiry", 0)

	// Should not send a second email.
	if len(email.getSent()) != 0 {
		t.Error("expected no email when already notified")
	}
}

func TestNotifier_SendNotification_EmailNotConfigured_Skips(t *testing.T) {
	email := &mockEmailSender{configured: false}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	past := time.Now().Add(-1 * time.Hour)
	u := expiringUser{
		ID:          "user-nocfg",
		Email:       "nocfg@example.com",
		Plan:        "free",
		TrialEndsAt: &past,
	}

	n.sendNotification(u, "trial_expiry", 0)

	// Email not configured — no email sent.
	if len(email.getSent()) != 0 {
		t.Error("expected no email when email not configured")
	}
}

func TestNotifier_SendNotification_MarketingSkipped_NoConsent(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	u := expiringUser{
		ID:               "user-mkt-noc",
		Email:            "mktno@example.com",
		Plan:             "free",
		MarketingConsent: false,
	}

	// "newsletter" is a marketing type — should be skipped without consent.
	n.sendNotification(u, "newsletter", 0)

	if len(email.getSent()) != 0 {
		t.Error("expected no email for marketing notification without consent")
	}
}

// ── Notifier sendNotification (using existing test helpers) ──────────────────

func TestNotifier_SendNotification_MarketingConsentSkipped(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	// A future trial — WarningExpiringSoon.
	twoDays := time.Now().Add(2 * 24 * time.Hour)
	u := expiringUser{
		ID:               "user-mkt",
		Email:            "mkt@example.com",
		Plan:             "free",
		TrialEndsAt:      &twoDays,
		MarketingConsent: false,
	}

	// sendNotification directly with a marketing type.
	// Since trial_expiry is NOT marketing, test with a hypothetical "newsletter" type
	// by verifying the internal guard logic.
	if isMarketingNotification("trial_expiry") {
		t.Fatal("trial_expiry should not be a marketing notification")
	}

	// Process user — should send trial_expiry (non-marketing, consent not required).
	n.processUser(u)
	sent := email.getSent()
	if len(sent) == 0 {
		t.Error("expected trial_expiry email even without marketing consent")
	}
}

func TestNotifier_ProcessUser_NilExpiresAt(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	// User with no expiry dates — should be a no-op.
	u := expiringUser{
		ID:    "user-noexp",
		Email: "noexp@example.com",
		Plan:  "free",
	}
	n.processUser(u)

	if len(email.getSent()) != 0 {
		t.Error("expected no emails for user with no expiry")
	}
	if len(updater.getUpdates()) != 0 {
		t.Error("expected no plan updates for user with no expiry")
	}
}

// ── NewNotifier / Start / Stop / loop / check / queryExpiringUsers ────────────

func TestNewNotifier_ReturnsNonNil(t *testing.T) {
	pool := badPool(t)
	n := NewNotifier(pool, nil, &mockPlanUpdater{}, zap.NewNop(), time.Hour)
	if n == nil {
		t.Fatal("NewNotifier returned nil")
	}
}

func TestNotifier_StartStop_WithBadDB(t *testing.T) {
	// pool.Query will fail immediately (connection refused) so check() returns
	// quickly without blocking. This covers NewNotifier, Start, Stop, loop,
	// check (error path), and queryExpiringUsers (error path).
	pool := badPool(t)
	n := NewNotifier(pool, &mockEmailSender{}, &mockPlanUpdater{}, zap.NewNop(), time.Hour)
	n.Start()
	n.Stop() // must not hang
}

func TestNotifier_StartStop_MultipleChecks(t *testing.T) {
	// Use a very short interval so loop() fires the ticker at least once.
	pool := badPool(t)
	n := NewNotifier(pool, &mockEmailSender{}, &mockPlanUpdater{}, zap.NewNop(), 5*time.Millisecond)
	n.Start()
	time.Sleep(30 * time.Millisecond) // let the ticker fire a couple times
	n.Stop()
}

// ── PGNotificationStore error paths ──────────────────────────────────────────

func TestPGNotificationStore_AlreadyNotified_DBError(t *testing.T) {
	pool := badPool(t)
	store := NewPGNotificationStore(pool, zap.NewNop())
	// DB fails → returns false (safe default).
	got := store.AlreadyNotified("uid", "trial_expiry", 3)
	if got {
		t.Error("expected false when DB is unavailable")
	}
}

func TestPGNotificationStore_RecordNotification_DBError(t *testing.T) {
	pool := badPool(t)
	store := NewPGNotificationStore(pool, zap.NewNop())
	err := store.RecordNotification("uid", "trial_expiry", 3)
	if err == nil {
		t.Error("expected error when DB is unavailable")
	}
}

func TestPGNotificationStore_RemoveNotification_DBError(t *testing.T) {
	pool := badPool(t)
	store := NewPGNotificationStore(pool, zap.NewNop())
	// RemoveNotification only logs on error — must not panic.
	store.RemoveNotification("uid", "trial_expiry", 3)
}

// ── Notifier.check with error in updater (SetPlan failure) ───────────────────

type failingPlanUpdater struct{}

func (f *failingPlanUpdater) SetPlan(_, _ string, _ *string) error {
	return fmt.Errorf("updater: db down")
}

func TestNotifier_ProcessUser_SetPlanError(t *testing.T) {
	email := &mockEmailSender{configured: true}
	store := newMockNotificationStore()
	n := newTestNotifier(email, &failingPlanUpdater{}, store)

	// Expired pro plan — downgrade will fail but notification still sent.
	past := time.Now().Add(-1 * time.Hour)
	n.processUser(expiringUser{
		ID:            "user-setplan-err",
		Email:         "sp@example.com",
		Plan:          "pro",
		PlanExpiresAt: &past,
	})

	// sendNotification still runs after SetPlan error.
	sent := email.getSent()
	if len(sent) != 1 {
		t.Errorf("expected 1 email after SetPlan error, got %d", len(sent))
	}
}
