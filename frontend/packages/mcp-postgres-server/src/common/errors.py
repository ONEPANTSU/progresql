"""Custom exceptions for the MCP PostgreSQL adapter."""

class MCPConfigError(RuntimeError):
    """Configuration or environment issue (e.g., missing DSN)."""


class MCPSecurityError(RuntimeError):
    """Raised when a query violates safety rules."""


class MCPQueryError(RuntimeError):
    """Raised for database execution issues that are safe to report."""

