import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  TextField,
  Button,
  CircularProgress,
  IconButton,
  Alert,
  Link,
} from '@mui/material';
import {
  Close as CloseIcon,
  AccountBalanceWallet as WalletIcon,
} from '@mui/icons-material';
import { useTranslation } from '../contexts/LanguageContext';
import { createPaymentInvoice, fetchBalance } from '../services/auth';
import { BalanceInfo } from '../types';

interface BalanceTopUpModalProps {
  open: boolean;
  onClose: () => void;
}

const PRESET_AMOUNTS = [100, 500, 1000, 5000, 10000] as const;
const MIN_AMOUNT = 100;
const MAX_AMOUNT = 50000;

export default function BalanceTopUpModal({ open, onClose }: BalanceTopUpModalProps) {
  const { t, language } = useTranslation();

  const [balance, setBalance] = React.useState<BalanceInfo | null>(null);
  const [selectedAmount, setSelectedAmount] = React.useState<number | null>(null);
  const [customAmount, setCustomAmount] = React.useState('');
  const [showCustomInput, setShowCustomInput] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = React.useState(false);

  // Fetch current balance when modal opens
  React.useEffect(() => {
    if (!open) return;
    setBalanceLoading(true);
    setError(null);
    setSelectedAmount(null);
    setCustomAmount('');
    setShowCustomInput(false);
    fetchBalance()
      .then(setBalance)
      .catch(() => setBalance(null))
      .finally(() => setBalanceLoading(false));
  }, [open]);

  const effectiveAmount = selectedAmount ?? (customAmount ? Number(customAmount) : 0);
  const isCustomValid =
    customAmount === '' ||
    (Number(customAmount) >= MIN_AMOUNT && Number(customAmount) <= MAX_AMOUNT && !isNaN(Number(customAmount)));
  const canSubmit = effectiveAmount >= MIN_AMOUNT && effectiveAmount <= MAX_AMOUNT && !loading;

  const handlePresetClick = (amount: number) => {
    setSelectedAmount(amount);
    setCustomAmount('');
    setShowCustomInput(false);
    setError(null);
  };

  const handleCustomChange = (value: string) => {
    // Allow only digits
    const cleaned = value.replace(/[^0-9]/g, '');
    setCustomAmount(cleaned);
    setSelectedAmount(null);
    setError(null);
  };

  const handleTopUp = async () => {
    if (loading || !canSubmit) return;
    setLoading(true);
    setError(null);

    try {
      const { payment_url } = await createPaymentInvoice(11, {
        paymentType: 'balance_topup',
        amount: effectiveAmount,
      });

      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(payment_url);
      } else {
        window.open(payment_url, '_blank');
      }

      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('balance.topUpError');
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const presetSx = (amount: number) => ({
    minWidth: 'auto',
    px: 2,
    py: 0.75,
    borderRadius: 2,
    fontWeight: 700,
    fontSize: '0.85rem',
    textTransform: 'none' as const,
    border: '1.5px solid',
    borderColor: selectedAmount === amount ? '#6366f1' : 'divider',
    bgcolor: selectedAmount === amount ? 'rgba(99,102,241,0.1)' : 'transparent',
    color: selectedAmount === amount ? '#6366f1' : 'text.primary',
    transition: 'all 0.18s ease',
    '&:hover': {
      borderColor: '#6366f1',
      bgcolor: 'rgba(99,102,241,0.08)',
    },
  });

  return (
    <Dialog
      open={open}
      onClose={loading ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      data-testid="balance-topup-modal"
      PaperProps={{ sx: { borderRadius: 3, overflow: 'hidden' } }}
    >
      {/* Gradient top border */}
      <Box
        sx={{
          height: 4,
          background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)',
        }}
      />

      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          pb: 0.5,
          pt: 2,
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {t('balance.topUp')}
        </Typography>
        <IconButton size="small" onClick={onClose} disabled={loading}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 1, pb: 3 }}>
        {/* Current balance */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mb: 2.5,
            p: 1.5,
            borderRadius: 2,
            bgcolor: 'rgba(99,102,241,0.06)',
            border: '1px solid',
            borderColor: 'rgba(99,102,241,0.15)',
          }}
        >
          <WalletIcon sx={{ fontSize: 20, color: '#6366f1' }} />
          <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 500 }}>
            {t('balance.currentBalance')}:
          </Typography>
          {balanceLoading ? (
            <CircularProgress size={16} sx={{ color: '#6366f1', ml: 'auto' }} />
          ) : (
            <Typography
              variant="body2"
              sx={{ fontWeight: 700, ml: 'auto', color: '#6366f1' }}
            >
              {balance ? `${balance.balance.toFixed(2)} ${language === 'ru' ? '\u20BD' : 'RUB'}` : '\u2014'}
            </Typography>
          )}
        </Box>

        {/* Select amount label */}
        <Typography
          variant="body2"
          sx={{ fontWeight: 600, mb: 1 }}
        >
          {t('balance.selectAmount')}
        </Typography>

        {/* Preset amount buttons + custom */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
          {PRESET_AMOUNTS.map((amount) => (
            <Button
              key={amount}
              variant="outlined"
              onClick={() => handlePresetClick(amount)}
              sx={presetSx(amount)}
              disabled={loading}
            >
              {amount.toLocaleString()}{'\u20BD'}
            </Button>
          ))}
          <Button
            variant="outlined"
            onClick={() => { setShowCustomInput(true); setSelectedAmount(null); }}
            sx={{
              ...presetSx(0),
              borderColor: showCustomInput ? '#6366f1' : 'divider',
              bgcolor: showCustomInput ? 'rgba(99,102,241,0.1)' : 'transparent',
              color: showCustomInput ? '#6366f1' : 'text.primary',
            }}
            disabled={loading}
          >
            {language === 'ru' ? 'Другая' : 'Other'}
          </Button>
        </Box>

        {/* Custom amount input — shown only after clicking "Other" */}
        {showCustomInput && (
          <TextField
            fullWidth
            size="small"
            autoFocus
            label={t('balance.customAmount')}
            value={customAmount}
            onChange={(e) => handleCustomChange(e.target.value)}
            disabled={loading}
            placeholder={`${MIN_AMOUNT} \u2014 ${MAX_AMOUNT.toLocaleString()}`}
            InputProps={{
              endAdornment: <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', ml: 0.5 }}>{'\u20BD'}</Typography>,
            }}
            error={customAmount !== '' && !isCustomValid}
            helperText={
              customAmount !== '' && Number(customAmount) < MIN_AMOUNT && customAmount !== ''
                ? t('balance.minAmount', { amount: String(MIN_AMOUNT) })
                : customAmount !== '' && Number(customAmount) > MAX_AMOUNT
                  ? t('balance.maxAmount', { amount: MAX_AMOUNT.toLocaleString() })
                  : undefined
            }
            sx={{ mb: 2 }}
            inputProps={{
              inputMode: 'numeric',
              'data-testid': 'balance-custom-amount-input',
            }}
          />
        )}

        {/* Top up button */}
        <Box sx={{ mb: 2 }}>
          <Button
            fullWidth
            variant="contained"
            disabled={loading || !canSubmit}
            onClick={() => handleTopUp()}
            sx={{
              textTransform: 'none',
              fontWeight: 700,
              py: 1.5,
              fontSize: '1rem',
              color: '#fff',
              background: (loading || !canSubmit) ? undefined : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
            }}
          >
            {loading ? (
              <CircularProgress size={22} sx={{ color: '#fff' }} />
            ) : (
              language === 'ru' ? 'Пополнить' : 'Top Up'
            )}
          </Button>
        </Box>

        {/* Error message */}
        {error && (
          <Alert severity="error" sx={{ mb: 1, fontSize: '0.8rem' }}>
            {error}
          </Alert>
        )}

        {/* Legal text */}
        <Typography variant="caption" sx={{ color: 'text.disabled', lineHeight: 1.5, display: 'block' }}>
          {(() => {
            const template = t('settings.legalConsentContinue');
            const parts = template.split(/(\{offer\}|\{refunds\})/);
            const openLink = (url: string) => {
              if (window.electronAPI?.openExternal) {
                window.electronAPI.openExternal(url);
              } else {
                window.open(url, '_blank');
              }
            };
            return parts.map((part, i) => {
              if (part === '{offer}') return <Link key={i} component="button" variant="caption" sx={{ color: 'text.secondary' }} onClick={() => openLink('https://progresql.com/legal/offer.html')}>{t('settings.legalOffer')}</Link>;
              if (part === '{refunds}') return <Link key={i} component="button" variant="caption" sx={{ color: 'text.secondary' }} onClick={() => openLink('https://progresql.com/legal/refunds.html')}>{t('settings.legalRefunds')}</Link>;
              return <React.Fragment key={i}>{part}</React.Fragment>;
            });
          })()}
        </Typography>
      </DialogContent>
    </Dialog>
  );
}
