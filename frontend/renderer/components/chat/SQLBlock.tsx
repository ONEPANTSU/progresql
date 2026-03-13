import React, { useMemo, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import {
  ContentCopy as CopyIcon,
  Check as CheckIcon,
  PlayArrow as RunIcon,
  Lightbulb as ExplainIcon,
  FileOpen as ApplyIcon,
} from '@mui/icons-material';
import { createLogger } from '../../utils/logger';
import { highlightSQL } from '../../utils/sqlHighlight';
import { useTranslation } from '../../contexts/LanguageContext';

const log = createLogger('SQLBlock');

interface SQLBlockProps {
  sql: string;
  isTyping?: boolean;
  isAgentConnected?: boolean;
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
  onExplain,
  onApply,
  onExecute,
}) => {
  const { t } = useTranslation();
  const highlightedHTML = useMemo(() => highlightSQL(sql), [sql]);
  const [copied, setCopied] = useState(false);

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
