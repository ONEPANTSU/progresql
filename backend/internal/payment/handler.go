package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"log"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/onepantsu/progressql/backend/internal/auth"
)

// Payment status constants aligned with CryptoCloud lifecycle.
const (
	StatusCreated   = "created"
	StatusPending   = "pending"
	StatusConfirmed = "confirmed"
	StatusFailed    = "failed"
	StatusExpired   = "expired"
)

type errorResponse struct {
	Error string `json:"error"`
}

type createInvoiceHandlerResponse struct {
	PaymentURL string `json:"payment_url"`
}

// PlanUpdater abstracts user plan updates so the webhook handler can be tested
// without a real database connection.
type PlanUpdater interface {
	SetPlan(userID, plan string, expiresAt *string) error
}

// nilIfEmpty returns nil for empty strings, otherwise a pointer to the string.
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// CreateInvoiceHandler returns an HTTP handler that creates a CryptoCloud invoice
// for the authenticated user. The invoice order_id is set to "user_<ID>" so the
// webhook can map payments back to user accounts.
func CreateInvoiceHandler(client *CryptoCloudClient, userStore *auth.UserStore, db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		user, err := userStore.GetByID(claims.UserID)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(errorResponse{Error: "user not found"})
			return
		}

		orderID := fmt.Sprintf("user_%s", user.ID)

		// Parse amount from request body, default to 20 USD.
		var reqBody struct {
			Amount             float64 `json:"amount"`
			Currency           string  `json:"currency"`
			SuccessRedirectURL string  `json:"success_redirect_url"`
			FailRedirectURL    string  `json:"fail_redirect_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil || reqBody.Amount <= 0 {
			reqBody.Amount = 20.0
		}
		if reqBody.Currency == "" {
			reqBody.Currency = "USD"
		}

		invoice, err := client.CreateInvoice(reqBody.Amount, reqBody.Currency, orderID, user.Email)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to create invoice"})
			return
		}

		// Record payment in database.
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		_, _ = db.Exec(ctx,
			`INSERT INTO payments (user_id, invoice_id, order_id, amount, currency, status,
			                       success_redirect_url, fail_redirect_url, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
			user.ID, invoice.Result.UUID, orderID, reqBody.Amount, reqBody.Currency,
			StatusCreated, nilIfEmpty(reqBody.SuccessRedirectURL), nilIfEmpty(reqBody.FailRedirectURL))

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(createInvoiceHandlerResponse{
			PaymentURL: invoice.Result.Link,
		})
	}
}

// webhookPayload represents the postback data sent by CryptoCloud.
type webhookPayload struct {
	Status       string `json:"status"`
	InvoiceID    string `json:"invoice_id"`
	OrderID      string `json:"order_id"`
	AmountCrypto string `json:"amount_crypto"`
	Currency     string `json:"currency"`
	Token        string `json:"token"`
	// Crypto-specific fields sent by CryptoCloud.
	CryptoCurrency string `json:"currency_received,omitempty"`
	CryptoNetwork  string `json:"network,omitempty"`
	TxHash         string `json:"txid,omitempty"`
}

// WebhookHandler returns an HTTP handler that processes CryptoCloud payment
// postback notifications. It is unauthenticated (called by CryptoCloud servers).
// On successful payment it grants 30 days of "pro" plan to the user identified
// by the order_id field (format: "user_<ID>").
func WebhookHandler(planUpdater PlanUpdater, db *pgxpool.Pool, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		log.Printf("[webhook] received postback Content-Type=%s", r.Header.Get("Content-Type"))

		var payload webhookPayload

		contentType := r.Header.Get("Content-Type")
		if strings.HasPrefix(contentType, "application/x-www-form-urlencoded") {
			// CryptoCloud v2 sends postbacks as form-urlencoded.
			if err := r.ParseForm(); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
				return
			}
			payload = webhookPayload{
				Status:         r.FormValue("status"),
				InvoiceID:      r.FormValue("invoice_id"),
				OrderID:        r.FormValue("order_id"),
				AmountCrypto:   r.FormValue("amount_crypto"),
				Currency:       r.FormValue("currency"),
				Token:          r.FormValue("token"),
				CryptoCurrency: r.FormValue("currency_received"),
				CryptoNetwork:  r.FormValue("network"),
				TxHash:         r.FormValue("txid"),
			}
		} else {
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
				return
			}
		}

		log.Printf("[webhook] parsed: status=%s invoice=%s order=%s", payload.Status, payload.InvoiceID, payload.OrderID)

		// Verify the webhook secret token. Secret MUST be configured —
		// without it anyone could forge a webhook and activate subscriptions.
		if secret == "" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "webhook secret not configured"})
			return
		}
		if payload.Token != secret {
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid webhook token"})
			return
		}

		// Only process successful payments.
		incomingStatus := strings.ToLower(payload.Status)
		if incomingStatus != "success" && incomingStatus != "paid" {
			// For non-success statuses, update payment record if applicable.
			if db != nil && (incomingStatus == "failed" || incomingStatus == "expired") {
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				defer cancel()
				_, _ = db.Exec(ctx,
					`UPDATE payments SET status = $1, updated_at = NOW()
					 WHERE order_id = $2 AND status IN ('created', 'pending')`,
					incomingStatus, payload.OrderID)
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{"status": "ignored"})
			return
		}

		// Extract user ID from order_id (format: "user_<UUID>").
		if !strings.HasPrefix(payload.OrderID, "user_") {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid order_id format"})
			return
		}
		userID := strings.TrimPrefix(payload.OrderID, "user_")

		expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour).Format(time.RFC3339)

		if err := planUpdater.SetPlan(userID, "pro", &expiresAt); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to update user plan"})
			return
		}

		// Update payment record in database.
		if db != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			_, _ = db.Exec(ctx,
				`UPDATE payments
				    SET status = $1, paid_at = NOW(), confirmed_at = NOW(), updated_at = NOW(),
				        crypto_currency = $2, crypto_network = $3, tx_hash = $4
				  WHERE order_id = $5 AND status IN ('created', 'pending')`,
				StatusConfirmed,
				nilIfEmpty(payload.CryptoCurrency),
				nilIfEmpty(payload.CryptoNetwork),
				nilIfEmpty(payload.TxHash),
				payload.OrderID)
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}
