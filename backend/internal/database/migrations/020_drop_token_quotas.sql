-- 020_drop_token_quotas.sql
-- Clean up legacy token quota system replaced by USD credit billing (v2).
--
-- token_quotas tracked per-period budget/premium token usage — no longer used.
-- token_usage is kept for analytics and cost tracking.

-- 1. Drop the token_quotas table (no longer read or written by any code).
DROP TABLE IF EXISTS token_quotas;

-- 2. Drop deprecated plan values — normalize any remaining legacy plans.
UPDATE users SET plan = 'pro'  WHERE plan IN ('pro_plus', 'team');
UPDATE users SET plan = 'free' WHERE plan = 'trial';
