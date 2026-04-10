-- 018_billing_v2_constraints.sql
-- Update CHECK constraints introduced before billing v2 to accept the new
-- transaction types produced by the credit system (creditor, autocomplete,
-- expirations) and relax the balance_after precision so it can hold USD
-- values with up to 6 decimal digits.

-- 1. Widen balance_after precision (was NUMERIC(12,2) for RUB; USD needs more digits).
ALTER TABLE balance_transactions
    ALTER COLUMN balance_after TYPE NUMERIC(14,6);

-- 2. Drop the old tx_type CHECK constraint and recreate with the billing v2 set.
DO $$
BEGIN
    ALTER TABLE balance_transactions DROP CONSTRAINT IF EXISTS balance_transactions_tx_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE balance_transactions
    ADD CONSTRAINT balance_transactions_tx_type_check
    CHECK (tx_type IN (
        'top_up',
        'model_charge',
        'over_quota_charge',
        'refund',
        'subscription_credit',
        'credit_expire',
        'autocomplete_charge'
    ));
