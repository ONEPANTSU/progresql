import { McpClient } from './McpClient';
import { McpToolCallResult } from '../shared-types';

/**
 * Allowed tools - only metadata/schema operations
 */
const ALLOWED_TOOLS = new Set([
  'list_schemas',
  'list_tables',
  'describe_table',
  'list_indexes',
  'list_constraints',
  'list_columns',
  'list_views',
  'list_functions',
  'list_sequences',
  'explain_query', // Only if safe (no execution)
]);

/**
 * Type definitions for safe operations
 */
export interface TableRef {
  schema: string;
  name: string;
}

export interface TableDescription {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  indexes?: IndexInfo[];
  constraints?: ConstraintInfo[];
  primaryKey?: string[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isIdentity?: boolean;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface ConstraintInfo {
  name: string;
  type: string;
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
}

export interface ExplainPlan {
  plan: any;
  format: 'json' | 'text';
}

/**
 * Safe Postgres Tools API
 * Provides a secure interface to MCP tools with allowlist enforcement
 */
export class SafePostgresToolsApi {
  constructor(private mcpClient: McpClient) {
    if (!mcpClient.isInitialized()) {
      throw new Error('MCP client must be initialized before creating SafePostgresToolsApi');
    }
  }

  /**
   * Check if a tool is allowed
   */
  private isToolAllowed(toolName: string): boolean {
    return ALLOWED_TOOLS.has(toolName);
  }

  /**
   * Call a tool with allowlist check
   */
  private async callToolSafe(toolName: string, args: Record<string, any>): Promise<McpToolCallResult> {
    if (!this.isToolAllowed(toolName)) {
      throw new Error(`Tool '${toolName}' is not allowed. Only metadata/schema operations are permitted.`);
    }

    return await this.mcpClient.callTool(toolName, args);
  }

  /**
   * Extract text content from tool result
   */
  private extractResult(result: McpToolCallResult): any {
    if (result.isError) {
      throw new Error(result.content[0]?.text || 'Unknown error');
    }

    // Try to parse JSON from text content
    const textContent = result.content[0]?.text;
    if (textContent) {
      try {
        return JSON.parse(textContent);
      } catch {
        return textContent;
      }
    }

    // Return data if available
    return result.content[0]?.data || result.content;
  }

  /**
   * Get list of schemas
   */
  async getSchemas(): Promise<string[]> {
    const result = await this.callToolSafe('list_schemas', {});
    const data = this.extractResult(result);
    return Array.isArray(data) ? data : data.schemas || [];
  }

  /**
   * Get list of tables in a schema
   */
  async getTables(schema: string): Promise<TableRef[]> {
    const result = await this.callToolSafe('list_tables', { schema });
    const data = this.extractResult(result);
    
    if (Array.isArray(data)) {
      return data.map((item: any) => ({
        schema: item.schema || schema,
        name: item.name || item.table_name || item,
      }));
    }
    
    const tables = data.tables || [];
    return tables.map((table: any) => ({
      schema: table.schema || schema,
      name: table.name || table.table_name,
    }));
  }

  /**
   * Get detailed description of a table
   */
  async describeTable(schema: string, table: string): Promise<TableDescription> {
    const result = await this.callToolSafe('describe_table', { schema, table });
    const data = this.extractResult(result);

    return {
      schema: data.schema || schema,
      name: data.name || data.table_name || table,
      columns: (data.columns || []).map((col: any) => ({
        name: col.name || col.column_name,
        type: col.type || col.data_type,
        nullable: col.nullable !== false,
        defaultValue: col.default || col.default_value,
        isIdentity: col.is_identity || false,
      })),
      indexes: data.indexes?.map((idx: any) => ({
        name: idx.name || idx.index_name,
        columns: idx.columns || [],
        unique: idx.unique || false,
        type: idx.type || 'btree',
      })),
      constraints: data.constraints?.map((con: any) => ({
        name: con.name || con.constraint_name,
        type: con.type || con.constraint_type,
        columns: con.columns || [con.column_name].filter(Boolean),
        referencedTable: con.referenced_table,
        referencedColumns: con.referenced_columns,
      })),
      primaryKey: data.primary_key || data.primaryKey,
    };
  }

  /**
   * Get indexes for a table
   */
  async getIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const result = await this.callToolSafe('list_indexes', { schema, table });
    const data = this.extractResult(result);

    const indexes = Array.isArray(data) ? data : data.indexes || [];
    return indexes.map((idx: any) => ({
      name: idx.name || idx.index_name,
      columns: idx.columns || [idx.column_name].filter(Boolean),
      unique: idx.unique || false,
      type: idx.type || 'btree',
    }));
  }

  /**
   * Get constraints for a table
   */
  async getConstraints(schema: string, table: string): Promise<ConstraintInfo[]> {
    const result = await this.callToolSafe('list_constraints', { schema, table });
    const data = this.extractResult(result);

    const constraints = Array.isArray(data) ? data : data.constraints || [];
    return constraints.map((con: any) => ({
      name: con.name || con.constraint_name,
      type: con.type || con.constraint_type,
      columns: con.columns || [con.column_name].filter(Boolean),
      referencedTable: con.referenced_table,
      referencedColumns: con.referenced_columns,
    }));
  }

  /**
   * Get columns for a table (convenience method)
   */
  async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const description = await this.describeTable(schema, table);
    return description.columns;
  }

  /**
   * Explain a query (read-only, no execution)
   * WARNING: Only use if MCP server guarantees no execution
   */
  async explainQuery(sql: string, format: 'json' | 'text' = 'json'): Promise<ExplainPlan> {
    if (!this.isToolAllowed('explain_query')) {
      throw new Error('explain_query tool is not available or not allowed');
    }

    // Additional safety check: reject queries that look like DML
    const upperSql = sql.trim().toUpperCase();
    const dangerousKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE'];
    
    if (dangerousKeywords.some(keyword => upperSql.startsWith(keyword))) {
      throw new Error('EXPLAIN is only allowed for SELECT queries');
    }

    const result = await this.callToolSafe('explain_query', { sql, format });
    const data = this.extractResult(result);

    return {
      plan: data.plan || data,
      format,
    };
  }

  /**
   * Get list of views in a schema
   */
  async getViews(schema: string): Promise<TableRef[]> {
    const result = await this.callToolSafe('list_views', { schema });
    const data = this.extractResult(result);

    const views = Array.isArray(data) ? data : data.views || [];
    return views.map((view: any) => ({
      schema: view.schema || schema,
      name: view.name || view.view_name,
    }));
  }

  /**
   * Get list of functions in a schema
   */
  async getFunctions(schema: string): Promise<any[]> {
    const result = await this.callToolSafe('list_functions', { schema });
    const data = this.extractResult(result);

    return Array.isArray(data) ? data : data.functions || [];
  }

  /**
   * Get list of sequences in a schema
   */
  async getSequences(schema: string): Promise<any[]> {
    const result = await this.callToolSafe('list_sequences', { schema });
    const data = this.extractResult(result);

    return Array.isArray(data) ? data : data.sequences || [];
  }
}
