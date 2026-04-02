/*
* Created on Mar 27, 2026
* Test file for chatStorage.ts
* File path: renderer/__tests__/chatStorage.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import {
  loadChats,
  saveChats,
  loadActiveChatId,
  saveActiveChatId,
  clearChatHistory,
} from '@/entities/chat/chatStorage';
import type { Chat, Message } from '@/shared/types';

// Mock the logger to suppress noise
jest.mock('@/shared/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock userStorage to keep key resolution deterministic in tests
jest.mock('@/shared/lib/userStorage', () => ({
  userKey: jest.fn((suffix: string) => `progresql-${suffix}`),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    text: 'Hello',
    sender: 'user',
    timestamp: new Date('2024-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Test Chat',
    createdAt: new Date('2024-01-01T09:00:00.000Z'),
    updatedAt: new Date('2024-01-01T10:00:00.000Z'),
    messages: [],
    hasSentFirstMessage: false,
    ...overrides,
  };
}

const CHATS_KEY = 'progresql-chats';
const ACTIVE_KEY = 'progresql-active-chat-id';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('chatStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  // ── loadChats ────────────────────────────────────────────────────────────

  describe('loadChats', () => {
    it('returns empty array when nothing is stored', () => {
      expect(loadChats()).toEqual([]);
    });

    it('loads and deserializes a single chat correctly', () => {
      const chats = [
        {
          id: 'chat-1',
          title: 'First Chat',
          createdAt: '2024-01-01T09:00:00.000Z',
          updatedAt: '2024-01-01T10:00:00.000Z',
          messages: [],
          hasSentFirstMessage: false,
        },
      ];
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));

      const result = loadChats();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('chat-1');
      expect(result[0].title).toBe('First Chat');
      expect(result[0].createdAt).toBeInstanceOf(Date);
      expect(result[0].updatedAt).toBeInstanceOf(Date);
    });

    it('deserializes message timestamps as Date objects', () => {
      const chats = [
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2024-01-01T09:00:00.000Z',
          updatedAt: '2024-01-01T10:00:00.000Z',
          messages: [
            {
              id: 'msg-1',
              text: 'Hello',
              sender: 'user',
              timestamp: '2024-01-01T10:00:00.000Z',
            },
          ],
          hasSentFirstMessage: true,
        },
      ];
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));

      const result = loadChats();
      expect(result[0].messages[0].timestamp).toBeInstanceOf(Date);
      expect(result[0].messages[0].sender).toBe('user');
    });

    it('returns empty array when stored value is invalid JSON', () => {
      localStorage.setItem(CHATS_KEY, 'not-valid-json{{{');
      expect(loadChats()).toEqual([]);
    });

    it('returns empty array when stored value is not an array', () => {
      localStorage.setItem(CHATS_KEY, JSON.stringify({ id: 'not-array' }));
      expect(loadChats()).toEqual([]);
    });

    it('handles missing messages array gracefully', () => {
      const chats = [
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2024-01-01T09:00:00.000Z',
          updatedAt: '2024-01-01T10:00:00.000Z',
          hasSentFirstMessage: false,
          // messages field omitted intentionally
        },
      ];
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
      const result = loadChats();
      expect(result[0].messages).toEqual([]);
    });

    it('loads multiple chats correctly', () => {
      const chats = [
        {
          id: 'chat-1',
          title: 'First',
          createdAt: '2024-01-01T09:00:00.000Z',
          updatedAt: '2024-01-01T10:00:00.000Z',
          messages: [],
          hasSentFirstMessage: false,
        },
        {
          id: 'chat-2',
          title: 'Second',
          createdAt: '2024-01-02T09:00:00.000Z',
          updatedAt: '2024-01-02T10:00:00.000Z',
          messages: [],
          hasSentFirstMessage: true,
        },
      ];
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats));

      const result = loadChats();
      expect(result).toHaveLength(2);
      expect(result[1].id).toBe('chat-2');
      expect(result[1].hasSentFirstMessage).toBe(true);
    });
  });

  // ── saveChats ─────────────────────────────────────────────────────────────

  describe('saveChats', () => {
    it('serializes and stores chats in localStorage', () => {
      const chat = makeChat({ messages: [makeMessage()] });
      saveChats([chat]);

      const stored = localStorage.getItem(CHATS_KEY);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe('chat-1');
    });

    it('overwrites previously saved chats', () => {
      saveChats([makeChat({ id: 'old-chat', title: 'Old' })]);
      saveChats([makeChat({ id: 'new-chat', title: 'New' })]);

      const stored = JSON.parse(localStorage.getItem(CHATS_KEY)!);
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('new-chat');
    });

    it('saves an empty array', () => {
      saveChats([]);
      const stored = JSON.parse(localStorage.getItem(CHATS_KEY)!);
      expect(stored).toEqual([]);
    });
  });

  // ── Round-trip ────────────────────────────────────────────────────────────

  describe('save then load round-trip', () => {
    it('preserves chat data through a save/load cycle', () => {
      const original = makeChat({
        id: 'round-trip',
        title: 'Round Trip',
        hasSentFirstMessage: true,
        messages: [
          makeMessage({ id: 'msg-a', text: 'ping', sender: 'user' }),
          makeMessage({ id: 'msg-b', text: 'pong', sender: 'bot' }),
        ],
      });

      saveChats([original]);
      const loaded = loadChats();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('round-trip');
      expect(loaded[0].hasSentFirstMessage).toBe(true);
      expect(loaded[0].messages).toHaveLength(2);
      expect(loaded[0].messages[0].text).toBe('ping');
      expect(loaded[0].messages[1].sender).toBe('bot');
      expect(loaded[0].messages[0].timestamp).toBeInstanceOf(Date);
    });
  });

  // ── loadActiveChatId ──────────────────────────────────────────────────────

  describe('loadActiveChatId', () => {
    it('returns null when nothing is stored', () => {
      expect(loadActiveChatId()).toBeNull();
    });

    it('returns the stored active chat ID', () => {
      localStorage.setItem(ACTIVE_KEY, 'chat-abc');
      expect(loadActiveChatId()).toBe('chat-abc');
    });
  });

  // ── saveActiveChatId ──────────────────────────────────────────────────────

  describe('saveActiveChatId', () => {
    it('stores the provided chat ID', () => {
      saveActiveChatId('chat-xyz');
      expect(localStorage.getItem(ACTIVE_KEY)).toBe('chat-xyz');
    });

    it('removes the key when null is passed', () => {
      localStorage.setItem(ACTIVE_KEY, 'chat-xyz');
      saveActiveChatId(null);
      expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
    });
  });

  // ── clearChatHistory ──────────────────────────────────────────────────────

  describe('clearChatHistory', () => {
    it('removes both chats and active chat ID', () => {
      localStorage.setItem(CHATS_KEY, JSON.stringify([makeChat()]));
      localStorage.setItem(ACTIVE_KEY, 'chat-1');

      clearChatHistory();

      expect(localStorage.getItem(CHATS_KEY)).toBeNull();
      expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
    });

    it('does not throw when storage is already empty', () => {
      expect(() => clearChatHistory()).not.toThrow();
    });
  });
});
