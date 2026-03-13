"""Configuration loader for PostgreSQL MCP adapter."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict

import psycopg

from common.errors import MCPConfigError


DEFAULT_APP_NAME = "progres-mcp"


@dataclass
class PgConfig:
    """Holds PostgreSQL connection details."""

    dsn: str
    app_name: str = DEFAULT_APP_NAME

    @classmethod
    def from_env(cls) -> "PgConfig":
        dsn = os.getenv("POSTGRES_DSN")
        if not dsn:
            raise MCPConfigError("POSTGRES_DSN is required for MCP server to start")
        app_name = os.getenv("POSTGRES_APP_NAME", DEFAULT_APP_NAME)
        return cls(dsn=dsn, app_name=app_name)

    def connection_kwargs(self) -> Dict[str, Any]:
        """Return safe connection kwargs enforcing read-only mode."""
        # options enforces read-only at session start; autocommit avoids open transactions.
        options = f"-c application_name={self.app_name} -c default_transaction_read_only=on"
        return {"conninfo": self.dsn, "autocommit": True, "options": options}

    def connect(self) -> psycopg.Connection[Any]:
        """Create a psycopg connection with safe defaults."""
        return psycopg.connect(**self.connection_kwargs())

