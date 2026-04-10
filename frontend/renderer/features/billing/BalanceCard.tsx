import React from 'react';
import { Box, Typography, Button, LinearProgress } from '@mui/material';
import {
  CreditCard as CreditCardIcon,
  AutoAwesome as AutoAwesomeIcon,
} from '@mui/icons-material';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import { UsageInfo } from '@/shared/types';

export interface BalanceCardProps {
  usage: UsageInfo | null;
  loading?: boolean;
  onTopUp?: () => void;
  onManage?: () => void;
}

function formatUsd(n: number): string {
  if (!isFinite(n)) return '$0.00';
  if (Math.abs(n) >= 0.01 || n === 0) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

// Russian plural for "day" — 1 день / 2 дня / 5 дней.
function daysRu(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'дней';
  if (last === 1) return 'день';
  if (last >= 2 && last <= 4) return 'дня';
  return 'дней';
}

/**
 * "Reset in X days" label for Pro plan credits. Only rendered for Pro —
 * the Free plan subline is a different affordance ("budget models only").
 * Guards against sentinel/broken period_end values from the backend.
 */
function useProResetLabel(usage: UsageInfo | null, language: string): string {
  return React.useMemo(() => {
    if (!usage || usage.plan !== 'pro' || !usage.period_end) return '';
    const target = new Date(usage.period_end);
    const now = new Date();
    const deltaMs = target.getTime() - now.getTime();
    const twoYearsMs = 2 * 365 * 24 * 3600 * 1000;
    if (deltaMs <= 0 || deltaMs > twoYearsMs) return '';

    const days = Math.floor(deltaMs / (24 * 3600 * 1000));
    const hours = Math.floor((deltaMs % (24 * 3600 * 1000)) / (3600 * 1000));

    if (language === 'ru') {
      if (days >= 1) return `сброс через ${days} ${daysRu(days)}`;
      if (hours >= 1) return `сброс через ${hours} ч`;
      return 'сброс скоро';
    }
    if (days >= 1) return `resets in ${days}d`;
    if (hours >= 1) return `resets in ${hours}h`;
    return 'resets soon';
  }, [usage, language]);
}

/**
 * Borderless balance content. The outer section frame + header live in the
 * parent (SettingsPanel), so this component draws only the inner widgets:
 *   [ big USD balance ]
 *   [ plan credits panel with progress bar ]
 *   [ primary gradient action button ]
 *
 * Heights are tuned so the primary action (40px) matches the Select input
 * elsewhere in the panel, and the secondary buttons (History/Spending) live
 * at 32px in the parent — giving a consistent two-tier rhythm.
 */
export default function BalanceCard({
  usage,
  loading = false,
  onTopUp,
  onManage,
}: BalanceCardProps): JSX.Element {
  const { language } = useTranslation();
  const plan = usage?.plan ?? 'free';
  const isPro = plan === 'pro';
  const proReset = useProResetLabel(usage, language);

  const creditsIncluded = usage?.credits_included_usd ?? 0;
  const creditsUsed = usage?.credits_used_usd ?? 0;
  const creditsPct = creditsIncluded > 0
    ? Math.min(100, (creditsUsed / creditsIncluded) * 100)
    : 0;

  // Bar stays on-brand until credits actually start draining.
  const barGradient = creditsPct >= 90
    ? 'linear-gradient(90deg, #f87171, #ef4444)'
    : creditsPct >= 75
      ? 'linear-gradient(90deg, #f59e0b, #f97316)'
      : 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)';

  // Free: shorter daily allowance framing; Pro: monthly credits with reset.
  const creditsLabel = isPro
    ? (language === 'ru' ? 'Кредиты плана' : 'Plan credits')
    : (language === 'ru' ? 'Дневной лимит' : 'Daily limit');

  const creditsSubline = isPro
    ? proReset
    : (language === 'ru' ? 'только бюджетные модели' : 'budget models only');

  const balanceUsd = usage?.balance_usd ?? 0;

  // Primary CTA differs by plan: Pro wants top-ups, Free wants upgrades.
  const primaryHandler = isPro ? onTopUp : (onManage ?? onTopUp);
  const primaryLabel = isPro
    ? (language === 'ru' ? 'Пополнить' : 'Top up')
    : (language === 'ru' ? 'Обновить до Pro' : 'Upgrade to Pro');

  return (
    <Box>
      {/* Balance — the single big number, no sub-lines. */}
      <Typography
        sx={{
          fontWeight: 800,
          lineHeight: 1.05,
          fontSize: '1.75rem',
          fontFamily: '"SF Pro Display", -apple-system, system-ui, sans-serif',
          letterSpacing: '-0.02em',
          color: 'text.primary',
          mb: 1.25,
        }}
      >
        {loading ? '—' : formatUsd(balanceUsd)}
      </Typography>

      {/* Plan credits panel — subtle background, no border (the parent already
          frames the whole section so we avoid visual double-borders). */}
      {creditsIncluded > 0 && (
        <Box
          sx={{
            mb: 1.25,
            px: 1.25,
            py: 0.75,
            borderRadius: 1.5,
            bgcolor: 'action.hover',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              mb: 0.5,
              gap: 1,
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontSize: '0.68rem', fontWeight: 600, color: 'text.secondary' }}
            >
              {creditsLabel}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                fontSize: '0.68rem',
                fontWeight: 700,
                color: 'text.primary',
                whiteSpace: 'nowrap',
              }}
            >
              {formatUsd(creditsUsed)} / {formatUsd(creditsIncluded)}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={creditsPct}
            sx={{
              height: 5,
              borderRadius: 3,
              bgcolor: 'rgba(99,102,241,0.12)',
              '& .MuiLinearProgress-bar': {
                borderRadius: 3,
                background: barGradient,
                transition: 'transform 0.8s cubic-bezier(0.4, 0, 0.2, 1)',
              },
            }}
          />
          {creditsSubline && (
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                mt: 0.5,
                fontSize: '0.63rem',
                color: 'text.disabled',
              }}
            >
              {creditsSubline}
            </Typography>
          )}
        </Box>
      )}

      {/* Primary gradient action — full width, 36px — clearly larger than
          the 32px secondary buttons below, but not oversized. */}
      {primaryHandler && (
        <Button
          fullWidth
          variant="contained"
          disableElevation
          onClick={primaryHandler}
          startIcon={
            isPro
              ? <CreditCardIcon sx={{ fontSize: 16 }} />
              : <AutoAwesomeIcon sx={{ fontSize: 16 }} />
          }
          sx={{
            height: 36,
            fontWeight: 700,
            fontSize: '0.8rem',
            textTransform: 'none',
            color: '#fff',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            boxShadow: '0 4px 14px -4px rgba(99,102,241,0.5)',
            '& .MuiButton-startIcon': { mr: 0.75 },
            '&:hover': {
              background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
              boxShadow: '0 6px 18px -4px rgba(99,102,241,0.6)',
            },
          }}
        >
          {primaryLabel}
        </Button>
      )}

    </Box>
  );
}
