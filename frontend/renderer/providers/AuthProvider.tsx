import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { AuthContextValue, AuthUser } from '../types';
import { authService, getAuthToken, loadPersistedAuth } from '../services/auth';
import { migrateToUserStorage } from '../utils/userStorage';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function initAuth() {
      // Restore auth from disk if localStorage was cleared (e.g. after reboot)
      await loadPersistedAuth();

      const token = getAuthToken();
      const existing = authService.getCurrentUser();

      // If token is missing but user data exists, clear stale user data
      if (!token && existing) {
        authService.logout();
        setIsReady(true);
        return;
      }

      if (existing && token) {
        setUser(existing);
        migrateToUserStorage();
        // Fetch fresh profile from server on startup
        authService.refreshUser().then(updated => {
          if (updated) {
            setUser(updated);
          } else {
            // Backend rejected the token — force logout
            authService.logout();
            setUser(null);
          }
        }).catch(() => {});
        setIsReady(true);
      } else if (token && !existing) {
        // Token exists but user data is missing (e.g. partially cleared localStorage)
        // Try to restore user from backend
        authService.refreshUser().then(updated => {
          if (updated) {
            setUser(updated);
            migrateToUserStorage();
          } else {
            // Token is invalid — clear it
            authService.logout();
          }
          setIsReady(true);
        }).catch(() => {
          authService.logout();
          setIsReady(true);
        });
      } else {
        setIsReady(true);
      }
    }

    initAuth();
  }, []);

  // Listen for localStorage changes (e.g. token cleared externally or in another tab)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'progresql-auth-token' && !e.newValue) {
        // Token was removed — force logout
        setUser(null);
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Periodically refresh user profile (every 60 seconds)
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      authService.refreshUser().then(updated => {
        if (updated) setUser(updated);
      }).catch(() => {});
    }, 60 * 1000);
    return () => clearInterval(interval);
  }, [!!user]);

  const login = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    const loggedIn = await authService.login(email, password);
    migrateToUserStorage();
    setUser(loggedIn);
    return loggedIn;
  }, []);

  const register = useCallback(async (name: string, email: string, password: string, marketingConsent?: boolean) => {
    const registered = await authService.register(name, email, password, marketingConsent);
    migrateToUserStorage();
    setUser(registered);
  }, []);

  const logout = useCallback(() => {
    authService.logout();
    setUser(null);
  }, []);

  const sendVerificationCode = useCallback(async () => {
    return authService.sendVerificationCode();
  }, []);

  const verifyCode = useCallback(async (code: string) => {
    await authService.verifyCode(code);
    setUser(prev => prev ? { ...prev, emailVerified: true } : prev);
  }, []);

  const refreshUser = useCallback(async () => {
    const updated = await authService.refreshUser();
    if (updated) {
      setUser(updated);
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isAuthenticated: !!user,
    isEmailVerified: !!user?.emailVerified,
    login,
    register,
    logout,
    sendVerificationCode,
    verifyCode,
    refreshUser,
  }), [user, login, register, logout, sendVerificationCode, verifyCode, refreshUser]);

  if (!isReady) {
    return (
      <Box sx={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
      }}>
        <CircularProgress size={32} />
      </Box>
    );
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
