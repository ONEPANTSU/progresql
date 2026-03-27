import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Box, Button, Link as MuiLink, LinearProgress, Paper, TextField, Typography, Alert } from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { authService } from '../services/auth';
import Logo from '../components/Logo';
import { useTranslation } from '../contexts/LanguageContext';

/** Navigate via absolute file:// URL in packaged Electron only */
function navigateTo(route: string, router: ReturnType<typeof useRouter>) {
  const isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';
  const api = isFileProtocol ? (window as any).electronAPI : null;
  if (api?.getPageUrl) {
    window.location.href = api.getPageUrl(route);
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
  if (metCount <= 4) return { level: 'medium', value: 75, color: '#ed6c02' };
  return { level: 'strong', value: 100, color: '#4caf50' };
}

type Step = 'email' | 'code' | 'password' | 'done';

const CODE_LENGTH = 6;

export default function ForgotPasswordPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const code = digits.join('');

  const passwordChecks = useMemo(() => getPasswordChecks(newPassword), [newPassword]);
  const strength = useMemo(() => getPasswordStrength(newPassword), [newPassword]);
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

  const setDigitAt = useCallback((index: number, value: string) => {
    setDigits(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const handleDigitChange = useCallback((index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1);
    setDigitAt(index, digit);
    if (digit && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }, [setDigitAt]);

  const handleKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
      setDigitAt(index - 1, '');
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }, [digits, setDigitAt]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (!pasted) return;
    const newDigits = Array(CODE_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i++) {
      newDigits[i] = pasted[i];
    }
    setDigits(newDigits);
    const focusIndex = Math.min(pasted.length, CODE_LENGTH - 1);
    inputRefs.current[focusIndex]?.focus();
  }, []);

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

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.length < CODE_LENGTH) return;
    setStep('password');
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!allChecksMet) {
      setError(t('auth.register.passwordRequirementFail'));
      return;
    }
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

        {/* Step 1: Email */}
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

        {/* Step 2: OTP Code */}
        {step === 'code' && (
          <>
            <Typography variant="h5" gutterBottom sx={{ textAlign: 'center' }}>{t('auth.forgot.codeLabel')}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
              {t('auth.forgot.newPasswordSubtitle')}
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Box component="form" onSubmit={handleVerifyCode} sx={{ display: 'grid', gap: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1 }} onPaste={handlePaste}>
                {digits.map((digit, i) => (
                  <TextField
                    key={i}
                    inputRef={(el: HTMLInputElement | null) => { inputRefs.current[i] = el; }}
                    value={digit}
                    onChange={e => handleDigitChange(i, e.target.value)}
                    onKeyDown={e => handleKeyDown(i, e)}
                    autoFocus={i === 0}
                    inputProps={{
                      maxLength: 1,
                      style: {
                        textAlign: 'center',
                        fontSize: '24px',
                        fontWeight: 700,
                        fontFamily: "'SF Mono', SFMono-Regular, Consolas, monospace",
                        padding: '12px 0',
                        width: '44px',
                      },
                      inputMode: 'numeric',
                    }}
                    variant="outlined"
                    sx={{
                      width: 52,
                      '& .MuiOutlinedInput-root': {
                        borderRadius: '10px',
                      },
                    }}
                  />
                ))}
              </Box>
              <Button type="submit" variant="contained" disabled={code.length < CODE_LENGTH}>
                {t('auth.forgot.verify') || 'Verify'}
              </Button>
              <Button variant="text" size="small" onClick={() => { setStep('email'); setError(null); }}>
                {t('auth.forgot.back') || 'Back'}
              </Button>
            </Box>
          </>
        )}

        {/* Step 3: New Password */}
        {step === 'password' && (
          <>
            <Typography variant="h5" gutterBottom sx={{ textAlign: 'center' }}>{t('auth.forgot.newPassword')}</Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Box component="form" onSubmit={handleResetPassword} sx={{ display: 'grid', gap: 2 }}>
              <TextField label={t('auth.forgot.newPasswordLabel')} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} fullWidth autoFocus />

              {/* Password strength indicator */}
              {newPassword.length > 0 && (
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

              <TextField label={t('auth.forgot.confirmPassword')} type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} fullWidth />
              <Button type="submit" variant="contained" disabled={loading}>
                {loading ? t('auth.forgot.changingPassword') : t('auth.forgot.changePassword')}
              </Button>
              <Button variant="text" size="small" onClick={() => { setStep('code'); setError(null); }}>
                {t('auth.forgot.back') || 'Back'}
              </Button>
            </Box>
          </>
        )}

        {/* Step 4: Done */}
        {step === 'done' && (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>{t('auth.forgot.success')}</Alert>
            <Button variant="contained" fullWidth onClick={() => navigateTo('/login', router)}>
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
