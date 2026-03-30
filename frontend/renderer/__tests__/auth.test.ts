/*
* Created on Mar 27, 2026
* Test file for auth.ts
* File path: renderer/__tests__/auth.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import {
  getAuthToken,
  getSubscriptionWarning,
  isSubscriptionActive,
  createPaymentInvoice,
  applyPromoCode,
  authService,
} from '../services/auth';
import type { AuthUser } from '../types';

// ── Mock dependencies ─────────────────────────────────────────────────────────

jest.mock('../utils/secureSettingsStorage', () => ({
  loadBackendUrl: jest.fn(() => 'https://progresql.com'),
}));

const TOKEN_KEY = 'progresql-auth-token';
const CURRENT_USER_KEY = 'progresql-current-user';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    plan: 'pro',
    ...overrides,
  };
}

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('auth service', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  // ── getAuthToken ───────────────────────────────────────────────────────────

  describe('getAuthToken', () => {
    it('returns null when no token is stored', () => {
      expect(getAuthToken()).toBeNull();
    });

    it('returns the stored token', () => {
      localStorage.setItem(TOKEN_KEY, 'my-jwt-token');
      expect(getAuthToken()).toBe('my-jwt-token');
    });
  });

  // ── authService.getCurrentUser ────────────────────────────────────────────

  describe('authService.getCurrentUser', () => {
    it('returns null when nothing is stored', () => {
      expect(authService.getCurrentUser()).toBeNull();
    });

    it('returns the stored user', () => {
      const user = makeUser();
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
      expect(authService.getCurrentUser()).toEqual(user);
    });

    it('returns null for invalid JSON', () => {
      localStorage.setItem(CURRENT_USER_KEY, 'INVALID_JSON{{{');
      expect(authService.getCurrentUser()).toBeNull();
    });
  });

  // ── authService.logout ────────────────────────────────────────────────────

  describe('authService.logout', () => {
    it('clears token and current user from localStorage', () => {
      localStorage.setItem(TOKEN_KEY, 'some-token');
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(makeUser()));

      authService.logout();

      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(localStorage.getItem(CURRENT_USER_KEY)).toBeNull();
    });
  });

  // ── authService.login ─────────────────────────────────────────────────────

  describe('authService.login', () => {
    it('saves token and user on successful login', async () => {
      const mockResponse = {
        token: 'access-token-123',
        expires_at: futureDate(7),
        user: {
          id: 'u1',
          email: 'user@example.com',
          name: 'User',
          email_verified: true,
          plan: 'pro',
          plan_expires_at: futureDate(30),
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }) as jest.Mock;

      const user = await authService.login('user@example.com', 'password123');

      expect(user.id).toBe('u1');
      expect(user.email).toBe('user@example.com');
      expect(user.emailVerified).toBe(true);
      expect(user.plan).toBe('pro');
      expect(localStorage.getItem(TOKEN_KEY)).toBe('access-token-123');
      expect(localStorage.getItem(CURRENT_USER_KEY)).not.toBeNull();
    });

    it('throws an error on failed login (non-ok response)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Invalid email or password' }),
      }) as jest.Mock;

      await expect(authService.login('bad@example.com', 'wrong')).rejects.toThrow(
        'Invalid email or password'
      );
    });

    it('throws with generic message when server returns no error field', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }) as jest.Mock;

      await expect(authService.login('a@b.com', 'pass')).rejects.toThrow(
        'Invalid email or password'
      );
    });

    it('throws when fetch itself fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as jest.Mock;

      await expect(authService.login('a@b.com', 'pass')).rejects.toThrow('Failed to fetch');
    });
  });

  // ── authService.register ──────────────────────────────────────────────────

  describe('authService.register', () => {
    it('saves token and user on successful registration', async () => {
      const mockResponse = {
        token: 'reg-token',
        expires_at: futureDate(7),
        user: {
          id: 'u2',
          email: 'new@example.com',
          name: 'New User',
          email_verified: false,
          plan: 'free',
          trial_ends_at: futureDate(14),
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }) as jest.Mock;

      const user = await authService.register('New User', 'new@example.com', 'pass123');

      expect(user.id).toBe('u2');
      expect(user.emailVerified).toBe(false);
      expect(localStorage.getItem(TOKEN_KEY)).toBe('reg-token');
    });

    it('throws on failed registration', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Email already exists' }),
      }) as jest.Mock;

      await expect(
        authService.register('User', 'exists@example.com', 'pass')
      ).rejects.toThrow('Email already exists');
    });
  });

  // ── authService.refreshUser ───────────────────────────────────────────────

  describe('authService.refreshUser', () => {
    it('returns null when no token is present', async () => {
      expect(await authService.refreshUser()).toBeNull();
    });

    it('returns null on non-ok response', async () => {
      localStorage.setItem(TOKEN_KEY, 'some-token');
      global.fetch = jest.fn().mockResolvedValue({ ok: false }) as jest.Mock;
      expect(await authService.refreshUser()).toBeNull();
    });

    it('updates and returns user on success', async () => {
      localStorage.setItem(TOKEN_KEY, 'valid-token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          user: {
            id: 'u1',
            email: 'a@b.com',
            name: 'A',
            email_verified: true,
            plan: 'pro_plus',
          },
        }),
      }) as jest.Mock;

      const result = await authService.refreshUser();
      expect(result).not.toBeNull();
      expect(result!.plan).toBe('pro_plus');
      expect(localStorage.getItem(CURRENT_USER_KEY)).not.toBeNull();
    });

    it('handles flat response structure (not nested under user)', async () => {
      localStorage.setItem(TOKEN_KEY, 'valid-token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          id: 'u2',
          email: 'flat@b.com',
          name: 'Flat',
          email_verified: false,
          plan: 'pro',
        }),
      }) as jest.Mock;

      const result = await authService.refreshUser();
      expect(result!.id).toBe('u2');
      expect(result!.email).toBe('flat@b.com');
    });
  });

  // ── authService.verifyCode ────────────────────────────────────────────────

  describe('authService.verifyCode', () => {
    it('marks current user as email verified in localStorage', async () => {
      const user = makeUser({ emailVerified: false });
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
      localStorage.setItem(TOKEN_KEY, 'token');

      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;

      await authService.verifyCode('123456');

      const stored = JSON.parse(localStorage.getItem(CURRENT_USER_KEY)!);
      expect(stored.emailVerified).toBe(true);
    });

    it('throws on invalid code', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Invalid code' }),
      }) as jest.Mock;

      await expect(authService.verifyCode('wrong')).rejects.toThrow('Invalid code');
    });
  });

  // ── getSubscriptionWarning ────────────────────────────────────────────────

  describe('getSubscriptionWarning', () => {
    it('returns null for a null user', () => {
      expect(getSubscriptionWarning(null)).toBeNull();
    });

    it('returns server-provided subscriptionWarning when present', () => {
      const user = makeUser({ subscriptionWarning: 'expiring_soon' });
      expect(getSubscriptionWarning(user)).toBe('expiring_soon');
    });

    it('returns "expired" for pro plan with past expiry', () => {
      const user = makeUser({ plan: 'pro', planExpiresAt: pastDate(1) });
      expect(getSubscriptionWarning(user)).toBe('expired');
    });

    it('returns "expiring_soon" for pro plan expiring within 3 days', () => {
      const user = makeUser({ plan: 'pro', planExpiresAt: futureDate(1) });
      expect(getSubscriptionWarning(user)).toBe('expiring_soon');
    });

    it('returns null for pro plan with expiry far in the future', () => {
      const user = makeUser({ plan: 'pro', planExpiresAt: futureDate(30) });
      expect(getSubscriptionWarning(user)).toBeNull();
    });

    it('returns "expired" for pro_plus plan with past expiry', () => {
      const user = makeUser({ plan: 'pro_plus', planExpiresAt: pastDate(5) });
      expect(getSubscriptionWarning(user)).toBe('expired');
    });

    it('returns "expired" when trial has ended', () => {
      const user = makeUser({ plan: 'free', trialEndsAt: pastDate(1) });
      expect(getSubscriptionWarning(user)).toBe('expired');
    });

    it('returns "expiring_soon" for trial ending within 3 days', () => {
      const user = makeUser({ plan: 'free', trialEndsAt: futureDate(2) });
      expect(getSubscriptionWarning(user)).toBe('expiring_soon');
    });

    it('returns null for active trial with plenty of time left', () => {
      const user = makeUser({ plan: 'free', trialEndsAt: futureDate(10) });
      expect(getSubscriptionWarning(user)).toBeNull();
    });

    it('returns "expired" for free plan with no trial', () => {
      const user = makeUser({ plan: 'free', trialEndsAt: undefined });
      expect(getSubscriptionWarning(user)).toBe('expired');
    });
  });

  // ── isSubscriptionActive ──────────────────────────────────────────────────

  describe('isSubscriptionActive', () => {
    it('returns false for null user', () => {
      expect(isSubscriptionActive(null)).toBe(false);
    });

    it('returns true for pro plan with future expiry', () => {
      const user = makeUser({ plan: 'pro', planExpiresAt: futureDate(10) });
      expect(isSubscriptionActive(user)).toBe(true);
    });

    it('returns false for pro plan with past expiry', () => {
      const user = makeUser({ plan: 'pro', planExpiresAt: pastDate(1) });
      expect(isSubscriptionActive(user)).toBe(false);
    });

    it('returns true for pro_plus plan with future expiry', () => {
      const user = makeUser({ plan: 'pro_plus', planExpiresAt: futureDate(5) });
      expect(isSubscriptionActive(user)).toBe(true);
    });

    it('returns false for pro_plus plan with past expiry', () => {
      const user = makeUser({ plan: 'pro_plus', planExpiresAt: pastDate(3) });
      expect(isSubscriptionActive(user)).toBe(false);
    });

    it('returns true when trial is still active', () => {
      const user = makeUser({ plan: 'free', trialEndsAt: futureDate(7) });
      expect(isSubscriptionActive(user)).toBe(true);
    });

    it('returns false when trial has expired', () => {
      const user = makeUser({ plan: 'free', trialEndsAt: pastDate(1) });
      expect(isSubscriptionActive(user)).toBe(false);
    });

    it('returns false for free plan with no trial and no expiry', () => {
      const user = makeUser({ plan: 'free', trialEndsAt: undefined, planExpiresAt: undefined });
      expect(isSubscriptionActive(user)).toBe(false);
    });
  });

  // ── createPaymentInvoice ──────────────────────────────────────────────────

  describe('createPaymentInvoice', () => {
    it('returns payment_url on success', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ payment_url: 'https://pay.example.com/invoice' }),
      }) as jest.Mock;

      const result = await createPaymentInvoice();
      expect(result.payment_url).toBe('https://pay.example.com/invoice');
    });

    it('throws on failed request', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Payment failed' }),
      }) as jest.Mock;

      await expect(createPaymentInvoice()).rejects.toThrow('Payment failed');
    });
  });

  // ── applyPromoCode ────────────────────────────────────────────────────────

  describe('applyPromoCode', () => {
    it('returns plan details on successful promo application', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          plan: 'pro',
          expires_at: futureDate(30),
        }),
      }) as jest.Mock;

      const result = await applyPromoCode('PROMO50');
      expect(result.success).toBe(true);
      expect(result.plan).toBe('pro');
    });

    it('throws on invalid or expired promo code', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Invalid or expired promo code' }),
      }) as jest.Mock;

      await expect(applyPromoCode('BAD-CODE')).rejects.toThrow('Invalid or expired promo code');
    });
  });
});
