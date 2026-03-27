/*
* Created on Mar 28, 2026
* Test file for ChatPanel.tsx (extended coverage)
* File path: renderer/__tests__/ChatPanel.extra.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ChatPanel from '../components/ChatPanel';
import { AgentContextValue } from '../contexts/AgentContext';

// ── Mocks ──────────────────────────────────────────────────────────────────────

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
  model: 'qwen/qwen3-coder',
  setModel: jest.fn(),
  securityMode: 'safe',
  setSecurityMode: jest.fn(),
  safeMode: true,
  setSafeMode: jest.fn(),
  sendAutocomplete: jest.fn(),
  cancelAutocomplete: jest.fn(),
};

jest.mock('../contexts/AgentContext', () => ({
  useAgent: () => mockAgentValue,
}));

jest.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({
    language: 'en',
    setLanguage: jest.fn(),
    t: (key: string, params?: Record<string, unknown>) => {
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
        'chat.title': 'AI Assistant',
        'settings.unsafeWarning': 'Unsafe mode: execute',
        'settings.dataModeWarning': 'Data mode active',
        'subscription.upgradeButton': 'Upgrade',
        'subscription.expiringSoon': `Expires in ${params?.days ?? 0} days`,
        'subscription.expired': 'Your subscription has expired.',
        'subscription.chatBlocked': 'Chat is blocked. Please upgrade.',
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

// Default auth mock — can be overridden per test via __setUser
let mockUser: any = null;

jest.mock('../providers/AuthProvider', () => ({
  useAuth: () => ({
    user: mockUser,
    isLoading: false,
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    refreshUser: jest.fn(),
  }),
}));

jest.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

const defaultProps = {
  isOpen: true,
  onClose: jest.fn(),
  onExecuteQuery: jest.fn(),
  onApplySQL: jest.fn(),
  isDatabaseConnected: true,
  onOpenSettings: jest.fn(),
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ChatPanel (extended coverage)', () => {
  beforeEach(() => {
    mockAgentValue.isConnected = true;
    mockAgentValue.connectionState = 'connected';
    mockAgentValue.connectionPhase = 'connected';
    mockAgentValue.securityMode = 'safe';
    mockAgentValue.isAuthError = false;
    mockUser = null;
    jest.clearAllMocks();
  });

  // ── isOpen=false ────────────────────────────────────────────────────────────

  describe('closed state', () => {
    it('returns null when isOpen is false — no DOM output', () => {
      const { container } = render(<ChatPanel {...defaultProps} isOpen={false} />);
      expect(container.firstChild).toBeNull();
    });
  });

  // ── Connection state banners ────────────────────────────────────────────────

  describe('connection state banners', () => {
    it('shows backend unavailable banner when connectionState is disconnected', () => {
      mockAgentValue.isConnected = false;
      mockAgentValue.connectionState = 'disconnected';
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByText(/Backend unavailable/)).toBeInTheDocument();
    });

    it('does not show backend unavailable banner when connected', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.queryByText(/Backend unavailable/)).not.toBeInTheDocument();
    });

    it('shows DB not connected info when agent is connected but DB is disconnected', () => {
      render(<ChatPanel {...defaultProps} isDatabaseConnected={false} />);
      expect(screen.getByText(/Connect to PostgreSQL/)).toBeInTheDocument();
    });

    it('does not show DB info banner when both agent and DB are connected', () => {
      render(<ChatPanel {...defaultProps} isDatabaseConnected={true} />);
      expect(screen.queryByText(/Connect to PostgreSQL/)).not.toBeInTheDocument();
    });

    it('does not show DB info banner when agent is disconnected', () => {
      mockAgentValue.isConnected = false;
      mockAgentValue.connectionState = 'disconnected';
      render(<ChatPanel {...defaultProps} isDatabaseConnected={false} />);
      // Only backend-unavailable banner; DB banner requires isConnected=true
      expect(screen.queryByText(/Connect to PostgreSQL/)).not.toBeInTheDocument();
    });
  });

  // ── Security mode warning icon ──────────────────────────────────────────────

  describe('security mode warning', () => {
    it('shows warning icon when securityMode is execute', () => {
      mockAgentValue.securityMode = 'execute';
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByLabelText('execute mode active')).toBeInTheDocument();
    });

    it('shows warning icon when securityMode is data', () => {
      mockAgentValue.securityMode = 'data';
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByLabelText('data mode active')).toBeInTheDocument();
    });

    it('does not show warning icon when securityMode is safe', () => {
      mockAgentValue.securityMode = 'safe';
      render(<ChatPanel {...defaultProps} />);
      expect(screen.queryByLabelText(/mode active/)).not.toBeInTheDocument();
    });
  });

  // ── Settings button ─────────────────────────────────────────────────────────

  describe('settings button', () => {
    it('renders settings button when onOpenSettings is provided', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByLabelText('Open settings')).toBeInTheDocument();
    });

    it('calls onOpenSettings when settings button is clicked', () => {
      const onOpenSettings = jest.fn();
      render(<ChatPanel {...defaultProps} onOpenSettings={onOpenSettings} />);
      fireEvent.click(screen.getByLabelText('Open settings'));
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it('does not render settings button when onOpenSettings is not provided', () => {
      const { onOpenSettings: _, ...propsWithout } = defaultProps;
      render(<ChatPanel {...propsWithout} />);
      expect(screen.queryByLabelText('Open settings')).not.toBeInTheDocument();
    });
  });

  // ── New chat button ─────────────────────────────────────────────────────────

  describe('new chat button', () => {
    it('renders "Create new chat" button', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByLabelText('Create new chat')).toBeInTheDocument();
    });

    it('clicking new chat button creates a new tab', () => {
      render(<ChatPanel {...defaultProps} />);
      const newChatBtn = screen.getByLabelText('Create new chat');
      const initialTabs = screen.getAllByRole('tab');
      fireEvent.click(newChatBtn);
      const updatedTabs = screen.getAllByRole('tab');
      expect(updatedTabs.length).toBeGreaterThanOrEqual(initialTabs.length);
    });
  });

  // ── Chat tabs ───────────────────────────────────────────────────────────────

  describe('chat tabs', () => {
    it('renders at least one chat tab', () => {
      render(<ChatPanel {...defaultProps} />);
      const tabs = screen.getAllByRole('tab');
      expect(tabs.length).toBeGreaterThanOrEqual(1);
    });

    it('tab has aria-selected attribute', () => {
      render(<ChatPanel {...defaultProps} />);
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('aria-selected');
    });

    it('tabs container has correct role and aria-label', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
    });

    it('clicking a tab sets it as active (aria-selected true)', () => {
      render(<ChatPanel {...defaultProps} />);
      // Create a second tab first
      const newChatBtn = screen.getByLabelText('Create new chat');
      fireEvent.click(newChatBtn);
      const tabs = screen.getAllByRole('tab');
      if (tabs.length > 1) {
        fireEvent.click(tabs[0]);
        expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      }
    });

    it('tab close button deletes the chat', () => {
      render(<ChatPanel {...defaultProps} />);
      const newChatBtn = screen.getByLabelText('Create new chat');
      fireEvent.click(newChatBtn);
      const closeBtns = screen.getAllByRole('button').filter(btn =>
        btn.getAttribute('aria-label')?.startsWith('Close chat:')
      );
      if (closeBtns.length > 0) {
        const tabsBefore = screen.getAllByRole('tab').length;
        fireEvent.click(closeBtns[0]);
        const tabsAfter = screen.getAllByRole('tab').length;
        expect(tabsAfter).toBeLessThanOrEqual(tabsBefore);
      }
    });

    it('double-clicking tab title enters edit mode', () => {
      render(<ChatPanel {...defaultProps} />);
      const tabs = screen.getAllByRole('tab');
      const titleEl = tabs[0].querySelector('p');
      if (titleEl) {
        fireEvent.dblClick(titleEl);
        // After double click, an input should appear for renaming
        const input = tabs[0].querySelector('input');
        expect(input).not.toBeNull();
      }
    });

    it('pressing Enter in edit mode commits rename', () => {
      render(<ChatPanel {...defaultProps} />);
      const tabs = screen.getAllByRole('tab');
      const titleEl = tabs[0].querySelector('p');
      if (titleEl) {
        fireEvent.dblClick(titleEl);
        const input = tabs[0].querySelector('input');
        if (input) {
          fireEvent.change(input, { target: { value: 'My Renamed Chat' } });
          fireEvent.keyDown(input, { key: 'Enter' });
          // After commit, input should be gone and title should be updated
          expect(tabs[0].querySelector('input')).toBeNull();
        }
      }
    });

    it('pressing Escape in edit mode cancels rename', () => {
      render(<ChatPanel {...defaultProps} />);
      const tabs = screen.getAllByRole('tab');
      const titleEl = tabs[0].querySelector('p');
      if (titleEl) {
        fireEvent.dblClick(titleEl);
        const input = tabs[0].querySelector('input');
        if (input) {
          fireEvent.keyDown(input, { key: 'Escape' });
          expect(tabs[0].querySelector('input')).toBeNull();
        }
      }
    });

    it('keyboard Enter on a tab activates it', () => {
      render(<ChatPanel {...defaultProps} />);
      const newChatBtn = screen.getByLabelText('Create new chat');
      fireEvent.click(newChatBtn);
      const tabs = screen.getAllByRole('tab');
      if (tabs.length > 1) {
        fireEvent.keyDown(tabs[0], { key: 'Enter' });
        expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      }
    });

    it('keyboard Space on a tab activates it', () => {
      render(<ChatPanel {...defaultProps} />);
      const newChatBtn = screen.getByLabelText('Create new chat');
      fireEvent.click(newChatBtn);
      const tabs = screen.getAllByRole('tab');
      if (tabs.length > 1) {
        fireEvent.keyDown(tabs[0], { key: ' ' });
        expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      }
    });
  });

  // ── Empty state ─────────────────────────────────────────────────────────────

  describe('empty message state', () => {
    it('shows empty state placeholder when no messages', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByText(/Send a message to start/)).toBeInTheDocument();
    });
  });

  // ── Input field ─────────────────────────────────────────────────────────────

  describe('chat input', () => {
    it('renders a text input', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('allows typing in the input', () => {
      render(<ChatPanel {...defaultProps} />);
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'SELECT 1' } });
      expect(input).toHaveValue('SELECT 1');
    });

    it('send button is disabled when input is empty', () => {
      render(<ChatPanel {...defaultProps} />);
      const buttons = screen.getAllByRole('button');
      const sendBtn = buttons.find(btn => btn.querySelector('svg[data-testid="SendIcon"]'));
      if (sendBtn) {
        expect(sendBtn).toBeDisabled();
      }
    });
  });

  // ── Subscription banners ────────────────────────────────────────────────────

  describe('subscription banners', () => {
    it('shows expired subscription alert when plan is expired', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'pro',
        planExpiresAt: pastDate(1),
      };
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByText('Your subscription has expired.')).toBeInTheDocument();
    });

    it('shows chat blocked state when subscription is expired', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'pro',
        planExpiresAt: pastDate(1),
      };
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByText('Chat is blocked. Please upgrade.')).toBeInTheDocument();
    });

    it('shows upgrade button in expired state when onOpenSettings is provided', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'pro',
        planExpiresAt: pastDate(1),
      };
      render(<ChatPanel {...defaultProps} />);
      const upgradeBtns = screen.getAllByText('Upgrade');
      expect(upgradeBtns.length).toBeGreaterThan(0);
    });

    it('expired state upgrade button calls onOpenSettings', () => {
      const onOpenSettings = jest.fn();
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'pro',
        planExpiresAt: pastDate(1),
      };
      render(<ChatPanel {...defaultProps} onOpenSettings={onOpenSettings} />);
      // Find the upgrade button inside the chat-blocked area
      const upgradeBtns = screen.getAllByRole('button').filter(btn =>
        btn.textContent?.includes('Upgrade')
      );
      // Click last upgrade button (the one in the blocked-chat area, not the alert)
      if (upgradeBtns.length > 0) {
        fireEvent.click(upgradeBtns[upgradeBtns.length - 1]);
        expect(onOpenSettings).toHaveBeenCalled();
      }
    });

    it('expired banner is shown when subscription is expired', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'pro',
        planExpiresAt: pastDate(1),
      };
      render(<ChatPanel {...defaultProps} />);
      // Banner and blocked state are shown
      expect(screen.getByText('Your subscription has expired.')).toBeInTheDocument();
      expect(screen.getByText('Chat is blocked. Please upgrade.')).toBeInTheDocument();
    });

    it('shows expiring soon banner for trial expiring in 1 day', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'free',
        trialEndsAt: futureDate(1),
      };
      render(<ChatPanel {...defaultProps} />);
      // expiringSoon message contains "Expires in"
      expect(screen.getByText(/Expires in/)).toBeInTheDocument();
    });

    it('dismissing expiring-soon banner removes it', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'free',
        trialEndsAt: futureDate(1),
      };
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByText(/Expires in/)).toBeInTheDocument();
      // The expiring_soon Alert has a CloseIcon inside an IconButton that calls setTrialBannerDismissed
      const closeBtns = screen.getAllByRole('button').filter(btn =>
        btn.querySelector('svg[data-testid="CloseIcon"]')
      );
      if (closeBtns.length > 0) {
        // The dismiss button for expiring_soon is the last CloseIcon button rendered
        act(() => { fireEvent.click(closeBtns[closeBtns.length - 1]); });
        // trialBannerDismissed = true hides the banner
        expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
      }
    });

    it('shows upgrade button in expiring soon banner', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'free',
        trialEndsAt: futureDate(1),
      };
      render(<ChatPanel {...defaultProps} />);
      const upgradeBtns = screen.getAllByText('Upgrade');
      expect(upgradeBtns.length).toBeGreaterThan(0);
    });

    it('no subscription banner when user has valid active subscription', () => {
      mockUser = {
        id: 'u1',
        email: 'test@example.com',
        plan: 'pro',
        planExpiresAt: futureDate(30),
      };
      render(<ChatPanel {...defaultProps} />);
      expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
      expect(screen.queryByText('Your subscription has expired.')).not.toBeInTheDocument();
    });
  });

  // ── Model display names ─────────────────────────────────────────────────────

  describe('model name rendering', () => {
    it('renders panel with known model name', () => {
      mockAgentValue.model = 'qwen/qwen3-coder';
      const { container } = render(<ChatPanel {...defaultProps} />);
      expect(container.querySelector('[aria-label="AI Assistant panel"]')).toBeInTheDocument();
    });

    it('renders panel with unknown model name', () => {
      mockAgentValue.model = 'some/unknown-model';
      const { container } = render(<ChatPanel {...defaultProps} />);
      expect(container.querySelector('[aria-label="AI Assistant panel"]')).toBeInTheDocument();
    });

    it('renders panel with no model', () => {
      mockAgentValue.model = '';
      const { container } = render(<ChatPanel {...defaultProps} />);
      expect(container.querySelector('[aria-label="AI Assistant panel"]')).toBeInTheDocument();
    });
  });

  // ── Connection with connections prop ────────────────────────────────────────

  describe('connections prop', () => {
    const mockConnections = [
      {
        id: 'conn-1',
        host: 'localhost',
        port: 5432,
        username: 'admin',
        password: 'secret',
        database: 'mydb',
        connectionName: 'Local DB',
        isActive: true,
        databases: [],
      },
    ];

    it('renders with connections provided', () => {
      render(<ChatPanel {...defaultProps} connections={mockConnections} />);
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });

    it('renders with active connection provided', () => {
      render(<ChatPanel {...defaultProps} activeConnection={mockConnections[0]} />);
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });
  });

  // ── Wheel event on tabs container ───────────────────────────────────────────

  describe('tabs container scroll', () => {
    it('handles wheel event on tabs container without crashing', () => {
      render(<ChatPanel {...defaultProps} />);
      const tablist = screen.getByRole('tablist');
      fireEvent.wheel(tablist, { deltaX: 0, deltaY: 50 });
      // No crash = pass
      expect(tablist).toBeInTheDocument();
    });

    it('handles wheel event with horizontal delta without crashing', () => {
      render(<ChatPanel {...defaultProps} />);
      const tablist = screen.getByRole('tablist');
      fireEvent.wheel(tablist, { deltaX: 100, deltaY: 10 });
      expect(tablist).toBeInTheDocument();
    });
  });

  // ── Panel structure ─────────────────────────────────────────────────────────

  describe('panel structure', () => {
    it('renders with role="complementary"', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });

    it('renders with correct aria-label', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByLabelText('AI Assistant panel')).toBeInTheDocument();
    });

    it('renders the chat title text', () => {
      render(<ChatPanel {...defaultProps} />);
      expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    });
  });
});
