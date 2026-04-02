import React from 'react';
import {
  Box,
  Typography,
  LinearProgress,
  Tooltip,
  Chip,
} from '@mui/material';
import {
  AccountBalance as BalanceIcon,
} from '@mui/icons-material';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import { UsageInfo } from '@/shared/types';

interface QuotaIndicatorProps {
  usage: UsageInfo | null;
  compact?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function getProgressColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 75) return '#f59e0b';
  return '#6366f1';
}

export default function QuotaIndicator({ usage, compact = false }: QuotaIndicatorProps) {
  const { t, language } = useTranslation();

  if (!usage) return null;

  const budgetPct = usage.budget_tokens_limit > 0
    ? Math.min(100, (usage.budget_tokens_used / usage.budget_tokens_limit) * 100)
    : 0;
  const premiumPct = usage.premium_tokens_limit > 0
    ? Math.min(100, (usage.premium_tokens_used / usage.premium_tokens_limit) * 100)
    : 0;

  const planLabels: Record<string, string> = {
    free: 'Free',
    trial: 'Trial',
    pro: 'Pro',
    pro_plus: 'Pro Plus',
    team: 'Team',
  };

  const planColors: Record<string, string> = {
    free: '#94a3b8',
    trial: '#6366f1',
    pro: '#6366f1',
    pro_plus: '#8b5cf6',
    team: '#10b981',
  };

  if (compact) {
    return (
      <Tooltip
        title={
          <Box sx={{ p: 0.5 }}>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {language === 'ru' ? 'Бюджетные' : 'Budget'}: {formatTokens(usage.budget_tokens_used)} / {formatTokens(usage.budget_tokens_limit)}
            </Typography>
            <br />
            {usage.premium_tokens_limit > 0 && (
              <>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  {language === 'ru' ? 'Премиум' : 'Premium'}: {formatTokens(usage.premium_tokens_used)} / {formatTokens(usage.premium_tokens_limit)}
                </Typography>
                <br />
              </>
            )}
            {usage.balance_enabled && (
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                {language === 'ru' ? 'Баланс' : 'Balance'}: {usage.balance.toFixed(0)}₽
              </Typography>
            )}
          </Box>
        }
      >
        <Chip
          size="small"
          label={planLabels[usage.plan] || usage.plan}
          sx={{
            fontWeight: 700,
            fontSize: '0.65rem',
            height: 20,
            color: '#fff',
            bgcolor: planColors[usage.plan] || '#6366f1',
          }}
        />
      </Tooltip>
    );
  }

  return (
    <Box sx={{ width: '100%', p: 1.5 }}>
      {/* Plan badge */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Chip
          size="small"
          label={planLabels[usage.plan] || usage.plan}
          sx={{
            fontWeight: 700,
            fontSize: '0.7rem',
            height: 22,
            color: '#fff',
            bgcolor: planColors[usage.plan] || '#6366f1',
          }}
        />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {usage.period_type === 'daily'
            ? (language === 'ru' ? 'Ежедневно' : 'Daily')
            : (language === 'ru' ? 'Ежемесячно' : 'Monthly')}
        </Typography>
      </Box>

      {/* Budget tokens */}
      <Box sx={{ mb: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
          <Typography variant="caption" sx={{ fontWeight: 500, fontSize: '0.7rem' }}>
            {language === 'ru' ? 'Бюджетные токены' : 'Budget tokens'}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
            {formatTokens(usage.budget_tokens_used)} / {formatTokens(usage.budget_tokens_limit)}
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={budgetPct}
          sx={{
            height: 4,
            borderRadius: 2,
            bgcolor: 'rgba(99,102,241,0.1)',
            '& .MuiLinearProgress-bar': {
              bgcolor: getProgressColor(budgetPct),
              borderRadius: 2,
            },
          }}
        />
      </Box>

      {/* Premium tokens */}
      {usage.premium_tokens_limit > 0 && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
            <Typography variant="caption" sx={{ fontWeight: 500, fontSize: '0.7rem', color: '#f59e0b' }}>
              {language === 'ru' ? 'Премиум токены' : 'Premium tokens'}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
              {formatTokens(usage.premium_tokens_used)} / {formatTokens(usage.premium_tokens_limit)}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={premiumPct}
            sx={{
              height: 4,
              borderRadius: 2,
              bgcolor: 'rgba(245,158,11,0.1)',
              '& .MuiLinearProgress-bar': {
                bgcolor: getProgressColor(premiumPct),
                borderRadius: 2,
              },
            }}
          />
        </Box>
      )}

      {/* Balance */}
      {usage.balance_enabled && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <BalanceIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
          <Typography variant="caption" sx={{ fontWeight: 600, fontSize: '0.7rem' }}>
            {usage.balance.toFixed(0)}₽
          </Typography>
        </Box>
      )}
    </Box>
  );
}
