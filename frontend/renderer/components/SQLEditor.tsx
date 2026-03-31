import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
  Box,
  Typography,
  Button,
  IconButton,
  Tooltip,
  CircularProgress,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  PlayArrow as RunIcon,
  Stop as StopIcon,
  Clear as ClearIcon,
  ContentCopy as CopyIcon,
  AutoFixHigh as MagicWandIcon,
  Add as AddIcon,
  Close as CloseIcon,
  Code as FormatIcon,
  Storage as StorageIcon,
  Description as TemplateIcon,
} from '@mui/icons-material';
import { format as formatSQL } from 'sql-formatter';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Transaction, Compartment, StateEffect, StateField, RangeSet } from '@codemirror/state';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { EditorView as EditorViewTheme, Decoration, GutterMarker, gutter } from '@codemirror/view';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { createLogger } from '../utils/logger';
import { SQLTab, DatabaseInfo, DatabaseServer } from '../types';
import { buildSQLSchema } from '../utils/sqlAutocomplete';
import { ghostTextExtension, showGhostText, hideGhostText } from '../utils/ghostTextExtension';
import { useAgent } from '../contexts/AgentContext';

const log = createLogger('SQLEditor');

// Custom dark theme matching chat SQL colors
const progreSQLDarkTheme = EditorViewTheme.theme({
  '&': { backgroundColor: '#1a1d23', color: '#e6edf3', position: 'relative' },
  '.cm-content': { caretColor: '#58a6ff' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#58a6ff' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#3a6fbf' },
  '.cm-panels': { backgroundColor: '#161b22', color: '#e6edf3' },
  '.cm-panels.cm-panels-top': { borderBottom: '2px solid #30363d' },
  '.cm-panels.cm-panels-bottom': { borderTop: '2px solid #30363d' },
  '.cm-activeLine': { backgroundColor: '#161b2280' },
  '.cm-selectionMatch': { backgroundColor: '#e2c08d66' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: '#ffffff22' },
  '.cm-gutters': { backgroundColor: '#1a1d23', color: '#484f58', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: '#161b2280' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: '#484f58' },
  '.cm-tooltip': { border: '1px solid #30363d', backgroundColor: '#161b22' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: '#161b22', borderBottomColor: '#161b22' },
  '.cm-tooltip-autocomplete': {
    '& > ul': { fontFamily: 'monospace', fontSize: '13px' },
    '& > ul > li': { color: '#e6edf3' },
    '& > ul > li[aria-selected]': { backgroundColor: '#3a6fbf', color: '#e6edf3' },
  },
  '.cm-completionIcon': { opacity: 0.7 },
  '.cm-completionDetail': { color: '#8b949e', fontStyle: 'italic', marginLeft: '8px' },

  // Search panel — floating top-right, compact
  '.cm-panels.cm-panels-top': {
    border: 'none',
    backgroundColor: 'transparent',
    position: 'absolute',
    top: '4px',
    right: '4px',
    left: 'auto',
    zIndex: 10,
  },
  '.cm-panel.cm-search': {
    backgroundColor: '#1e1e2e',
    borderRadius: '8px',
    padding: '6px 8px',
    border: '1px solid #30363d',
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '13px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    flexWrap: 'wrap',
  },
  '.cm-panel.cm-search input[type="text"], .cm-panel.cm-search .cm-textfield': {
    backgroundColor: '#2a2a3e',
    color: '#e6edf3',
    border: '1px solid #444',
    borderRadius: '6px',
    padding: '4px 8px',
    fontSize: '13px',
    outline: 'none',
    fontFamily: 'monospace',
    width: '180px',
  },
  '.cm-panel.cm-search input[type="text"]:focus, .cm-panel.cm-search .cm-textfield:focus': {
    borderColor: '#8b5cf6',
    boxShadow: '0 0 0 2px rgba(139, 92, 246, 0.25)',
  },
  // Nav buttons (next/prev)
  '.cm-panel.cm-search button[name=next], .cm-panel.cm-search button[name=prev]': {
    backgroundColor: 'transparent',
    color: '#c9d1d9',
    border: '1px solid #444',
    borderRadius: '6px',
    padding: '4px 8px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    lineHeight: '1.4',
  },
  '.cm-panel.cm-search button[name=next]:hover, .cm-panel.cm-search button[name=prev]:hover': {
    backgroundColor: '#8b5cf6',
    borderColor: '#8b5cf6',
    color: '#ffffff',
  },
  // Close button
  '.cm-panel.cm-search button[name=close]': {
    backgroundColor: 'transparent',
    color: '#8b949e',
    border: 'none',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '16px',
    cursor: 'pointer',
    lineHeight: '1',
  },
  '.cm-panel.cm-search button[name=close]:hover': {
    backgroundColor: '#3a3a4e',
    color: '#e6edf3',
  },
  // Hide useless: "all" button, checkboxes
  '.cm-panel.cm-search button[name=select]': { display: 'none' },
  '.cm-panel.cm-search label': { display: 'none' },
  // Replace buttons
  '.cm-panel.cm-search button[name=replace], .cm-panel.cm-search button[name=replaceAll]': {
    backgroundColor: 'transparent',
    color: '#c9d1d9',
    border: '1px solid #444',
    borderRadius: '6px',
    padding: '4px 8px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    lineHeight: '1.4',
  },
  '.cm-panel.cm-search button[name=replace]:hover, .cm-panel.cm-search button[name=replaceAll]:hover': {
    backgroundColor: '#8b5cf6',
    borderColor: '#8b5cf6',
    color: '#ffffff',
  },
  '.cm-panel.cm-search br': { display: 'none' },
  '.cm-searchMatch': {
    backgroundColor: '#e2c08d55',
    outline: '1px solid #c8a97180',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: '#8b5cf640',
    outline: '1px solid #8b5cf6',
    borderRadius: '2px',
  },
}, { dark: true });

const progreSQLHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#c678dd' },           // purple keywords (SELECT, FROM, etc.)
  { tag: tags.operatorKeyword, color: '#c678dd' },   // AND, OR, NOT
  { tag: tags.definitionKeyword, color: '#c678dd' },  // CREATE, ALTER
  { tag: tags.moduleKeyword, color: '#c678dd' },
  { tag: tags.controlKeyword, color: '#c678dd' },
  { tag: tags.typeName, color: '#e5c07b' },           // types: INTEGER, VARCHAR
  { tag: tags.string, color: '#98c379' },              // green strings
  { tag: tags.number, color: '#d19a66' },              // orange numbers
  { tag: tags.bool, color: '#d19a66' },
  { tag: tags.null, color: '#d19a66' },
  { tag: tags.comment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.operator, color: '#56b6c2' },            // =, <, >
  { tag: tags.punctuation, color: '#abb2bf' },
  { tag: tags.bracket, color: '#abb2bf' },
  { tag: tags.variableName, color: '#e6edf3' },
  { tag: tags.propertyName, color: '#61afef' },        // column/table names
  { tag: tags.function(tags.variableName), color: '#61afef' },
  { tag: tags.standard(tags.name), color: '#e5c07b' },
  { tag: tags.special(tags.string), color: '#98c379' },  // quoted identifiers "public"
  { tag: tags.literal, color: '#d19a66' },
  { tag: tags.name, color: '#e6edf3' },
  { tag: tags.content, color: '#e6edf3' },
]);

// Error line decoration system
const setErrorLine = StateEffect.define<number | null>();

const errorLineDecoration = Decoration.line({ class: 'cm-errorLine' });

const errorLineField = StateField.define({
  create() { return Decoration.none; },
  update(decorations, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        if (e.value === null) return Decoration.none;
        const lineNum = e.value;
        if (lineNum < 1 || lineNum > tr.state.doc.lines) return Decoration.none;
        const line = tr.state.doc.line(lineNum);
        return RangeSet.of([errorLineDecoration.range(line.from)]);
      }
    }
    return decorations.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

class ErrorGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.style.cssText = 'color: #f85149; font-size: 14px; line-height: 1;';
    el.textContent = '\u25CF'; // filled circle
    return el;
  }
}

const errorGutterMarker = new ErrorGutterMarker();

const errorGutter = gutter({
  class: 'cm-error-gutter',
  markers(view) {
    const decos = view.state.field(errorLineField);
    const markers: { from: number; marker: GutterMarker }[] = [];
    const iter = decos.iter();
    while (iter.value) {
      markers.push({ from: iter.from, marker: errorGutterMarker });
      iter.next();
    }
    return RangeSet.of(markers.map(m => m.marker.range(m.from)));
  },
});

// ── SQL Templates with $N placeholders ──
const PLACEHOLDER_RE = /\$\d+/g;

interface SQLTemplate {
  label: string;        // display label (SQL keyword name — same in all locales)
  sql: string;          // template body with $1, $2, … placeholders
}

const SQL_TEMPLATES: SQLTemplate[] = [
  { label: 'SELECT',          sql: 'SELECT $1\nFROM $2\nWHERE $3;' },
  { label: 'INSERT',          sql: 'INSERT INTO $1 ($2)\nVALUES ($3);' },
  { label: 'UPDATE',          sql: 'UPDATE $1\nSET $2 = $3\nWHERE $4;' },
  { label: 'DELETE',          sql: 'DELETE FROM $1\nWHERE $2;' },
  { label: 'CREATE TABLE',    sql: 'CREATE TABLE $1 (\n  $2 $3 NOT NULL,\n  $4 $5\n);' },
  { label: 'CREATE INDEX',    sql: 'CREATE INDEX $1\nON $2 ($3);' },
  { label: 'EXPLAIN ANALYZE', sql: 'EXPLAIN ANALYZE\n$1;' },
];

/** Find all $N placeholder positions in `text`, ordered by N then by occurrence. */
function findPlaceholders(text: string): { from: number; to: number }[] {
  const hits: { from: number; to: number; n: number }[] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    hits.push({ from: m.index, to: m.index + m[0].length, n: parseInt(m[0].slice(1), 10) });
  }
  hits.sort((a, b) => a.n - b.n || a.from - b.from);
  return hits.map(({ from, to }) => ({ from, to }));
}

export interface SQLEditorHandle {
  insertText: (text: string) => void;
  replaceSelection: (text: string) => void;
  focus: () => void;
  getSelectedSQL: () => string;
}

interface SQLEditorProps {
  onExecuteQuery: (query: string) => void;
  onImproveQuery?: (sql: string) => void;
  isImproving?: boolean;
  tabs: SQLTab[];
  activeTab: SQLTab | null;
  activeTabId: string | null;
  onTabChange: (tabId: string) => void;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab?: (tabId: string, title: string) => void;
  onContentChange: (tabId: string, content: string) => void;
  databaseInfo?: DatabaseInfo | null;
  errorLine?: number | null;
  activeConnection?: DatabaseServer | null;
  connections?: DatabaseServer[];
  connectionErrors?: Record<string, string>;
  onSwitchConnection?: (connectionId: string, database?: string) => void;
}

const SQLEditor = forwardRef<SQLEditorHandle, SQLEditorProps>(function SQLEditor({
  onExecuteQuery, onImproveQuery, isImproving = false,
  tabs, activeTab, activeTabId, onTabChange, onCreateTab, onCloseTab, onRenameTab, onContentChange,
  databaseInfo, errorLine = null,
  activeConnection = null, connections = [], connectionErrors = {}, onSwitchConnection,
}, ref) {
  const { actualTheme } = useTheme();
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [query, setQuery] = useState(activeTab?.content ?? '');
  const [isExecuting, setIsExecuting] = useState(false);
  const [connectionMenuAnchor, setConnectionMenuAnchor] = useState<HTMLElement | null>(null);
  const [expandedEditorConnId, setExpandedEditorConnId] = useState<string | null>(null);
  const [templateMenuAnchor, setTemplateMenuAnchor] = useState<HTMLElement | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const prevTabCountRef = useRef(tabs.length);
  const sqlCompartment = useRef(new Compartment());
  // Placeholder positions (absolute offsets) for Tab-navigation after template insertion
  const placeholdersRef = useRef<{ from: number; to: number }[]>([]);
  const placeholderIdxRef = useRef<number>(-1);

  // AI Autocomplete
  const agent = useAgent();
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const databaseInfoRef = useRef(databaseInfo);
  databaseInfoRef.current = databaseInfo;
  const autocompleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutocompletePos = useRef<number>(-1);

  // Auto-scroll tabs container when new tab is added
  useEffect(() => {
    if (tabs.length > prevTabCountRef.current && tabsScrollRef.current) {
      tabsScrollRef.current.scrollLeft = tabsScrollRef.current.scrollWidth;
    }
    prevTabCountRef.current = tabs.length;
  }, [tabs.length]);

  // Track which tab the editor was last initialized for
  const currentTabIdRef = useRef<string | null>(null);
  // Flag to suppress content change callback during programmatic doc replacement
  const suppressContentChangeRef = useRef(false);

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const cursor = view.state.selection.main.head;
      view.dispatch({
        changes: { from: cursor, insert: text },
        selection: { anchor: cursor + text.length },
      });
      view.focus();
    },
    replaceSelection(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      if (sel.from === sel.to) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          annotations: Transaction.userEvent.of('input'),
        });
      } else {
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
          annotations: Transaction.userEvent.of('input'),
        });
      }
      view.focus();
    },
    focus() {
      viewRef.current?.focus();
    },
    getSelectedSQL() {
      const view = viewRef.current;
      if (!view) return '';
      const sel = view.state.selection.main;
      if (sel.from !== sel.to) {
        return view.state.sliceDoc(sel.from, sel.to);
      }
      return '';
    },
  }), []);

  // Initialize CodeMirror editor
  useEffect(() => {
    if (editorRef.current) {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
        setEditorView(null);
      }
      if (editorRef.current) {
        editorRef.current.innerHTML = '';
      }

      try {
        const updateListener = EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newQuery = update.state.doc.toString();
            setQuery(newQuery);
            if (!suppressContentChangeRef.current && currentTabIdRef.current) {
              onContentChange(currentTabIdRef.current, newQuery);
            }
            // Debounced AI autocomplete
            if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current);
            agentRef.current.cancelAutocomplete();
            // Autocomplete: 500ms debounce, min 3 chars after last space, skip strings/comments
            const cursorPos = update.state.selection.main.head;
            const textBeforeCursor = newQuery.slice(0, cursorPos);
            const lastSpaceIdx = textBeforeCursor.lastIndexOf(' ');
            const charsAfterSpace = lastSpaceIdx === -1 ? textBeforeCursor.length : textBeforeCursor.length - lastSpaceIdx - 1;
            // Skip if cursor is inside a string or comment
            const isInStringOrComment = (() => {
              const before = textBeforeCursor;
              const singleQuotes = (before.match(/'/g) || []).length;
              if (singleQuotes % 2 !== 0) return true; // inside single-quoted string
              const doubleQuotes = (before.match(/"/g) || []).length;
              if (doubleQuotes % 2 !== 0) return true; // inside double-quoted identifier
              // Check line comment (-- ...)
              const lastNewline = before.lastIndexOf('\n');
              const currentLine = lastNewline === -1 ? before : before.slice(lastNewline + 1);
              if (currentLine.includes('--')) return true;
              // Check block comment /* ... */
              const lastBlockOpen = before.lastIndexOf('/*');
              const lastBlockClose = before.lastIndexOf('*/');
              if (lastBlockOpen > lastBlockClose) return true;
              return false;
            })();
            // Autocomplete is available for trial and paid plans (not free after trial expiry)
            const plan = agentRef.current.usage?.plan;
            const autocompleteAllowed = plan && plan !== 'free';
            if (agentRef.current.isConnected && autocompleteAllowed && charsAfterSpace >= 3 && !isInStringOrComment) {
              autocompleteTimer.current = setTimeout(() => {
                if (!viewRef.current) return;
                const currentPos = viewRef.current.state.selection.main.head;
                if (currentPos === lastAutocompletePos.current) return;
                lastAutocompletePos.current = currentPos;
                const dbInfo = databaseInfoRef.current;
                const schemaCtx = dbInfo
                  ? Object.entries(dbInfo.schemas || {}).map(([schema, info]: [string, any]) =>
                      `Schema "${schema}":\n` + (info.tables || []).map((t: any) =>
                        `  ${schema}.${t.name}(${(t.columns || []).map((c: any) => `${c.name} ${c.type || ''}`).join(', ')})`
                      ).join('\n')
                    ).join('\n')
                  : '';
                const doc = viewRef.current.state.doc.toString();
                agentRef.current.sendAutocomplete(doc, currentPos, schemaCtx, (completion) => {
                  if (!viewRef.current) return;
                  const nowPos = viewRef.current.state.selection.main.head;
                  if (nowPos === currentPos && completion) {
                    showGhostText(viewRef.current, completion, currentPos);
                  }
                });
              }, 500);
            }
          }
        });

        const sqlSchema = buildSQLSchema(databaseInfo);
        const extensions = [
          ghostTextExtension(), // Must be before indentWithTab so Tab accepts ghost text first
          basicSetup,
          keymap.of([
            indentWithTab,
            { key: 'Mod-r', run: openSearchPanel },
          ]),
          indentUnit.of('  '),
          sqlCompartment.current.of(sql({
            dialect: PostgreSQL,
            schema: sqlSchema,
            upperCaseKeywords: true,
          })),
          updateListener,
          errorLineField,
          errorGutter,
          EditorView.theme({
            "&": { height: "100%", maxHeight: "100%", overflow: "auto" },
            ".cm-scroller": { overflow: "auto", maxHeight: "100%", overscrollBehavior: "contain" },
            ".cm-errorLine": { backgroundColor: "rgba(248, 81, 73, 0.15)" },
            ".cm-error-gutter": { width: "16px" },
          }),
          EditorView.domEventHandlers({
            wheel: () => false,
          }),
        ];

        if (actualTheme === 'dark') {
          extensions.push(progreSQLDarkTheme, syntaxHighlighting(progreSQLHighlight));
        }

        const state = EditorState.create({
          doc: activeTab?.content ?? '',
          extensions,
        });

        const view = new EditorView({
          state,
          parent: editorRef.current,
        });

        setEditorView(view);
        viewRef.current = view;
        currentTabIdRef.current = activeTabId;
        setQuery(activeTab?.content ?? '');
      } catch (error) {
        log.error('Error initializing CodeMirror:', error);
      }
    }

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
        setEditorView(null);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualTheme]);

  // When active tab changes, swap editor content
  useEffect(() => {
    if (!activeTabId || activeTabId === currentTabIdRef.current) return;
    const view = viewRef.current;
    if (!view) return;

    const newContent = activeTab?.content ?? '';
    suppressContentChangeRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newContent },
    });
    suppressContentChangeRef.current = false;
    currentTabIdRef.current = activeTabId;
    setQuery(newContent);
  }, [activeTabId, activeTab]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, []);

  // Update autocomplete schema when database info changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const sqlSchema = buildSQLSchema(databaseInfo);
    view.dispatch({
      effects: sqlCompartment.current.reconfigure(sql({
        dialect: PostgreSQL,
        schema: sqlSchema,
        upperCaseKeywords: true,
      })),
    });
  }, [databaseInfo]);

  // Apply error line decoration when errorLine prop changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine]);

  const getQueryToExecute = useCallback((): string => {
    const view = viewRef.current;
    if (!view) return query.trim();

    const sel = view.state.selection.main;
    if (sel.from !== sel.to) {
      return view.state.sliceDoc(sel.from, sel.to).trim();
    }

    const fullText = view.state.doc.toString();
    const cursorPos = sel.head;

    let start = 0;
    const statements: { text: string; from: number; to: number }[] = [];
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < fullText.length; i++) {
      const ch = fullText[i];
      const next = fullText[i + 1];

      if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
      if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
      if (inSingleQuote) { if (ch === "'" && next === "'") { i++; continue; } if (ch === "'") inSingleQuote = false; continue; }
      if (inDoubleQuote) { if (ch === '"' && next === '"') { i++; continue; } if (ch === '"') inDoubleQuote = false; continue; }

      if (ch === '-' && next === '-') { inLineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
      if (ch === "'") { inSingleQuote = true; continue; }
      if (ch === '"') { inDoubleQuote = true; continue; }

      if (ch === ';') {
        statements.push({ text: fullText.slice(start, i).trim(), from: start, to: i + 1 });
        start = i + 1;
      }
    }
    if (start < fullText.length) {
      statements.push({ text: fullText.slice(start).trim(), from: start, to: fullText.length });
    }

    for (const stmt of statements) {
      if (cursorPos >= stmt.from && cursorPos <= stmt.to && stmt.text) {
        return stmt.text;
      }
    }

    return query.trim();
  }, [query]);

  const abortControllerRef = useRef<AbortController | null>(null);

  const executeQuery = useCallback(async () => {
    const sqlToRun = getQueryToExecute();
    if (!sqlToRun) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsExecuting(true);
    try {
      await onExecuteQuery(sqlToRun);
    } finally {
      abortControllerRef.current = null;
      setIsExecuting(false);
    }
  }, [getQueryToExecute, onExecuteQuery]);

  const cancelQuery = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsExecuting(false);
  }, []);

  const clearEditor = () => {
    if (editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: '' },
      });
    }
  };

  const copyQuery = async () => {
    if (query.trim()) {
      try { await navigator.clipboard.writeText(query.trim()); }
      catch (error) { log.error('Failed to copy query:', error); }
    }
  };

  const improveQuery = () => {
    if (!query.trim() || !onImproveQuery) return;
    const view = viewRef.current;
    let selectedSQL = '';
    if (view) {
      const sel = view.state.selection.main;
      if (sel.from !== sel.to) {
        selectedSQL = view.state.sliceDoc(sel.from, sel.to);
      }
    }
    onImproveQuery(selectedSQL || query.trim());
  };

  const formatQuery = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (!doc.trim()) return;
    try {
      const formatted = formatSQL(doc, {
        language: 'postgresql',
        keywordCase: 'upper',
        tabWidth: 2,
        useTabs: false,
        linesBetweenQueries: 2,
        denseOperators: false,
        newlineBeforeSemicolon: false,
      });
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
        annotations: Transaction.userEvent.of('input'),
      });
    } catch {
      // If formatting fails (invalid SQL), silently ignore
      log.warn('SQL formatting failed');
    }
  }, []);

  /** Insert a SQL template into the editor and select the first placeholder. */
  const insertTemplate = useCallback((tpl: SQLTemplate) => {
    const view = viewRef.current;
    if (!view) return;

    const cursor = view.state.selection.main.head;
    const text = tpl.sql;

    // Insert the template text at cursor
    view.dispatch({
      changes: { from: cursor, insert: text },
      annotations: Transaction.userEvent.of('input'),
    });

    // Compute absolute placeholder positions
    const raw = findPlaceholders(text);
    const phs = raw.map(p => ({ from: p.from + cursor, to: p.to + cursor }));
    placeholdersRef.current = phs;
    placeholderIdxRef.current = -1;

    // Select the first placeholder
    if (phs.length > 0) {
      placeholderIdxRef.current = 0;
      const first = phs[0];
      view.dispatch({
        selection: { anchor: first.from, head: first.to },
      });
    } else {
      view.dispatch({
        selection: { anchor: cursor + text.length },
      });
    }
    view.focus();
    setTemplateMenuAnchor(null);
  }, []);

  /** Advance to the next placeholder. Returns true if handled. */
  const selectNextPlaceholder = useCallback((): boolean => {
    const view = viewRef.current;
    const phs = placeholdersRef.current;
    if (!view || phs.length === 0) return false;

    const idx = placeholderIdxRef.current;
    if (idx < 0 || idx >= phs.length) return false;

    // The current placeholder may have been replaced by user typing.
    // Compute offset delta from original placeholder to what user typed.
    const currentPh = phs[idx];
    const sel = view.state.selection.main;
    // delta = (what user typed length) - (original placeholder length)
    const originalLen = currentPh.to - currentPh.from;
    const typedLen = sel.head - currentPh.from;
    const delta = typedLen - originalLen;

    // Shift all subsequent placeholders by delta
    for (let i = idx + 1; i < phs.length; i++) {
      phs[i] = { from: phs[i].from + delta, to: phs[i].to + delta };
    }

    const nextIdx = idx + 1;
    if (nextIdx >= phs.length) {
      // No more placeholders — clear and let Tab work normally
      placeholdersRef.current = [];
      placeholderIdxRef.current = -1;
      return false;
    }

    placeholderIdxRef.current = nextIdx;
    const next = phs[nextIdx];
    view.dispatch({
      selection: { anchor: next.from, head: next.to },
    });
    view.focus();
    return true;
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      executeQuery();
    }
  };

  useEffect(() => {
    const handleEditorKeyDown = (e: KeyboardEvent) => {
      if (((e.ctrlKey || e.metaKey) && e.key === 'Enter') || e.key === 'F5') {
        e.preventDefault();
        executeQuery();
      }
      if (e.shiftKey && e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        formatQuery();
      }
      // Tab navigation between template placeholders
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (selectNextPlaceholder()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };

    const handleWheel = (e: WheelEvent) => {
      const editorElement = editorRef.current;
      if (editorElement) {
        const scroller = editorElement.querySelector('.cm-scroller');
        if (scroller) {
          scroller.scrollTop += e.deltaY;
          e.preventDefault();
        }
      }
    };

    if (editorRef.current) {
      editorRef.current.addEventListener('keydown', handleEditorKeyDown);
      editorRef.current.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
        if (editorRef.current) {
          editorRef.current.removeEventListener('keydown', handleEditorKeyDown);
          editorRef.current.removeEventListener('wheel', handleWheel);
        }
      };
    }
  }, [executeQuery, formatQuery, selectNextPlaceholder]);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tab bar with integrated toolbar actions */}
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid',
        borderColor: 'rgba(255,255,255,0.08)',
        minHeight: 36,
        bgcolor: 'background.default',
        overflow: 'hidden',
      }}>
        <Box ref={tabsScrollRef} sx={{
          display: 'flex',
          alignItems: 'center',
          flex: 1,
          overflow: 'auto',
          scrollBehavior: 'smooth',
          '&::-webkit-scrollbar': { height: 4 },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.15)', borderRadius: 2 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
        }}>
          {tabs.map((tab) => (
            <Box
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
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
                whiteSpace: 'nowrap',
                bgcolor: tab.id === activeTabId ? 'background.paper' : 'transparent',
                borderBottom: tab.id === activeTabId ? '2px solid' : '2px solid transparent',
                borderBottomColor: tab.id === activeTabId ? 'primary.main' : 'transparent',
                '&:hover': {
                  bgcolor: tab.id === activeTabId ? 'background.paper' : 'action.hover',
                },
              }}
            >
              {editingTabId === tab.id ? (
                <input
                  autoFocus
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={() => {
                    if (editingTitle.trim() && onRenameTab) onRenameTab(tab.id, editingTitle.trim());
                    setEditingTabId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (editingTitle.trim() && onRenameTab) onRenameTab(tab.id, editingTitle.trim());
                      setEditingTabId(null);
                    }
                    if (e.key === 'Escape') setEditingTabId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(99,102,241,0.5)',
                    borderRadius: 3,
                    color: 'inherit',
                    fontSize: '0.75rem',
                    fontFamily: 'inherit',
                    padding: '1px 4px',
                    width: Math.max(40, editingTitle.length * 7 + 16),
                    outline: 'none',
                  }}
                />
              ) : (
                <Typography
                  variant="caption"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingTabId(tab.id);
                    setEditingTitle(tab.title);
                  }}
                  sx={{
                    fontWeight: tab.id === activeTabId ? 600 : 400,
                    color: tab.id === activeTabId ? 'text.primary' : 'text.secondary',
                    fontSize: '0.75rem',
                    cursor: 'default',
                  }}
                >
                  {tab.title}
                </Typography>
              )}
              {tabs.length > 1 && (
                <IconButton
                  size="small"
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                  sx={{
                    p: '1px',
                    opacity: tab.id === activeTabId ? 0.7 : 0,
                    '&:hover': { opacity: 1 },
                    '.MuiBox-root:hover > &': { opacity: 0.5 },
                  }}
                  aria-label={`Close ${tab.title}`}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              )}
            </Box>
          ))}
        </Box>
        <Tooltip title={t('editor.newTab')}>
          <IconButton
            size="small"
            onClick={onCreateTab}
            sx={{ mx: 0.5, p: '3px' }}
            aria-label="New query tab"
          >
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>

        {/* Connection pill/badge */}
        <Tooltip title={activeConnection ? t('editor.switchConnection') : t('editor.noConnection')}>
          <Box
            onClick={(e) => { if (connections.length > 0) { setConnectionMenuAnchor(e.currentTarget); setExpandedEditorConnId(null); } }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              px: 1,
              py: 0.25,
              mx: 0.5,
              borderRadius: '12px',
              cursor: connections.length > 0 ? 'pointer' : 'default',
              bgcolor: 'rgba(255,255,255,0.05)',
              border: '1px solid',
              borderColor: 'rgba(255,255,255,0.1)',
              '&:hover': connections.length > 0 ? {
                bgcolor: 'rgba(255,255,255,0.08)',
                borderColor: 'rgba(255,255,255,0.15)',
              } : {},
              flexShrink: 0,
              maxWidth: 220,
            }}
          >
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: activeConnection
                  ? (connectionErrors[activeConnection.id] ? 'error.main' : activeConnection.isActive ? 'success.main' : 'text.disabled')
                  : 'text.disabled',
                flexShrink: 0,
              }}
            />
            <Typography
              variant="caption"
              sx={{
                fontSize: '0.7rem',
                color: 'text.secondary',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeConnection
                ? `${activeConnection.connectionName || activeConnection.host} · ${activeConnection.activeDatabase || activeConnection.database}`
                : t('editor.noConnection')}
            </Typography>
          </Box>
        </Tooltip>
        <Menu
          anchorEl={connectionMenuAnchor}
          open={Boolean(connectionMenuAnchor)}
          onClose={() => { setConnectionMenuAnchor(null); setExpandedEditorConnId(null); }}
          slotProps={{
            paper: {
              sx: {
                bgcolor: 'rgba(20, 20, 35, 0.85)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: '1px solid rgba(99, 102, 241, 0.4)',
                borderRadius: '12px',
                minWidth: 240,
                maxHeight: 300,
                overflowY: 'auto',
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
                '&::-webkit-scrollbar': { width: 4 },
                '&::-webkit-scrollbar-thumb': { background: 'rgba(99,102,241,0.3)', borderRadius: 2 },
              },
            },
          }}
        >
          {connections.map((conn) => {
            const hasMultiDb = conn.isActive && conn.availableDatabases && conn.availableDatabases.length > 1;
            const isExpanded = expandedEditorConnId === conn.id;
            const isSelected = activeConnection?.id === conn.id;
            const connActiveDb = conn.activeDatabase || conn.database;

            return (
              <Box key={conn.id}>
                <MenuItem
                  selected={isSelected && !hasMultiDb}
                  onClick={() => {
                    if (hasMultiDb) {
                      setExpandedEditorConnId(prev => prev === conn.id ? null : conn.id);
                    } else {
                      if (onSwitchConnection) onSwitchConnection(conn.id);
                      setConnectionMenuAnchor(null);
                      setExpandedEditorConnId(null);
                    }
                  }}
                  sx={{
                    borderRadius: '8px', mx: 0.5, my: 0.25,
                    '&.Mui-selected': { bgcolor: 'rgba(99,102,241,0.15)', '&:hover': { bgcolor: 'rgba(99,102,241,0.25)' } },
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: '28px !important' }}>
                    <Box sx={{
                      width: 8, height: 8, borderRadius: 1,
                      bgcolor: conn.isActive ? (connectionErrors[conn.id] ? 'error.main' : 'success.main') : 'text.disabled',
                    }} />
                  </ListItemIcon>
                  <ListItemText
                    primary={conn.connectionName || conn.host}
                    secondary={`${conn.host}:${conn.port}`}
                    primaryTypographyProps={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.9)' }}
                    secondaryTypographyProps={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.45)' }}
                  />
                  {hasMultiDb && (
                    <Typography sx={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)', ml: 0.5 }}>
                      {connActiveDb} {isExpanded ? '▾' : '▸'}
                    </Typography>
                  )}
                </MenuItem>
                {hasMultiDb && isExpanded && (
                  <Box sx={{ pl: 3, pr: 0.5, pb: 0.5 }}>
                    {conn.availableDatabases!.map((db: any) => {
                      const isActiveDb = db.name === connActiveDb && isSelected;
                      return (
                        <MenuItem
                          key={db.name}
                          selected={isActiveDb}
                          onClick={() => {
                            if (onSwitchConnection) onSwitchConnection(conn.id, db.name);
                            setConnectionMenuAnchor(null);
                            setExpandedEditorConnId(null);
                          }}
                          sx={{
                            borderRadius: '6px', mx: 0, my: 0.25, py: 0.5, minHeight: 28,
                            '&.Mui-selected': { bgcolor: 'rgba(76,175,80,0.15)' },
                            '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
                          }}
                        >
                          <ListItemIcon sx={{ minWidth: '20px !important' }}>
                            <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: isActiveDb ? '#4caf50' : 'rgba(255,255,255,0.25)' }} />
                          </ListItemIcon>
                          <ListItemText
                            primary={db.name}
                            primaryTypographyProps={{ fontSize: '0.75rem', color: isActiveDb ? '#4caf50' : 'rgba(255,255,255,0.8)' }}
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

        {/* Toolbar actions integrated into tab bar */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto', mr: 1, flexShrink: 0 }}>
          <Tooltip title={isImproving ? t('editor.improving') : t('editor.improveTooltip')}>
            <span>
              <IconButton
                onClick={improveQuery}
                disabled={!query.trim() || isImproving || !onImproveQuery}
                aria-label={t('editor.improveAria')}
                size="small"
                sx={{
                  p: '4px',
                  color: isImproving ? 'warning.main' : 'text.primary',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                {isImproving ? (
                  <CircularProgress size={16} color="warning" />
                ) : (
                  <MagicWandIcon sx={{ fontSize: 18 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('editor.formatTooltip')}>
            <span>
              <IconButton onClick={formatQuery} disabled={!query.trim()} size="small" aria-label={t('editor.formatAria')} sx={{ p: '4px' }}>
                <TemplateIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('editor.copyTooltip')}>
            <span>
              <IconButton onClick={copyQuery} disabled={!query.trim()} size="small" aria-label={t('editor.copyAria')} sx={{ p: '4px' }}>
                <CopyIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('editor.clearTooltip')}>
            <span>
              <IconButton onClick={clearEditor} size="small" aria-label={t('editor.clearAria')} sx={{ p: '4px' }}>
                <ClearIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={isExecuting ? t('editor.stopTooltip') : t('editor.runTooltip')}>
            <span>
              {isExecuting ? (
                <Button
                  variant="contained"
                  startIcon={<StopIcon />}
                  onClick={cancelQuery}
                  size="small"
                  sx={{
                    background: "linear-gradient(135deg, #ef4444, #dc2626, #b91c1c)",
                    '&:hover': { background: "linear-gradient(135deg, #f87171, #ef4444, #dc2626)" },
                    minHeight: 28,
                    py: 0.25,
                    px: 1.5,
                    fontSize: "0.75rem",
                  }}
                >
                  {t('editor.stop')}
                </Button>
              ) : (
                <Button
                  variant="contained"
                  startIcon={<RunIcon />}
                  onClick={executeQuery}
                  disabled={!query.trim()}
                  onKeyDown={handleKeyDown}
                  size="small"
                  sx={{
                    background: "linear-gradient(135deg, #4ade80, #22c55e, #16a34a)",
                    '&:hover': { background: "linear-gradient(135deg, #22c55e, #16a34a, #15803d)" },
                    '&.Mui-disabled': { background: "linear-gradient(135deg, #6ee7b7, #4ade80, #34d399)", color: "rgba(255,255,255,0.7)" },
                    minHeight: 28,
                    py: 0.25,
                    px: 1.5,
                    fontSize: "0.75rem",
                  }}
                >
                  {t('editor.run')}
                </Button>
              )}
            </span>
          </Tooltip>
        </Box>
      </Box>

      {/* Editor */}
      <Box sx={{
        flexGrow: 1,
        position: 'relative',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div
          ref={editorRef}
          role="textbox"
          aria-label="SQL query editor"
          aria-multiline="true"
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            backgroundColor: actualTheme === 'dark' ? '#1a1d23' : '#ffffff',
            color: actualTheme === 'dark' ? '#ffffff' : '#000000',
            maxHeight: '100%',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
          }}
          className={actualTheme === 'light' ? 'light-editor' : ''}
        />
        <style jsx>{`
          .light-editor :global(.cm-selectionBackground),
          .light-editor :global(.cm-selection),
          .light-editor :global(.cm-editor .cm-selectionBackground),
          .light-editor :global(.cm-editor .cm-selection),
          .light-editor :global(.cm-content .cm-selectionBackground),
          .light-editor :global(.cm-content .cm-selection),
          .light-editor :global(.cm-scroller .cm-selectionBackground),
          .light-editor :global(.cm-scroller .cm-selection) {
            background-color: #6366f1 !important;
            color: #ffffff !important;
          }
          .light-editor :global(.cm-editor ::selection),
          .light-editor :global(.cm-content ::selection),
          .light-editor :global(.cm-scroller ::selection) {
            background-color: #6366f1 !important;
            color: #ffffff !important;
          }
          .light-editor :global(.cm-editor),
          .light-editor :global(.cm-content),
          .light-editor :global(.cm-scroller) {
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
          }
          :global(.cm-editor) {
            height: 100% !important;
            max-height: 100% !important;
            overflow: auto !important;
            display: flex !important;
            flex-direction: column !important;
          }
          :global(.cm-scroller) {
            overflow: auto !important;
            max-height: 100% !important;
            height: 100% !important;
            flex: 1 !important;
            scrollbar-width: thin;
            scrollbar-color: rgba(255, 255, 255, 0.2) rgba(255, 255, 255, 0.05);
            overscroll-behavior: contain;
          }
          :global(.cm-content) {
            min-height: auto !important;
            height: auto !important;
            min-height: 100%;
          }
          :global(.cm-editor .cm-scroller) {
            overflow: auto !important;
            overscroll-behavior: auto !important;
          }
          :global(.cm-scroller::-webkit-scrollbar) { width: 8px; height: 8px; }
          :global(.cm-scroller::-webkit-scrollbar-track) { background: rgba(255, 255, 255, 0.05); border-radius: 4px; }
          :global(.cm-scroller::-webkit-scrollbar-thumb) { background: rgba(255, 255, 255, 0.2); border-radius: 4px; }
          :global(.cm-scroller::-webkit-scrollbar-thumb:hover) { background: rgba(255, 255, 255, 0.35); }
        `}</style>
        {!editorView && (
          <Box
            sx={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: actualTheme === 'dark' ? 'background.default' : 'background.paper',
              color: 'text.primary',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              {t('editor.loading')}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
});

export default SQLEditor;
