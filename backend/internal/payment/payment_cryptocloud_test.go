/*
* Created on Mar 27, 2026
* Test file for cryptocloud.go and discount.go
* File path: internal/payment/payment_cryptocloud_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package payment

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ── NewCryptoCloudClient ──────────────────────────────────────────────────────

func TestNewCryptoCloudClient(t *testing.T) {
	client := NewCryptoCloudClient("api-key-123", "shop-456")
	if client == nil {
		t.Fatal("expected non-nil CryptoCloudClient")
	}
	if client.apiKey != "api-key-123" {
		t.Errorf("apiKey: got %q, want %q", client.apiKey, "api-key-123")
	}
	if client.shopID != "shop-456" {
		t.Errorf("shopID: got %q, want %q", client.shopID, "shop-456")
	}
	if client.httpClient == nil {
		t.Error("expected non-nil httpClient")
	}
}

// ── CryptoCloudClient.CreateInvoice ──────────────────────────────────────────

func TestCryptoCloudClient_CreateInvoice_Success(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(CreateInvoiceResponse{
			Status: "success",
			Result: struct {
				UUID    string `json:"uuid"`
				Link    string `json:"link"`
				OrderID string `json:"order_id"`
			}{
				UUID:    "inv-uuid-001",
				Link:    "https://pay.cryptocloud.plus/inv-uuid-001",
				OrderID: "order-123",
			},
		})
	}))
	defer mockServer.Close()

	client := &CryptoCloudClient{
		apiKey: "test-api-key",
		shopID: "test-shop",
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

	resp, err := client.CreateInvoice(50.0, "USD", "order-123", "user@example.com")
	if err != nil {
		t.Fatalf("CreateInvoice: %v", err)
	}
	if resp.Result.UUID != "inv-uuid-001" {
		t.Errorf("UUID: got %q, want %q", resp.Result.UUID, "inv-uuid-001")
	}
	if resp.Result.Link == "" {
		t.Error("expected non-empty Link")
	}
}

func TestCryptoCloudClient_CreateInvoice_ServerError(t *testing.T) {
	client := &CryptoCloudClient{
		apiKey: "key",
		shopID: "shop",
		httpClient: &http.Client{
			Transport: &mockTransport{
				fn: func(req *http.Request) (*http.Response, error) {
					return &http.Response{
						StatusCode: http.StatusInternalServerError,
						Body:       http.NoBody,
					}, nil
				},
			},
		},
	}

	_, err := client.CreateInvoice(50.0, "USD", "order-abc", "user@example.com")
	if err == nil {
		t.Fatal("expected error for server error response")
	}
}

func TestCryptoCloudClient_CreateInvoice_NetworkError(t *testing.T) {
	import_err := "connection refused"
	client := &CryptoCloudClient{
		apiKey: "key",
		shopID: "shop",
		httpClient: &http.Client{
			Transport: &mockTransport{
				fn: func(req *http.Request) (*http.Response, error) {
					return nil, &networkError{msg: import_err}
				},
			},
		},
	}

	_, err := client.CreateInvoice(50.0, "USD", "order-net", "user@example.com")
	if err == nil {
		t.Fatal("expected error for network failure")
	}
}

// networkError is a simple error type used in tests.
type networkError struct{ msg string }

func (e *networkError) Error() string { return e.msg }

// ── applyDiscount ─────────────────────────────────────────────────────────────

func TestApplyDiscount_NilDB(t *testing.T) {
	// With nil db, amount should be returned unchanged.
	result := applyDiscount(context.Background(), nil, "user-123", 100.0)
	if result != 100.0 {
		t.Errorf("expected 100.0 with nil db, got %v", result)
	}
}

func TestApplyDiscount_NilDB_ZeroAmount(t *testing.T) {
	result := applyDiscount(context.Background(), nil, "user-xyz", 0.0)
	if result != 0.0 {
		t.Errorf("expected 0.0 with nil db, got %v", result)
	}
}
