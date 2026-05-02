package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/metrics"
)

type applyPromoRequest struct {
	Code string `json:"code"`
}

type applyPromoResponse struct {
	Success         bool    `json:"success"`
	Plan            string  `json:"plan,omitempty"`
	ExpiresAt       string  `json:"expires_at,omitempty"`
	DiscountPercent int     `json:"discount_percent,omitempty"`
	DiscountAmount  float64 `json:"discount_amount,omitempty"`
	Message         string  `json:"message,omitempty"`
}

// promoApplyHandler validates and applies a promo code for the authenticated user.
//
// @Summary      Apply promo code
// @Description  Validates and applies a promo code for the authenticated user. Supports pro_grant, trial_extension, and discount code types.
// @Tags         promo
// @Accept       json
// @Produce      json
// @Security     BearerAuth
// @Param        body  body      applyPromoRequest   true  "Promo code"
// @Success      200   {object}  applyPromoResponse
// @Failure      400   {object}  errorResponse
// @Failure      401   {object}  errorResponse
// @Failure      409   {object}  errorResponse
// @Failure      500   {object}  errorResponse
// @Router       /api/v1/promo/apply [post]
func promoApplyHandler(db *pgxpool.Pool, userStore *auth.UserStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		claims := auth.ClaimsFromContext(r.Context())
		if claims == nil || claims.UserID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(errorResponse{Error: "authentication required"})
			return
		}

		if db == nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "database not configured"})
			return
		}

		var req applyPromoRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Code) == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "code is required"})
			return
		}

		code := strings.TrimSpace(req.Code)

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		// 1. Find promo code (case-insensitive).
		var promoID int
		var promoType string
		var durationDays int
		var discountPercent int
		var discountAmount float64
		var maxUses *int
		var usedCount int
		var expiresAt *time.Time
		var isActive bool

		err := db.QueryRow(ctx,
			`SELECT id, type, duration_days, COALESCE(discount_percent, 0), COALESCE(discount_amount, 0),
			        max_uses, used_count, expires_at, is_active
			 FROM promo_codes WHERE LOWER(code) = LOWER($1)`, code,
		).Scan(&promoID, &promoType, &durationDays, &discountPercent, &discountAmount,
			&maxUses, &usedCount, &expiresAt, &isActive)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid or expired promo code"})
			return
		}

		// 2. Validate: is_active.
		if !isActive {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid or expired promo code"})
			return
		}

		// 3. Validate: not expired.
		if expiresAt != nil && expiresAt.Before(time.Now()) {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "invalid or expired promo code"})
			return
		}

		// 4. Validate: max_uses not reached.
		if maxUses != nil && usedCount >= *maxUses {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(errorResponse{Error: "promo code usage limit reached"})
			return
		}

		// 5. Validate: user hasn't already used it.
		var alreadyUsed int
		err = db.QueryRow(ctx,
			`SELECT COUNT(*) FROM promo_code_uses WHERE promo_code_id = $1 AND user_id = $2::uuid`,
			promoID, claims.UserID,
		).Scan(&alreadyUsed)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "failed to check promo code usage"})
			return
		}
		if alreadyUsed > 0 {
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(errorResponse{Error: "promo code already used"})
			return
		}

		// 6. Apply the promo code.
		newExpiresAt := time.Now().Add(time.Duration(durationDays) * 24 * time.Hour).UTC()
		var resultPlan string

		switch promoType {
		case "pro_grant":
			resultPlan = "pro"
			expStr := newExpiresAt.Format(time.RFC3339)
			if err := userStore.SetPlan(claims.UserID, "pro", &expStr); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to apply promo code"})
				return
			}
		case "trial_extension":
			resultPlan = "free"
			// Extend trial_ends_at by duration_days from now (or from current trial_ends_at if still active).
			_, err := db.Exec(ctx,
				`UPDATE users SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + ($1 || ' days')::interval WHERE id = $2`,
				fmt.Sprintf("%d", durationDays), claims.UserID,
			)
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(errorResponse{Error: "failed to extend trial"})
				return
			}
			// Fetch the updated trial_ends_at for the response.
			var trialEnd *time.Time
			_ = db.QueryRow(ctx, `SELECT trial_ends_at FROM users WHERE id = $1`, claims.UserID).Scan(&trialEnd)
			if trialEnd != nil {
				newExpiresAt = trialEnd.UTC()
			}
		case "discount":
			// Save discount to user's pending discount (stored in promo_code_uses, checked at payment).
			// Record usage now, payment handler will look up active discount.
			metrics.PromoCodesApplied.WithLabelValues(code, promoType).Inc()

			_, _ = db.Exec(ctx,
				`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1`, promoID)
			_, _ = db.Exec(ctx,
				`INSERT INTO promo_code_uses (promo_code_id, user_id) VALUES ($1, $2::uuid)`,
				promoID, claims.UserID)

			var msg string
			if discountPercent > 0 {
				msg = fmt.Sprintf("Discount %d%% applied! It will be used on your next payment.", discountPercent)
			} else if discountAmount > 0 {
				msg = fmt.Sprintf("Discount $%.2f applied! It will be used on your next payment.", discountAmount)
			}

			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(applyPromoResponse{
				Success:         true,
				DiscountPercent: discountPercent,
				DiscountAmount:  discountAmount,
				Message:         msg,
			})
			return
		default:
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(errorResponse{Error: "unknown promo code type"})
			return
		}

		// 7. Increment used_count.
		_, _ = db.Exec(ctx,
			`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1`, promoID)

		// 8. Insert into promo_code_uses.
		_, _ = db.Exec(ctx,
			`INSERT INTO promo_code_uses (promo_code_id, user_id) VALUES ($1, $2::uuid)`,
			promoID, claims.UserID)

		// 9. Prometheus metric.
		metrics.PromoCodesApplied.WithLabelValues(code, promoType).Inc()

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(applyPromoResponse{
			Success:   true,
			Plan:      resultPlan,
			ExpiresAt: newExpiresAt.Format(time.RFC3339),
		})
	}
}
