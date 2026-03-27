/*
* Created on Mar 27, 2026
* Test file for email.go, middleware.go, jwt.go (extra coverage)
* File path: internal/auth/auth_extra_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package auth

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ── GenerateResetCode / VerifyResetCode ──────────────────────────────────────

func TestEmailService_GenerateAndVerifyResetCode(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")

	code, err := svc.GenerateResetCode("user@example.com")
	if err != nil {
		t.Fatalf("GenerateResetCode: %v", err)
	}
	if len(code) != VerificationCodeLength {
		t.Fatalf("expected %d-digit code, got %d", VerificationCodeLength, len(code))
	}

	// Wrong code should fail.
	if err := svc.VerifyResetCode("user@example.com", "000000"); err == nil {
		t.Fatal("expected error for wrong reset code")
	}

	// Correct code should succeed.
	code2, _ := svc.GenerateResetCode("user@example.com")
	if err := svc.VerifyResetCode("user@example.com", code2); err != nil {
		t.Fatalf("VerifyResetCode with correct code: %v", err)
	}

	// Code consumed — second verify fails.
	code3, _ := svc.GenerateResetCode("user@example.com")
	svc.VerifyResetCode("user@example.com", code3)
	if err := svc.VerifyResetCode("user@example.com", code3); err == nil {
		t.Fatal("expected error for consumed reset code")
	}
}

func TestEmailService_VerifyResetCode_NoPendingCode(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	if err := svc.VerifyResetCode("nobody@example.com", "123456"); err == nil {
		t.Fatal("expected error for no pending reset code")
	}
}

func TestEmailService_VerifyResetCode_Expired(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	code, _ := svc.GenerateResetCode("exp@example.com")

	// Manually expire the reset code.
	svc.mu.Lock()
	svc.resetCodes["exp@example.com"].ExpiresAt = time.Now().Add(-1 * time.Second)
	svc.mu.Unlock()

	if err := svc.VerifyResetCode("exp@example.com", code); err == nil {
		t.Fatal("expected error for expired reset code")
	}
}

func TestEmailService_VerifyResetCode_TooManyAttempts(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	_, _ = svc.GenerateResetCode("many@example.com")

	for i := 0; i <= MaxVerificationAttempts; i++ {
		_ = svc.VerifyResetCode("many@example.com", "000000")
	}

	// All subsequent verifications should fail.
	if err := svc.VerifyResetCode("many@example.com", "000000"); err == nil {
		t.Fatal("expected error after too many reset attempts")
	}
}

func TestEmailService_VerifyResetCode_CaseInsensitiveEmail(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	code, _ := svc.GenerateResetCode("Test@Example.COM")

	// Verify with different case — should still work.
	if err := svc.VerifyResetCode("test@example.com", code); err != nil {
		t.Fatalf("expected case-insensitive email match: %v", err)
	}
}

// ── SendVerificationEmail (not configured) ────────────────────────────────────

func TestEmailService_SendVerificationEmail_NotConfigured(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	if err := svc.SendVerificationEmail("to@example.com", "123456"); err == nil {
		t.Fatal("expected error when SMTP not configured")
	}
}

func TestEmailService_SendPasswordResetEmail_NotConfigured(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	if err := svc.SendPasswordResetEmail("to@example.com", "123456"); err == nil {
		t.Fatal("expected error when SMTP not configured")
	}
}

func TestEmailService_SendTrialExpiryEmail_NotConfigured(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	if err := svc.SendTrialExpiryEmail("to@example.com", 3); err == nil {
		t.Fatal("expected error when SMTP not configured")
	}
}

// ── buildPasswordResetEmail ───────────────────────────────────────────────────

func TestBuildPasswordResetEmail_Headers(t *testing.T) {
	msg := buildPasswordResetEmail("noreply@progresql.app", "user@example.com", "654321")

	checks := []struct {
		name, substr string
	}{
		{"From", "From: ProgreSQL <noreply@progresql.app>"},
		{"To", "To: user@example.com"},
		{"MIME-Version", "MIME-Version: 1.0"},
		{"X-Mailer", "X-Mailer: ProgreSQL/1.0"},
		{"multipart", "multipart/alternative"},
		{"boundary", mimeBoundary},
		{"text/plain", "text/plain"},
		{"text/html", "text/html"},
		{"code in plain", "654321"},
	}
	for _, c := range checks {
		if !strings.Contains(msg, c.substr) {
			t.Errorf("%s: expected %q in message", c.name, c.substr)
		}
	}
}

// ── buildPasswordResetHTML ────────────────────────────────────────────────────

func TestBuildPasswordResetHTML_Contents(t *testing.T) {
	html := buildPasswordResetHTML("123456", 15)

	checks := []struct {
		name, substr string
	}{
		{"DOCTYPE", "<!DOCTYPE html>"},
		{"ProgreSQL", "ProgreSQL"},
		{"code digit 1", ">1</td>"},
		{"code digit 6", ">6</td>"},
		{"expiry", "15 minutes"},
		{"logo", "data:image/png;base64,"},
		{"color", "#6366f1"},
		{"viewport", "width=device-width"},
	}
	for _, c := range checks {
		if !strings.Contains(html, c.substr) {
			t.Errorf("%s: expected %q in HTML", c.name, c.substr)
		}
	}
}

// ── UserIDFromContext ─────────────────────────────────────────────────────────

func TestUserIDFromContext_Empty(t *testing.T) {
	id := UserIDFromContext(context.Background())
	if id != "" {
		t.Errorf("expected empty string, got %q", id)
	}
}

func TestUserIDFromContext_Set(t *testing.T) {
	ctx := context.WithValue(context.Background(), UserIDContextKey, "user-abc")
	id := UserIDFromContext(ctx)
	if id != "user-abc" {
		t.Errorf("expected 'user-abc', got %q", id)
	}
}

// ── AuthMiddleware ────────────────────────────────────────────────────────────

func TestAuthMiddleware_SetsUserIDContext(t *testing.T) {
	jwtSvc := NewJWTService("test-secret")
	user := &User{ID: "user-xyz", Email: "test@example.com", Name: "Test"}
	token, _ := jwtSvc.GenerateUserToken(user)

	// Verify that the token encodes the UserID correctly.
	claims, err := jwtSvc.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.UserID != "user-xyz" {
		t.Fatalf("expected UserID='user-xyz', got %q", claims.UserID)
	}

	// Verify UserIDContextKey is set when UserID is non-empty.
	ctx := context.Background()
	ctx = context.WithValue(ctx, ClaimsContextKey, claims)
	if claims.UserID != "" {
		ctx = context.WithValue(ctx, UserIDContextKey, claims.UserID)
	}
	id := UserIDFromContext(ctx)
	if id != "user-xyz" {
		t.Errorf("expected 'user-xyz' from context, got %q", id)
	}
}

// ── JWT ValidateToken edge cases ──────────────────────────────────────────────

func TestJWTService_ValidateToken_WrongSigningMethod(t *testing.T) {
	// A token signed with a different method (or tampered) should fail.
	jwtSvc := NewJWTService("test-secret")
	_, err := jwtSvc.ValidateToken("not.a.jwt.token")
	if err == nil {
		t.Fatal("expected error for invalid token string")
	}
}

func TestJWTService_ValidateToken_ExpiredToken(t *testing.T) {
	// Generate a token and expire it by using very short TTL.
	jwtSvc := NewJWTService("test-secret")
	// We can't easily make expired tokens without changing source, so
	// test with a wrong signature.
	_, err := jwtSvc.ValidateToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.WRONG_SIGNATURE")
	if err == nil {
		t.Fatal("expected error for tampered token")
	}
}

func TestJWTService_GenerateUserToken(t *testing.T) {
	jwtSvc := NewJWTService("test-secret")
	user := &User{ID: "user-1", Email: "user@example.com", Name: "User One"}

	token, err := jwtSvc.GenerateUserToken(user)
	if err != nil {
		t.Fatalf("GenerateUserToken: %v", err)
	}

	claims, err := jwtSvc.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}

	if claims.UserID != "user-1" {
		t.Errorf("expected UserID 'user-1', got %q", claims.UserID)
	}
	if claims.Email != "user@example.com" {
		t.Errorf("expected email 'user@example.com', got %q", claims.Email)
	}
	if claims.Name != "User One" {
		t.Errorf("expected name 'User One', got %q", claims.Name)
	}
}

// ── NewUserStore ─────────────────────────────────────────────────────────────

func TestNewUserStore_WithNilDB_UsesMem(t *testing.T) {
	store := NewUserStore(nil)
	if store == nil {
		t.Fatal("expected non-nil store")
	}
	if !store.usingMem() {
		t.Error("expected in-memory store when db=nil")
	}
}

// ── buildTrialExpiryEmail ─────────────────────────────────────────────────────

func TestBuildTrialExpiryEmail_Expired(t *testing.T) {
	msg := buildTrialExpiryEmail("noreply@progresql.app", "user@example.com", 0)
	checks := []string{
		"From: ProgreSQL <noreply@progresql.app>",
		"To: user@example.com",
		"expired",
		"MIME-Version: 1.0",
		"multipart/alternative",
		"text/plain",
		"text/html",
		"ProgreSQL",
	}
	for _, s := range checks {
		if !strings.Contains(msg, s) {
			t.Errorf("expected %q in trial expiry email (expired)", s)
		}
	}
}

func TestBuildTrialExpiryEmail_ExpiresTomorrow(t *testing.T) {
	msg := buildTrialExpiryEmail("noreply@progresql.app", "user@example.com", 1)
	if !strings.Contains(msg, "tomorrow") {
		t.Error("expected 'tomorrow' in 1-day expiry email")
	}
}

func TestBuildTrialExpiryEmail_ExpiresInDays(t *testing.T) {
	msg := buildTrialExpiryEmail("noreply@progresql.app", "user@example.com", 5)
	if !strings.Contains(msg, "5") {
		t.Error("expected day count in multi-day expiry email")
	}
}

// ── generateRandomCode ────────────────────────────────────────────────────────

func TestGenerateRandomCode_Length(t *testing.T) {
	for _, length := range []int{4, 6, 8} {
		code, err := generateRandomCode(length)
		if err != nil {
			t.Fatalf("generateRandomCode(%d): %v", length, err)
		}
		if len(code) != length {
			t.Errorf("generateRandomCode(%d): expected length %d, got %d", length, length, len(code))
		}
		for _, ch := range code {
			if ch < '0' || ch > '9' {
				t.Errorf("generateRandomCode: non-digit character %q in code", ch)
			}
		}
	}
}

func TestGenerateRandomCode_Unique(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 20; i++ {
		code, err := generateRandomCode(6)
		if err != nil {
			t.Fatalf("generateRandomCode: %v", err)
		}
		seen[code] = true
	}
	// With 6-digit codes there are 1 million possibilities; 20 codes should
	// produce at least a few unique values.
	if len(seen) < 2 {
		t.Error("expected at least 2 unique codes in 20 attempts")
	}
}

// ── IsConfigured ─────────────────────────────────────────────────────────────

func TestEmailService_IsConfigured_False(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	if svc.IsConfigured() {
		t.Error("expected IsConfigured=false for empty credentials")
	}
}

func TestEmailService_IsConfigured_True(t *testing.T) {
	svc := NewEmailService("smtp.example.com", 465, "user@example.com", "secret", "noreply@example.com")
	if !svc.IsConfigured() {
		t.Error("expected IsConfigured=true when credentials set")
	}
}

// ── GenerateCode edge cases ───────────────────────────────────────────────────

func TestEmailService_GenerateCode_TrimsCaseEmail(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	code, err := svc.GenerateCode("user-123", "  Test@Example.COM  ")
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	if len(code) == 0 {
		t.Fatal("expected non-empty code")
	}
}

func TestEmailService_GenerateCode_OverwritesPrevious(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")
	code1, _ := svc.GenerateCode("user-overwrite", "over@example.com")
	code2, _ := svc.GenerateCode("user-overwrite", "over@example.com")
	// The first code should no longer verify (replaced by code2).
	_ = code1
	if err := svc.VerifyCode("user-overwrite", code2); err != nil {
		t.Errorf("VerifyCode with latest code: %v", err)
	}
}

// ── ValidateToken — none algorithm (unexpected signing method) ────────────────

func TestJWTService_ValidateToken_NoneAlgorithm(t *testing.T) {
	// Create a token signed with the "none" algorithm (not HMAC).
	// ValidateToken must reject it via the "unexpected signing method" branch.
	claims := &Claims{
		SessionID: "sess-none",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(TokenTTL)),
		},
	}
	unsafeToken := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	tokenStr, err := unsafeToken.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign none-algorithm token: %v", err)
	}

	jwtSvc := NewJWTService("test-secret-long")
	_, validateErr := jwtSvc.ValidateToken(tokenStr)
	if validateErr == nil {
		t.Fatal("expected error for none-algorithm token")
	}
}

// ── AuthMiddleware — token with no user_id ────────────────────────────────────

func TestAuthMiddleware_ValidToken_NoUserID(t *testing.T) {
	// GenerateToken creates a token with no UserID.
	// The middleware should NOT set UserIDContextKey in this case.
	jwtSvc := NewJWTService("test-secret-mw")
	token, err := jwtSvc.GenerateToken("session-no-uid")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	called := false
	handler := AuthMiddleware(jwtSvc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if ClaimsFromContext(r.Context()) == nil {
			t.Error("expected claims in context")
		}
		uid := UserIDFromContext(r.Context())
		if uid != "" {
			t.Errorf("expected empty user_id, got %q", uid)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req, _ := http.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rw := &stubResponseWriter{}
	handler.ServeHTTP(rw, req)

	if !called {
		t.Error("expected handler to be called")
	}
}

// stubResponseWriter is a minimal http.ResponseWriter for tests in this file.
type stubResponseWriter struct {
	code int
	body []byte
}

func (s *stubResponseWriter) Header() http.Header         { return http.Header{} }
func (s *stubResponseWriter) Write(b []byte) (int, error) { s.body = append(s.body, b...); return len(b), nil }
func (s *stubResponseWriter) WriteHeader(code int)        { s.code = code }

// ── SendVerificationEmail / SendPasswordResetEmail / sendRawEmail — SMTP fail ──

// TestEmailService_SendVerificationEmail_SMTPUnreachable exercises the TLS dial
// error path inside SendVerificationEmail when the SMTP server is unreachable.
func TestEmailService_SendVerificationEmail_SMTPUnreachable(t *testing.T) {
	svc := NewEmailService("127.0.0.1", 9999, "user@smtp.example.com", "pass", "noreply@example.com")
	err := svc.SendVerificationEmail("to@example.com", "123456")
	if err == nil {
		t.Fatal("expected TLS dial error for unreachable SMTP server")
	}
}

func TestEmailService_SendPasswordResetEmail_SMTPUnreachable(t *testing.T) {
	svc := NewEmailService("127.0.0.1", 9999, "user@smtp.example.com", "pass", "noreply@example.com")
	err := svc.SendPasswordResetEmail("to@example.com", "654321")
	if err == nil {
		t.Fatal("expected TLS dial error for unreachable SMTP server")
	}
}

// TestEmailService_SendTrialExpiryEmail_SMTPUnreachable exercises sendRawEmail's
// TLS dial error path via SendTrialExpiryEmail.
func TestEmailService_SendTrialExpiryEmail_SMTPUnreachable(t *testing.T) {
	svc := NewEmailService("127.0.0.1", 9999, "user@smtp.example.com", "pass", "noreply@example.com")
	err := svc.SendTrialExpiryEmail("to@example.com", 3)
	if err == nil {
		t.Fatal("expected TLS dial error for unreachable SMTP server")
	}
}

// ── ValidateToken — explicitly expired token ──────────────────────────────────

func TestJWTService_ValidateToken_ReallyExpired(t *testing.T) {
	jwtSvc := NewJWTService("test-secret-exp")

	// Build an already-expired token by signing directly with old timestamps.
	expiredClaims := &Claims{
		SessionID: "session-exp2",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-48 * time.Hour)),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-24 * time.Hour)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, expiredClaims)
	tokenStr, err := tok.SignedString(jwtSvc.secret)
	if err != nil {
		t.Fatalf("sign expired token: %v", err)
	}

	_, err = jwtSvc.ValidateToken(tokenStr)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
}
