# ProgreSQL — Admin Guide

## Server Access

```bash
ssh -i ~/.ssh/progresql_server root@progresql.com
cd /opt/progresql
```

## Database Access

```bash
# From server
docker exec -it $(docker ps -q -f name=postgres) psql -U progressql -d progressql

# Direct (external DB)
PGPASSWORD=Pr0greSqL2026 psql -h 92.63.176.193 -U progressql -d progressql
```

## User Management

### View All Users

```sql
SELECT id, email, name, plan, plan_expires_at, trial_ends_at, email_verified, created_at
FROM users ORDER BY created_at DESC;
```

### Grant Pro Plan

```sql
UPDATE users
SET plan = 'pro', plan_expires_at = NOW() + INTERVAL '30 days'
WHERE email = 'user@example.com';
```

### Extend Trial

```sql
UPDATE users
SET trial_ends_at = NOW() + INTERVAL '7 days'
WHERE email = 'user@example.com';
```

### Reset Password (force)

Not directly possible — user must use "Forgot Password" flow. But you can verify email:

```sql
UPDATE users SET email_verified = true WHERE email = 'user@example.com';
```

## Promo Codes

### Create a Promo Code

```sql
-- Grant Pro for 30 days
INSERT INTO promo_codes (code, type, duration_days, max_uses, is_active)
VALUES ('LAUNCH2026', 'pro_grant', 30, 100, true);

-- Extend trial by 14 days
INSERT INTO promo_codes (code, type, duration_days, max_uses, is_active)
VALUES ('TRYEXTRA', 'trial_extension', 14, 50, true);

-- 50% discount on payment
INSERT INTO promo_codes (code, type, duration_days, discount_percent, max_uses, is_active)
VALUES ('HALF50', 'discount', 30, 50, 200, true);

-- Fixed discount (500 RUB off)
INSERT INTO promo_codes (code, type, duration_days, discount_amount, max_uses, is_active)
VALUES ('SAVE500', 'discount', 30, 500.00, 100, true);
```

### Promo Code Types

| Type | Effect | Key Fields |
|------|--------|-----------|
| `pro_grant` | Grants Pro plan immediately | `duration_days` |
| `trial_extension` | Extends free trial | `duration_days` |
| `discount` | Discount on next payment | `discount_percent` or `discount_amount` |

### View Promo Code Usage

```sql
SELECT pc.code, pc.type, pc.used_count, pc.max_uses, pc.expires_at,
       COUNT(pcu.id) as actual_uses
FROM promo_codes pc
LEFT JOIN promo_code_uses pcu ON pc.id = pcu.promo_code_id
GROUP BY pc.id ORDER BY pc.created_at DESC;
```

### Deactivate a Promo Code

```sql
UPDATE promo_codes SET is_active = false WHERE code = 'LAUNCH2026';
```

## Payment Management

### View Payments

```sql
SELECT p.id, u.email, p.amount, p.currency, p.status, p.plan, p.created_at, p.confirmed_at
FROM payments p JOIN users u ON p.user_id = u.id
ORDER BY p.created_at DESC LIMIT 20;
```

### Payment Statuses

| Status | Meaning |
|--------|---------|
| `created` | Invoice created, user redirected to payment page |
| `pending` | Payment in progress |
| `confirmed` | Payment confirmed, plan activated |
| `failed` | Payment failed or cancelled |
| `expired` | Payment link expired |

### Manually Confirm Payment

If webhook didn't fire but payment was received:

```sql
UPDATE payments SET status = 'confirmed', confirmed_at = NOW() WHERE invoice_id = '...';
UPDATE users SET plan = 'pro', plan_expires_at = NOW() + INTERVAL '30 days'
WHERE id = (SELECT user_id FROM payments WHERE invoice_id = '...');
```

### Payment Configuration

In `/opt/progresql/.env`:
```
PROGRESSQL_PLATEGA_MERCHANT_ID=<merchant_id>
PROGRESSQL_PLATEGA_API_KEY=<api_key>
PROGRESSQL_PLATEGA_SUCCESS_URL=https://progresql.com/payment/success.html
PROGRESSQL_PLATEGA_FAIL_URL=https://progresql.com/payment/fail.html
```

### Change Price

Default price is hardcoded in backend:
- v1: 20 USD (`backend/internal/payment/handler.go`)
- v2: 1999 RUB (`backend/internal/payment/handler_v2.go`)

To change, update the code and redeploy.

## Subscription Management

### View Active Subscriptions

```sql
SELECT email, plan, plan_expires_at,
       CASE WHEN plan_expires_at > NOW() THEN 'active' ELSE 'expired' END as status
FROM users WHERE plan = 'pro' ORDER BY plan_expires_at DESC;
```

### View Trial Users

```sql
SELECT email, trial_ends_at,
       CASE WHEN trial_ends_at > NOW() THEN 'active' ELSE 'expired' END as status
FROM users WHERE plan = 'free' AND trial_ends_at IS NOT NULL
ORDER BY trial_ends_at DESC;
```

### Subscription Notifier

Runs automatically every 1 hour:
- Sends email 3 days and 1 day before trial/subscription expiry
- Auto-downgrades expired Pro users to Free
- Only emails users with `marketing_consent = true`

## Monitoring

### Grafana

```
https://progresql.com/grafana/
Login: admin / zaq1@WSXcde3
```

### Key Dashboards

- **Overview** — Health at a glance
- **Business Metrics** — Users, payments, subscriptions, ARPU, DAU/WAU/MAU
- **AI Agent** — Request rates, token usage, costs, errors
- **HTTP & WebSocket** — API latency, error rates, WS connections
- **Infrastructure** — CPU, memory, disk
- **Logs** — Searchable backend and nginx logs

### Prometheus Metrics

```bash
curl -s https://progresql.com/api/v1/health
curl -s http://localhost:8080/metrics   # from server
```

### Alerts

Alerts go to Telegram group. Configured in:
```
/opt/progresql/monitoring/grafana/provisioning/alerting/
```

## Admin API

### Analytics — All Users

```bash
curl -H "Authorization: Bearer <admin_jwt>" \
  https://progresql.com/api/v1/admin/analytics/users?month=2026-03
```

### Analytics — Single User

```bash
curl -H "Authorization: Bearer <admin_jwt>" \
  https://progresql.com/api/v1/admin/analytics/users/<user_id>
```

**Admin users** configured via `PROGRESSQL_ADMIN_USER_IDS` in `.env` (comma-separated UUIDs).

## Docker Management

```bash
cd /opt/progresql

# View running containers
docker compose ps

# View backend logs
docker compose logs -f backend --tail=100

# Restart backend
docker compose restart backend

# Full restart (all services)
docker compose up -d --force-recreate

# View resource usage
docker stats
```

## Legal Documents

Stored in `legal_documents` table. To update:

```sql
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at)
VALUES ('privacy', '2.0', 'Privacy Policy', 'ru', '<html>...</html>', NOW(), NOW());
```

Static legal pages served from `/var/www/progresql/legal/`.

## Backup

### Database Dump

```bash
PGPASSWORD=Pr0greSqL2026 pg_dump -h 92.63.176.193 -U progressql progressql > backup.sql
```

### Restore

```bash
PGPASSWORD=Pr0greSqL2026 psql -h 92.63.176.193 -U progressql progressql < backup.sql
```

## Cleanup k6 Test Users

After load testing:

```sql
BEGIN;
DELETE FROM legal_acceptances WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'k6_load_%@test.local');
DELETE FROM email_notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'k6_load_%@test.local');
DELETE FROM token_usage WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'k6_load_%@test.local');
DELETE FROM users WHERE email LIKE 'k6_load_%@test.local';
COMMIT;
```
