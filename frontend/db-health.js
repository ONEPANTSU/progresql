/**
 * Database health check and auto-reconnect module.
 *
 * Usage:
 *   const dbHealth = require('./db-health');
 *   // After successful connect:
 *   dbHealth.onConnected(connectionConfig, mainWindow);
 *   // On user-initiated disconnect:
 *   dbHealth.onDisconnected();
 *   // On app quit:
 *   dbHealth.shutdown();
 */

const { createLogger } = require('./logger');
const log = createLogger('DBHealth');

const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;

let lastConnectionConfig = null;
let mainWindowRef = null;
let healthCheckInterval = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
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

function startHealthCheck() {
  stopHealthCheck();
  healthCheckInterval = setInterval(async () => {
    if (!global.dbClient) return;
    try {
      await global.dbClient.query('SELECT 1');
    } catch (err) {
      log.warn('Health check failed:', err.message);
      global.dbClient = null;
      stopHealthCheck();
      notifyRenderer('db-connection-lost', { message: err.message });
      startAutoReconnect();
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

function stopAutoReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}

async function startAutoReconnect() {
  if (!lastConnectionConfig) {
    log.warn('No stored connection config for auto-reconnect');
    return;
  }
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    log.error('Max reconnect attempts reached, giving up');
    notifyRenderer('db-reconnect-failed', {
      message: `Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`
    });
    reconnectAttempt = 0;
    return;
  }

  reconnectAttempt++;
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt - 1),
    MAX_RECONNECT_DELAY_MS
  );
  log.info(`Auto-reconnect attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
  notifyRenderer('db-reconnecting', {
    attempt: reconnectAttempt,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    delayMs: delay
  });

  reconnectTimer = setTimeout(async () => {
    try {
      const { Client } = require('pg');
      const cfg = lastConnectionConfig;
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
        log.error('Reconnected client error:', err.message);
        global.dbClient = null;
        stopHealthCheck();
        notifyRenderer('db-connection-lost', { message: err.message });
        startAutoReconnect();
      });

      client.on('end', () => {
        log.debug('Reconnected client ended');
        global.dbClient = null;
      });

      await client.connect();
      global.dbClient = client;
      reconnectAttempt = 0;
      log.info('Auto-reconnect successful');

      // Re-initialize MCP and tool servers
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

      notifyRenderer('db-reconnected', { message: 'Reconnected successfully' });
      startHealthCheck();
    } catch (err) {
      log.warn(`Reconnect attempt ${reconnectAttempt} failed:`, err.message);
      startAutoReconnect();
    }
  }, delay);
}

/**
 * Call after a successful database connection.
 * Stores the config for auto-reconnect and starts health checks.
 */
function onConnected(connectionConfig, mainWindow) {
  lastConnectionConfig = connectionConfig;
  mainWindowRef = mainWindow;
  stopAutoReconnect();
  startHealthCheck();
}

/**
 * Call when the user explicitly disconnects.
 * Stops health checks and clears reconnect state.
 */
function onDisconnected() {
  stopAutoReconnect();
  stopHealthCheck();
  lastConnectionConfig = null;
}

/**
 * Call on app quit to clean up timers.
 */
function shutdown() {
  stopAutoReconnect();
  stopHealthCheck();
}

/**
 * Attempt a single immediate reconnect (no delay).
 * Returns true if reconnect succeeded, false otherwise.
 * On failure, starts the normal auto-reconnect process.
 */
async function tryImmediateReconnect() {
  if (!lastConnectionConfig) {
    log.warn('No stored connection config for immediate reconnect');
    return false;
  }

  stopHealthCheck();
  notifyRenderer('db-connection-lost', { message: 'Connection lost, reconnecting...' });

  try {
    const { Client } = require('pg');
    const cfg = lastConnectionConfig;
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
      log.error('Reconnected client error:', err.message);
      global.dbClient = null;
      stopHealthCheck();
      notifyRenderer('db-connection-lost', { message: err.message });
      startAutoReconnect();
    });

    client.on('end', () => {
      log.debug('Reconnected client ended');
      global.dbClient = null;
    });

    await client.connect();
    global.dbClient = client;
    reconnectAttempt = 0;
    log.debug('Immediate reconnect successful');

    // Re-initialize MCP and tool servers
    if (mcpManagerRef) {
      try {
        await mcpManagerRef.stopMcpServer();
        const mcpResult = await mcpManagerRef.initializeMcpServer(cfg);
        if (mcpResult.success) {
          log.debug('MCP server re-initialized after immediate reconnect');
        }
      } catch (mcpErr) {
        log.warn('MCP re-init failed after immediate reconnect:', mcpErr.message);
      }
    }

    if (toolServerRef) {
      try {
        await toolServerRef.stopToolServer();
        const tsResult = await toolServerRef.startToolServer();
        if (tsResult.success) {
          log.debug('Tool server re-started after immediate reconnect');
        }
      } catch (tsErr) {
        log.warn('Tool server re-start failed after immediate reconnect:', tsErr.message);
      }
    }

    notifyRenderer('db-reconnected', { message: 'Reconnected successfully' });
    startHealthCheck();
    return true;
  } catch (err) {
    log.warn('Immediate reconnect failed:', err.message);
    // Fall back to auto-reconnect with exponential backoff
    startAutoReconnect();
    return false;
  }
}

module.exports = {
  configure,
  onConnected,
  onDisconnected,
  shutdown,
  tryImmediateReconnect,
};
