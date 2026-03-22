import React, { useState, useMemo, useRef } from 'react';
import { Box, Button, Checkbox, CircularProgress, FormControlLabel, Link as MuiLink, LinearProgress, Paper, TextField, Typography, Alert } from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAuth } from '../providers/AuthProvider';
import Logo from '../components/Logo';
import { useTranslation } from '../contexts/LanguageContext';
import { authService } from '../services/auth';

/** Navigate via IPC in Electron to avoid file:// routing issues on Windows */
function navigateTo(route: string, router: ReturnType<typeof useRouter>) {
  const api = typeof window !== 'undefined' ? (window as any).electronAPI : null;
  if (api) {
    try { api.navigate(route); } catch (_) {}
    if (api.getPageUrl) {
      setTimeout(() => { window.location.href = api.getPageUrl(route); }, 100);
    }
  } else {
    router.replace(route);
  }
}

interface PasswordCheck {
  key: string;
  met: boolean;
}

function getPasswordChecks(password: string): PasswordCheck[] {
  return [
    { key: 'minLength', met: password.length >= 8 },
    { key: 'uppercase', met: /[A-Z]/.test(password) },
    { key: 'lowercase', met: /[a-z]/.test(password) },
    { key: 'digit', met: /[0-9]/.test(password) },
    { key: 'special', met: /[^A-Za-z0-9]/.test(password) },
  ];
}

function getPasswordStrength(password: string): { level: 'weak' | 'medium' | 'strong'; value: number; color: string } {
  if (password.length === 0) return { level: 'weak', value: 0, color: '#d32f2f' };

  const checks = getPasswordChecks(password);
  const metCount = checks.filter(c => c.met).length;

  if (metCount <= 2) return { level: 'weak', value: 20, color: '#d32f2f' };
  if (metCount <= 3) return { level: 'medium', value: 50, color: '#ed6c02' };
  if (metCount <= 4) return { level: 'strong', value: 75, color: '#2e7d32' };
  return { level: 'strong', value: 100, color: '#2e7d32' };
}

export default function RegisterPage() {
  const router = useRouter();
  const { register, isAuthenticated, isEmailVerified } = useAuth();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);

  const navigatingRef = useRef(false);
  const [navigating, setNavigating] = useState(false);

  const passwordChecks = useMemo(() => getPasswordChecks(password), [password]);
  const strength = useMemo(() => getPasswordStrength(password), [password]);
  const allChecksMet = passwordChecks.every(c => c.met);

  const strengthLabels: Record<string, string> = {
    weak: t('auth.register.passwordWeak'),
    medium: t('auth.register.passwordMedium'),
    strong: t('auth.register.passwordStrong'),
  };

  const checkLabels: Record<string, string> = {
    minLength: t('auth.register.req.minLength'),
    uppercase: t('auth.register.req.uppercase'),
    lowercase: t('auth.register.req.lowercase'),
    digit: t('auth.register.req.digit'),
    special: t('auth.register.req.special'),
  };

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

  const openLegalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!legalAccepted) {
      setError(t('auth.register.legalRequired'));
      return;
    }
    if (!allChecksMet) {
      setError(t('auth.register.passwordRequirementFail'));
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await register(name.trim(), email.trim(), password, marketingConsent);
      // Send legal acceptance after successful registration (fire-and-forget)
      Promise.all([
        authService.acceptLegal('terms', '1.0'),
        authService.acceptLegal('privacy', '1.0'),
      ]).catch(() => {});
      // Navigate explicitly to avoid race with useEffect
      navigatingRef.current = true;
      setNavigating(true);
      navigateTo('/verify-email', router);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.register.error'));
      setLoading(false);
    }
  };

  if (navigating) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ width: '100%', maxWidth: 480, p: 4 }}>
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

        <Typography variant="h5" gutterBottom sx={{ textAlign: 'center' }}>{t('auth.register.title')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
          {t('auth.register.subtitle')}
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box component="form" noValidate onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2 }}>
          <TextField label={t('auth.register.name')} value={name} onChange={e => setName(e.target.value)} fullWidth autoFocus />
          <TextField label={t('auth.register.email')} type="email" value={email} onChange={e => setEmail(e.target.value)} fullWidth />
          <TextField label={t('auth.register.password')} type="password" value={password} onChange={e => setPassword(e.target.value)} fullWidth />

          {/* Password strength indicator */}
          {password.length > 0 && (
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t('auth.register.passwordStrength')}
                </Typography>
                <Typography variant="caption" sx={{ color: strength.color, fontWeight: 600 }}>
                  {strengthLabels[strength.level]}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={strength.value}
                sx={{
                  height: 6,
                  borderRadius: 3,
                  bgcolor: 'action.hover',
                  '& .MuiLinearProgress-bar': {
                    bgcolor: strength.color,
                    borderRadius: 3,
                  },
                }}
              />
              <Box sx={{ mt: 1 }}>
                {passwordChecks.map((check) => (
                  <Typography
                    key={check.key}
                    variant="caption"
                    sx={{
                      display: 'block',
                      color: check.met ? 'success.main' : 'text.disabled',
                      lineHeight: 1.6,
                    }}
                  >
                    {check.met ? '\u2713' : '\u2717'} {checkLabels[check.key]}
                  </Typography>
                ))}
              </Box>
            </Box>
          )}

          <FormControlLabel
            control={
              <Checkbox
                checked={legalAccepted}
                onChange={(e) => setLegalAccepted(e.target.checked)}
                size="small"
              />
            }
            label={
              <Typography variant="caption" color="text.secondary">
                {t('auth.register.legalConsent')
                  .split(/{terms}|{privacy}/)
                  .reduce<React.ReactNode[]>((acc, part, i) => {
                    if (i > 0) {
                      const placeholder = t('auth.register.legalConsent').match(/{terms}|{privacy}/g)?.[i - 1];
                      if (placeholder === '{terms}') {
                        acc.push(
                          <MuiLink
                            key="terms"
                            component="button"
                            type="button"
                            variant="caption"
                            onClick={(e: React.MouseEvent) => { e.preventDefault(); openLegalLink('https://progresql.com/terms'); }}
                            sx={{ cursor: 'pointer', verticalAlign: 'baseline' }}
                          >
                            {t('auth.register.legalTerms')}
                          </MuiLink>
                        );
                      } else {
                        acc.push(
                          <MuiLink
                            key="privacy"
                            component="button"
                            type="button"
                            variant="caption"
                            onClick={(e: React.MouseEvent) => { e.preventDefault(); openLegalLink('https://progresql.com/privacy'); }}
                            sx={{ cursor: 'pointer', verticalAlign: 'baseline' }}
                          >
                            {t('auth.register.legalPrivacy')}
                          </MuiLink>
                        );
                      }
                    }
                    acc.push(part);
                    return acc;
                  }, [])}
              </Typography>
            }
            sx={{ alignItems: 'flex-start', mt: 1, '& .MuiCheckbox-root': { pt: 0 } }}
          />

          <FormControlLabel
            control={
              <Checkbox
                checked={marketingConsent}
                onChange={(e) => setMarketingConsent(e.target.checked)}
                size="small"
              />
            }
            label={
              <Typography variant="caption" color="text.secondary">
                {t('auth.register.marketingConsent')}
              </Typography>
            }
            sx={{ alignItems: 'flex-start', mt: 0, '& .MuiCheckbox-root': { pt: 0 } }}
          />

          <Button type="submit" variant="contained" disabled={loading || !allChecksMet || !legalAccepted}>
            {loading ? t('auth.register.submitting') : t('auth.register.submit')}
          </Button>
        </Box>
        <Typography variant="body2" sx={{ mt: 2 }}>
          {t('auth.register.hasAccount')} <MuiLink component={Link} href="/login">{t('auth.register.login')}</MuiLink>
        </Typography>
      </Paper>
    </Box>
  );
}
