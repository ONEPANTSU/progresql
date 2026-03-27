package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// badRestPool returns a pgxpool that will fail on every query (connection refused).
func badRestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(),
		"postgres://x:x@127.0.0.1:9999/testdb?sslmode=disable")
	if err != nil {
		t.Skipf("could not create bad pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// ── legalDocumentHandler — DB error paths ────────────────────────────────────

func TestLegalDocumentHandler_DBError_NoVersion(t *testing.T) {
	pool := badRestPool(t)
	handler := legalDocumentHandler(pool)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/legal/privacy", nil)
	req.SetPathValue("type", "privacy")
	// No "version" path value — fetches latest active document, which fails.
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// DB query fails → 404 "document not found"
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 on DB error (no version), got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestLegalDocumentHandler_DBError_WithVersion(t *testing.T) {
	pool := badRestPool(t)
	handler := legalDocumentHandler(pool)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/legal/privacy/1.0", nil)
	req.SetPathValue("type", "privacy")
	req.SetPathValue("version", "1.0")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// DB query fails → 404 "document not found"
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 on DB error (with version), got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestLegalDocumentHandler_LangQueryParam(t *testing.T) {
	pool := badRestPool(t)
	handler := legalDocumentHandler(pool)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/legal/terms?lang=en", nil)
	req.SetPathValue("type", "terms")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// DB fails but handler should run the query branch (not short-circuit).
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

// ── legalAcceptHandler — DB error path ───────────────────────────────────────

func TestLegalAcceptHandler_DBError(t *testing.T) {
	pool := badRestPool(t)
	handler := legalAcceptHandler(pool)

	claims := &auth.Claims{UserID: "user-accept-db"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	body := `{"doc_type":"terms","doc_version":"1.0"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// DB exec fails → 500
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on DB error, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ── analyticsUsersHandler — DB error path ────────────────────────────────────

func TestAnalyticsUsersHandler_DBError(t *testing.T) {
	store := auth.NewUserStore(nil)
	pool := badRestPool(t)
	handler := analyticsUsersHandler(pool, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// DB Query fails → 500
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on DB error, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAnalyticsUsersHandler_DBError_WithMonth(t *testing.T) {
	store := auth.NewUserStore(nil)
	pool := badRestPool(t)
	handler := analyticsUsersHandler(pool, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users?month=2026-03", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on DB error with month filter, got %d", rec.Code)
	}
}

// ── analyticsUserDetailHandler — DB error path ───────────────────────────────

func TestAnalyticsUserDetailHandler_DBError(t *testing.T) {
	store := auth.NewUserStore(nil)
	pool := badRestPool(t)
	handler := analyticsUserDetailHandler(pool, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users/user-xyz", nil)
	req.SetPathValue("id", "user-xyz")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// DB QueryRow fails → 500
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on DB error, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ── registerHandler — ErrEmailAlreadyVerified path ───────────────────────────

func TestRegisterHandler_EmailAlreadyVerified(t *testing.T) {
	store := auth.NewUserStore(nil)
	jwtSvc := auth.NewJWTService("test-secret")
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := registerHandler(jwtSvc, store, emailSvc)

	// Register a user and then mark them as verified.
	user, _ := store.Register("Alice", "already-verified@example.com", "P@ssw0rd123", false)
	_ = store.SetEmailVerified(user.ID)

	// Try to register again with same email — should get 409.
	body := `{"name":"Alice","email":"already-verified@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409 for already-verified email, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRegisterHandler_DBError_Default(t *testing.T) {
	pool := badRestPool(t)
	store := auth.NewUserStore(pool)
	jwtSvc := auth.NewJWTService("test-secret")
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := registerHandler(jwtSvc, store, emailSvc)

	// DB pool fails → Register returns non-specific error → 500
	body := `{"name":"Test","email":"db-error@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on DB error, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRegisterHandler_Success_WithEmailSvc(t *testing.T) {
	store := auth.NewUserStore(nil)
	jwtSvc := auth.NewJWTService("test-secret")
	// Configured email service — will attempt to send goroutine (fails silently since no SMTP).
	emailSvc := auth.NewEmailService("smtp.example.com", 465, "user@example.com", "pass", "noreply@example.com")
	handler := registerHandler(jwtSvc, store, emailSvc)

	body := `{"name":"NewUser","email":"new-user-email-svc@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ── promoApplyHandler — DB error paths ───────────────────────────────────────

// ── analyticsUserDetailHandler — nil db / missing user_id ────────────────────

func TestAnalyticsUserDetailHandler_MissingUserID(t *testing.T) {
	store := auth.NewUserStore(nil)
	pool := badRestPool(t)
	handler := analyticsUserDetailHandler(pool, store)

	// No "id" path value → userID == "" → 400
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing user_id, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ── authTokenHandler — success path ──────────────────────────────────────────

func TestAuthTokenHandler_Success(t *testing.T) {
	jwtSvc := auth.NewJWTService("test-secret-for-auth-token")
	handler := authTokenHandler(jwtSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from authTokenHandler, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Token == "" {
		t.Error("expected non-empty token")
	}
}

func TestPromoApplyHandler_DBError_BadPromoCode(t *testing.T) {
	store := auth.NewUserStore(nil)
	pool := badRestPool(t)
	handler := promoApplyHandler(pool, store)

	claims := &auth.Claims{UserID: "user-promo-db"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	// DB query for promo code fails → 400 "invalid or expired promo code"
	req := httptest.NewRequest(http.MethodPost, "/api/v1/promo/apply",
		bytes.NewBufferString(`{"code":"BADCODE"}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for DB error on promo lookup, got %d: %s", rec.Code, rec.Body.String())
	}
}
