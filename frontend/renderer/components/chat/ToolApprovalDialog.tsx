import React, { useMemo } from 'react';
import { Box, Button, Typography, Chip } from '@mui/material';
import {
  WarningAmber as WarningIcon,
  CheckCircle as AcceptIcon,
  Block as DenyIcon,
} from '@mui/icons-material';
import { highlightSQL } from '../../utils/sqlHighlight';
import { useTranslationSafe } from '../../contexts/LanguageContext';

export type SqlDangerLevel = 'ddl' | 'dml' | 'dcl' | 'function_call';

export interface PendingApproval {
  sql: string;
  dangerLevel: SqlDangerLevel;
  resolve: (decision: 'accept_once' | 'accept_always' | 'deny') => void;
}

interface ToolApprovalBannerProps {
  pending: PendingApproval;
}

function dangerLabel(level: SqlDangerLevel): string {
  switch (level) {
    case 'ddl': return 'DDL';
    case 'dml': return 'DML';
    case 'dcl': return 'DCL';
    case 'function_call': return 'Function Call';
  }
}

const ToolApprovalBanner: React.FC<ToolApprovalBannerProps> = ({ pending }) => {
  const { t } = useTranslationSafe();
  const highlightedHTML = useMemo(() => highlightSQL(pending.sql), [pending.sql]);

  return (
    <Box
      sx={{
        mx: 1,
        mb: 1,
        p: 1.5,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'warning.main',
        bgcolor: 'rgba(237, 108, 2, 0.04)',
        animation: 'fadeIn 0.2s ease-in',
        '@keyframes fadeIn': {
          from: { opacity: 0, transform: 'translateY(8px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
        <WarningIcon sx={{ fontSize: 18, color: 'warning.main' }} />
        <Typography variant="body2" sx={{ fontWeight: 600, color: 'warning.main', flex: 1 }}>
          {t('toolApproval.title')}
        </Typography>
        <Chip
          label={dangerLabel(pending.dangerLevel)}
          size="small"
          variant="outlined"
          sx={{
            height: 20,
            fontSize: '0.65rem',
            fontWeight: 600,
            borderColor: 'warning.main',
            color: 'warning.main',
          }}
        />
      </Box>

      {/* Description */}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
        {t(`toolApproval.level.${pending.dangerLevel}` as any)}
      </Typography>

      {/* SQL preview */}
      <Box
        component="pre"
        dangerouslySetInnerHTML={{ __html: highlightedHTML }}
        className="hljs"
        sx={{
          bgcolor: 'grey.50',
          color: 'text.primary',
          p: 1,
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'grey.200',
          fontFamily: 'monospace',
          fontSize: '0.75rem',
          lineHeight: 1.4,
          overflow: 'auto',
          maxHeight: '120px',
          mb: 1,
          '& .hljs-keyword': { color: '#c678dd' },
          '& .hljs-built_in': { color: '#e5c07b' },
          '& .hljs-type': { color: '#e5c07b' },
          '& .hljs-string': { color: '#98c379' },
          '& .hljs-number': { color: '#d19a66' },
          '& .hljs-comment': { color: '#5c6370', fontStyle: 'italic' },
          '& .hljs-operator': { color: '#56b6c2' },
          '& .hljs-punctuation': { color: '#abb2bf' },
          '& .hljs-literal': { color: '#d19a66' },
        }}
      />

      {/* Action buttons */}
      <Box sx={{ display: 'flex', gap: 0.75, justifyContent: 'flex-end' }}>
        <Button
          onClick={() => pending.resolve('deny')}
          startIcon={<DenyIcon sx={{ fontSize: '14px !important' }} />}
          size="small"
          sx={{
            fontSize: '0.7rem',
            textTransform: 'none',
            color: 'error.main',
            borderColor: 'error.main',
            px: 1.5,
            py: 0.25,
            minHeight: 28,
            '&:hover': { bgcolor: 'rgba(211, 47, 47, 0.08)' },
          }}
          variant="outlined"
        >
          {t('toolApproval.deny')}
        </Button>
        <Button
          onClick={() => pending.resolve('accept_once')}
          startIcon={<AcceptIcon sx={{ fontSize: '14px !important' }} />}
          size="small"
          sx={{
            fontSize: '0.7rem',
            textTransform: 'none',
            color: 'warning.main',
            borderColor: 'warning.main',
            px: 1.5,
            py: 0.25,
            minHeight: 28,
            '&:hover': { bgcolor: 'rgba(237, 108, 2, 0.08)' },
          }}
          variant="outlined"
        >
          {t('toolApproval.acceptOnce')}
        </Button>
        <Button
          onClick={() => pending.resolve('accept_always')}
          startIcon={<AcceptIcon sx={{ fontSize: '14px !important' }} />}
          size="small"
          sx={{
            fontSize: '0.7rem',
            textTransform: 'none',
            bgcolor: 'success.main',
            color: '#fff',
            px: 1.5,
            py: 0.25,
            minHeight: 28,
            '&:hover': { bgcolor: 'success.dark' },
          }}
          variant="contained"
        >
          {t('toolApproval.acceptAlways')}
        </Button>
      </Box>
    </Box>
  );
};

export default ToolApprovalBanner;
