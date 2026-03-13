-- 002_create_payments.sql
-- Payment history for CryptoCloud transactions.

CREATE TABLE IF NOT EXISTS payments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invoice_id  TEXT NOT NULL,
    order_id    TEXT NOT NULL,
    amount      NUMERIC(10, 2) NOT NULL DEFAULT 0,
    currency    TEXT NOT NULL DEFAULT 'USD',
    status      TEXT NOT NULL DEFAULT 'pending',
    plan        TEXT NOT NULL DEFAULT 'pro',
    plan_days   INTEGER NOT NULL DEFAULT 30,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);
