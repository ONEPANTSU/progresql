package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/metrics"
)

// Plan prices in RUB.
const (
	PriceProRUB     = 1999.0
	PriceProPlusRUB = 5999.0
	MinBalanceTopUp = 100.0
	MaxBalanceTopUp = 100000.0
)

// resolvePlanPrice returns the price in RUB for the given subscription plan.
// Defaults to Pro price for unknown plans.
func resolvePlanPrice(plan string) float64 {
	switch plan {
	case "pro_plus":
		return PriceProPlusRUB
	default:
		return PriceProRUB
	}
}

// orderPayloadResult holds the parsed result of a Platega payment payload.
type orderPayloadResult struct {
	PaymentType string  // "subscription" or "balance_topup"
	Plan        string  // "pro", "pro_plus" — only for subscription
	UserID      string
	Amount      float64 // only for balance_topup
}

// parseOrderPayload parses the Platega payload field to determine payment type.
//
// Payload formats:
//   - "sub_pro_<userID>"       → subscription for pro plan
//   - "sub_pro_plus_<userID>"  → subscription for pro_plus plan
//   - "bal_<amount>_<userID>"  → balance top-up
//   - "user_<userID>"          → legacy format, treated as pro subscription
func parseOrderPayload(payload string) (*orderPayloadResult, error) {
	if payload == "" {
		return nil, fmt.Errorf("empty payload")
	}

	// Legacy format: user_<UUID>
	if strings.HasPrefix(payload, "user_") {
		userID := payload[5:]
		if userID == "" {
			return nil, fmt.Errorf("invalid legacy payload: empty user ID")
		}
		return &orderPayloadResult{
			PaymentType: "subscription",
			Plan:        "pro",
			UserID:      userID,
		}, nil
	}

	// Subscription: sub_<plan>_<userID>
	if strings.HasPrefix(payload, "sub_") {
		rest := payload[4:]
		// Handle pro_plus first (contains underscore in plan name).
		if strings.HasPrefix(rest, "pro_plus_") {
			userID := rest[9:] // len("pro_plus_") = 9
			if userID == "" {
				return nil, fmt.Errorf("invalid subscription payload: empty user ID")
			}
			return &orderPayloadResult{
				PaymentType: "subscription",
				Plan:        "pro_plus",
				UserID:      userID,
			}, nil
		}
		// Pro plan: sub_pro_<userID>
		if strings.HasPrefix(rest, "pro_") {
			userID := rest[4:] // len("pro_") = 4
			if userID == "" {
				return nil, fmt.Errorf("invalid subscription payload: empty user ID")
			}
			return &orderPayloadResult{
				PaymentType: "subscription",
				Plan:        "pro",
				UserID:      userID,
			}, nil
		}
		return nil, fmt.Errorf("invalid subscription payload: unknown plan in %q", payload)
	}

	// Balance top-up: bal_<amount>_<userID>
	if strings.HasPrefix(payload, "bal_") {
		rest := payload[4:]
		idx := strings.Index(rest, "_")
		if idx <= 0 {
			return nil, fmt.Errorf("invalid balance payload: missing amount/userID separator in %q", payload)
		}
		amountStr := rest[:idx]
		userID := rest[idx+1:]
		if userID == "" {
			return nil, fmt.Errorf("invalid balance payload: empty user ID")
		}
		amount, err := strconv.ParseFloat(amountStr, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid balance payload: bad amount %q: %w", amountStr, err)
		}
		return &orderPayloadResult{
			PaymentType: "balance_topup",
			Amount:      amount,
			UserID:      userID,
		}, nil
	}

	return nil, fmt.Errorf("unrecognized payload format: %q", payload)
}

// createInvoiceRequestV2 is the request body for v2 invoice creation.
type createInvoiceRequestV2 struct {
	PaymentType        string  `json:"payment_type"`         // "subscription" (default) or "balance_topup"
	Plan               string  `json:"plan"`                 // "pro" (default) or "pro_plus"
	Amount             float64 `json:"amount"`               // for balance_topup: top-up amount in RUB
	Currency           string  `json:"currency"`
	PaymentMethod      int     `json:"payment_method"`
	PromoCode          string  `json:"promo_code"`
	SuccessRedirectURL string  `json:"success_redirect_url"`
	FailRedirectURL    string  `json:"fail_redirect_url"`
}

// BalanceTopUpHandler is an interface for topping up balance from webhook.
type BalanceTopUpHandler interface {
	TopUp(ctx context.Context, userID string, amount float64, description string) error
}

// CreateInvoiceHandlerV2 returns an HTTP handler that creates a Platega payment
// for the authenticated user via the v2 API. Supports both subscription payments
// (pro/pro_plus) and balance top-ups.
//
// Payment types:
//   - "subscription" (default): pays for a subscription plan. Plan can be "pro" (1999₽) or "pro_plus" (5999₽).
//   - "balance_topup": adds funds to user's balance. Amount must be between 100₽ and 100,000₽.
//
// @Summary      Create payment invoice (v2)
// @Description  Creates a Platega payment invoice. Supports subscription (pro/pro_plus) and balance top-up.
// @Tags         payments
// @Accept       json
// @Produce      json
// @Security     BearerAuth
// @Param        body  body      createInvoiceRequestV2       false  "Invoice parameters"
// @Success      200   {object}  createInvoiceHandlerResponse
// @Failure      400   {object}  errorResponse
// @Failure      401   {object}  errorResponse
// @Failure      404   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v2/payments/create-invoice [post]
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

		var reqBody createInvoiceRequestV2
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
			// Defaults applied below.
		}
		if reqBody.Currency == "" {
			reqBody.Currency = "RUB"
		}
		if reqBody.PaymentMethod == 0 {
			reqBody.PaymentMethod = 11 // Card acquiring
		}
		if reqBody.PaymentType == "" {
			reqBody.PaymentType = "subscription"
		}
		if reqBody.Plan == "" {
			reqBody.Plan = "pro"
		}

		var orderID string
		var invoiceAmount float64
		var paymentPlan *string // nullable for DB storage

		switch reqBody.PaymentType {
		case "subscription":
			// Validate plan.
			if reqBody.Plan != "pro" && reqBody.Plan != "pro_plus" {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{Error: "invalid plan: must be 'pro' or 'pro_plus'"})
				return
			}
			invoiceAmount = resolvePlanPrice(reqBody.Plan)
			invoiceAmount = applyDiscount(r.Context(), db, user.ID, invoiceAmount)
			orderID = fmt.Sprintf("sub_%s_%s", reqBody.Plan, user.ID)
			planStr := reqBody.Plan
			paymentPlan = &planStr

		case "balance_topup":
			if reqBody.Amount < MinBalanceTopUp {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{
					Error: fmt.Sprintf("minimum top-up amount is %.0f₽", MinBalanceTopUp),
				})
				return
			}
			if reqBody.Amount > MaxBalanceTopUp {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{
					Error: fmt.Sprintf("maximum top-up amount is %.0f₽", MaxBalanceTopUp),
				})
				return
			}
			invoiceAmount = reqBody.Amount
			orderID = fmt.Sprintf("bal_%.2f_%s", reqBody.Amount, user.ID)

		default:
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid payment_type: must be 'subscription' or 'balance_topup'"})
			return
		}

		invoice, err := client.CreateInvoice(
			invoiceAmount, reqBody.Currency, orderID, user.Email,
			reqBody.SuccessRedirectURL, reqBody.FailRedirectURL, reqBody.PaymentMethod,
		)
		if err != nil {
			zap.L().Error("v2/create-invoice: Platega error",
				zap.Error(err), zap.String("payment_type", reqBody.PaymentType))
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to create invoice"})
			return
		}

		// Record payment in database.
		if db != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			_, _ = db.Exec(ctx,
				`INSERT INTO payments (user_id, invoice_id, order_id, amount, currency, status,
				                       plan, payment_type,
				                       success_redirect_url, fail_redirect_url, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
				user.ID, invoice.TransactionID, orderID, invoiceAmount, reqBody.Currency,
				StatusCreated, paymentPlan, reqBody.PaymentType,
				nilIfEmpty(reqBody.SuccessRedirectURL), nilIfEmpty(reqBody.FailRedirectURL))
		}

		// Prometheus: track payment creation.
		metrics.PaymentsTotal.WithLabelValues(StatusCreated, reqBody.Currency).Inc()
		metrics.PaymentsAmountTotal.WithLabelValues(reqBody.Currency).Add(invoiceAmount)

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(createInvoiceHandlerResponse{
			PaymentURL: invoice.Redirect,
		})
	}
}

// WebhookHandlerV2 returns an HTTP handler that processes Platega v2 payment
// callback notifications. It verifies X-MerchantId and X-Secret headers.
//
// Supports two payment types based on payload format:
//   - Subscription (sub_<plan>_<userID> or legacy user_<userID>): grants plan for 30 days
//   - Balance top-up (bal_<amount>_<userID>): credits balance
//
// @Summary      Platega payment webhook (v2)
// @Description  Receives payment callback from Platega.io. Handles subscription and balance top-up payments.
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
// @Router       /api/v2/payments/webhook [post]
func WebhookHandlerV2(planUpdater PlanUpdater, balanceSvc BalanceTopUpHandler, db *pgxpool.Pool, merchantID, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		log := zap.L().With(zap.String("handler", "v2/webhook"))
		log.Info("received Platega callback", zap.String("content_type", r.Header.Get("Content-Type")))

		// Verify Platega credentials from headers.
		if merchantID == "" || secret == "" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "webhook secret not configured"})
			return
		}

		headerMerchantID := r.Header.Get("X-MerchantId")
		headerSecret := r.Header.Get("X-Secret")

		if headerMerchantID != merchantID || headerSecret != secret {
			log.Warn("credential verification failed",
				zap.Bool("merchant_id_match", headerMerchantID == merchantID),
				zap.Bool("secret_match", headerSecret == secret))
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

		var payload plategaWebhookPayload
		if err := json.Unmarshal(bodyBytes, &payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		log.Info("parsed callback", zap.String("status", payload.Status),
			zap.String("transaction_id", payload.ID), zap.String("payload", payload.Payload))

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

		// Parse the order payload to determine payment type.
		parsed, err := parseOrderPayload(payload.Payload)
		if err != nil {
			log.Error("failed to parse order payload",
				zap.String("payload", payload.Payload), zap.Error(err))
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid order_id format"})
			return
		}

		currency := payload.Currency
		if currency == "" {
			currency = "unknown"
		}

		switch parsed.PaymentType {
		case "subscription":
			expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour).Format(time.RFC3339)

			if err := planUpdater.SetPlan(parsed.UserID, parsed.Plan, &expiresAt); err != nil {
				log.Error("failed to update user plan",
					zap.String("user_id", parsed.UserID), zap.String("plan", parsed.Plan), zap.Error(err))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to update user plan"})
				return
			}

			metrics.UserSubscriptionsActivatedTotal.WithLabelValues(parsed.Plan).Inc()
			log.Info("subscription payment confirmed",
				zap.String("user_id", parsed.UserID),
				zap.String("plan", parsed.Plan),
				zap.String("transaction_id", payload.ID))

		case "balance_topup":
			if balanceSvc == nil {
				log.Error("balance service not configured")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "balance service not available"})
				return
			}

			description := fmt.Sprintf("Top-up via Platega (tx: %s)", payload.ID)
			if err := balanceSvc.TopUp(r.Context(), parsed.UserID, parsed.Amount, description); err != nil {
				log.Error("failed to top up balance",
					zap.String("user_id", parsed.UserID),
					zap.Float64("amount", parsed.Amount), zap.Error(err))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to credit balance"})
				return
			}

			metrics.BalanceTopUpsTotal.Inc()
			metrics.BalanceTopUpsAmountTotal.Add(parsed.Amount)
			log.Info("balance top-up confirmed",
				zap.String("user_id", parsed.UserID),
				zap.Float64("amount", parsed.Amount),
				zap.String("transaction_id", payload.ID))
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

		// Prometheus: track confirmed payment.
		metrics.PaymentsTotal.WithLabelValues(StatusConfirmed, currency).Inc()

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}

// PriceHandlerV2 returns prices for all available subscription plans.
//
// @Summary      Get subscription prices
// @Description  Returns prices for Pro and Pro Plus plans, with active discount applied.
// @Tags         payments
// @Produce      json
// @Security     BearerAuth
// @Success      200  {object}  pricesResponse
// @Router       /api/v2/payment/prices [get]
func PriceHandlerV2(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		var userID string
		if claims := auth.ClaimsFromContext(r.Context()); claims != nil {
			userID = claims.UserID
		}

		proPrice := PriceProRUB
		proPlusPrice := PriceProPlusRUB
		if userID != "" {
			proPrice = applyDiscount(r.Context(), db, userID, PriceProRUB)
			proPlusPrice = applyDiscount(r.Context(), db, userID, PriceProPlusRUB)
		}

		json.NewEncoder(w).Encode(pricesResponse{
			Plans: []planPrice{
				{
					Plan:          "pro",
					Price:         proPrice,
					OriginalPrice: PriceProRUB,
					Currency:      "RUB",
					Period:        "month",
				},
				{
					Plan:          "pro_plus",
					Price:         proPlusPrice,
					OriginalPrice: PriceProPlusRUB,
					Currency:      "RUB",
					Period:        "month",
				},
			},
			MinBalanceTopUp: MinBalanceTopUp,
			MaxBalanceTopUp: MaxBalanceTopUp,
		})
	}
}

// pricesResponse is the JSON response for the v2 prices endpoint.
type pricesResponse struct {
	Plans           []planPrice `json:"plans"`
	MinBalanceTopUp float64     `json:"min_balance_topup"`
	MaxBalanceTopUp float64     `json:"max_balance_topup"`
}

// planPrice describes a single plan's pricing.
type planPrice struct {
	Plan          string  `json:"plan"`
	Price         float64 `json:"price"`
	OriginalPrice float64 `json:"original_price"`
	Currency      string  `json:"currency"`
	Period        string  `json:"period"`
}
