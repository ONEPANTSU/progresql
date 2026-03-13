const { EventEmitter } = require('events');
const { createLogger } = require('../../logger');
const log = createLogger('McpClient');

class McpClient extends EventEmitter {
  constructor(command, args = [], options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.process = null;
    this.messageIdCounter = 0;
    this.pendingRequests = new Map();
    this.initialized = false;
    this.tools = [];
    this.options = {
      timeout: options.timeout || 30000,
      maxRetries: options.maxRetries || 1,
      retryDelay: options.retryDelay || 1000,
    };
  }

  async start(envOverride) {
    if (this.process) {
      throw new Error('MCP client already started');
    }

    const { spawn } = require('child_process');

    // Merge environment variables (MCP server needs POSTGRES_* vars)
    // Use envOverride if provided (from McpServerProcessManager), otherwise use process.env
    const env = envOverride ? { ...process.env, ...envOverride } : process.env;

    log.debug('Starting process with env:', {
      hasPostgresDsn: !!env.POSTGRES_DSN,
      hasPostgresHost: !!env.POSTGRES_HOST,
      hasPostgresUser: !!env.POSTGRES_USER,
      hasPostgresPassword: !!env.POSTGRES_PASSWORD,
      hasPostgresDatabase: !!env.POSTGRES_DATABASE,
      envKeys: Object.keys(env).filter(k => k.startsWith('POSTGRES_')),
    });

    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env,
      shell: false,
    });

    // Handle stdout (MCP messages)
    let buffer = '';
    this.process.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            log.debug('Received message:', JSON.stringify(message, null, 2));
            this.handleMessage(message);
          } catch (error) {
            log.error('Failed to parse message:', error, 'Line:', line);
            // Log raw output for debugging
            log.debug('Raw stdout buffer:', buffer);
          }
        }
      }
    });

    // Handle stderr (logs)
    this.process.stderr.on('data', (data) => {
      const stderrOutput = data.toString();
      this.emit('log', { level: 'error', message: stderrOutput });
      log.error('Server stderr:', stderrOutput);
    });

    // Log process info
    log.debug('Process started:', {
      command: this.command,
      args: this.args,
      pid: this.process.pid,
      stdin: !!this.process.stdin,
      stdout: !!this.process.stdout,
      stderr: !!this.process.stderr,
    });

    // Handle process exit
    this.process.on('exit', (code) => {
      this.emit('exit', code);
      if (code !== 0) {
        this.emit('error', new Error(`MCP server exited with code ${code}`));
      }
    });

    this.process.on('error', (error) => {
      this.emit('error', error);
    });

    // Wait a bit for process to start
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  async stop() {
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

  async initialize(params = {}) {
    const initParams = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'progresql-desktop',
        version: '1.0.0',
      },
      ...params,
    };

    log.debug('Sending initialize request:', JSON.stringify(initParams, null, 2));

    // Use longer timeout for initialize
    const originalTimeout = this.options.timeout;
    this.options.timeout = 60000; // 60 seconds for initialize

    try {
      const result = await this.sendRequest('initialize', initParams);
      this.initialized = true;

      log.debug('Initialize successful:', JSON.stringify(result, null, 2));

      // Send initialized notification
      await this.sendNotification('initialized', {});

      return result;
    } finally {
      // Restore original timeout
      this.options.timeout = originalTimeout;
    }
  }

  async listTools() {
    if (!this.initialized) {
      throw new Error('MCP client not initialized');
    }

    const result = await this.sendRequest('tools/list', {});
    this.tools = result.tools || [];
    return this.tools;
  }

  async callTool(name, args = {}) {
    if (!this.initialized) {
      throw new Error('MCP client not initialized');
    }

    const params = {
      name,
      arguments: args,
    };

    const result = await this.sendRequest('tools/call', params);
    return result;
  }

  async sendRequest(method, params, retries = 0) {
    const id = ++this.messageIdCounter;
    const message = {
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

  async sendNotification(method, params) {
    const message = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.sendMessage(message);
  }

  sendMessage(message) {
    if (!this.process || !this.process.stdin) {
      throw new Error('MCP process not available');
    }

    const json = JSON.stringify(message) + '\n';
    log.debug('Sending message:', json.trim());
    this.process.stdin.write(json);
  }

  handleMessage(message) {
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

  isTransientError(error) {
    const transientPatterns = [
      /timeout/i,
      /connection/i,
      /network/i,
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
    ];

    return transientPatterns.some(pattern => pattern.test(error.message));
  }

  getTools() {
    return this.tools;
  }

  isInitialized() {
    return this.initialized;
  }

  isRunning() {
    return this.process !== null && this.process.exitCode === null;
  }
}

module.exports = { McpClient };
