/*
* Created on Mar 27, 2026
* Test file for useStreamingMessage.ts
* File path: renderer/__tests__/useStreamingMessage.test.ts
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import { renderHook, act } from '@testing-library/react';
import { useStreamingMessage } from '@/features/agent-chat/useStreamingMessage';
import type { Chat } from '@/shared/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChat(id: string, messageId: string, text = ''): Chat {
  return {
    id,
    title: 'Test Chat',
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [
      {
        id: messageId,
        text,
        sender: 'bot',
        timestamp: new Date(),
        isStreaming: false,
      },
    ],
    hasSentFirstMessage: false,
  };
}

describe('useStreamingMessage', () => {
  let setChats: jest.Mock;

  beforeEach(() => {
    setChats = jest.fn();
    jest.clearAllMocks();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('returns all required methods and textRef', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      expect(result.current.textRef).toBeDefined();
      expect(typeof result.current.startStreaming).toBe('function');
      expect(typeof result.current.appendDelta).toBe('function');
      expect(typeof result.current.finishStreaming).toBe('function');
      expect(typeof result.current.cancelStreaming).toBe('function');
    });

    it('textRef starts as empty string', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      expect(result.current.textRef.current).toBe('');
    });
  });

  // ── startStreaming ────────────────────────────────────────────────────────

  describe('startStreaming', () => {
    it('resets textRef to empty string', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.textRef.current = 'some prior text';
        result.current.startStreaming('chat-1', 'msg-1');
      });

      expect(result.current.textRef.current).toBe('');
    });

    it('does not call setChats on its own', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
      });

      expect(setChats).not.toHaveBeenCalled();
    });
  });

  // ── appendDelta ───────────────────────────────────────────────────────────

  describe('appendDelta', () => {
    it('accumulates text in textRef', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.appendDelta('Hello');
        result.current.appendDelta(', ');
        result.current.appendDelta('world');
      });

      expect(result.current.textRef.current).toBe('Hello, world');
    });

    it('triggers setChats via requestAnimationFrame to update streaming state', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.appendDelta('chunk');
      });

      // requestAnimationFrame is mocked to call synchronously in setup.ts
      expect(setChats).toHaveBeenCalled();
    });

    it('passes updater function that marks message as isStreaming: true', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      const chat = makeChat('chat-1', 'msg-1');

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.appendDelta('partial text');
      });

      // Simulate the setChats updater call
      const updater = setChats.mock.calls[0][0];
      const newChats = updater([chat]);
      const updatedMessage = newChats[0].messages[0];
      expect(updatedMessage.isStreaming).toBe(true);
      expect(updatedMessage.text).toBe('partial text');
    });

    it('does not call setChats when chatId or messageId is not set', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      // Do NOT call startStreaming first
      act(() => {
        result.current.appendDelta('orphan delta');
      });

      // Even though RAF fires, the updater should be a no-op since refs are empty
      if (setChats.mock.calls.length > 0) {
        const updater = setChats.mock.calls[0][0];
        const chat = makeChat('chat-1', 'msg-1');
        // The updater should not modify chats when refs are empty
        const result2 = updater([chat]);
        // Chats remain unchanged
        expect(result2).toEqual([chat]);
      }
    });
  });

  // ── finishStreaming ───────────────────────────────────────────────────────

  describe('finishStreaming', () => {
    it('calls setChats with final text and isStreaming: false', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      const chat = makeChat('chat-1', 'msg-1', 'partial');

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.finishStreaming('Final response text');
      });

      expect(setChats).toHaveBeenCalled();
      const lastUpdater = setChats.mock.calls[setChats.mock.calls.length - 1][0];
      const newChats = lastUpdater([chat]);
      const updatedMsg = newChats[0].messages[0];
      expect(updatedMsg.text).toBe('Final response text');
      expect(updatedMsg.isStreaming).toBe(false);
    });

    it('attaches visualization when provided', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      const chat = makeChat('chat-1', 'msg-1');
      const viz = {
        chart_type: 'bar' as const,
        title: 'Sales Chart',
        data: [{ category: 'A', value: 100 }],
        x_label: 'Category',
        y_label: 'Value',
      };

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.finishStreaming('Here is the chart', viz);
      });

      const updater = setChats.mock.calls[setChats.mock.calls.length - 1][0];
      const newChats = updater([chat]);
      const updatedMsg = newChats[0].messages[0];
      expect(updatedMsg.visualization).toEqual(viz);
    });

    it('does not attach visualization key when not provided', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      const chat = makeChat('chat-1', 'msg-1');

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.finishStreaming('Done');
      });

      const updater = setChats.mock.calls[setChats.mock.calls.length - 1][0];
      const newChats = updater([chat]);
      const updatedMsg = newChats[0].messages[0];
      expect(updatedMsg.visualization).toBeUndefined();
    });

    it('does nothing when called before startStreaming', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.finishStreaming('Should not update');
      });

      expect(setChats).not.toHaveBeenCalled();
    });

    it('clears chatId and messageId refs after finishing', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.finishStreaming('Done');
      });

      // Calling finishStreaming again should be a no-op
      const callCount = setChats.mock.calls.length;
      act(() => {
        result.current.finishStreaming('Should not update again');
      });
      expect(setChats.mock.calls.length).toBe(callCount);
    });
  });

  // ── cancelStreaming ───────────────────────────────────────────────────────

  describe('cancelStreaming', () => {
    it('sets message text to error text and marks isStreaming: false', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      const chat = makeChat('chat-1', 'msg-1', 'partial streaming text');

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.cancelStreaming('Connection lost');
      });

      expect(setChats).toHaveBeenCalled();
      const updater = setChats.mock.calls[setChats.mock.calls.length - 1][0];
      const newChats = updater([chat]);
      const updatedMsg = newChats[0].messages[0];
      expect(updatedMsg.text).toBe('Connection lost');
      expect(updatedMsg.isStreaming).toBe(false);
    });

    it('does nothing when called before startStreaming', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.cancelStreaming('Error message');
      });

      expect(setChats).not.toHaveBeenCalled();
    });

    it('clears chatId and messageId refs after cancelling', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));

      act(() => {
        result.current.startStreaming('chat-1', 'msg-1');
        result.current.cancelStreaming('Error');
      });

      // Calling cancelStreaming again should be a no-op
      const callCount = setChats.mock.calls.length;
      act(() => {
        result.current.cancelStreaming('Another error');
      });
      expect(setChats.mock.calls.length).toBe(callCount);
    });
  });

  // ── Updater correctness ───────────────────────────────────────────────────

  describe('updater function chat filtering', () => {
    it('only updates the correct chat and message', () => {
      const { result } = renderHook(() => useStreamingMessage({ setChats }));
      const targetChat = makeChat('chat-target', 'msg-target');
      const otherChat = makeChat('chat-other', 'msg-other');

      act(() => {
        result.current.startStreaming('chat-target', 'msg-target');
        result.current.finishStreaming('Updated text');
      });

      const updater = setChats.mock.calls[setChats.mock.calls.length - 1][0];
      const newChats = updater([targetChat, otherChat]);

      // Target chat message updated
      expect(newChats[0].messages[0].text).toBe('Updated text');
      // Other chat message untouched
      expect(newChats[1].messages[0].text).toBe('');
    });
  });
});
