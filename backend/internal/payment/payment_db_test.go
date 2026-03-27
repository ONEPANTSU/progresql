package payment

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// badPaymentPool returns a pgxpool that always fails on queries (connection refused).
func badPaymentPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(),
		"postgres://x:x@127.0.0.1:9999/testdb?sslmode=disable")
	if err != nil {
		t.Skipf("could not create bad pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// mockSuccessPlategaServer creates an HTTP test server that returns a valid Platega
// transaction response. The caller is responsible for closing the returned server.
func mockSuccessPlategaServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(PlategaTransactionResponse{
			TransactionID: "txn-success-123",
			Redirect:      "https://pay.platega.io/test",
			Status:        "pending",
		})
	}))
}

// plategaClientWithMockServer builds a PlategaClient that redirects all requests
// to the provided mock server URL.
func plategaClientWithMockServer(t *testing.T, mockURL string) *PlategaClient {
	t.Helper()
	return &PlategaClient{
		merchantID: "test-merchant",
		apiKey:     "test-key",
		httpClient: &http.Client{
			Transport: &mockTransport{
				fn: func(req *http.Request) (*http.Response, error) {
					// Replace the host with the mock server URL.
					return http.DefaultTransport.RoundTrip(replaceHost(req, mockURL))
				},
			},
			Timeout: 5 * time.Second,
		},
	}
}

// ── CreateInvoiceHandler success + DB INSERT path ────────────────────────────

func TestCreateInvoiceHandler_Success_WithBadDB(t *testing.T) {
	// Register a user and set up claims.
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test User", "success-test@example.com", "P@ssw0rd123", false)

	svc := auth.NewJWTService("test-secret")
	userObj := &auth.User{ID: user.ID, Email: user.Email, Name: user.Name}
	token, _ := svc.GenerateUserToken(userObj)
	claims, _ := svc.ValidateToken(token)
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	// Use a bad pool — INSERT will fail silently (errors ignored via `_, _ = db.Exec(...)`).
	pool := badPaymentPool(t)

	// Mock Platega server that returns success.
	mock := mockSuccessPlategaServer(t)
	defer mock.Close()

	client := plategaClientWithMockServer(t, mock.URL)
	handler := CreateInvoiceHandler(client, store, pool)

	body := `{"amount":1999,"currency":"USD","payment_method":11}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/create-invoice", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on success, got %d: %s", w.Code, w.Body.String())
	}

	var resp createInvoiceHandlerResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.PaymentURL == "" {
		t.Error("expected non-empty PaymentURL")
	}
}

func TestCreateInvoiceHandler_DefaultAmount_WithBadDB(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test2", "default-amount@example.com", "P@ssw0rd123", false)

	svc := auth.NewJWTService("test-secret")
	token, _ := svc.GenerateUserToken(&auth.User{ID: user.ID, Email: user.Email, Name: user.Name})
	claims, _ := svc.ValidateToken(token)
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	pool := badPaymentPool(t)
	mock := mockSuccessPlategaServer(t)
	defer mock.Close()

	client := plategaClientWithMockServer(t, mock.URL)
	handler := CreateInvoiceHandler(client, store, pool)

	// Send empty body — should default to 20 USD.
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/create-invoice", bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// ── CreateInvoiceHandlerV2 success + DB INSERT path ───────────────────────────

func TestCreateInvoiceHandlerV2_Success_WithBadDB(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test V2", "v2-success@example.com", "P@ssw0rd123", false)

	svc := auth.NewJWTService("test-secret")
	token, _ := svc.GenerateUserToken(&auth.User{ID: user.ID, Email: user.Email, Name: user.Name})
	claims, _ := svc.ValidateToken(token)
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	pool := badPaymentPool(t)
	mock := mockSuccessPlategaServer(t)
	defer mock.Close()

	client := plategaClientWithMockServer(t, mock.URL)
	handler := CreateInvoiceHandlerV2(client, store, pool)

	body := `{"amount":1999,"currency":"RUB","payment_method":11}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/v2/create-invoice", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for v2 success, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateInvoiceHandlerV2_DefaultValues_WithBadDB(t *testing.T) {
	store := auth.NewUserStore(nil)
	user, _ := store.Register("Test V2 Defaults", "v2-defaults@example.com", "P@ssw0rd123", false)

	svc := auth.NewJWTService("test-secret")
	token, _ := svc.GenerateUserToken(&auth.User{ID: user.ID, Email: user.Email, Name: user.Name})
	claims, _ := svc.ValidateToken(token)
	ctx := context.WithValue(context.Background(), auth.ClaimsContextKey, claims)

	pool := badPaymentPool(t)
	mock := mockSuccessPlategaServer(t)
	defer mock.Close()

	client := plategaClientWithMockServer(t, mock.URL)
	handler := CreateInvoiceHandlerV2(client, store, pool)

	// Empty body — should default to 1999 RUB.
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/v2/create-invoice",
		bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for v2 defaults, got %d: %s", w.Code, w.Body.String())
	}
}

// ── applyDiscount with bad DB (error path) ────────────────────────────────────

func TestApplyDiscount_BadDB_ReturnsOriginalAmount(t *testing.T) {
	pool := badPaymentPool(t)
	ctx := context.Background()
	amount := applyDiscount(ctx, pool, "user-123", 100.0)
	if amount != 100.0 {
		t.Errorf("expected original amount 100.0 on DB error, got %.2f", amount)
	}
}

// ── WebhookHandler with bad DB (UPDATE path) ──────────────────────────────────

func TestWebhookHandler_ConfirmedPayment_BadDB(t *testing.T) {
	// CONFIRMED payment with bad DB — UPDATE silently fails, but plan is set
	// via the mock updater.
	pool := badPaymentPool(t)
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, pool, "merchant", "secret")

	payload := plategaWebhookPayload{
		ID:       "txn-webhook-db",
		Status:   "CONFIRMED",
		Currency: "USD",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "merchant")
	req.Header.Set("X-Secret", "secret")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for confirmed payment with bad DB, got %d", w.Code)
	}
}

func TestWebhookHandlerV2_ConfirmedPayment_BadDB(t *testing.T) {
	pool := badPaymentPool(t)
	mock := &mockPlanUpdater{}
	handler := WebhookHandlerV2(mock, pool, "merchant", "secret")

	payload := plategaWebhookPayload{
		ID:       "txn-v2-webhook-db",
		Status:   "CONFIRMED",
		Currency: "RUB",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/v2/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "merchant")
	req.Header.Set("X-Secret", "secret")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for v2 confirmed with bad DB, got %d", w.Code)
	}
}

func TestWebhookHandler_CanceledPayment_BadDB(t *testing.T) {
	pool := badPaymentPool(t)
	mock := &mockPlanUpdater{}
	handler := WebhookHandler(mock, pool, "merchant", "secret")

	payload := plategaWebhookPayload{
		ID:       "txn-cancel-baddb",
		Status:   "CANCELED",
		Currency: "USD",
		Payload:  "user_550e8400-e29b-41d4-a716-446655440000",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/webhook", bytes.NewReader(body))
	req.Header.Set("X-MerchantId", "merchant")
	req.Header.Set("X-Secret", "secret")
	w := httptest.NewRecorder()
	handler(w, req)

	// CANCELED with bad DB: UPDATE silently fails but returns 200 "ignored".
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for canceled with bad DB, got %d", w.Code)
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "ignored" {
		t.Errorf("expected status=ignored, got %q", resp["status"])
	}
}

