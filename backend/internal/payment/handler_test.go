package payment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// mockPlanUpdater records SetPlan calls for test verification.
type mockPlanUpdater struct {
	calls []setPlanCall
	err   error // if set, SetPlan returns this error
}

type setPlanCall struct {
	UserID    string
	Plan      string
	ExpiresAt *string
}

func (m *mockPlanUpdater) SetPlan(userID, plan string, expiresAt *string) error {
	m.calls = append(m.calls, setPlanCall{UserID: userID, Plan: plan, ExpiresAt: expiresAt})
	return m.err
}

func TestWebhookHandler_ValidPayment(t *testing.T) {
	merchantID := "test-merchant-id"
	secret := "test-webhook-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "CONFIRMED",
		PaymentMethod: 12,
		Payload:       "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "ok" {
		t.Errorf("expected status ok, got %s", resp["status"])
	}

	// Verify SetPlan was called with correct args.
	if len(mock.calls) != 1 {
		t.Fatalf("expected 1 SetPlan call, got %d", len(mock.calls))
	}
	call := mock.calls[0]
	if call.UserID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("unexpected userID: %s", call.UserID)
	}
	if call.Plan != "pro" {
		t.Errorf("expected plan 'pro', got %s", call.Plan)
	}
	if call.ExpiresAt == nil {
		t.Error("expiresAt should not be nil")
	}
}

func TestWebhookHandler_InvalidCredentials(t *testing.T) {
	merchantID := "correct-merchant"
	secret := "correct-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "CONFIRMED",
		PaymentMethod: 12,
		Payload:       "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	// Wrong secret.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", "wrong-secret")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for invalid credentials, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not have been called for invalid credentials")
	}

	var resp errorResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Error != "invalid webhook credentials" {
		t.Errorf("unexpected error message: %s", resp.Error)
	}
}

func TestWebhookHandler_WrongMerchantID(t *testing.T) {
	merchantID := "correct-merchant"
	secret := "correct-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "CONFIRMED",
		PaymentMethod: 12,
		Payload:       "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "wrong-merchant")
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for wrong merchant ID, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not have been called for wrong merchant ID")
	}
}

func TestWebhookHandler_EmptySecret_Rejected(t *testing.T) {
	// When webhook secret is not configured, ALL webhooks must be rejected.
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, "", "")

	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "CONFIRMED",
		PaymentMethod: 12,
		Payload:       "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when secret not configured, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not have been called when secret is not configured")
	}

	var resp errorResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Error != "webhook secret not configured" {
		t.Errorf("unexpected error: %s", resp.Error)
	}
}

func TestWebhookHandler_CanceledStatus_Ignored(t *testing.T) {
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "CANCELED",
		PaymentMethod: 12,
		Payload:       "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for CANCELED status, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not be called for CANCELED status")
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "ignored" {
		t.Errorf("expected ignored, got %s", resp["status"])
	}
}

func TestWebhookHandler_PendingStatus_Ignored(t *testing.T) {
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "PENDING",
		PaymentMethod: 12,
		Payload:       "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for PENDING status, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not be called for PENDING status")
	}
}

func TestWebhookHandler_InvalidPayload(t *testing.T) {
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	for _, payloadStr := range []string{"invalid", "payment_123", "user", ""} {
		t.Run(fmt.Sprintf("payload_%s", payloadStr), func(t *testing.T) {
			mock.calls = nil
			payload := plategaWebhookPayload{
				ID:            "txn-123",
				Amount:        20.0,
				Currency:      "USD",
				Status:        "CONFIRMED",
				PaymentMethod: 12,
				Payload:       payloadStr,
			}
			body, _ := json.Marshal(payload)

			req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
			req.Header.Set("X-MerchantId", merchantID)
			req.Header.Set("X-Secret", secret)
			w := httptest.NewRecorder()
			handler(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400 for payload %q, got %d", payloadStr, w.Code)
			}
			if len(mock.calls) != 0 {
				t.Errorf("SetPlan should not be called for invalid payload %q", payloadStr)
			}
		})
	}
}

func TestWebhookHandler_InvalidBody(t *testing.T) {
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader([]byte("not json")))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid body, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not be called for invalid body")
	}
}

func TestWebhookHandler_SetPlanError(t *testing.T) {
	merchantID := "test-merchant"
	secret := "test-secret"
	mock := &mockPlanUpdater{err: fmt.Errorf("user not found")}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "CONFIRMED",
		PaymentMethod: 12,
		Payload:       "user_nonexistent-uuid",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when SetPlan fails, got %d", w.Code)
	}
}

func TestWebhookHandler_ForgedWebhook_Rejected(t *testing.T) {
	// Simulates an attacker trying to forge a webhook to activate a free subscription.
	merchantID := "production-merchant"
	secret := "production-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, merchantID, secret)

	// Attempt 1: no credentials at all.
	payload := plategaWebhookPayload{
		ID:            "txn-123",
		Amount:        20.0,
		Currency:      "USD",
		Status:        "CONFIRMED",
		PaymentMethod: 12,
		Payload:       "user_attacker-uuid",
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("forged webhook should be rejected with 403, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("plan should not be activated by forged webhook")
	}

	// Attempt 2: guessed credentials.
	body2, _ := json.Marshal(payload)
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body2))
	req2.Header.Set("X-MerchantId", "guessed-merchant")
	req2.Header.Set("X-Secret", "guessed-secret")
	w2 := httptest.NewRecorder()
	handler(w2, req2)

	if w2.Code != http.StatusForbidden {
		t.Errorf("guessed credentials should be rejected with 403, got %d", w2.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("plan should not be activated by guessed credentials")
	}
}

func TestNilIfEmpty(t *testing.T) {
	if nilIfEmpty("") != nil {
		t.Error("expected nil for empty string")
	}
	result := nilIfEmpty("hello")
	if result == nil || *result != "hello" {
		t.Error("expected pointer to 'hello'")
	}
}

func TestStatusConstants(t *testing.T) {
	// Verify status constants have expected values.
	if StatusCreated != "created" {
		t.Errorf("StatusCreated = %q", StatusCreated)
	}
	if StatusPending != "pending" {
		t.Errorf("StatusPending = %q", StatusPending)
	}
	if StatusConfirmed != "confirmed" {
		t.Errorf("StatusConfirmed = %q", StatusConfirmed)
	}
	if StatusFailed != "failed" {
		t.Errorf("StatusFailed = %q", StatusFailed)
	}
	if StatusExpired != "expired" {
		t.Errorf("StatusExpired = %q", StatusExpired)
	}
}
