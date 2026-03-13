"""SQL validation to enforce metadata-only access."""

from __future__ import annotations

import re
from typing import Literal

from common.errors import MCPSecurityError

StatementType = Literal["select", "explain"]

# Keywords we categorically block to prevent DDL/DML and bulk access.
FORBIDDEN_KEYWORDS = (
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "grant",
    "truncate",
    "vacuum",
    "copy",
)

SELECT_STAR_PATTERN = re.compile(r"(?is)select\s+\*\s+from")
FORBIDDEN_PATTERN = re.compile(
    r"(?is)\\b(" + "|".join(map(re.escape, FORBIDDEN_KEYWORDS)) + r")\\b"
)


def _strip_semicolon(sql: str) -> str:
    sql = sql.strip()
    if sql.endswith(";"):
        sql = sql[:-1].rstrip()
    if ";" in sql:
        raise MCPSecurityError("Multiple statements are forbidden")
    return sql


def _ensure_no_select_star(sql: str) -> None:
    if SELECT_STAR_PATTERN.search(sql):
        raise MCPSecurityError("Direct data access is forbidden")


def _ensure_no_forbidden_keywords(sql: str) -> None:
    if FORBIDDEN_PATTERN.search(sql):
        raise MCPSecurityError("DML/DDL statements are forbidden")


def _strip_explain(sql: str, allow_analyze: bool) -> str:
    sql_lower = sql.lower()
    if not sql_lower.startswith("explain"):
        return sql

    remainder = sql[len("explain") :].lstrip()
    if remainder.lower().startswith("analyze"):
        if not allow_analyze:
            raise MCPSecurityError("EXPLAIN ANALYZE is not allowed here")
        remainder = remainder[len("analyze") :].lstrip()
    if remainder.startswith("("):
        # Reject EXPLAIN options to keep the surface minimal and safer.
        raise MCPSecurityError("EXPLAIN options are not supported")
    return remainder


def validate_sql(sql: str, *, allow_explain_analyze: bool = True) -> StatementType:
    """
    Validate SQL string for safety.

    Allowed:
    - SELECT ... (no SELECT *)
    - EXPLAIN / EXPLAIN ANALYZE <SELECT ...> (no options)
    """
    if not sql or not sql.strip():
        raise MCPSecurityError("Empty SQL is not allowed")

    normalized = _strip_semicolon(sql)
    lowered = normalized.lower()

    if lowered.startswith("explain"):
        inner = _strip_explain(normalized, allow_explain_analyze)
        if not inner.lower().startswith("select"):
            raise MCPSecurityError("Only SELECT is allowed under EXPLAIN")
        _ensure_no_select_star(inner)
        _ensure_no_forbidden_keywords(inner)
        return "explain"

    if not lowered.startswith("select"):
        raise MCPSecurityError("Only SELECT and EXPLAIN are permitted")

    _ensure_no_select_star(normalized)
    _ensure_no_forbidden_keywords(normalized)
    return "select"

