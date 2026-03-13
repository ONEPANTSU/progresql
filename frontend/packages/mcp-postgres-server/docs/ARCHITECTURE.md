# Architecture

The adapter keeps PostgreSQL interactions narrowly scoped to metadata and query plans. All surfaces sit behind a SQL guard that blocks data access and mutation.

```mermaid
flowchart TD
    mcpHost[MCPHost (LLM app)] --> stdioServer[MCP STDIO Server]
    clientHost[ClientHost CLI] --> stdioServer
    stdioServer --> sqlGuard[SQLGuard]
    stdioServer --> metadataProvider[MetadataProvider]
    stdioServer --> explainService[ExplainService]
    metadataProvider --> postgres[PostgreSQL]
    explainService --> postgres
```

## Components
- `MCPServer`: orchestration facade exposing metadata and explain endpoints.
- `STDIO MCP server`: `mcp_server.stdio_server` registers MCP tools/resources and runs the STDIO transport.
- `MetadataProvider`: queries catalog views for schemas, tables, columns.
- `ExplainService`: wraps safe EXPLAIN / EXPLAIN ANALYZE calls.
- `SQLGuard`: validates incoming SQL, forbidding `SELECT *`, DML/DDL, multi-statements, and EXPLAIN options.
- `PgConfig`: loads DSN from environment and enforces read-only connections.

## Data flow
1. MCP host connects over STDIO and completes MCP initialization (capabilities advertise tools/resources).
2. Host discovers tools/resources via `tools/list` and `resources/list`.
3. SQLGuard validates input (for explain paths).
4. Server opens a read-only connection with `default_transaction_read_only=on`.
5. Metadata/Explain queries run against catalog; only text plans or metadata lists are returned.

## Threat model (SQL access)
- **Goal:** prevent row-level data access and any mutations.
- **Guards:** reject `SELECT *`, DML/DDL keywords, multiple statements, and EXPLAIN options; read-only connections.
- **Residual risk:** poorly formed SELECT that still infers data shape via statistics (acceptable within scope).
- **Design choice:** metadata includes column data types (including enums); function bodies remain hidden to avoid leaking business logic.

