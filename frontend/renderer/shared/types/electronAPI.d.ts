import type { AuthUser, DatabaseStructureResponse, QueryResult } from './index';

/** Generic wrapper for IPC responses that use ok/result/error pattern. */
export interface ElectronAPIResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { message: string };
}

/** Tool execution request sent to main process. */
export interface ToolRequest {
  requestId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  connectionId?: string;
  security_mode?: 'safe' | 'data' | 'execute';
}

/** Database connection config for connectDatabase IPC call. */
export interface DatabaseConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  connectionName?: string;
}

/** Response from connectDatabase IPC call. */
export interface ConnectDatabaseResult {
  success: boolean;
  message?: string;
}

/** Response from executeQuery IPC call. */
export interface ExecuteQueryResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  fields?: { name: string; dataType: number; dataTypeName?: string }[];
  message?: string;
}

/** Response from disconnectDatabase IPC call. */
export interface DisconnectDatabaseResult {
  success: boolean;
  message?: string;
}

/** MCP tool descriptor returned by mcpListTools. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Response from checkForUpdates IPC call. */
export interface UpdateCheckResult {
  hasUpdate: boolean;
  latestVersion: string;
  downloadUrl: string;
}

/** Auth data persisted to disk for session survival across restarts. */
export interface PersistedAuthData {
  token: string;
  user: AuthUser;
}

declare global {
  interface Window {
    electronAPI: {
      // Database operations — return flat objects with success/message pattern
      connectDatabase: (config: DatabaseConnectionConfig & { connectionId: string }) => Promise<ConnectDatabaseResult>;
      executeQuery: (connectionId: string, query: string) => Promise<ExecuteQueryResult>;
      getDatabaseStructure: (connectionId?: string, database?: string) => Promise<DatabaseStructureResponse>;
      disconnectDatabase: (connectionId: string) => Promise<DisconnectDatabaseResult>;
      listDatabases: (connectionId: string) => Promise<{ success: boolean; databases?: Array<{ name: string; owner?: string; encoding?: string; size?: string }>; message?: string }>;
      switchDatabase: (connectionId: string, database: string) => Promise<ConnectDatabaseResult>;
      setActiveClient: (connectionId: string) => Promise<{ success: boolean }>;
      // MCP operations
      mcpIsAvailable: () => Promise<{ available: boolean; hasApi: boolean }>;
      mcpListTools: () => Promise<ElectronAPIResponse<McpToolDescriptor[]>>;
      // Tool execution — uses ok/result/error pattern
      executeToolRequest: (request: ToolRequest) => Promise<ElectronAPIResponse<unknown>>;
      // Password encryption via safeStorage
      encryptPassword: (plaintext: string) => Promise<{ encrypted: boolean; data: string }>;
      decryptPassword: (encryptedBase64: string) => Promise<string>;
      isEncryptionAvailable: () => Promise<boolean>;
      // App lifecycle
      onAppReady: (callback: () => void) => void;
      removeAppReadyListener: () => void;
      // Database connection state events (auto-reconnect)
      onDBConnectionLost: (callback: (data: { connectionId?: string; message: string }) => void) => void;
      onDBReconnecting: (callback: (data: { connectionId?: string; attempt: number; maxAttempts: number; delayMs: number }) => void) => void;
      onDBReconnected: (callback: (data: { connectionId?: string; message: string }) => void) => void;
      onDBReconnectFailed: (callback: (data: { connectionId?: string; message: string }) => void) => void;
      removeDBConnectionListeners: () => void;
      // External URLs
      openExternal: (url: string) => Promise<void>;
      // App info
      getAppVersion: () => Promise<string>;
      // Update check
      checkForUpdates: () => Promise<UpdateCheckResult>;
      // Auth session persistence
      saveAuthData: (data: PersistedAuthData) => Promise<{ success: boolean }>;
      loadAuthData: () => Promise<PersistedAuthData | null>;
      clearAuthData: () => Promise<{ success: boolean }>;
      // Tool approval IPC
      onToolApprovalRequest: (callback: (data: { sql: string; dangerLevel: string }) => void) => void;
      removeToolApprovalListener: () => void;
      respondToolApproval: (decision: 'accept_once' | 'accept_always' | 'deny') => void;
      resetToolAutoApproval: () => void;
    };
  }
}

export {};
