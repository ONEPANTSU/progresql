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
| LLM Provider | OpenRouter API (Qwen 3 Coder, GPT-OSS 120B) |
| Payments | Platega (Card/SBP) |
| Auth | JWT (HS256, 24h TTL) + bcrypt + SMTP verification |
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
│   ├── metrics/                 # Observability
│   │   ├── prometheus.go        # Prometheus counters, histograms, gauges
│   │   └── metrics.go           # Custom JSON metrics endpoint
│   ├── payment/                 # Platega integration
│   │   ├── platega.go           # API client
│   │   ├── handler.go           # v1 endpoints
│   │   ├── handler_v2.go        # v2 endpoints (RUB)
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

## Frontend Architecture

```
frontend/
├── main.js                # Electron main process (IPC handlers, window management)
├── preload.js             # Context bridge (electronAPI)
├── db-health.js           # Connection health check & auto-reconnect
├── tool-server.js         # Backend tool execution bridge
├── mcp-manager.js         # MCP server lifecycle
├── renderer/
│   ├── pages/
│   │   ├── index.tsx      # Main app (connection mgmt, panels, query execution)
│   │   ├── login.tsx      # Sign in
│   │   ├── register.tsx   # Registration
│   │   ├── verify-email.tsx  # Email verification (OTP)
│   │   └── forgot-password.tsx
│   ├── components/
│   │   ├── DatabasePanel.tsx     # Left: connections, schema tree
│   │   ├── SQLEditor.tsx         # Center: CodeMirror SQL editor
│   │   ├── QueryResults.tsx      # Center-bottom: results table
│   │   ├── ChatPanel.tsx         # Right: AI chat sidebar
│   │   ├── SettingsPanel.tsx     # Settings drawer
│   │   ├── ERDiagram.tsx         # ER diagram viewer
│   │   ├── SchemaSyncModal.tsx   # Schema diff tool
│   │   ├── ElementDetailsModal.tsx # Object inspector
│   │   ├── PaymentModal.tsx      # Subscription payment
│   │   ├── TopNavigation.tsx     # Header bar
│   │   └── UpdateBanner.tsx      # Update notification
│   ├── contexts/
│   │   ├── AgentContext.tsx       # AI backend connection state
│   │   ├── ThemeContext.tsx       # Light/dark/system theme
│   │   ├── LanguageContext.tsx    # i18n (en/ru)
│   │   └── NotificationContext.tsx # Toast notifications
│   ├── providers/
│   │   └── AuthProvider.tsx      # Auth state, JWT, profile
│   ├── hooks/
│   │   ├── useChat.ts            # Chat tabs, messages
│   │   ├── useSQLTabs.ts         # SQL editor tabs
│   │   └── useStreamingMessage.ts # Streaming text renderer
│   ├── services/
│   │   ├── auth.ts               # Auth API client
│   │   ├── agent/AgentService.ts # WebSocket agent client
│   │   └── database/DatabaseSchemaService.ts
│   ├── locales/
│   │   ├── en.ts                 # English translations
│   │   └── ru.ts                 # Russian translations
│   └── utils/
│       ├── connectionStorage.ts  # Encrypted connection persistence
│       ├── chatStorage.ts        # Chat history persistence
│       └── descriptionStorage.ts # User descriptions for schema objects
```

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
| `schema_migrations` | Migration version tracking |

### Key Relationships

```
users ─┬── payments (1:N)
       ├── token_usage (1:N)
       ├── legal_acceptances (1:N)
       ├── email_notifications (1:N)
       └── promo_code_uses (1:N)

promo_codes ── promo_code_uses (1:N)
```

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
