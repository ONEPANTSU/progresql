import React, { useState, useRef } from 'react';
import { Box, Button, CircularProgress, Link as MuiLink, Paper, TextField, Typography, Alert } from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAuth } from '../providers/AuthProvider';
import Logo from '../components/Logo';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * Navigate using full page reload in Electron production.
 * Next.js client-side routing with file:// protocol breaks on Windows
 * (JS chunks fail to load → white screen). Full reload is reliable.
 */
function navigateTo(route: string, router: ReturnType<typeof useRouter>) {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    // Electron production: full page reload to the target HTML file
    const page = route === '/' ? 'index' : route.replace(/^\//, '');
    window.location.href = `./${page}.html`;
  } else {
    // Dev mode or web: use Next.js router
    router.replace(route);
  }
}

export default function LoginPage() {
  const router = useRouter();
  const { login, isAuthenticated, isEmailVerified } = useAuth();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const navigatingRef = useRef(false);
  const [navigating, setNavigating] = useState(false);

  // Handle page load when already authenticated (e.g., direct navigation)
  React.useEffect(() => {
    if (isAuthenticated && !navigatingRef.current) {
      navigatingRef.current = true;
      setNavigating(true);
      if (!isEmailVerified) {
        navigateTo('/verify-email', router);
      } else {
        navigateTo('/', router);
      }
    }
  }, [isAuthenticated, isEmailVerified, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: { email?: string; password?: string } = {};
    if (!email.trim()) errs.email = t('auth.login.emailRequired') || 'Email is required';
    if (!password) errs.password = t('auth.login.passwordRequired') || 'Password is required';
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setError(null);
    setLoading(true);
    try {
      const loggedInUser = await login(email.trim(), password);
      // Navigate explicitly based on verification status
      navigatingRef.current = true;
      setNavigating(true);
      if (loggedInUser && !loggedInUser.emailVerified) {
        navigateTo('/verify-email', router);
      } else {
        navigateTo('/', router);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[LOGIN] Login failed:', msg, err);
      setError(msg || t('auth.login.error'));
      setLoading(false);
    }
  };

  // Fallback: if navigation gets stuck, reset after 5 seconds
  React.useEffect(() => {
    if (!navigating) return;
    const timer = setTimeout(() => {
      console.warn('[LOGIN] Navigation timeout — resetting');
      navigatingRef.current = false;
      setNavigating(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, [navigating]);

  if (navigating) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ width: '100%', maxWidth: 420, p: 4 }}>
        {/* Logo */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 3 }}>
          <Box sx={{ mr: 2 }}>
            <Logo size={64} />
          </Box>
          <Typography
            variant="h4"
            sx={{
              color: 'text.primary',
              fontWeight: 700,
            }}
          >
            ProgreSQL
          </Typography>
        </Box>

        <Typography variant="h5" gutterBottom sx={{ textAlign: 'center' }}>{t('auth.login.title')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
          {t('auth.login.subtitle')}
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box component="form" noValidate onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2 }}>
          <TextField label={t('auth.login.email')} type="email" value={email} onChange={e => { setEmail(e.target.value); setFieldErrors(prev => ({ ...prev, email: undefined })); }} error={!!fieldErrors.email} helperText={fieldErrors.email} fullWidth autoFocus />
          <TextField label={t('auth.login.password')} type="password" value={password} onChange={e => { setPassword(e.target.value); setFieldErrors(prev => ({ ...prev, password: undefined })); }} error={!!fieldErrors.password} helperText={fieldErrors.password} fullWidth />
          <Button type="submit" variant="contained" disabled={loading}>
            {loading ? t('auth.login.submitting') : t('auth.login.submit')}
          </Button>
        </Box>
        <Typography variant="body2" sx={{ mt: 2 }}>
          {t('auth.login.noAccount')} <MuiLink component={Link} href="/register">{t('auth.login.register')}</MuiLink>
        </Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>
          <MuiLink component={Link} href="/forgot-password">{t('auth.login.forgotPassword')}</MuiLink>
        </Typography>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            gap: 2,
            mt: 3,
            pt: 2,
            borderTop: 1,
            borderColor: 'divider',
          }}
        >
          {([
            { label: t('auth.login.legalPrivacy'), url: 'https://progresql.com/privacy' },
            { label: t('auth.login.legalTerms'), url: 'https://progresql.com/terms' },
            { label: t('auth.login.legalOffer'), url: 'https://progresql.com/offer' },
            { label: t('auth.login.legalSupport'), url: 'https://progresql.com/contacts' },
          ] as const).map(({ label, url }) => (
            <MuiLink
              key={url}
              component="button"
              variant="caption"
              color="text.secondary"
              sx={{ cursor: 'pointer' }}
              onClick={() => {
                if (window.electronAPI?.openExternal) {
                  window.electronAPI.openExternal(url);
                } else {
                  window.open(url, '_blank');
                }
              }}
            >
              {label}
            </MuiLink>
          ))}
        </Box>
      </Paper>
    </Box>
  );
}
