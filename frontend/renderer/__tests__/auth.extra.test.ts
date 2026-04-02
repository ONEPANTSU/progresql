/*
* Created on Mar 28, 2026
* Test file for auth.ts (extended coverage)
* File path: renderer/__tests__/auth.extra.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import {
  authService,
  getAuthToken,
} from '@/features/auth/auth';

// ── Mock dependencies ─────────────────────────────────────────────────────────

jest.mock('@/shared/lib/secureSettingsStorage', () => ({
  loadBackendUrl: jest.fn(() => 'https://progresql.com'),
}));

const TOKEN_KEY = 'progresql-auth-token';
const CURRENT_USER_KEY = 'progresql-current-user';

// ── Helpers ───────────────────────────────────────────────────────────────────

function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('auth service (extended coverage)', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  // ── authService.acceptLegal ────────────────────────────────────────────────

  describe('authService.acceptLegal', () => {
    it('sends POST to legal/accept endpoint with token', async () => {
      localStorage.setItem(TOKEN_KEY, 'legal-token');
      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;

      await authService.acceptLegal('privacy_policy', '1.0');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/legal/accept'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer legal-token' }),
        })
      );
    });

    it('sends POST to legal/accept endpoint without token', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;

      await authService.acceptLegal('terms_of_service', '2.0');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/legal/accept'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ── authService.sendVerificationCode ──────────────────────────────────────

  describe('authService.sendVerificationCode', () => {
    it('returns message on successful code send', async () => {
      localStorage.setItem(TOKEN_KEY, 'auth-token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'Code sent to your email' }),
      }) as jest.Mock;

      const msg = await authService.sendVerificationCode();
      expect(msg).toBe('Code sent to your email');
    });

    it('throws on failed send verification code', async () => {
      localStorage.setItem(TOKEN_KEY, 'auth-token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Failed to send code' }),
      }) as jest.Mock;

      await expect(authService.sendVerificationCode()).rejects.toThrow('Failed to send code');
    });

    it('throws generic message when no error field in response', async () => {
      localStorage.setItem(TOKEN_KEY, 'auth-token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }) as jest.Mock;

      await expect(authService.sendVerificationCode()).rejects.toThrow('Failed to send code');
    });

    it('sends with Authorization header when token exists', async () => {
      localStorage.setItem(TOKEN_KEY, 'verif-token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'Sent' }),
      }) as jest.Mock;

      await authService.sendVerificationCode();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/auth/send-verification'),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer verif-token' }),
        })
      );
    });

    it('sends without Authorization header when no token', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'Sent' }),
      }) as jest.Mock;

      await authService.sendVerificationCode();

      const callArgs = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(callArgs.headers.Authorization).toBeUndefined();
    });
  });

  // ── authService.forgotPassword ────────────────────────────────────────────

  describe('authService.forgotPassword', () => {
    it('returns message on successful forgot password request', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'Reset code sent' }),
      }) as jest.Mock;

      const msg = await authService.forgotPassword('user@example.com');
      expect(msg).toBe('Reset code sent');
    });

    it('throws on failed forgot password', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Email not found' }),
      }) as jest.Mock;

      await expect(authService.forgotPassword('unknown@example.com')).rejects.toThrow('Email not found');
    });

    it('throws generic message when no error field', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }) as jest.Mock;

      await expect(authService.forgotPassword('x@x.com')).rejects.toThrow('Failed to send code');
    });

    it('calls correct endpoint with email', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'OK' }),
      }) as jest.Mock;

      await authService.forgotPassword('test@example.com');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/auth/forgot-password'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'test@example.com' }),
        })
      );
    });
  });

  // ── authService.resetPassword ─────────────────────────────────────────────

  describe('authService.resetPassword', () => {
    it('resolves on successful password reset', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
      }) as jest.Mock;

      await expect(
        authService.resetPassword('user@example.com', '123456', 'newPass123!')
      ).resolves.toBeUndefined();
    });

    it('throws on failed password reset', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Invalid or expired code' }),
      }) as jest.Mock;

      await expect(
        authService.resetPassword('user@example.com', 'bad-code', 'newPass')
      ).rejects.toThrow('Invalid or expired code');
    });

    it('throws generic message when response has no error field', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }) as jest.Mock;

      await expect(
        authService.resetPassword('a@b.com', '000', 'pass')
      ).rejects.toThrow('Failed to reset password');
    });

    it('sends correct payload to reset-password endpoint', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;

      await authService.resetPassword('a@b.com', 'CODE', 'myNewPass');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/auth/reset-password'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'a@b.com', code: 'CODE', new_password: 'myNewPass' }),
        })
      );
    });
  });

  // ── authService.verifyCode — no current user branch ───────────────────────

  describe('authService.verifyCode when no current user', () => {
    it('resolves without error when there is no current user to update', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      // No current user in localStorage

      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;

      await expect(authService.verifyCode('123456')).resolves.toBeUndefined();
      // Current user storage remains empty
      expect(localStorage.getItem(CURRENT_USER_KEY)).toBeNull();
    });
  });

  // ── authService.login — fetch network error ───────────────────────────────

  describe('authService.login error paths', () => {
    it('wraps network error with Failed to fetch prefix', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as jest.Mock;

      await expect(authService.login('a@b.com', 'pass')).rejects.toThrow('Failed to fetch: ECONNREFUSED');
    });

    it('wraps non-Error network failure with Failed to fetch prefix', async () => {
      global.fetch = jest.fn().mockRejectedValue('timeout') as jest.Mock;

      await expect(authService.login('a@b.com', 'pass')).rejects.toThrow('Failed to fetch: timeout');
    });
  });

  // ── createPaymentInvoice — no error field ─────────────────────────────────

  describe('createPaymentInvoice error path', () => {
    it('throws generic message when no error field in body', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }) as jest.Mock;

      const { createPaymentInvoice } = require('@/features/auth/auth');
      await expect(createPaymentInvoice()).rejects.toThrow('Failed to create payment invoice');
    });

    it('does not send payment_method in v3 (T-Bank handles method selection)', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ payment_url: 'https://pay.example.com' }),
      }) as jest.Mock;

      const { createPaymentInvoice } = require('@/features/auth/auth');
      await createPaymentInvoice(5);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v3/payments/create-invoice'),
        expect.objectContaining({
          body: expect.not.stringContaining('"payment_method"'),
        })
      );
    });
  });

  // ── applyPromoCode — no error field ───────────────────────────────────────

  describe('applyPromoCode error path', () => {
    it('throws generic message when no error field in body', async () => {
      localStorage.setItem(TOKEN_KEY, 'token');
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }) as jest.Mock;

      const { applyPromoCode } = require('@/features/auth/auth');
      await expect(applyPromoCode('BADCODE')).rejects.toThrow('Invalid or expired promo code');
    });
  });
});
