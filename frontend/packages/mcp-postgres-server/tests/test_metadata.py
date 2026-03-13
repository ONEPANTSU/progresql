from __future__ import annotations

from typing import Dict, List

import pytest
from pytest_bdd import given, parsers, scenarios, then, when

scenarios("../features/metadata.feature")


@given("MCP server is running")
def mcp_server(server):
    return server


@given("PostgreSQL connection is configured")
def pg_connection(dsn: str):
    assert dsn


@given(parsers.cfparse('a schema "public" exists'))
def public_schema_exists(server):
    assert "public" in server.list_schemas()


@when("client requests database schemas")
def request_schemas(server, context: Dict):
    context["schemas"] = server.list_schemas()


@then("server returns list of schemas")
def verify_schemas(context: Dict):
    schemas: List[str] = context.get("schemas", [])
    assert isinstance(schemas, list)
    assert schemas


@then("each schema contains tables")
def verify_tables(server, context: Dict, ensure_users_table: str):
    schemas: List[str] = context["schemas"]
    schema_tables = {schema: server.list_tables(schema) for schema in schemas}
    context["schema_tables"] = schema_tables
    public_tables = schema_tables.get("public", [])
    # We expect at least one table (our ensured users) in public.
    assert ensure_users_table in public_tables or public_tables


@then("no table data is returned")
def no_table_data(context: Dict):
    assert all(isinstance(schema, str) for schema in context["schemas"])
    for tables in context.get("schema_tables", {}).values():
        assert all(isinstance(table, str) for table in tables)


@when(parsers.cfparse('client requests table "{table}" structure'))
def request_table_structure(server, context: Dict, table: str, ensure_users_table: str):
    assert table == ensure_users_table
    context["columns"] = server.table_columns("public", table)


@then("server returns column names")
def check_column_names(context: Dict):
    cols = context["columns"]
    assert cols
    assert all("name" in col for col in cols)


@then("column data types")
def check_column_types(context: Dict):
    cols = context["columns"]
    assert all("data_type" in col for col in cols)


@then("nullability information")
def check_nullability(context: Dict):
    cols = context["columns"]
    assert all("is_nullable" in col for col in cols)


@then("no row data")
def confirm_no_row_data(context: Dict):
    cols = context["columns"]
    for col in cols:
        assert set(col.keys()) == {"name", "data_type", "is_nullable"}

