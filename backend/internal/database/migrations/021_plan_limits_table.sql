CREATE TABLE IF NOT EXISTS plan_limits (
    plan TEXT PRIMARY KEY,
    max_requests_per_min INT NOT NULL DEFAULT 10,
    max_sessions_concurrent INT NOT NULL DEFAULT 1,
    max_tokens_per_request INT NOT NULL DEFAULT 16384,
    allowed_model_tiers TEXT[] NOT NULL DEFAULT ARRAY['budget'],
    autocomplete_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    balance_markup_pct INT NOT NULL DEFAULT 30,
    daily_credits_usd FLOAT8 NOT NULL DEFAULT 0,
    monthly_credits_usd FLOAT8 NOT NULL DEFAULT 0,
    credits_rollover BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO plan_limits (plan, max_requests_per_min, max_sessions_concurrent, max_tokens_per_request, allowed_model_tiers, autocomplete_enabled, balance_markup_pct, daily_credits_usd, monthly_credits_usd, credits_rollover)
VALUES
    ('free', 10, 1, 16384, ARRAY['budget'], FALSE, 30, 0.03, 0, FALSE),
    ('pro', 60, 5, 32768, ARRAY['budget','premium'], TRUE, 20, 0, 15.0, FALSE),
    ('pro_yearly', 60, 5, 32768, ARRAY['budget','premium'], TRUE, 15, 0, 15.0, FALSE)
ON CONFLICT (plan) DO NOTHING;
