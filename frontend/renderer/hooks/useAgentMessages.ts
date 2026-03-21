import { useCallback, useRef } from 'react';
import { Chat, Message } from '../types';
import { useNotifications } from '../contexts/NotificationContext';
import { useAgent } from '../contexts/AgentContext';
import { useTranslation } from '../contexts/LanguageContext';
import { AgentResponsePayload, AgentRequestPayload } from '../services/agent/AgentService';
import { useStreamingMessage } from './useStreamingMessage';
import { createLogger } from '../utils/logger';
import { getDescriptionsForContext } from '../utils/descriptionStorage';
import type { TranslationKey } from '../locales/en';

const log = createLogger('useAgentMessages');

type TFunction = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * Maps agent error codes to user-friendly messages.
 * Raw technical errors are never shown to the user.
 */
function getUserFriendlyError(error: { code: string; message: string }, t: TFunction): string {
  switch (error.code) {
    case 'db_not_connected':
      return t('agentError.dbNotConnected');
    case 'tool_timeout':
      return t('agentError.toolTimeout');
    case 'llm_error':
      return t('agentError.llmError');
    case 'sql_blocked':
      return t('agentError.sqlBlocked');
    case 'rate_limited':
      return t('agentError.rateLimited');
    case 'invalid_request':
      return t('agentError.invalidRequest');
    case 'disconnected':
    case 'not_connected':
    case 'connection_lost':
      return t('agentError.connectionLost');
    case 'not_initialized':
      return t('agentError.notInitialized');
    case 'subscription_expired':
      return t('agentError.subscriptionExpired');
    default:
      log.warn('Unknown agent error code:', error.code, error.message);
      return t('agentError.unknown');
  }
}

function formatQueryResultAsTable(data: any, t: TFunction): string {
  if (!data) return '';
  // Handle error case
  if (data.error) return `\n**${t('agentError.queryExecution')}**`;
  // Expect { columns: string[], rows: any[][] } or { rows: object[] }
  let columns: string[] = data.columns || [];
  let rows: any[][] = [];

  if (Array.isArray(data.rows) && data.rows.length > 0) {
    if (Array.isArray(data.rows[0])) {
      rows = data.rows;
    } else if (typeof data.rows[0] === 'object') {
      // Array of objects
      if (columns.length === 0) {
        columns = Object.keys(data.rows[0]);
      }
      rows = data.rows.map((row: any) => columns.map(col => row[col]));
    }
  }

  if (columns.length === 0 || rows.length === 0) {
    // Fallback: just show as JSON
    return '\n```json\n' + JSON.stringify(data, null, 2) + '\n```';
  }

  // Build markdown table
  const header = '| ' + columns.join(' | ') + ' |';
  const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const bodyRows = rows.slice(0, 50).map(
    row => '| ' + row.map(cell => String(cell ?? 'NULL')).join(' | ') + ' |'
  );

  let table = '\n' + [header, separator, ...bodyRows].join('\n');
  if (rows.length > 50) {
    const remainingCount = rows.length - 50;
    table += `\n\n*${t('misc.moreRows', { count: String(remainingCount) })}*`;
  }
  return table;
}

function formatAgentResponse(response: AgentResponsePayload, t: TFunction): string {
  const parts: string[] = [];

  if (response.result.explanation) {
    parts.push(response.result.explanation);
  }

  // Only show SQL if there are no query results (i.e. the query wasn't auto-executed).
  // When results exist, the LLM summary already covers the explanation.
  if (response.result.sql && !response.result.query_result) {
    if (!response.result.explanation || !response.result.explanation.includes('```sql')) {
      parts.push('\n```sql\n' + response.result.sql + '\n```');
    }
  }

  // Show validation error annotation when SQL failed EXPLAIN validation after retries.
  if (response.result.validation_error) {
    parts.push('\n> ⚠️ ' + t('agentError.validationFailed') + ': ' + response.result.validation_error);
  }

  // Candidates are internal — do not expose to the user.

  return parts.join('\n') || t('misc.responseReceived');
}

export interface UseAgentMessagesReturn {
  isTyping: boolean;
  setIsTyping: (v: boolean) => void;
  sendViaAgent: (text: string, chatId: string, botMessageId: string) => void;
  sendImproveViaAgent: (sqlText: string, chatId: string, botMessageId: string) => void;
  sendExplainViaAgent: (sqlText: string, chatId: string, botMessageId: string) => void;
  sendAnalyzeViaAgent: (chatId: string, botMessageId: string) => void;
  handleSendImproveSQL: (sql: string) => void;
  handleSendExplainSQL: (sql: string) => void;
  handleSendAnalyzeSchema: () => void;
  handleSendMessage: () => void;
  stopGeneration: () => void;
}

interface UseAgentMessagesArgs {
  activeChatId: string | null;
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
  inputValue: string;
  setInputValue: (v: string) => void;
  isTyping: boolean;
  setIsTyping: (v: boolean) => void;
  handleCreateChat: () => string;
  attachedSQL?: string | null;
  setAttachedSQL?: (v: string | null) => void;
  connectionId?: string | null;
}

export function useAgentMessages({
  activeChatId,
  setChats,
  inputValue,
  setInputValue,
  isTyping,
  setIsTyping,
  handleCreateChat,
  attachedSQL,
  setAttachedSQL,
  connectionId,
}: UseAgentMessagesArgs): UseAgentMessagesReturn {
  const { showError } = useNotifications();
  const agent = useAgent();
  const streaming = useStreamingMessage({ setChats });
  const { t, language } = useTranslation();
  const activeRequestIdRef = useRef<string | null>(null);

  const stopGeneration = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;

    agent.cancelRequest(requestId);
    activeRequestIdRef.current = null;

    // Keep partial text, append " · stopped" marker.
    const partialText = streaming.textRef.current;
    const stoppedText = partialText
      ? partialText + ' · stopped'
      : '· stopped';
    streaming.finishStreaming(stoppedText);
    setIsTyping(false);
  }, [agent, streaming, setIsTyping]);

  const addPlaceholderAndSend = useCallback(
    (
      chatId: string,
      botMessageId: string,
      payload: AgentRequestPayload,
    ) => {
      streaming.startStreaming(chatId, botMessageId);

      const placeholderMessage: Message = {
        id: botMessageId,
        text: '',
        sender: 'bot',
        timestamp: new Date(),
        isStreaming: true,
      };

      setChats(prev => prev.map(chat =>
        chat.id === chatId
          ? { ...chat, messages: [...chat.messages, placeholderMessage], updatedAt: new Date() }
          : chat
      ));

      const userDescs = getDescriptionsForContext();
      const enrichedPayload: AgentRequestPayload = {
        ...payload,
        context: {
          ...payload.context,
          ...(userDescs ? { user_descriptions: userDescs } : {}),
          safe_mode: agent.safeMode,
          language: language,
          ...(connectionId ? { connection_id: connectionId } : {}),
        },
      };

      const requestId = agent.sendRequest(enrichedPayload, {
        onStream: (delta: string) => {
          streaming.appendDelta(delta);
        },
        onResponse: (response: AgentResponsePayload) => {
          activeRequestIdRef.current = null;
          const finalText = formatAgentResponse(response, t);
          const viz = response.result.visualization;
          streaming.finishStreaming(finalText, viz ? {
            chart_type: viz.chart_type,
            title: viz.title,
            data: viz.data as Record<string, unknown>[],
            x_label: viz.x_label,
            y_label: viz.y_label,
            sql: viz.sql,
          } : undefined);
          setIsTyping(false);
        },
        onError: (error) => {
          activeRequestIdRef.current = null;
          // If cancelled, the stopGeneration handler already finalized the message.
          if (error.code === 'cancelled') {
            return;
          }
          log.error('Agent error:', error.code, error.message);
          const friendlyText = getUserFriendlyError(error, t);
          streaming.cancelStreaming(friendlyText);
          setIsTyping(false);
          if (showError) {
            showError(friendlyText);
          }
        },
      });
      activeRequestIdRef.current = requestId;
    },
    [agent, setChats, setIsTyping, showError, streaming, t],
  );

  const sendViaAgent = useCallback(
    (text: string, chatId: string, botMessageId: string) => {
      addPlaceholderAndSend(chatId, botMessageId, {
        action: 'generate_sql',
        user_message: text,
      });
      // Update title on response
      const originalOnResponse = undefined; // handled inside addPlaceholderAndSend
      // We need a post-response hook to rename chat title
      // This is handled by wrapping addPlaceholderAndSend for generate_sql
      // Actually, let's set title in a separate effect or inline
      setChats(prev => prev.map(chat =>
        chat.id === chatId && chat.title.startsWith('Chat ')
          ? { ...chat, title: text.substring(0, 30) || chat.title }
          : chat
      ));
    },
    [addPlaceholderAndSend, setChats],
  );

  const sendImproveViaAgent = useCallback(
    (sqlText: string, chatId: string, botMessageId: string) => {
      addPlaceholderAndSend(chatId, botMessageId, {
        action: 'improve_sql',
        context: { selected_sql: sqlText },
      });
    },
    [addPlaceholderAndSend],
  );

  const sendExplainViaAgent = useCallback(
    (sqlText: string, chatId: string, botMessageId: string) => {
      addPlaceholderAndSend(chatId, botMessageId, {
        action: 'explain_sql',
        context: { selected_sql: sqlText },
      });
    },
    [addPlaceholderAndSend],
  );

  const sendAnalyzeViaAgent = useCallback(
    (chatId: string, botMessageId: string) => {
      addPlaceholderAndSend(chatId, botMessageId, {
        action: 'analyze_schema',
      });
    },
    [addPlaceholderAndSend],
  );

  const ensureChatExists = useCallback(
    (defaultTitle: string): string => {
      if (activeChatId) return activeChatId;
      return handleCreateChat();
    },
    [activeChatId, handleCreateChat],
  );

  const addUserMessageAndSend = useCallback(
    (
      chatId: string,
      userText: string,
      sendFn: (chatId: string, botMessageId: string) => void,
    ) => {
      const userMessage: Message = {
        id: Date.now().toString(),
        text: userText,
        sender: 'user',
        timestamp: new Date(),
      };

      setChats(prev => prev.map(chat =>
        chat.id === chatId
          ? {
              ...chat,
              messages: [...chat.messages, userMessage],
              hasSentFirstMessage: true,
              updatedAt: new Date(),
            }
          : chat
      ));

      setIsTyping(true);
      const botMessageId = (Date.now() + 1).toString();
      sendFn(chatId, botMessageId);
    },
    [setChats, setIsTyping],
  );

  const handleSendImproveSQL = useCallback(
    (sql: string) => {
      if (!agent.isConnected || !sql.trim()) return;
      const chatId = ensureChatExists('Improve SQL');
      addUserMessageAndSend(
        chatId,
        `Improve SQL:\n\`\`\`sql\n${sql}\n\`\`\``,
        (cId, bId) => sendImproveViaAgent(sql, cId, bId),
      );
    },
    [agent.isConnected, ensureChatExists, addUserMessageAndSend, sendImproveViaAgent],
  );

  const handleSendExplainSQL = useCallback(
    (sql: string) => {
      if (!agent.isConnected || !sql.trim()) return;
      const chatId = ensureChatExists('Explain SQL');
      addUserMessageAndSend(
        chatId,
        `Explain SQL:\n\`\`\`sql\n${sql}\n\`\`\``,
        (cId, bId) => sendExplainViaAgent(sql, cId, bId),
      );
    },
    [agent.isConnected, ensureChatExists, addUserMessageAndSend, sendExplainViaAgent],
  );

  const handleSendAnalyzeSchema = useCallback(
    () => {
      if (!agent.isConnected) return;
      const chatId = ensureChatExists('Analyze Schema');
      addUserMessageAndSend(
        chatId,
        '/analyze',
        (cId, bId) => sendAnalyzeViaAgent(cId, bId),
      );
    },
    [agent.isConnected, ensureChatExists, addUserMessageAndSend, sendAnalyzeViaAgent],
  );

  const handleSendMessage = useCallback(() => {
    const hasText = inputValue.trim().length > 0;
    const hasAttachment = !!attachedSQL;
    if (!hasText && !hasAttachment) return;

    if (!agent.isConnected) {
      if (showError) {
        showError(t('agentError.backendUnavailable'));
      }
      return;
    }

    const text = inputValue.trim();
    // Auto-create chat if no active chat exists
    const chatId = activeChatId || handleCreateChat();
    setInputValue('');
    const currentAttachedSQL = attachedSQL;
    if (setAttachedSQL) setAttachedSQL(null);

    // Parse slash commands (only when no attachment)
    if (!currentAttachedSQL) {
      const explainMatch = text.match(/^\/explain\s+([\s\S]+)/i);
      const analyzeMatch = text.match(/^\/analyze\s*$/i);

      if (explainMatch) {
        const sql = explainMatch[1].trim();
        if (!sql) return;
        handleSendExplainSQL(sql);
        return;
      }

      if (analyzeMatch) {
        handleSendAnalyzeSchema();
        return;
      }
    }

    setIsTyping(true);

    // Build display text for user message
    const displayText = currentAttachedSQL
      ? (text ? `${text}\n\n\`\`\`sql\n${currentAttachedSQL}\n\`\`\`` : `\`\`\`sql\n${currentAttachedSQL}\n\`\`\``)
      : text;

    // Build the actual message to send to the agent
    const agentText = currentAttachedSQL
      ? (text ? `${text}\n\nSQL:\n${currentAttachedSQL}` : currentAttachedSQL)
      : text;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: displayText,
      sender: 'user',
      timestamp: new Date(),
    };

    setChats(prev => prev.map(chat =>
      chat.id === chatId
        ? {
            ...chat,
            messages: [...chat.messages, userMessage],
            hasSentFirstMessage: true,
            updatedAt: new Date(),
          }
        : chat
    ));

    try {
      const botMessageId = (Date.now() + 1).toString();
      sendViaAgent(agentText, chatId, botMessageId);
    } catch (error) {
      log.error('Failed to send message:', error);
      setIsTyping(false);

      const friendlyText = t('agentError.sendFailed');
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: friendlyText,
        sender: 'bot',
        timestamp: new Date(),
      };

      setChats(prev => prev.map(chat =>
        chat.id === chatId
          ? { ...chat, messages: [...chat.messages, errorMessage] }
          : chat
      ));

      if (showError) {
        showError(friendlyText);
      }
    }
  }, [
    inputValue, activeChatId, agent.isConnected, showError, attachedSQL,
    setInputValue, setIsTyping, setChats, sendViaAgent, setAttachedSQL,
    handleSendExplainSQL, handleSendAnalyzeSchema, handleCreateChat, t,
  ]);

  return {
    isTyping,
    setIsTyping,
    sendViaAgent,
    sendImproveViaAgent,
    sendExplainViaAgent,
    sendAnalyzeViaAgent,
    handleSendImproveSQL,
    handleSendExplainSQL,
    handleSendAnalyzeSchema,
    handleSendMessage,
    stopGeneration,
  };
}
