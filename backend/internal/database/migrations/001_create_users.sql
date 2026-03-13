-- 001_create_users.sql
-- Initial users table with all fields from the JSON-based UserStore.

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL DEFAULT '',
    password_hash   TEXT NOT NULL,
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    plan            TEXT NOT NULL DEFAULT 'free',
    plan_expires_at TIMESTAMPTZ,
    trial_ends_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
