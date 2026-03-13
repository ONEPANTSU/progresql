import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
  Box,
  Typography,
  Button,
  IconButton,
  Tooltip,
  CircularProgress,
} from '@mui/material';
import {
  PlayArrow as RunIcon,
  Clear as ClearIcon,
  ContentCopy as CopyIcon,
  AutoFixHigh as MagicWandIcon,
  Add as AddIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Transaction } from '@codemirror/state';
import { sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorView as EditorViewTheme } from '@codemirror/view';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { createLogger } from '../utils/logger';
import { SQLTab } from '../types';

const log = createLogger('SQLEditor');

// Custom dark theme matching chat SQL colors
const progreSQLDarkTheme = EditorViewTheme.theme({
  '&': { backgroundColor: '#1a1d23', color: '#e6edf3' },
  '.cm-content': { caretColor: '#58a6ff' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#58a6ff' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#264f78' },
  '.cm-panels': { backgroundColor: '#161b22', color: '#e6edf3' },
  '.cm-panels.cm-panels-top': { borderBottom: '2px solid #30363d' },
  '.cm-panels.cm-panels-bottom': { borderTop: '2px solid #30363d' },
  '.cm-searchMatch': { backgroundColor: '#e2c08d80', outline: '1px solid #c8a97199' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#6199ff40' },
  '.cm-activeLine': { backgroundColor: '#161b2280' },
  '.cm-selectionMatch': { backgroundColor: '#e2c08d40' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: '#ffffff22' },
  '.cm-gutters': { backgroundColor: '#1a1d23', color: '#484f58', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: '#161b2280' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: '#484f58' },
  '.cm-tooltip': { border: '1px solid #30363d', backgroundColor: '#161b22' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: '#161b22', borderBottomColor: '#161b22' },
  '.cm-tooltip-autocomplete': { '& > ul > li[aria-selected]': { backgroundColor: '#264f78', color: '#e6edf3' } },
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
]);

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
  onContentChange: (tabId: string, content: string) => void;
}

const SQLEditor = forwardRef<SQLEditorHandle, SQLEditorProps>(function SQLEditor({
  onExecuteQuery, onImproveQuery, isImproving = false,
  tabs, activeTab, activeTabId, onTabChange, onCreateTab, onCloseTab, onContentChange,
}, ref) {
  const { actualTheme } = useTheme();
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [query, setQuery] = useState(activeTab?.content ?? '');
  const [isExecuting, setIsExecuting] = useState(false);
  const prevTabCountRef = useRef(tabs.length);

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
          }
        });

        const extensions = [
          basicSetup,
          sql(),
          updateListener,
          EditorView.theme({
            "&": { height: "100%", maxHeight: "100%", overflow: "auto" },
            ".cm-scroller": { overflow: "auto", maxHeight: "100%", overscrollBehavior: "contain" },
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

  const executeQuery = useCallback(async () => {
    const sqlToRun = getQueryToExecute();
    if (!sqlToRun) return;
    setIsExecuting(true);
    try {
      await onExecuteQuery(sqlToRun);
    } finally {
      setIsExecuting(false);
    }
  }, [getQueryToExecute, onExecuteQuery]);

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
  }, [executeQuery]);

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
              <Typography
                variant="caption"
                sx={{
                  fontWeight: tab.id === activeTabId ? 600 : 400,
                  color: tab.id === activeTabId ? 'text.primary' : 'text.secondary',
                  fontSize: '0.75rem',
                }}
              >
                {tab.title}
              </Typography>
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
                  color: isImproving ? 'warning.main' : 'text.secondary',
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
          <Tooltip title={t('editor.runTooltip')}>
            <span>
              <Button
                variant="contained"
                startIcon={<RunIcon />}
                onClick={executeQuery}
                disabled={!query.trim() || isExecuting}
                onKeyDown={handleKeyDown}
                size="small"
                sx={{
                  bgcolor: 'success.main',
                  '&:hover': { bgcolor: 'success.dark' },
                  minHeight: 28,
                  py: 0.25,
                  px: 1.5,
                  fontSize: '0.75rem',
                }}
              >
                {isExecuting ? t('editor.executing') : t('editor.run')}
              </Button>
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
