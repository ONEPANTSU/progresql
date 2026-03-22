import React, { useState } from 'react';
import { Box, Button, Link as MuiLink, Paper, TextField, Typography, Alert } from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { authService } from '../services/auth';
import Logo from '../components/Logo';
import { useTranslation } from '../contexts/LanguageContext';

type Step = 'email' | 'code' | 'done';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await authService.forgotPassword(email.trim());
      setStep('code');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.forgot.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError(t('auth.forgot.passwordMismatch'));
      return;
    }

    setLoading(true);
    try {
      await authService.resetPassword(email.trim(), code.trim(), newPassword);
      setStep('done');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.forgot.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ width: '100%', maxWidth: 420, p: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 3 }}>
          <Box sx={{ mr: 2 }}>
            <Logo size={64} />
          </Box>
          <Typography variant="h4" sx={{ color: 'text.primary', fontWeight: 700 }}>
            ProgreSQL
          </Typography>
        </Box>

        {step === 'email' && (
          <>
            <Typography variant="h5" gutterBottom sx={{ textAlign: 'center' }}>{t('auth.forgot.title')}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
              {t('auth.forgot.subtitle')}
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Box component="form" onSubmit={handleSendCode} sx={{ display: 'grid', gap: 2 }}>
              <TextField label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} fullWidth autoFocus />
              <Button type="submit" variant="contained" disabled={loading}>
                {loading ? t('auth.forgot.sendingCode') : t('auth.forgot.sendCode')}
              </Button>
            </Box>
          </>
        )}

        {step === 'code' && (
          <>
            <Typography variant="h5" gutterBottom sx={{ textAlign: 'center' }}>{t('auth.forgot.newPassword')}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
              {t('auth.forgot.newPasswordSubtitle')}
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Box component="form" onSubmit={handleResetPassword} sx={{ display: 'grid', gap: 2 }}>
              <TextField label={t('auth.forgot.codeLabel')} value={code} onChange={e => setCode(e.target.value)} fullWidth autoFocus />
              <TextField label={t('auth.forgot.newPasswordLabel')} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} fullWidth />
              <TextField label={t('auth.forgot.confirmPassword')} type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} fullWidth />
              <Button type="submit" variant="contained" disabled={loading}>
                {loading ? t('auth.forgot.changingPassword') : t('auth.forgot.changePassword')}
              </Button>
            </Box>
          </>
        )}

        {step === 'done' && (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>{t('auth.forgot.success')}</Alert>
            <Button variant="contained" fullWidth onClick={() => router.replace('/login')}>
              {t('auth.forgot.loginButton')}
            </Button>
          </>
        )}

        <Typography variant="body2" sx={{ mt: 2 }}>
          <MuiLink component={Link} href="/login">{t('auth.forgot.backToLogin')}</MuiLink>
        </Typography>
      </Paper>
    </Box>
  );
}
