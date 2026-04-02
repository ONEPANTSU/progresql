import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentService,
  AgentRequestPayload,
  AgentRequestCallbacks,
  ConnectionState,
  ConnectionPhase,
  AgentServiceConfig,
  ServerNotification,
  ToolResultPayload,
} from '../services/agent/AgentService';
import { handleToolCall } from '../services/agent/toolHandler';
import type { PendingApproval, SqlDangerLevel } from '../components/chat/ToolApprovalDialog';
import { createLogger } from '../utils/logger';

const log = createLogger('AgentContext');
import {
  loadBackendUrl,
  saveBackendUrl,
  loadModel,
  saveModel,
  loadAutocompleteModel,
  saveAutocompleteModel,
  loadAutocompleteEnabled,
  saveAutocompleteEnabled,
  loadSecurityMode,
  saveSecurityMode,
  SecurityMode,
} from '../utils/secureSettingsStorage';
import { isSubscriptionActive, fetchUsage } from '../services/auth';
import { useAuth } from '../providers/AuthProvider';
import { UsageInfo } from '../types';

const DEFAULT_BACKEND_URL = 'https://progresql.com';

// ── SQL danger classification ──

const DDL_KEYWORDS = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT'];
const DML_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT'];
const DCL_KEYWORDS = ['GRANT', 'REVOKE', 'REASSIGN', 'SECURITY'];

/** Strip SQL comments to analyze the actual statement */
function stripSQLComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
}

/**
 * Classify whether an SQL statement is dangerous and what kind.
 * Returns null if the statement is safe (e.g. SELECT without side effects).
 */
function classifySqlDanger(sql: string): SqlDangerLevel | null {
  const cleaned = stripSQLComments(sql);
  const upper = cleaned.toUpperCase();
  const firstWord = upper.split(/\s+/)[0];

  if (DDL_KEYWORDS.includes(firstWord)) return 'ddl';
  if (DML_KEYWORDS.includes(firstWord)) return 'dml';
  if (DCL_KEYWORDS.includes(firstWord)) return 'dcl';

  // SELECT with side-effect functions (e.g. pg_terminate_backend, lo_unlink, etc.)
  if (firstWord === 'SELECT' || firstWord === 'WITH') {
    const dangerousFunctions = [
      'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
      'pg_rotate_logfile', 'pg_switch_wal', 'pg_switch_xlog',
      'lo_unlink', 'lo_create', 'lo_import', 'lo_export',
      'dblink_exec', 'set_config', 'pg_advisory_lock',
      'nextval', 'setval',
      'pg_sleep',
    ];
    const lowerSql = cleaned.toLowerCase();
    for (const fn of dangerousFunctions) {
      if (lowerSql.includes(fn + '(') || lowerSql.includes(fn + ' (')) {
        return 'function_call';
      }
    }
  }

  // CALL, DO, EXECUTE — procedural execution
  if (['CALL', 'DO', 'EXECUTE'].includes(firstWord)) return 'function_call';

  return null;
}

// ── Context value ──

export interface AgentContextValue {
  /** Current connection state of the AgentService */
  connectionState: ConnectionState;
  /** Fine-grained connection phase (authorizing, creating_session, websocket, etc.) */
  connectionPhase: ConnectionPhase;
  /** Whether the agent is connected and ready to accept requests */
  isConnected: boolean;
  /** Whether the last error was an authentication error */
  isAuthError: boolean;
  /** Connect to the backend (auth + session + websocket) */
  connect: () => Promise<void>;
  /** Disconnect from the backend */
  disconnect: () => void;
  /** Send an agent.request and receive callbacks for stream/response/error */
  sendRequest: (payload: AgentRequestPayload, callbacks: AgentRequestCallbacks) => string;
  /** Cancel tracking for a pending request */
  cancelRequest: (requestId: string) => void;
  /** Current session ID (null if not connected) */
  sessionId: string | null;
  /** Last connection error message */
  error: string | null;
  /** Configured backend URL */
  backendUrl: string;
  /** Update backend URL (persisted securely) */
  setBackendUrl: (url: string) => void;
  /** Configured LLM model */
  model: string;
  /** Update LLM model (persisted) */
  setModel: (model: string) => void;
  /** Configured autocomplete model (budget tier only) */
  autocompleteModel: string;
  /** Update autocomplete model (persisted) */
  setAutocompleteModel: (model: string) => void;
  /** Whether autocomplete is enabled */
  autocompleteEnabled: boolean;
  /** Toggle autocomplete on/off (persisted) */
  setAutocompleteEnabled: (enabled: boolean) => void;
  /** Current security mode: "safe" | "data" | "execute" */
  securityMode: SecurityMode;
  /** Update security mode (persisted) */
  setSecurityMode: (mode: SecurityMode) => void;
  /** Whether safe mode is enabled (backward compat helper) */
  safeMode: boolean;
  /** Toggle safe mode (backward compat — maps to securityMode) */
  setSafeMode: (enabled: boolean) => void;
  /** Send autocomplete request */
  sendAutocomplete: (sql: string, cursorPos: number, schemaContext: string, callback: (completion: string) => void) => void;
  /** Cancel pending autocomplete */
  cancelAutocomplete: () => void;
  /** Current usage/quota info (periodically refreshed) */
  usage: UsageInfo | null;
  /** Refresh usage data from backend */
  refreshUsage: () => void;
  /** Last server notification (quota.warning, model.fallback, etc.) */
  lastNotification: ServerNotification | null;
  /** Pending tool approval request (shown inline in chat) */
  pendingApproval: PendingApproval | null;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

// ── Provider ──

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [backendUrl, setBackendUrlState] = useState<string>(() =>
    loadBackendUrl(DEFAULT_BACKEND_URL),
  );
  const [model, setModelState] = useState<string>(() => loadModel());
  const [autocompleteModel, setAutocompleteModelState] = useState<string>(() => loadAutocompleteModel());
  const [autocompleteEnabled, setAutocompleteEnabledState] = useState<boolean>(() => loadAutocompleteEnabled());
  const [securityMode, setSecurityModeState] = useState<SecurityMode>(() => loadSecurityMode());

  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const { user } = useAuth();
  const userId = user?.id;

  // Usage/quota state
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [lastNotification, setLastNotification] = useState<ServerNotification | null>(null);

  // Tool approval state
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const autoApproveRef = useRef(false); // "accept always" for this session

  // AgentService ref (recreated when config changes)
  const serviceRef = useRef<AgentService | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Rebuild service only when backendUrl changes (not model or user)
  useEffect(() => {
    // Disconnect old service if it exists
    if (serviceRef.current) {
      unsubscribeRef.current?.();
      serviceRef.current.disconnect();
    }

    const config: AgentServiceConfig = {
      backendUrl,
      model,
    };

    const service = new AgentService(config);

    const unsubscribe = service.onConnectionStateChange((state, phase) => {
      setConnectionState(state);
      if (phase) setConnectionPhase(phase);
      if (state === 'connected') {
        setSessionId(service.getSessionId());
        setError(null);
        setIsAuthError(false);
      } else if (state === 'disconnected') {
        setSessionId(null);
      }
    });

    // Register tool call handler with approval gating for dangerous SQL
    service.setToolCallHandler(async (toolName: string, args: Record<string, unknown>): Promise<ToolResultPayload> => {
      // Only gate execute_query with dangerous SQL in execute mode
      if (toolName === 'execute_query') {
        const sql = (args.sql || args.query || '') as string;
        const dangerLevel = classifySqlDanger(sql);

        if (dangerLevel && !autoApproveRef.current) {
          // Show approval dialog and wait for user decision
          const decision = await new Promise<'accept_once' | 'accept_always' | 'deny'>((resolve) => {
            setPendingApproval({ sql, dangerLevel, resolve });
          });
          setPendingApproval(null);

          if (decision === 'deny') {
            return {
              success: false,
              error: 'User denied execution of this SQL statement.',
            };
          }
          if (decision === 'accept_always') {
            autoApproveRef.current = true;
          }
        }
      }
      return handleToolCall(toolName, args);
    });

    // Subscribe to server push notifications
    const unsubNotification = service.onNotification((notification) => {
      log.info('Server notification:', notification.type, notification.payload);
      setLastNotification(notification);
    });

    serviceRef.current = service;
    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      unsubNotification();
      service.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl]);

  // Auto-connect when user logs in, disconnect when logs out
  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;

    if (userId) {
      service.connect().catch((err) => {
        const msg = err?.message || '';
        log.warn('Auto-connect failed:', msg);
        setIsAuthError(false);
        setError(msg);
      });
    } else {
      service.disconnect();
    }
  }, [userId]);

  // Update model on existing service without reconnecting
  useEffect(() => {
    const service = serviceRef.current;
    if (service) {
      service.updateModel(model);
    }
  }, [model]);

  // Persist settings
  const setBackendUrl = useCallback((url: string) => {
    setBackendUrlState(url);
    saveBackendUrl(url);
  }, []);

  const setModel = useCallback((m: string) => {
    setModelState(m);
    saveModel(m);
  }, []);

  const setAutocompleteModel = useCallback((m: string) => {
    setAutocompleteModelState(m);
    saveAutocompleteModel(m);
  }, []);

  const setAutocompleteEnabled = useCallback((enabled: boolean) => {
    setAutocompleteEnabledState(enabled);
    saveAutocompleteEnabled(enabled);
  }, []);

  const setSecurityMode = useCallback((mode: SecurityMode) => {
    setSecurityModeState(mode);
    saveSecurityMode(mode);
    // Reset "accept always" when switching modes
    autoApproveRef.current = false;
  }, []);

  // Backward compat
  const setSafeMode = useCallback((enabled: boolean) => {
    setSecurityMode(enabled ? 'safe' : 'execute');
  }, [setSecurityMode]);

  // IPC listener: tool-server.js (main process) asks renderer to approve dangerous SQL
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.onToolApprovalRequest) return;

    api.onToolApprovalRequest((data: { sql: string; dangerLevel: string }) => {
      setPendingApproval({
        sql: data.sql,
        dangerLevel: data.dangerLevel as SqlDangerLevel,
        resolve: (decision) => {
          setPendingApproval(null);
          if (decision === 'accept_always') {
            autoApproveRef.current = true;
          }
          api.respondToolApproval(decision);
        },
      });
    });

    return () => {
      api.removeToolApprovalListener?.();
    };
  }, []);

  // Connect
  const connect = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;

    setError(null);
    setIsAuthError(false);
    try {
      await service.connect();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to connect to agent backend';
      setError(message);
      throw err;
    }
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    serviceRef.current?.disconnect();
    setError(null);
  }, []);

  // Send request — gated by subscription status
  const sendRequest = useCallback((payload: AgentRequestPayload, callbacks: AgentRequestCallbacks): string => {
    if (!isSubscriptionActive(user)) {
      callbacks.onError?.({
        code: 'subscription_expired',
        message: 'Your trial has expired. Upgrade to Pro to continue using AI features.',
      });
      return '';
    }

    const service = serviceRef.current;
    if (!service) {
      callbacks.onError?.({ code: 'not_initialized', message: 'AgentService not initialized' });
      return '';
    }
    return service.sendRequest(payload, callbacks);
  }, [user]);

  // Cancel request
  const cancelRequest = useCallback((requestId: string) => {
    serviceRef.current?.cancelRequest(requestId);
  }, []);

  // Fetch usage data from backend
  const refreshUsage = useCallback(() => {
    if (!userId) return;
    fetchUsage().then(setUsage).catch((err) => {
      log.warn('Failed to fetch usage:', err);
    });
  }, [userId]);

  // Auto-fetch usage when user is logged in, periodically (every 60s).
  // Usage is fetched via REST API with the login token, so it does not
  // require the WebSocket connection to be established.
  useEffect(() => {
    if (!userId) return;
    refreshUsage();
    const interval = setInterval(refreshUsage, 60_000);
    return () => clearInterval(interval);
  }, [userId, refreshUsage]);

  // Autocomplete — pass autocompleteModel to service via ref for stable callback
  const autocompleteModelRef = useRef(autocompleteModel);
  const autocompleteEnabledRef = useRef(autocompleteEnabled);
  useEffect(() => {
    autocompleteModelRef.current = autocompleteModel;
  }, [autocompleteModel]);
  useEffect(() => {
    autocompleteEnabledRef.current = autocompleteEnabled;
  }, [autocompleteEnabled]);

  const sendAutocomplete = useCallback((sql: string, cursorPos: number, schemaContext: string, callback: (completion: string) => void) => {
    if (!autocompleteEnabledRef.current) return;
    serviceRef.current?.sendAutocomplete(sql, cursorPos, schemaContext, callback, autocompleteModelRef.current);
  }, []);

  const cancelAutocomplete = useCallback(() => {
    serviceRef.current?.cancelAutocomplete();
  }, []);

  const value = useMemo<AgentContextValue>(() => ({
    connectionState,
    connectionPhase,
    isConnected: connectionState === 'connected',
    isAuthError,
    connect,
    disconnect,
    sendRequest,
    cancelRequest,
    sessionId,
    error,
    backendUrl,
    setBackendUrl,
    model,
    setModel,
    autocompleteModel,
    setAutocompleteModel,
    autocompleteEnabled,
    setAutocompleteEnabled,
    securityMode,
    setSecurityMode,
    safeMode: securityMode === 'safe',
    setSafeMode,
    sendAutocomplete,
    cancelAutocomplete,
    usage,
    refreshUsage,
    lastNotification,
    pendingApproval,
  }), [connectionState, connectionPhase, isAuthError, connect, disconnect, sendRequest, cancelRequest, sessionId, error, backendUrl, setBackendUrl, model, setModel, autocompleteModel, setAutocompleteModel, autocompleteEnabled, setAutocompleteEnabled, securityMode, setSecurityMode, setSafeMode, sendAutocomplete, cancelAutocomplete, usage, refreshUsage, lastNotification, pendingApproval]);

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  );
};

// ── Hook ──

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within AgentProvider');
  return ctx;
}
