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
  onSelectMethod: (method: 'card' | 'sbp') => void;
  paymentLoading: boolean;
  paymentError: string | null;
}

export default function PaymentModal({
  open,
  onClose,
  currentPrice,
  originalPrice,
  onSelectMethod,
  paymentLoading,
  paymentError,
}: PaymentModalProps) {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();

  const [promoOpen, setPromoOpen] = React.useState(false);
  const [promoCode, setPromoCode] = React.useState('');
  const [promoLoading, setPromoLoading] = React.useState(false);
  const [promoSuccess, setPromoSuccess] = React.useState<string | null>(null);
  const [promoError, setPromoError] = React.useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = React.useState<'card' | 'sbp' | null>(null);
  const [localCurrentPrice, setLocalCurrentPrice] = React.useState(currentPrice);
  const [localOriginalPrice, setLocalOriginalPrice] = React.useState(originalPrice);

  React.useEffect(() => {
    setLocalCurrentPrice(currentPrice);
    setLocalOriginalPrice(originalPrice);
  }, [currentPrice, originalPrice]);

  const refreshPrice = React.useCallback(async () => {
    try {
      const baseUrl = loadBackendUrl('https://progresql.com');
      const token = getAuthToken() || '';
      const resp = await fetch(`${baseUrl}/api/v1/payment/price`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        setLocalCurrentPrice(data.price ?? 20);
        setLocalOriginalPrice(data.original_price ?? 20);
      }
    } catch {
      // keep current prices
    }
  }, []);

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
      await refreshPrice();
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

  const handleSelectMethod = (method: 'card' | 'sbp') => {
    if (paymentLoading) return;
    setSelectedMethod(method);
    onSelectMethod(method);
  };

  const openLegalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const hasDiscount = localCurrentPrice < localOriginalPrice;

  const methodSx = (method: 'card' | 'sbp') => ({
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    p: '12px 16px',
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

  return (
    <Dialog
      open={open}
      onClose={paymentLoading ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{ sx: { borderRadius: 3, overflow: 'hidden' } }}
    >
      {/* Gradient top border */}
      <Box sx={{ height: 4, background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)' }} />

      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 0.5, pt: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {t('settings.upgradeButton')}
        </Typography>
        <IconButton size="small" onClick={onClose} disabled={paymentLoading}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 2, pb: 3 }}>

        {/* Price block */}
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <Box sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 1 }}>
            <Typography sx={{ fontSize: '2.5rem', fontWeight: 800, color: '#10b981', lineHeight: 1 }}>
              {localCurrentPrice} ₽
            </Typography>
            <Typography sx={{ fontSize: '1rem', color: 'text.secondary' }}>/мес</Typography>
          </Box>
          {hasDiscount && (
            <Typography sx={{ fontSize: '0.85rem', textDecoration: 'line-through', color: 'text.disabled', mt: 0.25 }}>
              {localOriginalPrice} ₽/мес
            </Typography>
          )}
        </Box>

        {/* Payment methods */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2.5 }}>
          <Box onClick={() => handleSelectMethod('card')} sx={methodSx('card')}>
            {paymentLoading && selectedMethod === 'card' ? (
              <CircularProgress size={24} sx={{ color: '#6366f1', flexShrink: 0 }} />
            ) : (
              <CreditCardIcon sx={{ fontSize: 24, color: '#6366f1', flexShrink: 0 }} />
            )}
            <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>{t('payment.card')}</Typography>
          </Box>

          <Box onClick={() => handleSelectMethod('sbp')} sx={methodSx('sbp')}>
            {paymentLoading && selectedMethod === 'sbp' ? (
              <CircularProgress size={24} sx={{ color: '#6366f1', flexShrink: 0 }} />
            ) : (
              <QrCodeIcon sx={{ fontSize: 24, color: '#6366f1', flexShrink: 0 }} />
            )}
            <Typography sx={{ fontWeight: 600, fontSize: '0.95rem' }}>{t('payment.sbp')}</Typography>
          </Box>
        </Box>

        {/* Promo code collapsible */}
        <Box sx={{ mb: 2 }}>
          <Box
            onClick={() => setPromoOpen(v => !v)}
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
                inputProps={{ style: { fontSize: '0.85rem' } }}
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
