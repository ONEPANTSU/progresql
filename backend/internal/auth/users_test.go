package auth

import (
	"testing"
)

// ── ValidatePassword ─────────────────────────────────────────────────────────

func TestValidatePassword_ValidPassword(t *testing.T) {
	cases := []struct {
		name     string
		password string
	}{
		{"all criteria met", "P@ssw0rd123"},
		{"exactly 8 chars", "Ab1!cdef"},
		{"long password", "MyStr0ng!Passphrase"},
		{"special symbols", "Hello_World1"},
		{"unicode special", "Héllo1!A"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidatePassword(tc.password); err != nil {
				t.Errorf("expected valid, got error: %v", err)
			}
		})
	}
}

func TestValidatePassword_TooShort(t *testing.T) {
	err := ValidatePassword("Ab1!")
	if err == nil {
		t.Fatal("expected error for short password")
	}
}

func TestValidatePassword_MissingUppercase(t *testing.T) {
	err := ValidatePassword("password1!")
	if err == nil {
		t.Fatal("expected error for missing uppercase")
	}
}

func TestValidatePassword_MissingLowercase(t *testing.T) {
	err := ValidatePassword("PASSWORD1!")
	if err == nil {
		t.Fatal("expected error for missing lowercase")
	}
}

func TestValidatePassword_MissingDigit(t *testing.T) {
	err := ValidatePassword("Password!")
	if err == nil {
		t.Fatal("expected error for missing digit")
	}
}

func TestValidatePassword_MissingSpecial(t *testing.T) {
	err := ValidatePassword("Password1")
	if err == nil {
		t.Fatal("expected error for missing special char")
	}
}

func TestValidatePassword_Empty(t *testing.T) {
	err := ValidatePassword("")
	if err == nil {
		t.Fatal("expected error for empty password")
	}
}

// ── PasswordStrength ─────────────────────────────────────────────────────────

func TestPasswordStrength_Weak(t *testing.T) {
	cases := []string{
		"short",      // too short
		"abc",        // too short
		"abcdefgh",   // 8 chars, lower only → score 1
		"abcdefgh12", // lower+digits → score 2
	}
	for _, p := range cases {
		if s := PasswordStrength(p); s != "weak" {
			t.Errorf("PasswordStrength(%q) = %q, want weak", p, s)
		}
	}
}

func TestPasswordStrength_Medium(t *testing.T) {
	cases := []string{
		"abcdef1A",   // lower+upper+digit → score 3
		"abcdef1!",   // lower+digit+special → score 3
	}
	for _, p := range cases {
		if s := PasswordStrength(p); s != "medium" {
			t.Errorf("PasswordStrength(%q) = %q, want medium", p, s)
		}
	}
}

func TestPasswordStrength_Strong(t *testing.T) {
	cases := []string{
		"Abcdef1!",        // upper+lower+digit+special → score 4
		"Abcdef1!longer",  // upper+lower+digit+special+length → score 5
		"P@ssw0rd123",     // classic strong
	}
	for _, p := range cases {
		if s := PasswordStrength(p); s != "strong" {
			t.Errorf("PasswordStrength(%q) = %q, want strong", p, s)
		}
	}
}

// ── UserStore (in-memory) ────────────────────────────────────────────────────

func TestUserStore_Register(t *testing.T) {
	store := NewUserStore(nil)

	user, err := store.Register("Alice", "alice@example.com", "P@ssw0rd123", true)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if user.ID == "" {
		t.Error("expected non-empty ID")
	}
	if user.Email != "alice@example.com" {
		t.Errorf("email: got %q", user.Email)
	}
	if user.Name != "Alice" {
		t.Errorf("name: got %q", user.Name)
	}
	if user.Plan != "free" {
		t.Errorf("plan: got %q", user.Plan)
	}
}

func TestUserStore_Register_EmptyEmail(t *testing.T) {
	store := NewUserStore(nil)
	_, err := store.Register("Alice", "", "P@ssw0rd123", false)
	if err == nil {
		t.Fatal("expected error for empty email")
	}
}

func TestUserStore_Register_WeakPassword(t *testing.T) {
	store := NewUserStore(nil)
	_, err := store.Register("Alice", "alice@example.com", "weak", false)
	if err == nil {
		t.Fatal("expected error for weak password")
	}
}

func TestUserStore_Register_DuplicateUnverified(t *testing.T) {
	store := NewUserStore(nil)
	_, err := store.Register("Alice", "alice@example.com", "P@ssw0rd123", false)
	if err != nil {
		t.Fatalf("first register: %v", err)
	}
	// Re-register unverified should succeed (updates credentials).
	user2, err := store.Register("Alice2", "alice@example.com", "N3wP@sswd!", false)
	if err != nil {
		t.Fatalf("re-register unverified: %v", err)
	}
	if user2.Name != "Alice2" {
		t.Errorf("expected updated name, got %q", user2.Name)
	}
}

func TestUserStore_Register_DuplicateVerified(t *testing.T) {
	store := NewUserStore(nil)
	user, err := store.Register("Alice", "alice@example.com", "P@ssw0rd123", false)
	if err != nil {
		t.Fatalf("first register: %v", err)
	}
	if err := store.SetEmailVerified(user.ID); err != nil {
		t.Fatalf("verify: %v", err)
	}
	_, err = store.Register("Alice", "alice@example.com", "P@ssw0rd123", false)
	if err != ErrEmailAlreadyVerified {
		t.Errorf("expected ErrEmailAlreadyVerified, got %v", err)
	}
}

func TestUserStore_Authenticate(t *testing.T) {
	store := NewUserStore(nil)
	_, err := store.Register("Bob", "bob@example.com", "P@ssw0rd123", false)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	user, err := store.Authenticate("bob@example.com", "P@ssw0rd123")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if user.Email != "bob@example.com" {
		t.Errorf("email: got %q", user.Email)
	}
}

func TestUserStore_Authenticate_WrongPassword(t *testing.T) {
	store := NewUserStore(nil)
	store.Register("Bob", "bob@example.com", "P@ssw0rd123", false)

	_, err := store.Authenticate("bob@example.com", "wrongpassword")
	if err != ErrInvalidPassword {
		t.Errorf("expected ErrInvalidPassword, got %v", err)
	}
}

func TestUserStore_Authenticate_NotFound(t *testing.T) {
	store := NewUserStore(nil)
	_, err := store.Authenticate("nobody@example.com", "P@ssw0rd123")
	if err != ErrUserNotFound {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestUserStore_GetByID(t *testing.T) {
	store := NewUserStore(nil)
	user, _ := store.Register("Carol", "carol@example.com", "P@ssw0rd123", false)

	got, err := store.GetByID(user.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.Email != "carol@example.com" {
		t.Errorf("email: got %q", got.Email)
	}
}

func TestUserStore_GetByID_NotFound(t *testing.T) {
	store := NewUserStore(nil)
	_, err := store.GetByID("nonexistent-id")
	if err != ErrUserNotFound {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestUserStore_GetByEmail(t *testing.T) {
	store := NewUserStore(nil)
	store.Register("Dave", "dave@example.com", "P@ssw0rd123", false)

	got, err := store.GetByEmail("dave@example.com")
	if err != nil {
		t.Fatalf("GetByEmail: %v", err)
	}
	if got.Name != "Dave" {
		t.Errorf("name: got %q", got.Name)
	}
}

func TestUserStore_GetByEmail_CaseInsensitive(t *testing.T) {
	store := NewUserStore(nil)
	store.Register("Eve", "Eve@Example.COM", "P@ssw0rd123", false)

	got, err := store.GetByEmail("eve@example.com")
	if err != nil {
		t.Fatalf("GetByEmail case: %v", err)
	}
	if got.Name != "Eve" {
		t.Errorf("name: got %q", got.Name)
	}
}

func TestUserStore_SetEmailVerified(t *testing.T) {
	store := NewUserStore(nil)
	user, _ := store.Register("Frank", "frank@example.com", "P@ssw0rd123", false)

	if err := store.SetEmailVerified(user.ID); err != nil {
		t.Fatalf("SetEmailVerified: %v", err)
	}
	got, _ := store.GetByID(user.ID)
	if !got.EmailVerified {
		t.Error("expected EmailVerified=true")
	}
}

func TestUserStore_SetEmailVerified_NotFound(t *testing.T) {
	store := NewUserStore(nil)
	err := store.SetEmailVerified("nonexistent")
	if err != ErrUserNotFound {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestUserStore_SetPlan(t *testing.T) {
	store := NewUserStore(nil)
	user, _ := store.Register("Grace", "grace@example.com", "P@ssw0rd123", false)

	exp := "2026-12-31T00:00:00Z"
	if err := store.SetPlan(user.ID, "pro", &exp); err != nil {
		t.Fatalf("SetPlan: %v", err)
	}
	got, _ := store.GetByID(user.ID)
	if got.Plan != "pro" {
		t.Errorf("plan: got %q", got.Plan)
	}
}

func TestUserStore_SetPlan_NotFound(t *testing.T) {
	store := NewUserStore(nil)
	err := store.SetPlan("nonexistent", "pro", nil)
	if err != ErrUserNotFound {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestUserStore_UpdatePassword(t *testing.T) {
	store := NewUserStore(nil)
	user, _ := store.Register("Heidi", "heidi@example.com", "P@ssw0rd123", false)

	if err := store.UpdatePassword(user.ID, "N3wP@sswd!"); err != nil {
		t.Fatalf("UpdatePassword: %v", err)
	}
	// Old password should fail.
	if _, err := store.Authenticate("heidi@example.com", "P@ssw0rd123"); err == nil {
		t.Error("expected auth failure with old password")
	}
	// New password should work.
	if _, err := store.Authenticate("heidi@example.com", "N3wP@sswd!"); err != nil {
		t.Errorf("expected auth success with new password: %v", err)
	}
}

func TestUserStore_UpdatePassword_WeakPassword(t *testing.T) {
	store := NewUserStore(nil)
	user, _ := store.Register("Ivan", "ivan@example.com", "P@ssw0rd123", false)

	err := store.UpdatePassword(user.ID, "weak")
	if err == nil {
		t.Fatal("expected error for weak new password")
	}
}

func TestUserStore_UpdatePassword_NotFound(t *testing.T) {
	store := NewUserStore(nil)
	err := store.UpdatePassword("nonexistent", "N3wP@sswd!")
	if err != ErrUserNotFound {
		t.Errorf("expected ErrUserNotFound, got %v", err)
	}
}

func TestNewInMemoryUserStore(t *testing.T) {
	store := NewInMemoryUserStore()
	if store == nil {
		t.Fatal("expected non-nil store")
	}
	user, err := store.Register("Test", "test@example.com", "P@ssw0rd123", false)
	if err != nil || user == nil {
		t.Fatalf("Register on NewInMemoryUserStore: %v", err)
	}
}
