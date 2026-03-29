package balance

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// ErrInsufficientBalance is returned when a charge exceeds the user's current balance.
var ErrInsufficientBalance = errors.New("insufficient balance")

// Transaction represents a single balance ledger entry.
type Transaction struct {
	ID           string    `json:"id"`
	Amount       float64   `json:"amount"`
	BalanceAfter float64   `json:"balance_after"`
	TxType       string    `json:"tx_type"`       // "top_up", "model_charge", "over_quota_charge", "refund"
	ModelID      string    `json:"model_id"`       // nullable, set for model-related charges
	TokensInput  int       `json:"tokens_input"`   // nullable
	TokensOutput int       `json:"tokens_output"`  // nullable
	Description  string    `json:"description"`
	CreatedAt    time.Time `json:"created_at"`
}

// Service handles all balance-related operations: top-ups, charges, and history.
type Service struct {
	db     *pgxpool.Pool
	logger *zap.Logger
}

// NewService creates a new balance Service.
func NewService(db *pgxpool.Pool, logger *zap.Logger) *Service {
	return &Service{
		db:     db,
		logger: logger,
	}
}

// GetBalance returns the current balance for the given user.
func (s *Service) GetBalance(ctx context.Context, userID string) (float64, error) {
	var balance float64
	err := s.db.QueryRow(ctx,
		`SELECT balance FROM users WHERE id = $1`, userID,
	).Scan(&balance)
	if err != nil {
		return 0, fmt.Errorf("balance: get balance for user %s: %w", userID, err)
	}
	return balance, nil
}

// TopUp adds funds to the user's balance. Typically called from the payment webhook
// after a confirmed payment. Uses a transaction with row-level locking to prevent
// race conditions on concurrent top-ups.
func (s *Service) TopUp(ctx context.Context, userID string, amount float64, description string) error {
	if amount <= 0 {
		return fmt.Errorf("balance: top-up amount must be positive, got %.6f", amount)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("balance: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock user row and read current balance.
	var currentBalance float64
	err = tx.QueryRow(ctx,
		`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, userID,
	).Scan(&currentBalance)
	if err != nil {
		return fmt.Errorf("balance: lock user %s: %w", userID, err)
	}

	newBalance := currentBalance + amount

	// Update balance.
	_, err = tx.Exec(ctx,
		`UPDATE users SET balance = $1 WHERE id = $2`, newBalance, userID,
	)
	if err != nil {
		return fmt.Errorf("balance: update balance for user %s: %w", userID, err)
	}

	// Record transaction in ledger.
	_, err = tx.Exec(ctx,
		`INSERT INTO balance_transactions (user_id, amount, balance_after, tx_type, description)
		 VALUES ($1, $2, $3, 'top_up', $4)`,
		userID, amount, newBalance, description,
	)
	if err != nil {
		return fmt.Errorf("balance: insert top-up transaction: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("balance: commit top-up: %w", err)
	}

	s.logger.Info("balance topped up",
		zap.String("user_id", userID),
		zap.Float64("amount", amount),
		zap.Float64("new_balance", newBalance),
	)
	return nil
}

// Charge deducts the specified amount from the user's balance. Returns
// ErrInsufficientBalance if the user does not have enough funds.
// Uses SELECT ... FOR UPDATE to prevent concurrent overdraft.
func (s *Service) Charge(ctx context.Context, userID string, amount float64, modelID string, tokensInput, tokensOutput int, description string) error {
	if amount <= 0 {
		return fmt.Errorf("balance: charge amount must be positive, got %.6f", amount)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("balance: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Lock user row and get current balance.
	var currentBalance float64
	err = tx.QueryRow(ctx,
		`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, userID,
	).Scan(&currentBalance)
	if err != nil {
		return fmt.Errorf("balance: lock user %s: %w", userID, err)
	}

	if currentBalance < amount {
		return ErrInsufficientBalance
	}

	newBalance := currentBalance - amount

	// Update balance.
	_, err = tx.Exec(ctx,
		`UPDATE users SET balance = $1 WHERE id = $2`, newBalance, userID,
	)
	if err != nil {
		return fmt.Errorf("balance: update balance for user %s: %w", userID, err)
	}

	// Record transaction in ledger.
	_, err = tx.Exec(ctx,
		`INSERT INTO balance_transactions (user_id, amount, balance_after, tx_type, model_id, tokens_input, tokens_output, description)
		 VALUES ($1, $2, $3, 'model_charge', $4, $5, $6, $7)`,
		userID, -amount, newBalance, modelID, tokensInput, tokensOutput, description,
	)
	if err != nil {
		return fmt.Errorf("balance: insert charge transaction: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("balance: commit charge: %w", err)
	}

	s.logger.Info("balance charged",
		zap.String("user_id", userID),
		zap.Float64("amount", amount),
		zap.Float64("new_balance", newBalance),
		zap.String("model_id", modelID),
	)
	return nil
}

// ChargeOverQuota is like Charge but records the transaction as "over_quota_charge".
// Used when a user exceeds their plan's token quota and pays from balance.
func (s *Service) ChargeOverQuota(ctx context.Context, userID string, amount float64, modelID string, tokensInput, tokensOutput int, description string) error {
	if amount <= 0 {
		return fmt.Errorf("balance: charge amount must be positive, got %.6f", amount)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("balance: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var currentBalance float64
	err = tx.QueryRow(ctx,
		`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, userID,
	).Scan(&currentBalance)
	if err != nil {
		return fmt.Errorf("balance: lock user %s: %w", userID, err)
	}

	if currentBalance < amount {
		return ErrInsufficientBalance
	}

	newBalance := currentBalance - amount

	_, err = tx.Exec(ctx,
		`UPDATE users SET balance = $1 WHERE id = $2`, newBalance, userID,
	)
	if err != nil {
		return fmt.Errorf("balance: update balance for user %s: %w", userID, err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO balance_transactions (user_id, amount, balance_after, tx_type, model_id, tokens_input, tokens_output, description)
		 VALUES ($1, $2, $3, 'over_quota_charge', $4, $5, $6, $7)`,
		userID, -amount, newBalance, modelID, tokensInput, tokensOutput, description,
	)
	if err != nil {
		return fmt.Errorf("balance: insert over-quota transaction: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("balance: commit over-quota charge: %w", err)
	}

	s.logger.Info("over-quota balance charged",
		zap.String("user_id", userID),
		zap.Float64("amount", amount),
		zap.Float64("new_balance", newBalance),
		zap.String("model_id", modelID),
	)
	return nil
}

// Refund credits the specified amount back to the user's balance.
func (s *Service) Refund(ctx context.Context, userID string, amount float64, description string) error {
	if amount <= 0 {
		return fmt.Errorf("balance: refund amount must be positive, got %.6f", amount)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("balance: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var currentBalance float64
	err = tx.QueryRow(ctx,
		`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, userID,
	).Scan(&currentBalance)
	if err != nil {
		return fmt.Errorf("balance: lock user %s: %w", userID, err)
	}

	newBalance := currentBalance + amount

	_, err = tx.Exec(ctx,
		`UPDATE users SET balance = $1 WHERE id = $2`, newBalance, userID,
	)
	if err != nil {
		return fmt.Errorf("balance: update balance for user %s: %w", userID, err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO balance_transactions (user_id, amount, balance_after, tx_type, description)
		 VALUES ($1, $2, $3, 'refund', $4)`,
		userID, amount, newBalance, description,
	)
	if err != nil {
		return fmt.Errorf("balance: insert refund transaction: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("balance: commit refund: %w", err)
	}

	s.logger.Info("balance refunded",
		zap.String("user_id", userID),
		zap.Float64("amount", amount),
		zap.Float64("new_balance", newBalance),
	)
	return nil
}

// GetHistory returns recent balance transactions for the given user, ordered by
// created_at descending (newest first). Returns the page of transactions, the
// total count of all transactions for the user, and any error.
func (s *Service) GetHistory(ctx context.Context, userID string, limit, offset int) ([]Transaction, int, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	// Get total count.
	var total int
	err := s.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM balance_transactions WHERE user_id = $1`, userID,
	).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("balance: count transactions for user %s: %w", userID, err)
	}

	if total == 0 {
		return []Transaction{}, 0, nil
	}

	// Fetch page.
	rows, err := s.db.Query(ctx,
		`SELECT id, amount, balance_after, tx_type,
		        COALESCE(model_id, ''), COALESCE(tokens_input, 0), COALESCE(tokens_output, 0),
		        COALESCE(description, ''), created_at
		   FROM balance_transactions
		  WHERE user_id = $1
		  ORDER BY created_at DESC
		  LIMIT $2 OFFSET $3`,
		userID, limit, offset,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("balance: query transactions for user %s: %w", userID, err)
	}
	defer rows.Close()

	var transactions []Transaction
	for rows.Next() {
		var t Transaction
		if err := rows.Scan(
			&t.ID, &t.Amount, &t.BalanceAfter, &t.TxType,
			&t.ModelID, &t.TokensInput, &t.TokensOutput,
			&t.Description, &t.CreatedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("balance: scan transaction row: %w", err)
		}
		transactions = append(transactions, t)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("balance: iterate transaction rows: %w", err)
	}

	return transactions, total, nil
}
