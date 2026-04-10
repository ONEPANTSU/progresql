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
  CreditCard as CreditCardIcon,
} from '@mui/icons-material';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import {
  createPaymentInvoice,
  fetchUsage,
  fetchQuota,
  fetchExchangeRate,
} from '@/features/auth/auth';
import { UsageInfo, QuotaInfo } from '@/shared/types';

interface BalanceTopUpModalProps {
  open: boolean;
  onClose: () => void;
}

const PRESET_AMOUNTS = [100, 500, 1000, 5000, 10000] as const;
const MIN_AMOUNT = 100;
const MAX_AMOUNT = 50000;
const DEFAULT_USD_TO_RUB = 90;
const DEFAULT_MARKUP_PCT = 50;

function formatUsd(n: number): string {
  if (!isFinite(n)) return '$0.00';
  if (Math.abs(n) >= 0.01 || n === 0) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export default function BalanceTopUpModal({ open, onClose }: BalanceTopUpModalProps) {
  const { t, language } = useTranslation();

  const [usage, setUsage] = React.useState<UsageInfo | null>(null);
  const [quota, setQuota] = React.useState<QuotaInfo | null>(null);
  const [usdToRub, setUsdToRub] = React.useState<number>(DEFAULT_USD_TO_RUB);
  const [selectedAmount, setSelectedAmount] = React.useState<number | null>(null);
  const [customAmount, setCustomAmount] = React.useState('');
  const [showCustomInput, setShowCustomInput] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [infoLoading, setInfoLoading] = React.useState(false);

  // Fetch balance, quota (markup) and exchange rate when modal opens
  React.useEffect(() => {
    if (!open) return;
    setInfoLoading(true);
    setError(null);
    setSelectedAmount(null);
    setCustomAmount('');
    setShowCustomInput(false);

    Promise.all([
      fetchUsage().catch(() => null),
      fetchQuota().catch(() => null),
      fetchExchangeRate().catch(() => DEFAULT_USD_TO_RUB),
    ])
      .then(([u, q, rate]) => {
        setUsage(u);
        setQuota(q);
        setUsdToRub(rate || DEFAULT_USD_TO_RUB);
      })
      .finally(() => setInfoLoading(false));
  }, [open]);

  const effectiveAmount = selectedAmount ?? (customAmount ? Number(customAmount) : 0);
  const isCustomValid =
    customAmount === '' ||
    (Number(customAmount) >= MIN_AMOUNT && Number(customAmount) <= MAX_AMOUNT && !isNaN(Number(customAmount)));
  const canSubmit = effectiveAmount >= MIN_AMOUNT && effectiveAmount <= MAX_AMOUNT && !loading;

  // Compute USD credits for a given RUB amount accounting for the plan markup.
  // Formula: rub -> usd via exchange rate, then credits_usd = usd / (1 + markup_pct/100).
  const computeCreditsUsd = React.useCallback((rubAmount: number): number => {
    if (!rubAmount || !usdToRub) return 0;
    const markupPct = quota?.balance_markup_pct ?? DEFAULT_MARKUP_PCT;
    const usd = rubAmount / usdToRub;
    return usd / (1 + markupPct / 100);
  }, [usdToRub, quota]);

  const previewCreditsUsd = computeCreditsUsd(effectiveAmount);

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
        {/* Compact "available" line — the full balance card already lives in SettingsPanel. */}
        {!infoLoading && usage && (
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              color: 'text.secondary',
              mb: 2,
              fontSize: '0.75rem',
            }}
          >
            {t('balance.currentBalance')}:{' '}
            <Box component="span" sx={{ fontWeight: 700, color: '#6366f1' }}>
              {formatUsd(usage.balance_usd)}
            </Box>{' '}
            <Box component="span" sx={{ color: 'text.disabled' }}>
              {`(≈ ${Math.round(usage.balance_usd * usdToRub)}\u00A0\u20BD)`}
            </Box>
          </Typography>
        )}
        {infoLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
            <CircularProgress size={16} sx={{ color: '#6366f1' }} />
          </Box>
        )}

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

        {/* Credits preview (USD after markup) */}
        {effectiveAmount > 0 && isCustomValid && (
          <Box
            sx={{
              mb: 2,
              p: 1.25,
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'rgba(139,92,246,0.3)',
              bgcolor: 'rgba(139,92,246,0.04)',
            }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: '0.7rem' }}>
              {language === 'ru' ? 'Вы получите' : "You'll receive"}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 700, color: '#8b5cf6' }}>
              {language === 'ru'
                ? `Получите ${formatUsd(previewCreditsUsd)} кредитов`
                : `${formatUsd(previewCreditsUsd)} credits`}
            </Typography>
            {quota && (
              <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.65rem' }}>
                {language === 'ru'
                  ? `наценка ${quota.balance_markup_pct}% • курс ~${usdToRub.toFixed(0)}\u20BD/$`
                  : `markup ${quota.balance_markup_pct}% • rate ~${usdToRub.toFixed(0)}\u20BD/$`}
              </Typography>
            )}
          </Box>
        )}

        {/* Top up button — same credit-card icon as the BalanceCard primary CTA */}
        <Box sx={{ mb: 2 }}>
          <Button
            fullWidth
            variant="contained"
            disabled={loading || !canSubmit}
            onClick={() => handleTopUp()}
            startIcon={!loading ? <CreditCardIcon sx={{ fontSize: 18 }} /> : undefined}
            sx={{
              textTransform: 'none',
              fontWeight: 700,
              py: 1.5,
              fontSize: '1rem',
              color: '#fff',
              background: (loading || !canSubmit) ? undefined : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              '& .MuiButton-startIcon': { mr: 1 },
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
