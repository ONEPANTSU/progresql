-- 003_create_token_usage.sql
-- Token usage analytics: records every AI request for usage tracking and billing.

CREATE TABLE IF NOT EXISTS token_usage (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id          TEXT NOT NULL,
    model               TEXT NOT NULL,
    prompt_tokens       INTEGER NOT NULL DEFAULT 0,
    completion_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens        INTEGER NOT NULL DEFAULT 0,
    cost_usd            NUMERIC(10, 6) NOT NULL DEFAULT 0,
    action              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_user_id ON token_usage (user_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage (created_at);
