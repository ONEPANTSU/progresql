# ProgreSQL — Features

## AI-Powered SQL Assistant

- **Natural language to SQL** — Describe what you need in plain language, get a ready SQL query
- **Real-time streaming** — See AI responses appear character by character
- **Multi-turn conversations** — Context preserved across messages in a chat session
- **SQL explanation** — Select any SQL and ask the AI to explain it
- **SQL improvement** — Get optimization suggestions for your queries
- **Schema analysis** — AI analyzes your database structure and provides insights
- **Smart autocomplete** — AI-powered SQL completion as you type (context-aware)
- **Multiple chat tabs** — Run several conversations in parallel

## Three Security Modes

| Mode | Access Level | Use Case |
|------|-------------|----------|
| **Safe** | Schema-only | Explore structure without touching data |
| **Data** | Read-only | Run SELECT queries, analytics, charts |
| **Execute** | Full access | INSERT, UPDATE, DELETE, DDL operations |

## Database Management

- **Multiple connections** — Connect to several PostgreSQL servers simultaneously
- **Schema browser** — Navigate schemas, tables, views, functions, sequences, types
- **Object inspector** — View column details, indexes, constraints, foreign keys
- **Schema sync** — Compare and generate migration SQL between two connections
- **Database switching** — Switch between databases on the same server
- **Auto-reconnect** — Automatic reconnection on connection loss with exponential backoff
- **Encrypted credentials** — Passwords stored with OS-level encryption (Electron safeStorage)
- **Delete confirmation** — Confirmation dialog before deleting connections to prevent accidental removal

## SQL Editor

- **Syntax highlighting** — PostgreSQL-aware highlighting (keywords, types, strings, comments)
- **Multiple editor tabs** — Work on several queries at once
- **Code formatting** — Auto-format SQL with one click
- **Bracket matching** — Automatic bracket pair highlighting
- **Search & replace** — Built-in search with regex support
- **Execute with Ctrl+Enter** — Run query directly from editor
- **Ghost text suggestions** — AI completion suggestions inline

## Query Results

- **Results table** — View query output in a sortable table
- **CSV export** — Export results to CSV file
- **Chart visualization** — Automatic chart generation (bar, line, pie, area, metric)
- **Row count & timing** — See how many rows returned and execution time

## ER Diagram

- **Visual schema** — Entity-relationship diagram for your database
- **Interactive** — Zoom, pan, click on entities for details
- **Cross-area connections** — See relationships across schemas
- **Per-connection** — Open ER diagrams for different connections in tabs

## Subscription & Plans

| | Free | Trial (3 days) | Pro (1,999₽/mo) | Pro Plus (5,999₽/mo) |
|--|------|----------------|------------------|---------------------|
| Budget AI models | 50K tokens/day | 500K tokens/day | 5M tokens/month | 10M tokens/month |
| Premium AI models | — | — | 200K tokens/month | 1.5M tokens/month |
| AI requests | 10/min | 10/min | 60/min | 120/min |
| Tokens per request | 4,096 | 4,096 | 16,384 | 32,768 |
| AI autocomplete | — | Yes | Yes | Yes |
| Balance access | — | — | Yes (50% markup) | Yes (25% markup) |
| Concurrent sessions | 1 | 1 | 5 | 5 |

### Budget Models (included in plan)
- Qwen 3 Coder, GPT-OSS 120B, Qwen 3 VL 32B
- Gemma 3 27B, Mistral Small 3.2, DeepSeek V3

### Premium Models (quota + balance)
- Claude Sonnet 4, GPT-4.1, Gemini 2.5 Pro
- Claude 3.5 Sonnet, o3-mini, DeepSeek R1

### Balance System
- Pay-as-you-go for usage beyond quota limits
- Top-up via card or SBP (100₽ — 100,000₽)
- Per-token pricing with plan-dependent markup (Pro: 50%, Pro Plus: 25%)
- Balance persists through subscription changes
- Transparent cost display per AI request

- **Payment** — Card and SBP via Platega
- **Promo codes** — Support for trial extension, pro grants, and discounts

## Localization

- **Russian** (default)
- **English**
- AI responds in the same language as your message

## Desktop Application

- **macOS** — DMG installer with branded background
- **Windows** — NSIS installer with custom branding
- **Linux** — AppImage (sandbox-patched)
- **Auto-update** — Checks GitHub releases and notifies about new versions
- **Dark/Light/System** — Three theme modes

## Settings

- Theme selection (dark / light / system)
- Language (English / Russian)
- LLM model selection
- Security mode
- Custom backend URL
- Profile & subscription management
