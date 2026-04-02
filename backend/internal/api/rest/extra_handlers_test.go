/*
* Created on Mar 27, 2026
* Test file for handlers.go, middleware_logging.go, middleware_metrics.go, cors.go, analytics_landing.go
* File path: test/internal/api/rest/extra_handlers_test.go
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

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// ── CORSMiddleware ────────────────────────────────────────────────────────────

func TestCORSMiddleware_NoOrigin(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	handler := CORSMiddleware(inner)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Error("expected inner handler to be called when no Origin header")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestCORSMiddleware_WithOrigin(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	handler := CORSMiddleware(inner)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Error("expected inner handler to be called")
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Errorf("expected CORS origin header, got %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Error("expected Allow-Credentials: true")
	}
}

func TestCORSMiddleware_Preflight(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	handler := CORSMiddleware(inner)

	req := httptest.NewRequest(http.MethodOptions, "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Error("inner handler should NOT be called for OPTIONS preflight")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS, got %d", rec.Code)
	}
}

// ── LoggingMiddleware ─────────────────────────────────────────────────────────

func TestRequestIDFromContext_Empty(t *testing.T) {
	id := RequestIDFromContext(context.Background())
	if id != "" {
		t.Errorf("expected empty string, got %q", id)
	}
}

func TestRequestIDFromContext_Set(t *testing.T) {
	ctx := context.WithValue(context.Background(), requestIDKey{}, "my-request-id")
	id := RequestIDFromContext(ctx)
	if id != "my-request-id" {
		t.Errorf("expected 'my-request-id', got %q", id)
	}
}

func TestLoggingRecorder_Flush(t *testing.T) {
	rec := httptest.NewRecorder()
	lr := &loggingRecorder{ResponseWriter: rec, statusCode: http.StatusOK}
	// Should not panic even though httptest.ResponseRecorder doesn't implement Flusher
	lr.Flush()
}

func TestLoggingRecorder_Hijack_NotSupported(t *testing.T) {
	rec := httptest.NewRecorder()
	lr := &loggingRecorder{ResponseWriter: rec, statusCode: http.StatusOK}
	conn, _, err := lr.Hijack()
	if conn != nil {
		t.Error("expected nil conn")
	}
	if err == nil {
		t.Error("expected error when underlying ResponseWriter doesn't support Hijack")
	}
}

// ── MetricsMiddleware ────────────────────────────────────────────────────────

func TestMetricsMiddleware_RecordsRequest(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	handler := MetricsMiddleware(inner)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Error("expected inner handler to be called")
	}
}

func TestNormalizePath(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"/ws/550e8400-e29b-41d4-a716-446655440000", "/ws/:id"},
		{"/api/v1/health", "/api/v1/health"},
		{"/api/v1/users/123e4567-e89b-12d3-a456-426614174000/profile", "/api/v1/users/:id/profile"},
		{"", ""},
	}
	for _, tc := range cases {
		got := normalizePath(tc.input)
		if got != tc.expected {
			t.Errorf("normalizePath(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}

func TestStatusRecorder_Flush(t *testing.T) {
	rec := httptest.NewRecorder()
	sr := &statusRecorder{ResponseWriter: rec, statusCode: http.StatusOK}
	sr.Flush()
}

func TestStatusRecorder_Hijack_NotSupported(t *testing.T) {
	rec := httptest.NewRecorder()
	sr := &statusRecorder{ResponseWriter: rec, statusCode: http.StatusOK}
	conn, _, err := sr.Hijack()
	if conn != nil {
		t.Error("expected nil conn")
	}
	if err == nil {
		t.Error("expected error for unsupported Hijack")
	}
}

// ── analyticsLandingEventHandler ─────────────────────────────────────────────

func TestAnalyticsLandingEventHandler_InvalidBody(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString("not json"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_InvalidEvent(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	body := `{"event":"invalid_event","page":"/","session_id":"sess-1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid event type, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_PageView(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	body := `{"event":"page_view","page":"/","referrer":"https://google.com","utm_source":"google","session_id":"sess-pageview"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_ButtonClick(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	body := `{"event":"button_click","button_id":"download-mac","session_id":"sess-btn"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_ButtonClickWindows(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	body := `{"event":"button_click","button_id":"download-windows","session_id":"sess-win"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_ButtonClickLinux(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	body := `{"event":"button_click","button_id":"download-linux","session_id":"sess-linux"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_ButtonClickUnknownID(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	// button_id is empty — should be set to "unknown"
	body := `{"event":"button_click","session_id":"sess-unknown"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_ScrollDepth(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	pct := 50
	bodyData := map[string]interface{}{
		"event":          "scroll_depth",
		"scroll_percent": pct,
		"session_id":     "sess-scroll",
	}
	bodyBytes, _ := json.Marshal(bodyData)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewReader(bodyBytes))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_ScrollDepthNilPercent(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	body := `{"event":"scroll_depth","session_id":"sess-scroll-nil"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_VideoPlay(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	body := `{"event":"video_play","video_action":"play","session_id":"sess-video"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_VideoPlayEmptyAction(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	// video_action empty — should default to "play"
	body := `{"event":"video_play","session_id":"sess-video-empty"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_UserAgentFromHeader(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	// user_agent not in body — should be taken from header
	body := `{"event":"page_view","session_id":"sess-ua"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	req.Header.Set("User-Agent", "TestBrowser/1.0")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestAnalyticsLandingEventHandler_UniqueSessionTracked(t *testing.T) {
	handler := analyticsLandingEventHandler(nil)

	// First event with new session_id.
	body := `{"event":"page_view","session_id":"unique-sess-1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}

	// Second event with same session_id — should not double-count.
	body = `{"event":"button_click","session_id":"unique-sess-1","button_id":"test-btn"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/analytics/event", bytes.NewBufferString(body))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204 on second event, got %d", rec.Code)
	}
}

// ── extractReferrerDomain ─────────────────────────────────────────────────────

func TestExtractReferrerDomain(t *testing.T) {
	cases := []struct {
		ref      string
		expected string
	}{
		{"", "direct"},
		{"https://google.com/search?q=test", "google.com"},
		{"https://www.yandex.ru", "www.yandex.ru"},
		{"not a url", "unknown"},
		{"://broken", "unknown"},
	}
	for _, tc := range cases {
		got := extractReferrerDomain(tc.ref)
		if got != tc.expected {
			t.Errorf("extractReferrerDomain(%q) = %q, want %q", tc.ref, got, tc.expected)
		}
	}
}

// ── extractCountry ────────────────────────────────────────────────────────────

func TestExtractCountry(t *testing.T) {
	cases := []struct {
		header   string
		expected string
	}{
		{"", "unknown"},
		{"en-US,en;q=0.9", "US"},
		{"ru-RU,ru;q=0.9", "RU"},
		{"en", "en"},
		{"en;q=0.9", "en"},
		{"zh-CN", "CN"},
	}
	for _, tc := range cases {
		got := extractCountry(tc.header)
		if got != tc.expected {
			t.Errorf("extractCountry(%q) = %q, want %q", tc.header, got, tc.expected)
		}
	}
}

// ── clientIP ─────────────────────────────────────────────────────────────────

func TestClientIP_XForwardedFor(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8")
	ip := clientIP(req)
	if ip != "1.2.3.4" {
		t.Errorf("expected '1.2.3.4', got %q", ip)
	}
}

func TestClientIP_XRealIP(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Real-Ip", "9.10.11.12")
	ip := clientIP(req)
	if ip != "9.10.11.12" {
		t.Errorf("expected '9.10.11.12', got %q", ip)
	}
}

func TestClientIP_RemoteAddr(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.168.1.1:54321"
	ip := clientIP(req)
	if ip != "192.168.1.1" {
		t.Errorf("expected '192.168.1.1', got %q", ip)
	}
}

// ── hashIP ────────────────────────────────────────────────────────────────────

func TestHashIP(t *testing.T) {
	h1 := hashIP("1.2.3.4")
	h2 := hashIP("1.2.3.4")
	h3 := hashIP("5.6.7.8")

	if h1 != h2 {
		t.Error("same IP should produce same hash")
	}
	if h1 == h3 {
		t.Error("different IPs should produce different hashes")
	}
	if len(h1) != 64 {
		t.Errorf("expected SHA-256 hex (64 chars), got len=%d", len(h1))
	}
}

// ── landingRateLimiter ────────────────────────────────────────────────────────

func TestLandingRateLimiter_Allow(t *testing.T) {
	rl := newLandingRateLimiter(3, 60*1000*1000*1000) // 3 per minute
	ip := "10.0.0.1"

	for i := 0; i < 3; i++ {
		if !rl.allow(ip) {
			t.Fatalf("expected allow on request %d", i+1)
		}
	}
	// 4th should be denied.
	if rl.allow(ip) {
		t.Error("expected deny on 4th request")
	}
}

func TestLandingRateLimiter_DifferentIPs(t *testing.T) {
	rl := newLandingRateLimiter(1, 60*1000*1000*1000)

	if !rl.allow("1.1.1.1") {
		t.Error("expected allow for first IP")
	}
	if !rl.allow("2.2.2.2") {
		t.Error("expected allow for second (different) IP")
	}
	if rl.allow("1.1.1.1") {
		t.Error("expected deny for first IP after limit")
	}
}

// ── sendVerificationHandler ───────────────────────────────────────────────────

func TestSendVerificationHandler_NoAuth(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	jwtSvc := auth.NewJWTService("test-secret")
	handler := sendVerificationHandler(jwtSvc, store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/send-verification", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestSendVerificationHandler_UserNotFound(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	jwtSvc := auth.NewJWTService("test-secret")
	handler := sendVerificationHandler(jwtSvc, store, emailSvc)

	claims := &auth.Claims{UserID: "nonexistent-id"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/send-verification", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestSendVerificationHandler_AlreadyVerified(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Alice", "alice@example.com", "P@ssw0rd123", false)
	store.SetEmailVerified(user.ID)

	emailSvc := auth.NewEmailService("", 0, "", "", "")
	jwtSvc := auth.NewJWTService("test-secret")
	handler := sendVerificationHandler(jwtSvc, store, emailSvc)

	claims := &auth.Claims{UserID: user.ID}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/send-verification", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
	var resp errorResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Error != "email already verified" {
		t.Errorf("expected 'email already verified', got %q", resp.Error)
	}
}

func TestSendVerificationHandler_EmailNotConfigured(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Alice", "alice@example.com", "P@ssw0rd123", false)

	emailSvc := auth.NewEmailService("", 0, "", "", "") // not configured
	jwtSvc := auth.NewJWTService("test-secret")
	handler := sendVerificationHandler(jwtSvc, store, emailSvc)

	claims := &auth.Claims{UserID: user.ID}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/send-verification", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", rec.Code)
	}
}

// ── verifyCodeHandler ─────────────────────────────────────────────────────────

func TestVerifyCodeHandler_NoAuth(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := verifyCodeHandler(store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify-code", bytes.NewBufferString(`{"code":"123456"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestVerifyCodeHandler_MissingCode(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := verifyCodeHandler(store, emailSvc)

	claims := &auth.Claims{UserID: "user-123"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify-code", bytes.NewBufferString(`{"code":""}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestVerifyCodeHandler_InvalidCode(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Bob", "bob@example.com", "P@ssw0rd123", false)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	emailSvc.GenerateCode(user.ID, user.Email)

	handler := verifyCodeHandler(store, emailSvc)

	claims := &auth.Claims{UserID: user.ID}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify-code", bytes.NewBufferString(`{"code":"000000"}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid code, got %d", rec.Code)
	}
}

func TestVerifyCodeHandler_ValidCode(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Carol", "carol@example.com", "P@ssw0rd123", false)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	code, _ := emailSvc.GenerateCode(user.ID, user.Email)

	handler := verifyCodeHandler(store, emailSvc)

	claims := &auth.Claims{UserID: user.ID}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	body := `{"code":"` + code + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify-code", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for valid code, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp verifyCodeResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if !resp.Verified {
		t.Error("expected Verified=true")
	}
}

func TestVerifyCodeHandler_InvalidJSON(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := verifyCodeHandler(store, emailSvc)

	claims := &auth.Claims{UserID: "user-123"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify-code", bytes.NewBufferString("not json")).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid JSON, got %d", rec.Code)
	}
}

// ── forgotPasswordHandler ─────────────────────────────────────────────────────

func TestForgotPasswordHandler_MissingEmail(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := forgotPasswordHandler(store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/forgot-password", bytes.NewBufferString(`{"email":""}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestForgotPasswordHandler_InvalidJSON(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := forgotPasswordHandler(store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/forgot-password", bytes.NewBufferString("not json"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid JSON, got %d", rec.Code)
	}
}

func TestForgotPasswordHandler_UserNotFound_StillReturns200(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := forgotPasswordHandler(store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/forgot-password", bytes.NewBufferString(`{"email":"nobody@example.com"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Should return 200 to prevent email enumeration.
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 even for unknown email, got %d", rec.Code)
	}
}

func TestForgotPasswordHandler_EmailNotConfigured(t *testing.T) {
	store := auth.NewUserStore(nil)
	store.Register("Dave", "dave@example.com", "P@ssw0rd123", false)
	emailSvc := auth.NewEmailService("", 0, "", "", "") // not configured
	handler := forgotPasswordHandler(store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/forgot-password", bytes.NewBufferString(`{"email":"dave@example.com"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", rec.Code)
	}
}

// ── resetPasswordHandler ──────────────────────────────────────────────────────

func TestResetPasswordHandler_InvalidJSON(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := resetPasswordHandler(store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/reset-password", bytes.NewBufferString("not json"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestResetPasswordHandler_MissingFields(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := resetPasswordHandler(store, emailSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/reset-password", bytes.NewBufferString(`{"email":"test@example.com"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing fields, got %d", rec.Code)
	}
}

func TestResetPasswordHandler_InvalidCode(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	handler := resetPasswordHandler(store, emailSvc)

	body := `{"email":"test@example.com","code":"wrong","new_password":"N3wP@sswd!"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/reset-password", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid reset code, got %d", rec.Code)
	}
}

func TestResetPasswordHandler_ValidReset(t *testing.T) {
	store := auth.NewUserStore(nil)
	store.Register("Eve", "eve@example.com", "P@ssw0rd123", false)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	code, _ := emailSvc.GenerateResetCode("eve@example.com")
	handler := resetPasswordHandler(store, emailSvc)

	body := `{"email":"eve@example.com","code":"` + code + `","new_password":"N3wP@sswd!"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/reset-password", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestResetPasswordHandler_UserNotFound(t *testing.T) {
	store := auth.NewUserStore(nil)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	// Generate reset code for email that doesn't exist in store.
	code, _ := emailSvc.GenerateResetCode("nobody@example.com")
	handler := resetPasswordHandler(store, emailSvc)

	body := `{"email":"nobody@example.com","code":"` + code + `","new_password":"N3wP@sswd!"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/reset-password", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestResetPasswordHandler_WeakNewPassword(t *testing.T) {
	store := auth.NewUserStore(nil)
	store.Register("Frank", "frank@example.com", "P@ssw0rd123", false)
	emailSvc := auth.NewEmailService("", 0, "", "", "")
	code, _ := emailSvc.GenerateResetCode("frank@example.com")
	handler := resetPasswordHandler(store, emailSvc)

	body := `{"email":"frank@example.com","code":"` + code + `","new_password":"weak"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/reset-password", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for weak password, got %d", rec.Code)
	}
}

// ── userInfoFromUser ──────────────────────────────────────────────────────────

func TestUserInfoFromUser_DefaultFreeplan(t *testing.T) {
	user := &auth.User{
		ID:    "user-1",
		Email: "test@example.com",
		Name:  "Test",
		Plan:  "", // empty — should default to "free"
	}
	info := userInfoFromUser(user)
	if info.Plan != "free" {
		t.Errorf("expected plan 'free', got %q", info.Plan)
	}
}

func TestUserInfoFromUser_WithExpiry(t *testing.T) {
	exp := "2025-01-01T00:00:00Z" // past date — subscription expired
	user := &auth.User{
		ID:            "user-2",
		Email:         "pro@example.com",
		Name:          "Pro User",
		Plan:          "pro",
		PlanExpiresAt: &exp,
	}
	info := userInfoFromUser(user)
	// Expired paid plan is normalized to "free" effective plan.
	if info.Plan != "free" {
		t.Errorf("expected plan 'free' (normalized from expired pro), got %q", info.Plan)
	}
	// After normalization to "free" with no trial, warning is empty.
	if info.SubscriptionWarning != "" {
		t.Errorf("expected no warning for normalized free plan, got %q", info.SubscriptionWarning)
	}
}

func TestUserInfoFromUser_WithTrialExpiry(t *testing.T) {
	trial := "2025-01-01T00:00:00Z" // past date
	user := &auth.User{
		ID:          "user-3",
		Email:       "free@example.com",
		Name:        "Free User",
		Plan:        "free",
		TrialEndsAt: &trial,
	}
	info := userInfoFromUser(user)
	if info.SubscriptionWarning != "expired" {
		t.Errorf("expected warning 'expired', got %q", info.SubscriptionWarning)
	}
}

// ── profileHandler ────────────────────────────────────────────────────────────

func TestProfileHandler_FallbackToClaims(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := profileHandler(store, nil)

	// Claims with a user ID that doesn't exist in the store — falls back to claims.
	claims := &auth.Claims{
		UserID: "nonexistent-user",
		Email:  "anon@example.com",
		Name:   "Anon",
	}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/profile", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var info userInfo
	json.NewDecoder(rec.Body).Decode(&info)
	if info.Email != "anon@example.com" {
		t.Errorf("expected fallback email, got %q", info.Email)
	}
}

func TestProfileHandler_EmptyUserID_FallbackToClaims(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := profileHandler(store, nil)

	// Claims with empty UserID — anonymous session.
	claims := &auth.Claims{
		UserID: "",
		Email:  "",
		Name:   "",
	}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/profile", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

// ── loginHandler ─────────────────────────────────────────────────────────────

func TestLoginHandler_InvalidBody(t *testing.T) {
	store := auth.NewUserStore(nil)
	jwtSvc := auth.NewJWTService("test-secret")
	handler := loginHandler(jwtSvc, store)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString("not json"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

// ── placeholder ──────────────────────────────────────────────────────────────

func TestPlaceholder(t *testing.T) {
	p := &placeholder{sessionID: "sess-abc"}
	if p.SessionID() != "sess-abc" {
		t.Errorf("expected 'sess-abc', got %q", p.SessionID())
	}
	if err := p.Close(); err != nil {
		t.Errorf("expected nil error from Close(), got %v", err)
	}
}

// ── authTokenHandler ─────────────────────────────────────────────────────────

func TestAuthTokenHandler_ReturnsToken(t *testing.T) {
	jwtSvc := auth.NewJWTService("test-secret")
	handler := authTokenHandler(jwtSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp authTokenResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Token == "" {
		t.Error("expected non-empty token")
	}
	if resp.ExpiresAt == "" {
		t.Error("expected non-empty expires_at")
	}
}

// ── createSessionHandler ─────────────────────────────────────────────────────

func TestCreateSessionHandler_HTTPS_Scheme(t *testing.T) {
	router, _ := authTestRouter(t)

	// Register a user to get a token.
	body := `{"name":"Test","email":"test@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var regResp authUserResponse
	json.NewDecoder(w.Body).Decode(&regResp)

	// Create session with X-Forwarded-Proto: https.
	sessBody := `{"model":"gpt-4"}`
	req = httptest.NewRequest("POST", "/api/v1/sessions", bytes.NewBufferString(sessBody))
	req.Header.Set("Authorization", "Bearer "+regResp.Token)
	req.Header.Set("X-Forwarded-Proto", "https")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var sessResp createSessionResponse
	json.NewDecoder(w.Body).Decode(&sessResp)
	if !strings.HasPrefix(sessResp.WSURL, "wss://") {
		t.Errorf("expected wss:// scheme for HTTPS, got %q", sessResp.WSURL)
	}
}
