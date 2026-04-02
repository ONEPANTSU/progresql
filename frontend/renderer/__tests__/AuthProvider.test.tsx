/*
* Created on Mar 27, 2026
* Test file for AuthProvider.tsx
* File path: renderer/__tests__/AuthProvider.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import type { AuthUser } from '@/shared/types';

// ── Mock dependencies ─────────────────────────────────────────────────────────

const mockLogin = jest.fn();
const mockRegister = jest.fn();
const mockLogout = jest.fn();
const mockRefreshUser = jest.fn();
const mockGetCurrentUser = jest.fn();
const mockSendVerificationCode = jest.fn();
const mockVerifyCode = jest.fn();

const mockGetAuthToken = jest.fn();

jest.mock('@/features/auth/auth', () => ({
  authService: {
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
    login: (...args: unknown[]) => mockLogin(...args),
    register: (...args: unknown[]) => mockRegister(...args),
    logout: (...args: unknown[]) => mockLogout(...args),
    refreshUser: (...args: unknown[]) => mockRefreshUser(...args),
    sendVerificationCode: (...args: unknown[]) => mockSendVerificationCode(...args),
    verifyCode: (...args: unknown[]) => mockVerifyCode(...args),
  },
  getAuthToken: (...args: unknown[]) => mockGetAuthToken(...args),
  loadPersistedAuth: jest.fn().mockImplementation(() => Promise.resolve()),
}));

jest.mock('@/shared/lib/userStorage', () => ({
  migrateToUserStorage: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    plan: 'pro',
    planExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// A consumer that exposes auth context values for assertions
function AuthConsumer({ onMount }: { onMount?: (ctx: ReturnType<typeof useAuth>) => void }) {
  const ctx = useAuth();
  React.useEffect(() => {
    onMount?.(ctx);
  });
  return (
    <div>
      <span data-testid="authenticated">{String(ctx.isAuthenticated)}</span>
      <span data-testid="email-verified">{String(ctx.isEmailVerified)}</span>
      <span data-testid="user-email">{ctx.user?.email ?? 'none'}</span>
      <button onClick={() => ctx.logout()}>Logout</button>
      <button onClick={() => ctx.login('a@b.com', 'pass')}>Login</button>
    </div>
  );
}

function renderWithProvider(onMount?: (ctx: ReturnType<typeof useAuth>) => void) {
  return render(
    <AuthProvider>
      <AuthConsumer onMount={onMount} />
    </AuthProvider>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentUser.mockReturnValue(null);
    mockGetAuthToken.mockReturnValue(null);
    mockRefreshUser.mockResolvedValue(null);
  });

  // ── Initial render ────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('renders children with unauthenticated state when no stored user', async () => {
      renderWithProvider();
      await waitFor(() => {
        expect(screen.getByTestId('authenticated').textContent).toBe('false');
      });
    });

    it('restores user from storage if one exists', async () => {
      const user = makeUser();
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(user);
      mockRefreshUser.mockResolvedValue(user);

      renderWithProvider();

      await waitFor(() => {
        expect(screen.getByTestId('user-email').textContent).toBe('test@example.com');
        expect(screen.getByTestId('authenticated').textContent).toBe('true');
      });
    });

    it('updates user when refreshUser returns fresh data', async () => {
      const storedUser = makeUser({ name: 'Old Name' });
      const freshUser = makeUser({ name: 'Fresh Name' });
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(storedUser);
      mockRefreshUser.mockResolvedValue(freshUser);

      let captured: ReturnType<typeof useAuth> | null = null;
      renderWithProvider((ctx) => { captured = ctx; });

      await waitFor(() => {
        expect(captured?.user?.name).toBe('Fresh Name');
      });
    });

    it('does not call refreshUser when no stored user exists', async () => {
      renderWithProvider();
      await waitFor(() => {
        expect(screen.getByTestId('authenticated').textContent).toBe('false');
      });
      expect(mockRefreshUser).not.toHaveBeenCalled();
    });
  });

  // ── isEmailVerified ───────────────────────────────────────────────────────

  describe('isEmailVerified', () => {
    it('is true when user has emailVerified = true', async () => {
      const user = makeUser({ emailVerified: true });
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(user);
      mockRefreshUser.mockResolvedValue(user);

      renderWithProvider();

      await waitFor(() => {
        expect(screen.getByTestId('email-verified').textContent).toBe('true');
      });
    });

    it('is false when user has emailVerified = false', async () => {
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(makeUser({ emailVerified: false }));

      renderWithProvider();

      await waitFor(() => {
        expect(screen.getByTestId('email-verified').textContent).toBe('false');
      });
    });

    it('is false when no user is authenticated', async () => {
      renderWithProvider();

      await waitFor(() => {
        expect(screen.getByTestId('email-verified').textContent).toBe('false');
      });
    });
  });

  // ── login ─────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('sets user after successful login', async () => {
      const user = makeUser();
      mockLogin.mockResolvedValue(user);

      renderWithProvider();

      await waitFor(() => {
        expect(screen.getByTestId('authenticated').textContent).toBe('false');
      });

      await act(async () => {
        screen.getByText('Login').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('user-email').textContent).toBe('test@example.com');
        expect(screen.getByTestId('authenticated').textContent).toBe('true');
      });
    });
  });

  // ── logout ────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('clears user after logout', async () => {
      const user = makeUser();
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(user);
      mockRefreshUser.mockResolvedValue(user);

      renderWithProvider();

      await waitFor(() => {
        expect(screen.getByTestId('authenticated').textContent).toBe('true');
      });

      await act(async () => {
        screen.getByText('Logout').click();
      });

      expect(screen.getByTestId('authenticated').textContent).toBe('false');
      expect(screen.getByTestId('user-email').textContent).toBe('none');
      expect(mockLogout).toHaveBeenCalled();
    });
  });

  // ── useAuth outside provider ──────────────────────────────────────────────

  describe('useAuth outside provider', () => {
    it('throws when useAuth is called outside AuthProvider', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<AuthConsumer />);
      }).toThrow('useAuth must be used within AuthProvider');

      spy.mockRestore();
    });
  });

  // ── verifyCode ────────────────────────────────────────────────────────────

  describe('verifyCode', () => {
    it('marks user email as verified after verifyCode is called', async () => {
      const user = makeUser({ emailVerified: false });
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(user);
      // refreshUser must resolve before verifyCode is called — return same user
      mockRefreshUser.mockResolvedValue(user);
      mockVerifyCode.mockResolvedValue(undefined);

      let captured: ReturnType<typeof useAuth> | null = null;
      renderWithProvider((ctx) => { captured = ctx; });

      // Wait for initAuth to complete including the fire-and-forget refreshUser
      await waitFor(() => {
        expect(captured?.user).not.toBeNull();
      });
      // Ensure refreshUser from initAuth has fully resolved and state settled
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });

      await act(async () => {
        await captured?.verifyCode('123456');
      });

      await waitFor(() => {
        expect(captured?.isEmailVerified).toBe(true);
      });
    });
  });

  // ── sendVerificationCode ──────────────────────────────────────────────────

  describe('sendVerificationCode', () => {
    it('delegates to authService.sendVerificationCode', async () => {
      mockSendVerificationCode.mockResolvedValue('Code sent');

      let captured: ReturnType<typeof useAuth> | null = null;
      renderWithProvider((ctx) => { captured = ctx; });

      await waitFor(() => expect(captured).not.toBeNull());

      await act(async () => {
        await captured?.sendVerificationCode();
      });

      expect(mockSendVerificationCode).toHaveBeenCalled();
    });
  });

  // ── refreshUser ───────────────────────────────────────────────────────────

  describe('refreshUser', () => {
    it('updates user state when refreshUser returns new data', async () => {
      const initial = makeUser({ name: 'Initial' });
      const refreshed = makeUser({ name: 'Refreshed' });
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(initial);
      // First call (on mount) returns initial, second call (manual) returns refreshed
      mockRefreshUser
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(refreshed);

      let captured: ReturnType<typeof useAuth> | null = null;
      renderWithProvider((ctx) => { captured = ctx; });

      await waitFor(() => expect(captured?.user?.name).toBe('Initial'));

      await act(async () => {
        await captured?.refreshUser();
      });

      await waitFor(() => {
        expect(captured?.user?.name).toBe('Refreshed');
      });
    });

    it('does not change user when refreshUser returns null', async () => {
      const initial = makeUser({ name: 'Stays Same' });
      mockGetAuthToken.mockReturnValue('fake-jwt-token');
      mockGetCurrentUser.mockReturnValue(initial);
      // First call (on mount) returns the user to avoid logout, second (manual) returns null
      mockRefreshUser
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(null);

      let captured: ReturnType<typeof useAuth> | null = null;
      renderWithProvider((ctx) => { captured = ctx; });

      await waitFor(() => expect(captured?.user?.name).toBe('Stays Same'));

      await act(async () => {
        await captured?.refreshUser();
      });

      expect(captured?.user?.name).toBe('Stays Same');
    });
  });
});
