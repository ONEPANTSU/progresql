"""Minimal CLI-style host to exercise MCP server capabilities."""

from __future__ import annotations

import argparse
import json
from typing import Any

from mcp_server.server import create_server


def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description="Safe MCP PostgreSQL client host")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("schemas", help="List schemas")

    t_parser = sub.add_parser("tables", help="List tables for schema")
    t_parser.add_argument("schema")

    c_parser = sub.add_parser("columns", help="List columns for table")
    c_parser.add_argument("schema")
    c_parser.add_argument("table")

    e_parser = sub.add_parser("explain", help="EXPLAIN SELECT query")
    e_parser.add_argument("query")

    ea_parser = sub.add_parser("explain_analyze", help="EXPLAIN ANALYZE SELECT query")
    ea_parser.add_argument("query")

    args = parser.parse_args()
    server = create_server()

    if args.command == "schemas":
        _print(server.list_schemas())
    elif args.command == "tables":
        _print(server.list_tables(args.schema))
    elif args.command == "columns":
        _print(server.table_columns(args.schema, args.table))
    elif args.command == "explain":
        _print(server.explain(args.query))
    elif args.command == "explain_analyze":
        _print(server.explain_analyze(args.query))


if __name__ == "__main__":
    main()

