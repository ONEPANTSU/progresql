import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ChatPanel from '../components/ChatPanel';
import { AgentContextValue } from '../contexts/AgentContext';

// ── Mocks ──

const mockAgentValue: AgentContextValue = {
  connectionState: 'connected',
  connectionPhase: 'connected',
  isConnected: true,
  isAuthError: false,
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  sendRequest: jest.fn().mockReturnValue('req-1'),
  cancelRequest: jest.fn(),
  sessionId: 'session-123',
  error: null,
  backendUrl: 'http://localhost:8080',
  setBackendUrl: jest.fn(),
  model: '',
  setModel: jest.fn(),
  autocompleteModel: 'openai/gpt-4o-mini',
  setAutocompleteModel: jest.fn(),
  safeMode: true,
  setSafeMode: jest.fn(),
  securityMode: 'safe' as const,
  setSecurityMode: jest.fn(),
  sendAutocomplete: jest.fn(),
  cancelAutocomplete: jest.fn(),
  usage: null,
  refreshUsage: jest.fn(),
  lastNotification: null,
};

jest.mock('../contexts/AgentContext', () => ({
  useAgent: () => mockAgentValue,
}));

jest.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({
    language: 'en',
    setLanguage: jest.fn(),
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat.backendUnavailable': 'Backend unavailable. Reconnecting...',
        'chat.dbNotConnected': 'Database not connected. Connect to PostgreSQL to use AI tools.',
        'chat.emptyState': 'Send a message to start a conversation',
        'chat.input.placeholder': 'Ask a question about your database\u2026',
        'chat.input.backendUnavailable': 'Backend unavailable\u2026',
        'chat.input.send': 'Send message',
        'chat.settings': 'Settings',
        'chat.clearHistory': 'Clear history',
        'chat.newChat': 'Create new chat',
        'chat.closeChat': 'Close chat',
        'chat.scrollTabs': 'Scroll tabs',
        'chat.configureApiKey': 'Configure the backend API key in settings.',
        'chat.authError': 'Invalid API key. Click to open settings.',
      };
      return translations[key] || key;
    },
  }),
}));

jest.mock('../contexts/NotificationContext', () => ({
  useNotifications: () => ({
    showNotification: jest.fn(),
    showSuccess: jest.fn(),
    showError: jest.fn(),
    showInfo: jest.fn(),
    showWarning: jest.fn(),
  }),
}));

jest.mock('../providers/AuthProvider', () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    refreshUser: jest.fn(),
  }),
}));

// Mock logger to prevent console noise
jest.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock highlight.js used by ChatMessage
jest.mock('highlight.js/lib/core', () => ({
  __esModule: true,
  default: {
    registerLanguage: jest.fn(),
    highlight: jest.fn(() => ({ value: 'SELECT 1' })),
  },
}));

jest.mock('highlight.js/lib/languages/sql', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('highlight.js/lib/languages/pgsql', () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe('ChatPanel', () => {
  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    onExecuteQuery: jest.fn(),
    onApplySQL: jest.fn(),
    isDatabaseConnected: true,
    onOpenSettings: jest.fn(),
  };

  beforeEach(() => {
    mockAgentValue.isConnected = true;
    mockAgentValue.connectionState = 'connected';
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(<ChatPanel {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the AI Assistant header when open', () => {
    render(<ChatPanel {...defaultProps} />);
    // Header uses t('chat.title') — key is returned as-is by mock
    expect(screen.getByText('chat.title')).toBeInTheDocument();
  });

  it('renders panel with a model set in agent context', () => {
    mockAgentValue.model = 'qwen/qwen3-coder-next';
    const { container } = render(<ChatPanel {...defaultProps} />);
    // Panel should still render with any model value
    expect(container.querySelector('[aria-label="AI Assistant panel"]')).toBeInTheDocument();
    mockAgentValue.model = '';
  });

  it('renders panel without a model set', () => {
    mockAgentValue.model = '';
    const { container } = render(<ChatPanel {...defaultProps} />);
    expect(container.querySelector('[aria-label="AI Assistant panel"]')).toBeInTheDocument();
  });

  it('shows backend unavailable alert when disconnected', () => {
    mockAgentValue.isConnected = false;
    mockAgentValue.connectionState = 'disconnected';
    render(<ChatPanel {...defaultProps} />);
    expect(screen.getByText(/Backend unavailable/)).toBeInTheDocument();
  });

  it('shows database info when agent is connected but DB is not', () => {
    render(<ChatPanel {...defaultProps} isDatabaseConnected={false} />);
    expect(screen.getByText(/Connect to PostgreSQL/)).toBeInTheDocument();
  });

  it('shows empty state message when no messages exist', () => {
    render(<ChatPanel {...defaultProps} />);
    expect(screen.getByText(/Send a message to start/)).toBeInTheDocument();
  });

  it('has a text input field for typing messages', () => {
    render(<ChatPanel {...defaultProps} />);
    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
  });

  it('allows typing in the input field', () => {
    render(<ChatPanel {...defaultProps} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'SELECT * FROM users' } });
    expect(input).toHaveValue('SELECT * FROM users');
  });

  it('has a send button', () => {
    render(<ChatPanel {...defaultProps} />);
    // Send button is an IconButton with SendIcon
    const buttons = screen.getAllByRole('button');
    const sendButton = buttons.find(btn => btn.querySelector('svg[data-testid="SendIcon"]'));
    expect(sendButton).toBeDefined();
  });

  it('disables send button when input is empty', () => {
    render(<ChatPanel {...defaultProps} />);
    const buttons = screen.getAllByRole('button');
    const sendButton = buttons.find(btn => btn.querySelector('svg[data-testid="SendIcon"]'));
    expect(sendButton).toBeDisabled();
  });

  it('shows settings button when onOpenSettings is provided', () => {
    render(<ChatPanel {...defaultProps} />);
    const settingsButton = screen.getAllByRole('button').find(
      btn => btn.querySelector('svg[data-testid="SettingsIcon"]')
    );
    expect(settingsButton).toBeDefined();
  });
});
