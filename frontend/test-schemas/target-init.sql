-- ============================================================
-- TARGET SCHEMA ("the live system" — needs to be migrated)
-- Port 5434, database: livedb, user: test, pass: test
--
-- This database intentionally lags behind the source so that
-- every test category in the manual-QA checklist produces a
-- non-trivial diff.
-- ============================================================

-- ============================================================
-- ENUMS
-- ============================================================

-- C2: 'delivered' is missing → source will ADD VALUE
CREATE TYPE shipment_status AS ENUM ('pending', 'shipped');

-- C3: Multiple changes — source renames/adds/drops multiple values
CREATE TYPE delivery_method AS ENUM ('std_ship', 'express_shipping', 'pickup');

-- C5: extra 'obsolete' label that must be dropped
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'obsolete');

-- C7: legacy enum name — same values, source is "customer_tier_v2"
CREATE TYPE customer_tier AS ENUM ('bronze', 'silver', 'gold', 'platinum');

-- C8: only the first two labels exist — source adds sms/push/webhook/slack
CREATE TYPE notification_channel AS ENUM ('email', 'sms');

-- C9: identical to source — the differ should emit no ops for this enum
CREATE TYPE language_code AS ENUM ('en', 'ru', 'de', 'fr', 'es', 'it', 'pl', 'zh', 'ja', 'ko');

-- (subscription_plan absent on purpose → CREATE op in source diff)

-- C10: old enum name + old value names — source renames type AND values
CREATE TYPE payment_method AS ENUM ('cc', 'dc', 'bank_transfer', 'crypto');

-- C11: old enum name, same values — source renames to user_role_v2
CREATE TYPE user_role AS ENUM ('admin', 'editor', 'viewer', 'guest');

-- ============================================================
-- COMPOSITE TYPES
-- ============================================================

-- K2: outdated field list — source adds a `label` field
CREATE TYPE geo_point AS (
  lat double precision,
  lng double precision
);

-- K3: identical composite — regression check
CREATE TYPE money_amount AS (
  amount   numeric(12, 2),
  currency char(3)
);

-- (contact_info absent on purpose → CREATE composite)

-- ============================================================
-- DOMAINS
-- ============================================================

-- H2: wrong base type — source declares bigint
CREATE DOMAIN measurement AS integer;

-- H4: identical domain on both sides — regression check
CREATE DOMAIN percent AS smallint CHECK (VALUE BETWEEN 0 AND 100);

-- (positive_int absent on purpose → CREATE)
-- (email_address absent on purpose → CREATE domain with CHECK)

-- ============================================================
-- SEQUENCES
-- ============================================================

-- F1: counter_a exists but with the default INCREMENT of 1
CREATE SEQUENCE counter_a INCREMENT 1 START 1;

-- (counter_b absent → source will CREATE with START/INCREMENT/CYCLE)

-- ============================================================
-- TABLES
-- ============================================================

-- A1 + B1: this is the "old" users table. It will be renamed to
-- users_v2 and its email_addr column will be renamed to
-- email_address by the generated migration.
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    email_addr  TEXT NOT NULL,
    full_name   TEXT,
    tier        customer_tier,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- B2: same table name but feature_id is INTEGER while source has
-- feature_key TEXT. Differ should DROP feature_id and ADD
-- feature_key — NOT emit a rename, because the types differ.
CREATE TABLE settings (
    id          SERIAL PRIMARY KEY,
    feature_id  INTEGER,
    enabled     BOOLEAN DEFAULT false
);

-- I2: orders exists here but references the old "users" table.
-- After the rename, the FK automatically follows the renamed
-- table (Postgres stores FKs by OID), so no extra migration is
-- needed for the FK itself.
CREATE TABLE orders (
    id        SERIAL PRIMARY KEY,
    user_id   INTEGER REFERENCES users(id),
    status    shipment_status DEFAULT 'pending',
    total     NUMERIC(12,2)
    -- NOTE: missing "priority" column on purpose → ALTER ADD COLUMN
);

-- (products, shipments absent → CREATE ops on source diff)

-- ============================================================
-- VIEWS
-- ============================================================

-- D2: same column list, body differs slightly (no WHERE)
CREATE VIEW order_totals AS
SELECT id, total FROM orders;

-- D3: fewer columns than source → diff should forceRecreate
CREATE VIEW customer_summary AS
SELECT id, email_addr FROM users;

-- D4: original name of the renamed view (source has ..._v2)
CREATE VIEW shipment_report AS
SELECT id, status, notes FROM (
    SELECT 1 AS id, 'shipped'::text AS status, 'placeholder'::text AS notes
) s WHERE notes IS NOT NULL;

-- (active_products absent → CREATE)

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- E1: calc_total exists but returns x * 1 (body differs)
CREATE FUNCTION calc_total(x integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT x * 1 $$;

-- E2: totally different legacy function the source no longer has
CREATE FUNCTION aaa_legacy_compute() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'legacy' $$;

-- E3: original name of the renamed function; same body as source
CREATE FUNCTION compute_tax(amount numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT amount * 0.20 $$;

-- ============================================================
-- TRIGGERS
-- ============================================================

CREATE FUNCTION audit_products_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE NOTICE 'audit v1: row inserted';
    RETURN NEW;
END;
$$;

-- We need a placeholder table for the trigger because products
-- does not exist yet in target. Create a stub that will get
-- replaced when the migration runs.
CREATE TABLE legacy_products_stub (
    id SERIAL PRIMARY KEY,
    name TEXT
);

-- G1: the trigger sits on the stub table in the target so we can
-- at least exercise DROP TRIGGER. After the migration, the
-- "real" products table will be created with its own fresh
-- trg_audit_products trigger from the source side.
CREATE TRIGGER trg_legacy_audit
BEFORE INSERT ON legacy_products_stub
FOR EACH ROW EXECUTE FUNCTION audit_products_fn();
