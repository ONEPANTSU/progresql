-- 008_add_marketing_consent.sql
-- Add marketing_consent flag to users table.
-- Default false: users must explicitly opt-in to marketing emails.

ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN NOT NULL DEFAULT FALSE;
