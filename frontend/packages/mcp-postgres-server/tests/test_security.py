from __future__ import annotations

import pytest
from pytest_bdd import given, parsers, scenarios, then, when

from common.errors import MCPSecurityError
from mcp_server.sql_guard import validate_sql

scenarios("../features/security.feature")


@given("MCP server is running")
def server_running(server):
    return server


@when(parsers.parse('client sends "{query}"'))
def client_sends_query(context, query: str):
    context["query"] = query
    with pytest.raises(MCPSecurityError) as exc:
        validate_sql(query)
    context["error_message"] = str(exc.value)


@then("server rejects request")
def server_rejected(context):
    assert "error_message" in context


@then('returns error "Direct data access is forbidden"')
def correct_error(context):
    assert context["error_message"] == "Direct data access is forbidden"

