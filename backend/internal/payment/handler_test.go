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
	secret := "test-webhook-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	payload := webhookPayload{
		Status:  "success",
		OrderID: "user_550e8400-e29b-41d4-a716-446655440000",
		Token:   secret,
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
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

func TestWebhookHandler_InvalidToken(t *testing.T) {
	secret := "correct-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	payload := webhookPayload{
		Status:  "success",
		OrderID: "user_550e8400-e29b-41d4-a716-446655440000",
		Token:   "wrong-secret",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for invalid token, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not have been called for invalid token")
	}

	var resp errorResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Error != "invalid webhook token" {
		t.Errorf("unexpected error message: %s", resp.Error)
	}
}

func TestWebhookHandler_EmptySecret_Rejected(t *testing.T) {
	// When webhook secret is not configured, ALL webhooks must be rejected.
	// This prevents plan activation when the server is misconfigured.
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, "")

	payload := webhookPayload{
		Status:  "success",
		OrderID: "user_550e8400-e29b-41d4-a716-446655440000",
		Token:   "",
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

func TestWebhookHandler_NonSuccessStatus_Ignored(t *testing.T) {
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	for _, status := range []string{"pending", "expired", "cancelled", "failed"} {
		t.Run(status, func(t *testing.T) {
			mock.calls = nil
			payload := webhookPayload{
				Status:  status,
				OrderID: "user_550e8400-e29b-41d4-a716-446655440000",
				Token:   secret,
			}
			body, _ := json.Marshal(payload)

			req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
			w := httptest.NewRecorder()
			handler(w, req)

			if w.Code != http.StatusOK {
				t.Errorf("expected 200 for status %q, got %d", status, w.Code)
			}
			if len(mock.calls) != 0 {
				t.Errorf("SetPlan should not be called for status %q", status)
			}

			var resp map[string]string
			json.NewDecoder(w.Body).Decode(&resp)
			if resp["status"] != "ignored" {
				t.Errorf("expected ignored, got %s", resp["status"])
			}
		})
	}
}

func TestWebhookHandler_InvalidOrderID(t *testing.T) {
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	for _, orderID := range []string{"invalid", "payment_123", "user", ""} {
		t.Run(fmt.Sprintf("order_%s", orderID), func(t *testing.T) {
			mock.calls = nil
			payload := webhookPayload{
				Status:  "success",
				OrderID: orderID,
				Token:   secret,
			}
			body, _ := json.Marshal(payload)

			req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
			w := httptest.NewRecorder()
			handler(w, req)

			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400 for order_id %q, got %d", orderID, w.Code)
			}
			if len(mock.calls) != 0 {
				t.Errorf("SetPlan should not be called for invalid order_id %q", orderID)
			}
		})
	}
}

func TestWebhookHandler_InvalidBody(t *testing.T) {
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader([]byte("not json")))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid body, got %d", w.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("SetPlan should not be called for invalid body")
	}
}

func TestWebhookHandler_PaidStatus_Accepted(t *testing.T) {
	// CryptoCloud may send "paid" instead of "success" — both should activate the plan.
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	payload := webhookPayload{
		Status:  "paid",
		OrderID: "user_550e8400-e29b-41d4-a716-446655440000",
		Token:   secret,
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if len(mock.calls) != 1 {
		t.Fatalf("expected 1 SetPlan call for 'paid' status, got %d", len(mock.calls))
	}
	if mock.calls[0].Plan != "pro" {
		t.Errorf("expected plan 'pro', got %s", mock.calls[0].Plan)
	}
}

func TestWebhookHandler_SetPlanError(t *testing.T) {
	secret := "test-secret"
	mock := &mockPlanUpdater{err: fmt.Errorf("user not found")}
	handler := WebhookHandler(mock, nil, secret)

	payload := webhookPayload{
		Status:  "success",
		OrderID: "user_nonexistent-uuid",
		Token:   secret,
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when SetPlan fails, got %d", w.Code)
	}
}

func TestWebhookHandler_CryptoFieldsParsed(t *testing.T) {
	// Verify that crypto-specific fields from CryptoCloud webhooks are parsed correctly.
	secret := "test-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	payload := webhookPayload{
		Status:         "success",
		OrderID:        "user_550e8400-e29b-41d4-a716-446655440000",
		Token:          secret,
		AmountCrypto:   "0.0042",
		CryptoCurrency: "BTC",
		CryptoNetwork:  "bitcoin",
		TxHash:         "abc123def456",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if len(mock.calls) != 1 {
		t.Fatalf("expected 1 SetPlan call, got %d", len(mock.calls))
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

func TestWebhookHandler_ForgedWebhook_Rejected(t *testing.T) {
	// Simulates an attacker trying to forge a webhook to activate a free subscription.
	// The success redirect page is static HTML and never calls this endpoint,
	// so the ONLY way to activate a plan is through a properly signed webhook.
	secret := "production-secret"
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, nil, secret)

	// Attempt 1: guessed token → rejected
	payload := webhookPayload{
		Status:  "success",
		OrderID: "user_attacker-uuid",
		Token:   "guessed-token",
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

	// Attempt 2: empty token → rejected
	payload2 := webhookPayload{
		Status:  "success",
		OrderID: "user_attacker-uuid",
		Token:   "",
	}
	body2, _ := json.Marshal(payload2)
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/payments/webhook", bytes.NewReader(body2))
	w2 := httptest.NewRecorder()
	handler(w2, req2)

	if w2.Code != http.StatusForbidden {
		t.Errorf("empty token webhook should be rejected with 403, got %d", w2.Code)
	}
	if len(mock.calls) != 0 {
		t.Error("plan should not be activated by empty-token webhook")
	}
}
