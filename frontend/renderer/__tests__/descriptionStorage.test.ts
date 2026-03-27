/*
* Created on Mar 27, 2026
* Test file for descriptionStorage.ts
* File path: renderer/__tests__/descriptionStorage.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import {
  getDescription,
  setDescription,
  getAllDescriptions,
  getDescriptionsForContext,
  UserDescription,
} from '../utils/descriptionStorage';

// Mock userStorage so key resolution is deterministic
jest.mock('../utils/userStorage', () => ({
  userKey: jest.fn((suffix: string) => `progresql-${suffix}`),
}));

const STORAGE_KEY = 'progresql-user-descriptions';

describe('descriptionStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  // ── getDescription ────────────────────────────────────────────────────────

  describe('getDescription', () => {
    it('returns empty string when no descriptions are stored', () => {
      expect(getDescription('table', 'public', 'users')).toBe('');
    });

    it('returns empty string for an unknown object', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'table:public.orders': 'Orders table' }));
      expect(getDescription('table', 'public', 'users')).toBe('');
    });

    it('returns the stored description for a known object', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'table:public.users': 'User accounts' }));
      expect(getDescription('table', 'public', 'users')).toBe('User accounts');
    });

    it('handles different object types correctly', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          'table:public.users': 'User accounts',
          'view:public.user_stats': 'Aggregated user statistics',
          'column:public.users.email': 'Email address',
        })
      );
      expect(getDescription('table', 'public', 'users')).toBe('User accounts');
      expect(getDescription('view', 'public', 'user_stats')).toBe('Aggregated user statistics');
      expect(getDescription('column', 'public', 'users.email')).toBe('Email address');
    });

    it('returns empty string when localStorage contains invalid JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json{{');
      expect(getDescription('table', 'public', 'users')).toBe('');
    });
  });

  // ── setDescription ────────────────────────────────────────────────────────

  describe('setDescription', () => {
    it('stores a description for a new object', () => {
      setDescription('table', 'public', 'users', 'User accounts');
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored['table:public.users']).toBe('User accounts');
    });

    it('overwrites an existing description', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'table:public.users': 'Old description' }));
      setDescription('table', 'public', 'users', 'Updated description');
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored['table:public.users']).toBe('Updated description');
    });

    it('removes key when description is empty string', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'table:public.users': 'Some description' }));
      setDescription('table', 'public', 'users', '');
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored['table:public.users']).toBeUndefined();
    });

    it('removes key when description is whitespace only', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'table:public.users': 'Some description' }));
      setDescription('table', 'public', 'users', '   ');
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored['table:public.users']).toBeUndefined();
    });

    it('trims whitespace from description before storing', () => {
      setDescription('table', 'public', 'users', '  User accounts  ');
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored['table:public.users']).toBe('User accounts');
    });

    it('preserves other keys when updating one', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ 'table:public.orders': 'Orders table' })
      );
      setDescription('table', 'public', 'users', 'User accounts');
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored['table:public.orders']).toBe('Orders table');
      expect(stored['table:public.users']).toBe('User accounts');
    });

    it('can store multiple different objects', () => {
      setDescription('table', 'public', 'users', 'Users');
      setDescription('table', 'public', 'orders', 'Orders');
      setDescription('view', 'analytics', 'stats', 'Stats view');
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(Object.keys(all)).toHaveLength(3);
    });
  });

  // ── getAllDescriptions ────────────────────────────────────────────────────

  describe('getAllDescriptions', () => {
    it('returns empty object when nothing is stored', () => {
      expect(getAllDescriptions()).toEqual({});
    });

    it('returns all stored descriptions', () => {
      const data = {
        'table:public.users': 'Users',
        'table:public.orders': 'Orders',
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      expect(getAllDescriptions()).toEqual(data);
    });

    it('returns empty object when localStorage has invalid JSON', () => {
      localStorage.setItem(STORAGE_KEY, '{bad json}');
      expect(getAllDescriptions()).toEqual({});
    });
  });

  // ── getDescriptionsForContext ─────────────────────────────────────────────

  describe('getDescriptionsForContext', () => {
    it('returns empty string when no descriptions are stored', () => {
      expect(getDescriptionsForContext()).toBe('');
    });

    it('formats a single description as "key: description"', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ 'table:public.users': 'User accounts' })
      );
      expect(getDescriptionsForContext()).toBe('table:public.users: User accounts');
    });

    it('formats multiple descriptions joined by newlines', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          'table:public.users': 'User accounts',
          'table:public.orders': 'Orders',
        })
      );
      const result = getDescriptionsForContext();
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines).toContain('table:public.users: User accounts');
      expect(lines).toContain('table:public.orders: Orders');
    });

    it('returns empty string when localStorage has invalid JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'bad{json}');
      expect(getDescriptionsForContext()).toBe('');
    });
  });

  // ── Round-trip ────────────────────────────────────────────────────────────

  describe('round-trip: setDescription then getDescription', () => {
    it('stores and retrieves description correctly', () => {
      setDescription('table', 'myschema', 'products', 'Product catalog');
      expect(getDescription('table', 'myschema', 'products')).toBe('Product catalog');
    });

    it('deletion is reflected in getDescription', () => {
      setDescription('table', 'public', 'users', 'Users');
      setDescription('table', 'public', 'users', '');
      expect(getDescription('table', 'public', 'users')).toBe('');
    });
  });
});
