import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  TextField,
  Button,
  Checkbox,
  FormControlLabel,
  Link,
  CircularProgress,
  IconButton,
  Chip,
} from '@mui/material';
import {
  Close as CloseIcon,
  CreditCard as CreditCardIcon,
  QrCode as QrCodeIcon,
  CheckCircleOutline as CheckCircleIcon,
} from '@mui/icons-material';
import { useTranslation } from '../contexts/LanguageContext';
import { applyPromoCode, getAuthToken, isSubscriptionActive } from '../services/auth';
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


const glassCardSx = {
  flex: 1,
  p: 2.5,
  borderRadius: 2,
  bgcolor: 'rgba(99,102,241,0.08)',
  border: '1.5px solid rgba(99,102,241,0.2)',
  cursor: 'pointer',
  transition: 'all 0.2s ease',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 1,
  '&:hover': {
    borderColor: '#6366f1',
    bgcolor: 'rgba(99,102,241,0.14)',
    transform: 'translateY(-2px)',
    boxShadow: '0 4px 20px rgba(99,102,241,0.15)',
  },
} as const;

const selectedCardSx = {
  ...glassCardSx,
  border: '1.5px solid #6366f1',
  background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(139,92,246,0.12))',
  boxShadow: '0 0 0 1px rgba(99,102,241,0.3), 0 4px 20px rgba(99,102,241,0.15)',
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
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();

  // Promo code state
  const [promoCode, setPromoCode] = React.useState('');
  const [promoLoading, setPromoLoading] = React.useState(false);
  const [promoSuccess, setPromoSuccess] = React.useState<string | null>(null);
  const [promoError, setPromoError] = React.useState<string | null>(null);

  // Legal checkbox
  const [legalAccepted, setLegalAccepted] = React.useState(false);

  // Selected method (for loading indicator)
  const [selectedMethod, setSelectedMethod] = React.useState<'card' | 'sbp' | null>(null);

  // Dynamic price (local, refreshed after promo)
  const [localCurrentPrice, setLocalCurrentPrice] = React.useState(currentPrice);
  const [localOriginalPrice, setLocalOriginalPrice] = React.useState(originalPrice);

  // Check if user has active subscription (pro/trial with valid expiry)
  const isPro = isSubscriptionActive(user);

  // Sync prices from parent
  React.useEffect(() => {
    setLocalCurrentPrice(currentPrice);
    setLocalOriginalPrice(originalPrice);
  }, [currentPrice, originalPrice]);

  // Refresh price after promo applied
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
      // If promo granted Pro, close modal after short delay
      if (result.plan === 'pro') {
        setTimeout(() => {
          onClose();
        }, 1500);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('settings.promoCodeError');
      setPromoError(message);
    } finally {
      setPromoLoading(false);
    }
  };

  const handleSelectMethod = (method: 'card' | 'sbp') => {
    if (paymentLoading || !legalAccepted) return;
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

  const renderPrice = () => (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
      <Typography
        component="span"
        sx={{ fontSize: '1.5rem', fontWeight: 700, color: '#10b981' }}
      >
        ${localCurrentPrice}/mo
      </Typography>
      {hasDiscount && (
        <Typography
          component="span"
          sx={{ fontSize: '0.9rem', textDecoration: 'line-through', color: 'text.disabled' }}
        >
          ${localOriginalPrice}
        </Typography>
      )}
    </Box>
  );

  return (
    <Dialog
      open={open}
      onClose={paymentLoading ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 3,
          overflow: 'hidden',
        },
      }}
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
          pb: 1,
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {t('settings.upgradeButton')}
        </Typography>
        <IconButton
          size="small"
          onClick={onClose}
          disabled={paymentLoading}
          aria-label={t('settings.close')}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pb: 3 }}>
        {/* Promo Code Section */}
        <Box sx={{ mb: 2.5 }}>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'text.secondary',
              mb: 1,
              display: 'block',
            }}
          >
            {t('settings.promoCode')}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              size="small"
              placeholder={t('settings.promoCodePlaceholder')}
              value={promoCode}
              onChange={(e) => {
                setPromoCode(e.target.value);
                setPromoError(null);
                setPromoSuccess(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleApplyPromoCode();
              }}
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
                '&:hover': {
                  background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
                },
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
        </Box>

        {/* Legal Checkbox */}
        {
            <Box sx={{ mb: 2 }}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={legalAccepted}
                    onChange={(_, checked) => setLegalAccepted(checked)}
                    size="small"
                  />
                }
                label={
                  <Typography variant="caption" sx={{ lineHeight: 1.4 }}>
                    {(() => {
                      const template = t('settings.legalConsent');
                      const parts = template.split(/(\{offer\}|\{cryptoPayments\}|\{refunds\})/);
                      return parts.map((part, i) => {
                        if (part === '{offer}') return <Link key={i} component="button" variant="caption" onClick={() => openLegalLink('https://progresql.com/offer')}>{t('settings.legalOffer')}</Link>;
                        if (part === '{cryptoPayments}') return <Link key={i} component="button" variant="caption" onClick={() => openLegalLink('https://progresql.com/crypto-payments')}>{t('settings.legalCryptoPayments')}</Link>;
                        if (part === '{refunds}') return <Link key={i} component="button" variant="caption" onClick={() => openLegalLink('https://progresql.com/refunds')}>{t('settings.legalRefunds')}</Link>;
                        return <React.Fragment key={i}>{part}</React.Fragment>;
                      });
                    })()}
                  </Typography>
                }
                sx={{ alignItems: 'flex-start', mx: 0 }}
              />
            </Box>

            {/* Payment Methods */}
            <Typography
              variant="caption"
              sx={{
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'text.secondary',
                mb: 1.5,
                display: 'block',
              }}
            >
              {t('payment.selectMethod')}
            </Typography>

            <Box sx={{ display: 'flex', gap: 2, mb: 2.5 }}>
              {/* Card */}
              <Box
                onClick={() => handleSelectMethod('card')}
                sx={{
                  ...(selectedMethod === 'card' && paymentLoading ? selectedCardSx : glassCardSx),
                  opacity: (!legalAccepted && !paymentLoading) ? 0.5 : 1,
                  pointerEvents: (paymentLoading || !legalAccepted) ? 'none' : 'auto',
                }}
              >
                {paymentLoading && selectedMethod === 'card' ? (
                  <CircularProgress size={28} sx={{ color: '#6366f1' }} />
                ) : (
                  <CreditCardIcon sx={{ fontSize: 32, color: '#6366f1' }} />
                )}
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  {t('payment.card')}
                </Typography>
                {renderPrice()}
              </Box>

              {/* SBP */}
              <Box
                onClick={() => handleSelectMethod('sbp')}
                sx={{
                  ...(selectedMethod === 'sbp' && paymentLoading ? selectedCardSx : glassCardSx),
                  opacity: (!legalAccepted && !paymentLoading) ? 0.5 : 1,
                  pointerEvents: (paymentLoading || !legalAccepted) ? 'none' : 'auto',
                }}
              >
                {paymentLoading && selectedMethod === 'sbp' ? (
                  <CircularProgress size={28} sx={{ color: '#6366f1' }} />
                ) : (
                  <QrCodeIcon sx={{ fontSize: 32, color: '#6366f1' }} />
                )}
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  {t('payment.sbp')}
                </Typography>
                {renderPrice()}
              </Box>
            </Box>
        }

        {/* Payment error */}
        {paymentError && (
          <Typography variant="caption" sx={{ color: 'error.main', mt: 0.5, display: 'block' }}>
            {paymentError}
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}
