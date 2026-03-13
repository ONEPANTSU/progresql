package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// protectedHandler is a test handler that returns claims from context.
func protectedHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := ClaimsFromContext(r.Context())
		if claims == nil {
			http.Error(w, "no claims", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"session_id": claims.SessionID,
		})
	}
}

func TestAuthMiddleware_NoToken(t *testing.T) {
	jwtSvc := NewJWTService("test-secret")
	handler := AuthMiddleware(jwtSvc)(protectedHandler())

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_InvalidFormat(t *testing.T) {
	jwtSvc := NewJWTService("test-secret")
	handler := AuthMiddleware(jwtSvc)(protectedHandler())

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Basic abc123")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_InvalidToken(t *testing.T) {
	jwtSvc := NewJWTService("test-secret")
	handler := AuthMiddleware(jwtSvc)(protectedHandler())

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer invalid-token-string")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_WrongSecret(t *testing.T) {
	signer := NewJWTService("secret-a")
	validator := NewJWTService("secret-b")

	token, err := signer.GenerateToken("sess-1")
	if err != nil {
		t.Fatal(err)
	}

	handler := AuthMiddleware(validator)(protectedHandler())

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_ValidToken(t *testing.T) {
	jwtSvc := NewJWTService("test-secret")
	token, err := jwtSvc.GenerateToken("session-42")
	if err != nil {
		t.Fatal(err)
	}

	handler := AuthMiddleware(jwtSvc)(protectedHandler())

	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["session_id"] != "session-42" {
		t.Errorf("expected session_id=session-42, got %s", body["session_id"])
	}
}

func TestClaimsFromContext_NoClaims(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	claims := ClaimsFromContext(req.Context())
	if claims != nil {
		t.Error("expected nil claims from empty context")
	}
}
