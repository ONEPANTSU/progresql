# ProgreSQL — Architecture

## Overview

ProgreSQL is an AI-powered PostgreSQL database management desktop application. It provides a conversational AI agent that helps users write, explain, and execute SQL queries through a real-time WebSocket interface.

## System Architecture

```
                          ┌────────────────────────────────────┐
                          │           progresql.com            │
                          │         (147.45.198.0)             │
                          ├────────────────────────────────────┤
                          │                                    │
  ┌──────────────────┐    │   ┌─────────┐     ┌────────────┐  │
  │  Desktop Client  │────┼──▶│  Nginx   │────▶│  Backend   │  │
  │  (Electron)      │    │   │  :443    │     │  (Go)      │  │
  │                  │    │   │          │     │  :8080     │  │
  │  ┌────────────┐  │    │   └────┬─────┘     └─────┬──────┘  │
  │  │  React UI  │  │    │        │                  │         │
  │  │  Next.js   │  │    │   ┌────┴─────┐     ┌─────┴──────┐  │
  │  │  MUI       │  │    │   │ Landing  │     │ PostgreSQL │  │
  │  └────────────┘  │    │   │ /legal   │     │ :5432      │  │
  │  ┌────────────┐  │    │   │ /payment │     │(92.63...)  │  │
  │  │  pg client │──┼────┼───┼──────────┼─────▶            │  │
  │  │  (Node.js) │  │    │   └──────────┘     └────────────┘  │
  │  └────────────┘  │    │                                    │
  └──────────────────┘    │   ┌──────────────────────────────┐ │
                          │   │     Monitoring Stack          │ │
                          │   │  Prometheus · Grafana · Loki  │ │
                          │   │  Promtail · Node Exporter     │ │
                          │   └──────────────────────────────┘ │
                          └────────────────────────────────────┘
```

## Key Architectural Decisions

1. **Direct DB connections** — The Electron client connects to PostgreSQL directly via Node.js `pg` client. The backend does NOT proxy SQL queries — it only handles auth, payments, AI, and analytics.

2. **AI via WebSocket** — All AI interactions (chat, autocomplete) go through a WebSocket connection to the backend. The backend calls external LLMs (OpenRouter) and orchestrates tool calls back to the client.

3. **Three security modes** — `safe` (schema-only), `data` (read-only), `execute` (full access) — enforced both by LLM system prompts and server-side SQL validation.

4. **Provisioned monitoring** — All Grafana dashboards, datasources, and alerts are defined as code and auto-provisioned on container start.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Client | Electron 37 + Next.js 14 + React 18 + MUI 5 |
| SQL Editor | CodeMirror 6 with SQL language + custom autocomplete |
| Charts | Recharts + @xyflow/react (ERD) |
| Backend | Go 1.25, stdlib net/http + gorilla/websocket |
| Database | PostgreSQL 16 |
| LLM Provider | OpenRouter API (12 models: 6 budget + 6 premium) |
| Payments | Platega (Card/SBP) |
| Auth | JWT (HS256, 90d TTL) + bcrypt + SMTP verification |
| Monitoring | Prometheus + Grafana 10.4 + Loki 2.9 + Promtail |
| Reverse Proxy | Nginx + Let's Encrypt |
| CI/CD | GitHub Actions (tag-triggered) |
| Packaging | electron-builder (NSIS, AppImage), create-dmg (macOS) |

## Backend Architecture

```
backend/
├── cmd/server/main.go           # Entry point, wiring
├── config/config.go             # Configuration from env vars
├── internal/
│   ├── api/rest/                # HTTP handlers, router, middleware
│   │   ├── router.go            # Route registration + middleware chain
│   │   ├── handlers.go          # Auth, profile, sessions, legal, admin
│   │   ├── promo.go             # Promo code application
│   │   ├── analytics_landing.go # Landing page event tracking
│   │   ├── cors.go              # CORS middleware
│   │   ├── middleware_logging.go # Request logging with request IDs
│   │   └── middleware_metrics.go # Prometheus HTTP metrics
│   ├── agent/                   # AI pipeline
│   │   ├── pipeline.go          # Pipeline executor, context, token tracking
│   │   ├── safemode.go          # Security mode system prompts
│   │   ├── errors.go            # Error classification
│   │   └── steps/               # Pipeline steps (intent, schema, SQL gen, etc.)
│   ├── auth/                    # Authentication
│   │   ├── jwt.go               # JWT generation/validation
│   │   ├── users.go             # User store (CRUD)
│   │   ├── email.go             # Email service (verification, password reset)
│   │   └── middleware.go        # JWT auth middleware
│   ├── database/                # DB layer
│   │   └── migrations/          # SQL migrations (001-011)
│   ├── llm/                     # LLM client
│   │   ├── client.go            # OpenRouter API client
│   │   ├── stream.go            # SSE streaming
│   │   ├── retry.go             # Exponential backoff retry
│   │   └── types.go             # Request/response types
│   ├── balance/                 # Balance service (pay-as-you-go)
│   │   ├── service.go           # Top-up, charge, get balance
│   │   ├── store.go             # Row-level locking, transaction ledger
│   │   └── handler.go           # REST endpoints (GET balance, GET history)
│   ├── quota/                   # Quota service
│   │   ├── service.go           # Token tracking, quota enforcement
│   │   ├── store.go             # Period management, usage persistence
│   │   └── handler.go           # REST endpoints (GET usage, GET quota)
│   ├── models/                  # Model catalog
│   │   └── catalog.go           # 12 models config, tier classification, pricing
│   ├── notification/            # Notification system
│   │   ├── email.go             # Email templates (quota warning, balance low, etc.)
│   │   └── ws_push.go           # WebSocket push notifications
│   ├── metrics/                 # Observability
│   │   ├── prometheus.go        # Prometheus counters, histograms, gauges
│   │   └── metrics.go           # Custom JSON metrics endpoint
│   ├── payment/                 # Platega integration
│   │   ├── platega.go           # API client
│   │   ├── handler.go           # v1 endpoints
│   │   ├── handler_v2.go        # v2 endpoints (subscription + balance top-up)
│   │   └── discount.go          # Promo discount application
│   ├── security/                # SQL validation
│   │   └── sql_checker.go       # Whitelist/blacklist SQL commands per mode
│   ├── subscription/            # Plan management
│   │   ├── plan.go              # Plan definitions & limits
│   │   ├── checker.go           # Plan validation
│   │   ├── warning.go           # Expiry warning logic
│   │   └── notifier.go          # Async email notifier (trial/subscription expiry)
│   ├── tools/                   # Agent tools
│   │   └── registry.go          # 7 database tools (list_schemas, describe_table, etc.)
│   └── websocket/               # WebSocket layer
│       ├── handler.go           # HTTP upgrade + session creation
│       ├── session.go           # Per-connection state, message history
│       ├── hub.go               # Connection registry
│       ├── tools.go             # Tool call dispatcher (call → wait → result)
│       └── types.go             # Protocol messages (envelope, payloads)
```

## Frontend Architecture (FSD)

The frontend follows **Feature-Sliced Design (FSD)** methodology — code is organized by domain features with strict layer dependencies: `shared → entities → features → widgets → pages`.

```
frontend/
├── main.js                # Electron main process (IPC handlers, window management)
├── preload.js             # Context bridge (electronAPI)
├── db-health.js           # Connection health check & auto-reconnect
├── tool-server.js         # Backend tool execution bridge (SQL danger gate)
├── mcp-manager.js         # MCP server lifecycle
├── renderer/
│   ├── pages/                          # Next.js entry points (thin wrappers)
│   │   ├── index.tsx                   # Main app — orchestrates all panels
│   │   ├── _app.tsx                    # Global providers (Auth, Agent, Theme, i18n)
│   │   ├── login.tsx / register.tsx    # Auth pages
│   │   ├── verify-email.tsx            # Email verification (OTP)
│   │   └── forgot-password.tsx
│   │
│   ├── shared/                         # Cross-cutting infrastructure
│   │   ├── types/                      # Global TypeScript types + electronAPI.d.ts
│   │   ├── lib/                        # Utilities: logger, userStorage, secureSettingsStorage, sqlHighlight
│   │   ├── api/                        # WebSocket primitives (WebSocketClient, Mock, WithLogging)
│   │   ├── i18n/                       # LanguageContext + locales (en.ts, ru.ts)
│   │   └── ui/                         # Shared UI: Logo, ErrorBoundary
│   │
│   ├── entities/                       # Domain data + storage
│   │   ├── database/                   # connectionStorage, descriptionStorage, DatabaseSchemaService
│   │   └── chat/                       # chatStorage (chat history persistence)
│   │
│   ├── features/                       # Feature modules (business logic + UI)
│   │   ├── auth/                       # AuthProvider, auth API client (JWT, login, register)
│   │   ├── agent-chat/                 # AI chat feature
│   │   │   ├── AgentContext.tsx         # Agent connection state, security modes
│   │   │   ├── AgentService.ts         # WebSocket client for backend pipeline
│   │   │   ├── ChatPanel.tsx           # Multi-tab chat interface
│   │   │   ├── toolHandler.ts          # Local tool call execution
│   │   │   ├── useAgentMessages.ts     # Message flow orchestration
│   │   │   ├── useChat.ts             # Chat state management
│   │   │   ├── useStreamingMessage.ts  # Streaming text accumulation
│   │   │   └── ui/                     # ChatMessage, ChatInput, SQLBlock, ChartBlock, ToolApprovalDialog
│   │   ├── sql-editor/                 # SQLEditor, useSQLTabs, sqlAutocomplete, ghostTextExtension
│   │   ├── database-browser/           # DatabasePanel, ConnectionForm, ElementDetailsModal, SchemaSyncModal
│   │   ├── query-results/              # QueryResults (paginated table + export)
│   │   ├── er-diagram/                 # ERDiagram (entity-relationship viewer)
│   │   ├── settings/                   # SettingsPanel, ThemeContext
│   │   ├── billing/                    # PaymentModal, BalanceTopUpModal, PaymentHistory, UsageDashboard, QuotaIndicator
│   │   └── notifications/              # NotificationContext (toast queue)
│   │
│   ├── widgets/                        # Composite UI blocks (bridge features)
│   │   ├── top-navigation/             # TopNavigation (header + user menu + quota)
│   │   ├── status-bar/                 # StatusBar (query execution footer)
│   │   ├── update-banner/              # UpdateBanner (app update notification)
│   │   └── notification-bridge/        # NotificationBridge (agent → toast)
│   │
│   ├── app/
│   │   └── styles/                     # Global CSS
│   └── __tests__/                      # Test suite (503 tests, 19 suites)
```

### FSD Layer Rules

| Layer | Can Import From |
|-------|----------------|
| `shared/` | External packages only |
| `entities/` | `shared/` |
| `features/` | `entities/`, `shared/` |
| `widgets/` | `features/`, `entities/`, `shared/` |
| `pages/` | All layers |

All imports use `@/` path alias (e.g. `@/features/agent-chat/AgentContext`). Each module has an `index.ts` barrel export.

## Network Architecture

```
Internet
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│ Nginx (:443)                                             │
│                                                          │
│  /api/*    ──▶  Backend :8080  (REST API)                │
│  /ws/*     ──▶  Backend :8080  (WebSocket, 3600s timeout)│
│  /grafana/ ──▶  Grafana :3000  (monitoring)              │
│  /         ──▶  /var/www/landing/ (static)               │
│  /legal/*  ──▶  /var/www/legal/  (static)                │
│  /payment/ ──▶  /var/www/payment/ (static)               │
│  /downloads/ ─▶ /opt/progresql/downloads/ (installers)   │
└──────────────────────────────────────────────────────────┘
         │                │
         ▼                ▼
  ┌──────────┐    ┌──────────────┐
  │ Backend  │    │  PostgreSQL  │
  │ Go :8080 │    │  :5432       │
  │          │    │ (92.63..)    │
  └─────┬────┘    └──────────────┘
        │
        ▼
  ┌──────────────┐
  │  OpenRouter   │
  │  LLM API      │
  └──────────────┘
```

## Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `users` | User accounts (email, password_hash, plan, trial_ends_at, plan_expires_at) |
| `payments` | Payment transactions (Platega invoice_id, status, amount, currency) |
| `token_usage` | AI token consumption per request (model, prompt/completion tokens, cost_usd) |
| `legal_documents` | Legal docs (privacy, terms) with versioning |
| `legal_acceptances` | User acceptance records with metadata |
| `email_notifications` | Sent notification deduplication |
| `promo_codes` | Promo codes (pro_grant, trial_extension, discount) |
| `promo_code_uses` | Promo code usage log |
| `landing_events` | Landing page analytics (page_view, button_click, scroll_depth, video_play) |
| `balances` | User balance (amount, currency), row-level locking for concurrency |
| `balance_transactions` | Transaction ledger (top-up, model_charge, refund), with model/token details |
| `quota_usage` | Per-period token usage (budget/premium tokens used, period_start/end) |
| `models` | Model catalog (id, name, tier, pricing, enabled flag) |
| `schema_migrations` | Migration version tracking |

### Key Relationships

```
users ─┬── payments (1:N)
       ├── token_usage (1:N)
       ├── legal_acceptances (1:N)
       ├── email_notifications (1:N)
       ├── promo_code_uses (1:N)
       ├── balances (1:1)
       ├── balance_transactions (1:N)
       └── quota_usage (1:N)

promo_codes ── promo_code_uses (1:N)
models ── balance_transactions (1:N, via model_id)
```

## Quota Service

The quota service (`backend/internal/quota/`) enforces per-plan token limits on a rolling period basis.

- **Token tracking** — Every AI request records input/output tokens against the user's current period usage (budget and premium tracked separately)
- **Period management** — Periods are `daily` (Free plan) or `monthly` (Pro/Pro Plus). A new period is auto-created when the current one expires.
- **Quota enforcement** — Before each LLM call, the pipeline checks remaining quota. If budget quota is exhausted, the system attempts to charge the user's balance. If premium quota is exhausted, mid-generation fallback triggers.
- **Plan limits** — Configured per plan: Free (50K budget/day), Trial (500K budget/day), Pro (5M budget + 200K premium/month), Pro Plus (10M budget + 1.5M premium/month)

## Balance Service

The balance service (`backend/internal/balance/`) provides pay-as-you-go usage beyond quota limits.

- **Row-level locking** — Balance updates use `SELECT ... FOR UPDATE` to prevent race conditions on concurrent AI requests
- **Transaction ledger** — Every balance change is recorded in `balance_transactions` with type (`topup`, `model_charge`, `refund`), model details, and token counts
- **Charge flow** — When quota is exhausted, the agent pipeline charges the balance at per-token rates with plan-dependent markup (Pro: 50%, Pro Plus: 25%)
- **Top-up** — Users add funds via Platega (card/SBP), minimum 100 RUB, maximum 100,000 RUB. Balance persists across subscription changes.

## Model Catalog

The system supports 12 LLM models organized into two tiers:

| Tier | Models | Access |
|------|--------|--------|
| **Budget** (included in plan) | Qwen 3 Coder, GPT-OSS 120B, Qwen 3 VL 32B, Gemma 3 27B, Mistral Small 3.2, DeepSeek V3 | All plans (within quota) |
| **Premium** (quota + balance) | Claude Sonnet 4, GPT-4.1, Gemini 2.5 Pro, Claude 3.5 Sonnet, o3-mini, DeepSeek R1 | Pro and Pro Plus only |

Model configuration (pricing, tier, enabled flag) is managed via `backend/internal/models/catalog.go`. The `/api/v1/models` endpoint returns the list filtered by the user's plan tier.

## Payment Flow v2

Payment v2 supports two payment types via Platega webhooks:

1. **Subscription** — User selects a plan (Pro or Pro Plus), pays via card/SBP. On webhook confirmation, `plan` and `plan_expires_at` are updated.
2. **Balance top-up** — User specifies an amount (100-100,000 RUB). On webhook confirmation, the balance service credits the user's balance and records a `topup` transaction.

Both flows use a single v2 webhook handler that routes based on the `payment_type` field stored in the payment record.

## Notification System

- **Email templates** — Quota warning (80%/100% usage), balance low, subscription expiry, trial expiry. Sent via SMTP with deduplication via `email_notifications` table.
- **WebSocket push notifications** — Real-time in-app alerts pushed to connected clients: quota warnings, balance charges, model fallback events. Delivered through the existing WebSocket hub.

## Mid-Generation Fallback

When a premium model request would exceed the user's quota or balance mid-generation:

1. The agent pipeline detects quota/balance exhaustion during streaming
2. The current generation is halted with a user-visible notification
3. The system automatically retries the request with the default budget model (Qwen 3 Coder)
4. A `ModelFallbackTotal` Prometheus counter is incremented
5. The user receives a WebSocket notification explaining the fallback

This ensures uninterrupted AI assistance even when premium resources are exhausted.

## Monitoring Architecture

```
┌────────────┐     ┌────────────┐     ┌───────────┐
│  Backend   │────▶│ Prometheus │────▶│  Grafana  │
│  /metrics  │     │  :9090     │     │  :3000    │
└────────────┘     └────────────┘     └─────┬─────┘
                                            │
┌────────────┐     ┌────────────┐           │
│  Node      │────▶│ Prometheus │───────────┘
│  Exporter  │     │  (same)    │
│  :9100     │     └────────────┘
└────────────┘
                   ┌────────────┐     ┌───────────┐
┌────────────┐     │    Loki    │────▶│  Grafana  │
│  Promtail  │────▶│   :3100    │     │  (same)   │
│  (logs)    │     └────────────┘     └───────────┘
└────────────┘
                   ┌────────────┐     ┌───────────┐
                   │ PostgreSQL │────▶│  Grafana  │
                   │ (direct)   │     │  (same)   │
                   └────────────┘     └───────────┘
```

### Grafana Dashboards

| Dashboard | Datasource | Content |
|-----------|-----------|---------|
| Overview | Prometheus | Health, traffic, resources, users |
| HTTP & WebSocket | Prometheus | API latency, status codes, WS connections |
| AI Agent | Prometheus | Request rates, token usage, tool calls, errors |
| Infrastructure | Prometheus + Node Exporter | CPU, memory, disk, Go runtime |
| Business Metrics | PostgreSQL | Users, payments, subscriptions, ARPU, DAU/WAU/MAU |
| Logs | Loki | Backend + Nginx logs, searchable |
| Landing Analytics | Prometheus | Page views, clicks, downloads |

### Alerts (Telegram)

| Alert | Severity | Condition |
|-------|----------|-----------|
| Backend Down | Critical | Scrape target unavailable for 1 min |
| High Error Rate | Critical | 5xx rate > 5% for 5 min |
| High P95 Latency | Warning | p95 > 5s for 5 min |
| High CPU | Warning | > 90% for 10 min |
| Low Disk Space | Warning | > 85% used |
| LLM Error Spike | Warning | Agent error rate > 20% for 5 min |
| DB Pool Exhausted | Warning | > 90% connections used |
| High Memory | Warning | > 90% for 5 min |
