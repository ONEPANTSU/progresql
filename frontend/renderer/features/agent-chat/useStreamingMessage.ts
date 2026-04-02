import { useRef, useCallback } from 'react';
import { Chat, MessageVisualization } from '@/shared/types';

/**
 * Hook that batches agent.stream deltas via requestAnimationFrame
 * to prevent excessive re-renders during fast LLM streaming.
 *
 * Instead of calling setChats() on every delta (which causes a full
 * React tree re-render + markdown parsing), this hook:
 * 1. Accumulates deltas in a ref (zero re-renders)
 * 2. Flushes accumulated text to state once per animation frame (~16ms)
 * 3. Marks message as `isStreaming: true` during stream for plain-text rendering
 */

export interface StreamingMessageState {
  /** Accumulated text ref — always holds the latest full text */
  textRef: React.MutableRefObject<string>;
  /** Start a new streaming session for a message */
  startStreaming: (chatId: string, messageId: string) => void;
  /** Append a delta chunk — batched via rAF */
  appendDelta: (delta: string) => void;
  /** Finalize streaming — flush final text, mark message as not streaming */
  finishStreaming: (finalText: string, visualization?: MessageVisualization) => void;
  /** Cancel streaming (on error) */
  cancelStreaming: (errorText: string) => void;
}

interface UseStreamingMessageArgs {
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
}

export function useStreamingMessage({ setChats }: UseStreamingMessageArgs): StreamingMessageState {
  const textRef = useRef<string>('');
  const rafIdRef = useRef<number | null>(null);
  const chatIdRef = useRef<string>('');
  const messageIdRef = useRef<string>('');

  const flushToState = useCallback(() => {
    const currentText = textRef.current;
    const chatId = chatIdRef.current;
    const messageId = messageIdRef.current;
    if (!chatId || !messageId) return;

    setChats(prev => prev.map(chat =>
      chat.id === chatId
        ? {
            ...chat,
            messages: chat.messages.map(m =>
              m.id === messageId ? { ...m, text: currentText, isStreaming: true } : m
            ),
          }
        : chat
    ));
    rafIdRef.current = null;
  }, [setChats]);

  const startStreaming = useCallback((chatId: string, messageId: string) => {
    textRef.current = '';
    chatIdRef.current = chatId;
    messageIdRef.current = messageId;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const appendDelta = useCallback((delta: string) => {
    textRef.current += delta;
    // Schedule a flush on the next animation frame if one isn't pending
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushToState);
    }
  }, [flushToState]);

  const finishStreaming = useCallback((finalText: string, visualization?: MessageVisualization) => {
    // Cancel any pending rAF
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const chatId = chatIdRef.current;
    const messageId = messageIdRef.current;
    if (!chatId || !messageId) return;

    // Final update: set text and mark streaming complete
    setChats(prev => prev.map(chat =>
      chat.id === chatId
        ? {
            ...chat,
            messages: chat.messages.map(m =>
              m.id === messageId
                ? { ...m, text: finalText, isStreaming: false, ...(visualization ? { visualization } : {}) }
                : m
            ),
          }
        : chat
    ));

    chatIdRef.current = '';
    messageIdRef.current = '';
  }, [setChats]);

  const cancelStreaming = useCallback((errorText: string) => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const chatId = chatIdRef.current;
    const messageId = messageIdRef.current;
    if (!chatId || !messageId) return;

    setChats(prev => prev.map(chat =>
      chat.id === chatId
        ? {
            ...chat,
            messages: chat.messages.map(m =>
              m.id === messageId ? { ...m, text: errorText, isStreaming: false } : m
            ),
          }
        : chat
    ));

    chatIdRef.current = '';
    messageIdRef.current = '';
  }, [setChats]);

  return {
    textRef,
    startStreaming,
    appendDelta,
    finishStreaming,
    cancelStreaming,
  };
}
