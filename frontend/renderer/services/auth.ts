import { AuthUser, SubscriptionWarning } from '../types';
import { loadBackendUrl } from '../utils/secureSettingsStorage';

const TOKEN_KEY = 'progresql-auth-token';
const CURRENT_USER_KEY = 'progresql-current-user';
const DEFAULT_BACKEND_URL = 'https://progresql.com';

function getBackendUrl(): string {
  return loadBackendUrl(DEFAULT_BACKEND_URL);
}

function saveToken(token: string) {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem(TOKEN_KEY, token);
  }
}

function clearToken() {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return localStorage.getItem(TOKEN_KEY);
}

function saveCurrentUser(user: AuthUser) {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
  }
}

function clearCurrentUser() {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.removeItem(CURRENT_USER_KEY);
  }
}

interface AuthResponse {
  token: string;
  expires_at: string;
  user: {
    id: string;
    email: string;
    name: string;
    email_verified?: boolean;
    plan?: string;
    plan_expires_at?: string;
    trial_ends_at?: string;
    marketing_consent?: boolean;
  };
}

function userFromResponse(data: AuthResponse): AuthUser {
  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name,
    emailVerified: data.user.email_verified ?? false,
    plan: (data.user.plan as AuthUser['plan']) ?? 'free',
    planExpiresAt: data.user.plan_expires_at,
    trialEndsAt: data.user.trial_ends_at,
    marketingConsent: data.user.marketing_consent ?? false,
  };
}

export async function createPaymentInvoice(paymentMethod: number = 11): Promise<{ payment_url: string }> {
  const baseUrl = getBackendUrl();
  const token = getAuthToken();
  const res = await fetch(`${baseUrl}/api/v2/payments/create-invoice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ amount: 1999, currency: 'RUB', payment_method: paymentMethod }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || 'Failed to create payment invoice');
  }

  return res.json();
}

export async function applyPromoCode(code: string): Promise<{ success: boolean; plan: string; expires_at: string }> {
  const baseUrl = getBackendUrl();
  const token = getAuthToken();
  const res = await fetch(`${baseUrl}/api/v1/promo/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ code }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || 'Invalid or expired promo code');
  }

  return res.json();
}

/** Compute subscription warning from user's plan/trial dates (client-side fallback) */
export function getSubscriptionWarning(user: AuthUser | null): SubscriptionWarning {
  // Prefer server-provided value
  if (user?.subscriptionWarning) return user.subscriptionWarning;
  if (!user) return null;

  const now = Date.now();
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

  // Check pro/team plan expiry FIRST (takes priority over trial)
  if ((user.plan === 'pro' || user.plan === 'team') && user.planExpiresAt) {
    const planEnd = new Date(user.planExpiresAt).getTime();
    if (planEnd <= now) return 'expired';
    if (planEnd - now <= THREE_DAYS_MS) return 'expiring_soon';
    return null;
  }

  // Check trial expiry (only for free plan)
  if (user.trialEndsAt) {
    const trialEnd = new Date(user.trialEndsAt).getTime();
    if (trialEnd <= now) return 'expired';
    if (trialEnd - now <= THREE_DAYS_MS) return 'expiring_soon';
    return null;
  }

  // Free plan with no trial = expired (no AI access)
  if (user.plan === 'free' && !user.trialEndsAt) return 'expired';

  return null;
}

/** Check if the user's subscription (pro or trial) is currently active */
export function isSubscriptionActive(user: AuthUser | null): boolean {
  if (!user) return false;
  const now = new Date();

  // Pro plan with valid expiry
  if (user.plan === 'pro' && user.planExpiresAt) {
    if (new Date(user.planExpiresAt) > now) return true;
  }

  // Team plan with valid expiry
  if (user.plan === 'team' && user.planExpiresAt) {
    if (new Date(user.planExpiresAt) > now) return true;
  }

  // Trial still active
  if (user.trialEndsAt) {
    if (new Date(user.trialEndsAt) > now) return true;
  }

  return false;
}

export const authService = {
  getCurrentUser(): AuthUser | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return null;
      }
      const raw = localStorage.getItem(CURRENT_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  async login(email: string, password: string): Promise<AuthUser> {
    const baseUrl = getBackendUrl();
    const url = `${baseUrl}/api/v1/auth/login`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch (fetchErr) {
      console.error('[AUTH] fetch failed:', fetchErr);
      throw new Error(`Failed to fetch: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'Invalid email or password');
    }

    const data: AuthResponse = await res.json();
    saveToken(data.token);

    const user = userFromResponse(data);
    saveCurrentUser(user);
    return user;
  },

  async register(name: string, email: string, password: string, marketingConsent?: boolean): Promise<AuthUser> {
    const baseUrl = getBackendUrl();
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, marketing_consent: !!marketingConsent }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'Registration failed');
    }

    const data: AuthResponse = await res.json();
    saveToken(data.token);

    const user = userFromResponse(data);
    saveCurrentUser(user);
    return user;
  },

  async acceptLegal(docType: string, docVersion: string): Promise<void> {
    const baseUrl = getBackendUrl();
    const token = getAuthToken();
    await fetch(`${baseUrl}/api/v1/legal/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ doc_type: docType, doc_version: docVersion }),
    });
  },

  async sendVerificationCode(): Promise<string> {
    const baseUrl = getBackendUrl();
    const token = getAuthToken();
    const res = await fetch(`${baseUrl}/api/v1/auth/send-verification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'Failed to send code');
    }

    const data = await res.json();
    return data.message;
  },

  async verifyCode(code: string): Promise<void> {
    const baseUrl = getBackendUrl();
    const token = getAuthToken();
    const res = await fetch(`${baseUrl}/api/v1/auth/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'Invalid code');
    }

    // Update local user with verified status.
    const current = authService.getCurrentUser();
    if (current) {
      current.emailVerified = true;
      saveCurrentUser(current);
    }
  },

  async forgotPassword(email: string): Promise<string> {
    const baseUrl = getBackendUrl();
    const res = await fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'Failed to send code');
    }

    const data = await res.json();
    return data.message;
  },

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const baseUrl = getBackendUrl();
    const res = await fetch(`${baseUrl}/api/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, new_password: newPassword }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'Failed to reset password');
    }
  },

  /** Re-fetch user profile from the backend to get fresh plan data */
  async refreshUser(): Promise<AuthUser | null> {
    const baseUrl = getBackendUrl();
    const token = getAuthToken();
    if (!token) return null;

    const res = await fetch(`${baseUrl}/api/v1/auth/profile`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const user: AuthUser = {
      id: data.user?.id ?? data.id,
      email: data.user?.email ?? data.email,
      name: data.user?.name ?? data.name,
      emailVerified: data.user?.email_verified ?? data.email_verified ?? false,
      plan: (data.user?.plan ?? data.plan ?? 'free') as AuthUser['plan'],
      planExpiresAt: data.user?.plan_expires_at ?? data.plan_expires_at,
      trialEndsAt: data.user?.trial_ends_at ?? data.trial_ends_at,
    };
    saveCurrentUser(user);
    return user;
  },

  logout() {
    clearToken();
    clearCurrentUser();
  },
};
