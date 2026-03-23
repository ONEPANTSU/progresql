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
  KeyboardArrowRight as ChevronRightIcon,
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
  onSwitchConnection?: (connectionId: string, database?: string) => void;
  chatConnectionId?: string | null;
  chatDatabase?: string | null;
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
  chatDatabase,
  hasSentFirstMessage = false,
}, ref) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [dbMenuAnchor, setDbMenuAnchor] = useState<HTMLElement | null>(null);
  const [expandedConnId, setExpandedConnId] = useState<string | null>(null);

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
      setExpandedConnId(null);
    }
  };

  const handleConnectionClick = (conn: DatabaseServer) => {
    // If connection has multiple databases, toggle expansion
    if (conn.isActive && conn.availableDatabases && conn.availableDatabases.length > 1) {
      setExpandedConnId(prev => prev === conn.id ? null : conn.id);
    } else {
      // Single database or not connected — select directly
      setDbMenuAnchor(null);
      setExpandedConnId(null);
      onSwitchConnection?.(conn.id);
    }
  };

  const handleDatabaseSelect = (connId: string, dbName: string) => {
    setDbMenuAnchor(null);
    setExpandedConnId(null);
    onSwitchConnection?.(connId, dbName);
  };

  // Determine which connection to display
  const displayConnection = chatConnectionId
    ? connections.find(c => c.id === chatConnectionId) ?? activeConnection
    : activeConnection;

  const displayDatabase = chatDatabase
    || displayConnection?.activeDatabase
    || displayConnection?.database;

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

  // Build pill label: "connectionName · database"
  const pillLabel = displayConnection
    ? `${displayConnection.connectionName || displayConnection.host}` +
      (displayDatabase ? ` · ${displayDatabase}` : '')
    : t('chat.dbPill.noConnection');

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

      {/* DB selector pill -- compact, inline above input */}
      <Box
        onClick={handleDbBarClick}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.25,
          mb: 0.5,
          borderRadius: '12px',
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
        <Box
          sx={{
            width: 6,
            height: 6,
            borderRadius: 1,
            bgcolor: displayConnection
              ? (hasError ? 'error.main' : displayConnection.isActive ? 'success.main' : 'text.disabled')
              : 'text.disabled',
            flexShrink: 0,
          }}
        />
        <Typography
          variant="caption"
          sx={{
            fontSize: '0.6875rem',
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 200,
          }}
        >
          {pillLabel}
        </Typography>
        {connections.length > 0 && (
          <ChevronDownIcon sx={{
            fontSize: '0.8rem',
            color: 'text.disabled',
            flexShrink: 0,
            transition: 'transform 0.2s',
            transform: dbMenuAnchor ? 'rotate(180deg)' : 'rotate(0deg)',
          }} />
        )}
      </Box>

      {/* Single unified menu with inline accordion for databases */}
      <Menu
        anchorEl={dbMenuAnchor}
        open={Boolean(dbMenuAnchor)}
        onClose={() => { setDbMenuAnchor(null); setExpandedConnId(null); }}
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
              minWidth: 240,
              maxHeight: 300,
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
        {connections.map((conn) => {
          const hasMultiDb = conn.isActive && conn.availableDatabases && conn.availableDatabases.length > 1;
          const isExpanded = expandedConnId === conn.id;
          const isSelected = displayConnection?.id === conn.id;
          const connActiveDb = conn.activeDatabase || conn.database;

          return (
            <Box key={conn.id}>
              <MenuItem
                selected={isSelected && !hasMultiDb}
                onClick={() => handleConnectionClick(conn)}
                sx={{
                  borderRadius: '8px',
                  mx: 0.5,
                  my: 0.25,
                  '&.Mui-selected': {
                    bgcolor: 'rgba(99, 102, 241, 0.15)',
                    '&:hover': { bgcolor: 'rgba(99, 102, 241, 0.25)' },
                  },
                  '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.06)' },
                }}
              >
                <ListItemIcon sx={{ minWidth: '28px !important' }}>
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: 1,
                      bgcolor: conn.isActive
                        ? (connectionErrors[conn.id] ? 'error.main' : 'success.main')
                        : 'text.disabled',
                    }}
                  />
                </ListItemIcon>
                <ListItemText
                  primary={conn.connectionName || conn.host}
                  secondary={`${conn.host}:${conn.port}`}
                  primaryTypographyProps={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.9)' }}
                  secondaryTypographyProps={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.45)' }}
                />
                {hasMultiDb && (
                  <Box sx={{ display: 'flex', alignItems: 'center', ml: 0.5 }}>
                    <Typography sx={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)', mr: 0.25 }}>
                      {connActiveDb}
                    </Typography>
                    {isExpanded
                      ? <ExpandLessIcon sx={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.4)' }} />
                      : <ChevronRightIcon sx={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.4)' }} />
                    }
                  </Box>
                )}
              </MenuItem>

              {/* Inline database list (accordion) */}
              {hasMultiDb && isExpanded && (
                <Box sx={{ pl: 3, pr: 0.5, pb: 0.5 }}>
                  {conn.availableDatabases!.map((db: any) => {
                    const isActiveDb = db.name === connActiveDb && isSelected;
                    return (
                      <MenuItem
                        key={db.name}
                        selected={isActiveDb}
                        onClick={() => handleDatabaseSelect(conn.id, db.name)}
                        sx={{
                          borderRadius: '6px',
                          mx: 0,
                          my: 0.25,
                          py: 0.5,
                          minHeight: 28,
                          '&.Mui-selected': { bgcolor: 'rgba(76,175,80,0.15)' },
                          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
                        }}
                      >
                        <ListItemIcon sx={{ minWidth: '20px !important' }}>
                          <Box sx={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            bgcolor: isActiveDb ? '#4caf50' : 'rgba(255,255,255,0.25)',
                          }} />
                        </ListItemIcon>
                        <ListItemText
                          primary={db.name}
                          primaryTypographyProps={{
                            fontSize: '0.75rem',
                            color: isActiveDb ? '#4caf50' : 'rgba(255,255,255,0.8)',
                          }}
                        />
                      </MenuItem>
                    );
                  })}
                </Box>
              )}
            </Box>
          );
        })}
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
              onClick={onStopGeneration}
              aria-label={t('chat.input.stop')}
              sx={{
                background: 'linear-gradient(135deg, #b91c1c, #991b1b, #7f1d1d)',
                color: '#fff',
                minWidth: 36,
                minHeight: 36,
                borderRadius: 1,
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                '&:hover': {
                  background: 'linear-gradient(135deg, #991b1b, #7f1d1d, #581c1c)',
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
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: '#fff',
                  minWidth: 36,
                  minHeight: 36,
                  borderRadius: 1,
                  transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                  '&:hover': {
                    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
                  },
                  '&:disabled': {
                    background: 'none',
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
