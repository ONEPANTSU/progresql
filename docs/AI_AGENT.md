# ProgreSQL — AI Agent Architecture

## Overview

The AI agent is a multi-step pipeline that processes natural language queries, discovers database schema, generates SQL, and optionally executes queries — all through a real-time WebSocket connection with streaming responses.

## Pipeline Flow

```
Client (Electron)                    Backend (Go)                     LLM (OpenRouter)
      |                                   |                                |
      |  agent.request                    |                                |
      |------------------------------------>                               |
      |                                   |  1. Intent Detection           |
      |                                   |------------------------------->|
      |                                   |<-------------------------------|
      |                                   |  "sql" or "conversational"     |
      |                                   |                                |
      |                                   |  2. Schema Grounding           |
      |  tool.call (list_schemas)         |                                |
      |<------------------------------------|                              |
      |  tool.result                      |                                |
      |------------------------------------>                               |
      |  tool.call (describe_table)       |                                |
      |<------------------------------------|                              |
      |  tool.result                      |                                |
      |------------------------------------>                               |
      |                                   |                                |
      |                                   |  3. Parallel SQL Generation    |
      |                                   |  (3 candidates, temp 0.2/0.6/0.9)
      |                                   |------------------------------->|
      |  agent.stream (delta chunks)      |<-------------------------------|
      |<------------------------------------|                              |
      |                                   |                                |
      |                                   |  6. Result Aggregation         |
      |                                   |  (LLM picks best SQL)         |
      |                                   |------------------------------->|
      |                                   |<-------------------------------|
      |                                   |                                |
      |                                   |  7. Auto-Execute (if allowed)  |
      |  tool.call (execute_query)        |                                |
      |<------------------------------------|                              |
      |  tool.result (query results)      |                                |
      |------------------------------------>                               |
      |                                   |                                |
      |                                   |  8. Visualization              |
      |  agent.response (final)           |                                |
      |<------------------------------------|                              |
```

## Pipeline Actions

### `generate_sql` (Main chat flow)

8-step pipeline for converting natural language to SQL:

| Step | Name | Purpose |
|------|------|---------|
| 1 | `intent_detection` | Classify message as "sql" or "conversational" (temp=0.0) |
| 2 | `schema_grounding` | Discover relevant tables via tool calls |
| 3 | `parallel_sql_generation` | Generate 3 SQL candidates with varied temperatures |
| 4 | `diagnostic_retry` | Fix errors with LLM if SQL generation failed |
| 5 | `seed_expansion` | Expand seed results if needed |
| 6 | `result_aggregation` | Pick best SQL from candidates + generate explanation |
| 7 | `auto_execute` | Execute query (if security mode allows) |
| 8 | `visualization` | Generate chart if applicable |

### `explain_sql`

Single-step: Takes SQL input, returns human-readable explanation.

### `improve_sql`

Single-step: Takes SQL input, returns optimized version with explanation.

### `analyze_schema`

Single-step: Analyzes database schema and provides insights.

## Step Details

### 1. Intent Detection

Classifies user message as "sql" or "conversational" using a fast LLM call with temperature 0.0.

- **sql** — Any mention of database, tables, data, entities, schema, queries
- **conversational** — Pure greetings, thanks, chitchat only

For conversational messages: streams direct response, skips remaining steps.

### 2. Schema Grounding

Multi-step schema discovery:

1. Calls `list_schemas` tool
2. Calls `list_tables` for each schema
3. Uses LLM to select relevant tables from user request
4. Calls `describe_table` for relevant tables to get columns/indexes/FKs
5. Stores enriched SchemaContext in PipelineContext

### 3. Parallel SQL Generation

Generates 3 SQL candidates in parallel goroutines with different strategies:

| Candidate | Temperature | Strategy |
|-----------|-------------|----------|
| 1 | 0.2 | Simple, straightforward SQL |
| 2 | 0.6 | CTEs or subqueries for readability |
| 3 | 0.9 | Creative/alternative approach |

Each prompt includes full schema description + user message + conversation history.

### 6. Result Aggregation

Takes all SQL candidates and sends to LLM for evaluation:
- LLM selects best candidate with justification
- Non-streaming (internal evaluation)
- Sets `pctx.Result.SQL` (chosen query) and `pctx.Result.Candidates` (all options)

### 7. Auto-Execute

Behavior depends on security mode:
- **Safe Mode** — Skipped; user must run manually
- **Data Mode** — Only SELECT/WITH queries
- **Execute Mode** — All queries allowed

### 8. Visualization

Detects if SQL result is suitable for charting. Generates chart configuration:
- Chart types: `bar`, `line`, `pie`, `area`, `metric`, `table`
- Includes title, axis labels, data points

## WebSocket Protocol

### Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `agent.request` | Client -> Server | Start AI request |
| `agent.stream` | Server -> Client | Streaming text delta |
| `agent.response` | Server -> Client | Final result (SQL, explanation, visualization) |
| `agent.error` | Server -> Client | Error with code |
| `agent.cancel` | Client -> Server | Cancel ongoing request |
| `tool.call` | Server -> Client | Request client to execute a tool |
| `tool.result` | Client -> Server | Tool execution result |
| `autocomplete.request` | Client -> Server | SQL autocomplete request |
| `autocomplete.response` | Server -> Client | Autocomplete suggestion |

### Envelope Format

```json
{
  "type": "agent.request",
  "request_id": "uuid",
  "call_id": "uuid",
  "payload": { ... }
}
```

### Agent Request Payload

```json
{
  "action": "generate_sql",
  "user_message": "Show all users registered this month",
  "context": {
    "selected_sql": "",
    "active_table": "",
    "user_descriptions": "users.name - Full name of user",
    "security_mode": "safe",
    "language": "ru"
  }
}
```

Available actions: `generate_sql`, `explain_sql`, `improve_sql`, `analyze_schema`.

### Agent Response Payload

```json
{
  "action": "generate_sql",
  "result": {
    "sql": "SELECT * FROM users WHERE created_at > NOW() - INTERVAL '30 days'",
    "explanation": "This query returns all users registered in the last 30 days",
    "candidates": [
      "SELECT * FROM users WHERE created_at > NOW() - INTERVAL '30 days'",
      "WITH recent AS (...) SELECT ...",
      "SELECT * FROM users WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())"
    ],
    "query_result": { "rows": [...], "columns": [...] },
    "visualization": {
      "chart_type": "bar",
      "title": "Users by Day",
      "data": [...]
    },
    "validation_error": "",
    "security_blocked": false
  },
  "tool_calls_log": [
    { "call_id": "...", "tool_name": "list_tables", "success": true }
  ],
  "model_used": "qwen/qwen3-coder",
  "tokens_used": 1250
}
```

## Agent Tools

7 database tools available to the LLM via function calling:

| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `list_schemas` | `{}` | Schema names | Discover available schemas |
| `list_tables` | `{schema}` | Table/view names | List objects in schema |
| `describe_table` | `{schema, table}` | Columns, indexes, FKs | Get table structure |
| `list_indexes` | `{schema, table}` | Index definitions | Analyze indexes |
| `explain_query` | `{sql}` | EXPLAIN output | Validate query plan |
| `execute_query` | `{sql, limit?}` | Query results | Run read-only queries |
| `list_functions` | `{schema}` | Function signatures | Discover functions |

### Tool Call Flow

1. LLM decides to call a tool
2. Backend sends `tool.call` envelope to client via WebSocket
3. Client executes the tool locally (against user's DB connection)
4. Client sends `tool.result` back
5. Backend passes result to LLM for next step

**Timeout:** 15 seconds per tool call, 1 retry on timeout.

### Tool Result Data Structures

```typescript
// list_schemas
{ schemas: ["public", "auth", "extensions"] }

// list_tables
{ tables: [{ name: "users", type: "BASE TABLE" }, { name: "user_view", type: "VIEW" }] }

// describe_table
{
  columns: [{ name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" }],
  indexes: [{ name: "users_pkey", columns: ["id"], unique: true }],
  foreign_keys: [{ name: "fk_user", columns: ["user_id"], referenced_table: "users", referenced_columns: ["id"] }]
}

// execute_query
{ rows: [{ id: "...", name: "John" }], columns: ["id", "name"], error: "" }

// explain_query
{ plan: "Seq Scan on users  (cost=0.00..1.14 rows=14 width=556)", error: "" }

// list_functions
{ functions: [{ name: "my_func", args: "integer, text", return_type: "boolean" }] }
```

## Security Modes

### Safe Mode (Default)

- Schema inspection only via `pg_catalog` and `information_schema`
- Can: `SELECT` system catalogs, `EXPLAIN` (no ANALYZE)
- Cannot: Read user data, execute queries, DDL
- Auto-execute: **Never** — user must run SQL manually

### Data Mode

- Read-only access to user data
- Can: `SELECT`, `EXPLAIN`, `WITH` (CTE), analytics queries
- Cannot: `INSERT`, `UPDATE`, `DELETE`, `DROP`, any DDL
- Auto-execute: Only `SELECT`/`WITH` queries
- Database enforces `READ ONLY` transaction mode

### Execute Mode

- Full access: DML + DDL
- Can: Everything including `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`
- Warns user before destructive operations
- Auto-execute: All queries

### Enforcement Layers

1. **System prompt** — LLM instructed what it can/cannot do per mode
2. **SQL checker (Go)** — Server-side validation blocks disallowed SQL commands
3. **SQL checker (Python)** — MCP server validates via SQLGuard
4. **Auto-execute gate** — Controls whether query runs automatically

### System Prompt Excerpts

**Safe Mode** instructs the LLM:
```
SECURITY POLICY (Safe Mode — Schema Only):
- You have access ONLY to database schema metadata (tables, columns, types, indexes, functions).
- You CAN read source code of functions, views, triggers via system catalogs.
- You CAN use EXPLAIN (without ANALYZE) to show query execution plans.
- You MUST NOT access, read, display, or reference any actual user data.
- You MUST generate ONLY schema-inspection SQL: queries against pg_catalog, information_schema.
- You MUST NOT generate INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE.
- You MUST NOT use EXPLAIN ANALYZE (it executes the query).
```

**Data Mode**:
```
SECURITY POLICY (Data Mode — Read Only):
- You have read-only access to the database including both schema and data.
- All queries MUST be executed inside a READ ONLY transaction.
- You CAN use SELECT, EXPLAIN, EXPLAIN ANALYZE, WITH (CTE).
- You MUST NOT generate INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE.
```

**Execute Mode**:
```
SECURITY POLICY (Execute Mode — Full Access):
- You have full access including INSERT, UPDATE, DELETE, and DDL statements.
- Use caution with destructive operations and always warn the user.
```

**Language Priority** (all modes):
```
1. Detect the language of the user's message and respond in that SAME language.
2. If ambiguous, use the client's UI language.
3. Default: English.
NEVER respond in Chinese or any Asian language unless the user explicitly writes in that language.
```

## LLM Configuration

### Models

| Model ID | Name | Price (per token) |
|----------|------|-------------------|
| `qwen/qwen3-coder` | Qwen 3 Coder | $0.30/M |
| `openai/gpt-oss-120b` | GPT-OSS 120B | $0.10/M |
| `qwen/qwen3-vl-32b-instruct` | Qwen 3 VL 32B | $0.25/M |

### Provider

- **API:** OpenRouter (`https://openrouter.ai/api/v1`)
- **Format:** OpenAI-compatible chat completion
- **Streaming:** Server-Sent Events (SSE) with `[DONE]` marker
- **Retry:** 3 attempts, exponential backoff (1s base, 10s max, jitter)
- **Timeout:** 30s per request

## Autocomplete

SQL autocomplete uses a separate LLM call (non-streaming):

1. Client sends current SQL + cursor position + schema context
2. Backend splits SQL at cursor: `before[CURSOR]after`
3. LLM generates completion (max 150 tokens, 5s timeout)
4. Post-processing: strip duplicated prefix, remove markdown
5. Response sent as `autocomplete.response`

**Rules:** 1-3 lines max, schema-qualified names, match existing style.

## Token Tracking

Every AI request is recorded in `token_usage` table:

```sql
INSERT INTO token_usage
  (user_id, session_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, action)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
```

Cost calculation per model:

| Model | Cost |
|-------|------|
| qwen/qwen3-coder | $0.0000003/token |
| openai/gpt-oss-120b | $0.0000001/token |
| qwen/qwen3-vl-32b-instruct | $0.00000025/token |

Prometheus metrics: `llm_tokens_total{model, type}`, `agent_requests_total{action, status}`.

## Conversation History

- Up to **20 messages** stored per session
- Format: `{role: "user"|"assistant", content: string}`
- Prepended to every LLM request for multi-turn context
- Stored in-memory per WebSocket session (not persisted to disk)

## MCP PostgreSQL Server

Alternative database tool backend (Python), used alongside Electron tool handler:

**Location:** `frontend/packages/mcp-postgres-server/`

### Architecture

```
frontend/packages/mcp-postgres-server/
  src/mcp_server/
    server.py       # Main orchestration (MCPServer class)
    metadata.py     # Schema metadata provider
    explain.py      # Query explanation service
    sql_guard.py    # SQL validation / SQLGuard
```

### SQLGuard (Python)

```python
def validate_sql(sql: str, *, allow_explain_analyze: bool = True) -> StatementType:
    # Returns "select" or "explain"
    # Raises MCPSecurityError on violations
```

Blocked keywords: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `GRANT`, `TRUNCATE`, `VACUUM`, `COPY`.
Also blocks: `SELECT *` (direct data access forbidden in metadata mode).

### Capabilities

- `list_schemas()` — Available schemas
- `list_tables(schema)` — Tables in schema
- `table_columns(schema, table)` — Column definitions
- `explain(query)` — Query plan (EXPLAIN)
- `explain_analyze(query)` — Query plan with runtime stats

Communication protocol: STDIO-based MCP.

## Rate Limiting

- Per-session rate limiting checked before pipeline execution
- Configurable via `PROGRESSQL_RATE_LIMIT_PER_MIN` (default: 10)
- Plan-based limits: Free=10/min, Pro=60/min, Team=120/min

## Cancellation Support

Client can cancel ongoing AI requests:

```json
{ "type": "agent.cancel", "request_id": "uuid" }
```

Backend uses Go context cancellation — propagates to all goroutines in the pipeline.

## Error Codes

| Code | Meaning |
|------|---------|
| `tool_timeout` | Client didn't respond to tool call within 15s |
| `llm_error` | LLM API returned an error |
| `invalid_request` | Malformed request |
| `sql_blocked` | SQL blocked by security mode |
| `rate_limited` | User exceeded rate limit |
| `db_not_connected` | No database connection (tool error) |
| `cancelled` | User cancelled the request |

## Graceful Degradation

When tool call fails due to missing DB connection:
1. Detects error message contains "No database connection"
2. Streams friendly LLM response (language-aware)
3. Falls back to bilingual static message if LLM fails
4. Doesn't return error envelope — graceful fallback
