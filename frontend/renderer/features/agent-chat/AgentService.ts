/**
 * AgentService — WebSocket client for the backend agent pipeline.
 *
 * Handles the full lifecycle:
 *   1. POST /api/v1/auth/token  -> JWT
 *   2. POST /api/v1/sessions    -> session_id + ws_url
 *   3. WebSocket connect to ws_url?token=JWT
 *   4. Send agent.request, receive agent.stream / agent.response / agent.error
 *   5. Handle tool.call from backend, execute locally, send tool.result
 *   6. Auto-reconnect on connection loss with exponential backoff
 */

import { createLogger } from '@/shared/lib/logger';

const log = createLogger('AgentService');

// ── Envelope & payload types (mirror backend/internal/websocket/types.go) ──

export interface Envelope {
  type: string;
  request_id?: string;
  call_id?: string;
  payload: unknown;
}

export interface AgentRequestPayload {
  action: 'generate_sql' | 'improve_sql' | 'explain_sql' | 'analyze_schema';
  user_message?: string;
  model?: string; // per-request model override sent to backend
  context?: {
    selected_sql?: string;
    active_table?: string;
    user_descriptions?: string;
    safe_mode?: boolean;
    security_mode?: 'safe' | 'data' | 'execute';
    language?: string;
    connection_id?: string;
  };
}

export interface AgentStreamPayload {
  delta: string;
}

export interface Visualization {
  chart_type: 'bar' | 'line' | 'pie' | 'area' | 'metric' | 'table';
  title: string;
  data: Record<string, unknown>[];
  x_label?: string;
  y_label?: string;
  sql?: string;
}

export interface AgentResult {
  sql?: string;
  explanation?: string;
  candidates?: string[];
  query_result?: any;
  visualization?: Visualization;
  validation_error?: string;
  security_blocked?: boolean;
}

export interface ToolCallLogEntry {
  call_id: string;
  tool_name: string;
  success: boolean;
}

export interface AgentResponsePayload {
  action: string;
  result: AgentResult;
  tool_calls_log?: ToolCallLogEntry[];
  model_used?: string;
  model_tier?: 'budget' | 'premium';
  tokens_used?: number;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface AgentErrorPayload {
  code: string;
  message: string;
}

// ── Server push notification types ──

export type NotificationType = 'quota.warning' | 'quota.exhausted' | 'balance.low';

export interface ServerNotification {
  type: NotificationType;
  payload: Record<string, unknown>;
}

export type NotificationCallback = (notification: ServerNotification) => void;

// ── Tool call types (mirror backend tool.call / tool.result) ──

export interface ToolCallPayload {
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultPayload {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Handler for tool.call messages from the backend.
 * Receives tool_name and arguments, must return { success, data?, error? }.
 */
export type ToolCallHandler = (toolName: string, args: Record<string, unknown>) => Promise<ToolResultPayload>;

// ── Callback types ──

export type StreamCallback = (delta: string) => void;
export type ResponseCallback = (response: AgentResponsePayload) => void;
export type ErrorCallback = (error: AgentErrorPayload) => void;

export interface AgentRequestCallbacks {
  onStream?: StreamCallback;
  onResponse?: ResponseCallback;
  onError?: ErrorCallback;
}

// ── Connection state ──

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** Fine-grained sub-phase for the 'connecting' state */
export type ConnectionPhase = 'idle' | 'authorizing' | 'creating_session' | 'websocket' | 'connected';

export type ConnectionStateCallback = (state: ConnectionState, phase?: ConnectionPhase) => void;

// ── Config ──

export interface AgentServiceConfig {
  backendUrl: string;  // e.g. "http://localhost:8080"
  model?: string;      // LLM model name
  reconnectMaxRetries?: number;
  reconnectBaseDelay?: number; // ms
  reconnectMaxDelay?: number;  // ms — cap for exponential backoff
}

// ── Service ──

function generateRequestId(): string {
  // Simple UUID v4 generator (no crypto.randomUUID dependency)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    var v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class AgentService {
  private config: AgentServiceConfig;
  private jwt: string | null = null;
  private jwtExpiresAt: Date | null = null;
  private sessionId: string | null = null;
  private wsUrl: string | null = null;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private connectionPhase: ConnectionPhase = 'idle';
  private stateCallbacks: ConnectionStateCallback[] = [];

  // JWT refresh timer
  private jwtRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending request tracking: request_id -> callbacks
  private pendingRequests = new Map<string, AgentRequestCallbacks>();

  // Autocomplete
  private autocompleteCallback: ((completion: string) => void) | null = null;
  private autocompleteRequestId: string | null = null;

  // Tool call handler — set by the consumer (e.g. AgentContext)
  private toolCallHandler: ToolCallHandler | null = null;

  // Server push notification callbacks
  private notificationCallbacks: NotificationCallback[] = [];

  // Reconnect
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  /** Update model without reconnecting */
  updateModel(model: string): void {
    this.config.model = model;
  }

  constructor(config: AgentServiceConfig) {
    this.config = {
      reconnectMaxRetries: Infinity,    // unlimited retries
      reconnectBaseDelay: 1000,         // 1s initial delay
      reconnectMaxDelay: 30000,         // 30s max delay cap
      ...config,
    };
  }

  // ── Public API ──

  /**
   * Full connect sequence: auth -> session -> websocket.
   */
  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.setConnectionState('connecting', 'authorizing');

    try {
      await this.obtainJWT();
      this.setConnectionState('connecting', 'creating_session');
      await this.createSession();
      this.setConnectionState('connecting', 'websocket');
      await this.connectWebSocket();
      this.reconnectAttempt = 0;
      this.scheduleJWTRefresh();
      this.setConnectionState('connected', 'connected');
    } catch (err) {
      this.setConnectionState('disconnected', 'idle');
      throw err;
    }
  }

  /**
   * Disconnect and stop reconnection attempts.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.clearJWTRefreshTimer();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this.jwt = null;
    this.sessionId = null;
    this.wsUrl = null;
    this.setConnectionState('disconnected');

    // Reject all pending requests
    this.pendingRequests.forEach(function (cbs) {
      if (cbs.onError) cbs.onError({ code: 'disconnected', message: 'AgentService disconnected' });
    });
    this.pendingRequests.clear();
  }

  /**
   * Send an agent.request and receive callbacks for stream / response / error.
   * Returns the generated request_id.
   *
   * The current model from config is injected into every request so the backend
   * always uses the model the user selected in settings, even if it changed
   * after the WebSocket session was created.
   */
  sendRequest(payload: AgentRequestPayload, callbacks: AgentRequestCallbacks): string {
    if (!this.ws || this.connectionState !== 'connected') {
      callbacks.onError?.({ code: 'not_connected', message: 'AgentService is not connected' });
      return '';
    }

    // Guard against stale WebSocket: state says 'connected' but socket is dead.
    if (this.ws.readyState !== WebSocket.OPEN) {
      log.warn('WebSocket is not OPEN (readyState=' + this.ws.readyState + '), triggering reconnect');
      callbacks.onError?.({ code: 'connection_lost', message: 'Connection lost, reconnecting...' });
      this.ws = null;
      this.setConnectionState('reconnecting');
      this.handleUnexpectedClose(new CloseEvent('close'));
      return '';
    }

    const requestId = generateRequestId();

    this.pendingRequests.set(requestId, callbacks);

    // Inject current model into the payload so the backend uses the user's selection.
    const payloadWithModel: AgentRequestPayload = {
      ...payload,
      model: payload.model || this.config.model || '',
    };

    const envelope: Envelope = {
      type: 'agent.request',
      request_id: requestId,
      payload: payloadWithModel,
    };

    this.ws.send(JSON.stringify(envelope));
    return requestId;
  }

  /**
   * Cancel a pending request: sends agent.cancel to the backend and removes local tracking.
   */
  cancelRequest(requestId: string): void {
    if (!requestId) return;

    // Send cancel signal to backend.
    if (this.ws && this.connectionState === 'connected') {
      const envelope: Envelope = {
        type: 'agent.cancel',
        request_id: requestId,
        payload: {},
      };
      this.ws.send(JSON.stringify(envelope));
    }

    this.pendingRequests.delete(requestId);
  }

  /**
   * Send an autocomplete request for SQL ghost text.
   */
  sendAutocomplete(sql: string, cursorPos: number, schemaContext: string, callback: (completion: string) => void, model?: string): void {
    if (!this.ws || this.connectionState !== 'connected') return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    // Cancel previous autocomplete if pending
    this.cancelAutocomplete();

    const requestId = generateRequestId();
    this.autocompleteRequestId = requestId;
    this.autocompleteCallback = callback;
    this.pendingRequests.set(requestId, {});

    const envelope: Envelope = {
      type: 'autocomplete.request',
      request_id: requestId,
      payload: { sql, cursor_position: cursorPos, schema_context: schemaContext, ...(model ? { model } : {}) },
    };

    this.ws.send(JSON.stringify(envelope));
  }

  /**
   * Cancel a pending autocomplete request.
   */
  cancelAutocomplete(): void {
    if (this.autocompleteRequestId) {
      this.pendingRequests.delete(this.autocompleteRequestId);
      this.autocompleteRequestId = null;
    }
    this.autocompleteCallback = null;
  }

  /**
   * Register a handler for tool.call messages from the backend.
   * The handler executes tools locally (e.g. via Electron database API)
   * and returns the result to send back as tool.result.
   */
  setToolCallHandler(handler: ToolCallHandler): void {
    this.toolCallHandler = handler;
  }

  /**
   * Register a listener for server push notifications
   * (quota.warning, quota.exhausted, balance.low).
   */
  onNotification(cb: NotificationCallback): () => void {
    this.notificationCallbacks.push(cb);
    return () => {
      this.notificationCallbacks = this.notificationCallbacks.filter(c => c !== cb);
    };
  }

  /**
   * Register a listener for connection state changes.
   */
  onConnectionStateChange(cb: ConnectionStateCallback): () => void {
    this.stateCallbacks.push(cb);
    return () => {
      this.stateCallbacks = this.stateCallbacks.filter(c => c !== cb);
    };
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  getConnectionPhase(): ConnectionPhase {
    return this.connectionPhase;
  }

  // ── Auth ──

  private async obtainJWT(): Promise<void> {
    // Prefer the user's login JWT (contains user_id for quota tracking).
    // Fall back to anonymous /auth/token only if no login token exists.
    const { getAuthToken } = await import('@/features/auth/auth');
    const loginToken = getAuthToken();

    if (loginToken) {
      this.jwt = loginToken;
      // Login JWTs have 24h TTL; schedule refresh well before that.
      this.jwtExpiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
      return;
    }

    const url = `${this.config.backendUrl}/api/v1/auth/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Auth failed (${res.status}): ${body.error || res.statusText}`);
    }

    const data: { token: string; expires_at: string } = await res.json();
    this.jwt = data.token;
    this.jwtExpiresAt = new Date(data.expires_at);
  }

  // ── Session ──

  private async createSession(): Promise<void> {
    if (!this.jwt) throw new Error('No JWT token');

    const url = `${this.config.backendUrl}/api/v1/sessions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.jwt}`,
      },
      body: JSON.stringify({
        model: this.config.model || '',
        db_context: { db_name: 'postgresql', db_version: '' },
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Session creation failed (${res.status}): ${body.error || res.statusText}`);
    }

    const data: { session_id: string; ws_url: string } = await res.json();
    this.sessionId = data.session_id;
    this.wsUrl = data.ws_url;
  }

  // ── WebSocket ──

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.wsUrl || !this.jwt) {
        reject(new Error('Missing ws_url or JWT'));
        return;
      }

      const wsUrlWithToken = `${this.wsUrl}?token=${encodeURIComponent(this.jwt)}`;
      const ws = new WebSocket(wsUrlWithToken);

      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };

      ws.onerror = () => {
        reject(new Error('WebSocket connection error'));
      };

      ws.onclose = (event) => {
        this.ws = null;
        if (!this.intentionalClose) {
          this.handleUnexpectedClose(event);
        }
      };

      ws.onmessage = (event) => {
        this.handleMessage(event);
      };
    });
  }

  // ── Message handling ──

  private handleMessage(event: MessageEvent): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      log.error('Failed to parse message:', event.data);
      return;
    }

    // tool.call messages use call_id, not request_id for routing
    if (envelope.type === 'tool.call') {
      this.handleToolCall(envelope);
      return;
    }

    // Server push notifications (no request_id)
    const notificationTypes: NotificationType[] = ['quota.warning', 'quota.exhausted', 'balance.low'];
    if (notificationTypes.includes(envelope.type as NotificationType)) {
      const notification: ServerNotification = {
        type: envelope.type as NotificationType,
        payload: envelope.payload as Record<string, unknown>,
      };
      for (const cb of this.notificationCallbacks) {
        try { cb(notification); } catch (e) { log.error('Notification callback error:', e); }
      }
      return;
    }

    const requestId = envelope.request_id;
    if (!requestId) return;

    const callbacks = this.pendingRequests.get(requestId);
    if (!callbacks) return;

    switch (envelope.type) {
      case 'agent.stream': {
        const payload = envelope.payload as AgentStreamPayload;
        callbacks.onStream?.(payload.delta);
        break;
      }
      case 'agent.response': {
        const payload = envelope.payload as AgentResponsePayload;
        callbacks.onResponse?.(payload);
        this.pendingRequests.delete(requestId);
        break;
      }
      case 'agent.error': {
        const payload = envelope.payload as AgentErrorPayload;
        callbacks.onError?.(payload);
        this.pendingRequests.delete(requestId);
        break;
      }
      case 'autocomplete.response': {
        const payload = envelope.payload as { completion: string };
        this.autocompleteCallback?.(payload.completion);
        this.pendingRequests.delete(requestId);
        break;
      }
    }
  }

  // ── Tool call handling ──

  private async handleToolCall(envelope: Envelope): Promise<void> {
    const callId = envelope.call_id;
    const requestId = envelope.request_id;
    const payload = envelope.payload as ToolCallPayload;

    log.debug(`tool.call received: ${payload.tool_name} (call_id=${callId})`);

    if (!this.toolCallHandler) {
      log.error('No tool call handler registered — sending error result');
      this.sendToolResult(requestId, callId, {
        success: false,
        error: 'No tool call handler registered on client',
      });
      return;
    }

    try {
      const result = await this.toolCallHandler(payload.tool_name, payload.arguments);
      log.debug(`tool.call completed: ${payload.tool_name} success=${result.success}`);
      this.sendToolResult(requestId, callId, result);
    } catch (err: unknown) {
      log.error(`tool.call failed: ${payload.tool_name}`, err);
      this.sendToolResult(requestId, callId, {
        success: false,
        error: err instanceof Error ? err.message : 'Tool execution failed',
      });
    }
  }

  private sendToolResult(requestId: string | undefined, callId: string | undefined, payload: ToolResultPayload): void {
    if (!this.ws) {
      log.error('Cannot send tool.result — WebSocket not connected');
      return;
    }

    const envelope: Envelope = {
      type: 'tool.result',
      request_id: requestId,
      call_id: callId,
      payload,
    };

    this.ws.send(JSON.stringify(envelope));
  }

  // ── Reconnect ──

  private handleUnexpectedClose(_event: CloseEvent): void {
    // Guard against multiple simultaneous reconnect attempts
    if (this.reconnectTimer) return;

    this.setConnectionState('reconnecting');

    const baseDelay = this.config.reconnectBaseDelay!;
    const maxDelay = this.config.reconnectMaxDelay!;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt), maxDelay);
    this.reconnectAttempt++;

    log.warn(`WebSocket closed unexpectedly. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      // Don't reconnect if intentionally closed while timer was pending
      if (this.intentionalClose) return;

      try {
        // Re-auth if JWT is expired or about to expire
        if (!this.jwt || !this.jwtExpiresAt || new Date() >= this.jwtExpiresAt) {
          await this.obtainJWT();
        }
        await this.createSession();
        await this.connectWebSocket();
        this.reconnectAttempt = 0;
        this.scheduleJWTRefresh();
        this.setConnectionState('connected');
        log.info('WebSocket reconnected successfully');
      } catch (err) {
        log.warn(`Reconnect attempt ${this.reconnectAttempt} failed:`, err);
        // Schedule another attempt — handleUnexpectedClose will be called
        // from connectWebSocket's onclose/onerror, but if the error happens
        // before the WebSocket is created, we need to retry manually.
        if (!this.intentionalClose) {
          this.handleUnexpectedClose(_event);
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  // ── JWT Refresh ──

  /**
   * Schedule a proactive JWT refresh 5 minutes before expiry.
   * On success, silently updates the token. On failure, falls back to reconnect.
   */
  private scheduleJWTRefresh(): void {
    this.clearJWTRefreshTimer();
    if (!this.jwtExpiresAt) return;

    const now = Date.now();
    const expiresAt = this.jwtExpiresAt.getTime();
    // Refresh 5 minutes before expiry, minimum 10 seconds from now
    const refreshIn = Math.max(expiresAt - now - 5 * 60 * 1000, 10_000);

    log.debug(`JWT refresh scheduled in ${Math.round(refreshIn / 1000)}s`);

    this.jwtRefreshTimer = setTimeout(async () => {
      if (this.intentionalClose || this.connectionState !== 'connected') return;
      try {
        await this.obtainJWT();
        log.debug('JWT refreshed transparently');
        this.scheduleJWTRefresh();
      } catch {
        log.warn('JWT refresh failed, connection will re-authenticate on next reconnect');
      }
    }, refreshIn);
  }

  private clearJWTRefreshTimer(): void {
    if (this.jwtRefreshTimer) {
      clearTimeout(this.jwtRefreshTimer);
      this.jwtRefreshTimer = null;
    }
  }

  // ── State ──

  private setConnectionState(state: ConnectionState, phase?: ConnectionPhase): void {
    const newPhase = phase || (state === 'disconnected' ? 'idle' : state === 'connected' ? 'connected' : this.connectionPhase);
    const stateChanged = this.connectionState !== state;
    const phaseChanged = this.connectionPhase !== newPhase;
    if (!stateChanged && !phaseChanged) return;
    this.connectionState = state;
    this.connectionPhase = newPhase;
    this.stateCallbacks.forEach(cb => cb(state, newPhase));
  }
}
