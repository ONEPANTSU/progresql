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
  CreditCard as CreditCardIcon,
  QrCode as QrCodeIcon,
  LocalOffer as PromoIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Check as CheckIcon,
} from '@mui/icons-material';
import { useTranslation } from '../contexts/LanguageContext';
import { applyPromoCode, getAuthToken } from '../services/auth';
import { useAuth } from '../providers/AuthProvider';
import { loadBackendUrl } from '../utils/secureSettingsStorage';

interface PaymentModalProps {
  open: boolean;
  onClose: () => void;
  currentPrice: number;
  originalPrice: number;
  onSelectMethod: (method: 'card' | 'sbp', plan?: string) => void;
  paymentLoading: boolean;
  paymentError: string | null;
}

const PLAN_FEATURES = {
  pro: {
    budget: '5M',
    premium: '200K',
    requests: '60',
    autocomplete: true,
    balance: true,
    markup: 50,
  },
  pro_plus: {
    budget: '10M',
    premium: '1.5M',
    requests: '120',
    autocomplete: true,
    balance: true,
    markup: 25,
  },
} as const;

export default function PaymentModal({
  open,
  onClose,
  currentPrice,
  originalPrice,
  onSelectMethod,
  paymentLoading,
  paymentError,
}: PaymentModalProps) {
  const { t, language } = useTranslation();
  const { user, refreshUser } = useAuth();

  const [selectedPlan, setSelectedPlan] = React.useState<'pro' | 'pro_plus'>('pro');
  const [promoOpen, setPromoOpen] = React.useState(false);
  const [promoCode, setPromoCode] = React.useState('');
  const [promoLoading, setPromoLoading] = React.useState(false);
  const [promoSuccess, setPromoSuccess] = React.useState<string | null>(null);
  const [promoError, setPromoError] = React.useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = React.useState<'card' | 'sbp' | null>(null);
  const [proPrice, setProPrice] = React.useState(1999);
  const [proPlusPrice, setProPlusPrice] = React.useState(5999);

  // Fetch prices from API
  React.useEffect(() => {
    if (!open) return;
    const fetchPrices = async () => {
      try {
        const baseUrl = loadBackendUrl('https://progresql.com');
        const token = getAuthToken() || '';
        const resp = await fetch(`${baseUrl}/api/v2/payment/prices`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          for (const plan of data.plans || []) {
            if (plan.plan === 'pro') setProPrice(plan.price);
            if (plan.plan === 'pro_plus') setProPlusPrice(plan.price);
          }
        }
      } catch {
        // keep default prices
      }
    };
    fetchPrices();
  }, [open]);

  const currentPlanPrice = selectedPlan === 'pro' ? proPrice : proPlusPrice;
  const features = PLAN_FEATURES[selectedPlan];

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
      if (result.plan === 'pro' || result.plan === 'pro_plus') {
        setTimeout(() => onClose(), 1500);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('settings.promoCodeError');
      setPromoError(message);
    } finally {
      setPromoLoading(false);
    }
  };

  const handleSelectMethod = (method: 'card' | 'sbp') => {
    if (paymentLoading) return;
    setSelectedMethod(method);
    onSelectMethod(method, selectedPlan);
  };

  const openLegalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const methodSx = (method: 'card' | 'sbp') => ({
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    p: '10px 14px',
    borderRadius: 2,
    border: '1.5px solid',
    borderColor: (selectedMethod === method && paymentLoading) ? '#6366f1' : 'rgba(99,102,241,0.2)',
    bgcolor: (selectedMethod === method && paymentLoading) ? 'rgba(99,102,241,0.1)' : 'rgba(99,102,241,0.04)',
    cursor: paymentLoading ? 'not-allowed' : 'pointer',
    transition: 'all 0.18s ease',
    '&:hover': paymentLoading ? {} : {
      borderColor: '#6366f1',
      bgcolor: 'rgba(99,102,241,0.1)',
    },
  });

  const planCardSx = (plan: 'pro' | 'pro_plus') => ({
    flex: 1,
    p: 1.5,
    borderRadius: 2,
    border: '2px solid',
    borderColor: selectedPlan === plan
      ? '#6366f1'
      : 'divider',
    cursor: 'pointer',
    transition: 'all 0.18s ease',
    position: 'relative' as const,
    '&:hover': {
      borderColor: '#6366f1',
    },
  });

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
          {language === 'ru' ? 'Выберите план' : 'Choose a Plan'}
        </Typography>
        <IconButton size="small" onClick={onClose} disabled={paymentLoading}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 1, pb: 3 }}>

        {/* Plan comparison cards */}
        <Box sx={{ display: 'flex', gap: 1.5, mb: 2.5 }}>
          {/* Pro Card */}
          <Box onClick={() => setSelectedPlan('pro')} sx={planCardSx('pro')}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>Pro</Typography>
            <Typography sx={{ fontSize: '1.5rem', fontWeight: 800, color: '#6366f1', lineHeight: 1 }}>
              {proPrice}₽
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {language === 'ru' ? '/мес' : '/month'}
            </Typography>
            <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
              <FeatureLine text={`${PLAN_FEATURES.pro.budget} ${language === 'ru' ? 'бюдж. токенов' : 'budget tokens'}`} />
              <FeatureLine text={`${PLAN_FEATURES.pro.premium} ${language === 'ru' ? 'прем. токенов' : 'premium tokens'}`} />
              <FeatureLine text={`${PLAN_FEATURES.pro.requests} ${language === 'ru' ? 'запр/мин' : 'req/min'}`} />
              <FeatureLine text={`${language === 'ru' ? 'Наценка' : 'Markup'} ${PLAN_FEATURES.pro.markup}%`} />
            </Box>
          </Box>

          {/* Pro Plus Card */}
          <Box onClick={() => setSelectedPlan('pro_plus')} sx={planCardSx('pro_plus')}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>Pro Plus</Typography>
            <Typography sx={{ fontSize: '1.5rem', fontWeight: 800, color: '#8b5cf6', lineHeight: 1 }}>
              {proPlusPrice}₽
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {language === 'ru' ? '/мес' : '/month'}
            </Typography>
            <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
              <FeatureLine text={`${PLAN_FEATURES.pro_plus.budget} ${language === 'ru' ? 'бюдж. токенов' : 'budget tokens'}`} />
              <FeatureLine text={`${PLAN_FEATURES.pro_plus.premium} ${language === 'ru' ? 'прем. токенов' : 'premium tokens'}`} highlight />
              <FeatureLine text={`${PLAN_FEATURES.pro_plus.requests} ${language === 'ru' ? 'запр/мин' : 'req/min'}`} />
              <FeatureLine text={`${language === 'ru' ? 'Наценка' : 'Markup'} ${PLAN_FEATURES.pro_plus.markup}%`} highlight />
            </Box>
          </Box>
        </Box>

        {/* Selected plan price */}
        <Box sx={{ textAlign: 'center', mb: 2 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {selectedPlan === 'pro' ? 'Pro' : 'Pro Plus'} — {currentPlanPrice}₽{language === 'ru' ? '/мес' : '/month'}
          </Typography>
        </Box>

        {/* Payment methods */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
          <Box onClick={() => handleSelectMethod('card')} sx={methodSx('card')} data-testid="payment-method-card">
            {paymentLoading && selectedMethod === 'card' ? (
              <CircularProgress size={22} sx={{ color: '#6366f1', flexShrink: 0 }} />
            ) : (
              <CreditCardIcon sx={{ fontSize: 22, color: '#6366f1', flexShrink: 0 }} />
            )}
            <Typography sx={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('payment.card')}</Typography>
          </Box>

          <Box onClick={() => handleSelectMethod('sbp')} sx={methodSx('sbp')} data-testid="payment-method-sbp">
            {paymentLoading && selectedMethod === 'sbp' ? (
              <CircularProgress size={22} sx={{ color: '#6366f1', flexShrink: 0 }} />
            ) : (
              <QrCodeIcon sx={{ fontSize: 22, color: '#6366f1', flexShrink: 0 }} />
            )}
            <Typography sx={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('payment.sbp')}</Typography>
          </Box>
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
      <CheckIcon sx={{ fontSize: 12, color: highlight ? '#8b5cf6' : 'success.main' }} />
      <Typography variant="caption" sx={{ color: highlight ? '#8b5cf6' : 'text.secondary', fontWeight: highlight ? 600 : 400, fontSize: '0.7rem' }}>
        {text}
      </Typography>
    </Box>
  );
}
