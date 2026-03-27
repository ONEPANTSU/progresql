/*
* Created on Mar 27, 2026
* Test file for userStorage.ts
* File path: renderer/__tests__/userStorage.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import {
  getCurrentUserId,
  userKey,
  migrateToUserStorage,
} from '../utils/userStorage';

const CURRENT_USER_KEY = 'progresql-current-user';

describe('userStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  // ── getCurrentUserId ──────────────────────────────────────────────────────

  describe('getCurrentUserId', () => {
    it('returns null when localStorage is empty', () => {
      expect(getCurrentUserId()).toBeNull();
    });

    it('returns the user ID when a user is stored', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'user-42', email: 'a@b.com' }));
      expect(getCurrentUserId()).toBe('user-42');
    });

    it('returns null when stored JSON has no id field', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ email: 'a@b.com' }));
      expect(getCurrentUserId()).toBeNull();
    });

    it('returns null when stored value is invalid JSON', () => {
      localStorage.setItem(CURRENT_USER_KEY, 'not-valid-json{{{');
      expect(getCurrentUserId()).toBeNull();
    });

    it('returns null when stored user id is empty string', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: '', email: 'a@b.com' }));
      expect(getCurrentUserId()).toBeNull();
    });
  });

  // ── userKey ───────────────────────────────────────────────────────────────

  describe('userKey', () => {
    it('returns global key when no user is logged in', () => {
      expect(userKey('chats')).toBe('progresql-chats');
    });

    it('returns user-scoped key when user is logged in', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'abc123', email: 'a@b.com' }));
      expect(userKey('chats')).toBe('progresql-abc123-chats');
    });

    it('uses different suffixes correctly', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1', email: 'a@b.com' }));
      expect(userKey('agent-model')).toBe('progresql-u1-agent-model');
      expect(userKey('active-chat-id')).toBe('progresql-u1-active-chat-id');
    });

    it('falls back to global key after user is cleared', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1', email: 'a@b.com' }));
      expect(userKey('chats')).toBe('progresql-u1-chats');

      localStorage.removeItem(CURRENT_USER_KEY);
      expect(userKey('chats')).toBe('progresql-chats');
    });
  });

  // ── migrateToUserStorage ──────────────────────────────────────────────────

  describe('migrateToUserStorage', () => {
    it('does nothing when no user is logged in', () => {
      migrateToUserStorage();
      // No error thrown and no scoped keys created
      expect(localStorage.getItem('progresql-u1-agent-model')).toBeNull();
    });

    it('migrates legacy agent-model key to user-scoped key', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1' }));
      localStorage.setItem('progresql-agent-model', 'gpt-4');

      migrateToUserStorage();

      expect(localStorage.getItem('progresql-u1-agent-model')).toBe('gpt-4');
    });

    it('migrates legacy agent-safe-mode key to user-scoped key', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1' }));
      localStorage.setItem('progresql-agent-safe-mode', 'true');

      migrateToUserStorage();

      expect(localStorage.getItem('progresql-u1-agent-safe-mode')).toBe('true');
    });

    it('sets migration flag after first run', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1' }));
      migrateToUserStorage();
      expect(localStorage.getItem('progresql-migrated-u1')).toBe('true');
    });

    it('is idempotent — does not overwrite existing scoped value on second run', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1' }));
      localStorage.setItem('progresql-agent-model', 'gpt-4');
      localStorage.setItem('progresql-u1-agent-model', 'already-set');

      migrateToUserStorage();

      // Should not overwrite the already-set scoped value
      expect(localStorage.getItem('progresql-u1-agent-model')).toBe('already-set');
    });

    it('skips migration entirely if already migrated for this user', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1' }));
      localStorage.setItem('progresql-migrated-u1', 'true');
      localStorage.setItem('progresql-agent-model', 'new-model');

      migrateToUserStorage();

      // No new migration should have occurred
      expect(localStorage.getItem('progresql-u1-agent-model')).toBeNull();
    });

    it('does not migrate keys for missing legacy values', () => {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ id: 'u1' }));

      migrateToUserStorage();

      expect(localStorage.getItem('progresql-u1-agent-model')).toBeNull();
      expect(localStorage.getItem('progresql-u1-agent-safe-mode')).toBeNull();
    });
  });
});
