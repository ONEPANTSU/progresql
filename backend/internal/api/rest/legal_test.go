package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

func TestLegalDocumentHandler_NilDB(t *testing.T) {
	handler := legalDocumentHandler(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/legal/privacy", nil)
	req.SetPathValue("type", "privacy")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for nil db, got %d", rec.Code)
	}

	var resp errorResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Error != "database not configured" {
		t.Errorf("expected 'database not configured', got %q", resp.Error)
	}
}

func TestLegalDocumentHandler_MissingType(t *testing.T) {
	handler := legalDocumentHandler(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/legal/", nil)
	// Don't set PathValue for "type" — simulate missing type.
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing type, got %d", rec.Code)
	}

	var resp errorResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Error != "missing document type" {
		t.Errorf("expected 'missing document type', got %q", resp.Error)
	}
}

func TestLegalAcceptHandler_NoAuth(t *testing.T) {
	handler := legalAcceptHandler(nil)

	body := `{"doc_type":"terms","doc_version":"1.0"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/legal/accept", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for no auth, got %d", rec.Code)
	}
}

func TestLegalAcceptHandler_EmptyUserID(t *testing.T) {
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: ""}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	body := `{"doc_type":"terms","doc_version":"1.0"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for empty user ID, got %d", rec.Code)
	}
}

func TestLegalAcceptHandler_NilDB(t *testing.T) {
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: "user-123"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	body := `{"doc_type":"terms","doc_version":"1.0"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for nil db, got %d", rec.Code)
	}
}

func TestLegalAcceptHandler_InvalidBody(t *testing.T) {
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: "user-123"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/legal/accept", bytes.NewBufferString("{invalid")).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid body, got %d", rec.Code)
	}
}

func TestLegalAcceptHandler_MissingFields(t *testing.T) {
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: "user-123"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	// Missing doc_version.
	body := `{"doc_type":"terms"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing fields, got %d", rec.Code)
	}

	var resp errorResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Error != "doc_type and doc_version are required" {
		t.Errorf("expected 'doc_type and doc_version are required', got %q", resp.Error)
	}
}

func TestLegalAcceptHandler_MissingDocType(t *testing.T) {
	handler := legalAcceptHandler(nil)

	claims := &auth.Claims{UserID: "user-123"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	body := `{"doc_version":"1.0"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/legal/accept", bytes.NewBufferString(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing doc_type, got %d", rec.Code)
	}
}
