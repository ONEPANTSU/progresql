package subscription

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// EmailSender is the interface for sending trial expiry emails.
type EmailSender interface {
	IsConfigured() bool
	SendTrialExpiryEmail(toEmail string, daysLeft int) error
}

// PlanUpdater is the interface for updating a user's plan in the database.
type PlanUpdater interface {
	SetPlan(userID, plan string, expiresAt *string) error
}

// NotificationStore persists sent notification records for deduplication.
type NotificationStore interface {
	AlreadyNotified(userID, notifType string, thresholdDays int) bool
	RecordNotification(userID, notifType string, thresholdDays int) error
	RemoveNotification(userID, notifType string, thresholdDays int)
}

// expiringUser holds minimal user info for expiry checks.
type expiringUser struct {
	ID               string
	Email            string
	Plan             string
	PlanExpiresAt    *time.Time
	TrialEndsAt      *time.Time
	MarketingConsent bool
}

// Notifier periodically checks for expiring subscriptions and sends email warnings.
// It also auto-downgrades expired paid plans to free.
type Notifier struct {
	db       *pgxpool.Pool
	email    EmailSender
	updater  PlanUpdater
	log      *zap.Logger
	interval time.Duration
	store    NotificationStore

	stopCh chan struct{}
	done   chan struct{}
}

// NewNotifier creates a Notifier that checks for expiring subscriptions.
// interval is how often to run checks (e.g., 1 hour).
func NewNotifier(db *pgxpool.Pool, email EmailSender, updater PlanUpdater, log *zap.Logger, interval time.Duration) *Notifier {
	return &Notifier{
		db:       db,
		email:    email,
		updater:  updater,
		log:      log,
		interval: interval,
		store:    NewPGNotificationStore(db, log),
		stopCh:   make(chan struct{}),
		done:     make(chan struct{}),
	}
}

// Start begins the background check loop.
func (n *Notifier) Start() {
	go n.loop()
}

// Stop gracefully stops the notifier and waits for the loop to finish.
func (n *Notifier) Stop() {
	close(n.stopCh)
	<-n.done
}

func (n *Notifier) loop() {
	defer close(n.done)

	// Run immediately on start, then on interval.
	n.check()

	ticker := time.NewTicker(n.interval)
	defer ticker.Stop()

	for {
		select {
		case <-n.stopCh:
			return
		case <-ticker.C:
			n.check()
		}
	}
}

func (n *Notifier) check() {
	users, err := n.queryExpiringUsers()
	if err != nil {
		n.log.Error("notifier: failed to query expiring users", zap.Error(err))
		return
	}

	for _, u := range users {
		n.processUser(u)
	}
}

// queryExpiringUsers finds users whose trial or plan expires within 3 days or has already expired.
func (n *Notifier) queryExpiringUsers() ([]expiringUser, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `
		SELECT id, email, plan, plan_expires_at, trial_ends_at, marketing_consent
		FROM users
		WHERE
			(plan = 'free' AND trial_ends_at IS NOT NULL AND trial_ends_at <= NOW() + INTERVAL '3 days')
			OR
			(plan != 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at <= NOW() + INTERVAL '3 days')
	`

	rows, err := n.db.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("querying expiring users: %w", err)
	}
	defer rows.Close()

	var users []expiringUser
	for rows.Next() {
		var u expiringUser
		if err := rows.Scan(&u.ID, &u.Email, &u.Plan, &u.PlanExpiresAt, &u.TrialEndsAt, &u.MarketingConsent); err != nil {
			n.log.Error("notifier: scan error", zap.Error(err))
			continue
		}
		users = append(users, u)
	}

	return users, rows.Err()
}

func (n *Notifier) processUser(u expiringUser) {
	var expiresAt *time.Time
	if u.Plan != "" && u.Plan != string(PlanFree) {
		expiresAt = u.PlanExpiresAt
	} else {
		expiresAt = u.TrialEndsAt
	}

	if expiresAt == nil {
		return
	}

	warning := checkExpiry(time.Now(), *expiresAt)
	daysLeft := DaysUntilExpiry(*expiresAt)

	notifType := "trial_expiry"
	if u.Plan != "" && u.Plan != string(PlanFree) {
		notifType = "plan_expiry"
	}

	switch warning {
	case WarningExpired:
		if u.Plan != "" && u.Plan != string(PlanFree) {
			if err := n.updater.SetPlan(u.ID, string(PlanFree), nil); err != nil {
				n.log.Error("notifier: failed to downgrade expired plan",
					zap.String("user_id", u.ID), zap.Error(err))
			} else {
				n.log.Info("notifier: auto-downgraded expired plan to free",
					zap.String("user_id", u.ID), zap.String("old_plan", u.Plan))
			}
		}
		n.sendNotification(u, notifType, 0)

	case WarningExpiringSoon:
		if daysLeft <= 1 {
			n.sendNotification(u, notifType, 1)
		}
		if daysLeft <= 3 {
			n.sendNotification(u, notifType, 3)
		}
	}
}

// isMarketingNotification returns true for notification types that require marketing consent.
// Service notifications (trial_expiry, plan_expiry) are always sent regardless of consent.
func isMarketingNotification(notifType string) bool {
	switch notifType {
	case "trial_expiry", "plan_expiry":
		return false
	default:
		return true
	}
}

// sendNotification sends an email if not already sent for this threshold.
func (n *Notifier) sendNotification(u expiringUser, notifType string, daysLeft int) {
	// Skip marketing notifications for users who didn't consent.
	if isMarketingNotification(notifType) && !u.MarketingConsent {
		return
	}

	if n.store.AlreadyNotified(u.ID, notifType, daysLeft) {
		return
	}

	if err := n.store.RecordNotification(u.ID, notifType, daysLeft); err != nil {
		n.log.Error("notifier: failed to record notification",
			zap.String("user_id", u.ID), zap.Error(err))
		return
	}

	if n.email == nil || !n.email.IsConfigured() {
		n.log.Debug("notifier: email not configured, skipping notification",
			zap.String("user_id", u.ID), zap.Int("days_left", daysLeft))
		return
	}

	if err := n.email.SendTrialExpiryEmail(u.Email, daysLeft); err != nil {
		n.log.Error("notifier: failed to send expiry email",
			zap.String("user_id", u.ID), zap.String("email", u.Email),
			zap.Int("days_left", daysLeft), zap.Error(err))
		// Do NOT remove the notification record on failure — otherwise the
		// notifier retries every cycle, flooding the SMTP server and getting
		// blocked as spam.  The record stays so we won't attempt again.
	} else {
		n.log.Info("notifier: sent expiry email",
			zap.String("user_id", u.ID), zap.Int("days_left", daysLeft))
	}
}

// CheckUser runs expiry checks for a single user (used during WebSocket connection).
func CheckUserWarning(u expiringUser) SubscriptionWarning {
	var expiresAt *time.Time
	if u.Plan != "" && u.Plan != string(PlanFree) {
		expiresAt = u.PlanExpiresAt
	} else {
		expiresAt = u.TrialEndsAt
	}

	if expiresAt == nil {
		return WarningNone
	}

	return checkExpiry(time.Now(), *expiresAt)
}

// PGNotificationStore implements NotificationStore using PostgreSQL.
type PGNotificationStore struct {
	db  *pgxpool.Pool
	log *zap.Logger
}

// NewPGNotificationStore creates a PostgreSQL-backed notification store.
func NewPGNotificationStore(db *pgxpool.Pool, log *zap.Logger) *PGNotificationStore {
	return &PGNotificationStore{db: db, log: log}
}

func (s *PGNotificationStore) AlreadyNotified(userID, notifType string, thresholdDays int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var exists bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM email_notifications
			WHERE user_id = $1 AND notification_type = $2 AND threshold_days = $3
		)
	`, userID, notifType, thresholdDays).Scan(&exists)
	if err != nil {
		s.log.Error("notifier: failed to check notification history",
			zap.String("user_id", userID), zap.Error(err))
		return false
	}
	return exists
}

func (s *PGNotificationStore) RecordNotification(userID, notifType string, thresholdDays int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := s.db.Exec(ctx, `
		INSERT INTO email_notifications (user_id, notification_type, threshold_days)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, notification_type, threshold_days) DO NOTHING
	`, userID, notifType, thresholdDays)
	return err
}

func (s *PGNotificationStore) RemoveNotification(userID, notifType string, thresholdDays int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := s.db.Exec(ctx, `
		DELETE FROM email_notifications
		WHERE user_id = $1 AND notification_type = $2 AND threshold_days = $3
	`, userID, notifType, thresholdDays)
	if err != nil {
		s.log.Error("notifier: failed to remove notification record",
			zap.String("user_id", userID), zap.Error(err))
	}
}
