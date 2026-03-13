"""Shared pytest fixtures for MCP PostgreSQL adapter."""

from __future__ import annotations

import os
from typing import Dict

import psycopg
import pytest

from mcp_server.config import PgConfig
from mcp_server.server import create_server


@pytest.fixture(scope="session")
def dsn() -> str:
    value = os.getenv("POSTGRES_DSN")
    if not value:
        pytest.skip("POSTGRES_DSN is not set; integration tests skipped")
    return value


@pytest.fixture(scope="session")
def pg_config(dsn: str) -> PgConfig:
    return PgConfig(dsn=dsn, app_name="progres-mcp-tests")


@pytest.fixture(scope="session")
def server(pg_config: PgConfig):
    return create_server(pg_config)


@pytest.fixture(scope="session")
def ensure_users_table(dsn: str) -> str:
    """Ensure a safe users table exists without inserting data."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        conn.autocommit = True
        cur.execute(
            """
            create table if not exists public.users (
                id serial primary key,
                name text not null,
                email text
            )
            """
        )
    return "users"


@pytest.fixture
def context() -> Dict:
    """Simple scenario context shared across steps."""
    return {}

