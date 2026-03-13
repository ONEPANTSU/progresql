# Progress MCP (PostgreSQL Safe Adapter)

Safe MCP server/client for PostgreSQL that exposes only metadata and EXPLAIN/EXPLAIN ANALYZE for SELECT queries. Data access (SELECT \*) and all DML/DDL are blocked by a SQL guard.

## Features
- MCP-compliant STDIO server (Anthropic MCP) exposing tools/resources.
- Tools: list_schemas, list_tables, table_columns, explain, explain_analyze.
- Resources: `schemas`, `tables/{schema}`, `columns/{schema}/{table}`.
- List schemas, tables, and columns without returning any row data; column data types include enums.
- Run EXPLAIN or EXPLAIN ANALYZE for allowed SELECT queries.
- SQL validator blocks `SELECT *`, multi-statements, and DML/DDL.
- Minimal client host to exercise server endpoints.

## Setup
1. Create and activate virtualenv: `python3 -m venv .venv && source .venv/bin/activate`
2. Install deps: `pip install -e .[dev]`
3. Configure PostgreSQL DSN: export `POSTGRES_DSN="postgresql://user:pass@host:port/dbname"`

## Usage
### MCP STDIO server
- Run server: `POSTGRES_DSN=... python -m mcp_server.stdio_server`
- Compatible with MCP hosts supporting STDIO transport; advertised tools/resources via MCP lifecycle.

### Minimal CLI host
- List schemas: `python -m mcp_client.client schemas`
- List tables: `python -m mcp_client.client tables public`
- List columns: `python -m mcp_client.client columns public users`
- Explain: `python -m mcp_client.client explain "SELECT id FROM public.users WHERE 1=0"`
- Explain analyze: `python -m mcp_client.client explain_analyze "SELECT id FROM public.users WHERE 1=0"`

## Tests
- BDD features live in `features/` and are bound via `pytest-bdd` tests in `tests/`.
- Run tests (requires `POSTGRES_DSN`): `pytest`
- Tests skip automatically if `POSTGRES_DSN` is unset.

## Safety
- Connections enforce `default_transaction_read_only=on`.
- SQL guard rejects unsafe patterns and `EXPLAIN` options.
- No table data is ever returned by the server surfaces.
- Function bodies are not exposed to avoid leaking logic; only metadata and plans are available.

