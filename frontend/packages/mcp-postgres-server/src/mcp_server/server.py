"""Public MCP server surface for PostgreSQL metadata + explain."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from mcp_server.config import PgConfig
from mcp_server.explain import ExplainService
from mcp_server.metadata import MetadataProvider


@dataclass
class MCPServer:
    """Thin orchestration layer composing provider services."""

    config: PgConfig
    metadata: MetadataProvider = field(init=False)
    explain_service: ExplainService = field(init=False)

    def __post_init__(self) -> None:
        self.metadata = MetadataProvider(self.config)
        self.explain_service = ExplainService(self.config)

    @classmethod
    def from_env(cls) -> "MCPServer":
        return cls(config=PgConfig.from_env())

    def list_schemas(self) -> List[str]:
        return self.metadata.list_schemas()

    def list_tables(self, schema: str) -> List[str]:
        return self.metadata.list_tables(schema)

    def table_columns(self, schema: str, table: str) -> List[dict]:
        return self.metadata.list_columns(schema, table)

    def explain(self, query: str, *, analyze: bool = False) -> List[str]:
        return self.explain_service.explain(query, analyze=analyze)

    def explain_analyze(self, query: str) -> List[str]:
        return self.explain_service.explain(query, analyze=True)


def create_server(config: Optional[PgConfig] = None) -> MCPServer:
    """Factory to allow DI in tests and host."""
    return MCPServer(config=config or PgConfig.from_env())

