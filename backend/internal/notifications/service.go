package notifications

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// EmailSender abstracts the ability to send an HTML email.
type EmailSender interface {
	SendEmail(to, subject, htmlBody string) error
}

// userInfo holds the minimal user data needed for sending notifications.
type userInfo struct {
	Email string
	Name  string
	Lang  string // "ru" or "en"; default "ru"
}

// Service sends branded email notifications with deduplication.
type Service struct {
	db     *pgxpool.Pool
	email  EmailSender
	logger *zap.Logger
}

// NewService creates a notification service.
func NewService(db *pgxpool.Pool, email EmailSender, logger *zap.Logger) *Service {
	return &Service{
		db:     db,
		email:  email,
		logger: logger,
	}
}

// ---------- public methods ----------

// NotifyQuotaWarning sends an email if a warning for this quota type has not yet been sent
// in the current billing period (threshold_days = usedPct to make the dedup key unique per level).
func (s *Service) NotifyQuotaWarning(ctx context.Context, userID, quotaType string, usedPct int, remaining int64) error {
	notifType := fmt.Sprintf("quota_warning_%s", quotaType)
	threshold := usedPct // use pct as threshold so 80% and 90% are separate entries

	if s.alreadyNotified(ctx, userID, notifType, threshold) {
		return nil
	}

	u, err := s.fetchUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("fetch user for quota warning: %w", err)
	}

	subject := "ProgreSQL — Quota Warning"
	if u.Lang != "en" {
		subject = "ProgreSQL — Предупреждение о квоте"
	}

	html := QuotaWarningEmail(u.Lang, quotaType, usedPct, remaining)

	if err := s.sendAndRecord(ctx, userID, u.Email, notifType, threshold, subject, html); err != nil {
		return err
	}
	return nil
}

// NotifyQuotaExhausted sends an email if not already sent for this period.
func (s *Service) NotifyQuotaExhausted(ctx context.Context, userID, quotaType string) error {
	notifType := fmt.Sprintf("quota_exhausted_%s", quotaType)
	threshold := 100

	if s.alreadyNotified(ctx, userID, notifType, threshold) {
		return nil
	}

	u, err := s.fetchUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("fetch user for quota exhausted: %w", err)
	}

	subject := "ProgreSQL — Quota Exhausted"
	if u.Lang != "en" {
		subject = "ProgreSQL — Квота исчерпана"
	}

	html := QuotaExhaustedEmail(u.Lang, quotaType)

	return s.sendAndRecord(ctx, userID, u.Email, notifType, threshold, subject, html)
}

// NotifyBalanceLow sends an email at most once per day.
func (s *Service) NotifyBalanceLow(ctx context.Context, userID string, balance float64) error {
	notifType := "balance_low"
	// Use current day as threshold for daily dedup.
	threshold := dayNumber()

	if s.alreadyNotified(ctx, userID, notifType, threshold) {
		return nil
	}

	u, err := s.fetchUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("fetch user for balance low: %w", err)
	}

	subject := "ProgreSQL — Low Balance"
	if u.Lang != "en" {
		subject = "ProgreSQL — Низкий баланс"
	}

	html := BalanceLowEmail(u.Lang, balance)

	return s.sendAndRecord(ctx, userID, u.Email, notifType, threshold, subject, html)
}

// NotifyBalanceDepleted sends an email when balance reaches zero.
func (s *Service) NotifyBalanceDepleted(ctx context.Context, userID string) error {
	notifType := "balance_depleted"
	threshold := dayNumber()

	if s.alreadyNotified(ctx, userID, notifType, threshold) {
		return nil
	}

	u, err := s.fetchUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("fetch user for balance depleted: %w", err)
	}

	subject := "ProgreSQL — Balance Depleted"
	if u.Lang != "en" {
		subject = "ProgreSQL — Баланс исчерпан"
	}

	html := BalanceDepletedEmail(u.Lang)

	return s.sendAndRecord(ctx, userID, u.Email, notifType, threshold, subject, html)
}

// NotifyBalanceTopUp sends a confirmation email (always sent, no dedup).
func (s *Service) NotifyBalanceTopUp(ctx context.Context, userID string, amount, newBalance float64) error {
	u, err := s.fetchUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("fetch user for balance topup: %w", err)
	}

	subject := "ProgreSQL — Balance Top-Up Confirmed"
	if u.Lang != "en" {
		subject = "ProgreSQL — Баланс пополнен"
	}

	html := BalanceTopUpConfirmEmail(u.Lang, amount, newBalance)

	if err := s.email.SendEmail(u.Email, subject, html); err != nil {
		s.logger.Error("notifications: failed to send balance topup email",
			zap.String("user_id", userID), zap.Error(err))
		return fmt.Errorf("send balance topup email: %w", err)
	}

	s.logger.Info("notifications: sent balance topup email",
		zap.String("user_id", userID), zap.Float64("amount", amount))
	return nil
}

// NotifyWelcome sends a welcome email after registration.
func (s *Service) NotifyWelcome(ctx context.Context, userID, email, name string) error {
	notifType := "welcome"
	threshold := 0

	if s.alreadyNotified(ctx, userID, notifType, threshold) {
		return nil
	}

	// For welcome emails the caller provides email/name directly since the user
	// was just created and the DB row might not be fully available yet.
	lang := "ru" // default

	subject := "Добро пожаловать в ProgreSQL!"
	html := WelcomeEmail(lang, name)

	return s.sendAndRecord(ctx, userID, email, notifType, threshold, subject, html)
}

// NotifySubscriptionActivated sends an email after plan purchase.
func (s *Service) NotifySubscriptionActivated(ctx context.Context, userID, planName string, expiresAt time.Time) error {
	notifType := "subscription_activated"
	threshold := 0

	u, err := s.fetchUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("fetch user for subscription activated: %w", err)
	}

	subject := "ProgreSQL — Subscription Activated"
	if u.Lang != "en" {
		subject = "ProgreSQL — Подписка активирована"
	}

	html := SubscriptionActivatedEmail(u.Lang, planName, expiresAt)

	return s.sendAndRecord(ctx, userID, u.Email, notifType, threshold, subject, html)
}

// ---------- internal helpers ----------

// fetchUser loads email, name, and locale for a given user ID.
func (s *Service) fetchUser(ctx context.Context, userID string) (userInfo, error) {
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var u userInfo
	err := s.db.QueryRow(qctx, `
		SELECT email, name FROM users WHERE id = $1
	`, userID).Scan(&u.Email, &u.Name)
	if err != nil {
		return u, fmt.Errorf("querying user %s: %w", userID, err)
	}

	// The users table does not store a locale column yet.
	// Default to Russian; can be extended later.
	u.Lang = "ru"

	return u, nil
}

// alreadyNotified checks the email_notifications table for deduplication.
func (s *Service) alreadyNotified(ctx context.Context, userID, notifType string, threshold int) bool {
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var exists bool
	err := s.db.QueryRow(qctx, `
		SELECT EXISTS(
			SELECT 1 FROM email_notifications
			WHERE user_id = $1 AND notification_type = $2 AND threshold_days = $3
		)
	`, userID, notifType, threshold).Scan(&exists)
	if err != nil {
		s.logger.Error("notifications: dedup check failed",
			zap.String("user_id", userID),
			zap.String("type", notifType),
			zap.Error(err))
		return false
	}
	return exists
}

// recordNotification inserts a dedup record into email_notifications.
func (s *Service) recordNotification(ctx context.Context, userID, notifType string, threshold int) error {
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := s.db.Exec(qctx, `
		INSERT INTO email_notifications (user_id, notification_type, threshold_days)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, notification_type, threshold_days) DO NOTHING
	`, userID, notifType, threshold)
	return err
}

// removeNotification deletes a dedup record (used on send failure for rollback).
func (s *Service) removeNotification(ctx context.Context, userID, notifType string, threshold int) {
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := s.db.Exec(qctx, `
		DELETE FROM email_notifications
		WHERE user_id = $1 AND notification_type = $2 AND threshold_days = $3
	`, userID, notifType, threshold)
	if err != nil {
		s.logger.Error("notifications: failed to remove notification record",
			zap.String("user_id", userID), zap.Error(err))
	}
}

// sendAndRecord records, sends, and rolls back the record on failure.
func (s *Service) sendAndRecord(ctx context.Context, userID, email, notifType string, threshold int, subject, html string) error {
	if err := s.recordNotification(ctx, userID, notifType, threshold); err != nil {
		s.logger.Error("notifications: failed to record notification",
			zap.String("user_id", userID),
			zap.String("type", notifType),
			zap.Error(err))
		return fmt.Errorf("record notification: %w", err)
	}

	if err := s.email.SendEmail(email, subject, html); err != nil {
		s.logger.Error("notifications: failed to send email",
			zap.String("user_id", userID),
			zap.String("type", notifType),
			zap.String("email", email),
			zap.Error(err))
		s.removeNotification(ctx, userID, notifType, threshold)
		return fmt.Errorf("send email [%s]: %w", notifType, err)
	}

	s.logger.Info("notifications: sent email",
		zap.String("user_id", userID),
		zap.String("type", notifType))
	return nil
}

// dayNumber returns the current day as an integer (days since Unix epoch),
// used for daily deduplication of balance-related notifications.
func dayNumber() int {
	return int(time.Now().Unix() / 86400)
}
