/**
 * Database health check and auto-reconnect module.
 * Supports multiple simultaneous connections.
 *
 * Usage:
 *   const dbHealth = require('./db-health');
 *   // After successful connect:
 *   dbHealth.onConnected(connectionId, connectionConfig, mainWindow);
 *   // On user-initiated disconnect:
 *   dbHealth.onDisconnected(connectionId);
 *   // On app quit:
 *   dbHealth.shutdown();
 */

const { createLogger } = require('./logger');
const log = createLogger('DBHealth');

const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;

// Per-connection state: Map<connectionId, { config, interval, reconnectTimer, attempt }>
const connectionStates = new Map();
// Ensure global.dbClients exists (shared Map of active pg clients)
if (!global.dbClients) global.dbClients = new Map();
let mainWindowRef = null;
let mcpManagerRef = null;
let toolServerRef = null;

function configure(opts) {
  mcpManagerRef = opts.mcpManager;
  toolServerRef = opts.toolServer;
}

function notifyRenderer(channel, data) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data);
  }
}

function startHealthCheck(connectionId) {
  const state = connectionStates.get(connectionId);
  if (!state) return;

  stopHealthCheck(connectionId);

  state.healthCheckInterval = setInterval(async () => {
    const client = global.dbClients.get(connectionId);
    if (!client) return;
    try {
      await client.query('SELECT 1');
    } catch (err) {
      log.warn(`Health check failed [${connectionId}]:`, err.message);
      global.dbClients.delete(connectionId);
      stopHealthCheck(connectionId);
      notifyRenderer('db-connection-lost', { connectionId, message: err.message });
      startAutoReconnect(connectionId);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck(connectionId) {
  const state = connectionStates.get(connectionId);
  if (!state) return;
  if (state.healthCheckInterval) {
    clearInterval(state.healthCheckInterval);
    state.healthCheckInterval = null;
  }
}

function stopAutoReconnect(connectionId) {
  const state = connectionStates.get(connectionId);
  if (!state) return;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.reconnectAttempt = 0;
}

async function startAutoReconnect(connectionId) {
  const state = connectionStates.get(connectionId);
  if (!state || !state.config) {
    log.warn(`No stored connection config for auto-reconnect [${connectionId}]`);
    return;
  }
  if (state.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    log.error(`Max reconnect attempts reached [${connectionId}], giving up`);
    notifyRenderer('db-reconnect-failed', {
      connectionId,
      message: `Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`
    });
    state.reconnectAttempt = 0;
    return;
  }

  state.reconnectAttempt++;
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, state.reconnectAttempt - 1),
    MAX_RECONNECT_DELAY_MS
  );
  log.info(`Auto-reconnect [${connectionId}] attempt ${state.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
  notifyRenderer('db-reconnecting', {
    connectionId,
    attempt: state.reconnectAttempt,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    delayMs: delay
  });

  state.reconnectTimer = setTimeout(async () => {
    try {
      const { Client } = require('pg');
      const cfg = state.config;
      const client = new Client({
        host: cfg.host,
        port: cfg.port,
        user: cfg.username,
        password: cfg.password,
        database: cfg.database,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000
      });

      client.on('error', (err) => {
        log.error(`Reconnected client error [${connectionId}]:`, err.message);
        global.dbClients.delete(connectionId);
        stopHealthCheck(connectionId);
        notifyRenderer('db-connection-lost', { connectionId, message: err.message });
        startAutoReconnect(connectionId);
      });

      client.on('end', () => {
        log.debug(`Reconnected client ended [${connectionId}]`);
        global.dbClients.delete(connectionId);
      });

      await client.connect();
      global.dbClients.set(connectionId, client);
      // Sync legacy single-client ref for tool-server compatibility
      global.dbClient = client;
      state.reconnectAttempt = 0;
      log.info(`Auto-reconnect successful [${connectionId}]`);

      // Re-initialize MCP and tool servers if this was the only connection
      if (global.dbClients.size === 1) {
        if (mcpManagerRef) {
          try {
            await mcpManagerRef.stopMcpServer();
            const mcpResult = await mcpManagerRef.initializeMcpServer(cfg);
            if (mcpResult.success) {
              log.debug('MCP server re-initialized after reconnect');
            }
          } catch (mcpErr) {
            log.warn('MCP re-init failed after reconnect:', mcpErr.message);
          }
        }

        if (toolServerRef) {
          try {
            await toolServerRef.stopToolServer();
            const tsResult = await toolServerRef.startToolServer();
            if (tsResult.success) {
              log.debug('Tool server re-started after reconnect');
            }
          } catch (tsErr) {
            log.warn('Tool server re-start failed after reconnect:', tsErr.message);
          }
        }
      }

      notifyRenderer('db-reconnected', { connectionId, message: 'Reconnected successfully' });
      startHealthCheck(connectionId);
    } catch (err) {
      log.warn(`Reconnect attempt ${state.reconnectAttempt} failed [${connectionId}]:`, err.message);
      startAutoReconnect(connectionId);
    }
  }, delay);
}

/**
 * Call after a successful database connection.
 * Stores the config for auto-reconnect and starts health checks.
 */
function onConnected(connectionId, connectionConfig, mainWindow) {
  mainWindowRef = mainWindow;

  // Stop any existing state for this connection
  if (connectionStates.has(connectionId)) {
    stopAutoReconnect(connectionId);
    stopHealthCheck(connectionId);
  }

  connectionStates.set(connectionId, {
    config: connectionConfig,
    healthCheckInterval: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
  });

  startHealthCheck(connectionId);
}

/**
 * Call when the user explicitly disconnects a specific connection.
 * Stops health checks and clears reconnect state.
 */
function onDisconnected(connectionId) {
  if (connectionId) {
    stopAutoReconnect(connectionId);
    stopHealthCheck(connectionId);
    connectionStates.delete(connectionId);
  } else {
    // Legacy: disconnect all
    shutdown();
  }
}

/**
 * Call on app quit to clean up all timers.
 */
function shutdown() {
  for (const [id] of connectionStates) {
    stopAutoReconnect(id);
    stopHealthCheck(id);
  }
  connectionStates.clear();
}

/**
 * Attempt a single immediate reconnect for a specific connection (no delay).
 * Returns true if reconnect succeeded, false otherwise.
 */
async function tryImmediateReconnect(connectionId) {
  // If no connectionId, try with the first available state
  if (!connectionId) {
    if (connectionStates.size === 0) {
      log.warn('No stored connection config for immediate reconnect');
      return false;
    }
    connectionId = connectionStates.keys().next().value;
  }

  const state = connectionStates.get(connectionId);
  if (!state || !state.config) {
    log.warn(`No stored connection config for immediate reconnect [${connectionId}]`);
    return false;
  }

  stopHealthCheck(connectionId);
  notifyRenderer('db-connection-lost', { connectionId, message: 'Connection lost, reconnecting...' });

  try {
    const { Client } = require('pg');
    const cfg = state.config;
    const client = new Client({
      host: cfg.host,
      port: cfg.port,
      user: cfg.username,
      password: cfg.password,
      database: cfg.database,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    });

    client.on('error', (err) => {
      log.error(`Reconnected client error [${connectionId}]:`, err.message);
      global.dbClients.delete(connectionId);
      stopHealthCheck(connectionId);
      notifyRenderer('db-connection-lost', { connectionId, message: err.message });
      startAutoReconnect(connectionId);
    });

    client.on('end', () => {
      log.debug(`Reconnected client ended [${connectionId}]`);
      global.dbClients.delete(connectionId);
    });

    await client.connect();
    global.dbClients.set(connectionId, client);
    // Sync legacy single-client ref for tool-server compatibility
    global.dbClient = client;
    state.reconnectAttempt = 0;
    log.debug(`Immediate reconnect successful [${connectionId}]`);

    notifyRenderer('db-reconnected', { connectionId, message: 'Reconnected successfully' });
    startHealthCheck(connectionId);
    return true;
  } catch (err) {
    log.warn(`Immediate reconnect failed [${connectionId}]:`, err.message);
    startAutoReconnect(connectionId);
    return false;
  }
}

function getConnectionState(connectionId) {
  return connectionStates.get(connectionId) || null;
}

module.exports = {
  configure,
  onConnected,
  onDisconnected,
  shutdown,
  tryImmediateReconnect,
  getConnectionState,
};
