/**
 * MCP Server Process Manager
 * Manages the lifecycle of the MCP Postgres server
 */

const path = require('path');
const { McpServerProcessManager } = require('./packages/mcp-client/McpServerProcessManager.js');
const { createLogger } = require('./logger');
const log = createLogger('MCP');

let mcpManager = null;
let safeApi = null;

/**
 * Initialize MCP server manager
 */
async function initializeMcpServer(connectionConfig) {
  try {
    // Если MCP сервер уже запущен, останавливаем его перед перезапуском с новыми параметрами
    if (mcpManager && mcpManager.isRunning()) {
      log.debug('Останавливаем существующий MCP сервер для переключения подключения...');
      await stopMcpServer();
      // Небольшая задержка для корректного завершения процесса
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Determine MCP server command
    // For now, we'll use a placeholder - this should point to the actual MCP server
    // Once the repo is cloned, update this path
    const mcpServerPath = path.join(__dirname, 'packages', 'mcp-postgres-server');

    // Check if MCP server exists, otherwise use a fallback
    const fs = require('fs');
    let command = 'node';
    let args = [];

    // Check if MCP server directory exists
    if (!fs.existsSync(mcpServerPath)) {
      log.warn('MCP server not found. Please clone the progress-mcp repository.');
      log.warn('Run: git clone git@github.com:SoftBananas/progress-mcp.git packages/mcp-postgres-server');
      return { success: false, message: 'MCP server not found' };
    }

    // This is a Python MCP server, so we need to use python command
    // Check for Python executable
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    // Check if virtualenv exists, otherwise use system python
    const venvPython = path.join(mcpServerPath, '.venv', 'bin', 'python');
    const pythonExecutable = fs.existsSync(venvPython) ? venvPython : pythonCmd;

    // MCP server module path
    const serverModule = path.join(mcpServerPath, 'src', 'mcp_server', 'stdio_server.py');

    if (!fs.existsSync(serverModule)) {
      log.warn('MCP server module not found:', serverModule);
      return { success: false, message: 'MCP server module not found' };
    }

    command = pythonExecutable;
    args = ['-m', 'mcp_server.stdio_server'];

    // Set environment variables for MCP server
    // Python MCP server uses POSTGRES_DSN format
    const postgresDsn = `postgresql://${connectionConfig.username}:${connectionConfig.password}@${connectionConfig.host}:${connectionConfig.port || 5432}/${connectionConfig.database}`;

    const env = {
      ...process.env,
      POSTGRES_DSN: postgresDsn,
      // Also set individual vars for compatibility
      POSTGRES_HOST: connectionConfig.host,
      POSTGRES_PORT: connectionConfig.port?.toString() || '5432',
      POSTGRES_USER: connectionConfig.username,
      POSTGRES_PASSWORD: connectionConfig.password,
      POSTGRES_DATABASE: connectionConfig.database,
      // Python path
      PYTHONPATH: path.join(mcpServerPath, 'src'),
    };

    log.debug('Starting MCP server with:', {
      command,
      args,
      cwd: mcpServerPath,
      envKeys: Object.keys(env),
      postgresDsn: postgresDsn.replace(/:[^:@]+@/, ':****@'), // Hide password
      hasPostgresDsn: !!env.POSTGRES_DSN,
      hasPostgresHost: !!env.POSTGRES_HOST,
      hasPostgresUser: !!env.POSTGRES_USER,
      hasPostgresPassword: !!env.POSTGRES_PASSWORD,
      hasPostgresDatabase: !!env.POSTGRES_DATABASE,
    });

    // Create MCP server manager
    mcpManager = new McpServerProcessManager({
      command,
      args,
      cwd: mcpServerPath, // Use MCP server directory as working directory
      env,
      logFile: path.join(__dirname, 'mcp-logs', 'mcp-server.log'),
      maxRestarts: 3,
      restartDelay: 2000,
    });

    // Setup event handlers
    mcpManager.on('started', () => {
      log.debug('Server started successfully');
    });

    mcpManager.on('error', (error) => {
      log.error('Server error:', error);
    });

    mcpManager.on('restarting', (count) => {
      log.warn(`Server restarting (${count})...`);
    });

    mcpManager.on('maxRestartsReached', () => {
      log.error('Max restarts reached. MCP server unavailable.');
    });

    // Start the server
    await mcpManager.start();

    // Get client and create safe API
    const client = mcpManager.getClient();
    if (client) {
      const { SafePostgresToolsApi } = require('./packages/mcp-client/SafePostgresToolsApi.js');
      safeApi = new SafePostgresToolsApi(client);
      log.debug('Safe API initialized');
    }

    return { success: true, message: 'MCP server started' };
  } catch (error) {
    log.error('Failed to initialize:', error);
    return { success: false, message: error.message };
  }
}

/**
 * Stop MCP server
 */
async function stopMcpServer() {
  if (mcpManager) {
    log.debug('Stopping MCP server...');
    try {
      await mcpManager.stop();
      log.debug('MCP server stopped successfully');
    } catch (error) {
      log.error('Error stopping MCP server:', error);
    } finally {
      mcpManager = null;
      safeApi = null;
    }
  }
}

/**
 * Get safe API instance
 */
function getSafeApi() {
  return safeApi;
}

/**
 * Get MCP client instance
 */
function getMcpClient() {
  return mcpManager?.getClient() || null;
}

/**
 * Check if MCP server is running
 */
function isMcpServerRunning() {
  const running = mcpManager !== null && mcpManager.isRunning();
  log.debug('isMcpServerRunning:', running, {
    hasManager: mcpManager !== null,
    isRunning: mcpManager?.isRunning() || false,
    hasSafeApi: safeApi !== null,
  });
  return running;
}

module.exports = {
  initializeMcpServer,
  stopMcpServer,
  getSafeApi,
  getMcpClient,
  isMcpServerRunning,
};
