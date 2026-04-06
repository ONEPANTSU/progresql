import React, { useMemo } from 'react';
import {
  Box,
  Typography,
  ListItem,
  Avatar,
  Button,
  Tooltip,
} from '@mui/material';
import {
  AutoAwesome as BotIcon,
  Person as UserIcon,
  ContentCopy as CopyIcon,
  PlayArrow as RunIcon,
} from '@mui/icons-material';
import { Message } from '@/shared/types';
import SQLBlock from './SQLBlock';
import ChartBlock from './ChartBlock';
import { createLogger } from '@/shared/lib/logger';
import { highlightSQL } from '@/shared/lib/sqlHighlight';

const log = createLogger('ChatMessage');

/** Format model ID to short display name */
function formatModelDisplay(modelId: string): string {
  const parts = modelId.split('/');
  return parts.length > 1 ? parts[1] : modelId;
}

interface ChatMessageProps {
  message: Message;
  isTyping?: boolean;
  isAgentConnected?: boolean;
  isDatabaseConnected?: boolean;
  safeMode?: boolean;
  securityMode?: 'safe' | 'data' | 'execute';
  connectionId?: string;
  onExplainSQL?: (sql: string) => void;
  onApplySQL?: (sql: string) => void;
  onExecuteQuery?: (query: string) => void;
  onRefreshVisualization?: () => void;
}

function isSQLCode(text: string): boolean {
  const trimmedText = text.trim();
  if (!trimmedText) return false;
  if (trimmedText.includes('```')) return false;
  if (trimmedText.includes('**') || trimmedText.includes('\u2022') || trimmedText.includes('\u{1F4A1}') ||
      trimmedText.includes('\u0412\u043E\u0442') || trimmedText.includes('\u0412\u044B \u043C\u043E\u0436\u0435\u0442\u0435') ||
      trimmedText.includes('SQL-\u0437\u0430\u043F\u0440\u043E\u0441') || trimmedText.includes('\u0437\u0430\u043F\u0440\u043E\u0441 \u0434\u043B\u044F')) {
    return false;
  }

  const lines = trimmedText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;

  const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'WITH'];
  const sqlClauses = ['FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
                      'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT'];

  const allLinesAreSQL = lines.every(line => {
    const trimmedLine = line.trim().toUpperCase();
    if (trimmedLine.startsWith('--') || trimmedLine.startsWith('/*')) return true;
    return sqlKeywords.some(kw => trimmedLine.startsWith(kw)) ||
           sqlClauses.some(clause => trimmedLine.startsWith(clause)) ||
           trimmedLine.match(/^[A-Z_][A-Z0-9_]*\s*=/) ||
           trimmedLine.match(/^[A-Z_][A-Z0-9_.]*\s*\(/) ||
           trimmedLine.match(/^[A-Z_][A-Z0-9_.]*\s*,/) ||
           trimmedLine === ';' || trimmedLine === '';
  });

  const firstLine = lines[0].trim().toUpperCase();
  const startsWithSQL = sqlKeywords.some(kw => firstLine.startsWith(kw));

  return startsWithSQL && allLinesAreSQL;
}

function processInlineFormatting(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} style={{ fontWeight: 'bold' }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    log.error('Failed to copy text:', error);
  }
}

/* -- Markdown table helpers ------------------------------------------------ */

/** Returns true when a line looks like a markdown table row: `| ... | ... |` */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1;
}

/** Returns true for the separator row, e.g. `|---|:---:|---:|` */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false;
  const inner = trimmed.slice(1, -1);
  return inner.split('|').every(cell => /^\s*:?-+:?\s*$/.test(cell));
}

/** Parse a `| a | b | c |` row into an array of trimmed cell strings. */
function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  // Remove leading and trailing pipes, then split on inner pipes.
  const inner = trimmed.slice(1, -1);
  return inner.split('|').map(c => c.trim());
}

interface MarkdownTableProps {
  headers: string[];
  rows: string[][];
}

/** Renders a markdown table with theme-aware dark/light styling. */
const MarkdownTable: React.FC<MarkdownTableProps> = ({ headers, rows }) => (
  <Box
    sx={{
      my: 1.5,
      overflowX: 'auto',
      borderRadius: 1,
      border: '1px solid',
      borderColor: 'grey.200',
    }}
  >
    <Box
      component="table"
      sx={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '0.8125rem',
        fontFamily: '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <Box component="thead">
        <Box component="tr">
          {headers.map((header, idx) => (
            <Box
              key={idx}
              component="th"
              sx={{
                px: 1.5,
                py: 1,
                textAlign: 'left',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                borderBottom: '2px solid',
                borderColor: 'grey.300',
                bgcolor: 'grey.100',
                color: 'text.primary',
                '&:not(:last-child)': {
                  borderRight: '1px solid',
                  borderRightColor: 'grey.200',
                },
              }}
            >
              {processInlineFormatting(header)}
            </Box>
          ))}
        </Box>
      </Box>
      <Box component="tbody">
        {rows.map((row, rowIdx) => (
          <Box
            key={rowIdx}
            component="tr"
            sx={{
              '&:hover': {
                bgcolor: 'action.hover',
              },
              '&:not(:last-child) > *': {
                borderBottom: '1px solid',
                borderColor: 'grey.200',
              },
            }}
          >
            {headers.map((_, cellIdx) => (
              <Box
                key={cellIdx}
                component="td"
                sx={{
                  px: 1.5,
                  py: 0.75,
                  color: 'text.primary',
                  lineHeight: 1.5,
                  '&:not(:last-child)': {
                    borderRight: '1px solid',
                    borderRightColor: 'grey.200',
                  },
                }}
              >
                {processInlineFormatting(row[cellIdx] ?? '')}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  </Box>
);

/* -- End markdown table helpers -------------------------------------------- */

interface RenderMarkdownProps {
  text: string;
  isTyping?: boolean;
  isAgentConnected?: boolean;
  isDatabaseConnected?: boolean;
  safeMode?: boolean;
  securityMode?: 'safe' | 'data' | 'execute';
  connectionId?: string;
  onExplainSQL?: (sql: string) => void;
  onApplySQL?: (sql: string) => void;
  onExecuteQuery?: (query: string) => void;
}

const RenderMarkdown: React.FC<RenderMarkdownProps> = ({
  text,
  isTyping,
  isAgentConnected,
  isDatabaseConnected,
  safeMode,
  securityMode,
  connectionId,
  onExplainSQL,
  onApplySQL,
  onExecuteQuery,
}) => {
  const lines = text.split('\n');
  const elements: JSX.Element[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // -- Markdown table ------------------------------------------------------
    // Detect a table: header row, separator row, then data rows.
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = parseTableCells(line);
      i++; // skip separator line
      const tableRows: string[][] = [];
      i++; // move to first data row
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        tableRows.push(parseTableCells(lines[i]));
        i++;
      }
      // The for-loop will i++ again, so step back one.
      i--;

      elements.push(
        <MarkdownTable key={`table-${i}`} headers={headers} rows={tableRows} />
      );
      continue;
    }

    // Markdown headings: #, ##, ###, ####
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const variants: Record<number, 'h5' | 'h6' | 'subtitle1' | 'subtitle2'> = {
        1: 'h5', 2: 'h6', 3: 'subtitle1', 4: 'subtitle2',
      };
      elements.push(
        <Typography key={i} variant={variants[level] || 'subtitle1'} sx={{ fontWeight: 'bold', mt: 1, mb: 0.25, color: 'primary.main' }}>
          {processInlineFormatting(headingMatch[2])}
        </Typography>
      );
    } else if (line.startsWith('**') && line.endsWith('**')) {
      elements.push(
        <Typography key={i} variant="h6" sx={{ fontWeight: 'bold', mt: 1, mb: 0.25, color: 'primary.main' }}>
          {line.slice(2, -2)}
        </Typography>
      );
    } else if (line.match(/^\s*[-*\u2022]\s/) || line.startsWith('\u2022')) {
      const content = line.replace(/^\s*[-*\u2022]\s*/, '').trim();
      const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
      elements.push(
        <Typography key={i} variant="body2" sx={{ ml: 2 + indent / 2, mb: 0.25, display: 'flex', alignItems: 'flex-start' }}>
          <span style={{ marginRight: '8px' }}>{'\u2022'}</span>
          <span>{processInlineFormatting(content)}</span>
        </Typography>
      );
    } else if (line.match(/^\s*\d+\.\s/)) {
      const numMatch = line.match(/^\s*(\d+)\.\s(.+)$/);
      if (numMatch) {
        const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
        elements.push(
          <Typography key={i} variant="body2" sx={{ ml: 2 + indent / 2, mb: 0.25, display: 'flex', alignItems: 'flex-start' }}>
            <span style={{ marginRight: '8px', minWidth: '1.2em' }}>{numMatch[1]}.</span>
            <span>{processInlineFormatting(numMatch[2])}</span>
          </Typography>
        );
      }
    } else if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      const language = line.trimStart().replace('```', '').trim() || 'text';
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      const codeContent = codeLines.join('\n');
      const isSQL = language === 'sql' || isSQLCode(codeContent);

      if (isSQL) {
        elements.push(
          <SQLBlock
            key={i}
            sql={codeContent}
            isTyping={isTyping}
            isAgentConnected={isAgentConnected}
            isDatabaseConnected={isDatabaseConnected}
            safeMode={safeMode}
            securityMode={securityMode}
            connectionId={connectionId}
            onExplain={onExplainSQL}
            onApply={onApplySQL}
            onExecute={onExecuteQuery}
          />
        );
      } else {
        elements.push(
          <Box key={i} sx={{ my: 1 }}>
            <Box
              component="pre"
              sx={{
                bgcolor: 'grey.50',
                p: 1.5,
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'grey.200',
                fontFamily: 'monospace',
                fontSize: '0.8125rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflow: 'auto',
                maxHeight: '300px',
              }}
            >
              {codeContent}
            </Box>
          </Box>
        );
      }
    } else if (line.startsWith('\u2192')) {
      elements.push(
        <Typography key={i} variant="body2" sx={{ ml: 2, mb: 0.5, fontStyle: 'italic', color: 'text.secondary' }}>
          {processInlineFormatting(line)}
        </Typography>
      );
    } else if (line.trim()) {
      elements.push(
        <Typography key={i} variant="body2" sx={{ mb: 0.4, lineHeight: 1.5 }}>
          {processInlineFormatting(line)}
        </Typography>
      );
    } else {
      // skip empty lines — spacing handled by mb on elements
    }
  }

  return <>{elements}</>;
};

const sqlHighlightStyles = {
  '& .hljs-keyword': { color: '#0033b3', fontWeight: 'bold' },
  '& .hljs-built_in': { color: '#0033b3' },
  '& .hljs-type': { color: '#0033b3' },
  '& .hljs-string': { color: '#067d17' },
  '& .hljs-number': { color: '#1750eb' },
  '& .hljs-comment': { color: '#8c8c8c', fontStyle: 'italic' },
  '& .hljs-operator': { color: '#0033b3' },
  '& .hljs-punctuation': { color: '#383a42' },
  '& .hljs-literal': { color: '#0033b3' },
};

const HighlightedSQLPre: React.FC<{ sql: string }> = ({ sql }) => {
  const html = useMemo(() => highlightSQL(sql), [sql]);
  return (
    <Box
      component="pre"
      dangerouslySetInnerHTML={{ __html: html }}
      className="hljs"
      sx={{
        bgcolor: 'grey.50',
        color: 'text.primary',
        border: '1px solid',
        borderColor: 'grey.300',
        borderRadius: 1,
        p: 1.5,
        mb: 1,
        fontFamily: 'monospace',
        fontSize: '0.875rem',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflow: 'auto',
        maxHeight: '300px',
        ...sqlHighlightStyles,
      }}
    />
  );
};

/**
 * Streaming renderer — renders markdown in real-time with a blinking cursor.
 * Uses the same RenderMarkdown component as completed messages for consistent styling.
 */
const StreamingText: React.FC<{ text: string }> = ({ text }) => (
  <Box
    sx={{
      '&::after': {
        content: '"\\2588"',
        animation: 'blink 1s step-end infinite',
        '@keyframes blink': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0 },
        },
      },
    }}
  >
    <RenderMarkdown text={text} />
  </Box>
);

const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  isTyping,
  isAgentConnected,
  isDatabaseConnected,
  safeMode,
  securityMode,
  connectionId,
  onExplainSQL,
  onApplySQL,
  onExecuteQuery,
  onRefreshVisualization,
}) => {
  const isUser = message.sender === 'user';
  const isStreaming = message.isStreaming === true;
  const isPlainSQL = !isStreaming && isSQLCode(message.text);

  return (
    <ListItem
      sx={{
        flexDirection: isUser ? 'row-reverse' : 'row',
        alignItems: 'flex-start',
        px: 1,
        py: 0.5,
      }}
    >
      <Avatar
        sx={{
          width: 28,
          height: 28,
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          mx: 1,
        }}
      >
        {isUser ? <UserIcon sx={{ fontSize: '1rem' }} /> : <BotIcon sx={{ fontSize: '1rem' }} />}
      </Avatar>
      <Box
        sx={{
          maxWidth: '80%',
          minWidth: 0,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          ...(isUser
            ? { background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff' }
            : { bgcolor: 'background.paper', color: 'text.primary', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }
          ),
          borderRadius: 1.5,
          p: 1.25,
        }}
      >
        {isStreaming ? (
          <StreamingText text={message.text} />
        ) : isPlainSQL ? (
          <Box>
            <HighlightedSQLPre sql={message.text} />
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Tooltip title="Copy SQL">
                <Button
                  size="small"
                  startIcon={<CopyIcon />}
                  onClick={() => copyToClipboard(message.text)}
                  variant="outlined"
                >
                  Copy
                </Button>
              </Tooltip>
              {onExecuteQuery && (
                <Tooltip title="Execute SQL">
                  <Button
                    size="small"
                    startIcon={<RunIcon />}
                    onClick={() => onExecuteQuery(message.text)}
                    variant="contained"
                    color="primary"
                  >
                    Run
                  </Button>
                </Tooltip>
              )}
            </Box>
          </Box>
        ) : (
          <Box>
            <RenderMarkdown
              text={message.text}
              isTyping={isTyping}
              isAgentConnected={isAgentConnected}
              isDatabaseConnected={isDatabaseConnected}
              safeMode={safeMode}
              securityMode={securityMode}
              connectionId={connectionId}
              onExplainSQL={onExplainSQL}
              onApplySQL={onApplySQL}
              onExecuteQuery={onExecuteQuery}
            />
            {message.visualization && (
              <ChartBlock
                visualization={message.visualization}
                onRefresh={onRefreshVisualization}
              />
            )}
          </Box>
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 }}>
          <Typography
            variant="caption"
            sx={{
              opacity: 0.7,
              fontSize: '0.65rem',
            }}
          >
            {message.timestamp.toLocaleTimeString()}
          </Typography>
          {!isUser && message.modelUsed && !isStreaming && (
            <Typography
              variant="caption"
              sx={{
                fontSize: '0.6rem',
                opacity: 0.6,
                color: message.modelTier === 'premium' ? '#f59e0b' : 'text.secondary',
                fontWeight: message.modelTier === 'premium' ? 600 : 400,
              }}
            >
              {formatModelDisplay(message.modelUsed)}
              {message.inputTokens != null && message.outputTokens != null && (
                <> · {message.inputTokens + message.outputTokens} tok</>
              )}
              {message.costRUB != null && message.costRUB > 0 && (
                <> · {message.costRUB.toFixed(2)}₽</>
              )}
            </Typography>
          )}
        </Box>
      </Box>
    </ListItem>
  );
};

export default ChatMessage;
