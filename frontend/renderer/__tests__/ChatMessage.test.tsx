/*
* Created on Mar 27, 2026
* Test file for ChatMessage.tsx
* File path: renderer/__tests__/ChatMessage.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatMessage from '../components/chat/ChatMessage';
import type { Message } from '../types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../utils/sqlHighlight', () => ({
  highlightSQL: jest.fn((sql: string) => `<span>${sql}</span>`),
}));

jest.mock('highlight.js/lib/core', () => ({
  __esModule: true,
  default: {
    registerLanguage: jest.fn(),
    highlight: jest.fn(() => ({ value: 'SELECT 1' })),
  },
}));

jest.mock('highlight.js/lib/languages/sql', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('highlight.js/lib/languages/pgsql', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({
    language: 'en',
    setLanguage: jest.fn(),
    t: (key: string) => key,
  }),
}));

// Mock ChartBlock to keep tests simple
jest.mock('../components/chat/ChartBlock', () => ({
  __esModule: true,
  default: ({ visualization }: { visualization: unknown }) => (
    <div data-testid="chart-block">{JSON.stringify(visualization)}</div>
  ),
}));

// Mock SQLBlock to avoid its internal electronAPI calls
jest.mock('../components/chat/SQLBlock', () => ({
  __esModule: true,
  default: ({ sql, onExplain, onApply, onExecute }: {
    sql: string;
    onExplain?: (s: string) => void;
    onApply?: (s: string) => void;
    onExecute?: (s: string) => void;
  }) => (
    <div data-testid="sql-block">
      <span data-testid="sql-content">{sql}</span>
      {onExplain && <button onClick={() => onExplain(sql)}>Explain</button>}
      {onApply && <button onClick={() => onApply(sql)}>Apply</button>}
      {onExecute && <button onClick={() => onExecute(sql)}>Execute</button>}
    </div>
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    text: 'Hello world',
    sender: 'bot',
    timestamp: new Date('2024-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

const defaultProps = {
  message: makeMessage(),
  isTyping: false,
  isAgentConnected: false,
  isDatabaseConnected: false,
  safeMode: true,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Supply a functional clipboard mock
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders a bot message', () => {
      render(<ChatMessage {...defaultProps} />);
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });

    it('renders a user message', () => {
      render(
        <ChatMessage
          {...defaultProps}
          message={makeMessage({ sender: 'user', text: 'My question' })}
        />
      );
      expect(screen.getByText('My question')).toBeInTheDocument();
    });

    it('renders the message timestamp', () => {
      const message = makeMessage({ timestamp: new Date('2024-01-01T10:30:00.000Z') });
      render(<ChatMessage {...defaultProps} message={message} />);
      // The timestamp is rendered via toLocaleTimeString, just check the element exists
      const timeEl = document.querySelector('.MuiTypography-caption');
      expect(timeEl).toBeTruthy();
    });
  });

  // ── Streaming ─────────────────────────────────────────────────────────────

  describe('streaming state', () => {
    it('renders streaming text without markdown parsing when isStreaming is true', () => {
      const message = makeMessage({ text: 'Streaming response...', isStreaming: true });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByText('Streaming response...')).toBeInTheDocument();
    });

    it('does not render SQLBlock during streaming', () => {
      const message = makeMessage({
        text: 'SELECT * FROM users',
        isStreaming: true,
      });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.queryByTestId('sql-block')).not.toBeInTheDocument();
    });
  });

  // ── Plain SQL messages ────────────────────────────────────────────────────

  describe('plain SQL rendering', () => {
    it('renders Copy and Run buttons for a plain SQL message from bot', () => {
      const message = makeMessage({
        sender: 'bot',
        text: 'SELECT id, name FROM products',
      });
      const onExecuteQuery = jest.fn();
      render(
        <ChatMessage
          {...defaultProps}
          message={message}
          onExecuteQuery={onExecuteQuery}
        />
      );
      // Button accessible names come from Tooltip titles (translated key = key in mock)
      expect(screen.getByRole('button', { name: /copy sql/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /execute sql/i })).toBeInTheDocument();
    });

    it('clicking Run calls onExecuteQuery with the SQL', () => {
      const sql = 'SELECT id, name FROM products';
      const onExecuteQuery = jest.fn();
      const message = makeMessage({ sender: 'bot', text: sql });
      render(
        <ChatMessage {...defaultProps} message={message} onExecuteQuery={onExecuteQuery} />
      );
      fireEvent.click(screen.getByRole('button', { name: /execute sql/i }));
      expect(onExecuteQuery).toHaveBeenCalledWith(sql);
    });

    it('clicking Copy calls clipboard.writeText with the SQL', async () => {
      const sql = 'SELECT 1';
      const message = makeMessage({ sender: 'bot', text: sql });
      render(<ChatMessage {...defaultProps} message={message} />);
      fireEvent.click(screen.getByRole('button', { name: /copy sql/i }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(sql);
    });

    it('does not render Run button when onExecuteQuery is not provided', () => {
      const message = makeMessage({ sender: 'bot', text: 'SELECT 1' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.queryByRole('button', { name: /execute sql/i })).not.toBeInTheDocument();
    });
  });

  // ── Markdown rendering ────────────────────────────────────────────────────

  describe('markdown rendering', () => {
    it('renders bold text from **text** syntax', () => {
      const message = makeMessage({ text: 'Hello **world**!' });
      render(<ChatMessage {...defaultProps} message={message} />);
      const bold = screen.getByText('world');
      expect(bold.tagName).toBe('STRONG');
    });

    it('renders H1 heading from # prefix', () => {
      const message = makeMessage({ text: '# Section Title' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByText('Section Title')).toBeInTheDocument();
    });

    it('renders H2 heading from ## prefix', () => {
      const message = makeMessage({ text: '## Subsection' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByText('Subsection')).toBeInTheDocument();
    });

    it('renders unordered list items with - prefix', () => {
      const message = makeMessage({ text: '- Item one\n- Item two' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByText('Item one')).toBeInTheDocument();
      expect(screen.getByText('Item two')).toBeInTheDocument();
    });

    it('renders ordered list items with 1. prefix', () => {
      const message = makeMessage({ text: '1. First item\n2. Second item' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByText('First item')).toBeInTheDocument();
      expect(screen.getByText('Second item')).toBeInTheDocument();
    });

    it('renders a markdown table', () => {
      const tableText = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
      const message = makeMessage({ text: tableText });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('renders a fenced SQL code block as SQLBlock', () => {
      const message = makeMessage({ text: '```sql\nSELECT 1\n```' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByTestId('sql-block')).toBeInTheDocument();
      expect(screen.getByTestId('sql-content').textContent).toBe('SELECT 1');
    });

    it('renders a fenced non-SQL code block as a plain pre element', () => {
      const message = makeMessage({ text: '```javascript\nconsole.log(1);\n```' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByText('console.log(1);')).toBeInTheDocument();
    });

    it('passes onApplySQL to SQLBlock as onApply', () => {
      const onApplySQL = jest.fn();
      const message = makeMessage({ text: '```sql\nSELECT 1\n```' });
      render(
        <ChatMessage {...defaultProps} message={message} onApplySQL={onApplySQL} />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApplySQL).toHaveBeenCalledWith('SELECT 1');
    });

    it('passes onExecuteQuery to SQLBlock as onExecute', () => {
      const onExecuteQuery = jest.fn();
      const message = makeMessage({ text: '```sql\nSELECT 1\n```' });
      render(
        <ChatMessage {...defaultProps} message={message} onExecuteQuery={onExecuteQuery} />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
      expect(onExecuteQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('renders visualization (ChartBlock) when message has visualization data', () => {
      const message = makeMessage({
        text: 'Here is the chart',
        visualization: {
          chart_type: 'bar',
          title: 'Sales',
          data: [],
        },
      });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.getByTestId('chart-block')).toBeInTheDocument();
    });
  });

  // ── isSQLCode detection ───────────────────────────────────────────────────

  describe('isSQLCode detection for plain text messages', () => {
    it('detects SELECT statement as SQL and shows Copy/Execute buttons', () => {
      const message = makeMessage({ text: 'SELECT * FROM users' });
      const onExecuteQuery = jest.fn();
      render(
        <ChatMessage {...defaultProps} message={message} onExecuteQuery={onExecuteQuery} />
      );
      expect(screen.getByRole('button', { name: /copy sql/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /execute sql/i })).toBeInTheDocument();
    });

    it('does not detect plain prose as SQL', () => {
      const message = makeMessage({ text: 'This is a regular text response.' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
    });

    it('does not detect text containing ** as SQL', () => {
      const message = makeMessage({ text: '**Important:** Remember to back up.' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
    });

    it('does not detect text with backtick blocks as SQL', () => {
      const message = makeMessage({ text: '```SELECT * FROM users```' });
      render(<ChatMessage {...defaultProps} message={message} />);
      expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
    });
  });
});
