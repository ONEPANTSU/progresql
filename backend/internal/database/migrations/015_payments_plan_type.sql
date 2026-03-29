-- 015_payments_plan_type.sql
-- Adds plan and payment_type columns to payments table for multi-plan support and balance top-ups.

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'pro',
    ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'subscription';

-- payment_type: 'subscription' (pro/pro_plus) or 'balance_topup'
-- plan: 'pro', 'pro_plus', or NULL for balance top-ups

COMMENT ON COLUMN payments.plan IS 'Target subscription plan: pro, pro_plus, or NULL for balance top-ups';
COMMENT ON COLUMN payments.payment_type IS 'Payment type: subscription or balance_topup';
