-- 019_payments_credited_usd.sql
-- Persist the exact USD amount credited to the user's balance during a
-- balance_topup payment so that refunds can deduct the same amount without
-- recomputing it at refund time (which would depend on the current exchange
-- rate, not the one used at the moment of the top-up).
--
-- - credited_usd is NULL for subscription payments (no USD is credited).
-- - Existing balance_topup rows are back-filled best-effort by converting the
--   stored RUB amount with a fallback rate of 90 and the default Free markup
--   of 30%. This is only a guess; new payments will always carry the exact
--   USD figure going forward.

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS credited_usd NUMERIC(14,6);

-- Back-fill historical balance_topup payments with a best-effort estimate.
UPDATE payments
   SET credited_usd = ROUND((amount / 90.0 / 1.30)::numeric, 6)
 WHERE payment_type = 'balance_topup'
   AND credited_usd IS NULL
   AND amount IS NOT NULL;
