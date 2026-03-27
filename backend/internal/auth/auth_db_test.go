package auth

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// badDBPool returns a pgxpool that will fail on every query (connection refused
// on 127.0.0.1:9999). This lets us exercise the DB code paths without a real
// PostgreSQL instance.
func badDBPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(),
		"postgres://x:x@127.0.0.1:9999/testdb?sslmode=disable")
	if err != nil {
		t.Skipf("could not create bad pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// badDBStore returns a UserStore backed by a non-connecting pool.
func badDBStore(t *testing.T) *UserStore {
	t.Helper()
	return NewUserStore(badDBPool(t))
}

// ── NewUserStore with non-nil DB ──────────────────────────────────────────────

func TestNewUserStore_WithNonNilDB_NotMem(t *testing.T) {
	pool := badDBPool(t)
	store := NewUserStore(pool)
	if store == nil {
		t.Fatal("expected non-nil store")
	}
	if store.usingMem() {
		t.Error("expected DB store (not in-memory) when db is non-nil")
	}
}

// ── Register — DB error path ─────────────────────────────────────────────────

func TestRegister_DBError(t *testing.T) {
	store := badDBStore(t)
	_, err := store.Register("Test", "test-dberr@example.com", "P@ssw0rd123", false)
	// Pool can't connect → should return an error (not panic).
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

func TestRegister_EmptyEmail_DBPath(t *testing.T) {
	store := badDBStore(t)
	_, err := store.Register("Test", "", "P@ssw0rd123", false)
	if err == nil {
		t.Fatal("expected error for empty email")
	}
}

func TestRegister_InvalidPassword_DBPath(t *testing.T) {
	store := badDBStore(t)
	_, err := store.Register("Test", "valid@example.com", "weak", false)
	if err == nil {
		t.Fatal("expected error for weak password")
	}
}

// ── Authenticate — DB error path ─────────────────────────────────────────────

func TestAuthenticate_DBError(t *testing.T) {
	store := badDBStore(t)
	_, err := store.Authenticate("test@example.com", "P@ssw0rd123")
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

// ── GetByID — DB error path ───────────────────────────────────────────────────

func TestGetByID_DBError(t *testing.T) {
	store := badDBStore(t)
	_, err := store.GetByID("some-user-id")
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

// ── GetByEmail — DB error path ────────────────────────────────────────────────

func TestGetByEmail_DBError(t *testing.T) {
	store := badDBStore(t)
	_, err := store.GetByEmail("user@example.com")
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

// ── SetEmailVerified — DB error path ──────────────────────────────────────────

func TestSetEmailVerified_DBError(t *testing.T) {
	store := badDBStore(t)
	err := store.SetEmailVerified("user-id-123")
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

// ── SetPlan — DB error path ───────────────────────────────────────────────────

func TestSetPlan_DBError_NilExpiry(t *testing.T) {
	store := badDBStore(t)
	err := store.SetPlan("user-id-123", "pro", nil)
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

func TestSetPlan_DBError_WithExpiry(t *testing.T) {
	store := badDBStore(t)
	exp := "2026-12-31T00:00:00Z"
	err := store.SetPlan("user-id-123", "pro", &exp)
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

// ── UpdatePassword — DB error path ────────────────────────────────────────────

func TestUpdatePassword_DBError(t *testing.T) {
	store := badDBStore(t)
	err := store.UpdatePassword("user-id-123", "NewP@ssw0rd123")
	if err == nil {
		t.Fatal("expected error when DB is unavailable")
	}
}

func TestUpdatePassword_WeakPassword_DBPath(t *testing.T) {
	store := badDBStore(t)
	err := store.UpdatePassword("user-id-123", "weak")
	if err == nil {
		t.Fatal("expected error for weak password")
	}
}
