/*
* Created on Mar 27, 2026
* Test file for useChat.ts
* File path: renderer/__tests__/useChat.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import { renderHook, act } from '@testing-library/react';
import { useChat } from '@/features/agent-chat/useChat';

// Mock storage utilities so tests are self-contained
jest.mock('@/entities/chat/chatStorage', () => ({
  loadChats: jest.fn(() => []),
  saveChats: jest.fn(),
  loadActiveChatId: jest.fn(() => null),
  saveActiveChatId: jest.fn(),
  clearChatHistory: jest.fn(),
}));

jest.mock('@/shared/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  loadChats,
  saveChats,
  loadActiveChatId,
  saveActiveChatId,
  clearChatHistory,
} from '@/entities/chat/chatStorage';

const mockLoadChats = loadChats as jest.Mock;
const mockSaveChats = saveChats as jest.Mock;
const mockLoadActiveChatId = loadActiveChatId as jest.Mock;
const mockSaveActiveChatId = saveActiveChatId as jest.Mock;
const mockClearChatHistory = clearChatHistory as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChat(id: string, title: string) {
  return {
    id,
    title,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    hasSentFirstMessage: false,
  };
}

describe('useChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadChats.mockReturnValue([]);
    mockLoadActiveChatId.mockReturnValue(null);
  });

  // ── Initialization ────────────────────────────────────────────────────────

  describe('initialization', () => {
    it('returns all expected properties', () => {
      const { result } = renderHook(() => useChat(false));
      const {
        chats, setChats, activeChatId, setActiveChatId, activeChat,
        handleCreateChat, handleDeleteChat, handleRenameChat,
        handleClearHistory, messagesEndRef, tabsContainerRef,
        canScrollLeft, canScrollRight, scrollTabs,
      } = result.current;

      expect(Array.isArray(chats)).toBe(true);
      expect(typeof setChats).toBe('function');
      expect(activeChatId).toBeNull();
      expect(typeof setActiveChatId).toBe('function');
      expect(activeChat).toBeUndefined();
      expect(typeof handleCreateChat).toBe('function');
      expect(typeof handleDeleteChat).toBe('function');
      expect(typeof handleRenameChat).toBe('function');
      expect(typeof handleClearHistory).toBe('function');
      expect(messagesEndRef).toBeDefined();
      expect(tabsContainerRef).toBeDefined();
      expect(canScrollLeft).toBe(false);
      expect(canScrollRight).toBe(false);
      expect(typeof scrollTabs).toBe('function');
    });

    it('loads chats from storage on mount', () => {
      const existingChat = makeChat('stored-1', 'Stored Chat');
      mockLoadChats.mockReturnValue([existingChat]);
      mockLoadActiveChatId.mockReturnValue('stored-1');

      const { result } = renderHook(() => useChat(true));

      expect(result.current.chats).toHaveLength(1);
      expect(result.current.chats[0].id).toBe('stored-1');
      expect(result.current.activeChatId).toBe('stored-1');
    });

    it('does not auto-create chat when isOpen is false', () => {
      const { result } = renderHook(() => useChat(false));
      expect(result.current.chats).toHaveLength(0);
    });

    it('auto-creates initial chat when isOpen is true and no chats exist', () => {
      const { result } = renderHook(() => useChat(true));
      expect(result.current.chats).toHaveLength(1);
      expect(result.current.chats[0].title).toBe('Chat 1');
      expect(result.current.activeChatId).toBe(result.current.chats[0].id);
    });

    it('does not create additional chat when chats already exist', () => {
      const existingChat = makeChat('existing-1', 'Chat 1');
      mockLoadChats.mockReturnValue([existingChat]);
      mockLoadActiveChatId.mockReturnValue('existing-1');

      const { result } = renderHook(() => useChat(true));

      // Should not have added a new chat
      expect(result.current.chats).toHaveLength(1);
    });
  });

  // ── setActiveChatId ───────────────────────────────────────────────────────

  describe('setActiveChatId', () => {
    it('updates activeChatId', () => {
      const { result } = renderHook(() => useChat(true));

      act(() => {
        result.current.setActiveChatId('some-id');
      });

      expect(result.current.activeChatId).toBe('some-id');
    });

    it('can be set to null', () => {
      const { result } = renderHook(() => useChat(true));

      act(() => {
        result.current.setActiveChatId('some-id');
      });
      act(() => {
        result.current.setActiveChatId(null);
      });

      expect(result.current.activeChatId).toBeNull();
    });
  });

  // ── activeChat ────────────────────────────────────────────────────────────

  describe('activeChat', () => {
    it('returns undefined when no active chat id is set', () => {
      const { result } = renderHook(() => useChat(false));
      expect(result.current.activeChat).toBeUndefined();
    });

    it('returns the matching chat object', () => {
      const { result } = renderHook(() => useChat(true));
      const chatId = result.current.chats[0].id;

      act(() => {
        result.current.setActiveChatId(chatId);
      });

      expect(result.current.activeChat?.id).toBe(chatId);
    });
  });

  // ── handleCreateChat ──────────────────────────────────────────────────────

  describe('handleCreateChat', () => {
    it('creates a new chat and sets it as active', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleCreateChat();
      });

      expect(result.current.chats).toHaveLength(1);
      expect(result.current.activeChatId).toBe(result.current.chats[0].id);
    });

    it('returns the new chat id', () => {
      const { result } = renderHook(() => useChat(false));
      let newId: string;

      act(() => {
        newId = result.current.handleCreateChat();
      });

      expect(newId!).toBe(result.current.chats[0].id);
    });

    it('names first chat "Chat 1"', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleCreateChat();
      });

      expect(result.current.chats[0].title).toBe('Chat 1');
    });

    it('names second chat "Chat 2" when Chat 1 exists', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleCreateChat();
      });
      act(() => {
        result.current.handleCreateChat();
      });

      const titles = result.current.chats.map(c => c.title);
      expect(titles).toContain('Chat 1');
      expect(titles).toContain('Chat 2');
    });

    it('picks the next available number (fills gaps)', () => {
      // Pre-load chats with Chat 1 and Chat 3, expect Chat 2 to be created
      mockLoadChats.mockReturnValue([
        makeChat('a', 'Chat 1'),
        makeChat('b', 'Chat 3'),
      ]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleCreateChat();
      });

      const newChat = result.current.chats.find(c => !['a', 'b'].includes(c.id));
      expect(newChat?.title).toBe('Chat 2');
    });

    it('initializes new chat with empty messages', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleCreateChat();
      });

      expect(result.current.chats[0].messages).toEqual([]);
    });

    it('initializes hasSentFirstMessage as false', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleCreateChat();
      });

      expect(result.current.chats[0].hasSentFirstMessage).toBe(false);
    });
  });

  // ── handleDeleteChat ──────────────────────────────────────────────────────

  describe('handleDeleteChat', () => {
    it('removes the specified chat', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Chat 1'), makeChat('chat-2', 'Chat 2')]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleDeleteChat('chat-1');
      });

      expect(result.current.chats).toHaveLength(1);
      expect(result.current.chats[0].id).toBe('chat-2');
    });

    it('switches active chat when the active one is deleted', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Chat 1'), makeChat('chat-2', 'Chat 2')]);
      mockLoadActiveChatId.mockReturnValue('chat-1');

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleDeleteChat('chat-1');
      });

      expect(result.current.activeChatId).toBe('chat-2');
    });

    it('sets activeChatId to null when last chat is deleted', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Chat 1')]);
      mockLoadActiveChatId.mockReturnValue('chat-1');

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleDeleteChat('chat-1');
      });

      expect(result.current.chats).toHaveLength(0);
      expect(result.current.activeChatId).toBeNull();
    });

    it('does not change activeChatId when a non-active chat is deleted', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Chat 1'), makeChat('chat-2', 'Chat 2')]);
      mockLoadActiveChatId.mockReturnValue('chat-2');

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleDeleteChat('chat-1');
      });

      expect(result.current.activeChatId).toBe('chat-2');
    });
  });

  // ── handleRenameChat ──────────────────────────────────────────────────────

  describe('handleRenameChat', () => {
    it('renames the specified chat', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Old Title')]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleRenameChat('chat-1', 'New Title');
      });

      expect(result.current.chats[0].title).toBe('New Title');
    });

    it('trims whitespace from the new title', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Old')]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleRenameChat('chat-1', '  Trimmed Title  ');
      });

      expect(result.current.chats[0].title).toBe('Trimmed Title');
    });

    it('does nothing when new title is empty', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Original')]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleRenameChat('chat-1', '');
      });

      expect(result.current.chats[0].title).toBe('Original');
    });

    it('does nothing when new title is whitespace only', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Original')]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleRenameChat('chat-1', '   ');
      });

      expect(result.current.chats[0].title).toBe('Original');
    });

    it('does not rename other chats', () => {
      mockLoadChats.mockReturnValue([
        makeChat('chat-1', 'Chat A'),
        makeChat('chat-2', 'Chat B'),
      ]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleRenameChat('chat-1', 'Renamed A');
      });

      expect(result.current.chats[0].title).toBe('Renamed A');
      expect(result.current.chats[1].title).toBe('Chat B');
    });
  });

  // ── handleClearHistory ────────────────────────────────────────────────────

  describe('handleClearHistory', () => {
    it('clears all chats', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Chat 1'), makeChat('chat-2', 'Chat 2')]);

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleClearHistory();
      });

      expect(result.current.chats).toHaveLength(0);
    });

    it('sets activeChatId to null', () => {
      mockLoadChats.mockReturnValue([makeChat('chat-1', 'Chat 1')]);
      mockLoadActiveChatId.mockReturnValue('chat-1');

      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleClearHistory();
      });

      expect(result.current.activeChatId).toBeNull();
    });

    it('calls clearChatHistory from storage', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleClearHistory();
      });

      expect(mockClearChatHistory).toHaveBeenCalled();
    });
  });

  // ── Persistence side effects ───────────────────────────────────────────────

  describe('persistence side effects', () => {
    it('calls saveChats when chats change', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.handleCreateChat();
      });

      expect(mockSaveChats).toHaveBeenCalled();
    });

    it('calls saveActiveChatId when activeChatId changes', () => {
      const { result } = renderHook(() => useChat(false));

      act(() => {
        result.current.setActiveChatId('test-id');
      });

      expect(mockSaveActiveChatId).toHaveBeenCalledWith('test-id');
    });
  });

  // ── scrollTabs ────────────────────────────────────────────────────────────

  describe('scrollTabs', () => {
    it('does not throw when tabsContainerRef has no element', () => {
      const { result } = renderHook(() => useChat(false));

      expect(() => {
        act(() => {
          result.current.scrollTabs('left');
        });
      }).not.toThrow();
    });

    it('accepts both left and right directions', () => {
      const { result } = renderHook(() => useChat(false));

      expect(() => {
        act(() => {
          result.current.scrollTabs('right');
        });
      }).not.toThrow();
    });
  });

  // ── canScrollLeft / canScrollRight ────────────────────────────────────────

  describe('scroll state', () => {
    it('initializes canScrollLeft to false', () => {
      const { result } = renderHook(() => useChat(false));
      expect(result.current.canScrollLeft).toBe(false);
    });

    it('initializes canScrollRight to false', () => {
      const { result } = renderHook(() => useChat(false));
      expect(result.current.canScrollRight).toBe(false);
    });
  });
});
