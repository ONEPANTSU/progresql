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
		switch plan {
		case "pro_plus":
			return "ProgreSQL Pro Plus subscription"
		default:
			return "ProgreSQL Pro subscription"
		}
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

		switch reqBody.PaymentType {
		case "subscription":
			if reqBody.Plan != "pro" && reqBody.Plan != "pro_plus" {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(errorResponse{Error: "invalid plan: must be 'pro' or 'pro_plus'"})
				return
			}
			invoiceAmount = resolvePlanPrice(reqBody.Plan)
			invoiceAmount = applyDiscount(r.Context(), db, user.ID, invoiceAmount)
			orderID = fmt.Sprintf("sub_%s_%s_%d", reqBody.Plan, user.ID, ts)
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
			orderID = fmt.Sprintf("bal_%.0f_%s_%d", reqBody.Amount, user.ID, ts)
			description = resolveDescription("balance_topup", "")

		default:
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid payment_type: must be 'subscription' or 'balance_topup'"})
			return
		}

		// Amount in kopecks for T-Bank.
		amountKopecks := int64(invoiceAmount * 100)

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
func WebhookHandlerV3(client *TBankClient, planUpdater PlanUpdater, balanceSvc BalanceTopUpHandler, db *pgxpool.Pool) http.HandlerFunc {
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

		// Strip timestamp suffix from OrderId and parse to get user ID, plan, amount.
		cleanOrderID := stripTimestampSuffix(payload.OrderId)
		parsed, err := parseOrderPayload(cleanOrderID)
		if err != nil {
			log.Error("failed to parse order payload",
				zap.String("order_id", payload.OrderId), zap.Error(err))
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid order_id format"})
			return
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
			log.Info("subscription payment confirmed via TBank",
				zap.String("user_id", parsed.UserID),
				zap.String("plan", parsed.Plan),
				zap.Int64("payment_id", payload.PaymentId))

		case "balance_topup":
			if balanceSvc == nil {
				log.Error("balance service not configured")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "balance service not available"})
				return
			}

			description := fmt.Sprintf("Top-up via TBank (payment: %d)", payload.PaymentId)
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
			log.Info("balance top-up confirmed via TBank",
				zap.String("user_id", parsed.UserID),
				zap.Float64("amount", parsed.Amount),
				zap.Int64("payment_id", payload.PaymentId))
		}

		// Update payment record in database.
		if db != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			_, _ = db.Exec(ctx,
				`UPDATE payments
				    SET status = $1, paid_at = NOW(), confirmed_at = NOW(), updated_at = NOW()
				  WHERE invoice_id = $2 AND status IN ('created', 'pending')`,
				StatusConfirmed, paymentIDStr)
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
