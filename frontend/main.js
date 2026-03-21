const { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;
const mcpManager = require('./mcp-manager');
const toolServer = require('./tool-server');
const dbHealth = require('./db-health');
const { createLogger } = require('./logger');
const log = createLogger('Main');

// Set app name for macOS Dock, Cmd+Tab, and window title
app.name = 'ProgreSQL';

// Set Dock icon explicitly on macOS (ensures correct icon in dev mode)
if (process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(path.join(__dirname, 'public/assets/icon.png'));
}

let mainWindow;

// Configure db-health with MCP and tool server refs
dbHealth.configure({ mcpManager, toolServer });
// Give tool-server a reference to db-health for auto-reconnect on stale connections
toolServer.setDbHealth(dbHealth);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Allow preload.js to require local modules (./logger, etc.)
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'ProgreSQL',
    icon: path.join(__dirname, 'public/assets/icon.png'),
    show: false
  });

  // Hide default Electron menu in production
  if (!isDev) {
    if (process.platform === 'darwin') {
      // macOS needs a minimal menu to keep system shortcuts (Cmd+Q, Cmd+C/V/X, etc.)
      const template = [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' }
          ]
        }
      ];
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } else {
      // Windows/Linux: remove menu bar entirely
      Menu.setApplicationMenu(null);
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Send app-ready event to renderer once the page has finished loading
  // This signals that all IPC handlers are registered and electronAPI is available
  mainWindow.webContents.on('did-finish-load', () => {
    log.debug('Page finished loading, sending app-ready event');
    mainWindow.webContents.send('app-ready');
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:8888');
    mainWindow.webContents.openDevTools();
  } else {
    // Nextron builds renderer output to 'app/' directory inside the asar
    mainWindow.loadFile(path.join(__dirname, 'app/index.html'));
  }

  // In production, intercept navigation to load correct HTML files
  // Next.js static export creates separate .html files for each route
  if (!isDev) {
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://')) {
        const urlPath = new URL(url).pathname;
        const appDir = path.join(__dirname, 'app');
        // Extract route name from URL path
        const segments = urlPath.split('/').filter(Boolean);
        const route = segments[segments.length - 1] || 'index';
        const htmlFile = path.join(appDir, `${route}.html`);
        const fs = require('fs');
        if (fs.existsSync(htmlFile)) {
          event.preventDefault();
          mainWindow.loadFile(htmlFile);
        }
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Set Content-Security-Policy to suppress Electron security warning
  const { session } = require('electron');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev
            ? "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-eval' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' http://localhost:* ws://localhost:* wss://localhost:* https://api.openai.com https://openrouter.ai https://*.openrouter.ai;"
            : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: file:; connect-src 'self' https://progresql.com https://*.progresql.com ws://localhost:* wss://localhost:* wss://progresql.com https://api.openai.com https://openrouter.ai https://*.openrouter.ai;"
        ]
      }
    });
  });

  createWindow();
});

app.on('window-all-closed', async () => {
  // Stop tool server and MCP server before quitting
  await toolServer.stopToolServer();
  await mcpManager.stopMcpServer();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  dbHealth.shutdown();
  // Ensure servers are stopped
  await toolServer.stopToolServer();
  await mcpManager.stopMcpServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for database operations
ipcMain.handle('connect-database', async (event, connectionConfig) => {
  log.debug('connect-database called', {
    host: connectionConfig.host,
    port: connectionConfig.port,
    username: connectionConfig.username,
    password: connectionConfig.password ? '[HIDDEN]' : 'undefined',
    database: connectionConfig.database,
    connectionName: connectionConfig.connectionName
  });

  try {
    const { Client } = require('pg');
    log.debug('Creating PostgreSQL client', {
      host: connectionConfig.host,
      port: connectionConfig.port,
      user: connectionConfig.username,
      password: connectionConfig.password ? '[HIDDEN]' : 'undefined',
      database: connectionConfig.database
    });

    // Close previous client if exists (prevent stale event listeners from nullifying global.dbClient)
    if (global.dbClient) {
      log.debug('Closing previous database connection before creating new one');
      try {
        global.dbClient.removeAllListeners();
        await global.dbClient.end();
      } catch (closeErr) {
        log.warn('Error closing previous connection (non-fatal):', closeErr.message);
      }
      global.dbClient = null;
    }

    // Guard against empty password (causes SCRAM error)
    if (!connectionConfig.password) {
      return { success: false, message: 'Password is required. Please update your connection settings.' };
    }

    const client = new Client({
      host: connectionConfig.host,
      port: connectionConfig.port,
      user: connectionConfig.username,
      password: connectionConfig.password,
      database: connectionConfig.database,
      // Add connection timeout and keep-alive settings
      connectionTimeoutMillis: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    });

    // Add error handlers — only clear global.dbClient if THIS client is still the active one
    client.on('error', (err) => {
      log.error('Connection error:', err);
      if (global.dbClient === client) {
        global.dbClient = null;
      }
    });

    client.on('end', () => {
      log.debug('Connection ended');
      if (global.dbClient === client) {
        global.dbClient = null;
      }
    });

    log.debug('Connecting to database...');
    await client.connect();
    log.debug('Connection successful');

    // Store client reference
    global.dbClient = client;

    // Stop existing MCP server if running (for connection switching)
    log.debug('Stopping existing MCP server (if any) before reinitializing...');
    try {
      await mcpManager.stopMcpServer();
    } catch (stopError) {
      log.warn('Error stopping existing MCP server (may not exist):', stopError.message);
    }

    // Initialize MCP server with NEW connection config
    // Это перезапустит MCP сервер с новыми параметрами подключения
    log.debug('Initializing MCP server with connection config:', {
      host: connectionConfig.host,
      port: connectionConfig.port,
      database: connectionConfig.database,
      username: connectionConfig.username,
    });
    try {
      const mcpResult = await mcpManager.initializeMcpServer(connectionConfig);
      if (mcpResult.success) {
        log.debug('MCP server initialized successfully with new connection');
      } else {
        log.warn('MCP server initialization failed:', mcpResult.message);
        // Continue without MCP - fallback to direct queries
      }
    } catch (mcpError) {
      log.error('MCP server initialization error:', mcpError);
      // Continue without MCP - fallback to direct queries
    }

    // Start tool server for Go backend communication
    try {
      const tsResult = await toolServer.startToolServer();
      if (tsResult.success) {
        log.debug(`Tool server started on port ${tsResult.port}`);
      }
    } catch (tsError) {
      log.error('Tool server start error:', tsError.message);
      // Continue without tool server — not a fatal error
    }

    // Start periodic health check for auto-reconnect
    dbHealth.onConnected(connectionConfig, mainWindow);

    return { success: true, message: 'Connected successfully' };
  } catch (error) {
    log.error('Connection error:', error);
    log.error('Error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack
    });

    // Provide more detailed error messages
    let errorMessage = error.message;
    if (error.code === 'ECONNREFUSED') {
      errorMessage = `Connection refused. Check if PostgreSQL is running on ${connectionConfig.host}:${connectionConfig.port}`;
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = `Connection timeout. Check if host ${connectionConfig.host} is reachable`;
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = `Host not found: ${connectionConfig.host}`;
    } else if (error.code === '28P01') {
      errorMessage = 'Authentication failed. Check username and password';
    } else if (error.code === '3D000') {
      errorMessage = `Database "${connectionConfig.database}" does not exist`;
    }

    return { success: false, message: errorMessage };
  }
});

ipcMain.handle('execute-query', async (event, params) => {
  try {
    // Support both old format (string) and new format ({ connectionId, query })
    const queryText = typeof params === 'string' ? params : params.query;
    if (!queryText) {
      throw new Error('No query text provided');
    }

    if (!global.dbClient) {
      throw new Error('No database connection');
    }

    // Check if connection is still alive, try reconnect if stale
    try {
      await global.dbClient.query('SELECT 1');
    } catch (connError) {
      log.warn('Connection check failed in execute-query, attempting reconnect:', connError.message);
      global.dbClient = null;
      const reconnected = await dbHealth.tryImmediateReconnect();
      if (!reconnected) {
        throw new Error('Database connection lost. Auto-reconnect in progress...');
      }
      log.debug('Reconnected successfully, proceeding with query');
    }

    const result = await global.dbClient.query(queryText);
    return {
      success: true,
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields.map(field => ({
        name: field.name,
        dataType: field.dataTypeID,
        dataTypeName: field.dataType
      }))
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// NOTE: get-database-structure handler is in main/background.js (single source of truth)
// [removed duplicate handler]


ipcMain.handle('disconnect-database', async (event) => {
  try {
    // Stop auto-reconnect and health check (user-initiated disconnect)
    dbHealth.onDisconnected();

    // Stop tool server
    await toolServer.stopToolServer();

    // Stop MCP server
    await mcpManager.stopMcpServer();

    if (global.dbClient) {
      await global.dbClient.end();
      global.dbClient = null;
    }
    return { success: true, message: 'Disconnected successfully' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// MCP-related IPC handlers
ipcMain.handle('mcp-get-schemas', async (event) => {
  try {
    const safeApi = mcpManager.getSafeApi();
    if (!safeApi) {
      throw new Error('MCP server not available');
    }
    const schemas = await safeApi.getSchemas();
    return { success: true, schemas };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('mcp-get-tables', async (event, schema) => {
  try {
    const safeApi = mcpManager.getSafeApi();
    if (!safeApi) {
      throw new Error('MCP server not available');
    }
    const tables = await safeApi.getTables(schema || 'public');
    return { success: true, tables };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('mcp-describe-table', async (event, schema, table) => {
  try {
    const safeApi = mcpManager.getSafeApi();
    if (!safeApi) {
      throw new Error('MCP server not available');
    }
    const description = await safeApi.describeTable(schema || 'public', table);
    return { success: true, description };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('mcp-get-indexes', async (event, schema, table) => {
  try {
    const safeApi = mcpManager.getSafeApi();
    if (!safeApi) {
      throw new Error('MCP server not available');
    }
    const indexes = await safeApi.getIndexes(schema || 'public', table);
    return { success: true, indexes };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('mcp-get-constraints', async (event, schema, table) => {
  try {
    const safeApi = mcpManager.getSafeApi();
    if (!safeApi) {
      throw new Error('MCP server not available');
    }
    const constraints = await safeApi.getConstraints(schema || 'public', table);
    return { success: true, constraints };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// Distributed tool calling handler
ipcMain.handle('execute-tool-request', async (event, toolRequest) => {
  const startTime = Date.now();
  // ToolRequest и ToolResult - это просто интерфейсы, не нужны для выполнения

  try {
    const safeApi = mcpManager.getSafeApi();

    // Validate tool request
    if (!toolRequest.requestId || !toolRequest.toolName) {
      throw new Error('Invalid tool request: missing requestId or toolName');
    }

    // Call tool through safe API (which enforces allowlist)
    // Use the appropriate method based on tool name
    let result;
    const toolName = toolRequest.toolName;
    const args = toolRequest.arguments || {};

    // Route to appropriate handler — prefer direct SQL (global.dbClient) for reliability,
    // fall back to MCP safeApi only when needed. MCP may not support all tools.
    if (toolName === 'list_schemas') {
      if (global.dbClient) {
        const r = await global.dbClient.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_toast','pg_catalog','information_schema') ORDER BY schema_name");
        result = r.rows.map(row => row.schema_name);
      } else if (safeApi) {
        result = await safeApi.getSchemas();
      } else {
        throw new Error('No database connection');
      }
    } else if (toolName === 'list_tables') {
      const schema = args.schema || 'public';
      if (global.dbClient) {
        const r = await global.dbClient.query(
          "SELECT table_name as name, table_type as type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
          [schema]
        );
        result = r.rows.map(row => ({ name: row.name, type: row.type === 'BASE TABLE' ? 'TABLE' : row.type }));
      } else if (safeApi) {
        result = await safeApi.getTables(schema);
      } else {
        throw new Error('No database connection');
      }
    } else if (toolName === 'table_columns') {
      const schema = args.schema || 'public';
      if (global.dbClient) {
        const r = await global.dbClient.query(
          "SELECT column_name as name, data_type as type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
          [schema, args.table]
        );
        result = r.rows.map(row => ({ name: row.name, type: row.type, nullable: row.is_nullable === 'YES', default: row.column_default }));
      } else if (safeApi) {
        result = await safeApi.getColumns(schema, args.table);
      } else {
        throw new Error('No database connection');
      }
    } else if (toolName === 'describe_table') {
      if (global.dbClient) {
        const schema = args.schema || 'public';
        const table = args.table;
        // Columns
        const colRes = await global.dbClient.query(
          "SELECT column_name as name, data_type as type, is_nullable, column_default as default_value FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
          [schema, table]
        );
        const columns = colRes.rows.map(row => ({ name: row.name, type: row.type, nullable: row.is_nullable === 'YES', default: row.default_value }));
        // Indexes
        const idxRes = await global.dbClient.query(
          "SELECT indexname as name, indexdef as definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname",
          [schema, table]
        );
        const indexes = idxRes.rows.map(row => {
          const match = row.definition ? row.definition.match(/\(([^)]+)\)/) : null;
          const cols = match ? match[1].split(',').map(s => s.trim().split(' ')[0]) : [];
          return { name: row.name, columns: cols, unique: row.definition ? row.definition.includes('UNIQUE') : false };
        });
        // Foreign keys
        const fkRes = await global.dbClient.query(
          `SELECT tc.constraint_name as name, kcu.column_name, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
           WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
          [schema, table]
        );
        const fkMap = {};
        for (const fkRow of fkRes.rows) {
          if (!fkMap[fkRow.name]) fkMap[fkRow.name] = { name: fkRow.name, columns: [], referenced_table: fkRow.referenced_table, referenced_columns: [] };
          fkMap[fkRow.name].columns.push(fkRow.column_name);
          fkMap[fkRow.name].referenced_columns.push(fkRow.referenced_column);
        }
        const foreign_keys = Object.values(fkMap);
        result = { columns, indexes, foreign_keys };
      } else if (safeApi) {
        result = await safeApi.describeTable(args.schema || 'public', args.table);
      } else {
        throw new Error('No database connection');
      }
    } else if (toolName === 'explain_query' || toolName === 'explain') {
      if (global.dbClient) {
        const sql = args.query || args.sql;
        const r = await global.dbClient.query(`EXPLAIN (FORMAT JSON) ${sql}`);
        result = r.rows;
      } else if (safeApi) {
        result = await safeApi.explainQuery(args.query || args.sql, args.format || 'json');
      } else {
        throw new Error('No database connection');
      }
    } else if (toolName === 'execute_query') {
      if (global.dbClient) {
        const sql = args.sql || args.query;
        const limit = args.limit || 100;
        const limitedSql = sql.toLowerCase().includes('limit') ? sql : `${sql} LIMIT ${limit}`;
        const r = await global.dbClient.query(limitedSql);
        result = { rows: r.rows, columns: r.fields ? r.fields.map(f => f.name) : [] };
      } else {
        throw new Error('No database connection');
      }
    } else if (toolName === 'list_indexes') {
      // Get indexes directly from database (MCP server doesn't provide this)
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const table = args.table;
      const query = table
        ? `SELECT indexname as name, indexdef as definition, indexname as index_name FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`
        : `SELECT indexname as name, tablename as table_name, indexdef as definition, indexname as index_name FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname`;
      const params = table ? [schema, table] : [schema];
      const indexResult = await global.dbClient.query(query, params);
      result = indexResult.rows.map(row => ({
        name: row.name || row.index_name,
        table: row.table_name || table,
        definition: row.definition,
        schema: schema,
      }));
    } else if (toolName === 'list_constraints') {
      // Get constraints directly from database (MCP server doesn't provide this)
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const table = args.table;
      const query = table
        ? `SELECT conname as name, contype as type, a.attname as column_name FROM pg_constraint co JOIN pg_class c ON co.conrelid = c.oid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(co.conkey) JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = $1 AND c.relname = $2 ORDER BY conname`
        : `SELECT conname as name, c.relname as table_name, contype as type, a.attname as column_name FROM pg_constraint co JOIN pg_class c ON co.conrelid = c.oid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(co.conkey) JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = $1 ORDER BY c.relname, conname`;
      const params = table ? [schema, table] : [schema];
      const constraintResult = await global.dbClient.query(query, params);
      result = constraintResult.rows.map(row => ({
        name: row.name,
        type: row.type === 'p' ? 'PRIMARY KEY' : row.type === 'f' ? 'FOREIGN KEY' : row.type === 'u' ? 'UNIQUE' : row.type === 'c' ? 'CHECK' : row.type,
        columns: [row.column_name],
        table: row.table_name || table,
        schema: schema,
      }));
    } else if (toolName === 'list_views') {
      // Get views directly from database (MCP server doesn't provide this)
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT table_name as name FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name`;
      const viewResult = await global.dbClient.query(query, [schema]);
      result = viewResult.rows.map(row => ({
        name: row.name,
        schema: schema,
      }));
    } else if (toolName === 'list_functions') {
      // Get functions directly from database (MCP server doesn't provide this)
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT p.proname as name, pg_get_function_result(p.oid) as return_type, pg_get_function_arguments(p.oid) as arguments FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = $1 ORDER BY p.proname`;
      const functionResult = await global.dbClient.query(query, [schema]);
      result = functionResult.rows.map(row => ({
        name: row.name,
        return_type: row.return_type,
        arguments: row.arguments,
        schema: schema,
      }));
    } else if (toolName === 'list_sequences') {
      // Get sequences directly from database (MCP server doesn't provide this)
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT sequence_name as name FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name`;
      const sequenceResult = await global.dbClient.query(query, [schema]);
      result = sequenceResult.rows.map(row => ({
        name: row.name,
        schema: schema,
      }));
    } else if (toolName === 'list_extensions') {
      // Get extensions directly from database
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const query = `SELECT extname as name, extversion as version, extnamespace::regnamespace::text as schema FROM pg_extension ORDER BY extname`;
      const extensionResult = await global.dbClient.query(query);
      result = extensionResult.rows.map(row => ({
        name: row.name,
        version: row.version,
        schema: row.schema,
      }));
    } else if (toolName === 'list_types' || toolName === 'list_enums') {
      // Get types/enums directly from database
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      // Include all types including those starting with _ (like _order_status)
      // Also include array types (typtype = 'b' with typname starting with _)
      const query = `SELECT
        t.typname as name,
        n.nspname as schema,
        CASE
          WHEN t.typtype = 'e' THEN (
            SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
            FROM pg_enum e
            WHERE e.enumtypid = t.oid
          )
          ELSE NULL
        END as enum_values,
        CASE
          WHEN t.typtype = 'e' THEN 'enum'
          WHEN t.typtype = 'd' THEN 'domain'
          WHEN t.typtype = 'c' THEN 'composite'
          WHEN t.typtype = 'b' AND t.typname LIKE '\\_%' THEN 'array'
          ELSE 'base'
        END as type_category
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = $1
        AND (
          t.typtype IN ('e', 'd', 'c')
          OR (t.typtype = 'b' AND t.typname LIKE '\\_%' AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_type t2
            WHERE t2.typname = SUBSTRING(t.typname FROM 2)
              AND t2.typnamespace = t.typnamespace
              AND t2.typtype IN ('e', 'd', 'c')
          ))
        )
      ORDER BY t.typname`;
      const typeResult = await global.dbClient.query(query, [schema]);
      result = typeResult.rows.map(row => ({
        name: row.name,
        schema: row.schema,
        enum_values: row.enum_values,
        type: row.type_category || (row.enum_values ? 'enum' : 'composite'),
      }));
    } else if (toolName === 'list_triggers') {
      // Get triggers directly from database
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const table = args.table;
      const query = table
        ? `SELECT tgname as name, c.relname as table_name, pg_get_triggerdef(t.oid) as definition, CASE WHEN t.tgtype & 66 = 2 THEN 'BEFORE' WHEN t.tgtype & 66 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END as timing FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 ORDER BY tgname`
        : `SELECT tgname as name, c.relname as table_name, pg_get_triggerdef(t.oid) as definition, CASE WHEN t.tgtype & 66 = 2 THEN 'BEFORE' WHEN t.tgtype & 66 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END as timing FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE NOT t.tgisinternal AND n.nspname = $1 ORDER BY c.relname, tgname`;
      const params = table ? [schema, table] : [schema];
      const triggerResult = await global.dbClient.query(query, params);
      result = triggerResult.rows.map(row => ({
        name: row.name,
        table: row.table_name || table,
        definition: row.definition,
        timing: row.timing,
        schema: schema,
      }));
    } else if (toolName === 'list_procedures') {
      // Get procedures directly from database
      if (!global.dbClient) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT p.proname as name, pg_get_functiondef(p.oid) as definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = $1 AND p.prokind = 'p' ORDER BY p.proname`;
      const procedureResult = await global.dbClient.query(query, [schema]);
      result = procedureResult.rows.map(row => ({
        name: row.name,
        definition: row.definition,
        schema: schema,
      }));
    } else if (toolName === 'explain_analyze') {
      if (safeApi) {
        result = await safeApi.callToolSafe(toolName, args);
        result = safeApi.extractResult(result);
      } else if (global.dbClient) {
        const sql = args.query || args.sql;
        const r = await global.dbClient.query(`EXPLAIN ANALYZE ${sql}`);
        result = r.rows;
      } else {
        throw new Error('No database connection');
      }
    } else {
      // For other tools, try safe API first, then fall back to error
      if (safeApi) {
        result = await safeApi.callToolSafe(toolName, args);
        result = safeApi.extractResult(result);
      } else {
        throw new Error(`Tool "${toolName}" requires MCP server or is not supported`);
      }
    }

    const executionTime = Date.now() - startTime;

    const toolResult = {
      requestId: toolRequest.requestId,
      ok: true,
      result: result,
      meta: {
        executionTime,
        timestamp: new Date().toISOString(),
      },
    };

    return toolResult;
  } catch (error) {
    const executionTime = Date.now() - startTime;

    const toolResult = {
      requestId: toolRequest.requestId || 'unknown',
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_ERROR',
        message: error.message,
        details: error.stack,
      },
      meta: {
        executionTime,
        timestamp: new Date().toISOString(),
      },
    };

    return toolResult;
  }
});

ipcMain.handle('mcp-is-available', async (event) => {
  const available = mcpManager.isMcpServerRunning();
  const hasApi = mcpManager.getSafeApi() !== null;
  log.debug('mcp-is-available check:', { available, hasApi });
  return {
    available,
    hasApi,
  };
});

ipcMain.handle('mcp-list-tools', async (event) => {
  try {
    const { getMcpClient } = require('./mcp-manager');
    const client = getMcpClient();

    // Получаем базовые инструменты из MCP сервера
    const mcpTools = client ? (client.getTools() || []) : [];

    // Добавляем дополнительные инструменты, реализованные напрямую
    const additionalTools = [
      {
        name: 'list_indexes',
        description: 'List indexes for a schema or table',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
            table: { type: 'string' },
          },
        },
      },
      {
        name: 'list_constraints',
        description: 'List constraints for a schema or table',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
            table: { type: 'string' },
          },
        },
      },
      {
        name: 'list_views',
        description: 'List views for a schema',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
          },
        },
      },
      {
        name: 'list_functions',
        description: 'List functions for a schema',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
          },
        },
      },
      {
        name: 'list_sequences',
        description: 'List sequences for a schema',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
          },
        },
      },
      {
        name: 'list_extensions',
        description: 'List PostgreSQL extensions',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_types',
        description: 'List user-defined types (including enums) for a schema',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
          },
        },
      },
      {
        name: 'list_enums',
        description: 'List enum types for a schema',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
          },
        },
      },
      {
        name: 'list_triggers',
        description: 'List triggers for a schema or table',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
            table: { type: 'string' },
          },
        },
      },
      {
        name: 'list_procedures',
        description: 'List procedures for a schema',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
          },
        },
      },
    ];

    // Объединяем инструменты
    const allTools = [...mcpTools, ...additionalTools];
    log.debug('Total tools available:', allTools.length, '(MCP:', mcpTools.length, ', Additional:', additionalTools.length, ')');
    return { success: true, tools: allTools };
  } catch (error) {
    log.error('Error getting MCP tools:', error);
    return { success: false, message: error.message, tools: [] };
  }
});

ipcMain.handle('get-env', async (event, key) => {
  // Читаем из переменных окружения
  // В Electron можно использовать dotenv для .env.local
  let value = process.env[key] || '';

  // Если ключ не найден, пытаемся прочитать из .env.local
  if (!value && key === 'OPENAI_API_KEY') {
    try {
      const fs = require('fs');
      const path = require('path');
      const envPath = path.join(__dirname, '.env.local');

      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const match = envContent.match(/OPENAI_API_KEY=(.+)/);
        if (match) {
          value = match[1].trim();
        }
      }
    } catch (error) {
      log.warn('Could not read .env.local:', error);
    }
  }

  return value;
});

// Password encryption via Electron safeStorage API
ipcMain.handle('encrypt-password', async (event, plaintext) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('safeStorage encryption not available, returning plaintext');
      return { encrypted: false, data: plaintext };
    }
    const encrypted = safeStorage.encryptString(plaintext);
    return { encrypted: true, data: encrypted.toString('base64') };
  } catch (error) {
    log.error('encrypt-password error:', error);
    return { encrypted: false, data: plaintext };
  }
});

ipcMain.handle('decrypt-password', async (event, encryptedBase64) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('safeStorage decryption not available, returning as-is');
      return encryptedBase64;
    }
    const buffer = Buffer.from(encryptedBase64, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (error) {
    log.error('decrypt-password error:', error);
    return encryptedBase64;
  }
});

ipcMain.handle('is-encryption-available', async () => {
  return safeStorage.isEncryptionAvailable();
});

// Open URL in external browser
ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
  }
});

// Get app version from package.json
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});
