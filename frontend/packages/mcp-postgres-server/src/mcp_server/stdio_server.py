"""MCP STDIO server exposing safe PostgreSQL metadata and explain tools/resources."""

from __future__ import annotations

import anyio
import json
from typing import Iterable, Tuple

from mcp import types
from mcp.server import NotificationOptions, Server
from mcp.server.stdio import stdio_server

from common.errors import MCPQueryError, MCPSecurityError
from mcp_server.server import MCPServer, create_server
from mcp_server.sql_guard import validate_sql


SERVER_NAME = "progres-mcp"
SERVER_VERSION = "0.1.0"

# Lazily instantiate the underlying adapter when a request arrives.
_adapter: MCPServer | None = None
server = Server(
    SERVER_NAME,
    version=SERVER_VERSION,
    instructions=(
        "Metadata and EXPLAIN/EXPLAIN ANALYZE for PostgreSQL. "
        "Data access and DML/DDL are forbidden. Connections are read-only."
    ),
    website_url=None,
)


def get_adapter() -> MCPServer:
    global _adapter
    if _adapter is None:
        _adapter = create_server()
    return _adapter


def _json_content(data: object) -> Tuple[list[types.TextContent], dict]:
    """Return unstructured + structured content pair."""
    return [types.TextContent(type="text", text=json.dumps(data, indent=2))], data if isinstance(data, dict) else {"result": data}


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    """Declare MCP tools available to clients."""
    base_annotations = types.ToolAnnotations(readOnlyHint=True, destructiveHint=False)
    tools = [
        types.Tool(
            name="list_schemas",
            description="List non-system schemas",
            inputSchema={"type": "object", "additionalProperties": False},
            annotations=base_annotations,
        ),
        types.Tool(
            name="list_tables",
            description="List tables for a schema",
            inputSchema={
                "type": "object",
                "properties": {"schema": {"type": "string"}},
                "required": ["schema"],
                "additionalProperties": False,
            },
            annotations=base_annotations,
        ),
        types.Tool(
            name="table_columns",
            description="List columns for a table",
            inputSchema={
                "type": "object",
                "properties": {"schema": {"type": "string"}, "table": {"type": "string"}},
                "required": ["schema", "table"],
                "additionalProperties": False,
            },
            annotations=base_annotations,
        ),
        types.Tool(
            name="explain",
            description="EXPLAIN a safe SELECT query (no ANALYZE)",
            inputSchema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
                "additionalProperties": False,
            },
            annotations=base_annotations,
        ),
        types.Tool(
            name="explain_analyze",
            description="EXPLAIN ANALYZE a safe SELECT query",
            inputSchema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
                "additionalProperties": False,
            },
            annotations=base_annotations,
        ),
    ]
    # Populate cache for call_tool validation.
    return tools


def _list_resources_payload() -> list[types.Resource]:
    """Assemble static resource list for schemas/tables/columns."""
    adapter = get_adapter()
    schemas = adapter.list_schemas()
    resources: list[types.Resource] = [
        types.Resource(
            name="schemas",
            uri="urn:progres-mcp:schemas",
            description="List of non-system schemas",
            mimeType="application/json",
        )
    ]
    for schema in schemas:
        resources.append(
            types.Resource(
                name=f"tables/{schema}",
                uri=f"urn:progres-mcp:tables:{schema}",
                description=f"Tables in schema {schema}",
                mimeType="application/json",
            )
        )
        for table in adapter.list_tables(schema):
            resources.append(
                types.Resource(
                    name=f"columns/{schema}/{table}",
                    uri=f"urn:progres-mcp:columns:{schema}:{table}",
                    description=f"Columns in {schema}.{table}",
                    mimeType="application/json",
                )
            )
    return resources


@server.list_resources()
async def list_resources() -> list[types.Resource]:
    """Expose discoverable resources for schemas, tables, and columns."""
    return _list_resources_payload()


def _resource_content_from_uri(uri: str) -> Iterable[types.ReadResourceContents]:
    adapter = get_adapter()
    parts = uri.split(":")
    if len(parts) < 3 or parts[0] != "urn" or parts[1] != "progres-mcp":
        raise MCPSecurityError("Unsupported resource URI")

    kind = parts[2]
    if kind == "schemas":
        content = {"schemas": adapter.list_schemas()}
        yield types.TextResourceContents(uri=uri, text=json.dumps(content), mimeType="application/json")
    elif kind == "tables":
        if len(parts) != 4:
            raise MCPSecurityError("Resource URI must be urn:progres-mcp:tables:<schema>")
        schema = parts[3]
        content = {"schema": schema, "tables": adapter.list_tables(schema)}
        yield types.TextResourceContents(uri=uri, text=json.dumps(content), mimeType="application/json")
    elif kind == "columns":
        if len(parts) != 5:
            raise MCPSecurityError("Resource URI must be urn:progres-mcp:columns:<schema>:<table>")
        schema, table = parts[3], parts[4]
        content = {"schema": schema, "table": table, "columns": adapter.table_columns(schema, table)}
        yield types.TextResourceContents(uri=uri, text=json.dumps(content), mimeType="application/json")
    else:
        raise MCPSecurityError("Unknown resource kind")


@server.read_resource()
async def read_resource(uri: types.AnyUrl) -> Iterable[types.ReadResourceContents]:
    """Return metadata-backed resources."""
    return _resource_content_from_uri(str(uri))


@server.call_tool()
async def handle_tool_call(name: str, arguments: dict):
    """Dispatch MCP tool calls to underlying adapter."""
    try:
        adapter = get_adapter()
        match name:
            case "list_schemas":
                schemas = adapter.list_schemas()
                return _json_content({"schemas": schemas})
            case "list_tables":
                schema = arguments["schema"]
                tables = adapter.list_tables(schema)
                return _json_content({"schema": schema, "tables": tables})
            case "table_columns":
                schema = arguments["schema"]
                table = arguments["table"]
                columns = adapter.table_columns(schema, table)
                return _json_content({"schema": schema, "table": table, "columns": columns})
            case "explain":
                query = arguments["query"]
                validate_sql(query, allow_explain_analyze=False)
                plan = adapter.explain(query, analyze=False)
                return _json_content({"plan": plan})
            case "explain_analyze":
                query = arguments["query"]
                validate_sql(query, allow_explain_analyze=True)
                plan = adapter.explain_analyze(query)
                return _json_content({"plan": plan})
            case _:
                raise MCPSecurityError(f"Unknown tool: {name}")
    except (MCPSecurityError, MCPQueryError) as exc:
        # Let MCP convert to an error CallToolResult with isError=True.
        raise exc
    except KeyError as exc:
        raise MCPSecurityError(f"Missing required argument: {exc}") from exc


async def amain() -> None:
    notification_opts = NotificationOptions(
        tools_changed=False, resources_changed=False, prompts_changed=False
    )
    init_options = server.create_initialization_options(notification_options=notification_opts)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, init_options, raise_exceptions=False)


def main() -> None:
    anyio.run(amain)


if __name__ == "__main__":
    main()

