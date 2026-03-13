from __future__ import annotations

import json

import pytest

from mcp_server import stdio_server as stdio


@pytest.mark.asyncio
async def test_list_tools_names():
    tools = await stdio.list_tools()
    names = {tool.name for tool in tools}
    assert {"list_schemas", "list_tables", "table_columns", "explain", "explain_analyze"} <= names


@pytest.mark.asyncio
async def test_tool_table_columns(dsn, ensure_users_table):
    _, structured = await stdio.handle_tool_call(
        "table_columns", {"schema": "public", "table": ensure_users_table}
    )
    assert structured["table"] == ensure_users_table
    assert structured["columns"]


@pytest.mark.asyncio
async def test_tool_explain(dsn, ensure_users_table):
    _, structured = await stdio.handle_tool_call(
        "explain", {"query": f"SELECT id FROM public.{ensure_users_table} WHERE 1=0"}
    )
    assert "plan" in structured
    assert structured["plan"]


@pytest.mark.asyncio
async def test_read_resource_columns(dsn, ensure_users_table):
    uri = f"urn:progres-mcp:columns:public:{ensure_users_table}"
    contents = list(await stdio.read_resource(uri))
    assert contents
    payload = json.loads(contents[0].text)
    assert payload["table"] == ensure_users_table
    assert payload["columns"]

