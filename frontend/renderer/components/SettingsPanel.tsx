import React from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  ToggleButtonGroup,
  ToggleButton,
  Button,
  Avatar,
  Switch,
  Alert,
  Snackbar,
  Chip,
  CircularProgress,
  Checkbox,
  FormControlLabel,
  Link,
  TextField,
} from '@mui/material';
import {
  Close as CloseIcon,
  Settings as SettingsIcon,
  Warning as WarningIcon,
  DarkMode as DarkModeIcon,
  LightMode as LightModeIcon,
  SettingsBrightness as SystemIcon,
  Logout as LogoutIcon,
  Person as PersonIcon,
  Shield as ShieldIcon,
  WorkspacePremium as PremiumIcon,
  OpenInNew as OpenInNewIcon,
  Translate as TranslateIcon,
  Gavel as GavelIcon,
  AutoAwesome as AutoAwesomeIcon,
  Palette as PaletteIcon,
  CardGiftcard as CardGiftcardIcon,
} from '@mui/icons-material';
import { useAgent } from '../contexts/AgentContext';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useAuth } from '../providers/AuthProvider';
import { authService, createPaymentInvoice, isSubscriptionActive, applyPromoCode, getAuthToken } from '../services/auth';
import { loadBackendUrl } from '../utils/secureSettingsStorage';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

function getTrialDaysRemaining(trialEndsAt?: string): number {
  if (!trialEndsAt) return 0;
  const now = new Date();
  const end = new Date(trialEndsAt);
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function formatPlanExpiry(planExpiresAt?: string, lang?: string): string {
  if (!planExpiresAt) return '';
  const date = new Date(planExpiresAt);
  return date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const sectionCardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  p: 1.5,
  mb: 1.5,
} as const;

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.25 }}>
      {icon}
      <Typography variant="caption" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary' }}>
        {title}
      </Typography>
    </Box>
  );
}

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { model, setModel, securityMode, setSecurityMode } = useAgent();
  const [showUnsafeWarning, setShowUnsafeWarning] = React.useState(false);
  const { themeMode, setThemeMode } = useTheme();
  const { t, language, setLanguage } = useTranslation();
  const { user, logout, refreshUser } = useAuth();
  const [paymentLoading, setPaymentLoading] = React.useState(false);
  const [paymentError, setPaymentError] = React.useState<string | null>(null);
  const [legalAccepted, setLegalAccepted] = React.useState(false);
  const [appVersion, setAppVersion] = React.useState<string>('');

  // Promo code state
  const [promoCode, setPromoCode] = React.useState('');
  const [promoLoading, setPromoLoading] = React.useState(false);
  const [promoSuccess, setPromoSuccess] = React.useState<string | null>(null);
  const [promoError, setPromoError] = React.useState<string | null>(null);

  // Dynamic price state
  const [currentPrice, setCurrentPrice] = React.useState<number>(20);
  const [originalPrice, setOriginalPrice] = React.useState<number>(20);

  React.useEffect(() => {
    if (window.electronAPI?.getAppVersion) {
      window.electronAPI.getAppVersion().then(setAppVersion);
    }
  }, []);

  // Fetch dynamic price when panel opens
  React.useEffect(() => {
    if (!open || !user) return;
    const fetchPrice = async () => {
      try {
        const baseUrl = loadBackendUrl('https://progresql.com');
        const token = getAuthToken() || '';
        const resp = await fetch(`${baseUrl}/api/v1/payment/price`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          setCurrentPrice(data.price ?? 20);
          setOriginalPrice(data.original_price ?? 20);
        }
      } catch {
        // fallback to default price
      }
    };
    fetchPrice();
  }, [open, user, promoSuccess]);

  const isActive = isSubscriptionActive(user);
  const trialDays = getTrialDaysRemaining(user?.trialEndsAt);
  const isTrialActive = trialDays > 0;
  const isPro = user?.plan === 'pro' && user?.planExpiresAt && new Date(user.planExpiresAt) > new Date();

  const openLegalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const handleUpgrade = async () => {
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      // Record legal acceptance BEFORE creating payment invoice
      await Promise.all([
        authService.acceptLegal('offer', '1.0'),
        authService.acceptLegal('crypto-payments', '1.0'),
        authService.acceptLegal('refunds', '1.0'),
      ]);
      const { payment_url } = await createPaymentInvoice();
      // Open in external browser (Electron's window.open shows blank page)
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(payment_url);
      } else {
        window.open(payment_url, '_blank');
      }
      const pollInterval = setInterval(async () => {
        try {
          await refreshUser();
        } catch { /* ignore polling errors */ }
      }, 5000);
      setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create payment';
      setPaymentError(message);
    } finally {
      setPaymentLoading(false);
    }
  };

  const handleApplyPromoCode = async () => {
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    setPromoSuccess(null);
    setPromoError(null);
    try {
      await applyPromoCode(promoCode.trim());
      setPromoSuccess(t('settings.promoCodeSuccess'));
      setPromoCode('');
      // Refresh user data to reflect the new plan
      await refreshUser();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('settings.promoCodeError');
      setPromoError(message);
    } finally {
      setPromoLoading(false);
    }
  };

  return (
    <>
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: 320,
          p: 2,
        },
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <SettingsIcon sx={{ mr: 1, color: 'text.secondary', fontSize: 20 }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 700, flexGrow: 1 }}>
          {t('settings.title')}
        </Typography>
        <IconButton size="small" onClick={onClose} aria-label={t('settings.close')}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ overflowY: 'auto', flex: 1, mx: -0.5, px: 0.5 }}>
        {/* Subscription */}
        {user && (
          <Box sx={sectionCardSx}>
            <SectionHeader
              icon={<PremiumIcon sx={{ fontSize: 16, color: isPro ? '#a78bfa' : isTrialActive ? '#a78bfa' : 'text.disabled' }} />}
              title={t('settings.subscription')}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              {isPro ? (
                <Chip
                  label={t('settings.planPro')}
                  size="small"
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.7rem',
                    height: 22,
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    color: '#fff',
                  }}
                />
              ) : isTrialActive ? (
                <Chip
                  label={t('settings.planTrial')}
                  size="small"
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.7rem',
                    height: 22,
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    color: '#fff',
                  }}
                />
              ) : (
                <Chip
                  label={t('settings.planFree')}
                  size="small"
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.7rem',
                    height: 22,
                    bgcolor: 'action.selected',
                    color: 'text.secondary',
                  }}
                />
              )}
            </Box>

            {isPro && (
              <Typography variant="caption" sx={{ color: 'success.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'success.main', display: 'inline-block' }} />
                {t('settings.proUntil', { date: formatPlanExpiry(user.planExpiresAt, language) })}
              </Typography>
            )}

            {!isPro && isTrialActive && (
              <Typography variant="caption" sx={{ color: '#a78bfa' }}>
                {t('settings.daysRemaining', { count: String(trialDays) })}
              </Typography>
            )}

            {!isPro && !isTrialActive && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('settings.upgradePrompt')}
              </Typography>
            )}

            {!isPro && (
              <Box sx={{ mt: 1.5 }}>
                {/* Legal consent checkbox */}
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
                  sx={{ alignItems: 'flex-start', mb: 0.5, mx: 0 }}
                />

                {/* Crypto transaction warning */}
                <Alert
                  severity="warning"
                  icon={<WarningIcon sx={{ fontSize: 16 }} />}
                  sx={{ mb: 1.5, py: 0, '& .MuiAlert-message': { fontSize: '0.7rem' } }}
                >
                  {t('settings.cryptoWarning')}
                </Alert>

                <Button
                  variant="contained"
                  size="small"
                  fullWidth
                  disabled={paymentLoading || !legalAccepted}
                  onClick={handleUpgrade}
                  startIcon={paymentLoading ? <CircularProgress size={14} color="inherit" /> : <OpenInNewIcon sx={{ fontSize: 14 }} />}
                  sx={{
                    textTransform: 'none',
                    fontWeight: 600,
                    background: (paymentLoading || !legalAccepted) ? undefined : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    '&:hover': {
                      background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
                    },
                  }}
                >
                  {paymentLoading ? t('settings.upgradeWaiting') : (
                    <>
                      {t('settings.upgradeButton')}
                      {currentPrice < originalPrice ? (
                        <span style={{ marginLeft: 6 }}>
                          ${currentPrice.toFixed(0)}/mo
                          <span style={{ textDecoration: 'line-through', opacity: 0.6, marginLeft: 4, fontSize: '0.8em' }}>
                            ${originalPrice}
                          </span>
                        </span>
                      ) : (
                        <span style={{ marginLeft: 6 }}>${currentPrice}/mo</span>
                      )}
                    </>
                  )}
                </Button>
                {paymentError && (
                  <Typography variant="caption" sx={{ color: 'error.main', mt: 0.5, display: 'block' }}>
                    {paymentError}
                  </Typography>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Promo Code */}
        {user && (
          <Box sx={sectionCardSx}>
            <SectionHeader
              icon={<CardGiftcardIcon sx={{ fontSize: 16, color: '#a78bfa' }} />}
              title={t('settings.promoCode')}
            />
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
        )}

        {/* AI Model */}
        <Box sx={sectionCardSx}>
          <SectionHeader
            icon={<AutoAwesomeIcon sx={{ fontSize: 16, color: '#a78bfa' }} />}
            title={t('settings.llmModel')}
          />
          <FormControl fullWidth size="small">
            <InputLabel id="settings-model-label">{t('settings.modelLabel')}</InputLabel>
            <Select
              labelId="settings-model-label"
              value={model}
              label={t('settings.modelLabel')}
              onChange={(e) => setModel(e.target.value as string)}
            >
              <MenuItem value="qwen/qwen3-coder">Qwen 3 Coder</MenuItem>
              <MenuItem value="openai/gpt-oss-120b">GPT-OSS 120B</MenuItem>
              <MenuItem value="qwen/qwen3-vl-32b-instruct">Qwen 3 VL 32B</MenuItem>
            </Select>
          </FormControl>
        </Box>

        {/* Security Mode */}
        <Box sx={sectionCardSx}>
          <SectionHeader
            icon={<ShieldIcon sx={{ fontSize: 16, color: securityMode === 'safe' ? 'success.main' : securityMode === 'data' ? 'info.main' : 'warning.main' }} />}
            title={t('settings.security')}
          />
          <FormControl fullWidth size="small">
            <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3, mb: 0.5 }}>
              {t('settings.securityMode')}
            </Typography>
            <Select
              value={securityMode}
              onChange={(e) => {
                const mode = e.target.value as 'safe' | 'data' | 'execute';
                setSecurityMode(mode);
                if (mode === 'execute') {
                  setShowUnsafeWarning(true);
                  setTimeout(() => setShowUnsafeWarning(false), 3000);
                } else {
                  setShowUnsafeWarning(false);
                }
              }}
              sx={{ fontSize: '0.85rem' }}
            >
              <MenuItem value="safe">
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>Safe Mode</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('settings.securityModeSafeDesc')}
                  </Typography>
                </Box>
              </MenuItem>
              <MenuItem value="data">
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>Data Mode</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('settings.securityModeDataDesc')}
                  </Typography>
                </Box>
              </MenuItem>
              <MenuItem value="execute">
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>Execute Mode</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('settings.securityModeExecuteDesc')}
                  </Typography>
                </Box>
              </MenuItem>
            </Select>
          </FormControl>
          {/* Mode info tooltip */}
          <Box sx={{ mt: 1, p: 1.5, borderRadius: 1, bgcolor: securityMode === 'safe' ? 'rgba(34,197,94,0.08)' : securityMode === 'data' ? 'rgba(59,130,246,0.08)' : 'rgba(245,158,11,0.08)', border: '1px solid', borderColor: securityMode === 'safe' ? 'rgba(34,197,94,0.2)' : securityMode === 'data' ? 'rgba(59,130,246,0.2)' : 'rgba(245,158,11,0.2)' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
              {securityMode === 'safe' && t('settings.securityModeSafeInfo')}
              {securityMode === 'data' && t('settings.securityModeDataInfo')}
              {securityMode === 'execute' && t('settings.securityModeExecuteInfo')}
            </Typography>
          </Box>
        </Box>

        {/* Theme */}
        <Box sx={sectionCardSx}>
          <SectionHeader
            icon={<PaletteIcon sx={{ fontSize: 16, color: '#a78bfa' }} />}
            title={t('settings.theme')}
          />
          <ToggleButtonGroup
            value={themeMode}
            exclusive
            onChange={(_, value) => { if (value) setThemeMode(value); }}
            size="small"
            fullWidth
          >
            <ToggleButton value="light" aria-label="Light theme">
              <LightModeIcon sx={{ fontSize: 16, mr: 0.5 }} />
              {t('settings.themeLight')}
            </ToggleButton>
            <ToggleButton value="dark" aria-label="Dark theme">
              <DarkModeIcon sx={{ fontSize: 16, mr: 0.5 }} />
              {t('settings.themeDark')}
            </ToggleButton>
            <ToggleButton value="system" aria-label="System theme">
              <SystemIcon sx={{ fontSize: 16, mr: 0.5 }} />
              {t('settings.themeSystem')}
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>

        {/* Language */}
        <Box sx={sectionCardSx}>
          <SectionHeader
            icon={<TranslateIcon sx={{ fontSize: 16, color: '#a78bfa' }} />}
            title={t('settings.language')}
          />
          <ToggleButtonGroup
            value={language}
            exclusive
            onChange={(_, value) => { if (value) setLanguage(value); }}
            size="small"
            fullWidth
          >
            <ToggleButton value="en" aria-label="English">
              English
            </ToggleButton>
            <ToggleButton value="ru" aria-label="Russian">
              Русский
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>

        {/* Legal */}
        <Box sx={sectionCardSx}>
          <SectionHeader
            icon={<GavelIcon sx={{ fontSize: 16, color: '#a78bfa' }} />}
            title={t('settings.legal')}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            {([
              { label: 'settings.legalPrivacy', url: 'https://progresql.com/privacy' },
              { label: 'settings.legalTerms', url: 'https://progresql.com/terms' },
              { label: 'settings.legalOfferFull', url: 'https://progresql.com/offer' },
              { label: 'settings.legalCryptoFull', url: 'https://progresql.com/crypto-payments' },
              { label: 'settings.legalRefundsFull', url: 'https://progresql.com/refunds' },
              { label: 'settings.legalContacts', url: 'https://progresql.com/contacts' },
            ] as const).map(({ label, url }) => (
              <Link
                key={label}
                component="button"
                variant="body2"
                onClick={() => openLegalLink(url)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  textAlign: 'left',
                  color: 'text.secondary',
                  textDecoration: 'none',
                  py: 0.375,
                  '&:hover': { color: 'primary.main' },
                }}
              >
                {t(label)}
                <OpenInNewIcon sx={{ fontSize: 12, ml: 'auto', opacity: 0.5 }} />
              </Link>
            ))}
          </Box>
          {appVersion && (
            <Typography variant="caption" sx={{ color: 'text.disabled', mt: 1, display: 'block' }}>
              {t('settings.version', { version: appVersion })}
            </Typography>
          )}
          <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.65rem' }}>
              {t('legal.disclaimer')}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.65rem' }}>
              {t('legal.copyright')}
            </Typography>
          </Box>
        </Box>

        {/* Account */}
        {user && (
          <Box sx={sectionCardSx}>
            <SectionHeader
              icon={<PersonIcon sx={{ fontSize: 16, color: '#a78bfa' }} />}
              title={t('settings.account')}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
              <Avatar sx={{ width: 32, height: 32, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', fontSize: 14 }}>
                {user.name ? user.name.charAt(0).toUpperCase() : <PersonIcon fontSize="small" />}
              </Avatar>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                {user.name && (
                  <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {user.name}
                  </Typography>
                )}
                <Typography variant="caption" sx={{ color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                  {user.email}
                </Typography>
              </Box>
            </Box>
            <Button
              variant="outlined"
              size="small"
              startIcon={<LogoutIcon />}
              onClick={logout}
              fullWidth
              color="inherit"
              sx={{ textTransform: 'none' }}
            >
              {t('settings.logout')}
            </Button>
          </Box>
        )}
      </Box>
    </Drawer>
    <Snackbar
      open={showUnsafeWarning}
      autoHideDuration={3000}
      onClose={() => setShowUnsafeWarning(false)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert severity="warning" variant="filled" sx={{ width: '100%', fontSize: '0.8125rem' }} onClose={() => setShowUnsafeWarning(false)}>
        {t('settings.unsafeWarning')}
      </Alert>
    </Snackbar>
    </>
  );
}
