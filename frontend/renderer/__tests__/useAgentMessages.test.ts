/*
* Created on Mar 27, 2026
* Test file for useAgentMessages.ts
* File path: renderer/__tests__/useAgentMessages.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import { renderHook, act } from '@testing-library/react';
import { useAgentMessages } from '../hooks/useAgentMessages';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();

jest.mock('../contexts/NotificationContext', () => ({
  useNotifications: () => ({
    showNotification: jest.fn(),
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showInfo: jest.fn(),
    showWarning: jest.fn(),
  }),
}));

const mockSendRequest = jest.fn();
const mockCancelRequest = jest.fn();

const mockAgentValue = {
  connectionState: 'connected',
  connectionPhase: 'connected',
  isConnected: true,
  isAuthError: false,
  connect: jest.fn(),
  disconnect: jest.fn(),
  sendRequest: mockSendRequest,
  cancelRequest: mockCancelRequest,
  sessionId: 'session-1',
  error: null,
  backendUrl: 'http://localhost:8080',
  setBackendUrl: jest.fn(),
  model: 'test-model',
  setModel: jest.fn(),
  securityMode: 'safe' as const,
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
    t: (key: string) => key,
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

jest.mock('../utils/descriptionStorage', () => ({
  getDescriptionsForContext: jest.fn(() => ''),
}));

// Mock useStreamingMessage with controllable refs
const mockStartStreaming = jest.fn();
const mockAppendDelta = jest.fn();
const mockFinishStreaming = jest.fn();
const mockCancelStreaming = jest.fn();
const mockTextRef = { current: '' };

jest.mock('../hooks/useStreamingMessage', () => ({
  useStreamingMessage: () => ({
    textRef: mockTextRef,
    startStreaming: mockStartStreaming,
    appendDelta: mockAppendDelta,
    finishStreaming: mockFinishStreaming,
    cancelStreaming: mockCancelStreaming,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChat(id: string, title = 'Chat 1') {
  return {
    id,
    title,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    hasSentFirstMessage: false,
  };
}

function makeArgs(overrides: Partial<Parameters<typeof useAgentMessages>[0]> = {}) {
  const setChats = jest.fn();
  const setInputValue = jest.fn();
  const setIsTyping = jest.fn();
  const handleCreateChat = jest.fn(() => 'new-chat-id');

  return {
    activeChatId: 'chat-1',
    setChats,
    inputValue: '',
    setInputValue,
    isTyping: false,
    setIsTyping,
    handleCreateChat,
    attachedSQL: null,
    setAttachedSQL: jest.fn(),
    connectionId: null,
    ...overrides,
  };
}

describe('useAgentMessages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTextRef.current = '';
    mockAgentValue.isConnected = true;
    mockSendRequest.mockReturnValue('req-1');
  });

  // ── Return interface ──────────────────────────────────────────────────────

  describe('return interface', () => {
    it('returns all expected properties', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      expect(typeof result.current.isTyping).toBe('boolean');
      expect(typeof result.current.setIsTyping).toBe('function');
      expect(typeof result.current.sendViaAgent).toBe('function');
      expect(typeof result.current.sendImproveViaAgent).toBe('function');
      expect(typeof result.current.sendExplainViaAgent).toBe('function');
      expect(typeof result.current.sendAnalyzeViaAgent).toBe('function');
      expect(typeof result.current.handleSendImproveSQL).toBe('function');
      expect(typeof result.current.handleSendExplainSQL).toBe('function');
      expect(typeof result.current.handleSendTextMessage).toBe('function');
      expect(typeof result.current.handleSendAnalyzeSchema).toBe('function');
      expect(typeof result.current.handleSendMessage).toBe('function');
      expect(typeof result.current.stopGeneration).toBe('function');
    });

    it('reflects isTyping from args', () => {
      const args = makeArgs({ isTyping: true });
      const { result } = renderHook(() => useAgentMessages(args));
      expect(result.current.isTyping).toBe(true);
    });
  });

  // ── sendViaAgent ──────────────────────────────────────────────────────────

  describe('sendViaAgent', () => {
    it('calls startStreaming with chatId and botMessageId', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('SELECT 1', 'chat-1', 'msg-bot-1');
      });

      expect(mockStartStreaming).toHaveBeenCalledWith('chat-1', 'msg-bot-1');
    });

    it('adds placeholder bot message to setChats', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('SELECT 1', 'chat-1', 'msg-bot-1');
      });

      expect(args.setChats).toHaveBeenCalled();
      const updater = (args.setChats as jest.Mock).mock.calls[0][0];
      const chat = makeChat('chat-1');
      const updatedChats = updater([chat]);
      const botMsg = updatedChats[0].messages.find((m: any) => m.id === 'msg-bot-1');
      expect(botMsg).toBeDefined();
      expect(botMsg.isStreaming).toBe(true);
      expect(botMsg.sender).toBe('bot');
    });

    it('calls agent.sendRequest with generate_sql action', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('get all users', 'chat-1', 'msg-bot-1');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'generate_sql', user_message: 'get all users' }),
        expect.objectContaining({
          onStream: expect.any(Function),
          onResponse: expect.any(Function),
          onError: expect.any(Function),
        })
      );
    });

    it('updates chat title to first 30 chars of text when title starts with "Chat "', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('My custom query text', 'chat-1', 'msg-bot-1');
      });

      // The second setChats call updates the title
      const titleUpdater = (args.setChats as jest.Mock).mock.calls[1][0];
      const chat = makeChat('chat-1', 'Chat 1');
      const updated = titleUpdater([chat]);
      expect(updated[0].title).toBe('My custom query text');
    });
  });

  // ── sendImproveViaAgent ───────────────────────────────────────────────────

  describe('sendImproveViaAgent', () => {
    it('calls sendRequest with improve_sql action', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendImproveViaAgent('SELECT *', 'chat-1', 'msg-bot-1');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'improve_sql' }),
        expect.any(Object)
      );
    });
  });

  // ── sendExplainViaAgent ───────────────────────────────────────────────────

  describe('sendExplainViaAgent', () => {
    it('calls sendRequest with explain_sql action', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendExplainViaAgent('SELECT * FROM users', 'chat-1', 'msg-bot-1');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'explain_sql' }),
        expect.any(Object)
      );
    });
  });

  // ── sendAnalyzeViaAgent ───────────────────────────────────────────────────

  describe('sendAnalyzeViaAgent', () => {
    it('calls sendRequest with analyze_schema action', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendAnalyzeViaAgent('chat-1', 'msg-bot-1');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'analyze_schema' }),
        expect.any(Object)
      );
    });
  });

  // ── Agent response callbacks ──────────────────────────────────────────────

  describe('agent response callbacks', () => {
    it('onStream appends delta to streaming', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      const callbacks = mockSendRequest.mock.calls[0][1];

      act(() => {
        callbacks.onStream(' chunk1');
      });

      expect(mockAppendDelta).toHaveBeenCalledWith(' chunk1');
    });

    it('onResponse calls finishStreaming with formatted text', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      const callbacks = mockSendRequest.mock.calls[0][1];

      act(() => {
        callbacks.onResponse({
          result: {
            explanation: 'Here is your query',
            sql: null,
            validation_error: null,
            visualization: null,
          },
        });
      });

      expect(mockFinishStreaming).toHaveBeenCalledWith('Here is your query', undefined);
      expect(args.setIsTyping).toHaveBeenCalledWith(false);
    });

    it('onResponse includes visualization when present', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      const callbacks = mockSendRequest.mock.calls[0][1];
      const viz = {
        chart_type: 'bar' as const,
        title: 'Chart',
        data: [{ x: 1, y: 2 }],
        x_label: 'X',
        y_label: 'Y',
        sql: 'SELECT 1',
      };

      act(() => {
        callbacks.onResponse({
          result: {
            explanation: 'Chart below',
            sql: null,
            validation_error: null,
            visualization: viz,
          },
        });
      });

      expect(mockFinishStreaming).toHaveBeenCalledWith(
        'Chart below',
        expect.objectContaining({ chart_type: 'bar', title: 'Chart' })
      );
    });

    it('onError calls cancelStreaming with friendly error text', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      const callbacks = mockSendRequest.mock.calls[0][1];

      act(() => {
        callbacks.onError({ code: 'llm_error', message: 'LLM failure' });
      });

      expect(mockCancelStreaming).toHaveBeenCalledWith('agentError.llmError');
      expect(args.setIsTyping).toHaveBeenCalledWith(false);
      expect(mockShowError).toHaveBeenCalledWith('agentError.llmError');
    });

    it('onError does nothing when error code is "cancelled"', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      const callbacks = mockSendRequest.mock.calls[0][1];

      act(() => {
        callbacks.onError({ code: 'cancelled', message: '' });
      });

      expect(mockCancelStreaming).not.toHaveBeenCalled();
      expect(mockShowError).not.toHaveBeenCalled();
    });

    it('maps known error codes to translation keys', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      const errorCodeToKey: Array<[string, string]> = [
        ['db_not_connected', 'agentError.dbNotConnected'],
        ['tool_timeout', 'agentError.toolTimeout'],
        ['sql_blocked', 'agentError.sqlBlocked'],
        ['rate_limited', 'agentError.rateLimited'],
        ['invalid_request', 'agentError.invalidRequest'],
        ['disconnected', 'agentError.connectionLost'],
        ['not_connected', 'agentError.connectionLost'],
        ['connection_lost', 'agentError.connectionLost'],
        ['not_initialized', 'agentError.notInitialized'],
        ['subscription_expired', 'agentError.subscriptionExpired'],
        ['unknown_code_xyz', 'agentError.unknown'],
      ];

      for (const [code, expectedKey] of errorCodeToKey) {
        jest.clearAllMocks();
        mockSendRequest.mockReturnValue('req-1');

        act(() => {
          result.current.sendViaAgent('test', 'chat-1', 'msg-1');
        });

        const callbacks = mockSendRequest.mock.calls[0][1];

        act(() => {
          callbacks.onError({ code, message: 'some message' });
        });

        expect(mockCancelStreaming).toHaveBeenCalledWith(expectedKey);
      }
    });
  });

  // ── stopGeneration ────────────────────────────────────────────────────────

  describe('stopGeneration', () => {
    it('does nothing when no active request', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.stopGeneration();
      });

      expect(mockCancelRequest).not.toHaveBeenCalled();
    });

    it('cancels active request and appends " · stopped" to partial text', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      mockTextRef.current = 'partial response';

      act(() => {
        result.current.stopGeneration();
      });

      expect(mockCancelRequest).toHaveBeenCalledWith('req-1');
      expect(mockFinishStreaming).toHaveBeenCalledWith('partial response · stopped');
      expect(args.setIsTyping).toHaveBeenCalledWith(false);
    });

    it('uses "· stopped" alone when textRef is empty', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      mockTextRef.current = '';

      act(() => {
        result.current.stopGeneration();
      });

      expect(mockFinishStreaming).toHaveBeenCalledWith('· stopped');
    });
  });

  // ── handleSendImproveSQL ──────────────────────────────────────────────────

  describe('handleSendImproveSQL', () => {
    it('does nothing when agent is not connected', () => {
      mockAgentValue.isConnected = false;
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendImproveSQL('SELECT 1');
      });

      expect(mockSendRequest).not.toHaveBeenCalled();
      mockAgentValue.isConnected = true;
    });

    it('does nothing when sql is empty', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendImproveSQL('   ');
      });

      expect(mockSendRequest).not.toHaveBeenCalled();
    });

    it('adds user message and sends improve_sql request when connected', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendImproveSQL('SELECT * FROM users');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'improve_sql' }),
        expect.any(Object)
      );
      expect(args.setIsTyping).toHaveBeenCalledWith(true);
    });

    it('uses activeChatId when available', () => {
      const args = makeArgs({ activeChatId: 'existing-chat' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendImproveSQL('SELECT 1');
      });

      expect(args.handleCreateChat).not.toHaveBeenCalled();
    });

    it('creates a new chat when activeChatId is null', () => {
      const args = makeArgs({ activeChatId: null });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendImproveSQL('SELECT 1');
      });

      expect(args.handleCreateChat).toHaveBeenCalled();
    });
  });

  // ── handleSendExplainSQL ──────────────────────────────────────────────────

  describe('handleSendExplainSQL', () => {
    it('does nothing when not connected', () => {
      mockAgentValue.isConnected = false;
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendExplainSQL('SELECT 1');
      });

      expect(mockSendRequest).not.toHaveBeenCalled();
      mockAgentValue.isConnected = true;
    });

    it('sends explain_sql when connected', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendExplainSQL('SELECT * FROM orders');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'explain_sql' }),
        expect.any(Object)
      );
    });

    it('uses objectLabel when provided for display text', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendExplainSQL('SELECT 1', 'orders table');
      });

      expect(args.setChats).toHaveBeenCalled();
      // Find the call that adds user message
      const addUserMsgCall = (args.setChats as jest.Mock).mock.calls.find(call => {
        if (typeof call[0] !== 'function') return false;
        const chat = makeChat('chat-1');
        const updated = call[0]([chat]);
        return updated[0].messages.some((m: any) => m.sender === 'user');
      });
      expect(addUserMsgCall).toBeDefined();
      const chat = makeChat('chat-1');
      const updatedChats = addUserMsgCall[0]([chat]);
      const userMsg = updatedChats[0].messages.find((m: any) => m.sender === 'user');
      expect(userMsg.text).toContain('orders table');
    });
  });

  // ── handleSendTextMessage ─────────────────────────────────────────────────

  describe('handleSendTextMessage', () => {
    it('does nothing when not connected', () => {
      mockAgentValue.isConnected = false;
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendTextMessage('hello');
      });

      expect(mockSendRequest).not.toHaveBeenCalled();
      mockAgentValue.isConnected = true;
    });

    it('does nothing when text is empty', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendTextMessage('  ');
      });

      expect(mockSendRequest).not.toHaveBeenCalled();
    });

    it('sends generate_sql when text is provided', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendTextMessage('show me all users');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'generate_sql' }),
        expect.any(Object)
      );
    });
  });

  // ── handleSendAnalyzeSchema ───────────────────────────────────────────────

  describe('handleSendAnalyzeSchema', () => {
    it('does nothing when not connected', () => {
      mockAgentValue.isConnected = false;
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendAnalyzeSchema();
      });

      expect(mockSendRequest).not.toHaveBeenCalled();
      mockAgentValue.isConnected = true;
    });

    it('sends analyze_schema when connected', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendAnalyzeSchema();
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'analyze_schema' }),
        expect.any(Object)
      );
    });
  });

  // ── handleSendMessage ─────────────────────────────────────────────────────

  describe('handleSendMessage', () => {
    it('does nothing when inputValue is empty and no attachedSQL', () => {
      const args = makeArgs({ inputValue: '', attachedSQL: null });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(mockSendRequest).not.toHaveBeenCalled();
    });

    it('shows error and returns when not connected', () => {
      mockAgentValue.isConnected = false;
      const args = makeArgs({ inputValue: 'hello' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(mockShowError).toHaveBeenCalledWith('agentError.backendUnavailable');
      expect(mockSendRequest).not.toHaveBeenCalled();
      mockAgentValue.isConnected = true;
    });

    it('sends message when inputValue is set', () => {
      const args = makeArgs({ inputValue: 'show tables', activeChatId: 'chat-1' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(mockSendRequest).toHaveBeenCalled();
      expect(args.setInputValue).toHaveBeenCalledWith('');
    });

    it('handles /explain slash command', () => {
      const args = makeArgs({ inputValue: '/explain SELECT * FROM users', activeChatId: 'chat-1' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'explain_sql' }),
        expect.any(Object)
      );
    });

    it('handles /analyze slash command', () => {
      const args = makeArgs({ inputValue: '/analyze', activeChatId: 'chat-1' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'analyze_schema' }),
        expect.any(Object)
      );
    });

    it('clears attachedSQL after sending', () => {
      const setAttachedSQL = jest.fn();
      const args = makeArgs({
        inputValue: 'context text',
        attachedSQL: 'SELECT * FROM users',
        setAttachedSQL,
        activeChatId: 'chat-1',
      });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(setAttachedSQL).toHaveBeenCalledWith(null);
    });

    it('builds display text combining user text and SQL attachment', () => {
      const args = makeArgs({
        inputValue: 'improve this',
        attachedSQL: 'SELECT * FROM users',
        activeChatId: 'chat-1',
      });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      // Find the setChats call that adds user message
      const userMsgCall = (args.setChats as jest.Mock).mock.calls.find(call => {
        if (typeof call[0] !== 'function') return false;
        const chat = makeChat('chat-1');
        const updated = call[0]([chat]);
        return updated[0].messages.some((m: any) => m.sender === 'user');
      });
      expect(userMsgCall).toBeDefined();
      const chat = makeChat('chat-1');
      const updatedChats = userMsgCall[0]([chat]);
      const userMsg = updatedChats[0].messages.find((m: any) => m.sender === 'user');
      expect(userMsg.text).toContain('improve this');
      expect(userMsg.text).toContain('SELECT * FROM users');
    });

    it('sends only SQL when inputValue is empty but attachedSQL exists', () => {
      const args = makeArgs({
        inputValue: '',
        attachedSQL: 'SELECT 1',
        activeChatId: 'chat-1',
      });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'generate_sql' }),
        expect.any(Object)
      );
    });

    it('creates a new chat when activeChatId is null', () => {
      const args = makeArgs({ inputValue: 'test', activeChatId: null });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(args.handleCreateChat).toHaveBeenCalled();
    });

    it('sets isTyping to true before sending', () => {
      const args = makeArgs({ inputValue: 'test', activeChatId: 'chat-1' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      expect(args.setIsTyping).toHaveBeenCalledWith(true);
    });

    it('adds user message to chats with hasSentFirstMessage: true', () => {
      const args = makeArgs({ inputValue: 'hello', activeChatId: 'chat-1' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.handleSendMessage();
      });

      const userMsgCall = (args.setChats as jest.Mock).mock.calls.find(call => {
        if (typeof call[0] !== 'function') return false;
        const chat = makeChat('chat-1');
        const updated = call[0]([chat]);
        return updated[0].messages.some((m: any) => m.sender === 'user');
      });
      expect(userMsgCall).toBeDefined();
      const chat = makeChat('chat-1');
      const updatedChats = userMsgCall[0]([chat]);
      expect(updatedChats[0].hasSentFirstMessage).toBe(true);
    });
  });

  // ── Context enrichment ────────────────────────────────────────────────────

  describe('context enrichment', () => {
    it('includes safe_mode in request context', () => {
      const args = makeArgs({ inputValue: '' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ safe_mode: true }),
        }),
        expect.any(Object)
      );
    });

    it('includes language in request context', () => {
      const args = makeArgs();
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ language: 'en' }),
        }),
        expect.any(Object)
      );
    });

    it('includes connection_id in context when provided', () => {
      const args = makeArgs({ connectionId: 'conn-abc' });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ connection_id: 'conn-abc' }),
        }),
        expect.any(Object)
      );
    });

    it('does not include connection_id when not provided', () => {
      const args = makeArgs({ connectionId: null });
      const { result } = renderHook(() => useAgentMessages(args));

      act(() => {
        result.current.sendViaAgent('test', 'chat-1', 'msg-1');
      });

      const callContext = mockSendRequest.mock.calls[0][0].context;
      expect(callContext.connection_id).toBeUndefined();
    });
  });
});
