-- 006_extend_payments.sql
-- Extend payments table with crypto transaction details, redirect URLs,
-- richer status tracking, and audit timestamps.

-- New columns for crypto payment details.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS crypto_currency TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS crypto_network TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS tx_hash TEXT;

-- Redirect URLs stored per-payment for audit trail.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS success_redirect_url TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fail_redirect_url TEXT;

-- Confirmed timestamp (distinct from paid_at — confirmed_at is blockchain confirmation).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- Generic updated_at for any status change.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Migrate existing status values: 'pending' and 'paid' are kept as-is.
-- New valid statuses: created, pending, confirmed, failed, expired.
-- Rename 'paid' → 'confirmed' for consistency with crypto semantics.
UPDATE payments SET status = 'confirmed', confirmed_at = paid_at WHERE status = 'paid';

-- Index on status for filtering.
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
