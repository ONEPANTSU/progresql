import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Typography,
  Tooltip,
  Collapse,
} from '@mui/material';
import {
  Send as SendIcon,
  Stop as StopIcon,
  Close as CloseIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Code as CodeIcon,
} from '@mui/icons-material';
import { useTranslation } from '../../contexts/LanguageContext';

export interface ChatInputHandle {
  focus: () => void;
}

interface ChatInputProps {
  inputValue: string;
  setInputValue: (value: string) => void;
  isTyping: boolean;
  isConnected: boolean;
  onSendMessage: () => void;
  onStopGeneration?: () => void;
  attachedSQL?: string | null;
  onRemoveAttachment?: () => void;
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  inputValue,
  setInputValue,
  isTyping,
  isConnected,
  onSendMessage,
  onStopGeneration,
  attachedSQL,
  onRemoveAttachment,
}, ref) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useImperativeHandle(ref, () => ({
    focus() {
      inputRef.current?.focus();
    },
  }));

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!isTyping) {
        onSendMessage();
      }
    }
  };

  const placeholder = !isConnected
    ? t('chat.input.backendUnavailable')
    : isTyping
      ? t('chat.input.generating')
      : t('chat.input.placeholder');

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? '⌘' : 'Ctrl';

  const sqlLineCount = attachedSQL ? attachedSQL.split('\n').length : 0;
  const sqlPreview = attachedSQL
    ? attachedSQL.split('\n').slice(0, 3).join('\n') + (sqlLineCount > 3 ? '\n...' : '')
    : '';

  return (
    <Box sx={{
      p: 1.5,
      flexShrink: 0,
      borderTop: 1,
      borderColor: 'divider',
      bgcolor: 'background.paper'
    }}>
      {/* Attached SQL card */}
      {attachedSQL && (
        <Box sx={{
          mb: 1,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          bgcolor: 'action.hover',
          overflow: 'hidden',
        }}>
          <Box sx={{
            display: 'flex',
            alignItems: 'center',
            px: 1,
            py: 0.5,
            gap: 0.75,
            minHeight: 32,
          }}>
            <CodeIcon sx={{ fontSize: '0.875rem', color: 'primary.main' }} />
            <Typography
              variant="caption"
              sx={{
                flexGrow: 1,
                fontWeight: 600,
                fontSize: '0.75rem',
                color: 'text.primary',
              }}
            >
              SQL · {t('chat.input.sqlLines', { count: String(sqlLineCount) })}
            </Typography>
            <IconButton
              size="small"
              onClick={() => setIsExpanded(prev => !prev)}
              aria-label={isExpanded ? 'Collapse SQL' : 'Expand SQL'}
              sx={{ p: 0.25 }}
            >
              {isExpanded ? <ExpandLessIcon sx={{ fontSize: '1rem' }} /> : <ExpandMoreIcon sx={{ fontSize: '1rem' }} />}
            </IconButton>
            <IconButton
              size="small"
              onClick={onRemoveAttachment}
              aria-label="Remove attached SQL"
              sx={{ p: 0.25 }}
            >
              <CloseIcon sx={{ fontSize: '0.875rem' }} />
            </IconButton>
          </Box>
          <Collapse in={isExpanded}>
            <Box sx={{
              px: 1,
              pb: 0.75,
              maxHeight: 200,
              overflow: 'auto',
              '&::-webkit-scrollbar': { width: 4 },
              '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.2)', borderRadius: 2 },
            }}>
              <Typography
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.7rem',
                  lineHeight: 1.4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'text.secondary',
                  m: 0,
                }}
              >
                {attachedSQL}
              </Typography>
            </Box>
          </Collapse>
          {!isExpanded && (
            <Box sx={{ px: 1, pb: 0.5 }}>
              <Typography
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.65rem',
                  lineHeight: 1.3,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'text.disabled',
                  m: 0,
                  overflow: 'hidden',
                  maxHeight: 40,
                }}
              >
                {sqlPreview}
              </Typography>
            </Box>
          )}
        </Box>
      )}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
        <TextField
          fullWidth
          multiline
          maxRows={4}
          placeholder={placeholder}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          inputRef={inputRef}
          size="small"
          inputProps={{ 'aria-label': 'Chat message input' }}
          sx={{
            '& .MuiOutlinedInput-root': {
              borderRadius: 1,
              transition: 'all 0.2s',
              '&:hover': {
                '& fieldset': {
                  borderColor: 'primary.main',
                },
              },
              '&.Mui-focused': {
                '& fieldset': {
                  borderWidth: 2,
                },
              },
            },
          }}
        />
        {isTyping ? (
          <Tooltip title={t('chat.input.stop')}>
            <IconButton
              color="error"
              onClick={onStopGeneration}
              aria-label={t('chat.input.stop')}
              sx={{
                bgcolor: 'error.main',
                color: 'error.contrastText',
                minWidth: 36,
                minHeight: 36,
                borderRadius: 1,
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                '&:hover': {
                  bgcolor: 'error.dark',
                },
              }}
            >
              <StopIcon />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title={`Send (Enter / ${modKey}+Enter)`}>
            <span>
              <IconButton
                color="primary"
                onClick={onSendMessage}
                aria-label={t('chat.input.send')}
                disabled={(!inputValue.trim() && !attachedSQL) || !isConnected}
                sx={{
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  minWidth: 36,
                  minHeight: 36,
                  borderRadius: 1,
                  transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                  '&:hover': {
                    bgcolor: 'primary.dark',
                  },
                  '&:disabled': {
                    bgcolor: 'action.disabledBackground',
                    color: 'action.disabled',
                  },
                }}
              >
                <SendIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
});

export default ChatInput;
