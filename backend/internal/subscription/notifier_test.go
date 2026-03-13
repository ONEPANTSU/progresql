package subscription

import (
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"
)

// mockEmailSender records sent emails for verification.
type mockEmailSender struct {
	mu         sync.Mutex
	configured bool
	sent       []sentEmail
}

type sentEmail struct {
	Email    string
	DaysLeft int
}

func (m *mockEmailSender) IsConfigured() bool { return m.configured }

func (m *mockEmailSender) SendTrialExpiryEmail(toEmail string, daysLeft int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, sentEmail{Email: toEmail, DaysLeft: daysLeft})
	return nil
}

func (m *mockEmailSender) getSent() []sentEmail {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]sentEmail, len(m.sent))
	copy(cp, m.sent)
	return cp
}

// mockPlanUpdater records plan updates.
type mockPlanUpdater struct {
	mu      sync.Mutex
	updates []planUpdate
}

type planUpdate struct {
	UserID    string
	Plan      string
	ExpiresAt *string
}

func (m *mockPlanUpdater) SetPlan(userID, plan string, expiresAt *string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.updates = append(m.updates, planUpdate{UserID: userID, Plan: plan, ExpiresAt: expiresAt})
	return nil
}

func (m *mockPlanUpdater) getUpdates() []planUpdate {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]planUpdate, len(m.updates))
	copy(cp, m.updates)
	return cp
}

// mockNotificationStore is an in-memory implementation of NotificationStore for testing.
type mockNotificationStore struct {
	mu       sync.Mutex
	notified map[string]bool // key: "userID|notifType|threshold"
}

func newMockNotificationStore() *mockNotificationStore {
	return &mockNotificationStore{notified: make(map[string]bool)}
}

func (m *mockNotificationStore) key(userID, notifType string, thresholdDays int) string {
	return userID + "|" + notifType + "|" + string(rune('0'+thresholdDays))
}

func (m *mockNotificationStore) AlreadyNotified(userID, notifType string, thresholdDays int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.notified[m.key(userID, notifType, thresholdDays)]
}

func (m *mockNotificationStore) RecordNotification(userID, notifType string, thresholdDays int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.notified[m.key(userID, notifType, thresholdDays)] = true
	return nil
}

func (m *mockNotificationStore) RemoveNotification(userID, notifType string, thresholdDays int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.notified, m.key(userID, notifType, thresholdDays))
}

func newTestNotifier(email EmailSender, updater PlanUpdater, store NotificationStore) *Notifier {
	return &Notifier{
		email:   email,
		updater: updater,
		log:     zap.NewNop(),
		store:   store,
	}
}

func TestNotifier_ProcessUser_ExpiredProPlan_Downgrades(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	past := time.Now().Add(-1 * time.Hour)
	n.processUser(expiringUser{
		ID:            "user-1",
		Email:         "test@example.com",
		Plan:          "pro",
		PlanExpiresAt: &past,
	})

	// Should have been downgraded.
	updates := updater.getUpdates()
	if len(updates) != 1 {
		t.Fatalf("expected 1 plan update, got %d", len(updates))
	}
	if updates[0].Plan != "free" {
		t.Errorf("expected downgrade to free, got %q", updates[0].Plan)
	}

	// Should have sent expired notification.
	sent := email.getSent()
	if len(sent) != 1 {
		t.Fatalf("expected 1 email, got %d", len(sent))
	}
	if sent[0].DaysLeft != 0 {
		t.Errorf("expected daysLeft=0, got %d", sent[0].DaysLeft)
	}
}

func TestNotifier_ProcessUser_ExpiringSoon_SendsWarning(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	// Trial expiring in 2.5 days — daysLeft=2, triggers 3-day threshold only.
	twoAndHalf := time.Now().Add(2*24*time.Hour + 12*time.Hour)
	n.processUser(expiringUser{
		ID:          "user-2",
		Email:       "trial@example.com",
		Plan:        "free",
		TrialEndsAt: &twoAndHalf,
	})

	sent := email.getSent()
	if len(sent) != 1 {
		t.Fatalf("expected 1 email, got %d", len(sent))
	}
	if sent[0].DaysLeft != 3 {
		t.Errorf("expected daysLeft=3, got %d", sent[0].DaysLeft)
	}

	// No plan update for trial expiry (still "free").
	if len(updater.getUpdates()) != 0 {
		t.Error("should not downgrade already-free plan")
	}
}

func TestNotifier_ProcessUser_ExpiringSoon_1Day(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	// Trial expiring in 12 hours — should send both 3-day and 1-day warnings.
	halfDay := time.Now().Add(12 * time.Hour)
	n.processUser(expiringUser{
		ID:          "user-3",
		Email:       "urgent@example.com",
		Plan:        "free",
		TrialEndsAt: &halfDay,
	})

	sent := email.getSent()
	if len(sent) != 2 {
		t.Fatalf("expected 2 emails (1-day + 3-day), got %d", len(sent))
	}
}

func TestNotifier_Deduplication(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	twoAndHalf := time.Now().Add(2*24*time.Hour + 12*time.Hour)
	user := expiringUser{
		ID:          "user-4",
		Email:       "dedup@example.com",
		Plan:        "free",
		TrialEndsAt: &twoAndHalf,
	}

	// Process twice — should only send one email (3-day threshold deduplicated).
	n.processUser(user)
	n.processUser(user)

	sent := email.getSent()
	if len(sent) != 1 {
		t.Fatalf("expected 1 email (deduplication), got %d", len(sent))
	}
}

func TestNotifier_NoEmail_WhenNotConfigured(t *testing.T) {
	email := &mockEmailSender{configured: false}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	twoDays := time.Now().Add(2 * 24 * time.Hour)
	n.processUser(expiringUser{
		ID:          "user-5",
		Email:       "nocfg@example.com",
		Plan:        "free",
		TrialEndsAt: &twoDays,
	})

	// No email sent (not configured).
	sent := email.getSent()
	if len(sent) != 0 {
		t.Errorf("expected 0 emails when not configured, got %d", len(sent))
	}
}

func TestNotifier_FreePlan_ExpiredTrial_NoDowngrade(t *testing.T) {
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()
	n := newTestNotifier(email, updater, store)

	past := time.Now().Add(-1 * time.Hour)
	n.processUser(expiringUser{
		ID:          "user-6",
		Email:       "expired-trial@example.com",
		Plan:        "free",
		TrialEndsAt: &past,
	})

	// Should NOT downgrade (already free).
	if len(updater.getUpdates()) != 0 {
		t.Error("should not downgrade already-free plan")
	}

	// Should send expired notification.
	sent := email.getSent()
	if len(sent) != 1 {
		t.Fatalf("expected 1 email for expired trial, got %d", len(sent))
	}
}

func TestNotifier_DeduplicationSurvivesRestart(t *testing.T) {
	// Simulate restart: same store shared between two Notifier instances.
	email := &mockEmailSender{configured: true}
	updater := &mockPlanUpdater{}
	store := newMockNotificationStore()

	twoAndHalf := time.Now().Add(2*24*time.Hour + 12*time.Hour)
	user := expiringUser{
		ID:          "user-7",
		Email:       "restart@example.com",
		Plan:        "free",
		TrialEndsAt: &twoAndHalf,
	}

	// First "instance" sends notification.
	n1 := newTestNotifier(email, updater, store)
	n1.processUser(user)

	// Second "instance" (simulating restart) with the SAME store.
	n2 := newTestNotifier(email, updater, store)
	n2.processUser(user)

	// Only 1 email — second instance sees the record in the store.
	sent := email.getSent()
	if len(sent) != 1 {
		t.Fatalf("expected 1 email (dedup across restart), got %d", len(sent))
	}
}

func TestCheckUserWarning(t *testing.T) {
	tests := []struct {
		name     string
		user     expiringUser
		expected SubscriptionWarning
	}{
		{
			name:     "no expiry",
			user:     expiringUser{Plan: "free"},
			expected: WarningNone,
		},
		{
			name: "trial expiring soon",
			user: expiringUser{
				Plan:        "free",
				TrialEndsAt: timePtr(time.Now().Add(1 * 24 * time.Hour)),
			},
			expected: WarningExpiringSoon,
		},
		{
			name: "pro plan expired",
			user: expiringUser{
				Plan:          "pro",
				PlanExpiresAt: timePtr(time.Now().Add(-1 * time.Hour)),
			},
			expected: WarningExpired,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CheckUserWarning(tt.user)
			if got != tt.expected {
				t.Errorf("CheckUserWarning: expected %q, got %q", tt.expected, got)
			}
		})
	}
}

func timePtr(t time.Time) *time.Time { return &t }
