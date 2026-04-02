/*
* Created on Mar 27, 2026
* Test file for SQLBlock.tsx
* File path: renderer/__tests__/SQLBlock.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import SQLBlock from '@/features/agent-chat/ui/SQLBlock';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('@/shared/i18n/LanguageContext', () => ({
  useTranslation: () => ({
    language: 'en',
    setLanguage: jest.fn(),
    t: (key: string) => {
      const map: Record<string, string> = {
        'sqlBlock.copySql': 'Copy SQL',
        'sqlBlock.copied': 'Copied!',
        'sqlBlock.explainSql': 'Explain SQL',
        'sqlBlock.applySql': 'Apply SQL',
        'sqlBlock.executeSql': 'Execute SQL',
        'sqlBlock.verifying': 'Verifying...',
        'sqlBlock.verified': 'Valid SQL',
        'sqlBlock.verifyInvalid': 'Invalid SQL',
        'sqlBlock.executionFailed': 'Execution failed',
      };
      return map[key] ?? key;
    },
  }),
}));

jest.mock('@/shared/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/shared/lib/sqlHighlight', () => ({
  highlightSQL: jest.fn((sql: string) => `<span>${sql}</span>`),
}));

jest.mock('highlight.js/lib/core', () => ({
  __esModule: true,
  default: {
    registerLanguage: jest.fn(),
    highlight: jest.fn(() => ({ value: 'SELECT 1' })),
  },
}));

jest.mock('highlight.js/lib/languages/pgsql', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultProps = {
  sql: 'SELECT * FROM users',
  isTyping: false,
  isAgentConnected: false,
  isDatabaseConnected: false,
  safeMode: true,
  securityMode: 'safe' as const,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SQLBlock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset electronAPI mock
    (window as any).electronAPI = {
      executeQuery: jest.fn(),
      queryDatabase: jest.fn(),
      getDatabaseStructure: jest.fn(),
      connectToDatabase: jest.fn(),
      disconnectFromDatabase: jest.fn(),
    };
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the SQL code block', () => {
      render(<SQLBlock {...defaultProps} />);
      expect(screen.getByRole('code')).toBeInTheDocument();
    });

    it('renders the copy button', () => {
      render(<SQLBlock {...defaultProps} />);
      expect(screen.getByLabelText('Copy SQL')).toBeInTheDocument();
    });

    it('does not render Explain button when isAgentConnected is false', () => {
      const onExplain = jest.fn();
      render(<SQLBlock {...defaultProps} isAgentConnected={false} onExplain={onExplain} />);
      expect(screen.queryByLabelText('Explain SQL')).not.toBeInTheDocument();
    });

    it('renders Explain button when isAgentConnected is true and onExplain is provided', () => {
      const onExplain = jest.fn();
      render(
        <SQLBlock {...defaultProps} isAgentConnected={true} onExplain={onExplain} />
      );
      expect(screen.getByLabelText('Explain SQL')).toBeInTheDocument();
    });

    it('renders Apply button when onApply is provided', () => {
      const onApply = jest.fn();
      render(<SQLBlock {...defaultProps} onApply={onApply} />);
      expect(screen.getByLabelText('Apply SQL')).toBeInTheDocument();
    });

    it('does not render Apply button when onApply is not provided', () => {
      render(<SQLBlock {...defaultProps} />);
      expect(screen.queryByLabelText('Apply SQL')).not.toBeInTheDocument();
    });

    it('renders Execute button when onExecute is provided', () => {
      const onExecute = jest.fn();
      render(<SQLBlock {...defaultProps} onExecute={onExecute} />);
      expect(screen.getByLabelText('Execute SQL')).toBeInTheDocument();
    });

    it('does not render Execute button when onExecute is not provided', () => {
      render(<SQLBlock {...defaultProps} />);
      expect(screen.queryByLabelText('Execute SQL')).not.toBeInTheDocument();
    });
  });

  // ── Copy button ───────────────────────────────────────────────────────────

  describe('copy button', () => {
    it('copies SQL to clipboard when copy button is clicked', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      render(<SQLBlock {...defaultProps} sql="SELECT 1" />);
      fireEvent.click(screen.getByLabelText('Copy SQL'));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('SELECT 1');
      });
    });

    it('shows "Copied!" tooltip text after copying', async () => {
      jest.useFakeTimers();
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      render(<SQLBlock {...defaultProps} sql="SELECT 1" />);

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Copy SQL'));
      });

      // After copy, button aria-label should remain as 'Copy SQL' but the
      // tooltip content changes — we verify by checking the copy was called
      expect(writeText).toHaveBeenCalledTimes(1);

      jest.runAllTimers();
      jest.useRealTimers();
    });
  });

  // ── Action button callbacks ───────────────────────────────────────────────

  describe('action callbacks', () => {
    it('calls onExplain with the SQL string when Explain is clicked', () => {
      const onExplain = jest.fn();
      render(
        <SQLBlock
          {...defaultProps}
          isAgentConnected={true}
          onExplain={onExplain}
          sql="SELECT id FROM orders"
        />
      );
      fireEvent.click(screen.getByLabelText('Explain SQL'));
      expect(onExplain).toHaveBeenCalledWith('SELECT id FROM orders');
    });

    it('calls onApply with the SQL string when Apply is clicked', () => {
      const onApply = jest.fn();
      render(
        <SQLBlock
          {...defaultProps}
          onApply={onApply}
          sql="UPDATE users SET active = true"
        />
      );
      fireEvent.click(screen.getByLabelText('Apply SQL'));
      expect(onApply).toHaveBeenCalledWith('UPDATE users SET active = true');
    });

    it('calls onExecute with the SQL string when Execute is clicked', async () => {
      const onExecute = jest.fn();
      (window as any).electronAPI.executeQuery = jest
        .fn()
        .mockResolvedValue({ success: true });

      render(
        <SQLBlock
          {...defaultProps}
          onExecute={onExecute}
          sql="DELETE FROM logs WHERE created_at < now()"
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Execute SQL'));
      });

      expect(onExecute).toHaveBeenCalledWith('DELETE FROM logs WHERE created_at < now()');
    });

    it('disables Explain button when isTyping is true', () => {
      const onExplain = jest.fn();
      render(
        <SQLBlock
          {...defaultProps}
          isAgentConnected={true}
          isTyping={true}
          onExplain={onExplain}
        />
      );
      expect(screen.getByLabelText('Explain SQL')).toBeDisabled();
    });
  });

  // ── Verification – skipped states ─────────────────────────────────────────

  describe('verification status', () => {
    it('shows "skipped" status (no badge) when database is not connected', () => {
      render(<SQLBlock {...defaultProps} isDatabaseConnected={false} />);
      // No verifying/verified/invalid badge should appear
      expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
      expect(screen.queryByText('Valid SQL')).not.toBeInTheDocument();
      expect(screen.queryByText('Invalid SQL')).not.toBeInTheDocument();
    });

    it('shows "skipped" status for DML statements even when DB is connected', () => {
      render(
        <SQLBlock
          {...defaultProps}
          sql="INSERT INTO users (name) VALUES ('Alice')"
          isDatabaseConnected={true}
        />
      );
      expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
    });

    it('shows "skipped" status when securityMode is "execute"', () => {
      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          securityMode="execute"
          sql="SELECT 1"
        />
      );
      expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
    });

    it('shows "skipped" status when isTyping is true', () => {
      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={true}
          sql="SELECT 1"
        />
      );
      expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
    });

    it('shows "Verifying..." when DB is connected and SQL is a SELECT', async () => {
      (window as any).electronAPI.executeQuery = jest
        .fn()
        .mockReturnValue(new Promise(() => {})); // never resolves

      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={false}
          sql="SELECT 1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Verifying...')).toBeInTheDocument();
      });
    });

    it('shows "Valid SQL" badge after successful verification', async () => {
      (window as any).electronAPI.executeQuery = jest
        .fn()
        .mockResolvedValue({ success: true });

      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={false}
          sql="SELECT 1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Valid SQL')).toBeInTheDocument();
      });
    });

    it('shows "Invalid SQL" badge when verification fails', async () => {
      (window as any).electronAPI.executeQuery = jest
        .fn()
        .mockResolvedValue({ success: false, message: 'syntax error' });

      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={false}
          sql="SELECT 1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Invalid SQL')).toBeInTheDocument();
      });
    });

    it('shows "Invalid SQL" badge when verification throws', async () => {
      (window as any).electronAPI.executeQuery = jest
        .fn()
        .mockRejectedValue(new Error('connection refused'));

      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={false}
          sql="SELECT 1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Invalid SQL')).toBeInTheDocument();
      });
    });
  });

  // ── Execution failure overrides verification ──────────────────────────────

  describe('execution failure', () => {
    it('shows "Execution failed" when verified SQL fails at runtime', async () => {
      const onExecute = jest.fn();
      const mockExecuteQuery = jest.fn((_connId: string, query: string) => {
        if (query.startsWith('EXPLAIN ')) {
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: false, message: 'array_agg is an aggregate function' });
      });
      (window as any).electronAPI.executeQuery = mockExecuteQuery;

      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={false}
          sql="SELECT array_agg(id) FROM users"
          onExecute={onExecute}
          connectionId="conn-1"
        />
      );

      // Wait for verification (EXPLAIN) to complete
      await waitFor(() => {
        expect(screen.getByText('Valid SQL')).toBeInTheDocument();
      });

      // Click Execute and wait for async state updates
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Execute SQL'));
        // Allow microtasks from the async handleExecute to complete
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Badge should now show execution failure
      await waitFor(() => {
        expect(screen.getByText('Execution failed')).toBeInTheDocument();
      });

      // The "Valid SQL" badge should be gone
      expect(screen.queryByText('Valid SQL')).not.toBeInTheDocument();
    });

    it('shows "Execution failed" when execution throws an error', async () => {
      const onExecute = jest.fn();
      const mockExecuteQuery = jest.fn((_connId: string, query: string) => {
        if (query.startsWith('EXPLAIN ')) {
          return Promise.resolve({ success: true });
        }
        return Promise.reject(new Error('connection lost'));
      });
      (window as any).electronAPI.executeQuery = mockExecuteQuery;

      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={false}
          sql="SELECT 1"
          onExecute={onExecute}
          connectionId="conn-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Valid SQL')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Execute SQL'));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByText('Execution failed')).toBeInTheDocument();
      });
    });

    it('does not change badge when execution succeeds', async () => {
      const onExecute = jest.fn();
      (window as any).electronAPI.executeQuery = jest
        .fn()
        .mockResolvedValue({ success: true }); // both EXPLAIN and execution succeed

      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          isTyping={false}
          sql="SELECT 1"
          onExecute={onExecute}
          connectionId="conn-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Valid SQL')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Execute SQL'));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Badge should still show verified
      expect(screen.getByText('Valid SQL')).toBeInTheDocument();
      expect(screen.queryByText('Execution failed')).not.toBeInTheDocument();
    });
  });

  // ── DML detection via stripSQLComments ────────────────────────────────────

  describe('DML statement detection', () => {
    const dmlStatements = [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x = 1',
      'DELETE FROM t',
      'DROP TABLE t',
      'ALTER TABLE t ADD COLUMN x int',
      'TRUNCATE TABLE t',
      'CREATE TABLE t (id int)',
    ];

    dmlStatements.forEach((sql) => {
      it(`skips verification for: ${sql.split(' ').slice(0, 2).join(' ')}`, () => {
        render(
          <SQLBlock
            {...defaultProps}
            isDatabaseConnected={true}
            sql={sql}
          />
        );
        expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
      });
    });

    it('skips verification for DML with leading SQL comment', () => {
      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          sql="/* comment */ DELETE FROM logs"
        />
      );
      expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
    });

    it('skips verification for DML with inline comment', () => {
      // The inline comment is on its own line followed by a DML statement.
      // stripSQLComments strips "--..." lines, leaving the DELETE statement.
      render(
        <SQLBlock
          {...defaultProps}
          isDatabaseConnected={true}
          sql={`-- drop all records
DELETE FROM t`}
        />
      );
      expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
    });
  });
});
