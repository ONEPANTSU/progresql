package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestGenerateToken(t *testing.T) {
	svc := NewJWTService("test-secret-key")

	token, err := svc.GenerateToken("session-123")
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}
	if token == "" {
		t.Fatal("GenerateToken() returned empty token")
	}
}

func TestValidateToken(t *testing.T) {
	svc := NewJWTService("test-secret-key")

	token, err := svc.GenerateToken("session-456")
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}

	claims, err := svc.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken() error = %v", err)
	}
	if claims.SessionID != "session-456" {
		t.Errorf("SessionID = %q, want %q", claims.SessionID, "session-456")
	}
	if claims.IssuedAt == nil {
		t.Error("IssuedAt is nil")
	}
	if claims.ExpiresAt == nil {
		t.Error("ExpiresAt is nil")
	}
	if claims.ExpiresAt.Sub(claims.IssuedAt.Time) != TokenTTL {
		t.Errorf("token TTL = %v, want %v", claims.ExpiresAt.Sub(claims.IssuedAt.Time), TokenTTL)
	}
}

func TestValidateToken_Expired(t *testing.T) {
	svc := NewJWTService("test-secret-key")

	// Create a token that expired 1 hour ago.
	now := time.Now()
	claims := Claims{
		SessionID: "expired-session",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now.Add(-2 * time.Hour)),
			ExpiresAt: jwt.NewNumericDate(now.Add(-1 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString([]byte("test-secret-key"))
	if err != nil {
		t.Fatalf("signing expired token: %v", err)
	}

	_, err = svc.ValidateToken(tokenString)
	if err == nil {
		t.Fatal("ValidateToken() should return error for expired token")
	}
}

func TestValidateToken_WrongSecret(t *testing.T) {
	svc1 := NewJWTService("secret-one")
	svc2 := NewJWTService("secret-two")

	token, _ := svc1.GenerateToken("session-789")

	_, err := svc2.ValidateToken(token)
	if err == nil {
		t.Fatal("ValidateToken() should return error for wrong secret")
	}
}

func TestValidateToken_InvalidString(t *testing.T) {
	svc := NewJWTService("test-secret-key")

	_, err := svc.ValidateToken("not-a-jwt")
	if err == nil {
		t.Fatal("ValidateToken() should return error for invalid token string")
	}
}

func TestGenerateUserToken(t *testing.T) {
	svc := NewJWTService("test-secret-key")
	user := &User{
		ID:    "user-123",
		Email: "alice@example.com",
		Name:  "Alice",
	}

	token, err := svc.GenerateUserToken(user)
	if err != nil {
		t.Fatalf("GenerateUserToken() error = %v", err)
	}
	if token == "" {
		t.Fatal("GenerateUserToken() returned empty token")
	}

	claims, err := svc.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken() error = %v", err)
	}
	if claims.UserID != "user-123" {
		t.Errorf("UserID = %q, want user-123", claims.UserID)
	}
	if claims.Email != "alice@example.com" {
		t.Errorf("Email = %q, want alice@example.com", claims.Email)
	}
	if claims.Name != "Alice" {
		t.Errorf("Name = %q, want Alice", claims.Name)
	}
}

func TestValidateToken_WrongSigningMethod(t *testing.T) {
	// Create a token with a non-HMAC method (none).
	claims := Claims{
		SessionID: "test",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	tokenString, _ := token.SignedString(jwt.UnsafeAllowNoneSignatureType)

	svc := NewJWTService("test-secret-key")
	_, err := svc.ValidateToken(tokenString)
	if err == nil {
		t.Fatal("ValidateToken() should reject non-HMAC signing methods")
	}
}
