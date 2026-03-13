package auth

import (
	"strings"
	"testing"
	"time"
)

func TestGenerateRandomCode(t *testing.T) {
	code, err := generateRandomCode(6)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(code) != 6 {
		t.Fatalf("expected 6 chars, got %d", len(code))
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			t.Fatalf("expected only digits, got %c", c)
		}
	}
}

func TestEmailService_GenerateAndVerify(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")

	code, err := svc.GenerateCode("user1", "test@example.com")
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	if len(code) != VerificationCodeLength {
		t.Fatalf("expected %d-digit code, got %d", VerificationCodeLength, len(code))
	}

	// Wrong code should fail.
	if err := svc.VerifyCode("user1", "000000"); err == nil {
		t.Fatal("expected error for wrong code")
	}

	// Correct code should succeed.
	if err := svc.VerifyCode("user1", code); err != nil {
		t.Fatalf("VerifyCode: %v", err)
	}

	// Code should be consumed — second verify fails.
	if err := svc.VerifyCode("user1", code); err == nil {
		t.Fatal("expected error for consumed code")
	}
}

func TestEmailService_CodeExpiry(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")

	code, _ := svc.GenerateCode("user2", "test@example.com")

	// Manually expire the code.
	svc.mu.Lock()
	svc.codes["user2"].ExpiresAt = time.Now().Add(-1 * time.Second)
	svc.mu.Unlock()

	if err := svc.VerifyCode("user2", code); err == nil {
		t.Fatal("expected error for expired code")
	}
}

func TestEmailService_MaxAttempts(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")

	_, _ = svc.GenerateCode("user3", "test@example.com")

	for i := 0; i < MaxVerificationAttempts; i++ {
		_ = svc.VerifyCode("user3", "000000")
	}

	// Next attempt should fail with "too many attempts".
	err := svc.VerifyCode("user3", "000000")
	if err == nil {
		t.Fatal("expected error for too many attempts")
	}
}

func TestEmailService_HasPendingCode(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")

	if svc.HasPendingCode("user4") {
		t.Fatal("expected no pending code")
	}

	_, _ = svc.GenerateCode("user4", "test@example.com")

	if !svc.HasPendingCode("user4") {
		t.Fatal("expected pending code")
	}
}

func TestEmailService_Cleanup(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")

	_, _ = svc.GenerateCode("user5", "test@example.com")

	svc.mu.Lock()
	svc.codes["user5"].ExpiresAt = time.Now().Add(-1 * time.Second)
	svc.mu.Unlock()

	svc.Cleanup()

	if svc.HasPendingCode("user5") {
		t.Fatal("expected code to be cleaned up")
	}
}

func TestEmailService_IsConfigured(t *testing.T) {
	svc := NewEmailService("smtp.yandex.ru", 465, "", "", "from@test.com")
	if svc.IsConfigured() {
		t.Fatal("expected not configured without user/password")
	}

	svc2 := NewEmailService("smtp.yandex.ru", 465, "user@yandex.ru", "pass", "from@test.com")
	if !svc2.IsConfigured() {
		t.Fatal("expected configured with user and password")
	}
}

func TestEmailService_NoCodeForUnknownUser(t *testing.T) {
	svc := NewEmailService("", 0, "", "", "")

	err := svc.VerifyCode("unknown", "123456")
	if err == nil {
		t.Fatal("expected error for unknown user")
	}
}

func TestBuildVerificationEmail_Headers(t *testing.T) {
	msg := buildVerificationEmail("noreply@progresql.app", "user@example.com", "123456")

	checks := []struct {
		name, substr string
	}{
		{"From with display name", "From: ProgreSQL <noreply@progresql.app>"},
		{"To", "To: user@example.com"},
		{"Subject", "ProgreSQL"},
		{"MIME-Version", "MIME-Version: 1.0"},
		{"X-Mailer", "X-Mailer: ProgreSQL/1.0"},
		{"multipart/alternative", "multipart/alternative"},
		{"boundary", mimeBoundary},
	}
	for _, c := range checks {
		if !strings.Contains(msg, c.substr) {
			t.Errorf("%s: expected %q in message", c.name, c.substr)
		}
	}
}

func TestBuildVerificationEmail_Parts(t *testing.T) {
	msg := buildVerificationEmail("from@test.com", "to@test.com", "654321")

	// Must contain plain text part
	if !strings.Contains(msg, "text/plain") {
		t.Error("missing text/plain part")
	}
	if !strings.Contains(msg, "654321") {
		t.Error("plain text part should contain the code")
	}

	// Must contain HTML part
	if !strings.Contains(msg, "text/html") {
		t.Error("missing text/html part")
	}
	if !strings.Contains(msg, "<!DOCTYPE html>") {
		t.Error("HTML part should contain DOCTYPE")
	}

	// Closing boundary
	if !strings.Contains(msg, mimeBoundary+"--") {
		t.Error("missing closing MIME boundary")
	}
}

func TestBuildVerificationHTML_BrandElements(t *testing.T) {
	html := buildVerificationHTML("987654", 15)

	checks := []struct {
		name, substr string
	}{
		{"code color", "#6366f1"},
		{"code digit 9", ">9</td>"},
		{"code digit 4", ">4</td>"},
		{"expiry time", "15 minutes"},
		{"viewport meta", "width=device-width"},
		{"ProgreSQL name", "ProgreSQL"},
		{"logo image", "data:image/png;base64,"},
	}
	for _, c := range checks {
		if !strings.Contains(html, c.substr) {
			t.Errorf("%s: expected %q in HTML", c.name, c.substr)
		}
	}
}

func TestBuildVerificationHTML_AllDigitsPresent(t *testing.T) {
	html := buildVerificationHTML("102938", 15)

	for _, ch := range "102938" {
		expected := ">" + string(ch) + "</td>"
		if !strings.Contains(html, expected) {
			t.Errorf("digit %c not found in HTML", ch)
		}
	}
}
