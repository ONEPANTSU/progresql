/**
 * Tool call handler bridge between Go backend agent pipeline and Electron database APIs.
 *
 * When the Go backend sends a `tool.call` message (e.g. "list_tables"),
 * this handler executes it via `window.electronAPI.executeToolRequest()`
 * and transforms the result into the format expected by the backend
 * (matching backend/internal/tools/types.go).
 */

import { createLogger } from '@/shared/lib/logger';
import type { ToolResultPayload } from './AgentService';
import type { ToolRequest } from '@/shared/types/electronAPI';

const log = createLogger('ToolHandler');

// ── Raw result shapes from Electron's executeToolRequest ──

interface RawSchemaItem {
  schema_name?: string;
  name?: string;
}

interface RawTableItem {
  name?: string;
  table_name?: string;
  type?: string;
  table_type?: string;
}

interface RawColumnItem {
  name?: string;
  column_name?: string;
  type?: string;
  data_type?: string;
  nullable?: boolean;
  is_nullable?: string | boolean;
  default?: string;
  column_default?: string;
}

interface RawIndexItem {
  name?: string;
  index_name?: string;
  columns?: string[];
  column_name?: string;
  unique?: boolean;
  is_unique?: boolean;
  definition?: string;
}

interface RawForeignKeyItem {
  name?: string;
  constraint_name?: string;
  columns?: string[];
  column_name?: string;
  referenced_table?: string;
  foreign_table_name?: string;
  referenced_columns?: string[];
  foreign_column_name?: string;
}

interface RawDescribeResult {
  columns?: RawColumnItem[];
  indexes?: RawIndexItem[];
  foreign_keys?: RawForeignKeyItem[];
  foreignKeys?: RawForeignKeyItem[];
}

interface RawFunctionItem {
  name?: string;
  args?: string;
  arguments?: string;
  return_type?: string;
}

interface RawQueryResult {
  rows?: Record<string, unknown>[];
  columns?: string[];
  error?: string;
}

interface RawExplainResult {
  plan?: string;
  error?: string;
}

// ── Backend-expected result shapes (matching backend/internal/tools/types.go) ──

interface BackendSchemaResult {
  schemas: string[];
}

interface BackendTableResult {
  tables: { name: string; type: string }[];
}

interface BackendDescribeResult {
  columns: { name: string; type: string; nullable: boolean; default?: string }[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreign_keys: { name: string; columns: string[]; referenced_table: string; referenced_columns: string[] }[];
}

interface BackendIndexResult {
  indexes: { name: string; columns: string[]; unique: boolean }[];
}

interface BackendExplainResult {
  plan: string;
  error: string;
}

interface BackendQueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  error: string;
}

interface BackendFunctionResult {
  functions: { name: string; args: string; return_type: string }[];
}

type TransformResult =
  | BackendSchemaResult
  | BackendTableResult
  | BackendDescribeResult
  | BackendIndexResult
  | BackendExplainResult
  | BackendQueryResult
  | BackendFunctionResult
  | unknown;

/**
 * Execute a tool call from the Go backend using Electron database APIs.
 * Returns a ToolResultPayload matching the backend's expected format.
 */
export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  connectionId?: string | null,
  securityMode?: 'safe' | 'data' | 'execute',
): Promise<ToolResultPayload> {
  log.debug(`Executing tool: ${toolName}`, connectionId ? `(conn: ${connectionId})` : '', securityMode ? `(mode: ${securityMode})` : '');

  // Check if electronAPI is available
  if (typeof window === 'undefined' || !window.electronAPI) {
    return { success: false, error: 'Electron API not available' };
  }

  const { electronAPI } = window;

  try {
    // Use the existing executeToolRequest handler in main.js
    // which already routes all tool names to the correct database queries
    const request: ToolRequest = {
      requestId: `tool-${Date.now()}`,
      toolName,
      arguments: args || {},
      ...(connectionId ? { connectionId } : {}),
      ...(securityMode ? { security_mode: securityMode } : {}),
    };
    const result = await electronAPI.executeToolRequest(request);

    if (!result.ok) {
      const errorMsg = result.error?.message || 'Tool execution failed';
      // Provide a clear, LLM-friendly message for missing DB connection
      if (errorMsg.includes('No database connection') || errorMsg.includes('connection lost')) {
        return {
          success: false,
          error: 'Database is not connected. The user needs to connect to a PostgreSQL database first before you can query it. Please ask the user to connect to a database.',
        };
      }
      return {
        success: false,
        error: errorMsg,
      };
    }

    // Transform the raw result into the format expected by the Go backend
    // (matching backend/internal/tools/types.go result structs)
    const data = transformResult(toolName, result.result);

    return { success: true, data };
  } catch (err: unknown) {
    log.error(`Tool ${toolName} failed:`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error executing tool',
    };
  }
}

/**
 * Transform the raw result from Electron's executeToolRequest
 * into the format expected by the Go backend's tool result types.
 *
 * The Go backend unmarshals tool.result.data into specific structs:
 *   - list_schemas  -> { schemas: string[] }
 *   - list_tables   -> { tables: [{name, type}] }
 *   - describe_table-> { columns: [...], indexes: [...], foreign_keys: [...] }
 *   - list_indexes  -> { indexes: [{name, columns, unique}] }
 *   - explain_query -> { plan: string, error: string }
 *   - execute_query -> { rows: [...], columns: [...], error: string }
 *   - list_functions-> { functions: [{name, args, return_type}] }
 */
function transformResult(toolName: string, raw: unknown): TransformResult {
  if (raw == null) {
    return raw;
  }

  switch (toolName) {
    case 'list_schemas': {
      // raw: string[] or [{schema_name: "..."}]
      if (Array.isArray(raw)) {
        const schemas = raw.map((s: string | RawSchemaItem) =>
          typeof s === 'string' ? s : ((s as RawSchemaItem).schema_name || (s as RawSchemaItem).name || String(s))
        );
        return { schemas };
      }
      const obj = raw as { schemas?: string[] };
      return { schemas: obj.schemas || [] };
    }

    case 'list_tables': {
      // raw: [{name: "users", type: "BASE TABLE"}] from safeApi.getTables()
      if (Array.isArray(raw)) {
        const tables = (raw as RawTableItem[]).map((t) => ({
          name: t.name || t.table_name || '',
          type: normalizeTableType(t.type || t.table_type || 'TABLE'),
        }));
        return { tables };
      }
      const obj = raw as { tables?: { name: string; type: string }[] };
      return { tables: obj.tables || [] };
    }

    case 'describe_table': {
      // raw from safeApi.describeTable(): {columns: [...], indexes: [...], ...}
      const desc = raw as RawDescribeResult;
      const columns = (desc.columns || []).map((c) => ({
        name: c.name || c.column_name || '',
        type: c.type || c.data_type || '',
        nullable: c.nullable ?? (c.is_nullable === 'YES' || c.is_nullable === true),
        default: c.default || c.column_default || undefined,
      }));

      const indexes = (desc.indexes || []).map((i) => ({
        name: i.name || i.index_name || '',
        columns: Array.isArray(i.columns) ? i.columns : [i.column_name].filter((x): x is string => !!x),
        unique: i.unique ?? i.is_unique ?? false,
      }));

      const foreign_keys = (desc.foreign_keys || desc.foreignKeys || []).map((fk) => ({
        name: fk.name || fk.constraint_name || '',
        columns: Array.isArray(fk.columns) ? fk.columns : [fk.column_name].filter((x): x is string => !!x),
        referenced_table: fk.referenced_table || fk.foreign_table_name || '',
        referenced_columns: Array.isArray(fk.referenced_columns)
          ? fk.referenced_columns
          : [fk.foreign_column_name].filter((x): x is string => !!x),
      }));

      return { columns, indexes, foreign_keys };
    }

    case 'list_indexes': {
      // raw: [{name, definition, ...}]
      if (Array.isArray(raw)) {
        const indexes = (raw as RawIndexItem[]).map((i) => ({
          name: i.name || i.index_name || '',
          columns: i.columns || extractColumnsFromDefinition(i.definition),
          unique: i.unique ?? (i.definition?.includes('UNIQUE') || false),
        }));
        return { indexes };
      }
      const obj = raw as { indexes?: { name: string; columns: string[]; unique: boolean }[] };
      return { indexes: obj.indexes || [] };
    }

    case 'explain_query': {
      // raw from safeApi.explainQuery(): string or {plan: string}
      if (typeof raw === 'string') {
        return { plan: raw, error: '' };
      }
      if (Array.isArray(raw)) {
        // EXPLAIN returns array of plan objects
        return { plan: JSON.stringify(raw, null, 2), error: '' };
      }
      const obj = raw as RawExplainResult;
      return { plan: obj.plan || JSON.stringify(raw), error: obj.error || '' };
    }

    case 'execute_query': {
      // raw: {rows: [...], columns: [...]} or just rows array
      if (Array.isArray(raw)) {
        const rows = raw as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        return { rows, columns, error: '' };
      }
      const obj = raw as RawQueryResult;
      return {
        rows: obj.rows || [],
        columns: obj.columns || [],
        error: obj.error || '',
      };
    }

    case 'list_functions': {
      // raw: [{name, return_type, arguments}]
      if (Array.isArray(raw)) {
        const functions = (raw as RawFunctionItem[]).map((f) => ({
          name: f.name || '',
          args: f.args || f.arguments || '',
          return_type: f.return_type || '',
        }));
        return { functions };
      }
      const obj = raw as { functions?: { name: string; args: string; return_type: string }[] };
      return { functions: obj.functions || [] };
    }

    default:
      // For unknown tools, pass through as-is
      return raw;
  }
}

/**
 * Normalize table type strings to what the Go backend expects.
 * PostgreSQL returns "BASE TABLE" / "VIEW", but backend expects "TABLE" / "VIEW".
 */
function normalizeTableType(type: string): string {
  const upper = type.toUpperCase();
  if (upper === 'BASE TABLE') return 'TABLE';
  if (upper.includes('VIEW')) return 'VIEW';
  return upper;
}

/**
 * Extract column names from a CREATE INDEX definition string.
 * e.g. "CREATE INDEX idx_users_email ON public.users USING btree (email)" -> ["email"]
 */
function extractColumnsFromDefinition(def: string | undefined): string[] {
  if (!def) return [];
  const match = def.match(/\(([^)]+)\)/);
  if (!match) return [];
  return match[1].split(',').map((s) => s.trim().split(' ')[0]);
}
