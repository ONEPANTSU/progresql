import React, { useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Chip,
} from '@mui/material';
import {
  WarningAmber as WarningIcon,
  CheckCircle as AcceptIcon,
  Block as DenyIcon,
} from '@mui/icons-material';
import { highlightSQL } from '../../utils/sqlHighlight';
import { useTranslation } from '../../contexts/LanguageContext';

export type SqlDangerLevel = 'ddl' | 'dml' | 'dcl' | 'function_call';

export interface PendingApproval {
  sql: string;
  dangerLevel: SqlDangerLevel;
  resolve: (decision: 'accept_once' | 'accept_always' | 'deny') => void;
}

interface ToolApprovalDialogProps {
  pending: PendingApproval | null;
}

/** Classify SQL danger level label */
function dangerLabel(level: SqlDangerLevel): string {
  switch (level) {
    case 'ddl': return 'DDL';
    case 'dml': return 'DML';
    case 'dcl': return 'DCL';
    case 'function_call': return 'Function Call';
  }
}

function dangerColor(level: SqlDangerLevel): 'error' | 'warning' {
  switch (level) {
    case 'ddl': return 'error';
    case 'dml': return 'error';
    case 'dcl': return 'error';
    case 'function_call': return 'warning';
  }
}

const ToolApprovalDialog: React.FC<ToolApprovalDialogProps> = ({ pending }) => {
  const { t } = useTranslation();
  const highlightedHTML = useMemo(
    () => (pending ? highlightSQL(pending.sql) : ''),
    [pending?.sql],
  );

  if (!pending) return null;

  return (
    <Dialog
      open
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2,
          border: '1px solid',
          borderColor: 'warning.main',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          pb: 1,
        }}
      >
        <WarningIcon sx={{ color: 'warning.main' }} />
        <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
          {t('toolApproval.title')}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5, color: 'text.secondary' }}>
          {t('toolApproval.description')}
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Chip
            label={dangerLabel(pending.dangerLevel)}
            color={dangerColor(pending.dangerLevel)}
            size="small"
            variant="outlined"
          />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t(`toolApproval.level.${pending.dangerLevel}` as any)}
          </Typography>
        </Box>

        <Box
          component="pre"
          dangerouslySetInnerHTML={{ __html: highlightedHTML }}
          className="hljs"
          sx={{
            bgcolor: 'grey.50',
            color: 'text.primary',
            p: 1.5,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'grey.200',
            fontFamily: 'monospace',
            fontSize: '0.8125rem',
            lineHeight: 1.5,
            overflow: 'auto',
            maxHeight: '200px',
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
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Button
          onClick={() => pending.resolve('deny')}
          startIcon={<DenyIcon />}
          color="error"
          variant="outlined"
          size="small"
        >
          {t('toolApproval.deny')}
        </Button>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            onClick={() => pending.resolve('accept_once')}
            startIcon={<AcceptIcon />}
            color="warning"
            variant="outlined"
            size="small"
          >
            {t('toolApproval.acceptOnce')}
          </Button>
          <Button
            onClick={() => pending.resolve('accept_always')}
            startIcon={<AcceptIcon />}
            color="success"
            variant="contained"
            size="small"
          >
            {t('toolApproval.acceptAlways')}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};

export default ToolApprovalDialog;
