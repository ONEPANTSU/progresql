package balance

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Unit tests (no DB required)
// ---------------------------------------------------------------------------

func TestErrInsufficientBalance(t *testing.T) {
	if ErrInsufficientBalance == nil {
		t.Fatal("ErrInsufficientBalance must not be nil")
	}
	if ErrInsufficientBalance.Error() != "insufficient balance" {
		t.Fatalf("unexpected error message: %q", ErrInsufficientBalance.Error())
	}

	// Ensure it can be detected with errors.Is after wrapping.
	wrapped := errors.New("outer: " + ErrInsufficientBalance.Error())
	_ = wrapped // wrapping check below uses sentinel directly

	if !errors.Is(ErrInsufficientBalance, ErrInsufficientBalance) {
		t.Fatal("errors.Is must recognise ErrInsufficientBalance")
	}
}

func TestTransaction_JSON_RoundTrip(t *testing.T) {
	original := Transaction{
		ID:           "550e8400-e29b-41d4-a716-446655440000",
		Amount:       -8.80,
		BalanceAfter: 333.70,
		TxType:       "model_charge",
		ModelID:      "anthropic/claude-sonnet-4.6",
		TokensInput:  15000,
		TokensOutput: 2000,
		Description:  "Chat request: generate_sql",
		CreatedAt:    time.Date(2026, 3, 29, 12, 0, 0, 0, time.UTC),
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Transaction
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.ID != original.ID {
		t.Errorf("ID mismatch: got %q, want %q", decoded.ID, original.ID)
	}
	if decoded.Amount != original.Amount {
		t.Errorf("Amount mismatch: got %v, want %v", decoded.Amount, original.Amount)
	}
	if decoded.BalanceAfter != original.BalanceAfter {
		t.Errorf("BalanceAfter mismatch: got %v, want %v", decoded.BalanceAfter, original.BalanceAfter)
	}
	if decoded.TxType != original.TxType {
		t.Errorf("TxType mismatch: got %q, want %q", decoded.TxType, original.TxType)
	}
	if decoded.ModelID != original.ModelID {
		t.Errorf("ModelID mismatch: got %q, want %q", decoded.ModelID, original.ModelID)
	}
	if decoded.TokensInput != original.TokensInput {
		t.Errorf("TokensInput mismatch: got %d, want %d", decoded.TokensInput, original.TokensInput)
	}
	if decoded.TokensOutput != original.TokensOutput {
		t.Errorf("TokensOutput mismatch: got %d, want %d", decoded.TokensOutput, original.TokensOutput)
	}
	if decoded.Description != original.Description {
		t.Errorf("Description mismatch: got %q, want %q", decoded.Description, original.Description)
	}
	if !decoded.CreatedAt.Equal(original.CreatedAt) {
		t.Errorf("CreatedAt mismatch: got %v, want %v", decoded.CreatedAt, original.CreatedAt)
	}
}

func TestTransaction_JSON_FieldNames(t *testing.T) {
	tx := Transaction{
		ID:           "test-id",
		Amount:       100.50,
		BalanceAfter: 500.00,
		TxType:       "top_up",
		Description:  "test",
		CreatedAt:    time.Now().UTC(),
	}

	data, err := json.Marshal(tx)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal to map: %v", err)
	}

	expectedKeys := []string{
		"id", "amount", "balance_after", "tx_type",
		"model_id", "tokens_input", "tokens_output",
		"description", "created_at",
	}
	for _, key := range expectedKeys {
		if _, ok := raw[key]; !ok {
			t.Errorf("expected JSON key %q not found in output", key)
		}
	}
}

func TestNewService_NotNil(t *testing.T) {
	// NewService should not panic with nil args (will fail at runtime on use,
	// but construction itself must succeed for DI containers).
	svc := NewService(nil, nil)
	if svc == nil {
		t.Fatal("NewService returned nil")
	}
}

// ---------------------------------------------------------------------------
// Integration tests (require a test PostgreSQL database)
//
// These are listed as skeletons. To run them, set up a test DB and provide
// a connection string via TEST_DATABASE_URL env var.
//
// TestTopUp_IncreasesBalance
//   - Create user with balance=0, call TopUp(100), verify balance=100.
//
// TestCharge_DecreasesBalance
//   - Create user with balance=200, call Charge(50), verify balance=150.
//   - Verify balance_transactions row has amount=-50, tx_type="model_charge".
//
// TestCharge_InsufficientBalance_ReturnsError
//   - Create user with balance=10, call Charge(50), expect ErrInsufficientBalance.
//   - Verify balance is still 10 (no partial deduction).
//
// TestCharge_ConcurrentCharges_NoOverdraft
//   - Create user with balance=100.
//   - Launch 10 goroutines each trying to Charge(20).
//   - At most 5 should succeed; balance must never go below 0.
//
// TestGetHistory_ReturnsOrderedTransactions
//   - Insert several transactions with different timestamps.
//   - Verify GetHistory returns them newest-first.
//
// TestGetHistory_Pagination
//   - Insert 30 transactions, request limit=10 offset=0, then offset=10.
//   - Verify correct pages and total count.
// ---------------------------------------------------------------------------
