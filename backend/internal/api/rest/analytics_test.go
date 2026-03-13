package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

func TestAdminMiddleware_NoAuth(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mw := adminMiddleware([]string{"admin-123"}, inner)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}

	var resp errorResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Error != "admin access required" {
		t.Errorf("expected 'admin access required', got %q", resp.Error)
	}
}

func TestAdminMiddleware_NonAdmin(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mw := adminMiddleware([]string{"admin-123"}, inner)

	// Put non-admin claims in context.
	claims := &auth.Claims{UserID: "regular-user-456"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodGet, "/test", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

func TestAdminMiddleware_AdminAllowed(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	mw := adminMiddleware([]string{"admin-123", "admin-456"}, inner)

	claims := &auth.Claims{UserID: "admin-456"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodGet, "/test", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !called {
		t.Error("inner handler was not called")
	}
}

func TestAdminMiddleware_EmptyUserID(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mw := adminMiddleware([]string{"admin-123"}, inner)

	claims := &auth.Claims{UserID: ""}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodGet, "/test", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for empty user ID, got %d", rec.Code)
	}
}

func TestAdminMiddleware_TrimWhitespace(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	// Admin IDs with whitespace.
	mw := adminMiddleware([]string{"  admin-123  ", "", " "}, inner)

	claims := &auth.Claims{UserID: "admin-123"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)
	req := httptest.NewRequest(http.MethodGet, "/test", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !called {
		t.Error("inner handler was not called")
	}
}

func TestAnalyticsUsersHandler_NilDB(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := analyticsUsersHandler(nil, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for nil db, got %d", rec.Code)
	}
}

func TestAnalyticsUserDetailHandler_NilDB(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := analyticsUserDetailHandler(nil, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users/some-id", nil)
	req.SetPathValue("id", "some-id")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for nil db, got %d", rec.Code)
	}
}

func TestAnalyticsUserDetailHandler_MissingID(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := analyticsUserDetailHandler(nil, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/analytics/users/", nil)
	// Don't set PathValue — simulate missing ID.
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing user_id, got %d", rec.Code)
	}
}
