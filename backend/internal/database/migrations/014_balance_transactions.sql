-- 014_balance_transactions.sql
-- Ledger of every balance mutation: top-ups, model charges, over-quota charges, refunds.

CREATE TABLE IF NOT EXISTS balance_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount          NUMERIC(12,6) NOT NULL,          -- positive = top-up, negative = charge
    balance_after   NUMERIC(12,2) NOT NULL,
    tx_type         TEXT NOT NULL CHECK (tx_type IN ('top_up', 'model_charge', 'over_quota_charge', 'refund')),
    model_id        TEXT,
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_tx_user ON balance_transactions(user_id, created_at DESC);

-- Extend the plan column to accept 'pro_plus' and 'trial' values.
-- The original 001 migration has no CHECK constraint on plan (just a DEFAULT),
-- so the column already accepts any TEXT value. However, if a CHECK was added later,
-- we drop it defensively and recreate with the full set of allowed plans.
DO $$
BEGIN
    -- Drop existing check constraint on plan if any.
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_plan;

    -- Add new CHECK with all allowed plan values.
    ALTER TABLE users ADD CONSTRAINT chk_users_plan
        CHECK (plan IN ('free', 'trial', 'pro', 'pro_plus'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
