-- 017_billing_v2.sql
-- Billing model v2: switch from token quotas to USD credit balance.
-- Balance stored in USD, single credit system, two plans (Free/Pro).

-- 1. Convert balance from RUB to USD (approximate rate 90).
UPDATE users SET balance = ROUND((balance / 90.0)::numeric, 6) WHERE balance > 0;

-- 2. Add credit tracking columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_used_usd FLOAT8 NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_period_start TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_period_end TIMESTAMPTZ;

-- 3. Migrate deprecated plans to Free/Pro.
UPDATE users SET plan = 'pro' WHERE plan = 'pro_plus';
UPDATE users SET plan = 'pro' WHERE plan = 'team';
UPDATE users SET plan = 'free' WHERE plan = 'trial';

-- 4. Convert balance_transactions amounts from RUB to USD.
UPDATE balance_transactions SET amount = ROUND((amount / 90.0)::numeric, 6) WHERE amount != 0;
UPDATE balance_transactions SET balance_after = ROUND((balance_after / 90.0)::numeric, 6) WHERE balance_after != 0;

-- 5. Initialize credit periods for existing Pro users.
UPDATE users
SET credits_period_start = COALESCE(
        (SELECT MAX(paid_at) FROM payments WHERE payments.user_id = users.id AND status = 'confirmed'),
        created_at
    ),
    credits_period_end = COALESCE(plan_expires_at, NOW() + INTERVAL '30 days')
WHERE plan = 'pro' AND credits_period_start IS NULL;
