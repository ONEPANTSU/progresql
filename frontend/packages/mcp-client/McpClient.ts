import { EventEmitter } from 'events';
const { createLogger } = require('../../logger');
const log = createLogger('McpClient');
import {
  McpMessage,
  McpError,
  McpInitializeParams,
  McpInitializeResult,
  McpTool,
  McpToolCallParams,
  McpToolCallResult,
} from '../shared-types';

export interface McpClientOptions {
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class McpClient extends EventEmitter {
  private process: any = null;
  private messageIdCounter: number = 0;
  private pendingRequests: Map<string | number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private initialized: boolean = false;
  private tools: McpTool[] = [];
  private options: Required<McpClientOptions>;

  constructor(private command: string, private args: string[] = [], options: McpClientOptions = {}) {
    super();
    this.options = {
      timeout: options.timeout || 30000,
      maxRetries: options.maxRetries || 1,
      retryDelay: options.retryDelay || 1000,
    };
  }

  /**
   * Start the MCP server process
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('MCP client already started');
    }

    const { spawn } = require('child_process');
    
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Handle stdout (MCP messages)
    let buffer = '';
    this.process.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message: McpMessage = JSON.parse(line);
            this.handleMessage(message);
          } catch (error) {
            log.error('Failed to parse message:', error, 'Line:', line);
          }
        }
      }
    });

    // Handle stderr (logs)
    this.process.stderr.on('data', (data: Buffer) => {
      const stderrOutput = data.toString();
      this.emit('log', { level: 'error', message: stderrOutput });
      log.error('Server stderr:', stderrOutput);
    });

    // Handle process exit
    this.process.on('exit', (code: number) => {
      this.emit('exit', code);
      if (code !== 0) {
        this.emit('error', new Error(`MCP server exited with code ${code}`));
      }
    });

    this.process.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Wait a bit for process to start
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  /**
   * Stop the MCP server process
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.initialized = false;
      this.tools = [];
      
      // Reject all pending requests
      for (const [id, request] of this.pendingRequests.entries()) {
        clearTimeout(request.timeout);
        request.reject(new Error('MCP client stopped'));
      }
      this.pendingRequests.clear();
    }
  }

  /**
   * Initialize the MCP connection
   */
  async initialize(params?: Partial<McpInitializeParams>): Promise<McpInitializeResult> {
    const initParams: McpInitializeParams = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'progresql-desktop',
        version: '1.0.0',
      },
      ...params,
    };

    const result = await this.sendRequest('initialize', initParams);
    this.initialized = true;
    
    // Send initialized notification
    await this.sendNotification('initialized', {});
    
    return result as McpInitializeResult;
  }

  /**
   * List available tools
   */
  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) {
      throw new Error('MCP client not initialized');
    }

    const result = await this.sendRequest('tools/list', {});
    this.tools = result.tools || [];
    return this.tools;
  }

  /**
   * Call a tool
   */
  async callTool(name: string, args?: Record<string, any>): Promise<McpToolCallResult> {
    if (!this.initialized) {
      throw new Error('MCP client not initialized');
    }

    const params: McpToolCallParams = {
      name,
      arguments: args || {},
    };

    const result = await this.sendRequest('tools/call', params);
    return result as McpToolCallResult;
  }

  /**
   * Send a JSON-RPC request
   */
  private async sendRequest(method: string, params: any, retries: number = 0): Promise<any> {
    const id = ++this.messageIdCounter;
    const message: McpMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.options.timeout);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          
          // Retry on transient errors
          if (retries < this.options.maxRetries && this.isTransientError(error)) {
            setTimeout(() => {
              this.sendRequest(method, params, retries + 1).then(resolve).catch(reject);
            }, this.options.retryDelay);
          } else {
            reject(error);
          }
        },
        timeout,
      });

      this.sendMessage(message);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private async sendNotification(method: string, params: any): Promise<void> {
    const message: McpMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.sendMessage(message);
  }

  /**
   * Send a message to the MCP server
   */
  private sendMessage(message: McpMessage): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('MCP process not available');
    }

    const json = JSON.stringify(message) + '\n';
    this.process.stdin.write(json);
  }

  /**
   * Handle incoming messages from MCP server
   */
  private handleMessage(message: McpMessage): void {
    if (message.id !== undefined) {
      // Response to a request
      const request = this.pendingRequests.get(message.id);
      if (request) {
        if (message.error) {
          request.reject(new Error(message.error.message));
        } else {
          request.resolve(message.result);
        }
      }
    } else if (message.method) {
      // Notification from server
      this.emit('notification', message);
    }
  }

  /**
   * Check if error is transient and should be retried
   */
  private isTransientError(error: Error): boolean {
    const transientPatterns = [
      /timeout/i,
      /connection/i,
      /network/i,
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
    ];

    return transientPatterns.some(pattern => pattern.test(error.message));
  }

  /**
   * Get list of available tools (cached)
   */
  getTools(): McpTool[] {
    return this.tools;
  }

  /**
   * Check if client is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if process is running
   */
  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }
}
