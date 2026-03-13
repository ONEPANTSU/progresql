const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { McpClient } = require('./McpClient');
const { createLogger } = require('../../logger');
const log = createLogger('McpServerProcessManager');

class McpServerProcessManager extends EventEmitter {
  constructor(config) {
    super();

    this.config = {
      command: config.command,
      args: config.args || [],
      cwd: config.cwd || process.cwd(),
      env: config.env || {},
      logFile: config.logFile || path.join(process.cwd(), 'mcp-logs', 'mcp-server.log'),
      maxRestarts: config.maxRestarts || 3,
      restartDelay: config.restartDelay || 2000,
    };

    this.client = null;
    this.restartCount = 0;
    this.logStream = null;
    this.isShuttingDown = false;

    // Ensure log directory exists
    const logDir = path.dirname(this.config.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  async start() {
    if (this.client) {
      throw new Error('MCP server already started');
    }

    this.isShuttingDown = false;
    this.restartCount = 0;

    await this.startServer();
  }

  async stop() {
    this.isShuttingDown = true;

    if (this.client) {
      await this.client.stop();
      this.client = null;
    }

    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  async restart() {
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, this.config.restartDelay));
    await this.start();
  }

  getClient() {
    return this.client;
  }

  isRunning() {
    return this.client !== null && this.client.isRunning();
  }

  async startServer() {
    try {
      // Create log stream
      this.logStream = fs.createWriteStream(this.config.logFile, { flags: 'a' });
      this.writeLog(`[${new Date().toISOString()}] Starting MCP server: ${this.config.command} ${this.config.args.join(' ')}`);

      // Create MCP client with longer timeout
      this.client = new McpClient(this.config.command, this.config.args, {
        timeout: 60000, // 60 seconds for initialize
        maxRetries: 1,
      });

      // Setup event handlers
      this.client.on('log', (entry) => {
        this.writeLog(`[${entry.level.toUpperCase()}] ${entry.message}`);
      });

      this.client.on('error', (error) => {
        this.emit('error', error);
        this.writeLog(`[ERROR] ${error.message}`);

        if (!this.isShuttingDown) {
          this.handleServerCrash();
        }
      });

      this.client.on('exit', (code) => {
        this.writeLog(`[EXIT] MCP server exited with code ${code}`);

        if (!this.isShuttingDown && code !== 0) {
          this.handleServerCrash();
        }
      });

      // Start the client with environment variables from config
      await this.client.start(this.config.env);

      // Initialize MCP connection
      await this.client.initialize();
      this.writeLog('[INFO] MCP server initialized successfully');

      // List available tools
      const tools = await this.client.listTools();
      this.writeLog(`[INFO] Available tools: ${tools.map(t => t.name).join(', ')}`);

      this.restartCount = 0;
      this.emit('started');
    } catch (error) {
      this.writeLog(`[ERROR] Failed to start MCP server: ${error.message}`);
      this.emit('error', error);

      if (!this.isShuttingDown) {
        this.handleServerCrash();
      }
    }
  }

  async handleServerCrash() {
    if (this.isShuttingDown) {
      return;
    }

    this.restartCount++;

    if (this.restartCount > this.config.maxRestarts) {
      this.writeLog(`[ERROR] Max restarts (${this.config.maxRestarts}) reached. Stopping auto-restart.`);
      this.emit('maxRestartsReached');
      return;
    }

    this.writeLog(`[WARN] MCP server crashed. Restarting (${this.restartCount}/${this.config.maxRestarts})...`);
    this.emit('restarting', this.restartCount);

    // Clean up
    if (this.client) {
      try {
        await this.client.stop();
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.client = null;
    }

    // Wait before restart
    await new Promise(resolve => setTimeout(resolve, this.config.restartDelay));

    // Restart
    try {
      await this.startServer();
    } catch (error) {
      this.emit('error', error);
    }
  }

  writeLog(message) {
    const timestampedMessage = `[${new Date().toISOString()}] ${message}\n`;

    if (this.logStream) {
      this.logStream.write(timestampedMessage);
    }

    log.debug(message);
  }
}

module.exports = { McpServerProcessManager };
