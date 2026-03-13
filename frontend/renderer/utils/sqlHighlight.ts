import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';

hljs.registerLanguage('sql', sql);

/**
 * Returns HTML string with highlighted SQL syntax.
 * Falls back to escaped plain text if highlighting fails.
 */
export function highlightSQL(code: string): string {
  try {
    return hljs.highlight(code, { language: 'sql' }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
