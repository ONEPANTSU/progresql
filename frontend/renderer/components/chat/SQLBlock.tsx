import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import {
  ContentCopy as CopyIcon,
  Check as CheckIcon,
  PlayArrow as RunIcon,
  Lightbulb as ExplainIcon,
  FileOpen as ApplyIcon,
  CheckCircleOutline as VerifiedIcon,
  ErrorOutline as InvalidIcon,
  HourglassEmpty as VerifyingIcon,
} from '@mui/icons-material';
import { createLogger } from '../../utils/logger';
import { highlightSQL } from '../../utils/sqlHighlight';
import { useTranslation } from '../../contexts/LanguageContext';

const log = createLogger('SQLBlock');

type VerificationStatus = 'idle' | 'verifying' | 'verified' | 'invalid' | 'skipped';

/** Returns true for DML/DDL statements that should not be verified in safe mode. */
function isDMLStatement(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  const dmlKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
  return dmlKeywords.some((kw) => trimmed.startsWith(kw));
}

interface SQLBlockProps {
  sql: string;
  isTyping?: boolean;
  isAgentConnected?: boolean;
  isDatabaseConnected?: boolean;
  safeMode?: boolean;
  securityMode?: 'safe' | 'data' | 'execute';
  onExplain?: (sql: string) => void;
  onApply?: (sql: string) => void;
  onExecute?: (sql: string) => void;
}

const actionButtonSx = {
  width: 28,
  height: 28,
  borderRadius: '6px',
  color: 'text.secondary',
  '&:hover': {
    bgcolor: 'action.hover',
    color: 'text.primary',
  },
  '& .MuiSvgIcon-root': {
    fontSize: '1rem',
  },
} as const;

const SQLBlock: React.FC<SQLBlockProps> = ({
  sql,
  isTyping = false,
  isAgentConnected = false,
  isDatabaseConnected = false,
  safeMode = true,
  securityMode = 'safe',
  onExplain,
  onApply,
  onExecute,
}) => {
  const { t } = useTranslation();
  const highlightedHTML = useMemo(() => highlightSQL(sql), [sql]);
  const [copied, setCopied] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>('idle');
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const verifiedSqlRef = useRef<string | null>(null);

  useEffect(() => {
    if (isTyping) return;
    if (!isDatabaseConnected) {
      setVerificationStatus('skipped');
      return;
    }
    if (isDMLStatement(sql) || securityMode === 'execute') {
      setVerificationStatus('skipped');
      return;
    }
    if (!sql.trim()) return;
    // Avoid re-verifying the same SQL
    if (verifiedSqlRef.current === sql) return;

    let cancelled = false;
    const verify = async () => {
      setVerificationStatus('verifying');
      setVerificationError(null);
      try {
        const result = await window.electronAPI.executeQuery('', `EXPLAIN ${sql}`);
        if (cancelled) return;
        if (result.success) {
          setVerificationStatus('verified');
        } else {
          setVerificationStatus('invalid');
          setVerificationError(result.message || t('sqlBlock.verifyInvalid'));
        }
        verifiedSqlRef.current = sql;
      } catch (err: unknown) {
        if (cancelled) return;
        setVerificationStatus('invalid');
        const msg = err instanceof Error ? err.message : String(err);
        setVerificationError(msg);
        verifiedSqlRef.current = sql;
      }
    };
    verify();
    return () => { cancelled = true; };
  }, [sql, isDatabaseConnected, safeMode, securityMode, isTyping, t]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      log.error('Failed to copy text:', error);
    }
  };

  return (
    <Box sx={{ my: 1, position: 'relative' }}>
      {/* Copy button — top-right corner of the code block */}
      <Box sx={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}>
        <Tooltip title={copied ? t('sqlBlock.copied') : t('sqlBlock.copySql')}>
          <IconButton
            size="small"
            onClick={handleCopy}
            aria-label={t('sqlBlock.copySql')}
            sx={{
              ...actionButtonSx,
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              opacity: 0.7,
              '&:hover': { ...actionButtonSx['&:hover'], opacity: 1, bgcolor: 'background.paper' },
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
        </Tooltip>
      </Box>
      <Box
        component="pre"
        dangerouslySetInnerHTML={{ __html: highlightedHTML }}
        className="hljs"
        role="code"
        aria-label="SQL code block"
        sx={{
          bgcolor: 'grey.50',
          color: 'text.primary',
          p: 1.5,
          pr: 5,
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'grey.200',
          fontFamily: 'monospace',
          fontSize: '0.8125rem',
          lineHeight: 1.5,
          overflow: 'auto',
          maxHeight: '300px',
          mb: 0,
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
      {/* Verification badge */}
      {verificationStatus !== 'idle' && verificationStatus !== 'skipped' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5, ml: 0.5 }}>
          {verificationStatus === 'verifying' && (
            <>
              <VerifyingIcon sx={{ fontSize: 16, color: 'text.secondary', animation: 'spin 1.5s linear infinite', '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } } }} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('sqlBlock.verifying')}</Typography>
            </>
          )}
          {verificationStatus === 'verified' && (
            <>
              <VerifiedIcon sx={{ fontSize: 16, color: 'success.main' }} />
              <Typography variant="caption" sx={{ color: 'success.main' }}>{t('sqlBlock.verified')}</Typography>
            </>
          )}
          {verificationStatus === 'invalid' && (
            <Tooltip title={verificationError || ''}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'default' }}>
                <InvalidIcon sx={{ fontSize: 16, color: 'error.main' }} />
                <Typography variant="caption" sx={{ color: 'error.main' }}>{t('sqlBlock.verifyInvalid')}</Typography>
              </Box>
            </Tooltip>
          )}
        </Box>
      )}
      {/* Action buttons — bottom row */}
      <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end', mt: 0.5 }}>
        {isAgentConnected && onExplain && (
          <Tooltip title={t('sqlBlock.explainSql')}>
            <IconButton
              size="small"
              onClick={() => onExplain(sql)}
              disabled={isTyping}
              aria-label={t('sqlBlock.explainSql')}
              sx={actionButtonSx}
            >
              <ExplainIcon />
            </IconButton>
          </Tooltip>
        )}
        {onApply && (
          <Tooltip title={t('sqlBlock.applySql')}>
            <IconButton
              size="small"
              onClick={() => onApply(sql)}
              aria-label={t('sqlBlock.applySql')}
              sx={actionButtonSx}
            >
              <ApplyIcon />
            </IconButton>
          </Tooltip>
        )}
        {onExecute && (
          <Tooltip title={t('sqlBlock.executeSql')}>
            <IconButton
              size="small"
              onClick={() => onExecute(sql)}
              aria-label={t('sqlBlock.executeSql')}
              sx={actionButtonSx}
            >
              <RunIcon />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
};

export default SQLBlock;
