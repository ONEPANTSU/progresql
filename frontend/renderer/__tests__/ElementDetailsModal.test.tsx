/*
* Created on Mar 31, 2026
* Test file for ElementDetailsModal.tsx
* File path: renderer/__tests__/ElementDetailsModal.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ElementDetailsModal from '../components/ElementDetailsModal';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({
    language: 'en',
    setLanguage: jest.fn(),
    t: (key: string) => {
      const map: Record<string, string> = {
        'details.copyCode': 'Copy Code',
        'details.addColumn': 'Add Column',
        'details.name': 'Name',
        'details.colType': 'Column Type',
        'details.colNullable': 'Nullable',
        'details.default': 'Default',
        'details.noDefault': 'No default',
        'details.addDescriptionPlaceholder': 'Add description...',
        'details.applyChanges': 'Apply Changes',
        'details.alterColumn': 'Alter Column',
        'details.dropColumn': 'Drop Column',
        'details.dropSql': 'Drop SQL',
        'details.dropColumnTitle': 'Drop Column',
        'details.dropConfirm': 'Are you sure you want to drop',
      };
      return map[key] ?? key;
    },
  }),
}));

jest.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../utils/descriptionStorage', () => ({
  getDescription: jest.fn().mockReturnValue(''),
  setDescription: jest.fn(),
}));

jest.mock('../utils/userStorage', () => ({
  userKey: jest.fn((suffix: string) => `progresql-${suffix}`),
}));

// Mock CodeMirror modules so MiniSQLEditor renders a simple textarea in tests
jest.mock('codemirror', () => ({
  EditorView: class { destroy() {} },
  basicSetup: [],
}));
jest.mock('@codemirror/state', () => ({
  EditorState: { create: () => ({}) },
}));
jest.mock('@codemirror/lang-sql', () => ({
  sql: () => [],
  PostgreSQL: {},
}));
jest.mock('@codemirror/language', () => ({
  HighlightStyle: { define: () => [] },
  syntaxHighlighting: () => [],
}));
jest.mock('@codemirror/view', () => ({
  EditorView: { theme: () => [], updateListener: { of: () => [] } },
}));
jest.mock('@lezer/highlight', () => ({
  tags: new Proxy({}, { get: () => () => ({}) }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockFunction = {
  routine_name: 'update_timestamp',
  routine_schema: 'public',
  data_type: 'trigger',
  routine_definition:
    'CREATE OR REPLACE FUNCTION public.update_timestamp()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  NEW.updated_at = NOW();\n  RETURN NEW;\nEND;\n$function$',
  external_language: 'plpgsql',
};

const defaultProps = {
  open: true,
  onClose: jest.fn(),
  element: mockFunction,
  elementType: 'function' as const,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderModal(overrides: Partial<typeof defaultProps> & { [key: string]: any } = {}) {
  return render(<ElementDetailsModal {...defaultProps} {...overrides} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ElementDetailsModal – function inline editing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── "Edit Function" button visibility ─────────────────────────────────────

  describe('Edit Function button', () => {
    it('renders "Edit Function" button when elementType is function and routine_definition is present', () => {
      renderModal();
      expect(screen.getByRole('button', { name: /edit function/i })).toBeInTheDocument();
    });

    it('does not render "Edit Function" button when routine_definition is absent', () => {
      renderModal({ element: { ...mockFunction, routine_definition: undefined } });
      expect(screen.queryByRole('button', { name: /edit function/i })).not.toBeInTheDocument();
    });

    it('does not render "Edit Function" button when elementType is not function', () => {
      const viewElement = {
        view_name: 'active_users',
        view_schema: 'public',
        view_definition: 'SELECT * FROM users WHERE active = true',
      };
      renderModal({ element: viewElement, elementType: 'view' });
      expect(screen.queryByRole('button', { name: /edit function/i })).not.toBeInTheDocument();
    });
  });

  // ── Entering edit mode ─────────────────────────────────────────────────────

  describe('entering edit mode', () => {
    it('shows the function editor textarea after clicking "Edit Function"', () => {
      renderModal();
      // Before clicking there should be only the description textbox (1 textarea)
      const before = screen.getAllByRole('textbox');
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));
      // After clicking there should be one more textarea (the function editor)
      const after = screen.getAllByRole('textbox');
      expect(after.length).toBe(before.length + 1);
    });

    it('pre-fills the function editor textarea with the element routine_definition', () => {
      renderModal();
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));
      // The function editor textarea contains the routine_definition text
      const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
      const functionEditor = textareas.find(
        (ta) => ta.value === mockFunction.routine_definition
      );
      expect(functionEditor).toBeDefined();
      expect(functionEditor!.value).toBe(mockFunction.routine_definition);
    });

    it('hides the "Edit Function" button while in edit mode', () => {
      renderModal();
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));
      expect(screen.queryByRole('button', { name: /edit function/i })).not.toBeInTheDocument();
    });

    it('shows "Cancel" and "Save" buttons while in edit mode', () => {
      renderModal();
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });
  });

  // ── Cancel button ──────────────────────────────────────────────────────────

  describe('Cancel button', () => {
    it('exits edit mode when "Cancel" is clicked', () => {
      renderModal();
      const beforeCount = screen.getAllByRole('textbox').length;
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));
      // One extra textarea added in edit mode
      expect(screen.getAllByRole('textbox').length).toBe(beforeCount + 1);
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      // Back to original count
      expect(screen.getAllByRole('textbox').length).toBe(beforeCount);
    });

    it('shows "Edit Function" button again after cancelling', () => {
      renderModal();
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.getByRole('button', { name: /edit function/i })).toBeInTheDocument();
    });
  });

  // ── Save button – success ──────────────────────────────────────────────────

  describe('Save button – success path', () => {
    it('calls onExecuteSQL with the textarea content when "Save" is clicked', async () => {
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      renderModal({ onExecuteSQL });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      const expectedSQL = mockFunction.routine_definition.trim().endsWith(';')
        ? mockFunction.routine_definition.trim()
        : mockFunction.routine_definition.trim() + ';';

      expect(onExecuteSQL).toHaveBeenCalledWith(expectedSQL);
    });

    it('calls onExecuteSQL with edited content when textarea is modified before saving', async () => {
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      renderModal({ onExecuteSQL });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
      const textarea = textareas.find((ta) => ta.value === mockFunction.routine_definition)!;
      const edited = 'CREATE OR REPLACE FUNCTION public.update_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;';
      fireEvent.change(textarea, { target: { value: edited } });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      expect(onExecuteSQL).toHaveBeenCalledWith(edited);
    });

    it('shows success alert after successful save', async () => {
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      renderModal({ onExecuteSQL });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      await waitFor(() => {
        expect(screen.getByText(/function saved successfully/i)).toBeInTheDocument();
      });
    });

    it('calls onRefreshData after a successful save', async () => {
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      const onRefreshData = jest.fn();
      renderModal({ onExecuteSQL, onRefreshData });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      await waitFor(() => {
        expect(onRefreshData).toHaveBeenCalledTimes(1);
      });
    });

    it('exits edit mode after a successful save', async () => {
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      renderModal({ onExecuteSQL });

      const beforeCount = screen.getAllByRole('textbox').length;
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      await waitFor(() => {
        expect(screen.getAllByRole('textbox').length).toBe(beforeCount);
      });
    });

    it('does NOT wrap the SQL in an additional CREATE OR REPLACE statement', async () => {
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      renderModal({ onExecuteSQL });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      const calledWith: string = onExecuteSQL.mock.calls[0][0];
      // The SQL should not be double-wrapped – count occurrences of CREATE OR REPLACE
      const occurrences = (calledWith.match(/CREATE OR REPLACE/gi) || []).length;
      expect(occurrences).toBe(1);
    });

    it('appends a semicolon if the routine_definition does not end with one', async () => {
      const definitionWithoutSemicolon =
        'CREATE OR REPLACE FUNCTION public.update_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$';
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      renderModal({
        onExecuteSQL,
        element: { ...mockFunction, routine_definition: definitionWithoutSemicolon },
      });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      const calledWith: string = onExecuteSQL.mock.calls[0][0];
      expect(calledWith.endsWith(';')).toBe(true);
    });

    it('does not double-append a semicolon when routine_definition already ends with one', async () => {
      const definitionWithSemicolon =
        'CREATE OR REPLACE FUNCTION public.update_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;';
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: true });
      renderModal({
        onExecuteSQL,
        element: { ...mockFunction, routine_definition: definitionWithSemicolon },
      });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      const calledWith: string = onExecuteSQL.mock.calls[0][0];
      expect(calledWith.endsWith(';;')).toBe(false);
      expect(calledWith.endsWith(';')).toBe(true);
    });
  });

  // ── Save button – failure ──────────────────────────────────────────────────

  describe('Save button – failure path', () => {
    it('shows error alert when onExecuteSQL returns success: false', async () => {
      const onExecuteSQL = jest
        .fn()
        .mockResolvedValue({ success: false, message: 'syntax error at or near "BEGIN"' });
      renderModal({ onExecuteSQL });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      await waitFor(() => {
        expect(screen.getByText(/syntax error at or near "BEGIN"/i)).toBeInTheDocument();
      });
    });

    it('shows a fallback error message when onExecuteSQL returns success: false without message', async () => {
      const onExecuteSQL = jest.fn().mockResolvedValue({ success: false });
      renderModal({ onExecuteSQL });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      await waitFor(() => {
        expect(screen.getByText(/failed to save function/i)).toBeInTheDocument();
      });
    });

    it('does NOT call onRefreshData when save fails', async () => {
      const onExecuteSQL = jest
        .fn()
        .mockResolvedValue({ success: false, message: 'permission denied' });
      const onRefreshData = jest.fn();
      renderModal({ onExecuteSQL, onRefreshData });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      expect(onRefreshData).not.toHaveBeenCalled();
    });

    it('stays in edit mode when save fails', async () => {
      const onExecuteSQL = jest
        .fn()
        .mockResolvedValue({ success: false, message: 'permission denied' });
      renderModal({ onExecuteSQL });

      const beforeCount = screen.getAllByRole('textbox').length;
      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      await waitFor(() => {
        // Still in edit mode – the extra function editor textarea is still present
        expect(screen.getAllByRole('textbox').length).toBe(beforeCount + 1);
      });
    });

    it('shows error alert when onExecuteSQL throws an exception', async () => {
      const onExecuteSQL = jest
        .fn()
        .mockRejectedValue(new Error('connection lost'));
      renderModal({ onExecuteSQL });

      fireEvent.click(screen.getByRole('button', { name: /edit function/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save/i }));
      });

      await waitFor(() => {
        expect(screen.getByText(/connection lost/i)).toBeInTheDocument();
      });
    });
  });
});
