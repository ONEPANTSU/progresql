import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Typography,
  Tooltip,
  Collapse,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  Send as SendIcon,
  Stop as StopIcon,
  Close as CloseIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Code as CodeIcon,
  Storage as StorageIcon,
  KeyboardArrowDown as ChevronDownIcon,
} from '@mui/icons-material';
import { useTranslation } from '../../contexts/LanguageContext';
import type { DatabaseServer } from '../../types';

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
  activeConnection?: DatabaseServer | null;
  connections?: DatabaseServer[];
  connectionErrors?: Record<string, string>;
  onSwitchConnection?: (connectionId: string) => void;
  chatConnectionId?: string | null;
  hasSentFirstMessage?: boolean;
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
  activeConnection,
  connections = [],
  connectionErrors = {},
  onSwitchConnection,
  chatConnectionId,
  hasSentFirstMessage = false,
}, ref) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [dbMenuAnchor, setDbMenuAnchor] = useState<HTMLElement | null>(null);
  const [showSwitchWarning, setShowSwitchWarning] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);

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

  const handleDbBarClick = (event: React.MouseEvent<HTMLElement>) => {
    if (connections.length > 0) {
      setDbMenuAnchor(event.currentTarget);
    }
  };

  const handleConnectionSelect = (connectionId: string) => {
    setDbMenuAnchor(null);
    if (connectionId === activeConnection?.id) return;

    // If chat already has messages, show warning
    if (hasSentFirstMessage && chatConnectionId && chatConnectionId !== connectionId) {
      setPendingSwitchId(connectionId);
      setShowSwitchWarning(true);
      return;
    }

    onSwitchConnection?.(connectionId);
  };

  const confirmSwitch = () => {
    if (pendingSwitchId) {
      onSwitchConnection?.(pendingSwitchId);
    }
    setShowSwitchWarning(false);
    setPendingSwitchId(null);
  };

  const cancelSwitch = () => {
    setShowSwitchWarning(false);
    setPendingSwitchId(null);
  };

  // Determine which connection to display
  const displayConnection = chatConnectionId
    ? connections.find(c => c.id === chatConnectionId) ?? activeConnection
    : activeConnection;

  const placeholder = !isConnected
    ? t('chat.input.backendUnavailable')
    : isTyping
      ? t('chat.input.generating')
      : t('chat.input.placeholder');

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? '\u2318' : 'Ctrl';

  const sqlLineCount = attachedSQL ? attachedSQL.split('\n').length : 0;
  const sqlPreview = attachedSQL
    ? attachedSQL.split('\n').slice(0, 3).join('\n') + (sqlLineCount > 3 ? '\n...' : '')
    : '';

  const hasError = displayConnection ? !!connectionErrors[displayConnection.id] : false;

  return (
    <Box sx={{
      p: 1.5,
      flexShrink: 0,
      borderTop: 1,
      borderColor: 'divider',
      bgcolor: 'background.paper'
    }}>
      {/* Switch warning banner */}
      {showSwitchWarning && (
        <Box sx={{
          mb: 1,
          p: 1,
          borderRadius: 1,
          bgcolor: 'warning.main',
          color: 'warning.contrastText',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          fontSize: '0.75rem',
        }}>
          <Typography variant="caption" sx={{ flexGrow: 1, color: 'inherit', fontWeight: 500 }}>
            {t('chat.dbPill.switchWarning')}
          </Typography>
          <Box
            component="button"
            onClick={confirmSwitch}
            sx={{
              border: '1px solid',
              borderColor: 'inherit',
              borderRadius: 0.5,
              px: 1,
              py: 0.25,
              bgcolor: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '0.7rem',
              fontWeight: 600,
              '&:hover': { bgcolor: 'rgba(0,0,0,0.1)' },
            }}
          >
            {t('chat.dbPill.switchConfirm')}
          </Box>
          <Box
            component="button"
            onClick={cancelSwitch}
            sx={{
              border: '1px solid',
              borderColor: 'inherit',
              borderRadius: 0.5,
              px: 1,
              py: 0.25,
              bgcolor: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '0.7rem',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.1)' },
            }}
          >
            {t('chat.dbPill.switchCancel')}
          </Box>
        </Box>
      )}
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

      {/* DB selector bar -- above input */}
      <Box
        onClick={handleDbBarClick}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.25,
          py: 0.75,
          mb: 1,
          borderRadius: '8px',
          cursor: connections.length > 0 ? 'pointer' : 'default',
          bgcolor: 'rgba(255,255,255,0.04)',
          border: '1px solid',
          borderColor: 'rgba(255,255,255,0.08)',
          transition: 'all 0.15s ease',
          '&:hover': connections.length > 0 ? {
            bgcolor: 'rgba(255,255,255,0.07)',
            borderColor: 'rgba(99, 102, 241, 0.3)',
          } : {},
        }}
      >
        {/* Status dot */}
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            bgcolor: displayConnection
              ? (hasError ? 'error.main' : 'success.main')
              : 'text.disabled',
            flexShrink: 0,
          }}
        />
        {/* DB icon */}
        <StorageIcon sx={{ fontSize: '0.85rem', color: 'text.secondary', flexShrink: 0 }} />
        {/* Connection name */}
        <Typography
          variant="caption"
          sx={{
            fontSize: '0.75rem',
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexGrow: 1,
          }}
        >
          {displayConnection
            ? (displayConnection.connectionName || displayConnection.database)
            : t('chat.dbPill.noConnection')}
        </Typography>
        {/* Chevron */}
        {connections.length > 0 && (
          <ChevronDownIcon sx={{
            fontSize: '1rem',
            color: 'text.disabled',
            flexShrink: 0,
            transition: 'transform 0.2s',
            transform: dbMenuAnchor ? 'rotate(180deg)' : 'rotate(0deg)',
          }} />
        )}
      </Box>
      <Menu
        anchorEl={dbMenuAnchor}
        open={Boolean(dbMenuAnchor)}
        onClose={() => setDbMenuAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              bgcolor: 'rgba(20, 20, 35, 0.85)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid',
              borderColor: 'rgba(99, 102, 241, 0.4)',
              borderRadius: '12px',
              minWidth: 220,
              maxHeight: 200,
              overflowY: 'auto',
              boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.4), 0 -1px 6px rgba(99, 102, 241, 0.15)',
              '&::-webkit-scrollbar': { width: 4 },
              '&::-webkit-scrollbar-thumb': {
                background: 'rgba(99, 102, 241, 0.3)',
                borderRadius: 2,
              },
              '&::-webkit-scrollbar-track': {
                background: 'transparent',
              },
            },
          },
        }}
      >
        {connections.map((conn) => (
          <MenuItem
            key={conn.id}
            selected={displayConnection?.id === conn.id}
            onClick={() => handleConnectionSelect(conn.id)}
            sx={{
              borderRadius: '8px',
              mx: 0.5,
              my: 0.25,
              '&.Mui-selected': {
                bgcolor: 'rgba(99, 102, 241, 0.15)',
                '&:hover': {
                  bgcolor: 'rgba(99, 102, 241, 0.25)',
                },
              },
              '&:hover': {
                bgcolor: 'rgba(255, 255, 255, 0.06)',
              },
            }}
          >
            <ListItemIcon sx={{ minWidth: '28px !important' }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: conn.isActive
                    ? (connectionErrors[conn.id] ? 'error.main' : 'success.main')
                    : 'text.disabled',
                }}
              />
            </ListItemIcon>
            <ListItemText
              primary={conn.connectionName || conn.database}
              secondary={`${conn.host}:${conn.port}/${conn.database}`}
              primaryTypographyProps={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.9)' }}
              secondaryTypographyProps={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.45)' }}
            />
          </MenuItem>
        ))}
      </Menu>

      {/* Input row */}
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
