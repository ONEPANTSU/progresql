package payment

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// ── PriceHandler ─────────────────────────────────────────────────────────────

func TestPriceHandler_NoAuth(t *testing.T) {
	handler := PriceHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/payment/price", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]float64
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["price"] != 1999.0 {
		t.Errorf("expected base price 1999.0, got %v", resp["price"])
	}
	if resp["original_price"] != 1999.0 {
		t.Errorf("expected original_price 1999.0, got %v", resp["original_price"])
	}
}

func TestPriceHandler_WithAuthNilDB(t *testing.T) {
	// Authenticated user but nil DB → returns base price.
	handler := PriceHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/payment/price", nil)

	svc := auth.NewJWTService("test-secret")
	user := &auth.User{ID: "user-123", Email: "test@example.com", Name: "Test"}
	token, _ := svc.GenerateUserToken(user)
	claims, _ := svc.ValidateToken(token)
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]float64
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["price"] != 1999.0 {
		t.Errorf("expected base price with nil DB, got %v", resp["price"])
	}
}

// ── WebhookHandlerV2 ─────────────────────────────────────────────────────────

func TestWebhookHandlerV2_ValidPayment(t *testing.T) {
	merchantID := "merchant-v2"
	secret := "secret-v2"
	mock := &mockPlanUpdater{}
	handler := WebhookHandlerV2(mock, nil, merchantID, secret)

	payload := plategaWebhookPayload{
		ID:       "txn-v2-123",
		Amount:   1999.0,
		Currency: "RUB",
		Status:   "CONFIRMED",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/v2/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", merchantID)
	req.Header.Set("X-Secret", secret)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if len(mock.calls) != 1 {
		t.Fatalf("expected 1 SetPlan call, got %d", len(mock.calls))
	}
	if mock.calls[0].Plan != "pro" {
		t.Errorf("expected plan=pro, got %q", mock.calls[0].Plan)
	}
	if mock.calls[0].UserID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("unexpected userID: %q", mock.calls[0].UserID)
	}
}

func TestWebhookHandlerV2_InvalidCredentials(t *testing.T) {
	handler := WebhookHandlerV2(&mockPlanUpdater{}, nil, "merchant", "secret")

	payload := plategaWebhookPayload{Status: "CONFIRMED", Payload: "user_123"}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "merchant")
	req.Header.Set("X-Secret", "wrong-secret")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestWebhookHandlerV2_NotConfigured(t *testing.T) {
	// Empty merchantID/secret → 500.
	handler := WebhookHandlerV2(&mockPlanUpdater{}, nil, "", "")

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestWebhookHandlerV2_PendingStatus(t *testing.T) {
	handler := WebhookHandlerV2(&mockPlanUpdater{}, nil, "m", "s")

	payload := plategaWebhookPayload{Status: "PENDING", Payload: "user_123"}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "m")
	req.Header.Set("X-Secret", "s")
	w := httptest.NewRecorder()
	handler(w, req)

	// Non-CONFIRMED status should return 200 with "ignored".
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for non-confirmed, got %d", w.Code)
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "ignored" {
		t.Errorf("expected status=ignored, got %q", resp["status"])
	}
}

func TestWebhookHandlerV2_InvalidPayload(t *testing.T) {
	handler := WebhookHandlerV2(&mockPlanUpdater{}, nil, "m", "s")

	payload := plategaWebhookPayload{
		Status:  "CONFIRMED",
		Payload: "invalid-format", // not "user_<UUID>"
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "m")
	req.Header.Set("X-Secret", "s")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid payload format, got %d", w.Code)
	}
}

func TestWebhookHandlerV2_InvalidJSON(t *testing.T) {
	handler := WebhookHandlerV2(&mockPlanUpdater{}, nil, "m", "s")

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewBufferString("not json"))
	req.Header.Set("X-MerchantId", "m")
	req.Header.Set("X-Secret", "s")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid JSON, got %d", w.Code)
	}
}

// ── CreateInvoiceHandlerV2 ────────────────────────────────────────────────────

func TestCreateInvoiceHandlerV2_Unauthorized(t *testing.T) {
	handler := CreateInvoiceHandlerV2(nil, auth.NewUserStore(nil), nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/v2/create-invoice", bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestCreateInvoiceHandlerV2_UserNotFound(t *testing.T) {
	store := auth.NewUserStore(nil) // empty store
	handler := CreateInvoiceHandlerV2(nil, store, nil)

	claims := &auth.Claims{UserID: "nonexistent-user-id"}
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/create-invoice", bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestCreateInvoiceHandlerV2_PlategaError(t *testing.T) {
	// Mock Platega server that returns an error.
	mockPlatega := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"payment failed"}`))
	}))
	defer mockPlatega.Close()

	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test", "test@example.com", "P@ssw0rd123", false)

	// Create platega client pointing to mock server.
	client := &PlategaClient{
		merchantID: "test-merchant",
		apiKey:     "test-key",
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
	// Override base URL is not possible with current struct, so we test the error path
	// by using an invalid URL client.
	client.httpClient.Transport = &mockTransport{
		fn: func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusInternalServerError,
				Body:       http.NoBody,
			}, nil
		},
	}

	svc := auth.NewJWTService("test-secret")
	userObj := &auth.User{ID: user.ID, Email: user.Email, Name: user.Name}
	token, _ := svc.GenerateUserToken(userObj)
	parsed, _ := svc.ValidateToken(token)
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, parsed)

	handler := CreateInvoiceHandlerV2(client, store, nil)
	body := `{"amount":1999,"currency":"RUB","payment_method":11}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/create-invoice", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for Platega error, got %d: %s", w.Code, w.Body.String())
	}
}

// ── PlategaClient ─────────────────────────────────────────────────────────────

func TestPlategaClient_CreateInvoice_Success(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-MerchantId") == "" || r.Header.Get("X-Secret") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(PlategaTransactionResponse{
			TransactionID: "txn-001",
			Redirect:      "https://pay.platega.io/redirect/txn-001",
			Status:        "created",
		})
	}))
	defer mockServer.Close()

	client := &PlategaClient{
		merchantID: "test-merchant",
		apiKey:     "test-key",
		httpClient: &http.Client{
			Transport: &mockTransport{
				fn: func(req *http.Request) (*http.Response, error) {
					return http.DefaultTransport.RoundTrip(
						replaceHost(req, mockServer.URL),
					)
				},
			},
		},
	}

	invoice, err := client.CreateInvoice(1999.0, "RUB", "user_123", "test@example.com", "", "", 11)
	if err != nil {
		t.Fatalf("CreateInvoice: %v", err)
	}
	if invoice.TransactionID != "txn-001" {
		t.Errorf("TransactionID: got %q", invoice.TransactionID)
	}
	if invoice.Redirect == "" {
		t.Error("expected non-empty Redirect")
	}
}

func TestPlategaClient_CreateInvoice_DefaultPaymentMethod(t *testing.T) {
	var capturedBody PlategaTransactionRequest
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&capturedBody)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(PlategaTransactionResponse{TransactionID: "txn-002", Redirect: "https://pay.platega.io"})
	}))
	defer mockServer.Close()

	client := &PlategaClient{
		merchantID: "m",
		apiKey:     "k",
		httpClient: &http.Client{
			Transport: &mockTransport{fn: func(req *http.Request) (*http.Response, error) {
				return http.DefaultTransport.RoundTrip(replaceHost(req, mockServer.URL))
			}},
		},
	}

	// paymentMethod=0 should default to 11 (card)
	_, err := client.CreateInvoice(100.0, "RUB", "user_123", "test@example.com", "", "", 0)
	if err != nil {
		t.Fatalf("CreateInvoice: %v", err)
	}
	if capturedBody.PaymentMethod != 11 {
		t.Errorf("expected default payment method 11, got %d", capturedBody.PaymentMethod)
	}
}

func TestNewPlategaClient(t *testing.T) {
	client := NewPlategaClient("merchant-id", "api-key")
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	if client.merchantID != "merchant-id" {
		t.Errorf("merchantID: got %q", client.merchantID)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

type mockTransport struct {
	fn func(*http.Request) (*http.Response, error)
}

func (m *mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return m.fn(req)
}

func replaceHost(req *http.Request, baseURL string) *http.Request {
	r2 := req.Clone(req.Context())
	parsed := *req.URL
	parsed.Scheme = "http"
	// Extract just host:port from mockServer URL.
	server := baseURL
	if len(server) > 7 && server[:7] == "http://" {
		server = server[7:]
	}
	parsed.Host = server
	r2.URL = &parsed
	return r2
}

