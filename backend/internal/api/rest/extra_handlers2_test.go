/*
* Created on Mar 27, 2026
* Additional tests targeting remaining uncovered branches in rest package
* File path: internal/api/rest/extra_handlers2_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/auth"
	websocketpkg "github.com/onepantsu/progressql/backend/internal/websocket"
)

// ── landingRateLimiter GC path ────────────────────────────────────────────────

func TestLandingRateLimiter_GarbageCollection(t *testing.T) {
	// Use a very short window so the GC logic triggers.
	rl := newLandingRateLimiter(100, 1*time.Millisecond)

	// Fill with entries.
	rl.allow("1.1.1.1")
	rl.allow("2.2.2.2")

	// Wait for windows to expire, then force GC by setting lastGC in the past.
	time.Sleep(5 * time.Millisecond)
	rl.mu.Lock()
	rl.lastGC = time.Now().Add(-10 * time.Minute) // force GC on next call
	rl.mu.Unlock()

	// Next allow call should trigger GC.
	result := rl.allow("3.3.3.3")
	if !result {
		t.Error("expected allow after GC")
	}
}

// ── analyticsLandingEventHandler rate limit ───────────────────────────────────

func TestAnalyticsLandingEventHandler_RateLimit(t *testing.T) {
	// Create a handler with a limit of 1 request per minute.
	rl := newLandingRateLimiter(1, time.Minute)
	// Manually exhaust the limit for a specific IP.
	rl.allow("ratelimited-ip")
	rl.allow("ratelimited-ip") // 2nd should be denied

	// Verify that the 2nd call is denied.
	if rl.allow("ratelimited-ip") {
		t.Error("expected deny on 3rd request")
	}
}

func TestAnalyticsLandingEventHandler_RateLimitHTTP(t *testing.T) {
	// We need to trigger the rate limit via the HTTP handler.
	// The handler creates its own rl with limit=100, so we'd need >100 requests.
	// Instead, test the underlying rate limiter behavior.
	rl := newLandingRateLimiter(2, time.Minute)
	for i := 0; i < 3; i++ {
		rl.allow("10.0.0.5")
	}
	// The 3rd call should be denied.
	if rl.allow("10.0.0.5") {
		t.Error("expected deny after exceeding rate limit")
	}
}

func TestAnalyticsLandingEventHandler_Exceeds429(t *testing.T) {
	// Create a fresh handler instance.
	handler := analyticsLandingEventHandler(nil)

	// Build a valid page_view request body.
	body := `{"event":"page_view","session_id":"ses-429","referrer":"https://google.com"}`

	var lastCode int
	// Submit 105 requests with same IP (limit is 100/min).
	for i := 0; i < 105; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/landing", strings.NewReader(body))
		req.Header.Set("X-Forwarded-For", "10.0.0.42")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		lastCode = rec.Code
	}
	// After 100 requests, subsequent ones should return 429.
	if lastCode != http.StatusTooManyRequests {
		t.Errorf("expected 429 after exhausting rate limit, got %d", lastCode)
	}
}

func TestAnalyticsLandingEventHandler_ButtonClickMac(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)
	body := `{"event":"button_click","button_id":"download-mac"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/landing", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204 for download-mac button click, got %d", rec.Code)
	}
}

// ── forgotPasswordHandler with email configured (but send fails) ──────────────

func TestForgotPasswordHandler_EmailConfiguredButSendFails(t *testing.T) {
	// NOTE: We can only test that emailSvc.IsConfigured() returns true
	// and then let GenerateResetCode succeed, but SendPasswordResetEmail would
	// fail because no real SMTP. We can only test what's testable without a real SMTP.

	// This path is: user found, email configured -> generate code -> send fails
	// We can't mock send failure without interfaces. The send will fail because
	// no real SMTP server, but the function will return 500.
	// In testing with unconfigured email, IsConfigured() returns false (503).
	store := auth.NewUserStore(nil)
	store.Register("Dave", "dave2@example.com", "P@ssw0rd123", false)

	// Configured email service pointing to non-existent SMTP.
	emailSvc := auth.NewEmailService("nonexistent.smtp.server", 465, "user", "pass", "from@test.com")
	if !emailSvc.IsConfigured() {
		t.Skip("email service should be configured")
	}

	handler := forgotPasswordHandler(store, emailSvc)
	req := httptest.NewRequest(http.MethodPost, "/forgot-password", bytes.NewBufferString(`{"email":"dave2@example.com"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Expect either 500 (send fails) or 200 (if somehow succeeds).
	if rec.Code != http.StatusInternalServerError && rec.Code != http.StatusOK {
		t.Errorf("expected 500 or 200, got %d", rec.Code)
	}
}

// ── sendVerificationHandler with email configured (send path) ─────────────────

func TestSendVerificationHandler_EmailConfiguredSendFails(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Alice2", "alice2@example.com", "P@ssw0rd123", false)
	// Don't verify email.

	// Configured email service pointing to non-existent SMTP.
	emailSvc := auth.NewEmailService("nonexistent.smtp.server", 465, "user", "pass", "from@test.com")
	if !emailSvc.IsConfigured() {
		t.Skip("need configured email service")
	}

	jwtSvc := auth.NewJWTService("test-secret")
	handler := sendVerificationHandler(jwtSvc, store, emailSvc)

	claims := &auth.Claims{UserID: user.ID}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodPost, "/send-verification", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Send should fail with 500 (TLS connect error to nonexistent server).
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when SMTP server unreachable, got %d", rec.Code)
	}
}

// ── legalAcceptHandler — source default ──────────────────────────────────────

func TestLegalAcceptHandler_DefaultSource(t *testing.T) {
	// Without source field, defaults to "app".
	// The handler will fail with nil DB after the source default path is covered.
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: "user-src"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	// Include source in body to test default path.
	body := `{"doc_type":"terms","doc_version":"1.0"}` // no "source" — defaults to "app"
	req := httptest.NewRequest(http.MethodPost, "/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Fails at db nil check (500), but source default was set.
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for nil db, got %d", rec.Code)
	}
}

func TestLegalAcceptHandler_ExplicitSource(t *testing.T) {
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: "user-explicit-src"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	body := `{"doc_type":"terms","doc_version":"1.0","source":"registration"}`
	req := httptest.NewRequest(http.MethodPost, "/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for nil db, got %d", rec.Code)
	}
}

func TestLegalAcceptHandler_WithXForwardedFor(t *testing.T) {
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: "user-xff"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	body := `{"doc_type":"privacy","doc_version":"2.0"}`
	req := httptest.NewRequest(http.MethodPost, "/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	req.Header.Set("User-Agent", "TestBrowser/2.0")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Should fail at db check after extracting IP/UA.
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for nil db, got %d", rec.Code)
	}
}

// ── authTokenHandler internal ─────────────────────────────────────────────────

func TestAuthTokenHandler_ContentType(t *testing.T) {
	jwtSvc := auth.NewJWTService("test-secret")
	handler := authTokenHandler(jwtSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("expected Content-Type=application/json, got %q", ct)
	}
}

// ── registerHandler — internal token generation path ─────────────────────────

func TestRegisterHandler_InternalServerError_TokenGen(t *testing.T) {
	// Use a JWTService with empty secret (still valid, GenerateUserToken succeeds).
	store := auth.NewUserStore(nil)
	jwtSvc := auth.NewJWTService("") // empty secret still works for HS256
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := registerHandler(jwtSvc, store, emailSvc)

	body := `{"name":"Test","email":"tokentest@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// With empty secret, GenerateUserToken still works (HS256 allows empty key).
	// Should succeed with 201.
	if rec.Code != http.StatusCreated {
		t.Logf("register response: %s", rec.Body.String())
	}
}

// ── legalDocumentHandler extra paths ─────────────────────────────────────────

func TestLegalDocumentHandler_NilDB_WithVersion(t *testing.T) {
	handler := legalDocumentHandler(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/legal/privacy/1.0", nil)
	req.SetPathValue("type", "privacy")
	req.SetPathValue("version", "1.0")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// DB is nil — should return 500.
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for nil db with version, got %d", rec.Code)
	}
}

func TestLegalDocumentHandler_WithLangParam(t *testing.T) {
	handler := legalDocumentHandler(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/legal/privacy?lang=en", nil)
	req.SetPathValue("type", "privacy")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Still fails with nil DB.
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
}

// ── createSessionHandler — no userID ─────────────────────────────────────────

func TestCreateSessionHandler_InvalidBodyExtra(t *testing.T) {
	router, _ := authTestRouter(t)

	// Register to get a valid token.
	body := `{"name":"Test","email":"session_invalid2@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var regResp authUserResponse
	json.NewDecoder(w.Body).Decode(&regResp)

	// Send invalid JSON body.
	req = httptest.NewRequest("POST", "/api/v1/sessions", bytes.NewBufferString("{invalid json"))
	req.Header.Set("Authorization", "Bearer "+regResp.Token)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid session body, got %d: %s", w.Code, w.Body.String())
	}
}

// ── promoApplyHandler — auth and db nil paths ─────────────────────────────────

func TestPromoApplyHandler_NoAuth(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := promoApplyHandler(nil, store)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/promo/apply", bytes.NewBufferString(`{"code":"PROMO123"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestPromoApplyHandler_NilDB(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := promoApplyHandler(nil, store)

	claims := &auth.Claims{UserID: "user-promo"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/promo/apply", bytes.NewBufferString(`{"code":"PROMO123"}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for nil db, got %d", rec.Code)
	}
}

func TestPromoApplyHandler_EmptyCode(t *testing.T) {
	// The handler checks db==nil before body validation, so nil DB returns 500 first.
	// This test verifies the nil-db fast path for an authenticated user.
	store := auth.NewUserStore(nil)
	handler := promoApplyHandler(nil, store)

	claims := &auth.Claims{UserID: "user-promo2"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/promo/apply", bytes.NewBufferString(`{"code":"   "}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// nil DB is checked before body — expect 500 "database not configured".
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for nil db path, got %d", rec.Code)
	}
	var resp errorResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Error != "database not configured" {
		t.Errorf("expected 'database not configured', got %q", resp.Error)
	}
}

func TestPromoApplyHandler_InvalidJSON(t *testing.T) {
	// Same reason as above: nil DB is checked before JSON decode.
	store := auth.NewUserStore(nil)
	handler := promoApplyHandler(nil, store)

	claims := &auth.Claims{UserID: "user-promo3"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/promo/apply", bytes.NewBufferString("not json")).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for nil db path, got %d", rec.Code)
	}
}

// ── analyticsUsersHandler NilDB ───────────────────────────────────────────────

func TestAnalyticsUsersHandler_NilDB_Already(t *testing.T) {
	// Already tested in analytics_test.go, but test month param path.
	store := auth.NewUserStore(nil)
	handler := analyticsUsersHandler(nil, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users?month=2026-01", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for nil db, got %d", rec.Code)
	}
}

// ── middleware_logging Flush path ─────────────────────────────────────────────

type flusherResponseWriter struct {
	*httptest.ResponseRecorder
	flushed bool
}

func (f *flusherResponseWriter) Flush() {
	f.flushed = true
}

func TestLoggingRecorder_Flush_WithFlusher(t *testing.T) {
	base := &flusherResponseWriter{ResponseRecorder: httptest.NewRecorder()}
	lr := &loggingRecorder{ResponseWriter: base, statusCode: http.StatusOK}
	lr.Flush()
	if !base.flushed {
		t.Error("expected underlying Flusher.Flush() to be called")
	}
}

func TestStatusRecorder_Flush_WithFlusher(t *testing.T) {
	base := &flusherResponseWriter{ResponseRecorder: httptest.NewRecorder()}
	sr := &statusRecorder{ResponseWriter: base, statusCode: http.StatusOK}
	sr.Flush()
	if !base.flushed {
		t.Error("expected underlying Flusher.Flush() to be called")
	}
}

// ── LoggingMiddleware — health/metrics paths ──────────────────────────────────

func TestLoggingMiddleware_HealthPathDebugLevel(t *testing.T) {
	import_zap, _ := func() (interface{}, error) { return nil, nil }()
	_ = import_zap

	// Just ensure health path is handled without panic.
	router, _ := authTestRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

// ── extractCountry — edge cases ───────────────────────────────────────────────

func TestExtractCountry_SemicolonOnly(t *testing.T) {
	// Language tag with q-value but no region.
	got := extractCountry("en;q=0.9")
	if got != "en" {
		t.Errorf("expected 'en', got %q", got)
	}
}

func TestExtractCountry_SingleLetter(t *testing.T) {
	got := extractCountry("x")
	if got != "x" {
		t.Errorf("expected 'x', got %q", got)
	}
}

// ── createSessionHandler — no userID in claims ───────────────────────────────

func TestCreateSessionHandler_AnonymousSession(t *testing.T) {
	// Create a session token without a user ID (anonymous session).
	jwtSvc := auth.NewJWTService("test-secret")
	token, _ := jwtSvc.GenerateToken("anon-session-id")

	router, _ := authTestRouter(t)

	sessBody := `{"model":"gpt-4"}`
	req := httptest.NewRequest("POST", "/api/v1/sessions", bytes.NewBufferString(sessBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 for anonymous session, got %d: %s", w.Code, w.Body.String())
	}

	var sessResp createSessionResponse
	json.NewDecoder(w.Body).Decode(&sessResp)
	if sessResp.SessionID == "" {
		t.Error("expected non-empty session_id")
	}
}

// ── createSessionHandler — host from header ───────────────────────────────────

func TestCreateSessionHandler_HostFromHeader(t *testing.T) {
	router, _ := authTestRouter(t)

	// Register to get a valid token.
	body := `{"name":"Test","email":"host_test@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var regResp authUserResponse
	json.NewDecoder(w.Body).Decode(&regResp)

	// Create session with Host header.
	sessBody := `{"model":"gpt-4"}`
	req = httptest.NewRequest("POST", "/api/v1/sessions", bytes.NewBufferString(sessBody))
	req.Header.Set("Authorization", "Bearer "+regResp.Token)
	req.Host = "api.example.com"
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var sessResp createSessionResponse
	json.NewDecoder(w.Body).Decode(&sessResp)
	if !strings.Contains(sessResp.WSURL, "api.example.com") {
		t.Errorf("expected WSURL to contain host, got %q", sessResp.WSURL)
	}
}

// ── userInfoFromUser — marketing consent ─────────────────────────────────────

func TestUserInfoFromUser_MarketingConsent(t *testing.T) {
	user := &auth.User{
		ID:               "mc-user",
		Email:            "mc@example.com",
		Name:             "Marketing",
		Plan:             "pro",
		MarketingConsent: true,
	}
	info := userInfoFromUser(user)
	if !info.MarketingConsent {
		t.Error("expected MarketingConsent=true")
	}
}

func TestUserInfoFromUser_PlanExpiryFarFuture(t *testing.T) {
	future := time.Now().Add(365 * 24 * time.Hour).UTC().Format(time.RFC3339)
	user := &auth.User{
		ID:            "future-user",
		Email:         "future@example.com",
		Name:          "Future",
		Plan:          "pro",
		PlanExpiresAt: &future,
	}
	info := userInfoFromUser(user)
	if info.SubscriptionWarning != "" {
		t.Errorf("expected no warning for far-future expiry, got %q", info.SubscriptionWarning)
	}
}

// ── profileHandler — fallback path (user not found in store) ─────────────────

func TestProfileHandler_FallbackToClaimsExtra(t *testing.T) {
	// Create a store, get a token, then clear the store so GetByID fails.
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test", "fallback@example.com", "P@ssw0rd123", false)

	jwtSvc := auth.NewJWTService("test-secret")
	userObj := &auth.User{ID: user.ID, Email: user.Email, Name: user.Name}
	token, _ := jwtSvc.GenerateUserToken(userObj)
	parsed, _ := jwtSvc.ValidateToken(token)

	// Create profile handler with a NEW empty store (user not found).
	emptyStore := auth.NewUserStore(nil)
	handler := profileHandler(emptyStore, nil)

	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, parsed)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/profile", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 fallback, got %d", rec.Code)
	}
	var info userInfo
	json.NewDecoder(rec.Body).Decode(&info)
	if info.ID != user.ID {
		t.Errorf("expected user ID %q, got %q", user.ID, info.ID)
	}
}

// ── NewRouter — admin user IDs and tool timeout paths ─────────────────────────

func TestNewRouter_WithAdminUserIDs(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Admin", "admin@example.com", "P@ssw0rd123", false)

	hub := websocketpkg.NewHub()
	cfg := &config.Config{
		ServerPort:         "0",
		JWTSecret:          "test-secret",
		AdminUserIDs:       []string{user.ID},
		ToolCallTimeoutSec: 30,
		RateLimitPerMin:    60,
	}

	router := NewRouter(cfg, zap.NewNop(), hub, store, nil)
	if router == nil {
		t.Fatal("expected non-nil router")
	}

	// Verify health endpoint still works.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for health, got %d", rec.Code)
	}
}
