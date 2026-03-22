const path = require('path');
const { contextBridge, ipcRenderer } = require('electron');
const { createLogger } = require('./logger');
const log = createLogger('Preload');

// Resolve absolute path to app assets directory
const APP_DIR = path.join(__dirname, 'app');
const ASSETS_DIR = path.join(APP_DIR, 'assets');

// Add error handling and logging
contextBridge.exposeInMainWorld('electronAPI', {
  connectDatabase: async (config) => {
    try {
      log.debug('connectDatabase called', config);
      const result = await ipcRenderer.invoke('connect-database', config);
      log.debug('connectDatabase result:', result);
      return result;
    } catch (error) {
      log.error('connectDatabase error:', error);
      throw error;
    }
  },
  executeQuery: async (connectionId, query) => {
    try {
      log.debug('executeQuery called', { connectionId, query });
      const result = await ipcRenderer.invoke('execute-query', { connectionId, query });
      log.debug('executeQuery result:', result);
      return result;
    } catch (error) {
      log.error('executeQuery error:', error);
      throw error;
    }
  },
  getDatabaseStructure: async (connectionId) => {
    try {
      log.debug('getDatabaseStructure called', { connectionId });
      const result = await ipcRenderer.invoke('get-database-structure', connectionId);
      log.debug('getDatabaseStructure result:', result);
      return result;
    } catch (error) {
      log.error('getDatabaseStructure error:', error);
      throw error;
    }
  },
  disconnectDatabase: async (connectionId) => {
    try {
      log.debug('disconnectDatabase called', { connectionId });
      const result = await ipcRenderer.invoke('disconnect-database', connectionId);
      log.debug('disconnectDatabase result:', result);
      return result;
    } catch (error) {
      log.error('disconnectDatabase error:', error);
      throw error;
    }
  },
  // MCP API methods
  mcpGetSchemas: async () => {
    try {
      const result = await ipcRenderer.invoke('mcp-get-schemas');
      return result;
    } catch (error) {
      log.error('mcpGetSchemas error:', error);
      throw error;
    }
  },
  mcpGetTables: async (schema) => {
    try {
      const result = await ipcRenderer.invoke('mcp-get-tables', schema);
      return result;
    } catch (error) {
      log.error('mcpGetTables error:', error);
      throw error;
    }
  },
  mcpDescribeTable: async (schema, table) => {
    try {
      const result = await ipcRenderer.invoke('mcp-describe-table', schema, table);
      return result;
    } catch (error) {
      log.error('mcpDescribeTable error:', error);
      throw error;
    }
  },
  mcpGetIndexes: async (schema, table) => {
    try {
      const result = await ipcRenderer.invoke('mcp-get-indexes', schema, table);
      return result;
    } catch (error) {
      log.error('mcpGetIndexes error:', error);
      throw error;
    }
  },
  mcpGetConstraints: async (schema, table) => {
    try {
      const result = await ipcRenderer.invoke('mcp-get-constraints', schema, table);
      return result;
    } catch (error) {
      log.error('mcpGetConstraints error:', error);
      throw error;
    }
  },
  executeToolRequest: async (toolRequest) => {
    try {
      const result = await ipcRenderer.invoke('execute-tool-request', toolRequest);
      return result;
    } catch (error) {
      log.error('executeToolRequest error:', error);
      throw error;
    }
  },
  mcpIsAvailable: async () => {
    try {
      const result = await ipcRenderer.invoke('mcp-is-available');
      return result;
    } catch (error) {
      log.error('mcpIsAvailable error:', error);
      return { available: false, hasApi: false };
    }
  },
  mcpListTools: async () => {
    try {
      const result = await ipcRenderer.invoke('mcp-list-tools');
      return result;
    } catch (error) {
      log.error('mcpListTools error:', error);
      return { success: false, tools: [] };
    }
  },
  // App-ready event from main process
  onAppReady: (callback) => {
    ipcRenderer.on('app-ready', () => {
      log.debug('received app-ready event');
      callback();
    });
  },
  removeAppReadyListener: () => {
    ipcRenderer.removeAllListeners('app-ready');
  },
  // Database connection state events for auto-reconnect
  onDBConnectionLost: (callback) => {
    ipcRenderer.on('db-connection-lost', (_event, data) => {
      log.warn('DB connection lost:', data);
      callback(data);
    });
  },
  onDBReconnecting: (callback) => {
    ipcRenderer.on('db-reconnecting', (_event, data) => {
      log.info('DB reconnecting:', data);
      callback(data);
    });
  },
  onDBReconnected: (callback) => {
    ipcRenderer.on('db-reconnected', (_event, data) => {
      log.info('DB reconnected:', data);
      callback(data);
    });
  },
  onDBReconnectFailed: (callback) => {
    ipcRenderer.on('db-reconnect-failed', (_event, data) => {
      log.error('DB reconnect failed:', data);
      callback(data);
    });
  },
  removeDBConnectionListeners: () => {
    ipcRenderer.removeAllListeners('db-connection-lost');
    ipcRenderer.removeAllListeners('db-reconnecting');
    ipcRenderer.removeAllListeners('db-reconnected');
    ipcRenderer.removeAllListeners('db-reconnect-failed');
  },
  // Password encryption via safeStorage
  encryptPassword: async (plaintext) => {
    try {
      return await ipcRenderer.invoke('encrypt-password', plaintext);
    } catch (error) {
      log.error('encryptPassword error:', error);
      return { encrypted: false, data: plaintext };
    }
  },
  decryptPassword: async (encryptedBase64) => {
    try {
      return await ipcRenderer.invoke('decrypt-password', encryptedBase64);
    } catch (error) {
      log.error('decryptPassword error:', error);
      return encryptedBase64;
    }
  },
  isEncryptionAvailable: async () => {
    try {
      return await ipcRenderer.invoke('is-encryption-available');
    } catch (error) {
      log.error('isEncryptionAvailable error:', error);
      return false;
    }
  },
  // Open URL in external browser
  openExternal: (url) => {
    ipcRenderer.invoke('open-external', url);
  },
  // Get app version
  getAppVersion: () => {
    return ipcRenderer.invoke('get-app-version');
  },
  // Navigate to a route (loads the correct HTML file in production)
  navigate: (route) => {
    ipcRenderer.send('navigate-to', route);
  },
  // Get absolute path to asset file
  getAssetPath: (filename) => {
    return 'file://' + path.join(ASSETS_DIR, filename);
  },
});
