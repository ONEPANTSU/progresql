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

function formatUsd(n: number): string {
  if (!isFinite(n)) return '$0.00';
  if (Math.abs(n) >= 0.01 || n === 0) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function getProgressColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 75) return '#f59e0b';
  return '#6366f1';
}

export default function QuotaIndicator({ usage, compact = false }: QuotaIndicatorProps) {
  const { language } = useTranslation();

  if (!usage) return null;

  const creditsPct = usage.credits_included_usd > 0
    ? Math.min(100, (usage.credits_used_usd / usage.credits_included_usd) * 100)
    : 0;

  const planLabels: Record<string, string> = {
    free: language === 'ru' ? 'Бесплатный' : 'Free',
    pro: 'Pro',
  };

  const planColors: Record<string, string> = {
    free: '#94a3b8',
    pro: '#6366f1',
  };

  const planLabel = planLabels[usage.plan] || usage.plan;
  const planColor = planColors[usage.plan] || '#6366f1';

  if (compact) {
    return (
      <Tooltip
        title={
          <Box sx={{ p: 0.5 }}>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {language === 'ru' ? 'Кредиты' : 'Credits'}: {formatUsd(usage.credits_used_usd)} / {formatUsd(usage.credits_included_usd)}
            </Typography>
            <br />
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {language === 'ru' ? 'Баланс' : 'Balance'}: {formatUsd(usage.balance_usd)}
            </Typography>
          </Box>
        }
      >
        <Chip
          size="small"
          label={planLabel}
          sx={{
            fontWeight: 700,
            fontSize: '0.65rem',
            height: 20,
            color: '#fff',
            bgcolor: planColor,
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
          label={planLabel}
          sx={{
            fontWeight: 700,
            fontSize: '0.7rem',
            height: 22,
            color: '#fff',
            bgcolor: planColor,
          }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <BalanceIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
          <Typography variant="caption" sx={{ fontWeight: 600, fontSize: '0.75rem' }}>
            {formatUsd(usage.balance_usd)}
          </Typography>
        </Box>
      </Box>

      {/* Included credits progress */}
      {usage.credits_included_usd > 0 && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
            <Typography variant="caption" sx={{ fontWeight: 500, fontSize: '0.7rem' }}>
              {language === 'ru' ? 'Кредиты плана' : 'Plan credits'}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
              {formatUsd(usage.credits_used_usd)} / {formatUsd(usage.credits_included_usd)}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={creditsPct}
            sx={{
              height: 4,
              borderRadius: 2,
              bgcolor: 'rgba(99,102,241,0.1)',
              '& .MuiLinearProgress-bar': {
                bgcolor: getProgressColor(creditsPct),
                borderRadius: 2,
              },
            }}
          />
        </Box>
      )}

      {/* Stats row */}
      <Box sx={{ display: 'flex', gap: 2, mt: 0.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
          {language === 'ru' ? 'Запросов' : 'Requests'}: <strong>{usage.requests_total}</strong>
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
          {language === 'ru' ? 'Всего' : 'Total'}: <strong>{formatUsd(usage.cost_usd_total)}</strong>
        </Typography>
      </Box>
    </Box>
  );
}
