import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentService,
  AgentRequestPayload,
  AgentRequestCallbacks,
  ConnectionState,
  ConnectionPhase,
  AgentServiceConfig,
} from '../services/agent/AgentService';
import { handleToolCall } from '../services/agent/toolHandler';
import { createLogger } from '../utils/logger';

const log = createLogger('AgentContext');
import {
  loadBackendUrl,
  saveBackendUrl,
  loadModel,
  saveModel,
  loadSafeMode,
  saveSafeMode,
} from '../utils/secureSettingsStorage';
import { isSubscriptionActive } from '../services/auth';
import { useAuth } from '../providers/AuthProvider';

const DEFAULT_BACKEND_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:8080' : 'https://progresql.com';

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
  /** Connect to the Go backend (auth + session + websocket) */
  connect: () => Promise<void>;
  /** Disconnect from the Go backend */
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
  /** Whether safe mode is enabled (default: true) */
  safeMode: boolean;
  /** Toggle safe mode (persisted) */
  setSafeMode: (enabled: boolean) => void;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

// ── Provider ──

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [backendUrl, setBackendUrlState] = useState<string>(() =>
    loadBackendUrl(DEFAULT_BACKEND_URL),
  );
  const [model, setModelState] = useState<string>(() => loadModel());
  const [safeMode, setSafeModeState] = useState<boolean>(() => loadSafeMode());

  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const { user } = useAuth();
  const userId = user?.id;

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

    // Register tool call handler so the backend can invoke database tools
    service.setToolCallHandler(handleToolCall);

    serviceRef.current = service;
    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
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

  const setSafeMode = useCallback((enabled: boolean) => {
    setSafeModeState(enabled);
    saveSafeMode(enabled);
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
    safeMode,
    setSafeMode,
  }), [connectionState, connectionPhase, isAuthError, connect, disconnect, sendRequest, cancelRequest, sessionId, error, backendUrl, setBackendUrl, model, setModel, safeMode, setSafeMode]);

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
