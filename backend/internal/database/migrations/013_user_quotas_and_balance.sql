-- 013_user_quotas_and_balance.sql
-- Add balance column to users and create per-period token quota tracking.

-- Balance in USD credited to user account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Token quota tracking per billing period.
CREATE TABLE IF NOT EXISTS token_quotas (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    budget_tokens_used  BIGINT NOT NULL DEFAULT 0,
    premium_tokens_used BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_token_quotas_user_period ON token_quotas(user_id, period_start DESC);
