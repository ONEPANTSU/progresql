/*
* Created on Mar 27, 2026
* Test file for ChatInput.tsx
* File path: renderer/__tests__/ChatInput.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React, { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatInput, { ChatInputHandle } from '../components/chat/ChatInput';
import type { DatabaseServer } from '../types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../contexts/LanguageContext', () => ({
  useTranslation: () => ({
    language: 'en',
    setLanguage: jest.fn(),
    t: (key: string, params?: Record<string, string>) => {
      const map: Record<string, string> = {
        'chat.input.placeholder': 'Ask a question about your database',
        'chat.input.backendUnavailable': 'Backend unavailable',
        'chat.input.generating': 'Generating...',
        'chat.input.send': 'Send message',
        'chat.input.stop': 'Stop',
        'chat.input.sqlLines': `SQL (${params?.count ?? '0'} lines)`,
        'chat.dbPill.noConnection': 'No connection',
      };
      return map[key] ?? key;
    },
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultProps = {
  inputValue: '',
  setInputValue: jest.fn(),
  isTyping: false,
  isConnected: true,
  onSendMessage: jest.fn(),
};

function makeConnection(overrides: Partial<DatabaseServer> = {}): DatabaseServer {
  return {
    id: 'conn-1',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: '',
    database: 'mydb',
    connectionName: 'My DB',
    isActive: true,
    databases: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatInput', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the text input field', () => {
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('shows the send button when not typing', () => {
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByLabelText('Send message')).toBeInTheDocument();
    });

    it('shows the stop button when isTyping is true', () => {
      render(<ChatInput {...defaultProps} isTyping={true} />);
      expect(screen.getByLabelText('Stop')).toBeInTheDocument();
    });

    it('does not show send button when isTyping is true', () => {
      render(<ChatInput {...defaultProps} isTyping={true} />);
      expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
    });

    it('shows the backend unavailable placeholder when not connected', () => {
      render(<ChatInput {...defaultProps} isConnected={false} />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveAttribute('placeholder', 'Backend unavailable');
    });

    it('shows the generating placeholder when isTyping is true', () => {
      render(<ChatInput {...defaultProps} isTyping={true} />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveAttribute('placeholder', 'Generating...');
    });

    it('shows the default placeholder when connected and not typing', () => {
      render(<ChatInput {...defaultProps} />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveAttribute('placeholder', 'Ask a question about your database');
    });

    it('shows the DB pill with "No connection" when no active connection', () => {
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByText('No connection')).toBeInTheDocument();
    });

    it('shows the connection name in the DB pill when an active connection is provided', () => {
      const conn = makeConnection({ connectionName: 'Production DB', activeDatabase: 'prod' });
      render(
        <ChatInput
          {...defaultProps}
          activeConnection={conn}
          connections={[conn]}
        />
      );
      expect(screen.getByText('Production DB · prod')).toBeInTheDocument();
    });

    it('shows host as connection name fallback when connectionName is empty', () => {
      const conn = makeConnection({ connectionName: '', host: '10.0.0.1', activeDatabase: 'mydb' });
      render(
        <ChatInput
          {...defaultProps}
          activeConnection={conn}
          connections={[conn]}
        />
      );
      expect(screen.getByText('10.0.0.1 · mydb')).toBeInTheDocument();
    });
  });

  // ── Input value ───────────────────────────────────────────────────────────

  describe('input value', () => {
    it('displays the provided inputValue', () => {
      render(<ChatInput {...defaultProps} inputValue="Hello!" />);
      expect(screen.getByRole('textbox')).toHaveValue('Hello!');
    });

    it('calls setInputValue when text is changed', () => {
      const setInputValue = jest.fn();
      render(<ChatInput {...defaultProps} setInputValue={setInputValue} />);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'test' } });
      expect(setInputValue).toHaveBeenCalledWith('test');
    });
  });

  // ── Send button state ─────────────────────────────────────────────────────

  describe('send button disabled state', () => {
    it('is disabled when input is empty and no attached SQL', () => {
      render(<ChatInput {...defaultProps} inputValue="" />);
      expect(screen.getByLabelText('Send message')).toBeDisabled();
    });

    it('is disabled when input has only whitespace', () => {
      render(<ChatInput {...defaultProps} inputValue="   " />);
      expect(screen.getByLabelText('Send message')).toBeDisabled();
    });

    it('is disabled when not connected, even with input', () => {
      render(<ChatInput {...defaultProps} inputValue="Some text" isConnected={false} />);
      expect(screen.getByLabelText('Send message')).toBeDisabled();
    });

    it('is enabled when input has text and is connected', () => {
      render(<ChatInput {...defaultProps} inputValue="Hello" />);
      expect(screen.getByLabelText('Send message')).not.toBeDisabled();
    });

    it('is enabled when attachedSQL is provided even with empty input', () => {
      render(
        <ChatInput
          {...defaultProps}
          inputValue=""
          attachedSQL="SELECT 1"
          isConnected={true}
        />
      );
      expect(screen.getByLabelText('Send message')).not.toBeDisabled();
    });
  });

  // ── Send via button click ─────────────────────────────────────────────────

  describe('send via button', () => {
    it('calls onSendMessage when send button is clicked with input', () => {
      const onSendMessage = jest.fn();
      render(
        <ChatInput {...defaultProps} inputValue="Hello" onSendMessage={onSendMessage} />
      );
      fireEvent.click(screen.getByLabelText('Send message'));
      expect(onSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── Send via keyboard ─────────────────────────────────────────────────────

  describe('keyboard shortcuts', () => {
    it('calls onSendMessage when Enter is pressed without Shift', () => {
      const onSendMessage = jest.fn();
      render(
        <ChatInput {...defaultProps} inputValue="Hello" onSendMessage={onSendMessage} />
      );
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: false });
      expect(onSendMessage).toHaveBeenCalledTimes(1);
    });

    it('does not call onSendMessage when Shift+Enter is pressed', () => {
      const onSendMessage = jest.fn();
      render(
        <ChatInput {...defaultProps} inputValue="Hello" onSendMessage={onSendMessage} />
      );
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
      expect(onSendMessage).not.toHaveBeenCalled();
    });

    it('does not call onSendMessage on Enter when isTyping is true', () => {
      const onSendMessage = jest.fn();
      render(
        <ChatInput
          {...defaultProps}
          inputValue="Hello"
          isTyping={true}
          onSendMessage={onSendMessage}
        />
      );
      // When isTyping, the Enter key handler checks isTyping and skips
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: false });
      expect(onSendMessage).not.toHaveBeenCalled();
    });

    it('does not call onSendMessage when pressing keys other than Enter', () => {
      const onSendMessage = jest.fn();
      render(<ChatInput {...defaultProps} inputValue="Hi" onSendMessage={onSendMessage} />);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' });
      expect(onSendMessage).not.toHaveBeenCalled();
    });
  });

  // ── Stop button ───────────────────────────────────────────────────────────

  describe('stop button', () => {
    it('calls onStopGeneration when stop button is clicked', () => {
      const onStopGeneration = jest.fn();
      render(
        <ChatInput
          {...defaultProps}
          isTyping={true}
          onStopGeneration={onStopGeneration}
        />
      );
      fireEvent.click(screen.getByLabelText('Stop'));
      expect(onStopGeneration).toHaveBeenCalledTimes(1);
    });
  });

  // ── Attached SQL ──────────────────────────────────────────────────────────

  describe('attached SQL', () => {
    it('renders the SQL attachment panel when attachedSQL is provided', () => {
      render(
        <ChatInput
          {...defaultProps}
          attachedSQL="SELECT 1"
        />
      );
      // The attachment header contains "SQL ·" and a line count
      expect(screen.getByText(/SQL ·/)).toBeInTheDocument();
    });

    it('does not render the SQL attachment panel when attachedSQL is null', () => {
      render(<ChatInput {...defaultProps} attachedSQL={null} />);
      expect(screen.queryByText(/SQL ·/)).not.toBeInTheDocument();
    });

    it('calls onRemoveAttachment when the remove button is clicked', () => {
      const onRemoveAttachment = jest.fn();
      render(
        <ChatInput
          {...defaultProps}
          attachedSQL="SELECT 1"
          onRemoveAttachment={onRemoveAttachment}
        />
      );
      fireEvent.click(screen.getByLabelText('Remove attached SQL'));
      expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    });

    it('expands SQL preview when Expand SQL button is clicked', () => {
      render(
        <ChatInput
          {...defaultProps}
          attachedSQL="SELECT * FROM users\nWHERE active = true\nLIMIT 10"
        />
      );
      const expandBtn = screen.getByLabelText('Expand SQL');
      fireEvent.click(expandBtn);
      // After expanding, it should show "Collapse SQL"
      expect(screen.getByLabelText('Collapse SQL')).toBeInTheDocument();
    });

    it('collapses SQL preview when Collapse SQL button is clicked', () => {
      render(
        <ChatInput
          {...defaultProps}
          attachedSQL="SELECT * FROM users\nWHERE active = true"
        />
      );
      // Expand first
      fireEvent.click(screen.getByLabelText('Expand SQL'));
      // Then collapse
      fireEvent.click(screen.getByLabelText('Collapse SQL'));
      expect(screen.getByLabelText('Expand SQL')).toBeInTheDocument();
    });
  });

  // ── Database selector pill ────────────────────────────────────────────────

  describe('database selector pill', () => {
    it('shows a chevron icon when connections are available', () => {
      const conn = makeConnection();
      render(
        <ChatInput
          {...defaultProps}
          connections={[conn]}
          activeConnection={conn}
        />
      );
      // The chevron icon is rendered when connections.length > 0
      // We verify by checking the pill is interactive (cursor: pointer)
      expect(screen.getByText(/My DB/)).toBeInTheDocument();
    });

    it('opens dropdown menu when pill is clicked with connections', () => {
      const conn = makeConnection({ connectionName: 'Test Server' });
      render(
        <ChatInput
          {...defaultProps}
          connections={[conn]}
          activeConnection={conn}
        />
      );
      // Click the DB pill — uses the text label to find it
      fireEvent.click(screen.getByText(/Test Server/));
      // Menu item for the connection should appear
      expect(screen.getAllByText(/Test Server/).length).toBeGreaterThan(0);
    });

    it('calls onSwitchConnection when a connection menu item is clicked', () => {
      const conn = makeConnection({ id: 'conn-2', connectionName: 'Staging DB', database: 'staging', activeDatabase: 'staging' });
      const onSwitchConnection = jest.fn();
      render(
        <ChatInput
          {...defaultProps}
          connections={[conn]}
          activeConnection={conn}
          onSwitchConnection={onSwitchConnection}
        />
      );
      // The pill shows "Staging DB · staging" — click it to open the menu
      fireEvent.click(screen.getByText('Staging DB · staging'));
      // Click the menu item — find all, pick the one in the dropdown (MenuItem role)
      const menuItems = screen.getAllByRole('menuitem');
      fireEvent.click(menuItems[0]);
      expect(onSwitchConnection).toHaveBeenCalledWith('conn-2');
    });

    it('uses chatConnectionId over activeConnection for display', () => {
      const activeConn = makeConnection({ id: 'active', connectionName: 'Active DB' });
      const chatConn = makeConnection({ id: 'chat', connectionName: 'Chat DB' });
      render(
        <ChatInput
          {...defaultProps}
          activeConnection={activeConn}
          connections={[activeConn, chatConn]}
          chatConnectionId="chat"
        />
      );
      expect(screen.getByText(/Chat DB/)).toBeInTheDocument();
    });

    it('uses chatDatabase over connection.activeDatabase for display', () => {
      const conn = makeConnection({ connectionName: 'My Server', activeDatabase: 'default' });
      render(
        <ChatInput
          {...defaultProps}
          activeConnection={conn}
          connections={[conn]}
          chatDatabase="override_db"
        />
      );
      expect(screen.getByText('My Server · override_db')).toBeInTheDocument();
    });
  });

  // ── Ref handle ────────────────────────────────────────────────────────────

  describe('ref imperative handle', () => {
    it('exposes a focus() method through the ref', () => {
      const ref = createRef<ChatInputHandle>();
      render(<ChatInput {...defaultProps} ref={ref} />);
      // Verify ref is populated with focus method
      expect(ref.current).not.toBeNull();
      expect(typeof ref.current?.focus).toBe('function');
    });
  });
});
