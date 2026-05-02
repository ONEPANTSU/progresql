package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/metrics"
)

// priceResponse represents the response from the price endpoint.
type priceResponse struct {
	Price         float64 `json:"price"`
	OriginalPrice float64 `json:"original_price"`
}

// PriceHandler returns the current price for the user, applying any active discount promo.
//
// @Summary      Get payment price
// @Description  Returns the current subscription price for the authenticated user, applying any active discount promo codes
// @Tags         payments
// @Produce      json
// @Security     BearerAuth
// @Success      200  {object}  priceResponse
// @Router       /api/v1/payment/price [get]
func PriceHandler(db *pgxpool.Pool) http.HandlerFunc {
	const basePrice = 1999.0
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		price := basePrice
		if claims := auth.ClaimsFromContext(r.Context()); claims != nil && claims.UserID != "" {
			price = applyDiscount(r.Context(), db, claims.UserID, basePrice)
		}
		_ = json.NewEncoder(w).Encode(priceResponse{
			Price:         price,
			OriginalPrice: basePrice,
		})
	}
}

// Payment status constants.
const (
	StatusCreated   = "created"
	StatusPending   = "pending"
	StatusConfirmed = "confirmed"
	StatusFailed    = "failed"
	StatusExpired   = "expired"
	StatusRefunded  = "refunded"
)

type errorResponse struct {
	Error string `json:"error"`
}

type createInvoiceHandlerResponse struct {
	PaymentURL string `json:"payment_url"`
}

// createInvoiceRequest represents the request body for creating a payment invoice.
type createInvoiceRequest struct {
	Amount             float64 `json:"amount"`
	Currency           string  `json:"currency"`
	PaymentMethod      int     `json:"payment_method"`
	PromoCode          string  `json:"promo_code"`
	SuccessRedirectURL string  `json:"success_redirect_url"`
	FailRedirectURL    string  `json:"fail_redirect_url"`
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

// CreateInvoiceHandler returns an HTTP handler that creates a Platega payment
// for the authenticated user. The payload field is set to "user_<ID>" so the
// webhook can map payments back to user accounts.
//
// @Summary      Create payment invoice (v1)
// @Description  Creates a Platega payment invoice for the authenticated user. Defaults to 20 USD if no amount is provided.
// @Tags         payments
// @Accept       json
// @Produce      json
// @Security     BearerAuth
// @Param        body  body      createInvoiceRequest         false  "Invoice parameters"
// @Success      200   {object}  createInvoiceHandlerResponse
// @Failure      401   {object}  errorResponse
// @Failure      404   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v1/payments/create-invoice [post]
func CreateInvoiceHandler(client *PlategaClient, userStore *auth.UserStore, db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}

		user, err := userStore.GetByID(claims.UserID)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "user not found"})
			return
		}

		orderID := fmt.Sprintf("user_%s", user.ID)

		// Parse amount from request body, default to 20 USD.
		var reqBody createInvoiceRequest
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil || reqBody.Amount <= 0 {
			reqBody.Amount = 20.0
		}
		if reqBody.Currency == "" {
			reqBody.Currency = "USD"
		}

		reqBody.Amount = applyDiscount(r.Context(), db, user.ID, reqBody.Amount)

		invoice, err := client.CreateInvoice(
			reqBody.Amount, reqBody.Currency, orderID, user.Email,
			reqBody.SuccessRedirectURL, reqBody.FailRedirectURL, reqBody.PaymentMethod,
		)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to create invoice"})
			return
		}

		// Record payment in database.
		if db != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			_, _ = db.Exec(ctx,
				`INSERT INTO payments (user_id, invoice_id, order_id, amount, currency, status,
				                       success_redirect_url, fail_redirect_url, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
				user.ID, invoice.TransactionID, orderID, reqBody.Amount, reqBody.Currency,
				StatusCreated, nilIfEmpty(reqBody.SuccessRedirectURL), nilIfEmpty(reqBody.FailRedirectURL))
		}

		// Prometheus: track payment creation.
		metrics.PaymentsTotal.WithLabelValues(StatusCreated, reqBody.Currency).Inc()
		metrics.PaymentsAmountTotal.WithLabelValues(reqBody.Currency).Add(reqBody.Amount)

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(createInvoiceHandlerResponse{
			PaymentURL: invoice.Redirect,
		})
	}
}

// plategaWebhookPayload represents the callback data sent by Platega.io.
// Platega sends headers X-MerchantId and X-Secret for authentication,
// and a JSON body with transaction details.
type plategaWebhookPayload struct {
	ID            string  `json:"id"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
	Status        string  `json:"status"`
	PaymentMethod int     `json:"paymentMethod"`
	Payload       string  `json:"payload"`
}

// WebhookHandler returns an HTTP handler that processes Platega payment
// callback notifications. It is unauthenticated by JWT (called by Platega servers)
// but verified via X-MerchantId and X-Secret headers.
// On successful payment (status=CONFIRMED) it grants 30 days of "pro" plan to
// the user identified by the payload field (format: "user_<ID>").
//
// @Summary      Platega payment webhook (v1)
// @Description  Receives payment callback from Platega.io. Verified via X-MerchantId and X-Secret headers. Grants 30 days of pro plan on CONFIRMED status.
// @Tags         payments
// @Accept       json
// @Produce      json
// @Param        X-MerchantId  header    string                 true  "Platega merchant ID"
// @Param        X-Secret      header    string                 true  "Platega webhook secret"
// @Param        body          body      plategaWebhookPayload  true  "Platega callback payload"
// @Success      200           {object}  map[string]string
// @Failure      400           {object}  errorResponse
// @Failure      403           {object}  errorResponse
// @Failure      500           {object}  errorResponse
// @Router       /api/v1/payments/webhook [post]
func WebhookHandler(planUpdater PlanUpdater, db *pgxpool.Pool, merchantID, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		log := zap.L().With(zap.String("handler", "webhook"))
		log.Info("received Platega callback", zap.String("content_type", r.Header.Get("Content-Type")))

		// Verify Platega credentials from headers.
		if merchantID == "" || secret == "" {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "webhook secret not configured"})
			return
		}

		headerMerchantID := r.Header.Get("X-MerchantId")
		headerSecret := r.Header.Get("X-Secret")

		if headerMerchantID != merchantID || headerSecret != secret {
			log.Warn("credential verification failed",
				zap.Bool("merchant_id_match", headerMerchantID == merchantID),
				zap.Bool("secret_match", headerSecret == secret))
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid webhook credentials"})
			return
		}

		// Read and parse JSON body.
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		var payload plategaWebhookPayload
		if err := json.Unmarshal(bodyBytes, &payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		log.Info("parsed callback", zap.String("status", payload.Status),
			zap.String("transaction_id", payload.ID), zap.String("payload", payload.Payload))

		// Only process confirmed payments.
		if payload.Status != "CONFIRMED" {
			// For non-confirmed statuses, update payment record if applicable.
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
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "ignored"})
			return
		}

		// Extract user ID from payload (format: "user_<UUID>").
		orderID := payload.Payload
		if len(orderID) <= 5 || orderID[:5] != "user_" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "invalid order_id format"})
			return
		}
		userID := orderID[5:]

		expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour).Format(time.RFC3339)

		if err := planUpdater.SetPlan(userID, "pro", &expiresAt); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(errorResponse{Error: "failed to update user plan"})
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

		log.Info("payment confirmed", zap.String("user_id", userID),
			zap.String("plan", "pro"), zap.String("transaction_id", payload.ID))

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}
