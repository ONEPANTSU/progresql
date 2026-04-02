import { Chat, Message } from '@/shared/types';
import { createLogger } from '@/shared/lib/logger';
import { userKey } from '@/shared/lib/userStorage';

const log = createLogger('ChatStorage');

function chatsKey(): string {
  return userKey('chats');
}

function activeChatKey(): string {
  return userKey('active-chat-id');
}

interface SerializedChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SerializedMessage[];
  hasSentFirstMessage: boolean;
}

interface SerializedMessage {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  timestamp: string;
}

function deserializeChat(raw: SerializedChat): Chat {
  return {
    id: raw.id,
    title: raw.title,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    messages: (raw.messages || []).map(deserializeMessage),
    hasSentFirstMessage: raw.hasSentFirstMessage,
  };
}

function deserializeMessage(raw: SerializedMessage): Message {
  return {
    id: raw.id,
    text: raw.text,
    sender: raw.sender,
    timestamp: new Date(raw.timestamp),
  };
}

export function loadChats(): Chat[] {
  if (typeof window === 'undefined') return [];

  try {
    const saved = localStorage.getItem(chatsKey());
    if (!saved) return [];

    const parsed: SerializedChat[] = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];

    return parsed.map(deserializeChat);
  } catch (error) {
    log.error('Failed to load chats from localStorage:', error);
    return [];
  }
}

export function saveChats(chats: Chat[]): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(chatsKey(), JSON.stringify(chats));
  } catch (error) {
    log.error('Failed to save chats to localStorage:', error);
  }
}

export function loadActiveChatId(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    return localStorage.getItem(activeChatKey());
  } catch {
    return null;
  }
}

export function saveActiveChatId(chatId: string | null): void {
  if (typeof window === 'undefined') return;

  try {
    if (chatId) {
      localStorage.setItem(activeChatKey(), chatId);
    } else {
      localStorage.removeItem(activeChatKey());
    }
  } catch (error) {
    log.error('Failed to save active chat ID:', error);
  }
}

export function clearChatHistory(): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem(chatsKey());
    localStorage.removeItem(activeChatKey());
  } catch (error) {
    log.error('Failed to clear chat history:', error);
  }
}
