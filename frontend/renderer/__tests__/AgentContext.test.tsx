import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { AgentProvider, useAgent, AgentContextValue } from '../contexts/AgentContext';
import { AuthProvider } from '../providers/AuthProvider';

// ── Mock AgentService ──

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn();
const mockSendRequest = jest.fn().mockReturnValue('req-1');
const mockCancelRequest = jest.fn();
const mockGetSessionId = jest.fn().mockReturnValue('session-abc');
const mockOnConnectionStateChange = jest.fn().mockReturnValue(jest.fn());
const mockSetToolCallHandler = jest.fn();

const mockUpdateModel = jest.fn();

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

// Helper component that exposes context values for testing
function TestConsumer({ onValue }: { onValue: (v: AgentContextValue) => void }) {
  const value = useAgent();
  React.useEffect(() => {
    onValue(value);
  });
  return (
    <div>
      <span data-testid="state">{value.connectionState}</span>
      <span data-testid="connected">{String(value.isConnected)}</span>
      <span data-testid="backend-url">{value.backendUrl}</span>
      <span data-testid="model">{value.model}</span>
      <span data-testid="error">{value.error ?? 'none'}</span>
      <span data-testid="session">{value.sessionId ?? 'none'}</span>
    </div>
  );
}

describe('AgentContext', () => {
  let capturedValue: AgentContextValue;

  const renderWithProvider = () => {
    return render(
      <AuthProvider>
        <AgentProvider>
          <TestConsumer onValue={(v) => { capturedValue = v; }} />
        </AgentProvider>
      </AuthProvider>
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    localStorage.clear();
  });

  it('provides default values', () => {
    renderWithProvider();

    expect(screen.getByTestId('backend-url').textContent).toBe('https://progresql.com');
    expect(screen.getByTestId('model').textContent).toBe('qwen/qwen3-coder');
  });

  it('starts in disconnected state', () => {
    renderWithProvider();

    expect(screen.getByTestId('state').textContent).toBe('disconnected');
    expect(screen.getByTestId('connected').textContent).toBe('false');
  });

  it('creates AgentService on mount', () => {
    const { AgentService } = require('../services/agent/AgentService');
    renderWithProvider();

    expect(AgentService).toHaveBeenCalledWith({
      backendUrl: 'https://progresql.com',
      model: 'qwen/qwen3-coder',
    });
  });

  it('does not auto-connect when no user is logged in', () => {
    // Without a logged-in user, connect should NOT be called.
    renderWithProvider();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('registers tool call handler', () => {
    renderWithProvider();
    expect(mockSetToolCallHandler).toHaveBeenCalled();
  });

  it('subscribes to connection state changes', () => {
    renderWithProvider();
    expect(mockOnConnectionStateChange).toHaveBeenCalled();
  });

  it('transitions to connected state when service reports connected', () => {
    renderWithProvider();

    const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];

    act(() => {
      stateCallback('connected');
    });

    expect(screen.getByTestId('state').textContent).toBe('connected');
    expect(screen.getByTestId('connected').textContent).toBe('true');
    expect(screen.getByTestId('session').textContent).toBe('session-abc');
  });

  it('clears session on disconnect', () => {
    renderWithProvider();

    const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];

    act(() => {
      stateCallback('connected');
    });
    expect(screen.getByTestId('session').textContent).toBe('session-abc');

    act(() => {
      stateCallback('disconnected');
    });
    expect(screen.getByTestId('session').textContent).toBe('none');
  });

  it('persists backendUrl to localStorage', () => {
    renderWithProvider();

    act(() => {
      capturedValue.setBackendUrl('http://example.com:9090');
    });

    expect(localStorage.getItem('progresql-agent-backend-url')).toBe('http://example.com:9090');
  });

  it('persists model to localStorage', () => {
    renderWithProvider();

    act(() => {
      capturedValue.setModel('anthropic/claude-3');
    });

    // Model is stored under a user-scoped key (userKey returns 'user_agent-model' in tests)
    expect(localStorage.getItem('user_agent-model')).toBe('anthropic/claude-3');
  });

  it('calls disconnect on service when disconnect is called', () => {
    renderWithProvider();

    act(() => {
      capturedValue.disconnect();
    });

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('sendRequest delegates to AgentService', () => {
    renderWithProvider();

    const callbacks = {
      onStream: jest.fn(),
      onResponse: jest.fn(),
      onError: jest.fn(),
    };

    const payload = {
      action: 'generate_sql' as const,
      user_message: 'get all users',
    };

    act(() => {
      const id = capturedValue.sendRequest(payload, callbacks);
      // Without a logged-in user with active subscription, request will be blocked
      // so we expect either the subscription error or the delegated call
      // Since no user is logged in, subscription check will block it
      expect(id).toBe('');
    });

    // The error callback should be called with subscription_expired
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'subscription_expired' })
    );
  });

  it('throws when useAgent is used outside provider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(
        <AuthProvider>
          <TestConsumer onValue={jest.fn()} />
        </AuthProvider>
      );
    }).toThrow('useAgent must be used within AgentProvider');

    spy.mockRestore();
  });

  it('cleans up on unmount', () => {
    const { unmount } = renderWithProvider();

    const unsubscribe = mockOnConnectionStateChange.mock.results[0].value;

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
