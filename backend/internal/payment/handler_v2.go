package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/metrics"
)

// CreateInvoiceHandlerV2 returns an HTTP handler that creates a Platega payment
// for the authenticated user via the v2 API. The payload field is set to
// "user_<ID>" so the webhook can map payments back to user accounts.
func CreateInvoiceHandlerV2(client *PlategaClient, userStore *auth.UserStore, db *pgxpool.Pool) http.HandlerFunc {
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
			PaymentMethod      int     `json:"payment_method"`
			PromoCode          string  `json:"promo_code"`
			SuccessRedirectURL string  `json:"success_redirect_url"`
			FailRedirectURL    string  `json:"fail_redirect_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil || reqBody.Amount <= 0 {
			reqBody.Amount = 20.0
		}
		if reqBody.Currency == "" {
			reqBody.Currency = "USD"
		}

		// Check for active discount promo code.
		if db != nil {
			var discountPercent int
			var discountAmount float64
			pctx, pcancel := context.WithTimeout(r.Context(), 3*time.Second)
			defer pcancel()
			err := db.QueryRow(pctx,
				`SELECT COALESCE(pc.discount_percent, 0), COALESCE(pc.discount_amount, 0)
				 FROM promo_code_uses pcu
				 JOIN promo_codes pc ON pc.id = pcu.promo_code_id
				 WHERE pcu.user_id = $1::uuid AND pc.type = 'discount' AND pc.is_active = true
				 ORDER BY pcu.applied_at DESC LIMIT 1`,
				user.ID,
			).Scan(&discountPercent, &discountAmount)
			if err == nil {
				if discountPercent > 0 {
					reqBody.Amount = reqBody.Amount * (1 - float64(discountPercent)/100)
				} else if discountAmount > 0 {
					reqBody.Amount = reqBody.Amount - discountAmount
				}
				if reqBody.Amount < 0.01 {
					reqBody.Amount = 0.01
				}
			}
		}

		invoice, err := client.CreateInvoice(
			reqBody.Amount, reqBody.Currency, orderID, user.Email,
			reqBody.SuccessRedirectURL, reqBody.FailRedirectURL, reqBody.PaymentMethod,
		)
		if err != nil {
			log.Printf("[v2/create-invoice] Platega error: %v", err)
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
			user.ID, invoice.TransactionID, orderID, reqBody.Amount, reqBody.Currency,
			StatusCreated, nilIfEmpty(reqBody.SuccessRedirectURL), nilIfEmpty(reqBody.FailRedirectURL))

		// Prometheus: track payment creation.
		metrics.PaymentsTotal.WithLabelValues(StatusCreated, reqBody.Currency).Inc()
		metrics.PaymentsAmountTotal.WithLabelValues(reqBody.Currency).Add(reqBody.Amount)

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(createInvoiceHandlerResponse{
			PaymentURL: invoice.Redirect,
		})
	}
}

// WebhookHandlerV2 returns an HTTP handler that processes Platega v2 payment
// callback notifications. It verifies X-MerchantId and X-Secret headers.
// On successful payment (status=CONFIRMED) it grants 30 days of "pro" plan to
// the user identified by the payload field (format: "user_<ID>").
func WebhookHandlerV2(planUpdater PlanUpdater, db *pgxpool.Pool, merchantID, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		log.Printf("[v2/webhook] received Platega callback Content-Type=%s", r.Header.Get("Content-Type"))

		// Verify Platega credentials from headers.
		if merchantID == "" || secret == "" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "webhook secret not configured"})
			return
		}

		headerMerchantID := r.Header.Get("X-MerchantId")
		headerSecret := r.Header.Get("X-Secret")

		if headerMerchantID != merchantID || headerSecret != secret {
			log.Printf("[v2/webhook] credential verification failed: merchantID match=%v, secret match=%v",
				headerMerchantID == merchantID, headerSecret == secret)
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid webhook credentials"})
			return
		}

		// Read and parse JSON body.
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}
		log.Printf("[v2/webhook] raw body: %s", string(bodyBytes))

		var payload plategaWebhookPayload
		if err := json.Unmarshal(bodyBytes, &payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		log.Printf("[v2/webhook] parsed: status=%s transactionID=%s payload=%s",
			payload.Status, payload.ID, payload.Payload)

		// Only process confirmed payments.
		if payload.Status != "CONFIRMED" {
			if db != nil && payload.Status == "CANCELED" {
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				defer cancel()
				_, _ = db.Exec(ctx,
					`UPDATE payments SET status = $1, updated_at = NOW()
					 WHERE invoice_id = $2 AND status IN ('created', 'pending')`,
					StatusFailed, payload.ID)

				currency := payload.Currency
				if currency == "" {
					currency = "unknown"
				}
				metrics.PaymentsTotal.WithLabelValues(StatusFailed, currency).Inc()
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{"status": "ignored"})
			return
		}

		// Extract user ID from payload (format: "user_<UUID>").
		orderID := payload.Payload
		if len(orderID) <= 5 || orderID[:5] != "user_" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid order_id format"})
			return
		}
		userID := orderID[5:]

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
				    SET status = $1, paid_at = NOW(), confirmed_at = NOW(), updated_at = NOW()
				  WHERE invoice_id = $2 AND status IN ('created', 'pending')`,
				StatusConfirmed, payload.ID)
		}

		// Prometheus: track confirmed payment and subscription activation.
		currency := payload.Currency
		if currency == "" {
			currency = "unknown"
		}
		metrics.PaymentsTotal.WithLabelValues(StatusConfirmed, currency).Inc()
		metrics.UserSubscriptionsActivatedTotal.WithLabelValues("pro").Inc()

		log.Printf("[v2/webhook] payment confirmed for user=%s plan=pro transactionID=%s", userID, payload.ID)

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}
