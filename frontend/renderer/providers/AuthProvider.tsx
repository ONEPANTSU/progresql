import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { AuthContextValue, AuthUser } from '../types';
import { authService } from '../services/auth';
import { migrateToUserStorage } from '../utils/userStorage';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const existing = authService.getCurrentUser();
    if (existing) {
      setUser(existing);
      migrateToUserStorage();
      // Fetch fresh profile from server on startup
      authService.refreshUser().then(updated => {
        if (updated) setUser(updated);
      }).catch(() => {});
    }
    setIsReady(true);
  }, []);

  // Periodically refresh user profile (every 5 minutes)
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      authService.refreshUser().then(updated => {
        if (updated) setUser(updated);
      }).catch(() => {});
    }, 5 * 60 * 1000);
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
