import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { McpClient } from './McpClient';
const { createLogger } = require('../../logger');
const mgrLog = createLogger('McpServerProcessManager');

export interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logFile?: string;
  maxRestarts?: number;
  restartDelay?: number;
}

export class McpServerProcessManager extends EventEmitter {
  private client: McpClient | null = null;
  private config: Required<McpServerConfig>;
  private restartCount: number = 0;
  private logStream: fs.WriteStream | null = null;
  private isShuttingDown: boolean = false;

  constructor(config: McpServerConfig) {
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

    // Ensure log directory exists
    const logDir = path.dirname(this.config.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    if (this.client) {
      throw new Error('MCP server already started');
    }

    this.isShuttingDown = false;
    this.restartCount = 0;

    await this.startServer();
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
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

  /**
   * Restart the MCP server
   */
  async restart(): Promise<void> {
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, this.config.restartDelay));
    await this.start();
  }

  /**
   * Get the MCP client instance
   */
  getClient(): McpClient | null {
    return this.client;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.client !== null && this.client.isRunning();
  }

  /**
   * Internal method to start the server
   */
  private async startServer(): Promise<void> {
    try {
      // Create log stream
      this.logStream = fs.createWriteStream(this.config.logFile, { flags: 'a' });
      this.log(`[${new Date().toISOString()}] Starting MCP server: ${this.config.command} ${this.config.args.join(' ')}`);

      // Create MCP client
      this.client = new McpClient(this.config.command, this.config.args, {
        timeout: 30000,
        maxRetries: 1,
      });

      // Setup event handlers
      this.client.on('log', (log: { level: string; message: string }) => {
        this.log(`[${log.level.toUpperCase()}] ${log.message}`);
      });

      this.client.on('error', (error: Error) => {
        this.emit('error', error);
        this.log(`[ERROR] ${error.message}`);
        
        if (!this.isShuttingDown) {
          this.handleServerCrash();
        }
      });

      this.client.on('exit', (code: number) => {
        this.log(`[EXIT] MCP server exited with code ${code}`);
        
        if (!this.isShuttingDown && code !== 0) {
          this.handleServerCrash();
        }
      });

      // Start the client
      await this.client.start();
      
      // Initialize MCP connection
      await this.client.initialize();
      this.log('[INFO] MCP server initialized successfully');

      // List available tools
      const tools = await this.client.listTools();
      this.log(`[INFO] Available tools: ${tools.map(t => t.name).join(', ')}`);

      this.restartCount = 0;
      this.emit('started');
    } catch (error) {
      this.log(`[ERROR] Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`);
      this.emit('error', error);
      
      if (!this.isShuttingDown) {
        this.handleServerCrash();
      }
    }
  }

  /**
   * Handle server crash with auto-restart
   */
  private async handleServerCrash(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.restartCount++;

    if (this.restartCount > this.config.maxRestarts) {
      this.log(`[ERROR] Max restarts (${this.config.maxRestarts}) reached. Stopping auto-restart.`);
      this.emit('maxRestartsReached');
      return;
    }

    this.log(`[WARN] MCP server crashed. Restarting (${this.restartCount}/${this.config.maxRestarts})...`);
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

  /**
   * Write log message to file and console
   */
  private log(message: string): void {
    const timestampedMessage = `[${new Date().toISOString()}] ${message}\n`;
    
    if (this.logStream) {
      this.logStream.write(timestampedMessage);
    }
    
    mgrLog.debug(message);
  }
}
