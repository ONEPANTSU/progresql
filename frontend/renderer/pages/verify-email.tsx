import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Button, CircularProgress, Paper, TextField, Typography, Alert } from '@mui/material';
import { useRouter } from 'next/router';
import { useAuth } from '@/features/auth/AuthProvider';
import Logo from '@/shared/ui/Logo';
import { useTranslation } from '@/shared/i18n/LanguageContext';

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

const COOLDOWN_SECONDS = 60;
const CODE_VALIDITY_MINUTES = 15;
const CODE_LENGTH = 6;

export default function VerifyEmailPage() {
  const router = useRouter();
  const { user, isAuthenticated, isEmailVerified, sendVerificationCode, verifyCode, logout } = useAuth();
  const { t } = useTranslation();
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  const [codeExpired, setCodeExpired] = useState(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const navigatingRef = useRef(false);
  const [navigating, setNavigating] = useState(false);

  useEffect(() => {
    if (navigatingRef.current) return;
    if (!isAuthenticated) {
      navigatingRef.current = true;
      setNavigating(true);
      navigateTo('/login', router);
    } else if (isEmailVerified) {
      navigatingRef.current = true;
      setNavigating(true);
      navigateTo('/', router);
    }
  }, [isAuthenticated, isEmailVerified, router]);

  const startCooldown = useCallback(() => {
    setCooldown(COOLDOWN_SECONDS);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!codeSentAt) return;
    const expiryMs = CODE_VALIDITY_MINUTES * 60 * 1000;
    const remaining = codeSentAt + expiryMs - Date.now();
    if (remaining <= 0) {
      setCodeExpired(true);
      return;
    }
    const timer = setTimeout(() => setCodeExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [codeSentAt]);

  const handleSendCode = useCallback(async () => {
    setError(null);
    setInfo(null);
    setCodeExpired(false);
    setSending(true);
    try {
      await sendVerificationCode();
      setCodeSentAt(Date.now());
      setInfo(t('auth.verify.codeSent'));
      startCooldown();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.verify.codeSendError'));
    } finally {
      setSending(false);
    }
  }, [sendVerificationCode, startCooldown, t]);

  const setDigitAt = useCallback((index: number, value: string) => {
    setDigits(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const handleDigitChange = useCallback((index: number, value: string) => {
    // Only allow single digit
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
    // Focus last filled or next empty
    const focusIndex = Math.min(pasted.length, CODE_LENGTH - 1);
    inputRefs.current[focusIndex]?.focus();
  }, []);

  const code = digits.join('');

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length < CODE_LENGTH) return;
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      await verifyCode(code);
      navigatingRef.current = true;
      setNavigating(true);
      await navigateTo('/', router);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.verify.invalidCode'));
      setLoading(false);
    }
  };

  // Auto-submit when all digits filled
  useEffect(() => {
    if (code.length === CODE_LENGTH && !loading && !codeExpired && codeSentAt) {
      handleVerify({ preventDefault: () => {} } as React.FormEvent);
    }
  }, [code]);

  const handleLogout = () => {
    logout();
    navigateTo('/login', router);
  };

  if (!isAuthenticated || isEmailVerified || navigating) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  const resendDisabled = sending || cooldown > 0;

  return (
    <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ width: '100%', maxWidth: 480, p: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 3 }}>
          <Box sx={{ mr: 2 }}>
            <Logo size={64} />
          </Box>
          <Typography variant="h4" sx={{ color: 'text.primary', fontWeight: 700 }}>
            ProgreSQL
          </Typography>
        </Box>

        <Typography variant="h5" gutterBottom sx={{ textAlign: 'center' }}>
          {t('auth.verify.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
          {t('auth.verify.subtitle', { email: user?.email || '' })}
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {info && <Alert severity="success" sx={{ mb: 2 }}>{info}</Alert>}
        {codeExpired && !error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('auth.verify.codeExpired')}
          </Alert>
        )}

        {codeSentAt && !codeExpired && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, textAlign: 'center' }}>
            {t('auth.verify.codeValid', { minutes: String(CODE_VALIDITY_MINUTES) })}
          </Typography>
        )}

        <Box component="form" onSubmit={handleVerify} sx={{ display: 'grid', gap: 2 }}>
          {/* 6 digit cells */}
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

          <Button
            type="submit"
            variant="contained"
            disabled={loading || code.length < CODE_LENGTH || codeExpired}
          >
            {loading ? t('auth.verify.submitting') : t('auth.verify.submit')}
          </Button>
        </Box>

        <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button
            variant="text"
            size="small"
            onClick={handleSendCode}
            disabled={resendDisabled}
          >
            {sending
              ? t('auth.verify.resending')
              : cooldown > 0
                ? t('auth.verify.resendCooldown', { seconds: String(cooldown) })
                : codeSentAt ? t('auth.verify.resend') : t('auth.verify.resend')}
          </Button>
          <Button variant="text" size="small" onClick={handleLogout}>
            {t('auth.verify.logout')}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
