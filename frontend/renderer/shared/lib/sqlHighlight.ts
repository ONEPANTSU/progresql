import hljs from 'highlight.js/lib/core';
import pgsql from 'highlight.js/lib/languages/pgsql';

hljs.registerLanguage('pgsql', pgsql);

/**
 * Returns HTML string with highlighted SQL syntax.
 * Falls back to escaped plain text if highlighting fails.
 */
export function highlightSQL(code: string): string {
  try {
    return hljs.highlight(code, { language: 'pgsql' }).value;
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
