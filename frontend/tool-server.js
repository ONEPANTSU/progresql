const { WebSocketServer } = require('ws');
const { createLogger } = require('./logger');
const log = createLogger('ToolServer');

let dbHealthRef = null;

/**
 * Set reference to db-health module for auto-reconnect on stale connections.
 * @param {object} dbHealth - The db-health module
 */
function setDbHealth(dbHealth) {
  dbHealthRef = dbHealth;
}

// Default port for the tool server
const DEFAULT_PORT = 9091;

let wss = null;
let activeConnections = new Set();

/**
 * Start the tool WebSocket server.
 * The Go backend connects here and sends tool.call messages.
 * Each tool.call is executed against the active PostgreSQL connection (global.dbClient).
 *
 * @param {number} [port] - Port to listen on (default 9091)
 * @returns {Promise<{success: boolean, port: number, message?: string}>}
 */
function startToolServer(port) {
  port = port || DEFAULT_PORT;

  return new Promise((resolve, reject) => {
    if (wss) {
      resolve({ success: true, port, message: 'Tool server already running' });
      return;
    }

    wss = new WebSocketServer({ port }, () => {
      log.debug(`WebSocket server listening on port ${port}`);
      resolve({ success: true, port });
    });

    wss.on('error', (err) => {
      log.error('Server error:', err.message);
      wss = null;
      reject(err);
    });

    wss.on('connection', (ws) => {
      log.debug('Go backend connected');
      activeConnections.add(ws);

      ws.on('message', async (data) => {
        try {
          const envelope = JSON.parse(data.toString());
          if (envelope.type === 'tool.call') {
            await handleToolCall(ws, envelope);
          } else {
            log.warn('Unknown message type:', envelope.type);
          }
        } catch (err) {
          log.error('Error processing message:', err.message);
        }
      });

      ws.on('close', () => {
        log.debug('Go backend disconnected');
        activeConnections.delete(ws);
      });

      ws.on('error', (err) => {
        log.error('Connection error:', err.message);
        activeConnections.delete(ws);
      });
    });
  });
}

/**
 * Stop the tool WebSocket server and close all connections.
 */
function stopToolServer() {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }

    // Close all active connections
    for (const ws of activeConnections) {
      try {
        ws.close(1000, 'server shutting down');
      } catch (_) { /* ignore */ }
    }
    activeConnections.clear();

    wss.close(() => {
      log.debug('Server stopped');
      wss = null;
      resolve();
    });
  });
}

/**
 * Check if the tool server is running.
 * @returns {boolean}
 */
function isToolServerRunning() {
  return wss !== null;
}

/**
 * Get the current port (or default).
 * @returns {number}
 */
function getToolServerPort() {
  if (wss && wss.address()) {
    return wss.address().port;
  }
  return DEFAULT_PORT;
}

// --- Tool call handler ---

async function handleToolCall(ws, envelope) {
  const callId = envelope.call_id;
  const requestId = envelope.request_id;
  let payload;

  try {
    payload = typeof envelope.payload === 'string'
      ? JSON.parse(envelope.payload)
      : envelope.payload;
  } catch (err) {
    sendToolResult(ws, callId, false, null, 'Invalid payload: ' + err.message);
    return;
  }

  const toolName = payload.tool_name;
  const args = payload.arguments || {};

  if (!global.dbClient) {
    // Try immediate reconnect if db-health module is available
    if (dbHealthRef) {
      log.warn('No database connection for tool.call, attempting reconnect');
      const reconnected = await dbHealthRef.tryImmediateReconnect();
      if (!reconnected) {
        sendToolResult(ws, callId, false, null, 'No database connection');
        return;
      }
      log.debug('Reconnected successfully, proceeding with tool.call');
    } else {
      sendToolResult(ws, callId, false, null, 'No database connection');
      return;
    }
  }

  // Check if connection is still alive
  try {
    await global.dbClient.query('SELECT 1');
  } catch (connError) {
    log.warn('Connection check failed in tool.call, attempting reconnect:', connError.message);
    global.dbClient = null;
    if (dbHealthRef) {
      const reconnected = await dbHealthRef.tryImmediateReconnect();
      if (!reconnected) {
        sendToolResult(ws, callId, false, null, 'Database connection lost. Auto-reconnect in progress...');
        return;
      }
      log.debug('Reconnected successfully, proceeding with tool.call');
    } else {
      sendToolResult(ws, callId, false, null, 'Database connection lost');
      return;
    }
  }

  try {
    let result;
    switch (toolName) {
      case 'list_schemas':
        result = await runListSchemas();
        break;
      case 'list_tables':
        result = await runListTables(args);
        break;
      case 'describe_table':
        result = await runDescribeTable(args);
        break;
      case 'list_indexes':
        result = await runListIndexes(args);
        break;
      case 'explain_query':
        result = await runExplainQuery(args);
        break;
      case 'execute_query':
        result = await runExecuteQuery(args);
        break;
      case 'list_functions':
        result = await runListFunctions(args);
        break;
      default:
        sendToolResult(ws, callId, false, null, `Unknown tool: ${toolName}`);
        return;
    }
    sendToolResult(ws, callId, true, result, null);
  } catch (err) {
    log.error(`Tool ${toolName} error:`, err.message);
    sendToolResult(ws, callId, false, null, err.message);
  }
}

function sendToolResult(ws, callId, success, data, error) {
  const payload = { success };
  if (success && data !== null) {
    payload.data = data;
  }
  if (!success && error) {
    payload.error = error;
  }

  const envelope = {
    type: 'tool.result',
    call_id: callId,
    payload: payload,
  };

  try {
    ws.send(JSON.stringify(envelope));
  } catch (err) {
    log.error('Failed to send tool.result:', err.message);
  }
}

// --- Tool implementations ---
// These mirror the Go client-minimal/tools.go implementations exactly,
// producing the same result format expected by the Go backend.

async function runListSchemas() {
  const result = await global.dbClient.query(`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    ORDER BY schema_name
  `);
  return { schemas: result.rows.map(r => r.schema_name) };
}

async function runListTables(args) {
  const schema = args.schema || 'public';
  const result = await global.dbClient.query(
    `SELECT table_name, table_type
     FROM information_schema.tables
     WHERE table_schema = $1
     ORDER BY table_name`,
    [schema]
  );
  return {
    tables: result.rows.map(r => ({
      name: r.table_name,
      type: r.table_type === 'VIEW' ? 'view' : 'table',
    })),
  };
}

async function runDescribeTable(args) {
  const schema = args.schema || 'public';
  const table = args.table;

  if (!table) {
    throw new Error('describe_table requires "table" argument');
  }

  // Columns
  const colResult = await global.dbClient.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table]
  );
  const columns = colResult.rows.map(r => {
    const col = {
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
    };
    if (r.column_default !== null) {
      col.default = r.column_default;
    }
    return col;
  });

  // Indexes
  const indexes = await queryIndexes(schema, table);

  // Foreign keys
  const fkResult = await global.dbClient.query(
    `SELECT
       tc.constraint_name,
       kcu.column_name,
       ccu.table_name AS referenced_table,
       ccu.column_name AS referenced_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
     ORDER BY tc.constraint_name, kcu.ordinal_position`,
    [schema, table]
  );

  const fkMap = new Map();
  const fkOrder = [];
  for (const row of fkResult.rows) {
    if (fkMap.has(row.constraint_name)) {
      const fk = fkMap.get(row.constraint_name);
      fk.columns.push(row.column_name);
      fk.referenced_columns.push(row.referenced_column);
    } else {
      fkMap.set(row.constraint_name, {
        name: row.constraint_name,
        columns: [row.column_name],
        referenced_table: row.referenced_table,
        referenced_columns: [row.referenced_column],
      });
      fkOrder.push(row.constraint_name);
    }
  }
  const foreign_keys = fkOrder.map(name => fkMap.get(name));

  return { columns, indexes, foreign_keys };
}

async function runListIndexes(args) {
  const schema = args.schema || 'public';
  const table = args.table;

  if (!table) {
    throw new Error('list_indexes requires "table" argument');
  }

  const indexes = await queryIndexes(schema, table);
  return { indexes };
}

/**
 * Shared index query — matches Go client-minimal queryIndexes exactly.
 */
async function queryIndexes(schema, table) {
  const result = await global.dbClient.query(
    `SELECT
       i.relname AS index_name,
       ix.indisunique AS is_unique,
       array_agg(a.attname ORDER BY x.ordinality) AS columns
     FROM pg_index ix
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality)
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
     WHERE n.nspname = $1 AND t.relname = $2
     GROUP BY i.relname, ix.indisunique
     ORDER BY i.relname`,
    [schema, table]
  );
  return result.rows.map(r => ({
    name: r.index_name,
    columns: r.columns || [],
    unique: r.is_unique,
  }));
}

async function runExplainQuery(args) {
  const sql = args.sql;
  if (!sql) {
    return { error: 'explain_query requires "sql" argument' };
  }

  try {
    const result = await global.dbClient.query('EXPLAIN ' + sql);
    const plan = result.rows.map(r => r['QUERY PLAN']).join('\n');
    return { plan };
  } catch (err) {
    return { error: err.message };
  }
}

async function runExecuteQuery(args) {
  const sql = args.sql;
  if (!sql) {
    return { error: 'execute_query requires "sql" argument' };
  }

  let limit = args.limit;
  if (!limit || limit <= 0 || limit > 1000) {
    limit = 100;
  }

  try {
    const trimmedSql = sql.replace(/[\s;]+$/, '');

    // Detect if the query is a SELECT/WITH (returns rows) or DDL/DML (no rows).
    // DDL (CREATE, ALTER, DROP) and DML (INSERT, UPDATE, DELETE) cannot be
    // wrapped in SELECT * FROM (...) — execute them directly.
    const upperSql = trimmedSql.trimStart().toUpperCase();
    const isSelect = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH');

    let result;
    if (isSelect) {
      // Wrap SELECT with LIMIT to prevent unbounded results
      const query = `SELECT * FROM (${trimmedSql}) AS _q LIMIT ${limit}`;
      result = await global.dbClient.query(query);
    } else {
      // DDL/DML: execute directly
      result = await global.dbClient.query(trimmedSql);
    }

    const columns = result.fields
      ? result.fields.map(f => f.name)
      : [];

    const rows = result.rows || [];

    return { rows, columns, rowCount: result.rowCount };
  } catch (err) {
    return { error: err.message };
  }
}

async function runListFunctions(args) {
  const schema = args.schema || 'public';

  const result = await global.dbClient.query(
    `SELECT
       p.proname AS name,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS return_type
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1
       AND p.prokind IN ('f', 'p')
     ORDER BY p.proname`,
    [schema]
  );

  return {
    functions: result.rows.map(r => ({
      name: r.name,
      args: r.args,
      return_type: r.return_type,
    })),
  };
}

module.exports = {
  startToolServer,
  stopToolServer,
  isToolServerRunning,
  getToolServerPort,
  setDbHealth,
  DEFAULT_PORT,
};
