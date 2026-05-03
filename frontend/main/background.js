const { app, BrowserWindow, ipcMain, Menu, protocol, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;
const mcpManager = require('../mcp-manager');
const toolServer = require('../tool-server');
const dbHealth = require('../db-health');
const { createLogger } = require('../logger');
const log = createLogger('Main');

// Set app name for macOS Dock, Cmd+Tab, and window title
app.name = 'ProgreSQL';

// Multi-connection support: Map<connectionId, pg.Client>
global.dbClients = new Map();

// Helper: get pg.Client for a given connectionId
function getClientForConnection(connectionId) {
  if (!connectionId) throw new Error('No connectionId provided');
  const client = global.dbClients.get(connectionId);
  if (!client) throw new Error(`No database connection for connectionId: ${connectionId}`);
  return client;
}

// Backward-compat: global.dbClient getter returns first available client (for MCP/tool-server)
Object.defineProperty(global, 'dbClient', {
  get() {
    if (global.dbClients.size === 0) return null;
    return global.dbClients.values().next().value;
  },
  set(val) {
    // no-op for backward compat — individual handlers manage dbClients map
  },
  configurable: true,
});

let mainWindow;

// ── Auto-updater (production only) ──
if (!isDev) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-available', info.version);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `ProgreSQL ${info.version} has been downloaded.`,
      detail: 'The update will be installed when you restart the application.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    log.error('Auto-update error:', err);
  });

  app.whenReady().then(() => {
    // Check for updates after a short delay
    setTimeout(() => autoUpdater.checkForUpdates(), 3000);
    // Check periodically (every 4 hours)
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
  });
}

// Configure db-health with MCP and tool server refs
dbHealth.configure({ mcpManager, toolServer });
// Give tool-server a reference to db-health for auto-reconnect on stale connections
toolServer.setDbHealth(dbHealth);

// Register custom protocol for static files in production
if (!isDev) {
  app.whenReady().then(() => {
    protocol.registerFileProtocol('app', (request, callback) => {
      const url = request.url.substr(6); // Remove 'app://' prefix
      const appPath = app.getAppPath();
      const filePath = path.join(appPath, url);
      callback({ path: filePath });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: isDev
        ? path.join(__dirname, '../preload.js')
        : path.join(app.getAppPath(), 'preload.js')
    },
    title: 'ProgreSQL',
    backgroundColor: '#0f1219',
    icon: isDev
      ? path.join(__dirname, '../public/assets/icon.png')
      : path.join(app.getAppPath(), 'public', 'assets', 'icon.png'),
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
    // In production, load from app directory
    const appPath = app.getAppPath();
    const htmlPath = path.join(appPath, 'app', 'index.html');
    log.debug('Loading HTML from:', htmlPath);
    log.debug('App path:', appPath);

    // Handle errors
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      log.error('Failed to load:', errorCode, errorDescription, validatedURL);
    });

    // Intercept requests to /_next/static/ and serve from app directory
    const fs = require('fs');
    mainWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      // Handle /_next/static/ requests - they come as relative paths from HTML
      if (url.includes('/_next/static/') || url.includes('_next')) {
        let filePath;

        if (url.startsWith('file://')) {
          // Extract path from file:// URL
          let urlPath = decodeURIComponent(url.replace('file://', '').split('?')[0]);
          // Remove leading slashes and normalize
          urlPath = urlPath.replace(/^\/+/, '');

          // If path contains app/, use it; otherwise assume it's relative to app
          if (urlPath.includes('app/')) {
            const relativePath = urlPath.split('app/')[1];
            filePath = path.join(appPath, 'app', relativePath);
          } else if (urlPath.startsWith('_next/')) {
            // Direct _next path
            filePath = path.join(appPath, 'app', urlPath);
          } else {
            // Try as relative to app directory
            filePath = path.join(appPath, 'app', urlPath);
          }
        } else {
          // Relative path from HTML file (starts with /)
          const relativePath = url.replace(/^\/+/, '');
          filePath = path.join(appPath, 'app', relativePath);
        }

        // Normalize path
        filePath = path.normalize(filePath);

        if (fs.existsSync(filePath)) {
          const normalizedUrl = `file://${filePath}`;
          log.debug('Redirecting:', url, '->', normalizedUrl);
          callback({ redirectURL: normalizedUrl });
          return;
        } else {
          log.warn('File not found:', filePath, 'for URL:', url);
        }
      }
      callback({});
    });

    mainWindow.loadFile(htmlPath).catch(err => {
      log.error('Error loading file:', err);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  // Close all database connections
  for (const [id, client] of global.dbClients) {
    try { await client.end(); } catch (_) { /* ignore */ }
  }
  global.dbClients.clear();
  dbHealth.shutdown();

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
  const connectionId = connectionConfig.connectionId;
  log.debug('connect-database called', { connectionId, host: connectionConfig.host, port: connectionConfig.port, database: connectionConfig.database, username: connectionConfig.username });

  try {
    const { Client } = require('pg');

    const client = new Client({
      host: connectionConfig.host,
      port: connectionConfig.port,
      user: connectionConfig.username,
      password: connectionConfig.password,
      database: connectionConfig.database,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    });

    // Add error handlers for connection issues
    client.on('error', (err) => {
      log.error(`Database connection error [${connectionId}]:`, err);
      global.dbClients.delete(connectionId);
    });

    client.on('end', () => {
      log.debug(`Database connection ended [${connectionId}]`);
      global.dbClients.delete(connectionId);
    });

    log.debug('Connecting to database...');
    await client.connect();
    log.debug('Connection successful');

    // Store client in multi-connection map
    global.dbClients.set(connectionId, client);

    // Initialize MCP server with this connection config (uses first/latest connection)
    // MCP is a singleton — re-initialize only if this is the first connection
    if (global.dbClients.size === 1) {
      log.debug('First connection — initializing MCP server');
      try {
        await mcpManager.stopMcpServer();
      } catch (stopError) {
        log.warn('Error stopping existing MCP server (may not exist):', stopError.message);
      }
      try {
        const mcpResult = await mcpManager.initializeMcpServer(connectionConfig);
        if (mcpResult.success) {
          log.debug('MCP server initialized successfully');
        } else {
          log.warn('MCP server initialization failed:', mcpResult.message);
        }
      } catch (mcpError) {
        log.error('MCP server initialization error:', mcpError);
      }

      // Start tool server for Go backend communication
      try {
        const tsResult = await toolServer.startToolServer();
        if (tsResult.success) {
          log.debug(`Tool server started on port ${tsResult.port}`);
        }
      } catch (tsError) {
        log.error('Tool server start error:', tsError.message);
      }
    }

    // Start periodic health check for this connection
    dbHealth.onConnected(connectionId, connectionConfig, mainWindow);

    return { success: true, message: 'Connected successfully' };
  } catch (error) {
    log.error('Connection error:', error);

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
  // Support both old format (string) and new format ({ connectionId, query })
  const connectionId = typeof params === 'string' ? null : params.connectionId;
  const query = typeof params === 'string' ? params : params.query;

  try {
    let client;
    if (connectionId && global.dbClients.has(connectionId)) {
      client = global.dbClients.get(connectionId);
    } else if (global.dbClients.size > 0) {
      // Fallback: use first available client
      client = global.dbClients.values().next().value;
    } else {
      throw new Error('No database connection');
    }

    // Check if connection is still alive
    try {
      await client.query('SELECT 1');
    } catch (connError) {
      log.warn(`Connection check failed [${connectionId}], attempting reconnect:`, connError.message);
      if (connectionId) global.dbClients.delete(connectionId);
      const reconnected = await dbHealth.tryImmediateReconnect(connectionId);
      if (!reconnected) {
        throw new Error('Database connection lost. Auto-reconnect in progress...');
      }
      // Get the reconnected client
      client = global.dbClients.get(connectionId) || global.dbClients.values().next().value;
      if (!client) throw new Error('Reconnect failed — no client available');
      log.debug('Reconnected successfully, proceeding with query');
    }

    const result = await client.query(query);
    return {
      success: true,
      rows: result.rows,
      rowCount: result.rowCount,
      fields: (result.fields || []).map(field => ({
        name: field.name,
        dataType: field.dataTypeID,
        dataTypeName: field.dataType
      }))
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-database-structure', async (event, connectionId, database) => {
  let tempClient = null;
  try {
    let client;
    if (connectionId && global.dbClients.has(connectionId)) {
      client = global.dbClients.get(connectionId);
    } else if (global.dbClients.size > 0) {
      client = global.dbClients.values().next().value;
    } else {
      throw new Error('No database connection');
    }

    // Check if connection is still alive
    try {
      await client.query('SELECT 1');
    } catch (connError) {
      log.warn(`Connection check failed in get-database-structure [${connectionId}]:`, connError.message);
      if (connectionId) global.dbClients.delete(connectionId);
      const reconnected = await dbHealth.tryImmediateReconnect(connectionId);
      if (!reconnected) {
        throw new Error('Database connection lost. Auto-reconnect in progress...');
      }
      client = connectionId ? global.dbClients.get(connectionId) : global.dbClients.values().next().value;
      if (!client) throw new Error('Reconnect failed — no client available');
      log.debug('Reconnected successfully, proceeding with getDatabaseStructure');
    }

    // If a specific database is requested, create a temporary client to that database
    if (database) {
      const currentDbResult = await client.query('SELECT current_database() as name');
      const currentDb = currentDbResult.rows[0].name;
      log.info(`getDatabaseStructure: requested="${database}", currentDb="${currentDb}", needTemp=${currentDb !== database}`);
      if (currentDb !== database) {
        const { Client: PgClient } = require('pg');
        // Get connection params directly from the existing pg.Client instance
        const tempHost = client.host || 'localhost';
        const tempPort = client.port || 5432;
        const tempUser = client.user || 'postgres';
        const tempPass = client.password || '';
        const tempSsl = client.connectionParameters ? client.connectionParameters.ssl : false;
        log.info(`getDatabaseStructure: creating tempClient to db="${database}" host=${tempHost}:${tempPort} user=${tempUser} ssl=${!!tempSsl}`);
        tempClient = new PgClient({
          host: tempHost,
          port: tempPort,
          user: tempUser,
          password: tempPass,
          database: database,
          ssl: tempSsl,
          connectionTimeoutMillis: 10000,
        });
        await tempClient.connect();
        const verifyResult = await tempClient.query('SELECT current_database() as name');
        const verifiedDb = verifyResult.rows[0].name;
        log.info(`getDatabaseStructure: tempClient connected, verified db="${verifiedDb}"`);
        if (verifiedDb !== database) {
          log.error(`getDatabaseStructure: MISMATCH! requested="${database}" but connected to "${verifiedDb}"`);
          throw new Error(`Failed to connect to database "${database}": connected to "${verifiedDb}" instead`);
        }
        client = tempClient;
      }
    }

    log.debug('Getting database structure...');

    // Get current database name
    const dbNameResult = await client.query('SELECT current_database() as name');
    const currentDb = dbNameResult.rows[0].name;

    // Get schemas
    let schemasResult;
    try {
      schemasResult = await client.query(`
        SELECT nspname as schema_name, nspowner::regrole::text as schema_owner
        FROM pg_namespace
        WHERE nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY nspname
      `);
    } catch (error) {
      schemasResult = { rows: [{ schema_name: 'public', schema_owner: 'postgres' }] };
    }

    // Get tables
    let tablesResult;
    try {
      tablesResult = await client.query(`
        SELECT
          tablename as table_name,
          'BASE TABLE' as table_type,
          schemaname as table_schema,
          'postgres' as table_catalog
        FROM pg_tables
        WHERE schemaname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY schemaname, tablename
      `);
    } catch (error) {
      tablesResult = { rows: [] };
    }

    // Get views
    let viewsResult;
    try {
      viewsResult = await client.query(`
        SELECT
          viewname as view_name,
          definition as view_definition,
          schemaname as view_schema,
          'postgres' as view_catalog,
          false as is_updatable,
          false as is_insertable_into,
          false as is_trigger_insertable_into
        FROM pg_views
        WHERE schemaname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY schemaname, viewname
      `);
    } catch (error) {
      viewsResult = { rows: [] };
    }

    // Get columns
    let columnsResult;
    try {
      columnsResult = await client.query(`
        SELECT
          c.relname as table_name,
          n.nspname as table_schema,
          a.attname as column_name,
          pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
          a.attnotnull = false as is_nullable,
          pg_get_expr(d.adbin, d.adrelid) as column_default,
          a.attnum as ordinal_position,
          CASE
            WHEN a.atttypid = 'pg_catalog.name'::pg_catalog.regtype THEN 1
            ELSE 0
          END as character_maximum_length,
          CASE
            WHEN a.atttypid = 'pg_catalog.numeric'::pg_catalog.regtype THEN a.atttypmod - 4
            ELSE NULL
          END as numeric_precision,
          CASE
            WHEN a.atttypid = 'pg_catalog.numeric'::pg_catalog.regtype THEN a.atttypmod & 65535
            ELSE NULL
          END as numeric_scale,
          NULL as datetime_precision,
          pg_catalog.format_type(a.atttypid, a.atttypmod) as udt_name,
          a.attidentity != '' as is_identity,
          a.attidentity as identity_generation
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
        JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
        LEFT JOIN pg_catalog.pg_attrdef d ON (d.adrelid = a.attrelid AND d.adnum = a.attnum)
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND c.relkind IN ('r', 'v')
          AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY c.relname, a.attnum
      `);
    } catch (error) {
      columnsResult = { rows: [] };
    }

    // Get indexes
    // Indexes: join pg_index for the primary/unique flags and the ordered
    // column list. We need these because the schema-sync table generator
    // filters primary-key indexes out of DROP INDEX / CREATE INDEX emission
    // (they live as constraints instead), and needs is_unique for the
    // CREATE INDEX vs CREATE UNIQUE INDEX branch.
    let indexesResult;
    try {
      indexesResult = await client.query(`
        SELECT
          ic.relname AS index_name,
          t.relname AS table_name,
          n.nspname AS table_schema,
          pg_get_indexdef(i.indexrelid) AS index_definition,
          am.amname AS index_type,
          i.indisunique AS is_unique,
          i.indisprimary AS is_primary,
          false AS is_clustered,
          (
            SELECT array_agg(a.attname ORDER BY k.ord)
            FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          ) AS columns
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_am am ON am.oid = ic.relam
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY n.nspname, t.relname, ic.relname
      `);
    } catch (error) {
      indexesResult = { rows: [] };
    }

    // Get constraints with proper type mapping and FK references
    let constraintsResult;
    try {
      constraintsResult = await client.query(`
        SELECT
          co.conname as constraint_name,
          c.relname as table_name,
          n.nspname as table_schema,
          CASE co.contype
            WHEN 'p' THEN 'PRIMARY KEY'
            WHEN 'f' THEN 'FOREIGN KEY'
            WHEN 'u' THEN 'UNIQUE'
            WHEN 'c' THEN 'CHECK'
            WHEN 'x' THEN 'EXCLUDE'
            ELSE co.contype
          END as constraint_type,
          a.attname as column_name,
          ref_c.relname as referenced_table,
          ref_a.attname as referenced_column
        FROM pg_constraint co
        JOIN pg_class c ON co.conrelid = c.oid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(co.conkey)
        JOIN pg_namespace n ON c.relnamespace = n.oid
        LEFT JOIN pg_class ref_c ON co.confrelid = ref_c.oid
        LEFT JOIN pg_attribute ref_a ON ref_a.attrelid = co.confrelid AND ref_a.attnum = ANY(co.confkey)
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY c.relname, co.conname
      `);
    } catch (error) {
      constraintsResult = { rows: [] };
    }

    // Get triggers
    // Triggers: use information_schema.triggers because it already exposes
    // the canonical event_manipulation / action_orientation / action_timing
    // fields that schema-sync's trigger differ expects. We also keep
    // table_name / table_schema as aliases for the older callers in the
    // renderer that still use those names.
    let triggersResult;
    try {
      triggersResult = await client.query(`
        SELECT
          trigger_name,
          event_manipulation,
          event_object_schema,
          event_object_table,
          event_object_schema as table_schema,
          event_object_table as table_name,
          action_statement,
          action_timing,
          action_orientation,
          action_condition,
          action_order
        FROM information_schema.triggers
        WHERE event_object_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY event_object_schema, event_object_table, trigger_name, event_manipulation
      `);
    } catch (error) {
      triggersResult = { rows: [] };
    }

    // Get functions
    let functionsResult;
    try {
      functionsResult = await client.query(`
        SELECT
          p.proname as routine_name,
          'FUNCTION' as routine_type,
          pg_catalog.format_type(p.prorettype, NULL) as data_type,
          n.nspname as routine_schema,
          'postgres' as routine_catalog,
          pg_get_functiondef(p.oid) as routine_definition
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY n.nspname, p.proname
      `);
    } catch (error) {
      functionsResult = { rows: [] };
    }

    // Get procedures
    let proceduresResult;
    try {
      proceduresResult = await client.query(`
        SELECT
          p.proname as routine_name,
          n.nspname as routine_schema,
          'postgres' as routine_catalog,
          pg_get_functiondef(p.oid) as procedure_definition
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
          AND p.prokind = 'p'
        ORDER BY n.nspname, p.proname
      `);
    } catch (error) {
      proceduresResult = { rows: [] };
    }

    // Get sequences
    let sequencesResult;
    try {
      sequencesResult = await client.query(`
        SELECT
          c.relname as sequence_name,
          n.nspname as sequence_schema,
          'postgres' as sequence_catalog,
          pg_catalog.format_type(s.seqtypid, NULL) as data_type,
          s.seqstart as start_value,
          s.seqmin as minimum_value,
          s.seqmax as maximum_value,
          s.seqincrement as increment,
          s.seqcycle as cycle_option,
          s.seqcache as cache_size,
          NULL as last_value
        FROM pg_sequence s
        JOIN pg_class c ON s.seqrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY n.nspname, c.relname
      `);
    } catch (error) {
      sequencesResult = { rows: [] };
    }

    // Get extensions
    let extensionsResult;
    try {
      extensionsResult = await client.query(`
        SELECT
          extname as name,
          extversion as version,
          extnamespace::regnamespace::text as schema
        FROM pg_extension
        ORDER BY extname
      `);
    } catch (error) {
      extensionsResult = { rows: [] };
    }

    // Get types.
    //
    // We surface user-defined domains (d), enums (e), composites (c) and
    // ranges (r) — the four kinds the Explorer sidebar renders with
    // distinct colour badges. Filters:
    //
    //   - typcategory <> 'A'    — skip the implicit _foo array row that
    //                             Postgres creates alongside every type.
    //   - NOT EXISTS(pg_class…) — skip composite rowtypes that exist only
    //                             because a real table / view backs them;
    //                             we only want standalone `CREATE TYPE …
    //                             AS (…)` composites here.
    //
    // Fields surfaced for each type:
    //   - enum_values  (text[]) — populated for enums, used by the sidebar
    //                             tooltip and by schema-sync's enum differ
    //   - base_type    (text)   — populated for domains (`format_type` on
    //                             the underlying type), used for "over X"
    //   - element_type (text)   — populated for ranges, shown as "of X"
    let typesResult;
    try {
      typesResult = await client.query(`
        SELECT
          t.typname as name,
          n.nspname as schema,
          r.rolname as owner,
          t.typcategory as type_category,
          t.typtype as type_type,
          CASE
            WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, NULL)
            ELSE NULL
          END as base_type,
          CASE
            WHEN t.typtype = 'r' THEN (
              SELECT pg_catalog.format_type(rngsubtype, NULL)
              FROM pg_catalog.pg_range
              WHERE rngtypid = t.oid
            )
            ELSE NULL
          END as element_type,
          CASE
            WHEN t.typtype = 'e' THEN (
              SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
              FROM pg_enum e
              WHERE e.enumtypid = t.oid
            )
            ELSE NULL
          END as enum_values
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid
        JOIN pg_catalog.pg_roles r ON t.typowner = r.oid
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
          AND t.typtype IN ('d', 'e', 'c', 'r')
          AND t.typcategory <> 'A'
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class c
            WHERE c.reltype = t.oid
              AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'i', 'S')
          )
        ORDER BY n.nspname, t.typname
      `);
    } catch (error) {
      typesResult = { rows: [] };
    }

    // Normalise type rows so the renderer always sees `enum_values` as a
    // real JS array. node-postgres usually parses `text[]` array_agg results
    // for us, but because the SELECT wraps it in a CASE expression Postgres
    // loses the column type annotation and the driver sometimes returns the
    // raw text literal "{a,b,c}" instead. Fix that here in one place so
    // both the sidebar and schema-sync's enum differ don't have to guard.
    typesResult = {
      ...typesResult,
      rows: (typesResult.rows || []).map((row) => {
        let enumValues = row.enum_values;
        if (typeof enumValues === 'string') {
          // "{a,b,c}" → ["a","b","c"]. Labels that contain commas/quotes
          // would need a proper parser, but enum labels in practice are
          // plain identifiers, so the simple split is good enough.
          enumValues = enumValues
            .replace(/^\{|\}$/g, '')
            .split(',')
            .map((v) => v.trim().replace(/^"|"$/g, ''))
            .filter((v) => v.length > 0);
        } else if (!Array.isArray(enumValues)) {
          enumValues = null;
        }
        return { ...row, enum_values: enumValues };
      }),
    };

    // Group columns, indexes, constraints, and triggers by table
    const tablesWithDetails = tablesResult.rows.map(table => {
      const tableColumns = columnsResult.rows.filter(col =>
        col.table_name === table.table_name && col.table_schema === table.table_schema
      );
      const tableIndexes = indexesResult.rows.filter(idx =>
        idx.table_name === table.table_name && idx.table_schema === table.table_schema
      );
      const tableConstraints = constraintsResult.rows.filter(con =>
        con.table_name === table.table_name && con.table_schema === table.table_schema
      );
      const tableTriggers = triggersResult.rows.filter(trig =>
        trig.table_name === table.table_name && trig.table_schema === table.table_schema
      );

      return {
        ...table,
        columns: tableColumns,
        indexes: tableIndexes,
        constraints: tableConstraints,
        triggers: tableTriggers
      };
    });

    // schema-sync differs (triggers / indexes) read these arrays from the
    // top-level DatabaseInfo, so expose the same rows that were nested
    // under tablesWithDetails. This is a flat view — the per-table nesting
    // is still preserved via `table.triggers` / `table.indexes`.
    const databaseInfo = {
      name: currentDb,
      schemas: schemasResult.rows,
      tables: tablesWithDetails,
      views: viewsResult.rows,
      functions: functionsResult.rows,
      procedures: proceduresResult.rows,
      sequences: sequencesResult.rows,
      types: typesResult.rows,
      extensions: extensionsResult.rows,
      indexes: indexesResult.rows,
      triggers: triggersResult.rows,
      constraints: constraintsResult.rows
    };

    const finalDbResult = await client.query('SELECT current_database() as name');
    log.info('Database structure retrieved:', {
      requestedDb: database,
      actualDb: finalDbResult.rows[0].name,
      tables: tablesResult.rows.length,
      schemas: schemasResult.rows.length,
      types: typesResult.rows.length,
      enumTypes: typesResult.rows.filter(r => Array.isArray(r.enum_values)).length,
      tableNames: tablesResult.rows.slice(0, 5).map(r => r.table_name),
    });
    if (constraintsResult.rows.length > 0) {
      log.debug('PK count:', constraintsResult.rows.filter(c => c.constraint_type === 'PRIMARY KEY').length);
      log.debug('FK count:', constraintsResult.rows.filter(c => c.constraint_type === 'FOREIGN KEY').length);
    }

    return { success: true, database_name: currentDb, databases: [databaseInfo] };
  } catch (error) {
    log.error('Error getting database structure:', error.message);
    return { success: false, message: error.message };
  } finally {
    if (tempClient) {
      try { await tempClient.end(); } catch (_) { /* ignore */ }
    }
  }
});

ipcMain.handle('disconnect-database', async (event, connectionId) => {
  try {
    // Stop auto-reconnect and health check for this connection
    dbHealth.onDisconnected(connectionId);

    const client = global.dbClients.get(connectionId);
    if (client) {
      await client.end();
      global.dbClients.delete(connectionId);
    }

    // If no more connections, stop MCP and tool servers
    if (global.dbClients.size === 0) {
      await toolServer.stopToolServer();
      await mcpManager.stopMcpServer();
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
    if (!safeApi) {
      throw new Error('MCP server not available');
    }

    // Validate tool request
    if (!toolRequest.requestId || !toolRequest.toolName) {
      throw new Error('Invalid tool request: missing requestId or toolName');
    }

    // If a specific connectionId is provided, use that connection's pg.Client
    // instead of the default global.dbClient (which is the first available).
    const connId = toolRequest.connectionId;
    const dbClientForTool = connId
      ? (global.dbClients.get(connId) || global.dbClient)
      : global.dbClient;

    // Call tool through safe API (which enforces allowlist)
    // Use the appropriate method based on tool name
    let result;
    const toolName = toolRequest.toolName;
    const args = toolRequest.arguments || {};

    // Route to appropriate handler.
    // When a specific connectionId is provided, use direct SQL via dbClientForTool
    // instead of safeApi (MCP server), because safeApi is a singleton bound to
    // one connection and won't reflect the chat's selected database.
    if (toolName === 'list_schemas') {
      if (connId && dbClientForTool) {
        const r = await dbClientForTool.query(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_toast','pg_catalog','information_schema') ORDER BY schema_name`
        );
        result = r.rows.map(row => row.schema_name);
      } else {
        result = await safeApi.getSchemas();
      }
    } else if (toolName === 'list_tables') {
      log.debug('Calling getTables with schema:', args.schema || 'public');
      if (connId && dbClientForTool) {
        const schema = args.schema || 'public';
        const r = await dbClientForTool.query(
          `SELECT table_name as name, table_type as type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
          [schema]
        );
        result = r.rows.map(row => ({ name: row.name, type: row.type }));
      } else {
        result = await safeApi.getTables(args.schema || 'public');
      }
      log.debug('getTables result:', JSON.stringify(result, null, 2));
    } else if (toolName === 'table_columns') {
      if (connId && dbClientForTool) {
        const schema = args.schema || 'public';
        const r = await dbClientForTool.query(
          `SELECT column_name as name, data_type as type, is_nullable, column_default as "default" FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [schema, args.table]
        );
        result = r.rows.map(row => ({ name: row.name, type: row.type, nullable: row.is_nullable === 'YES', default: row.default }));
      } else {
        result = await safeApi.getColumns(args.schema || 'public', args.table);
      }
    } else if (toolName === 'describe_table') {
      if (connId && dbClientForTool) {
        const schema = args.schema || 'public';
        const table = args.table;
        const colRes = await dbClientForTool.query(
          `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [schema, table]
        );
        const idxRes = await dbClientForTool.query(
          `SELECT indexname as name, indexdef as definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
          [schema, table]
        );
        const fkRes = await dbClientForTool.query(
          `SELECT tc.constraint_name as name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
          [schema, table]
        );
        result = {
          columns: colRes.rows.map(c => ({ column_name: c.column_name, data_type: c.data_type, is_nullable: c.is_nullable, column_default: c.column_default })),
          indexes: idxRes.rows.map(i => ({ index_name: i.name, definition: i.definition })),
          foreign_keys: fkRes.rows.map(fk => ({ constraint_name: fk.name, column_name: fk.column_name, foreign_table_name: fk.foreign_table_name, foreign_column_name: fk.foreign_column_name })),
        };
      } else {
        result = await safeApi.describeTable(args.schema || 'public', args.table);
      }
    } else if (toolName === 'list_indexes') {
      // Get indexes directly from database (MCP server doesn't provide this)
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const table = args.table;
      const query = table
        ? `SELECT indexname as name, indexdef as definition, indexname as index_name FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`
        : `SELECT indexname as name, tablename as table_name, indexdef as definition, indexname as index_name FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname`;
      const params = table ? [schema, table] : [schema];
      const indexResult = await dbClientForTool.query(query, params);
      result = indexResult.rows.map(row => ({
        name: row.name || row.index_name,
        table: row.table_name || table,
        definition: row.definition,
        schema: schema,
      }));
    } else if (toolName === 'list_constraints') {
      // Get constraints directly from database (MCP server doesn't provide this)
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const table = args.table;
      const query = table
        ? `SELECT conname as name, contype as type, a.attname as column_name FROM pg_constraint co JOIN pg_class c ON co.conrelid = c.oid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(co.conkey) JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = $1 AND c.relname = $2 ORDER BY conname`
        : `SELECT conname as name, c.relname as table_name, contype as type, a.attname as column_name FROM pg_constraint co JOIN pg_class c ON co.conrelid = c.oid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(co.conkey) JOIN pg_namespace n ON c.relnamespace = n.oid WHERE n.nspname = $1 ORDER BY c.relname, conname`;
      const params = table ? [schema, table] : [schema];
      const constraintResult = await dbClientForTool.query(query, params);
      result = constraintResult.rows.map(row => ({
        name: row.name,
        type: row.type === 'p' ? 'PRIMARY KEY' : row.type === 'f' ? 'FOREIGN KEY' : row.type === 'u' ? 'UNIQUE' : row.type === 'c' ? 'CHECK' : row.type,
        columns: [row.column_name],
        table: row.table_name || table,
        schema: schema,
      }));
    } else if (toolName === 'list_views') {
      // Get views directly from database (MCP server doesn't provide this)
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT table_name as name FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name`;
      const viewResult = await dbClientForTool.query(query, [schema]);
      result = viewResult.rows.map(row => ({
        name: row.name,
        schema: schema,
      }));
    } else if (toolName === 'list_functions') {
      // Get functions directly from database (MCP server doesn't provide this)
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT p.proname as name, pg_get_function_result(p.oid) as return_type, pg_get_function_arguments(p.oid) as arguments FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = $1 ORDER BY p.proname`;
      const functionResult = await dbClientForTool.query(query, [schema]);
      result = functionResult.rows.map(row => ({
        name: row.name,
        return_type: row.return_type,
        arguments: row.arguments,
        schema: schema,
      }));
    } else if (toolName === 'list_sequences') {
      // Get sequences directly from database (MCP server doesn't provide this)
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT sequence_name as name FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name`;
      const sequenceResult = await dbClientForTool.query(query, [schema]);
      result = sequenceResult.rows.map(row => ({
        name: row.name,
        schema: schema,
      }));
    } else if (toolName === 'list_extensions') {
      // Get extensions directly from database
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const query = `SELECT extname as name, extversion as version, extnamespace::regnamespace::text as schema FROM pg_extension ORDER BY extname`;
      const extensionResult = await dbClientForTool.query(query);
      result = extensionResult.rows.map(row => ({
        name: row.name,
        version: row.version,
        schema: row.schema,
      }));
    } else if (toolName === 'list_types' || toolName === 'list_enums') {
      // Get types/enums directly from database
      if (!dbClientForTool) {
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
      const typeResult = await dbClientForTool.query(query, [schema]);
      result = typeResult.rows.map(row => ({
        name: row.name,
        schema: row.schema,
        enum_values: row.enum_values,
        type: row.type_category || (row.enum_values ? 'enum' : 'composite'),
      }));
    } else if (toolName === 'list_triggers') {
      // Get triggers directly from database
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const table = args.table;
      const query = table
        ? `SELECT tgname as name, c.relname as table_name, pg_get_triggerdef(t.oid) as definition, CASE WHEN t.tgtype & 66 = 2 THEN 'BEFORE' WHEN t.tgtype & 66 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END as timing FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 ORDER BY tgname`
        : `SELECT tgname as name, c.relname as table_name, pg_get_triggerdef(t.oid) as definition, CASE WHEN t.tgtype & 66 = 2 THEN 'BEFORE' WHEN t.tgtype & 66 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END as timing FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE NOT t.tgisinternal AND n.nspname = $1 ORDER BY c.relname, tgname`;
      const params = table ? [schema, table] : [schema];
      const triggerResult = await dbClientForTool.query(query, params);
      result = triggerResult.rows.map(row => ({
        name: row.name,
        table: row.table_name || table,
        definition: row.definition,
        timing: row.timing,
        schema: schema,
      }));
    } else if (toolName === 'list_procedures') {
      // Get procedures directly from database
      if (!dbClientForTool) {
        throw new Error('No database connection');
      }
      const schema = args.schema || 'public';
      const query = `SELECT p.proname as name, pg_get_functiondef(p.oid) as definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = $1 AND p.prokind = 'p' ORDER BY p.proname`;
      const procedureResult = await dbClientForTool.query(query, [schema]);
      result = procedureResult.rows.map(row => ({
        name: row.name,
        definition: row.definition,
        schema: schema,
      }));
    } else if (toolName === 'explain_query' || toolName === 'explain') {
      if (connId && dbClientForTool) {
        const sql = args.query || args.sql;
        const format = (args.format || 'json').toUpperCase();
        const r = await dbClientForTool.query(`EXPLAIN (FORMAT ${format}) ${sql}`);
        result = { plan: r.rows.map(row => Object.values(row)[0]).join('\n'), error: '' };
      } else {
        result = await safeApi.explainQuery(args.query || args.sql, args.format || 'json');
      }
    } else if (toolName === 'explain_analyze') {
      if (connId && dbClientForTool) {
        const sql = args.query || args.sql;
        const r = await dbClientForTool.query(`EXPLAIN ANALYZE ${sql}`);
        result = { plan: r.rows.map(row => Object.values(row)[0]).join('\n'), error: '' };
      } else {
        result = await safeApi.callToolSafe(toolName, args);
        result = safeApi.extractResult(result);
      }
    } else {
      // For other tools, try dbClientForTool for direct SQL if available,
      // otherwise use safe API's callToolSafe which enforces allowlist
      result = await safeApi.callToolSafe(toolName, args);
      // Extract result from MCP format
      result = safeApi.extractResult(result);
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
    const { getMcpClient } = require('../mcp-manager');
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
      const envPath = isDev
        ? path.join(__dirname, '../.env.local')
        : path.join(app.getAppPath(), '.env.local');

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
      log.warn('safeStorage encryption not available; refusing to persist password');
      return { encrypted: false, data: '' };
    }
    const encrypted = safeStorage.encryptString(plaintext);
    return { encrypted: true, data: encrypted.toString('base64') };
  } catch (error) {
    log.error('encrypt-password error:', error);
    return { encrypted: false, data: '' };
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

// ── Check for updates via GitHub releases API ──
ipcMain.handle('check-for-updates', async () => {
  try {
    const https = require('https');
    const currentVersion = app.getVersion();

    const data = await new Promise((resolve, reject) => {
      const req = https.get(
        'https://api.github.com/repos/ONEPANTSU/progresql/releases',
        {
          headers: {
            'User-Agent': `ProgreSQL/${currentVersion}`,
            'Accept': 'application/vnd.github.v3+json',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error('Failed to parse GitHub API response'));
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('GitHub API request timed out'));
      });
    });

    // Find latest release with client-v* tag
    const releases = Array.isArray(data) ? data : [];
    const clientRelease = releases.find(
      (r) => r.tag_name && r.tag_name.startsWith('client-v') && !r.draft,
    );

    if (!clientRelease) {
      return { hasUpdate: false, latestVersion: currentVersion, downloadUrl: '' };
    }

    const latestVersion = clientRelease.tag_name.replace('client-v', '');

    // Simple semver comparison: split by dots and compare numerically
    const current = currentVersion.split('.').map(Number);
    const latest = latestVersion.split('.').map(Number);
    let hasUpdate = false;
    for (let i = 0; i < Math.max(current.length, latest.length); i++) {
      const c = current[i] || 0;
      const l = latest[i] || 0;
      if (l > c) { hasUpdate = true; break; }
      if (l < c) { break; }
    }

    // Platform-specific download URL
    let downloadUrl = 'https://progresql.com/downloads/';
    if (process.platform === 'darwin') {
      downloadUrl = 'https://progresql.com/downloads/ProgreSQL-latest.dmg';
    } else if (process.platform === 'win32') {
      downloadUrl = 'https://progresql.com/downloads/ProgreSQL-latest.exe';
    } else {
      downloadUrl = 'https://progresql.com/downloads/ProgreSQL-latest.AppImage';
    }

    log.info(`Update check: current=${currentVersion}, latest=${latestVersion}, hasUpdate=${hasUpdate}`);
    return { hasUpdate, latestVersion, downloadUrl };
  } catch (error) {
    log.error('Check for updates failed:', error);
    return { hasUpdate: false, latestVersion: app.getVersion(), downloadUrl: '' };
  }
});
