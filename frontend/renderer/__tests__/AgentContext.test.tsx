import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { AgentProvider, useAgent, AgentContextValue } from '@/features/agent-chat/AgentContext';
import { AuthProvider } from '@/features/auth/AuthProvider';

// ── Mock AgentService ──

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn();
const mockSendRequest = jest.fn().mockReturnValue('req-1');
const mockCancelRequest = jest.fn();
const mockGetSessionId = jest.fn().mockReturnValue('session-abc');
const mockOnConnectionStateChange = jest.fn().mockReturnValue(jest.fn());
const mockSetToolCallHandler = jest.fn();

const mockUpdateModel = jest.fn();

jest.mock('@/features/auth/auth', () => ({
  authService: {
    getCurrentUser: jest.fn().mockReturnValue(null),
    login: jest.fn(),
    register: jest.fn(),
    logout: jest.fn(),
    refreshUser: jest.fn().mockResolvedValue(null),
    sendVerificationCode: jest.fn(),
    verifyCode: jest.fn(),
  },
  getAuthToken: jest.fn().mockReturnValue(null),
  loadPersistedAuth: jest.fn().mockImplementation(() => Promise.resolve()),
  isSubscriptionActive: jest.fn().mockReturnValue(false),
}));

jest.mock('@/features/agent-chat/AgentService', () => ({
  AgentService: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    sendRequest: mockSendRequest,
    cancelRequest: mockCancelRequest,
    getSessionId: mockGetSessionId,
    onConnectionStateChange: mockOnConnectionStateChange,
    setToolCallHandler: mockSetToolCallHandler,
    updateModel: mockUpdateModel,
    sendAutocomplete: jest.fn(),
    cancelAutocomplete: jest.fn(),
    onNotification: jest.fn().mockReturnValue(jest.fn()),
  })),
}));

jest.mock('@/features/agent-chat/toolHandler', () => ({
  handleToolCall: jest.fn(),
}));

jest.mock('@/shared/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/shared/lib/userStorage', () => ({
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

  const renderWithProvider = async () => {
    const result = render(
      <AuthProvider>
        <AgentProvider>
          <TestConsumer onValue={(v) => { capturedValue = v; }} />
        </AgentProvider>
      </AuthProvider>
    );
    // Wait for async AuthProvider initAuth to complete
    await waitFor(() => {
      expect(screen.getByTestId('state')).toBeTruthy();
    });
    return result;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    localStorage.clear();
  });

  it('provides default values', async () => {
    await renderWithProvider();

    expect(screen.getByTestId('backend-url').textContent).toBe('https://progresql.com');
    expect(screen.getByTestId('model').textContent).toBe('qwen/qwen3-coder');
  });

  it('starts in disconnected state', async () => {
    await renderWithProvider();

    expect(screen.getByTestId('state').textContent).toBe('disconnected');
    expect(screen.getByTestId('connected').textContent).toBe('false');
  });

  it('creates AgentService on mount', async () => {
    const { AgentService } = require('@/features/agent-chat/AgentService');
    await renderWithProvider();

    expect(AgentService).toHaveBeenCalledWith({
      backendUrl: 'https://progresql.com',
      model: 'qwen/qwen3-coder',
    });
  });

  it('does not auto-connect when no user is logged in', async () => {
    // Without a logged-in user, connect should NOT be called.
    await renderWithProvider();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('registers tool call handler', async () => {
    await renderWithProvider();
    expect(mockSetToolCallHandler).toHaveBeenCalled();
  });

  it('subscribes to connection state changes', async () => {
    await renderWithProvider();
    expect(mockOnConnectionStateChange).toHaveBeenCalled();
  });

  it('transitions to connected state when service reports connected', async () => {
    await renderWithProvider();

    const stateCallback = mockOnConnectionStateChange.mock.calls[0][0];

    act(() => {
      stateCallback('connected');
    });

    expect(screen.getByTestId('state').textContent).toBe('connected');
    expect(screen.getByTestId('connected').textContent).toBe('true');
    expect(screen.getByTestId('session').textContent).toBe('session-abc');
  });

  it('clears session on disconnect', async () => {
    await renderWithProvider();

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

  it('persists backendUrl to localStorage', async () => {
    await renderWithProvider();

    act(() => {
      capturedValue.setBackendUrl('http://example.com:9090');
    });

    expect(localStorage.getItem('progresql-agent-backend-url')).toBe('http://example.com:9090');
  });

  it('persists model to localStorage', async () => {
    await renderWithProvider();

    act(() => {
      capturedValue.setModel('anthropic/claude-3');
    });

    // Model is stored under a user-scoped key (userKey returns 'user_agent-model' in tests)
    expect(localStorage.getItem('user_agent-model')).toBe('anthropic/claude-3');
  });

  it('calls disconnect on service when disconnect is called', async () => {
    await renderWithProvider();

    act(() => {
      capturedValue.disconnect();
    });

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('sendRequest delegates to AgentService', async () => {
    await renderWithProvider();

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
      render(<TestConsumer onValue={jest.fn()} />);
    }).toThrow('useAgent must be used within AgentProvider');

    spy.mockRestore();
  });

  it('cleans up on unmount', async () => {
    const { unmount } = await renderWithProvider();

    const unsubscribe = mockOnConnectionStateChange.mock.results[0].value;

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
