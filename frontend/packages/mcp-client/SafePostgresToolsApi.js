const { createLogger } = require('../../logger');
const log = createLogger('SafePostgresToolsApi');

const ALLOWED_TOOLS = new Set([
  'list_schemas',
  'list_tables',
  'table_columns', // MCP server tool name
  'describe_table',
  'list_indexes',
  'list_constraints',
  'list_columns',
  'list_views',
  'list_functions',
  'list_sequences',
  'list_extensions',
  'list_types',
  'list_enums',
  'list_triggers',
  'list_procedures',
  'explain_query',
  'explain', // MCP server tool name
  'explain_analyze', // MCP server tool name
]);

class SafePostgresToolsApi {
  constructor(mcpClient) {
    if (!mcpClient) {
      throw new Error('MCP client is required');
    }
    if (!mcpClient.isInitialized || !mcpClient.isInitialized()) {
      throw new Error('MCP client must be initialized before creating SafePostgresToolsApi');
    }
    this.mcpClient = mcpClient;
  }

  isToolAllowed(toolName) {
    const allowed = ALLOWED_TOOLS.has(toolName);
    log.debug(`isToolAllowed(${toolName}): ${allowed}, ALLOWED_TOOLS:`, Array.from(ALLOWED_TOOLS));
    return allowed;
  }

  async callToolSafe(toolName, args) {
    log.debug(`callToolSafe called with toolName: ${toolName}`);
    if (!this.isToolAllowed(toolName)) {
      throw new Error(`Tool '${toolName}' is not allowed. Only metadata/schema operations are permitted.`);
    }

    return await this.mcpClient.callTool(toolName, args);
  }

  extractResult(result) {
    log.debug('extractResult input:', JSON.stringify(result, null, 2));

    if (result.isError) {
      throw new Error(result.content[0]?.text || 'Unknown error');
    }

    // Try to parse JSON from text content
    const textContent = result.content[0]?.text;
    if (textContent) {
      try {
        const parsed = JSON.parse(textContent);
        log.debug('Parsed JSON from text:', parsed);
        return parsed;
      } catch (e) {
        log.debug('Failed to parse JSON, returning text:', textContent);
        return textContent;
      }
    }

    // Return data if available
    const data = result.content[0]?.data || result.content;
    log.debug('Returning data:', data);
    return data;
  }

  async getSchemas() {
    const result = await this.callToolSafe('list_schemas', {});
    const data = this.extractResult(result);
    const schemas = Array.isArray(data) ? data : data.schemas || [];

    // Filter out system schemas that might slip through
    const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1']);
    return schemas.filter(schema => !SYSTEM_SCHEMAS.has(schema));
  }

  async getTables(schema) {
    log.debug('getTables called with schema:', schema);
    const result = await this.callToolSafe('list_tables', { schema });
    log.debug('getTables raw result:', JSON.stringify(result, null, 2));
    const data = this.extractResult(result);
    log.debug('getTables extracted data:', JSON.stringify(data, null, 2));

    // MCP server returns {"schema": "public", "tables": ["table1", "table2", ...]}
    // where tables is an array of strings (table names)
    if (Array.isArray(data)) {
      // If data is already an array, treat each item as a table name
      const mapped = data.map((item) => {
        if (typeof item === 'string') {
          return { schema: schema, name: item };
        }
        return {
          schema: item.schema || schema,
          name: item.name || item.table_name || item,
        };
      });
      log.debug('getTables returning array:', mapped);
      return mapped;
    }

    // If data is an object with "tables" property
    const tables = data.tables || [];
    const mapped = tables.map((table) => {
      // table can be a string (table name) or an object
      if (typeof table === 'string') {
        return { schema: data.schema || schema, name: table };
      }
      return {
        schema: table.schema || data.schema || schema,
        name: table.name || table.table_name || table,
      };
    });
    log.debug('getTables returning from tables property:', mapped);
    return mapped;
  }

  async describeTable(schema, table) {
    const result = await this.callToolSafe('describe_table', { schema, table });
    const data = this.extractResult(result);

    return {
      schema: data.schema || schema,
      name: data.name || data.table_name || table,
      columns: (data.columns || []).map((col) => ({
        name: col.name || col.column_name,
        type: col.type || col.data_type,
        nullable: col.nullable !== false,
        defaultValue: col.default || col.default_value,
        isIdentity: col.is_identity || false,
      })),
      indexes: data.indexes?.map((idx) => ({
        name: idx.name || idx.index_name,
        columns: idx.columns || [],
        unique: idx.unique || false,
        type: idx.type || 'btree',
      })),
      constraints: data.constraints?.map((con) => ({
        name: con.name || con.constraint_name,
        type: con.type || con.constraint_type,
        columns: con.columns || [con.column_name].filter(Boolean),
        referencedTable: con.referenced_table,
        referencedColumns: con.referenced_columns,
      })),
      primaryKey: data.primary_key || data.primaryKey,
    };
  }

  async getIndexes(schema, table) {
    const result = await this.callToolSafe('list_indexes', { schema, table });
    const data = this.extractResult(result);

    const indexes = Array.isArray(data) ? data : data.indexes || [];
    return indexes.map((idx) => ({
      name: idx.name || idx.index_name,
      columns: idx.columns || [idx.column_name].filter(Boolean),
      unique: idx.unique || false,
      type: idx.type || 'btree',
    }));
  }

  async getConstraints(schema, table) {
    const result = await this.callToolSafe('list_constraints', { schema, table });
    const data = this.extractResult(result);

    const constraints = Array.isArray(data) ? data : data.constraints || [];
    return constraints.map((con) => ({
      name: con.name || con.constraint_name,
      type: con.type || con.constraint_type,
      columns: con.columns || [con.column_name].filter(Boolean),
      referencedTable: con.referenced_table,
      referencedColumns: con.referenced_columns,
    }));
  }

  async getColumns(schema, table) {
    // Use table_columns tool from MCP server directly
    const result = await this.callToolSafe('table_columns', { schema, table });
    const data = this.extractResult(result);

    // MCP server returns {"schema": "public", "table": "users", "columns": [...]}
    const columns = data.columns || [];
    return columns.map((col) => ({
      name: col.name || col.column_name,
      type: col.data_type || col.type,
      nullable: col.is_nullable !== 'NO',
    }));
  }

  async explainQuery(sql, format = 'json') {
    // Support both explain_query and explain tool names
    const toolName = this.isToolAllowed('explain') ? 'explain' : 'explain_query';

    // Additional safety check: reject queries that look like DML
    const upperSql = sql.trim().toUpperCase();
    const dangerousKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE'];

    if (dangerousKeywords.some(keyword => upperSql.startsWith(keyword))) {
      throw new Error('EXPLAIN is only allowed for SELECT queries');
    }

    const result = await this.callToolSafe(toolName, { query: sql });
    const data = this.extractResult(result);

    return {
      plan: data.plan || data,
      format,
    };
  }

  async getViews(schema) {
    const result = await this.callToolSafe('list_views', { schema });
    const data = this.extractResult(result);

    const views = Array.isArray(data) ? data : data.views || [];
    return views.map((view) => ({
      schema: view.schema || schema,
      name: view.name || view.view_name,
    }));
  }

  async getFunctions(schema) {
    const result = await this.callToolSafe('list_functions', { schema });
    const data = this.extractResult(result);

    return Array.isArray(data) ? data : data.functions || [];
  }

  async getSequences(schema) {
    const result = await this.callToolSafe('list_sequences', { schema });
    const data = this.extractResult(result);

    return Array.isArray(data) ? data : data.sequences || [];
  }
}

module.exports = { SafePostgresToolsApi };
