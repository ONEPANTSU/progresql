from __future__ import annotations

from typing import Dict, List

from pytest_bdd import given, scenarios, then, when

scenarios("../features/explain.feature")


@given("MCP server is running")
def mcp_server(server):
    return server


@when("client sends EXPLAIN ANALYZE for SELECT query")
def run_explain_analyze(server, context: Dict, ensure_users_table: str):
    query = f"SELECT id FROM public.{ensure_users_table} WHERE 1=0"
    context["explain_plan"] = server.explain_analyze(query)


@then("server executes EXPLAIN ANALYZE")
def verify_explain(context: Dict):
    plan: List[str] = context.get("explain_plan", [])
    assert plan


@then("returns query plan")
def returns_plan(context: Dict):
    plan: List[str] = context["explain_plan"]
    assert all(isinstance(line, str) for line in plan)


@then("does not return any table data")
def no_table_data(context: Dict):
    plan: List[str] = context["explain_plan"]
    # Plan text should not include row content; basic check for absence of literal row output markers.
    assert not any("Output:" in line for line in plan)

