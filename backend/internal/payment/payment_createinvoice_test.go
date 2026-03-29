/*
* Created on Mar 27, 2026
* Test file for handler.go CreateInvoiceHandler and WebhookHandler extra cases
* File path: internal/payment/payment_createinvoice_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package payment

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// ── CreateInvoiceHandler ──────────────────────────────────────────────────────

func TestCreateInvoiceHandler_Unauthorized(t *testing.T) {
	store := auth.NewUserStore(nil)
	handler := CreateInvoiceHandler(nil, store, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/create-invoice", bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestCreateInvoiceHandler_UserNotFound(t *testing.T) {
	store := auth.NewUserStore(nil) // empty store
	handler := CreateInvoiceHandler(nil, store, nil)

	claims := &auth.Claims{UserID: "nonexistent-user"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/create-invoice", bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestCreateInvoiceHandler_PlategaError(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test", "test@example.com", "P@ssw0rd123", false)

	// Create platega client that always returns an error.
	client := &PlategaClient{
		merchantID: "test-merchant",
		apiKey:     "test-key",
		httpClient: &http.Client{
			Transport: &mockTransport{
				fn: func(req *http.Request) (*http.Response, error) {
					return &http.Response{
						StatusCode: http.StatusInternalServerError,
						Body:       http.NoBody,
					}, nil
				},
			},
			Timeout: 5 * time.Second,
		},
	}

	svc := auth.NewJWTService("test-secret")
	userObj := &auth.User{ID: user.ID, Email: user.Email, Name: user.Name}
	token, _ := svc.GenerateUserToken(userObj)
	parsed, _ := svc.ValidateToken(token)
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, parsed)

	handler := CreateInvoiceHandler(client, store, nil)
	body := `{"amount":20,"currency":"USD","payment_method":12}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/create-invoice", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for Platega error, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateInvoiceHandler_NetworkError(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test", "test2@example.com", "P@ssw0rd123", false)

	// Client that returns a network error.
	client := &PlategaClient{
		merchantID: "test-merchant",
		apiKey:     "test-key",
		httpClient: &http.Client{
			Transport: &mockTransport{
				fn: func(req *http.Request) (*http.Response, error) {
					return nil, fmt.Errorf("connection refused")
				},
			},
			Timeout: 5 * time.Second,
		},
	}

	svc := auth.NewJWTService("test-secret")
	userObj := &auth.User{ID: user.ID, Email: user.Email, Name: user.Name}
	token, _ := svc.GenerateUserToken(userObj)
	parsed, _ := svc.ValidateToken(token)
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, parsed)

	handler := CreateInvoiceHandler(client, store, nil)
	body := `{"amount":20,"currency":"USD"}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/create-invoice", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for network error, got %d: %s", w.Code, w.Body.String())
	}
}

// ── WebhookHandler extra cases ────────────────────────────────────────────────

func TestWebhookHandler_CanceledStatus_NilDB(t *testing.T) {
	// Canceled status with nil DB should still return 200 "ignored".
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:       "txn-cancel-nil",
		Status:   "CANCELED",
		Currency: "USD",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for CANCELED, got %d", w.Code)
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "ignored" {
		t.Errorf("expected status=ignored, got %q", resp["status"])
	}
}

func TestWebhookHandler_CanceledStatus_EmptyCurrency(t *testing.T) {
	// CANCELED with empty Currency — should use "unknown" in metrics.
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:       "txn-cancel-empty-curr",
		Status:   "CANCELED",
		Currency: "",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestWebhookHandler_ConfirmedEmptyCurrency(t *testing.T) {
	// CONFIRMED with empty Currency — should use "unknown".
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:       "txn-confirm-no-currency",
		Status:   "CONFIRMED",
		Currency: "",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

// ── WebhookHandlerV2 extra cases ──────────────────────────────────────────────

func TestWebhookHandlerV2_CanceledStatus_NilDB(t *testing.T) {
	handler := WebhookHandlerV2(&mockPlanUpdater{}, nil, nil, "m", "s")

	payload := plategaWebhookPayload{
		ID:       "txn-v2-cancel",
		Status:   "CANCELED",
		Currency: "RUB",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "m")
	req.Header.Set("X-Secret", "s")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for CANCELED, got %d", w.Code)
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "ignored" {
		t.Errorf("expected status=ignored, got %q", resp["status"])
	}
}

func TestWebhookHandlerV2_CanceledStatus_EmptyCurrency(t *testing.T) {
	handler := WebhookHandlerV2(&mockPlanUpdater{}, nil, nil, "m", "s")

	payload := plategaWebhookPayload{
		ID:       "txn-v2-cancel-nocurr",
		Status:   "CANCELED",
		Currency: "",
		Payload:  "user_123",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "m")
	req.Header.Set("X-Secret", "s")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestWebhookHandlerV2_ConfirmedEmptyCurrency(t *testing.T) {
	mock := &mockPlanUpdater{}
	handler := WebhookHandlerV2(mock, nil, nil, "m", "s")

	payload := plategaWebhookPayload{
		ID:       "txn-v2-no-currency",
		Status:   "CONFIRMED",
		Currency: "",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "m")
	req.Header.Set("X-Secret", "s")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestWebhookHandlerV2_SetPlanError(t *testing.T) {
	mock := &mockPlanUpdater{err: fmt.Errorf("set plan failed")}
	handler := WebhookHandlerV2(mock, nil, nil, "m", "s")

	payload := plategaWebhookPayload{
		ID:      "txn-setplan-err",
		Status:  "CONFIRMED",
		Payload: "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "m")
	req.Header.Set("X-Secret", "s")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when SetPlan fails, got %d", w.Code)
	}
}
