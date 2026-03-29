# ProgreSQL — API Reference

Base URL: `https://progresql.com`

## Authentication

All authenticated endpoints require `Authorization: Bearer <JWT>` header.

### POST /api/v1/auth/register

Register new user. Returns JWT token.

```json
// Request
{ "email": "user@example.com", "password": "P@ssw0rd!", "name": "John" }

// Response 201
{ "token": "eyJ...", "user": { "id": "...", "email": "...", "plan": "free", "trial_ends_at": "..." } }
```

### POST /api/v1/auth/login

```json
// Request
{ "email": "user@example.com", "password": "P@ssw0rd!" }

// Response 200
{ "token": "eyJ...", "user": { ... } }
```

### GET /api/v1/auth/profile (Auth)

Returns user profile with subscription status and warning level.

### POST /api/v1/auth/send-verification (Auth)

Sends 6-digit verification code to user's email. TTL: 15 minutes.

### POST /api/v1/auth/verify-code (Auth)

```json
{ "code": "123456" }
```

### POST /api/v1/auth/forgot-password

```json
{ "email": "user@example.com" }
```

Always returns 200 (prevents email enumeration).

### POST /api/v1/auth/reset-password

```json
{ "email": "user@example.com", "code": "123456", "new_password": "NewP@ss1!" }
```

## Sessions

### POST /api/v1/sessions (Auth)

Create WebSocket session. Returns `session_id` and `ws_url`.

```json
// Response 201
{ "session_id": "uuid", "ws_url": "wss://progresql.com/ws/uuid" }
```

## Payments

### GET /api/v1/payment/price (Auth)

Returns current price (with active discount applied).

### POST /api/v1/payments/create-invoice (Auth)

```json
// Request
{ "payment_method": "card" }

// Response 200
{ "invoice_id": "...", "redirect_url": "https://app.platega.io/..." }
```

### GET /api/v2/payment/prices (Auth)

Returns prices for all available plans with active discounts applied.

```json
// Response 200
{
  "plans": [
    { "plan": "pro", "price": 1999, "original_price": 1999, "currency": "RUB", "period": "month" },
    { "plan": "pro_plus", "price": 5999, "original_price": 5999, "currency": "RUB", "period": "month" }
  ],
  "min_balance_topup": 100,
  "max_balance_topup": 100000
}
```

### POST /api/v2/payments/create-invoice (Auth)

v2 endpoint supports subscription and balance top-up payments.

```json
// Request — Subscription
{ "payment_type": "subscription", "plan": "pro_plus", "payment_method": 11 }

// Request — Balance Top-up
{ "payment_type": "balance_topup", "amount": 500, "payment_method": 11 }

// Response 200
{ "payment_url": "https://app.platega.io/..." }
```

### POST /api/v1/payments/webhook

Platega callback. Verified by `X-MerchantId` + `X-Secret` headers.

## Balance

### GET /api/v2/balance (Auth)

Returns current user balance.

```json
// Response 200
{ "balance": 1250.50, "currency": "RUB" }
```

### GET /api/v2/balance/history (Auth)

Returns paginated balance transaction history.

Query: `?limit=20&offset=0`

```json
// Response 200
{
  "transactions": [
    {
      "id": "uuid",
      "amount": -2.34,
      "balance_after": 1248.16,
      "tx_type": "model_charge",
      "model_id": "anthropic/claude-sonnet-4",
      "tokens_input": 1500,
      "tokens_output": 800,
      "description": "Token usage: anthropic/claude-sonnet-4",
      "created_at": "2026-03-29T12:34:56Z"
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

## Quota & Usage

### GET /api/v2/usage (Auth)

Returns current token usage for the billing period.

```json
// Response 200
{
  "budget_tokens_used": 1250000,
  "budget_tokens_limit": 5000000,
  "premium_tokens_used": 50000,
  "premium_tokens_limit": 200000,
  "period_start": "2026-03-01T00:00:00Z",
  "period_end": "2026-03-31T00:00:00Z",
  "period_type": "monthly",
  "balance": 1250.50,
  "balance_enabled": true,
  "plan": "pro"
}
```

### GET /api/v2/quota (Auth)

Returns quota configuration for the user's plan.

```json
// Response 200
{
  "plan": "pro",
  "budget_tokens_limit": 5000000,
  "premium_tokens_limit": 200000,
  "period_type": "monthly",
  "autocomplete_enabled": true,
  "balance_markup_pct": 50,
  "balance_enabled": true,
  "max_requests_per_min": 60,
  "max_tokens_per_request": 16384
}
```

## Promo Codes

### POST /api/v1/promo/apply (Auth)

```json
// Request
{ "code": "LAUNCH2026" }

// Response 200
{ "success": true, "plan": "pro", "expires_at": "2026-04-28T..." }
```

## Legal

### GET /api/v1/legal/{type}

Get latest legal document. Types: `privacy`, `terms`, `offer`.

### GET /api/v1/legal/{type}/{version}

Get specific version.

### POST /api/v1/legal/accept (Auth)

```json
{ "doc_type": "privacy", "doc_version": "1.0" }
```

## Models

### GET /api/v1/models

Returns available LLM models.

```json
{
  "models": [
    { "id": "qwen/qwen3-coder", "name": "Qwen 3 Coder", "is_default": true },
    { "id": "openai/gpt-oss-120b", "name": "GPT-OSS 120B" }
  ]
}
```

## Analytics

### POST /api/v1/analytics/event

Track landing page event (no auth, rate-limited 100/min per IP).

```json
{ "event_type": "page_view", "session_id": "...", "referrer": "..." }
```

### GET /api/v1/admin/analytics/users (Admin)

Query: `?month=2026-03` (optional). Returns aggregated token usage per user.

### GET /api/v1/admin/analytics/users/{id} (Admin)

Detailed analytics for a specific user.

## System

### GET /api/v1/health

```json
{ "status": "ok", "version": "1.0.70" }
```

### GET /metrics

Prometheus metrics (text format).

## WebSocket

### GET /ws/{session_id}?token={JWT}

Upgrade to WebSocket. See [AI_AGENT.md](AI_AGENT.md) for protocol details.

## Password Requirements

- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 digit
- At least 1 special character
