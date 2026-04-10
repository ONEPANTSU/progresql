-- ============================================================
-- SOURCE SCHEMA (reference — "the desired state")
-- Port 5433, database: refdb, user: test, pass: test
--
-- This is what the target database should become after running
-- the generated migration. Each block is labelled with the
-- corresponding test-case ID from the manual-QA checklist.
-- ============================================================

-- ============================================================
-- ENUMS  (section C)
-- ============================================================

-- C1: brand new enum — does not exist in target
CREATE TYPE subscription_plan AS ENUM ('free', 'pro', 'enterprise');

-- C2: ADD VALUE — 'delivered' is new in source
CREATE TYPE shipment_status AS ENUM ('pending', 'shipped', 'delivered');

-- C3: Multiple add/drop — several values changed at once.
-- target has: 'std_ship', 'express_shipping', 'pickup'
-- source has: 'standard_shipping', 'express_delivery', 'pickup', 'drone', 'locker'
-- Expected: rename std_ship→?, rename express_shipping→?, add drone, add locker
CREATE TYPE delivery_method AS ENUM ('standard_shipping', 'express_delivery', 'pickup', 'drone', 'locker');

-- C5: DROP VALUE — target has 'obsolete' that should go away
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high');

-- C7: RENAME TYPE — target has 'customer_tier' with identical values
CREATE TYPE customer_tier_v2 AS ENUM ('bronze', 'silver', 'gold', 'platinum');

-- C8: multiple ADD VALUE in a single type — verifies the planner batches
-- them into separate pre-commit statements.
CREATE TYPE notification_channel AS ENUM ('email', 'sms', 'push', 'webhook', 'slack');

-- C9: large enum that exists on both sides unchanged — ensures the differ
-- doesn't emit spurious ops when labels + order match exactly.
CREATE TYPE language_code AS ENUM ('en', 'ru', 'de', 'fr', 'es', 'it', 'pl', 'zh', 'ja', 'ko');

-- C10: RENAME TYPE + RENAME VALUE combined — target has 'payment_method'
-- with old value names; source renames the type AND two values.
-- Tests rename-type split/keep-both with nested value renames.
CREATE TYPE payment_type AS ENUM ('credit_card', 'debit_card', 'bank_transfer', 'crypto');

-- C11: RENAME TYPE only (values identical) — minimal rename-type case
-- for testing split → DROP old + CREATE new, keep-both → just CREATE alias.
CREATE TYPE user_role_v2 AS ENUM ('admin', 'editor', 'viewer', 'guest');

-- ============================================================
-- COMPOSITE TYPES  (section K — new in Phase 11)
-- ============================================================

-- K1: brand new composite — doesn't exist in target yet.
-- Used below by the `contacts` table to exercise the sidebar's "composite"
-- chip and tooltip (owner + field list).
CREATE TYPE contact_info AS (
  email    text,
  phone    text,
  country  text
);

-- K2: composite that already exists in target but with a different
-- field list — the differ should currently emit DROP + CREATE.
CREATE TYPE geo_point AS (
  lat   double precision,
  lng   double precision,
  label text
);

-- K3: composite that is identical on both sides — should not show up
-- in the diff at all.
CREATE TYPE money_amount AS (
  amount   numeric(12, 2),
  currency char(3)
);

-- ============================================================
-- DOMAINS  (section H)
-- ============================================================

-- H1: brand new domain
CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0);

-- H2: base type change (target has integer, source has bigint)
CREATE DOMAIN measurement AS bigint;

-- H3: text-based domain with a CHECK — distinct kind in the sidebar
-- (separates it from enum/composite and verifies the tooltip shows the
-- base type).
CREATE DOMAIN email_address AS text
  CHECK (VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- H4: identical domain on both sides — regression check.
CREATE DOMAIN percent AS smallint CHECK (VALUE BETWEEN 0 AND 100);

-- ============================================================
-- SEQUENCES  (section F)
-- ============================================================

-- F1: existing sequence with a changed INCREMENT (5 vs 1)
CREATE SEQUENCE counter_a INCREMENT 5 START 100;

-- F2: brand new sequence with non-default clauses
CREATE SEQUENCE counter_b AS integer START WITH 10 INCREMENT BY 2 CYCLE;

-- ============================================================
-- TABLES  (section A + B + I)
-- ============================================================

-- A1 + B1: table "users" is renamed to "users_v2" and the
-- column "email_addr" becomes "email_address". Everything else
-- stays the same so rename detection has a high confidence.
CREATE TABLE users_v2 (
    id           SERIAL PRIMARY KEY,
    email_address TEXT NOT NULL,
    full_name    TEXT,
    tier         customer_tier_v2,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- B2: column type mismatch — target has feature_id INTEGER,
-- source has feature_key TEXT. Similarity wants to pair them,
-- but the type mismatch must block the rename -> DROP + ADD.
CREATE TABLE settings (
    id           SERIAL PRIMARY KEY,
    feature_key  TEXT,
    enabled      BOOLEAN DEFAULT false
);

-- A3: brand new table with no counterpart in target.
CREATE TABLE products (
    id     SERIAL PRIMARY KEY,
    name   TEXT NOT NULL,
    price  NUMERIC(10,2),
    status task_priority DEFAULT 'medium'
);

-- I1: table that uses an enum which itself is being mutated
-- (shipment_status gains 'delivered'). Planner must emit the
-- ALTER TYPE ... ADD VALUE in the pre-commit phase so that
-- the CREATE TABLE below can reference the new label.
CREATE TABLE shipments (
    id      SERIAL PRIMARY KEY,
    status  shipment_status DEFAULT 'delivered',
    notes   TEXT,
    weight  measurement
);

-- I2: FK dependency — orders references users_v2. The planner
-- should CREATE users_v2 (or rename) before orders.
CREATE TABLE orders (
    id        SERIAL PRIMARY KEY,
    user_id   INTEGER REFERENCES users_v2(id),
    status    shipment_status DEFAULT 'pending',
    total     NUMERIC(12,2),
    priority  task_priority DEFAULT 'low'
);

-- ============================================================
-- VIEWS  (section D)
-- ============================================================

-- D1: brand new view
CREATE VIEW active_products AS
SELECT id, name, price FROM products WHERE price > 0;

-- D2: REPLACE without changing the column list (body tweak only)
CREATE VIEW order_totals AS
SELECT id, total FROM orders WHERE total IS NOT NULL AND total > 0;

-- D3: REPLACE with a column-list change → forceRecreate (DROP + CREATE)
CREATE VIEW customer_summary AS
SELECT id, email_address, full_name, tier FROM users_v2;

-- D4: rename — same body, different name ("..._v2")
CREATE VIEW shipment_report_v2 AS
SELECT id, status, notes FROM shipments WHERE notes IS NOT NULL;

-- ============================================================
-- FUNCTIONS  (section E)
-- ============================================================

-- E1: REPLACE — body changes but signature stays the same
CREATE FUNCTION calc_total(x integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT x * 2 $$;

-- E2: DROP + CREATE — completely different names, no rename
CREATE FUNCTION zzz_new_compute() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'new-impl' $$;

-- E3: rename function — same body, different name
CREATE FUNCTION compute_tax_v2(amount numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT amount * 0.20 $$;

-- ============================================================
-- TRIGGERS  (section G)
--
-- Both sides need the trigger-function it references, otherwise
-- the CREATE TRIGGER will fail at diff-time. We make the two
-- functions have different bodies so the trigger body-hash
-- changes and the differ emits a destructive REPLACE.
-- ============================================================

CREATE FUNCTION audit_products_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE NOTICE 'audit v2: inserting % into products', NEW.id;
    RETURN NEW;
END;
$$;

-- G1: REPLACE trigger — action body (function name) differs from target
CREATE TRIGGER trg_audit_products
BEFORE INSERT ON products
FOR EACH ROW EXECUTE FUNCTION audit_products_fn();
