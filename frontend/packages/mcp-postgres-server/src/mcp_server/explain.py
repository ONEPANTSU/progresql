"""Explain and explain analyze support with safety checks."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from psycopg import Cursor

from common.errors import MCPQueryError
from mcp_server.config import PgConfig
from mcp_server.sql_guard import validate_sql


def _prepare_explain_sql(sql: str, *, analyze: bool) -> str:
    lowered = sql.strip().lower()
    if lowered.startswith("explain"):
        validate_sql(sql, allow_explain_analyze=analyze)
        if analyze and "analyze" not in lowered.split():
            return f"EXPLAIN ANALYZE {sql.strip()[len('explain') :].strip()}"
        return sql.strip()

    validate_sql(sql, allow_explain_analyze=analyze)
    prefix = "EXPLAIN ANALYZE" if analyze else "EXPLAIN"
    return f"{prefix} {sql.strip()}"


@dataclass
class ExplainService:
    """Runs EXPLAIN/EXPLAIN ANALYZE for safe SELECT queries."""

    config: PgConfig

    def explain(self, query: str, *, analyze: bool = False) -> List[str]:
        sql = _prepare_explain_sql(query, analyze=analyze)
        try:
            with self.config.connect() as conn, conn.cursor() as cur:  # type: Cursor
                cur.execute(sql)
                rows = cur.fetchall()
                return [str(row[0]) for row in rows]
        except Exception as exc:  # pragma: no cover - surfaced in tests
            raise MCPQueryError(f"Explain failed: {exc}") from exc

