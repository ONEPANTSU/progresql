package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/metrics"
)

// BalanceRefundHandler abstracts the balance deduction for payment refunds.
type BalanceRefundHandler interface {
	DeductForRefund(ctx context.Context, userID string, amount float64, description string) error
}

// refundPolicyDays is the number of days after payment within which a refund is allowed.
const refundPolicyDays = 14

// stripTimestampSuffix removes the trailing _<unix_timestamp> suffix from an
// order ID so that it can be parsed by parseOrderPayload.
// Example: "sub_pro_abc123_1711929600" -> "sub_pro_abc123"
func stripTimestampSuffix(orderID string) string {
	idx := strings.LastIndex(orderID, "_")
	if idx < 0 {
		return orderID
	}
	suffix := orderID[idx+1:]
	// Check that the suffix is numeric (unix timestamp).
	if _, err := strconv.ParseInt(suffix, 10, 64); err != nil {
		return orderID
	}
	return orderID[:idx]
}

// resolveDescription returns a human-readable payment description for T-Bank.
func resolveDescription(paymentType, plan string) string {
	switch paymentType {
	case "subscription":
		return "ProgreSQL Pro subscription"
	case "balance_topup":
		return "ProgreSQL balance top-up"
	default:
		return "ProgreSQL payment"
	}
}

// CreateInvoiceHandlerV3 returns an HTTP handler that creates a T-Bank payment
// for the authenticated user. Supports both subscription payments (pro/pro_plus)
// and balance top-ups.
func CreateInvoiceHandlerV3(client *TBankClient, userStore *auth.UserStore, db *pgxpool.Pool, notificationURL string) http.HandlerFunc {
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
		if reqBody.PaymentType == "" {
			reqBody.PaymentType = "subscription"
		}
		if reqBody.Plan == "" {
			reqBody.Plan = "pro"
		}

		var orderID string
		var invoiceAmount float64
		var paymentPlan *string
		var description string

		ts := time.Now().Unix()
		// T-Bank OrderId max ~36 chars. Use first 8 chars of user ID.
		shortUID := user.ID
		if len(shortUID) > 8 {
			shortUID = shortUID[:8]
		}

		switch reqBody.PaymentType {
		case "subscription":
			// Normalize legacy plan names to "pro".
			if reqBody.Plan == "pro_plus" || reqBody.Plan == "team" {
				reqBody.Plan = "pro"
			}
			if reqBody.Plan != "pro" {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{Error: "invalid plan: must be 'pro'"})
				return
			}
			invoiceAmount = resolvePlanPrice(reqBody.Plan)
			invoiceAmount = applyDiscount(r.Context(), db, user.ID, invoiceAmount)
			orderID = fmt.Sprintf("sub_%s_%s_%d", reqBody.Plan, shortUID, ts)
			planStr := reqBody.Plan
			paymentPlan = &planStr
			description = resolveDescription("subscription", reqBody.Plan)

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
			orderID = fmt.Sprintf("bal_%.0f_%s_%d", reqBody.Amount, shortUID, ts)
			description = resolveDescription("balance_topup", "")

		default:
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid payment_type: must be 'subscription' or 'balance_topup'"})
			return
		}

		// Amount in kopecks for T-Bank.
		amountKopecks := int64(invoiceAmount * 100)

		// Build 54-FZ receipt.
		receipt := &TBankReceipt{
			Email:    user.Email,
			Taxation: "usn_income",
			Items: []TBankReceiptItem{
				{
					Name:          description,
					Price:         amountKopecks,
					Quantity:      1.00,
					Amount:        amountKopecks,
					Tax:           "none",
					PaymentMethod: "full_payment",
					PaymentObject: "service",
				},
			},
		}

		result, err := client.Init(r.Context(), TBankInitRequest{
			Amount:          amountKopecks,
			OrderId:         orderID,
			Description:     description,
			CustomerKey:     user.ID,
			NotificationURL: notificationURL,
			SuccessURL:      reqBody.SuccessRedirectURL,
			FailURL:         reqBody.FailRedirectURL,
			PayType:         "O",
			Language:        "ru",
			Receipt:         receipt,
		})
		if err != nil {
			zap.L().Error("v3/create-invoice: TBank error",
				zap.Error(err), zap.String("payment_type", reqBody.PaymentType))
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to create invoice"})
			return
		}

		// Record payment in database.
		if db != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			// plan column is NOT NULL — use "none" for balance top-ups.
			planVal := "none"
			if paymentPlan != nil {
				planVal = *paymentPlan
			}
			_, dbErr := db.Exec(ctx,
				`INSERT INTO payments (user_id, invoice_id, order_id, amount, currency, status,
				                       plan, payment_type,
				                       success_redirect_url, fail_redirect_url, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
				user.ID, result.PaymentId, orderID, invoiceAmount, reqBody.Currency,
				StatusCreated, planVal, reqBody.PaymentType,
				nilIfEmpty(reqBody.SuccessRedirectURL), nilIfEmpty(reqBody.FailRedirectURL))
			if dbErr != nil {
				zap.L().Error("v3/create-invoice: failed to record payment",
					zap.Error(dbErr), zap.String("order_id", orderID))
			}
		}

		// Prometheus: track payment creation.
		metrics.PaymentsTotal.WithLabelValues(StatusCreated, reqBody.Currency).Inc()
		metrics.PaymentsAmountTotal.WithLabelValues(reqBody.Currency).Add(invoiceAmount)

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(createInvoiceHandlerResponse{
			PaymentURL: result.PaymentURL,
		})
	}
}

// tbankWebhookPayload represents the T-Bank notification body.
type tbankWebhookPayload struct {
	TerminalKey string `json:"TerminalKey"`
	OrderId     string `json:"OrderId"`
	Success     bool   `json:"Success"`
	Status      string `json:"Status"`
	PaymentId   int64  `json:"PaymentId"`
	ErrorCode   string `json:"ErrorCode"`
	Amount      int64  `json:"Amount"`
	Pan         string `json:"Pan,omitempty"`
	Token       string `json:"Token"`
}

// WebhookHandlerV3 returns an HTTP handler that processes T-Bank payment
// callback notifications. Authentication is via token verification.
// rateSvc provides the current USD/RUB exchange rate for balance top-up conversion.
func WebhookHandlerV3(client *TBankClient, planUpdater PlanUpdater, balanceSvc BalanceTopUpHandler, db *pgxpool.Pool, rateSvc ExchangeRateProvider) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		log := zap.L().With(zap.String("handler", "v3/webhook"))
		log.Info("received TBank callback", zap.String("content_type", r.Header.Get("Content-Type")))

		// Read and parse JSON body.
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		var payload tbankWebhookPayload
		if err := json.Unmarshal(bodyBytes, &payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		log.Info("parsed TBank callback",
			zap.String("status", payload.Status),
			zap.Int64("payment_id", payload.PaymentId),
			zap.String("order_id", payload.OrderId))

		// Build params map from the raw JSON for token verification.
		var rawMap map[string]json.RawMessage
		if err := json.Unmarshal(bodyBytes, &rawMap); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}

		params := make(map[string]string)
		for k, v := range rawMap {
			if k == "Token" {
				continue
			}
			// Try to unmarshal as string first.
			var s string
			if err := json.Unmarshal(v, &s); err == nil {
				params[k] = s
				continue
			}
			// For non-string values (bool, number), use the raw JSON representation
			// without quotes — T-Bank uses string representation of all values for
			// token calculation.
			raw := strings.TrimSpace(string(v))
			raw = strings.Trim(raw, "\"")
			params[k] = raw
		}

		// Verify token.
		if !client.VerifyNotificationToken(params, payload.Token) {
			log.Warn("TBank token verification failed", zap.String("order_id", payload.OrderId))
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid webhook token"})
			return
		}

		paymentIDStr := strconv.FormatInt(payload.PaymentId, 10)

		// Only process confirmed payments.
		if payload.Status != "CONFIRMED" {
			if db != nil && (payload.Status == "CANCELED" || payload.Status == "REJECTED" || payload.Status == "REVERSED") {
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				defer cancel()
				_, _ = db.Exec(ctx,
					`UPDATE payments SET status = $1, updated_at = NOW()
					 WHERE invoice_id = $2 AND status IN ('created', 'pending')`,
					StatusFailed, paymentIDStr)

				metrics.PaymentsTotal.WithLabelValues(StatusFailed, "RUB").Inc()
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{"status": "ignored"})
			return
		}

		// Look up payment in DB by invoice_id (PaymentId from T-Bank).
		// The payment record was created during Init with full user_id, plan, amount.
		if db == nil {
			log.Error("database not configured for webhook")
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
			return
		}

		var userID, paymentType, plan string
		var amount float64
		var creditedUSD float64 // set inside balance_topup branch; read later when updating payments row
		{
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			err := db.QueryRow(ctx,
				`SELECT user_id, payment_type, plan, amount
				   FROM payments WHERE invoice_id = $1 AND status IN ('created', 'pending')
				   LIMIT 1`,
				paymentIDStr).Scan(&userID, &paymentType, &plan, &amount)
			if err != nil {
				log.Error("payment not found in DB",
					zap.String("payment_id", paymentIDStr),
					zap.String("order_id", payload.OrderId), zap.Error(err))
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{Error: "payment not found"})
				return
			}
		}

		switch paymentType {
		case "subscription":
			expiresAt := time.Now().UTC().Add(30 * 24 * time.Hour).Format(time.RFC3339)

			if err := planUpdater.SetPlan(userID, plan, &expiresAt); err != nil {
				log.Error("failed to update user plan",
					zap.String("user_id", userID), zap.String("plan", plan), zap.Error(err))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to update user plan"})
				return
			}

			metrics.UserSubscriptionsActivatedTotal.WithLabelValues(plan).Inc()
			log.Info("subscription payment confirmed via TBank",
				zap.String("user_id", userID),
				zap.String("plan", plan),
				zap.Int64("payment_id", payload.PaymentId))

		case "balance_topup":
			if balanceSvc == nil {
				log.Error("balance service not configured")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "balance service not available"})
				return
			}

			// Convert RUB payment to USD credits with plan-based markup.
			amountRUB := amount
			usdRate := 90.0 // fallback
			if rateSvc != nil {
				usdRate = rateSvc.GetUSDToRUB()
			}

			// Look up user's plan for markup percentage.
			markupPct := 30 // default: Free plan markup
			var userPlan string
			{
				lookupCtx, lookupCancel := context.WithTimeout(r.Context(), 3*time.Second)
				defer lookupCancel()
				_ = db.QueryRow(lookupCtx,
					`SELECT COALESCE(plan, 'free') FROM users WHERE id = $1`, userID,
				).Scan(&userPlan)
			}
			switch userPlan {
			case "pro":
				markupPct = 20
			}

			amountUSD := amountRUB / usdRate / (1.0 + float64(markupPct)/100.0)
			// Round to 6 decimal places.
			amountUSD = math.Round(amountUSD*1e6) / 1e6
			creditedUSD = amountUSD // remember for the payments UPDATE below

			description := fmt.Sprintf("Top-up %.0f₽ → $%.4f (rate: %.2f, markup: %d%%)",
				amountRUB, amountUSD, usdRate, markupPct)
			if err := balanceSvc.TopUp(r.Context(), userID, amountUSD, description); err != nil {
				log.Error("failed to top up balance",
					zap.String("user_id", userID),
					zap.Float64("amount_rub", amountRUB),
					zap.Float64("amount_usd", amountUSD), zap.Error(err))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to credit balance"})
				return
			}

			metrics.BalanceTopUpsTotal.Inc()
			metrics.BalanceTopUpsAmountTotal.Add(amountRUB)
			log.Info("balance top-up confirmed via TBank",
				zap.String("user_id", userID),
				zap.Float64("amount_rub", amountRUB),
				zap.Float64("amount_usd", amountUSD),
				zap.Float64("exchange_rate", usdRate),
				zap.Int("markup_pct", markupPct),
				zap.Int64("payment_id", payload.PaymentId))
		}

		// Update payment record in database.
		if db != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			if paymentType == "balance_topup" && creditedUSD > 0 {
				_, _ = db.Exec(ctx,
					`UPDATE payments
					    SET status = $1, paid_at = NOW(), confirmed_at = NOW(),
					        updated_at = NOW(), credited_usd = $3
					  WHERE invoice_id = $2 AND status IN ('created', 'pending')`,
					StatusConfirmed, paymentIDStr, creditedUSD)
			} else {
				_, _ = db.Exec(ctx,
					`UPDATE payments
					    SET status = $1, paid_at = NOW(), confirmed_at = NOW(), updated_at = NOW()
					  WHERE invoice_id = $2 AND status IN ('created', 'pending')`,
					StatusConfirmed, paymentIDStr)
			}
		}

		// Prometheus: track confirmed payment.
		metrics.PaymentsTotal.WithLabelValues(StatusConfirmed, "RUB").Inc()

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}

// GetPaymentStatusHandlerV3 returns an HTTP handler that checks a T-Bank
// payment status by payment ID.
func GetPaymentStatusHandlerV3(client *TBankClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		paymentID := r.PathValue("payment_id")
		if paymentID == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing payment_id"})
			return
		}

		result, err := client.GetState(r.Context(), paymentID)
		if err != nil {
			zap.L().Error("v3/payment-status: TBank error",
				zap.Error(err), zap.String("payment_id", paymentID))
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to get payment status"})
			return
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(result)
	}
}

// paymentHistoryItem represents a single payment in the history response.
type paymentHistoryItem struct {
	ID           string  `json:"id"`
	InvoiceID    string  `json:"invoice_id"`
	OrderID      string  `json:"order_id"`
	Amount       float64 `json:"amount"`
	Currency     string  `json:"currency"`
	Status       string  `json:"status"`
	Plan         string  `json:"plan"`
	PaymentType  string  `json:"payment_type"`
	CreatedAt    string  `json:"created_at"`
	PaidAt       string  `json:"paid_at"`
	Refundable   bool    `json:"refundable"`
	RefundReason string  `json:"refund_reason"`
}

// paymentHistoryResponse is the JSON response for the payment history endpoint.
type paymentHistoryResponse struct {
	Payments []paymentHistoryItem `json:"payments"`
	Total    int                  `json:"total"`
}

// PaymentHistoryHandlerV3 returns an HTTP handler that lists the authenticated
// user's payment history with pagination and computed refundability.
func PaymentHistoryHandlerV3(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}
		userID := claims.UserID

		// Parse pagination params.
		limit := 20
		offset := 0
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		if limit > 100 {
			limit = 100
		}
		if v := r.URL.Query().Get("offset"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed >= 0 {
				offset = parsed
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		// Get total count.
		var total int
		err := db.QueryRow(ctx,
			`SELECT COUNT(*) FROM payments WHERE user_id = $1`, userID,
		).Scan(&total)
		if err != nil {
			zap.L().Error("v3/payments/history: count error", zap.Error(err))
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to fetch payment history"})
			return
		}

		if total == 0 {
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(paymentHistoryResponse{
				Payments: []paymentHistoryItem{},
				Total:    0,
			})
			return
		}

		// Fetch payments page.
		rows, err := db.Query(ctx,
			`SELECT id, COALESCE(invoice_id, ''), COALESCE(order_id, ''),
			        amount, COALESCE(currency, 'RUB'), status,
			        COALESCE(plan, 'none'), COALESCE(payment_type, 'subscription'),
			        created_at, paid_at
			   FROM payments
			  WHERE user_id = $1
			  ORDER BY created_at DESC
			  LIMIT $2 OFFSET $3`,
			userID, limit, offset,
		)
		if err != nil {
			zap.L().Error("v3/payments/history: query error", zap.Error(err))
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to fetch payment history"})
			return
		}
		defer rows.Close()

		now := time.Now().UTC()
		refundDeadline := now.Add(-refundPolicyDays * 24 * time.Hour)

		var payments []paymentHistoryItem
		for rows.Next() {
			var (
				id, invoiceID, orderID, currency, status, plan, paymentType string
				amount                                                      float64
				createdAt                                                   time.Time
				paidAt                                                      *time.Time
			)
			if err := rows.Scan(&id, &invoiceID, &orderID, &amount, &currency,
				&status, &plan, &paymentType, &createdAt, &paidAt); err != nil {
				zap.L().Error("v3/payments/history: scan error", zap.Error(err))
				continue
			}

			paidAtStr := ""
			if paidAt != nil {
				paidAtStr = paidAt.UTC().Format(time.RFC3339)
			}

			item := paymentHistoryItem{
				ID:          id,
				InvoiceID:   invoiceID,
				OrderID:     orderID,
				Amount:      amount,
				Currency:    currency,
				Status:      status,
				Plan:        plan,
				PaymentType: paymentType,
				CreatedAt:   createdAt.UTC().Format(time.RFC3339),
				PaidAt:      paidAtStr,
			}

			// Compute refundability.
			item.Refundable, item.RefundReason = computeRefundability(
				ctx, db, userID, status, paymentType, paidAt, refundDeadline,
			)

			payments = append(payments, item)
		}
		if err := rows.Err(); err != nil {
			zap.L().Error("v3/payments/history: rows iteration error", zap.Error(err))
		}

		if payments == nil {
			payments = []paymentHistoryItem{}
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(paymentHistoryResponse{
			Payments: payments,
			Total:    total,
		})
	}
}

// computeRefundability checks whether a payment can be refunded according to the
// refund policy. Returns (refundable, reason) where reason explains why it's NOT
// refundable (empty string if it is refundable).
func computeRefundability(
	ctx context.Context, db *pgxpool.Pool,
	userID, status, paymentType string,
	paidAt *time.Time, refundDeadline time.Time,
) (bool, string) {
	// Only confirmed payments can be refunded.
	if status != StatusConfirmed {
		return false, fmt.Sprintf("payment status is '%s', only confirmed payments can be refunded", status)
	}

	// Must have a paid_at timestamp.
	if paidAt == nil {
		return false, "payment has no paid_at timestamp"
	}

	// Must be within the 14-day refund window.
	if paidAt.Before(refundDeadline) {
		return false, fmt.Sprintf("refund period expired (paid %d days ago, limit is %d days)",
			int(time.Since(*paidAt).Hours()/24), refundPolicyDays)
	}

	switch paymentType {
	case "subscription":
		// Subscription: refundable within 14 days, no extra conditions.
		return true, ""

	case "balance_topup":
		// Balance top-up: refundable only if no charges (model_charge, over_quota_charge)
		// happened after the payment's paid_at timestamp.
		var chargeCount int
		err := db.QueryRow(ctx,
			`SELECT COUNT(*) FROM balance_transactions
			  WHERE user_id = $1
			    AND tx_type IN ('model_charge', 'over_quota_charge')
			    AND created_at > $2`,
			userID, *paidAt,
		).Scan(&chargeCount)
		if err != nil {
			zap.L().Error("computeRefundability: failed to check balance charges",
				zap.Error(err), zap.String("user_id", userID))
			return false, "failed to verify refund eligibility"
		}
		if chargeCount > 0 {
			return false, "balance has been used after this top-up (charges exist)"
		}
		return true, ""

	default:
		return false, fmt.Sprintf("unsupported payment type '%s'", paymentType)
	}
}

// refundRequest is the JSON request body for the refund endpoint.
type refundRequest struct {
	PaymentID string `json:"payment_id"`
}

// ExchangeRateProvider returns the current USD→RUB exchange rate.
type ExchangeRateProvider interface {
	GetUSDToRUB() float64
}

// RefundHandlerV3 returns an HTTP handler that processes payment refund requests.
// It verifies ownership, checks refundability, reverses side effects (balance or
// subscription), calls T-Bank Cancel API, and marks the payment as refunded.
// For subscriptions, the refund amount is reduced by actual AI token costs incurred.
func RefundHandlerV3(client *TBankClient, planUpdater PlanUpdater, balanceRefund BalanceRefundHandler, db *pgxpool.Pool, rateSvc ExchangeRateProvider) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "missing authentication"})
			return
		}
		userID := claims.UserID

		var reqBody refundRequest
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid request body"})
			return
		}
		if reqBody.PaymentID == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "payment_id is required"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()

		log := zap.L().With(
			zap.String("handler", "v3/refund"),
			zap.String("user_id", userID),
			zap.String("payment_id", reqBody.PaymentID),
		)

		// Look up payment by ID.
		var (
			paymentUserID, invoiceID, status, paymentType, plan string
			amount                                               float64
			creditedUSD                                          *float64
			paidAt                                               *time.Time
		)
		err := db.QueryRow(ctx,
			`SELECT user_id, COALESCE(invoice_id, ''), status,
			        COALESCE(payment_type, 'subscription'), COALESCE(plan, 'none'),
			        amount, credited_usd, paid_at
			   FROM payments WHERE id = $1`,
			reqBody.PaymentID,
		).Scan(&paymentUserID, &invoiceID, &status, &paymentType, &plan, &amount, &creditedUSD, &paidAt)
		if err != nil {
			log.Error("payment not found", zap.Error(err))
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(errorResponse{Error: "payment not found"})
			return
		}

		// Verify ownership.
		if paymentUserID != userID {
			log.Warn("payment does not belong to user",
				zap.String("payment_owner", paymentUserID))
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(errorResponse{Error: "payment not found"})
			return
		}

		// Check refundability.
		now := time.Now().UTC()
		refundDeadline := now.Add(-refundPolicyDays * 24 * time.Hour)
		refundable, reason := computeRefundability(ctx, db, userID, status, paymentType, paidAt, refundDeadline)
		if !refundable {
			log.Info("refund denied", zap.String("reason", reason))
			w.WriteHeader(http.StatusUnprocessableEntity)
			json.NewEncoder(w).Encode(errorResponse{Error: reason})
			return
		}

		// Calculate refund amount.
		refundAmount := amount // full refund by default (balance_topup)

		// Reverse side effects based on payment type.
		switch paymentType {
		case "balance_topup":
			// Deduct the EXACT USD amount that was originally credited to the
			// user's balance. We must not recompute from RUB with today's rate,
			// because the exchange rate and plan markup at the time of top-up
			// may differ from the current ones. T-Bank Cancel API below still
			// refunds the full RUB amount, so the user gets back exactly what
			// they paid in fiat.
			var usdToDeduct float64
			if creditedUSD != nil && *creditedUSD > 0 {
				usdToDeduct = *creditedUSD
			} else {
				// Legacy top-up (pre-019 migration) without a stored USD value.
				// Fall back to the back-fill formula used by the migration so
				// the deduction is at least self-consistent with the estimate.
				usdToDeduct = math.Round((amount/90.0/1.30)*1e6) / 1e6
				log.Warn("refund: using fallback USD estimate for legacy top-up",
					zap.Float64("amount_rub", amount),
					zap.Float64("estimated_usd", usdToDeduct))
			}
			description := fmt.Sprintf("Refund for payment %s", reqBody.PaymentID)
			if err := balanceRefund.DeductForRefund(ctx, userID, usdToDeduct, description); err != nil {
				log.Error("failed to deduct balance for refund", zap.Error(err))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to reverse balance: " + err.Error()})
				return
			}
			log.Info("balance reversed for refund",
				zap.Float64("amount_rub", amount),
				zap.Float64("amount_usd", usdToDeduct))

		case "subscription":
			// Per Article 32 of Russian Consumer Protection Law: deduct actual expenses
			// (cost of AI tokens used during the subscription period).
			var tokenCostUSD float64
			err := db.QueryRow(ctx,
				`SELECT COALESCE(SUM(cost_usd), 0)
				   FROM token_usage
				  WHERE user_id = $1 AND created_at >= $2`,
				userID, *paidAt,
			).Scan(&tokenCostUSD)
			if err != nil {
				log.Error("failed to calculate token costs", zap.Error(err))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to calculate refund amount"})
				return
			}

			// Convert USD costs to RUB.
			usdToRub := rateSvc.GetUSDToRUB()
			tokenCostRUB := tokenCostUSD * usdToRub

			// Round up to kopecks (ceil).
			tokenCostRUB = math.Ceil(tokenCostRUB*100) / 100

			refundAmount = amount - tokenCostRUB
			if refundAmount < 0 {
				refundAmount = 0
			}

			log.Info("subscription refund calculated",
				zap.Float64("payment_amount", amount),
				zap.Float64("token_cost_usd", tokenCostUSD),
				zap.Float64("usd_to_rub", usdToRub),
				zap.Float64("token_cost_rub", tokenCostRUB),
				zap.Float64("refund_amount", refundAmount))

			if refundAmount == 0 {
				w.WriteHeader(http.StatusUnprocessableEntity)
				json.NewEncoder(w).Encode(errorResponse{
					Error: fmt.Sprintf("token usage costs (%.2f₽) exceed payment amount (%.2f₽), no refund available", tokenCostRUB, amount),
				})
				return
			}

			if err := planUpdater.SetPlan(userID, "free", nil); err != nil {
				log.Error("failed to downgrade plan for refund", zap.Error(err))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to downgrade subscription"})
				return
			}
			log.Info("subscription downgraded to free for refund", zap.String("previous_plan", plan))
		}

		// Call T-Bank Cancel API.
		// For partial refund (subscription with deductions): pass amount in kopecks.
		// For full refund (balance_topup): pass 0 (T-Bank refunds full amount).
		if invoiceID != "" {
			refundKopecks := int64(0) // full refund
			if paymentType == "subscription" && refundAmount < amount {
				refundKopecks = int64(refundAmount * 100)
			}
			_, err := client.Cancel(ctx, invoiceID, refundKopecks)
			if err != nil {
				log.Error("TBank Cancel API failed", zap.Error(err),
					zap.String("invoice_id", invoiceID),
					zap.Int64("refund_kopecks", refundKopecks))
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to process refund with payment provider"})
				return
			}
			log.Info("TBank payment refunded", zap.String("invoice_id", invoiceID),
				zap.Float64("refund_amount", refundAmount))
		}

		// Update payment status to refunded.
		_, err = db.Exec(ctx,
			`UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2`,
			StatusRefunded, reqBody.PaymentID,
		)
		if err != nil {
			log.Error("failed to update payment status to refunded", zap.Error(err))
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":        "refunded",
			"refund_amount": refundAmount,
			"deducted":      amount - refundAmount,
		})
	}
}
