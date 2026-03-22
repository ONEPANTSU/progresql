import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import {
  Avatar,
  Box,
  Paper,
  Typography,
  IconButton,
  List,
  Divider,
  Tooltip,
  Button,
} from '@mui/material';
import { Alert } from '@mui/material';
import {
  AutoAwesome as BotIcon,
  Add as AddIcon,
  Close as CloseIcon,
  Chat as ChatIcon,
  WarningAmber as WarningIcon,
  Settings as SettingsIcon,
  RocketLaunch as UpgradeIcon,
} from '@mui/icons-material';
import { useAgent } from '../contexts/AgentContext';
import { useAuth } from '../providers/AuthProvider';
import { useTranslation } from '../contexts/LanguageContext';
import { getSubscriptionWarning } from '../services/auth';
import { useChat } from '../hooks/useChat';
import { useAgentMessages } from '../hooks/useAgentMessages';
import ChatMessage from './chat/ChatMessage';
import ChatInput, { ChatInputHandle } from './chat/ChatInput';

export interface ChatPanelHandle {
  sendImproveSQL: (sql: string) => void;
  sendExplainSQL: (sql: string) => void;
  sendAnalyzeSchema: () => void;
  focusInput: () => void;
  setInputText: (text: string) => void;
  attachSQL: (sql: string) => void;
}

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onExecuteQuery?: (query: string) => void;
  onApplySQL?: (sql: string) => void;
  isDatabaseConnected?: boolean;
  onOpenSettings?: () => void;
  activeConnection?: import('../types').DatabaseServer | null;
  connections?: import('../types').DatabaseServer[];
  connectionErrors?: Record<string, string>;
  onSwitchConnection?: (connectionId: string) => void;
}

// Typing indicator removed — streaming messages already show content appearing in real-time

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'qwen/qwen3-coder': 'Qwen 3 Coder',
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
  'qwen/qwen3-vl-32b-instruct': 'Qwen 3 VL 32B',
};

function formatModelName(model: string): string {
  if (MODEL_DISPLAY_NAMES[model]) return MODEL_DISPLAY_NAMES[model];
  const parts = model.split('/');
  return parts.length > 1 ? parts[1] : model;
}

const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  { isOpen, onClose, onExecuteQuery, onApplySQL, isDatabaseConnected = false, onOpenSettings, activeConnection, connections = [], connectionErrors = {}, onSwitchConnection },
  ref,
) {
  const agent = useAgent();
  const { user } = useAuth();
  const { t } = useTranslation();
  const subscriptionWarning = getSubscriptionWarning(user);
  const isSubscriptionExpired = subscriptionWarning === 'expired';
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [attachedSQL, setAttachedSQL] = useState<string | null>(null);
  const [trialBannerDismissed, setTrialBannerDismissed] = useState(false);
  const chatInputRef = useRef<ChatInputHandle>(null);

  const chat = useChat(isOpen);
  const agentMessages = useAgentMessages({
    activeChatId: chat.activeChatId,
    setChats: chat.setChats,
    inputValue,
    setInputValue,
    isTyping,
    setIsTyping,
    handleCreateChat: chat.handleCreateChat,
    attachedSQL,
    setAttachedSQL,
    connectionId: chat.activeChat?.connectionId ?? activeConnection?.id ?? null,
  });

  // Stamp active chat with connectionId when it doesn't have one yet
  useEffect(() => {
    if (chat.activeChatId && activeConnection?.id) {
      chat.setChats(prev => prev.map(c =>
        c.id === chat.activeChatId && !c.connectionId
          ? { ...c, connectionId: activeConnection.id }
          : c
      ));
    }
  }, [chat.activeChatId, activeConnection?.id]);

  // Handle switching connection from ChatInput pill
  const handleChatSwitchConnection = useCallback((connectionId: string) => {
    // Update the chat's connectionId
    if (chat.activeChatId) {
      chat.setChats(prev => prev.map(c =>
        c.id === chat.activeChatId
          ? { ...c, connectionId }
          : c
      ));
    }
    // Also switch the actual database connection
    onSwitchConnection?.(connectionId);
  }, [chat.activeChatId, chat.setChats, onSwitchConnection]);

  useImperativeHandle(ref, () => ({
    sendImproveSQL: agentMessages.handleSendImproveSQL,
    sendExplainSQL: agentMessages.handleSendExplainSQL,
    sendAnalyzeSchema: agentMessages.handleSendAnalyzeSchema,
    focusInput() {
      chatInputRef.current?.focus();
    },
    setInputText(text: string) {
      setInputValue(text);
      chatInputRef.current?.focus();
    },
    attachSQL(sql: string) {
      setAttachedSQL(sql);
      chatInputRef.current?.focus();
    },
  }));

  const messages = chat.activeChat?.messages || [];

  if (!isOpen) return null;

  return (
    <Paper role="complementary" aria-label="AI Assistant panel" sx={{ height: '100%', display: 'flex', flexDirection: 'column', borderColor: 'divider', overflow: 'hidden', position: 'relative' }}>
      {/* Header */}
      <Box sx={{ borderBottom: '1px solid', borderColor: 'rgba(255,255,255,0.08)' }}>
        <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Avatar sx={{ width: 28, height: 28, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
            <BotIcon sx={{ fontSize: '1rem', color: '#fff' }} />
          </Avatar>
          <Typography variant="subtitle1" sx={{ flexGrow: 1, fontWeight: 600 }}>{t('chat.title')}</Typography>
          {!agent.safeMode && (
            <Tooltip title={t('settings.unsafeWarning')}>
              <WarningIcon sx={{ fontSize: 20, color: 'warning.main', cursor: 'default' }} aria-label="Unsafe mode active" />
            </Tooltip>
          )}
          {onOpenSettings && (<Tooltip title={t('chat.settings')}><IconButton size="small" onClick={onOpenSettings} aria-label="Open settings"><SettingsIcon /></IconButton></Tooltip>)}
        </Box>

        {/* Tabs — unified style matching query tabs */}
        <Box sx={{ borderBottom: '1px solid', borderColor: 'rgba(255,255,255,0.08)', bgcolor: 'background.default', display: 'flex', alignItems: 'center' }}>
          <Box ref={chat.tabsContainerRef} role="tablist" aria-label={t('chat.scrollTabs')} onWheel={(e) => { if (Math.abs(e.deltaX) < Math.abs(e.deltaY) && chat.tabsContainerRef.current) { chat.tabsContainerRef.current.scrollLeft += e.deltaY; } }} sx={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            overflowX: 'auto',
            overflowY: 'hidden',
            minHeight: 32,
            scrollBehavior: 'smooth',
            '&::-webkit-scrollbar': { height: 4 },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.15)', borderRadius: 2 },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
          }}>
            {chat.chats.map((c) => {
              const isActive = chat.activeChatId === c.id;
              return (
                <Box
                  key={c.id}
                  data-chat-id={c.id}
                  role="tab"
                  aria-selected={isActive}
                  aria-label={`Chat: ${c.title}`}
                  tabIndex={0}
                  onClick={() => chat.setActiveChatId(c.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chat.setActiveChatId(c.id); } }}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1.5,
                    py: 0.5,
                    cursor: 'pointer',
                    borderRight: '1px solid',
                    borderColor: 'rgba(255,255,255,0.08)',
                    minWidth: 'fit-content',
                    maxWidth: 180,
                    whiteSpace: 'nowrap',
                    bgcolor: isActive ? 'background.paper' : 'transparent',
                    borderBottom: isActive ? '2px solid' : '2px solid transparent',
                    borderBottomColor: isActive ? 'primary.main' : 'transparent',
                    transition: 'background-color 0.15s',
                    '&:hover': {
                      bgcolor: isActive ? 'background.paper' : 'action.hover',
                    },
                  }}
                >
                  <ChatIcon sx={{ fontSize: 14, opacity: isActive ? 1 : 0.7, color: isActive ? 'text.primary' : 'text.secondary' }} />
                  <Typography
                    variant="caption"
                    sx={{
                      flexGrow: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: '0.75rem',
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? 'text.primary' : 'text.secondary',
                    }}
                  >
                    {c.title}
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); chat.handleDeleteChat(c.id); }}
                    aria-label={`Close chat: ${c.title}`}
                    sx={{
                      p: '1px',
                      opacity: isActive ? 0.7 : 0,
                      '&:hover': { opacity: 1 },
                      '.MuiBox-root:hover > &': { opacity: 0.5 },
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Box>
              );
            })}
            <Tooltip title={t('chat.newChat')}>
              <IconButton
                size="small"
                onClick={() => chat.handleCreateChat()}
                aria-label="Create new chat"
                sx={{ mx: 0.5, p: '3px', flexShrink: 0 }}
              >
                <AddIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      {/* Banners */}
      {agent.connectionState === 'disconnected' && (<Alert severity="error" icon={<WarningIcon />} sx={{ mx: 1, mt: 1, flexShrink: 0 }}>{t('chat.backendUnavailable')}</Alert>)}
      {agent.isConnected && !isDatabaseConnected && (<Alert severity="info" sx={{ mx: 1, mt: 1, flexShrink: 0 }}>{t('chat.dbNotConnected')}</Alert>)}
      {!trialBannerDismissed && subscriptionWarning === 'expiring_soon' && (() => {
        const expiryDate = user?.trialEndsAt || user?.planExpiresAt;
        const days = expiryDate ? Math.max(0, Math.ceil((new Date(expiryDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : 0;
        return (
          <Alert severity="warning" icon={<WarningIcon />} sx={{ mx: 1, mt: 1, flexShrink: 0 }}
            action={
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {onOpenSettings && <Button color="warning" size="small" onClick={onOpenSettings}>{t('subscription.upgradeButton')}</Button>}
                <IconButton size="small" color="warning" onClick={() => setTrialBannerDismissed(true)}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            }
          >{t('subscription.expiringSoon', { days })}</Alert>
        );
      })()}
      {isSubscriptionExpired && !trialBannerDismissed && (
        <Alert severity="error" icon={<UpgradeIcon />} sx={{ mx: 1, mt: 1, flexShrink: 0 }}
          onClose={() => setTrialBannerDismissed(true)}
          action={onOpenSettings && <Button color="error" size="small" variant="outlined" onClick={onOpenSettings}>{t('subscription.upgradeButton')}</Button>}
        >{t('subscription.expired')}</Alert>
      )}

      {/* Messages */}
      <Box sx={{ flexGrow: 1, overflow: 'auto', p: 0.75, display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0 }}>
        {isSubscriptionExpired && !trialBannerDismissed ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', p: 3 }}>
            <UpgradeIcon sx={{ fontSize: 36, color: 'text.secondary', mb: 2 }} />
            <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 2 }}>{t('subscription.chatBlocked')}</Typography>
            {onOpenSettings && (
              <Button variant="contained" color="primary" size="small" startIcon={<UpgradeIcon />} onClick={onOpenSettings}>
                {t('subscription.upgradeButton')}
              </Button>
            )}
          </Box>
        ) : messages.length === 0 ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', p: 3 }}>
            <BotIcon sx={{ fontSize: 36, color: 'text.secondary', mb: 2 }} />
            <Typography variant="body2" color="text.secondary" align="center">{t('chat.emptyState')}</Typography>
          </Box>
        ) : (
          <List sx={{ p: 0 }}>
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} isTyping={isTyping} isAgentConnected={agent.isConnected} isDatabaseConnected={isDatabaseConnected} safeMode={agent.safeMode} onExplainSQL={agentMessages.handleSendExplainSQL} onApplySQL={onApplySQL} onExecuteQuery={onExecuteQuery} />
            ))}
          </List>
        )}
        {/* Typing indicator removed — streaming shows content in real-time */}
        <div ref={chat.messagesEndRef} />
      </Box>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />
      {(!isSubscriptionExpired || trialBannerDismissed) && (
        <ChatInput ref={chatInputRef} inputValue={inputValue} setInputValue={setInputValue} isTyping={isTyping} isConnected={agent.isConnected} onSendMessage={agentMessages.handleSendMessage} onStopGeneration={agentMessages.stopGeneration} attachedSQL={attachedSQL} onRemoveAttachment={() => setAttachedSQL(null)} activeConnection={activeConnection} connections={connections} connectionErrors={connectionErrors} onSwitchConnection={handleChatSwitchConnection} chatConnectionId={chat.activeChat?.connectionId ?? null} hasSentFirstMessage={chat.activeChat?.hasSentFirstMessage ?? false} />
      )}
    </Paper>
  );
});

export default ChatPanel;
