"""Metadata inspection for PostgreSQL without data access."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from psycopg import Cursor

from common.errors import MCPQueryError
from mcp_server.config import PgConfig

SYSTEM_SCHEMAS = {"pg_catalog", "information_schema"}


@dataclass
class MetadataProvider:
    """Expose schema/table/column metadata using safe catalog queries."""

    config: PgConfig

    def _execute(self, sql: str, params: tuple = ()) -> List[tuple]:
        try:
            with self.config.connect() as conn, conn.cursor() as cur:  # type: Cursor
                cur.execute(sql, params)
                return cur.fetchall()
        except Exception as exc:  # pragma: no cover - surfaced in tests
            raise MCPQueryError(f"Metadata query failed: {exc}") from exc

    def list_schemas(self) -> List[str]:
        rows = self._execute(
            """
            select schema_name
            from information_schema.schemata
            where schema_name not in ('pg_catalog', 'information_schema')
            order by schema_name
            """,
        )
        return [row[0] for row in rows]

    def list_tables(self, schema: str) -> List[str]:
        rows = self._execute(
            """
            select table_name
            from information_schema.tables
            where table_schema = %s
            order by table_name
            """,
            (schema,),
        )
        return [row[0] for row in rows]

    def list_columns(self, schema: str, table: str) -> List[Dict[str, str]]:
        rows = self._execute(
            """
            select
              column_name,
              data_type,
              is_nullable
            from information_schema.columns
            where table_schema = %s and table_name = %s
            order by ordinal_position
            """,
            (schema, table),
        )
        return [
            {"name": name, "data_type": dtype, "is_nullable": nullable}
            for name, dtype, nullable in rows
        ]

