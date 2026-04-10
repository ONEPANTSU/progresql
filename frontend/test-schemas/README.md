# Schema Sync manual-QA fixtures

Two throw-away Postgres containers preloaded with a schema pair that
exercises every Schema Sync code path (tables, columns, enums, views,
functions, sequences, triggers, domains + rename detection + planner
phases).

## Start / stop

```bash
cd frontend/test-schemas
docker compose up -d          # boot both containers
docker compose logs -f         # optional: follow startup
docker compose down -v         # tear everything down (also removes volumes)
```

Wait ~5 seconds after `up -d` so the health checks turn green.

## Connection details

Add these two connections in the app (Database Browser → New connection):

| Role   | Host      | Port | Database | User | Password |
| ------ | --------- | ---- | -------- | ---- | -------- |
| Source | 127.0.0.1 | 5433 | refdb    | test | test     |
| Target | 127.0.0.1 | 5434 | livedb   | test | test     |

Then open **Database Browser → Schema Sync**, pick `refdb` as _Source_,
`livedb` as _Target_, and press **Compare**.

## What you should see

The diff should surface ops across every category:

* **Tables** — `users → users_v2` rename, `email_addr → email_address`
  column rename inside it, new `products`/`shipments`, `settings` with
  column type mismatch (add + drop, NOT rename), `orders` ALTER ADD
  COLUMN `priority`.
* **Enums** — CREATE `subscription_plan`, ADD VALUE `delivered` on
  `shipment_status` (pre-commit phase), RENAME VALUE
  `std_ship → standard_shipping`, DROP VALUE `obsolete` on
  `task_priority` (destructive, needs a replacement pick),
  RENAME TYPE `customer_tier → customer_tier_v2`.
* **Views** — CREATE `active_products`, REPLACE `order_totals` (body
  only), REPLACE `customer_summary` with `forceRecreate` (column-list
  change → DROP + CREATE), RENAME `shipment_report → shipment_report_v2`.
* **Functions** — REPLACE `calc_total`, RENAME `compute_tax →
  compute_tax_v2`, DROP `aaa_legacy_compute` + CREATE
  `zzz_new_compute`.
* **Sequences** — ALTER `counter_a` (increment 1→5), CREATE `counter_b`.
* **Triggers** — DROP `trg_legacy_audit` on `legacy_products_stub`,
  CREATE `trg_audit_products` on the newly-created `products`.
* **Domains** — CREATE `positive_int`, DROP+CREATE `measurement`
  (base type change).

See `../renderer/features/database-browser/SchemaSyncModal.tsx`
comments and the test cases listed in the manual-QA checklist for
the full per-op expectations.

## Reset to initial state

If you click around and mutate the data, just run:

```bash
docker compose down -v && docker compose up -d
```

The `-v` flag wipes the volumes so the init scripts run again.
