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
  Alert,
  Snackbar,
  Chip,
  Link,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Close as CloseIcon,
  Settings as SettingsIcon,
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
  Star as StarIcon,
  AccountBalanceWallet as WalletIcon,
  TrendingUp as TrendingUpIcon,
} from '@mui/icons-material';
import { useAgent } from '../contexts/AgentContext';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useAuth } from '../providers/AuthProvider';
import { authService, createPaymentInvoice, getAuthToken } from '../services/auth';
import { loadBackendUrl } from '../utils/secureSettingsStorage';
import { useModels } from '../hooks/useModels';
import PaymentModal from './PaymentModal';
import BalanceTopUpModal from './BalanceTopUpModal';
import UsageDashboard from './UsageDashboard';

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

function formatPlanExpiryCompact(planExpiresAt?: string, lang?: string): string {
  if (!planExpiresAt) return '';
  const date = new Date(planExpiresAt);
  return date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', day: 'numeric' });
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
  const { model, setModel, autocompleteModel, setAutocompleteModel, autocompleteEnabled, setAutocompleteEnabled, securityMode, setSecurityMode } = useAgent();
  const [showUnsafeWarning, setShowUnsafeWarning] = React.useState(false);
  const { themeMode, setThemeMode } = useTheme();
  const { t, language, setLanguage } = useTranslation();
  const { user, logout, refreshUser } = useAuth();
  const [paymentLoading, setPaymentLoading] = React.useState(false);
  const [paymentError, setPaymentError] = React.useState<string | null>(null);
  const [appVersion, setAppVersion] = React.useState<string>('');

  const { models: allModels, budgetModels, premiumModels } = useModels();

  // Payment modal state
  const [paymentModalOpen, setPaymentModalOpen] = React.useState(false);
  const [balanceTopUpModalOpen, setBalanceTopUpModalOpen] = React.useState(false);
  const [usageDashboardOpen, setUsageDashboardOpen] = React.useState(false);

  // Dynamic price state
  const [currentPrice, setCurrentPrice] = React.useState<number>(1999);
  const [originalPrice, setOriginalPrice] = React.useState<number>(1999);

  // Auto-close payment modal when user becomes Pro or Pro Plus
  React.useEffect(() => {
    if ((user?.plan === 'pro' || user?.plan === 'pro_plus') && paymentModalOpen) {
      setPaymentModalOpen(false);
    }
  }, [user?.plan, paymentModalOpen]);

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
          setCurrentPrice(data.price ?? 1999);
          setOriginalPrice(data.original_price ?? 1999);
        }
      } catch {
        // fallback to default price
      }
    };
    fetchPrice();
  }, [open, user]);

  const trialDays = getTrialDaysRemaining(user?.trialEndsAt);
  const isTrialActive = trialDays > 0;
  const isPro = user?.plan === 'pro' && user?.planExpiresAt && new Date(user.planExpiresAt) > new Date();
  const isProPlus = user?.plan === 'pro_plus' && user?.planExpiresAt && new Date(user.planExpiresAt) > new Date();
  const isPaid = isPro || isProPlus;

  const openLegalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const handleSelectPaymentMethod = async (method: 'card' | 'sbp', plan?: string) => {
    const paymentMethod = method === 'card' ? 11 : 2;
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      // Record legal acceptance BEFORE creating payment invoice
      await Promise.all([
        authService.acceptLegal('offer', '1.0'),
        authService.acceptLegal('privacy', '1.0'),
        authService.acceptLegal('refunds', '1.0'),
      ]);
      const { payment_url } = await createPaymentInvoice(paymentMethod, {
        plan: plan || 'pro',
        paymentType: 'subscription',
      });
      // Open in external browser
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
        {/* Subscription - compact with wrap */}
        {user && (
          <Box sx={{ ...sectionCardSx, pb: 1.25 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
              <PremiumIcon sx={{ fontSize: 16, color: isPaid ? '#a78bfa' : isTrialActive ? '#a78bfa' : 'text.disabled' }} />
              <Typography variant="caption" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary' }}>
                {t('settings.subscription')}
              </Typography>
              {isProPlus ? (
                <>
                  <Chip label="Pro Plus" size="small" sx={{ fontWeight: 700, fontSize: '0.65rem', height: 20, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff' }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>
                    {language === 'ru' ? 'до' : 'until'} {formatPlanExpiryCompact(user.planExpiresAt, language)}
                  </Typography>
                </>
              ) : isPro ? (
                <>
                  <Chip label={t('settings.planPro')} size="small" sx={{ fontWeight: 700, fontSize: '0.65rem', height: 20, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff' }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>
                    {language === 'ru' ? 'до' : 'until'} {formatPlanExpiryCompact(user.planExpiresAt, language)}
                  </Typography>
                </>
              ) : isTrialActive ? (
                <>
                  <Chip label={t('settings.planTrial')} size="small" sx={{ fontWeight: 700, fontSize: '0.65rem', height: 20, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff' }} />
                  <Typography variant="caption" sx={{ color: '#a78bfa', fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                    {trialDays}{language === 'ru' ? 'д' : 'd'} {language === 'ru' ? 'ост.' : 'left'}
                  </Typography>
                </>
              ) : (
                <Chip label={t('settings.planFree')} size="small" sx={{ fontWeight: 700, fontSize: '0.65rem', height: 20, bgcolor: 'action.selected', color: 'text.secondary' }} />
              )}
            </Box>
            {!isPaid && (
              <Button
                variant="contained"
                fullWidth
                size="small"
                onClick={() => setPaymentModalOpen(true)}
                startIcon={<StarIcon sx={{ fontSize: 14 }} />}
                sx={{
                  mt: 1,
                  textTransform: 'none',
                  fontWeight: 700,
                  fontSize: '0.8rem',
                  height: 32,
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
                }}
              >
                {t('settings.upgradeButton')}
              </Button>
            )}
            <Button
              variant="contained"
              fullWidth
              size="small"
              onClick={() => setBalanceTopUpModalOpen(true)}
              startIcon={<WalletIcon sx={{ fontSize: 14 }} />}
              sx={{
                mt: 1,
                textTransform: 'none',
                fontWeight: 700,
                fontSize: '0.8rem',
                height: 32,
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                color: '#fff',
                '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
              }}
            >
              {t('balance.topUp')}
            </Button>
            <Button
              variant="outlined"
              fullWidth
              size="small"
              onClick={() => setUsageDashboardOpen(true)}
              startIcon={<TrendingUpIcon sx={{ fontSize: 14 }} />}
              sx={{
                mt: 0.75,
                textTransform: 'none',
                fontWeight: 600,
                fontSize: '0.8rem',
                height: 32,
                borderColor: 'rgba(99,102,241,0.3)',
                color: '#6366f1',
                '&:hover': { borderColor: '#6366f1', bgcolor: 'rgba(99,102,241,0.06)' },
              }}
            >
              {language === 'ru' ? 'Использование и расходы' : 'Usage & Spending'}
            </Button>
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
              renderValue={(value) => {
                const m = allModels.find(m => m.id === value);
                return m ? `${m.name}` : value;
              }}
            >
              {/* Budget Models */}
              <MenuItem disabled sx={{ opacity: 1, fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', color: 'text.secondary', py: 0.5, minHeight: 'auto', letterSpacing: '0.05em' }}>
                {language === 'ru' ? 'Бюджетные модели' : 'Budget Models'} — {language === 'ru' ? 'включены в подписку' : 'included in plan'}
              </MenuItem>
              {budgetModels.map(m => (
                <MenuItem key={m.id} value={m.id} sx={{ py: 0.75 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>{m.name}</Typography>
                    <Chip label={language === 'ru' ? 'Бюдж.' : 'Budget'} size="small" sx={{ fontSize: '0.6rem', height: 16, bgcolor: 'rgba(34,197,94,0.12)', color: 'success.main' }} />
                  </Box>
                </MenuItem>
              ))}
              {/* Premium Models */}
              <MenuItem disabled sx={{ opacity: 1, fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', color: 'text.secondary', py: 0.5, mt: 1, minHeight: 'auto', letterSpacing: '0.05em' }}>
                {language === 'ru' ? 'Премиум модели' : 'Premium Models'} — {language === 'ru' ? 'квота / баланс' : 'quota / balance'}
              </MenuItem>
              {premiumModels.map(m => (
                <MenuItem key={m.id} value={m.id} sx={{ py: 0.75 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>{m.name}</Typography>
                    <Chip label={language === 'ru' ? 'Прем.' : 'Premium'} size="small" sx={{ fontSize: '0.6rem', height: 16, bgcolor: 'rgba(245,158,11,0.12)', color: 'warning.main' }} />
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Autocomplete Toggle + Model */}
          <FormControlLabel
            control={
              <Switch
                checked={autocompleteEnabled}
                onChange={(e) => setAutocompleteEnabled(e.target.checked)}
                size="small"
                sx={{ '& .MuiSwitch-switchBase.Mui-checked': { color: '#6366f1' }, '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: '#6366f1' } }}
              />
            }
            label={<Typography variant="body2" sx={{ fontWeight: 500, fontSize: '0.8rem' }}>{language === 'ru' ? 'AI-автодополнение' : 'AI Autocomplete'}</Typography>}
            sx={{ mt: 1, ml: 0 }}
          />
          {autocompleteEnabled && (
            <FormControl fullWidth size="small" sx={{ mt: 1 }}>
              <InputLabel id="settings-autocomplete-model-label">{t('settings.autocompleteModelLabel')}</InputLabel>
              <Select
                labelId="settings-autocomplete-model-label"
                value={autocompleteModel}
                label={t('settings.autocompleteModelLabel')}
                onChange={(e) => setAutocompleteModel(e.target.value as string)}
                renderValue={(value) => {
                  const m = budgetModels.find(m => m.id === value);
                  return m ? m.name : value;
                }}
              >
                {budgetModels.map(m => (
                  <MenuItem key={m.id} value={m.id} sx={{ py: 0.75 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>{m.name}</Typography>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5, display: 'block', fontSize: '0.7rem' }}>
            {autocompleteEnabled ? t('settings.autocompleteModelHint') : (language === 'ru' ? 'Отключено для экономии токенов' : 'Disabled to save tokens')}
          </Typography>
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
            sx={{ '& .MuiToggleButton-root': { fontSize: '0.7rem', px: 0.5, gap: 0.5, minWidth: 0 } }}
          >
            <ToggleButton value="light" aria-label="Light theme">
              <LightModeIcon sx={{ fontSize: 15 }} />
              {t('settings.themeLight')}
            </ToggleButton>
            <ToggleButton value="dark" aria-label="Dark theme">
              <DarkModeIcon sx={{ fontSize: 15 }} />
              {t('settings.themeDark')}
            </ToggleButton>
            <ToggleButton value="system" aria-label="System theme">
              <SystemIcon sx={{ fontSize: 15 }} />
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

    {/* Payment Modal */}
    <PaymentModal
      open={paymentModalOpen}
      onClose={() => setPaymentModalOpen(false)}
      currentPrice={currentPrice}
      originalPrice={originalPrice}
      onSelectMethod={(method, plan) => handleSelectPaymentMethod(method, plan)}
      paymentLoading={paymentLoading}
      paymentError={paymentError}
    />
    <BalanceTopUpModal
      open={balanceTopUpModalOpen}
      onClose={() => setBalanceTopUpModalOpen(false)}
    />
    <UsageDashboard
      open={usageDashboardOpen}
      onClose={() => setUsageDashboardOpen(false)}
    />
    </>
  );
}
