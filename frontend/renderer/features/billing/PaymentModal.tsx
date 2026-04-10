import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  TextField,
  Button,
  Link,
  CircularProgress,
  IconButton,
  Collapse,
} from '@mui/material';
import {
  Close as CloseIcon,
  LocalOffer as PromoIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Check as CheckIcon,
} from '@mui/icons-material';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import { applyPromoCode, getAuthToken } from '@/features/auth/auth';
import { useAuth } from '@/features/auth/AuthProvider';
import { loadBackendUrl } from '@/shared/lib/secureSettingsStorage';

interface PaymentModalProps {
  open: boolean;
  onClose: () => void;
  currentPrice: number;
  originalPrice: number;
  onSelectMethod: (method: 'card' | 'sbp', plan?: string) => void;
  paymentLoading: boolean;
  paymentError: string | null;
}

// Pro plan feature highlights. Text values are intentionally generic — real
// numeric limits come from the backend via /api/v2/quota.
const PRO_FEATURES = {
  monthlyCreditsUsd: 5,   // default fallback when API data is not yet loaded
  requestsPerMin: 60,
  markupPct: 50,
  autocomplete: true,
  premiumModels: true,
} as const;

export default function PaymentModal({
  open,
  onClose,
  onSelectMethod,
  paymentLoading,
  paymentError,
}: PaymentModalProps) {
  const { t, language } = useTranslation();
  const { refreshUser } = useAuth();

  const [promoOpen, setPromoOpen] = React.useState(false);
  const [promoCode, setPromoCode] = React.useState('');
  const [promoLoading, setPromoLoading] = React.useState(false);
  const [promoSuccess, setPromoSuccess] = React.useState<string | null>(null);
  const [promoError, setPromoError] = React.useState<string | null>(null);
  const [proPrice, setProPrice] = React.useState(1999);
  const [monthlyCreditsUsd, setMonthlyCreditsUsd] = React.useState<number>(PRO_FEATURES.monthlyCreditsUsd);

  // Fetch prices from API
  React.useEffect(() => {
    if (!open) return;
    const fetchPrices = async () => {
      try {
        const baseUrl = loadBackendUrl('https://progresql.com');
        const token = getAuthToken() || '';
        const resp = await fetch(`${baseUrl}/api/v3/payment/prices`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          for (const plan of data.plans || []) {
            if (plan.plan === 'pro') setProPrice(plan.price);
          }
        }
      } catch {
        // keep default prices
      }
    };
    fetchPrices();
  }, [open]);

  // Fetch Pro plan monthly credits from /api/v2/plans (if available)
  React.useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const baseUrl = loadBackendUrl('https://progresql.com');
        const token = getAuthToken() || '';
        const resp = await fetch(`${baseUrl}/api/v2/plans`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          const plans = data.plans || data;
          const pro = Array.isArray(plans) ? plans.find((p: any) => p.plan === 'pro' || p.name === 'pro') : null;
          if (pro?.monthly_credits_usd) setMonthlyCreditsUsd(pro.monthly_credits_usd);
        }
      } catch {
        // keep default
      }
    })();
  }, [open]);

  const handleApplyPromoCode = async () => {
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    setPromoSuccess(null);
    setPromoError(null);
    try {
      const result = await applyPromoCode(promoCode.trim());
      setPromoSuccess(t('settings.promoCodeSuccess'));
      setPromoCode('');
      await refreshUser();
      if (result.plan === 'pro') {
        setTimeout(() => onClose(), 1500);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('settings.promoCodeError');
      setPromoError(message);
    } finally {
      setPromoLoading(false);
    }
  };

  const openLegalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={paymentLoading ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      data-testid="payment-modal"
      PaperProps={{ sx: { borderRadius: 3, overflow: 'hidden' } }}
    >
      {/* Gradient top border */}
      <Box sx={{ height: 4, background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)' }} />

      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 0.5, pt: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {language === 'ru' ? 'Обновить до Pro' : 'Upgrade to Pro'}
        </Typography>
        <IconButton size="small" onClick={onClose} disabled={paymentLoading}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 1, pb: 3 }}>

        {/* Pro Plan Card */}
        <Box
          sx={{
            p: 2,
            mb: 2.5,
            borderRadius: 2,
            border: '2px solid #6366f1',
            position: 'relative',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.05), rgba(139,92,246,0.05))',
          }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>Pro</Typography>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
            <Typography sx={{ fontSize: '2rem', fontWeight: 800, color: '#6366f1', lineHeight: 1 }}>
              {proPrice}₽
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {language === 'ru' ? '/мес' : '/month'}
            </Typography>
          </Box>
          <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <FeatureLine
              text={language === 'ru'
                ? `$${monthlyCreditsUsd.toFixed(2)} кредитов ежемесячно`
                : `$${monthlyCreditsUsd.toFixed(2)} credits per month`}
              highlight
            />
            <FeatureLine
              text={language === 'ru'
                ? 'Доступ к премиум моделям (Claude, GPT-4.1, o4)'
                : 'Premium models access (Claude, GPT-4.1, o4)'}
            />
            <FeatureLine
              text={language === 'ru'
                ? `${PRO_FEATURES.requestsPerMin} запросов в минуту`
                : `${PRO_FEATURES.requestsPerMin} requests per minute`}
            />
            <FeatureLine
              text={language === 'ru'
                ? 'AI-автодополнение в редакторе'
                : 'AI autocomplete in editor'}
            />
            <FeatureLine
              text={language === 'ru'
                ? `Пополнение баланса (наценка ${PRO_FEATURES.markupPct}%)`
                : `Balance top-ups (${PRO_FEATURES.markupPct}% markup)`}
            />
          </Box>
        </Box>

        {/* Pay button */}
        <Box sx={{ mb: 2 }}>
          <Button
            fullWidth
            variant="contained"
            disabled={paymentLoading}
            onClick={() => onSelectMethod('card', 'pro')}
            sx={{
              textTransform: 'none',
              fontWeight: 700,
              py: 1.5,
              fontSize: '1rem',
              color: '#fff',
              background: paymentLoading ? undefined : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
            }}
          >
            {paymentLoading ? (
              <CircularProgress size={22} sx={{ color: '#fff' }} />
            ) : (
              language === 'ru' ? 'Оплатить' : 'Pay'
            )}
          </Button>
        </Box>

        {/* Promo code collapsible */}
        <Box sx={{ mb: 1.5 }}>
          <Box
            onClick={() => setPromoOpen(v => !v)}
            data-testid="promo-code-toggle"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              cursor: 'pointer',
              color: 'text.secondary',
              width: 'fit-content',
              '&:hover': { color: 'primary.main' },
            }}
          >
            <PromoIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption" sx={{ fontWeight: 500 }}>
              {t('settings.promoCode')}
            </Typography>
            {promoOpen ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
          </Box>

          <Collapse in={promoOpen} timeout={200}>
            <Box sx={{ mt: 1.5, display: 'flex', gap: 1 }}>
              <TextField
                size="small"
                placeholder={t('settings.promoCodePlaceholder')}
                value={promoCode}
                onChange={(e) => { setPromoCode(e.target.value); setPromoError(null); setPromoSuccess(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleApplyPromoCode(); }}
                disabled={promoLoading}
                sx={{ flex: 1 }}
                inputProps={{ style: { fontSize: '0.85rem' }, 'data-testid': 'promo-code-input' }}
              />
              <Button
                variant="contained"
                size="small"
                disabled={promoLoading || !promoCode.trim()}
                onClick={handleApplyPromoCode}
                sx={{
                  textTransform: 'none',
                  fontWeight: 600,
                  minWidth: 'auto',
                  px: 2,
                  background: (promoLoading || !promoCode.trim()) ? undefined : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
                }}
              >
                {promoLoading ? <CircularProgress size={16} color="inherit" /> : t('settings.promoCodeApply')}
              </Button>
            </Box>
            {promoSuccess && (
              <Typography variant="caption" sx={{ color: 'success.main', mt: 0.5, display: 'block' }}>
                {promoSuccess}
              </Typography>
            )}
            {promoError && (
              <Typography variant="caption" sx={{ color: 'error.main', mt: 0.5, display: 'block' }}>
                {promoError}
              </Typography>
            )}
          </Collapse>
        </Box>

        {/* Payment error */}
        {paymentError && (
          <Typography variant="caption" sx={{ color: 'error.main', mb: 1, display: 'block' }}>
            {paymentError}
          </Typography>
        )}

        {/* Legal text */}
        <Typography variant="caption" sx={{ color: 'text.disabled', lineHeight: 1.5, display: 'block' }}>
          {(() => {
            const template = t('settings.legalConsentContinue');
            const parts = template.split(/(\{offer\}|\{refunds\})/);
            return parts.map((part, i) => {
              if (part === '{offer}') return <Link key={i} component="button" variant="caption" sx={{ color: 'text.secondary' }} onClick={() => openLegalLink('https://progresql.com/legal/offer.html')}>{t('settings.legalOffer')}</Link>;
              if (part === '{refunds}') return <Link key={i} component="button" variant="caption" sx={{ color: 'text.secondary' }} onClick={() => openLegalLink('https://progresql.com/legal/refunds.html')}>{t('settings.legalRefunds')}</Link>;
              return <React.Fragment key={i}>{part}</React.Fragment>;
            });
          })()}
        </Typography>
      </DialogContent>
    </Dialog>
  );
}

function FeatureLine({ text, highlight }: { text: string; highlight?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <CheckIcon sx={{ fontSize: 14, color: highlight ? '#8b5cf6' : 'success.main' }} />
      <Typography variant="caption" sx={{ color: highlight ? '#8b5cf6' : 'text.secondary', fontWeight: highlight ? 700 : 500, fontSize: '0.75rem' }}>
        {text}
      </Typography>
    </Box>
  );
}
