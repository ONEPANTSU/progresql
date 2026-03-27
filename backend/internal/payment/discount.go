package payment

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const discountQuery = `
SELECT COALESCE(pc.discount_percent, 0), COALESCE(pc.discount_amount, 0)
FROM promo_code_uses pcu
JOIN promo_codes pc ON pc.id = pcu.promo_code_id
WHERE pcu.user_id = $1::uuid AND pc.type = 'discount' AND pc.is_active = true
ORDER BY pcu.applied_at DESC LIMIT 1`

// applyDiscount looks up the most recent active discount promo for userID and
// applies it to amount. Returns the (possibly reduced) amount.
// If db is nil or no active promo exists, the original amount is returned unchanged.
func applyDiscount(ctx context.Context, db *pgxpool.Pool, userID string, amount float64) float64 {
	if db == nil {
		return amount
	}
	qctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	var discountPercent int
	var discountAmount float64
	if err := db.QueryRow(qctx, discountQuery, userID).Scan(&discountPercent, &discountAmount); err != nil {
		return amount
	}

	switch {
	case discountPercent > 0:
		amount = amount * (1 - float64(discountPercent)/100)
	case discountAmount > 0:
		amount = amount - discountAmount
	}
	if amount < 0.01 {
		amount = 0.01
	}
	return amount
}
