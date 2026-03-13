package rest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

const testJWTSecret = "test-jwt-secret"

func TestAuthTokenHandler_IssuesJWT(t *testing.T) {
	jwtSvc := auth.NewJWTService(testJWTSecret)
	handler := authTokenHandler(jwtSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp authTokenResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Token == "" {
		t.Error("expected non-empty token")
	}
	if resp.ExpiresAt == "" {
		t.Error("expected non-empty expires_at")
	}

	// Validate the returned token
	claims, err := jwtSvc.ValidateToken(resp.Token)
	if err != nil {
		t.Fatalf("returned token is invalid: %v", err)
	}
	if claims.SessionID == "" {
		t.Error("expected non-empty session_id in claims")
	}
}

func TestAuthTokenHandler_TokenIsValidatable(t *testing.T) {
	jwtSvc := auth.NewJWTService(testJWTSecret)
	handler := authTokenHandler(jwtSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	var resp authTokenResponse
	json.NewDecoder(rec.Body).Decode(&resp)

	// Token must pass ValidateToken
	_, err := jwtSvc.ValidateToken(resp.Token)
	if err != nil {
		t.Fatalf("token validation failed: %v", err)
	}

	// Token must NOT pass with different secret
	otherSvc := auth.NewJWTService("different-secret")
	_, err = otherSvc.ValidateToken(resp.Token)
	if err == nil {
		t.Error("expected token validation to fail with different secret")
	}
}
