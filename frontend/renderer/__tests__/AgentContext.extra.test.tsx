/*
* Created on Mar 28, 2026
* Test file for AgentContext.tsx (extended coverage)
* File path: renderer/__tests__/AgentContext.extra.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { AgentProvider, useAgent, AgentContextValue } from '../contexts/AgentContext';
import { AuthProvider } from '../providers/AuthProvider';

// ── Mock AgentService ──────────────────────────────────────────────────────────

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn();
const mockSendRequest = jest.fn().mockReturnValue('req-extra-1');
const mockCancelRequest = jest.fn();
const mockGetSessionId = jest.fn().mockReturnValue('session-extra');
const mockOnConnectionStateChange = jest.fn().mockReturnValue(jest.fn());
const mockSetToolCallHandler = jest.fn();
const mockUpdateModel = jest.fn();
const mockSendAutocomplete = jest.fn();
const mockCancelAutocomplete = jest.fn();

jest.mock('../services/agent/AgentService', () => ({
  AgentService: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    sendRequest: mockSendRequest,
    cancelRequest: mockCancelRequest,
    getSessionId: mockGetSessionId,
    onConnectionStateChange: mockOnConnectionStateChange,
    setToolCallHandler: mockSetToolCallHandler,
    updateModel: mockUpdateModel,
    sendAutocomplete: mockSendAutocomplete,
    cancelAutocomplete: mockCancelAutocomplete,
    onNotification: jest.fn().mockReturnValue(jest.fn()),
  })),
}));

jest.mock('../services/agent/toolHandler', () => ({
  handleToolCall: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../utils/userStorage', () => ({
  migrateToUserStorage: jest.fn(),
  userKey: jest.fn((suffix: string) => `user_${suffix}`),
  getCurrentUserId: jest.fn(() => null),
  setCurrentUser: jest.fn(),
  removeCurrentUser: jest.fn(),
}));

// ── Helper component ───────────────────────────────────────────────────────────

function TestConsumer({ onValue }: { onValue: (v: AgentContextValue) => void }) {
  const value = useAgent();
  React.useEffect(() => {
    onValue(value);
  });
  return (
    <div>
      <span data-testid="state">{value.connectionState}</span>
      <span data-testid="phase">{value.connectionPhase}</span>
      <span data-testid="connected">{String(value.isConnected)}</span>
      <span data-testid="auth-error">{String(value.isAuthError)}</span>
      <span data-testid="backend-url">{value.backendUrl}</span>
      <span data-testid="model">{value.model}</span>
      <span data-testid="security-mode">{value.securityMode}</span>
      <span data-testid="safe-mode">{String(value.safeMode)}</span>
      <span data-testid="error">{value.error ?? 'none'}</span>
      <span data-testid="session">{value.sessionId ?? 'none'}</span>
    </div>
  );
}

// ── Render helper ──────────────────────────────────────────────────────────────

function renderWithProvider() {
  let capturedValue: AgentContextValue = null as any;
  const result = render(
    <AuthProvider>
      <AgentProvider>
        <TestConsumer onValue={(v) => { capturedValue = v; }} />
      </AgentProvider>
    </AuthProvider>
  );
  return { ...result, getCaptured: () => capturedValue };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AgentContext (extended coverage)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockOnConnectionStateChange.mockReturnValue(jest.fn());
    localStorage.clear();
  });

  // ── Connection phase tracking ────────────────────────────────────────────────

  describe('connectionPhase tracking', () => {
    it('starts with idle phase', () => {
      renderWithProvider();
      expect(screen.getByTestId('phase').textContent).toBe('idle');
    });

    it('updates connectionPhase when state callback receives a phase argument', () => {
      renderWithProvider();
      const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];
      act(() => {
        stateCallback('connecting', 'authorizing');
      });
      expect(screen.getByTestId('phase').textContent).toBe('authorizing');
    });

    it('does not update connectionPhase when phase argument is undefined', () => {
      renderWithProvider();
      const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];
      act(() => {
        stateCallback('connecting', undefined);
      });
      // phase stays at 'idle'
      expect(screen.getByTestId('phase').textContent).toBe('idle');
    });

    it('updates phase to connected when connected state fires', () => {
      renderWithProvider();
      const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];
      act(() => {
        stateCallback('connected', 'connected');
      });
      expect(screen.getByTestId('phase').textContent).toBe('connected');
    });
  });

  // ── isAuthError flag ─────────────────────────────────────────────────────────

  describe('isAuthError flag', () => {
    it('starts as false', () => {
      renderWithProvider();
      expect(screen.getByTestId('auth-error').textContent).toBe('false');
    });

    it('is cleared to false when connected state fires', () => {
      renderWithProvider();
      const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];
      act(() => {
        stateCallback('connected');
      });
      expect(screen.getByTestId('auth-error').textContent).toBe('false');
    });
  });

  // ── connect() method ─────────────────────────────────────────────────────────

  describe('connect()', () => {
    it('resolves without error when service.connect succeeds', async () => {
      const { getCaptured } = renderWithProvider();
      mockConnect.mockResolvedValue(undefined);
      await act(async () => {
        await getCaptured().connect();
      });
      expect(mockConnect).toHaveBeenCalled();
    });

    it('sets error and rethrows when service.connect throws', async () => {
      const { getCaptured } = renderWithProvider();
      mockConnect.mockRejectedValue(new Error('Connection refused'));
      let caught: Error | null = null;
      await act(async () => {
        try {
          await getCaptured().connect();
        } catch (e) {
          caught = e as Error;
        }
      });
      expect(caught).not.toBeNull();
      expect(caught!.message).toBe('Connection refused');
      expect(screen.getByTestId('error').textContent).toBe('Connection refused');
    });

    it('sets generic error message when connect throws non-Error', async () => {
      const { getCaptured } = renderWithProvider();
      mockConnect.mockRejectedValue('string-error');
      let caught: unknown = null;
      await act(async () => {
        try {
          await getCaptured().connect();
        } catch (e) {
          caught = e;
        }
      });
      expect(caught).not.toBeNull();
      expect(screen.getByTestId('error').textContent).toBe('Failed to connect to agent backend');
    });

    it('clears error before attempting connect', async () => {
      const { getCaptured } = renderWithProvider();
      // First fail to set an error
      mockConnect.mockRejectedValue(new Error('First error'));
      await act(async () => {
        try { await getCaptured().connect(); } catch {}
      });
      expect(screen.getByTestId('error').textContent).toBe('First error');
      // Now succeed
      mockConnect.mockResolvedValue(undefined);
      await act(async () => {
        await getCaptured().connect();
      });
      // Error is cleared at start of connect
      expect(screen.getByTestId('error').textContent).toBe('none');
    });
  });

  // ── disconnect() method ──────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('calls service.disconnect', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().disconnect();
      });
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('clears error state on disconnect', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().disconnect();
      });
      expect(screen.getByTestId('error').textContent).toBe('none');
    });
  });

  // ── model update ─────────────────────────────────────────────────────────────

  describe('model updates', () => {
    it('setModel persists to localStorage', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setModel('openai/gpt-4');
      });
      expect(localStorage.getItem('user_agent-model')).toBe('openai/gpt-4');
    });

    it('setModel reflects new value in context', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setModel('openai/gpt-4');
      });
      expect(screen.getByTestId('model').textContent).toBe('openai/gpt-4');
    });

    it('calls updateModel on service when model changes', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setModel('anthropic/claude-3');
      });
      expect(mockUpdateModel).toHaveBeenCalledWith('anthropic/claude-3');
    });
  });

  // ── securityMode / safeMode ──────────────────────────────────────────────────

  describe('securityMode and safeMode', () => {
    it('starts with safe mode (securityMode=safe)', () => {
      renderWithProvider();
      expect(screen.getByTestId('security-mode').textContent).toBe('safe');
      expect(screen.getByTestId('safe-mode').textContent).toBe('true');
    });

    it('setSecurityMode to execute changes securityMode and safeMode=false', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setSecurityMode('execute');
      });
      expect(screen.getByTestId('security-mode').textContent).toBe('execute');
      expect(screen.getByTestId('safe-mode').textContent).toBe('false');
    });

    it('setSecurityMode to data changes securityMode', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setSecurityMode('data');
      });
      expect(screen.getByTestId('security-mode').textContent).toBe('data');
    });

    it('setSafeMode(false) maps to securityMode=execute', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setSafeMode(false);
      });
      expect(screen.getByTestId('security-mode').textContent).toBe('execute');
    });

    it('setSafeMode(true) maps to securityMode=safe', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setSafeMode(false);
      });
      act(() => {
        getCaptured().setSafeMode(true);
      });
      expect(screen.getByTestId('security-mode').textContent).toBe('safe');
    });

    it('setSecurityMode persists to localStorage', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setSecurityMode('data');
      });
      expect(localStorage.getItem('user_agent-security-mode')).toBe('data');
    });
  });

  // ── backendUrl update ────────────────────────────────────────────────────────

  describe('backendUrl updates', () => {
    it('setBackendUrl updates state', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setBackendUrl('http://new-backend.example.com');
      });
      expect(screen.getByTestId('backend-url').textContent).toBe('http://new-backend.example.com');
    });

    it('setBackendUrl persists to localStorage', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().setBackendUrl('http://saved-url.example.com');
      });
      expect(localStorage.getItem('progresql-agent-backend-url')).toBe('http://saved-url.example.com');
    });
  });

  // ── sendRequest ──────────────────────────────────────────────────────────────

  describe('sendRequest', () => {
    it('returns empty string and calls onError when subscription is inactive (no user)', () => {
      const { getCaptured } = renderWithProvider();
      const onError = jest.fn();
      let result: string = 'initial';
      act(() => {
        result = getCaptured().sendRequest(
          { action: 'generate_sql', user_message: 'test' },
          { onError }
        );
      });
      expect(result).toBe('');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'subscription_expired' })
      );
    });

    it('delegates to service when subscription is active', () => {
      // Inject a user with active subscription via localStorage + AuthProvider behavior
      // Since AuthProvider reads from auth service, we set a pro user with future expiry
      const TOKEN_KEY = 'progresql-auth-token';
      const CURRENT_USER_KEY = 'progresql-current-user';
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      localStorage.setItem(TOKEN_KEY, 'valid-token');
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({
        id: 'u1',
        email: 'sub@example.com',
        name: 'Sub User',
        plan: 'pro',
        planExpiresAt: futureDate,
      }));

      const { getCaptured } = renderWithProvider();
      const onError = jest.fn();
      let result: string = '';
      act(() => {
        result = getCaptured().sendRequest(
          { action: 'generate_sql', user_message: 'SELECT 1' },
          { onError }
        );
      });
      // With active subscription, service.sendRequest should be called
      expect(mockSendRequest).toHaveBeenCalled();
      expect(result).toBe('req-extra-1');
    });
  });

  // ── cancelRequest ────────────────────────────────────────────────────────────

  describe('cancelRequest', () => {
    it('delegates cancelRequest to service', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().cancelRequest('req-abc');
      });
      expect(mockCancelRequest).toHaveBeenCalledWith('req-abc');
    });
  });

  // ── sendAutocomplete / cancelAutocomplete ────────────────────────────────────

  describe('autocomplete', () => {
    it('sendAutocomplete delegates to service', () => {
      const { getCaptured } = renderWithProvider();
      const cb = jest.fn();
      act(() => {
        getCaptured().sendAutocomplete('SELECT', 6, 'schema ctx', cb);
      });
      expect(mockSendAutocomplete).toHaveBeenCalledWith('SELECT', 6, 'schema ctx', cb, 'openai/gpt-4o-mini');
    });

    it('cancelAutocomplete delegates to service', () => {
      const { getCaptured } = renderWithProvider();
      act(() => {
        getCaptured().cancelAutocomplete();
      });
      expect(mockCancelAutocomplete).toHaveBeenCalled();
    });
  });

  // ── sessionId tracking ───────────────────────────────────────────────────────

  describe('sessionId tracking', () => {
    it('session is none initially', () => {
      renderWithProvider();
      expect(screen.getByTestId('session').textContent).toBe('none');
    });

    it('session id is populated when connected state fires', () => {
      renderWithProvider();
      const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];
      act(() => {
        stateCallback('connected');
      });
      expect(screen.getByTestId('session').textContent).toBe('session-extra');
    });

    it('session id is cleared when disconnected state fires', () => {
      renderWithProvider();
      const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];
      act(() => { stateCallback('connected'); });
      act(() => { stateCallback('disconnected'); });
      expect(screen.getByTestId('session').textContent).toBe('none');
    });
  });

  // ── Cleanup on unmount ───────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('calls unsubscribe and disconnect on unmount', () => {
      const { unmount } = renderWithProvider();
      const unsubscribe = mockOnConnectionStateChange.mock.results[0].value;
      unmount();
      expect(unsubscribe).toHaveBeenCalled();
      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  // ── error state display ──────────────────────────────────────────────────────

  describe('error state', () => {
    it('error is none by default', () => {
      renderWithProvider();
      expect(screen.getByTestId('error').textContent).toBe('none');
    });

    it('error is set on connect failure', async () => {
      const { getCaptured } = renderWithProvider();
      mockConnect.mockRejectedValue(new Error('Backend down'));
      await act(async () => {
        try { await getCaptured().connect(); } catch {}
      });
      expect(screen.getByTestId('error').textContent).toBe('Backend down');
    });

    it('error is cleared on successful connect', async () => {
      const { getCaptured } = renderWithProvider();
      // First fail
      mockConnect.mockRejectedValue(new Error('Fail'));
      await act(async () => {
        try { await getCaptured().connect(); } catch {}
      });
      expect(screen.getByTestId('error').textContent).toBe('Fail');
      // Then succeed
      mockConnect.mockResolvedValue(undefined);
      await act(async () => {
        await getCaptured().connect();
      });
      // connected state callback would clear error via setError(null)
      const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];
      act(() => { stateCallback('connected'); });
      expect(screen.getByTestId('error').textContent).toBe('none');
    });
  });
});
