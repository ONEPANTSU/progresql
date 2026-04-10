/**
 * Sequence SQL generator.
 */

import type { SequenceOp, SequenceAttributes } from '../types';
import { quoteIdent, quoteQualifiedName } from '../util/sql';

function splitQualified(qualified: string): { schema: string; name: string } {
  if (qualified.includes('.')) {
    const [schema, name] = qualified.split('.', 2);
    return { schema, name };
  }
  return { schema: 'public', name: qualified };
}

/**
 * Render the clauses shared between `CREATE SEQUENCE` and `ALTER
 * SEQUENCE`. Returns an array of `CLAUSE value` strings, with no
 * leading `AS`/`START` words for fields that are undefined.
 */
function attrClauses(attrs: Partial<SequenceAttributes>): string[] {
  const out: string[] = [];
  if (attrs.dataType) out.push(`AS ${attrs.dataType}`);
  if (attrs.startValue !== undefined) out.push(`START WITH ${attrs.startValue}`);
  if (attrs.increment !== undefined) out.push(`INCREMENT BY ${attrs.increment}`);
  if (attrs.minValue !== undefined) out.push(`MINVALUE ${attrs.minValue}`);
  if (attrs.maxValue !== undefined) out.push(`MAXVALUE ${attrs.maxValue}`);
  if (attrs.cache !== undefined) out.push(`CACHE ${attrs.cache}`);
  if (attrs.cycle !== undefined) out.push(attrs.cycle ? 'CYCLE' : 'NO CYCLE');
  return out;
}

export function renderSequenceOp(op: SequenceOp): string {
  switch (op.kind) {
    case 'create': {
      const qn = quoteQualifiedName(op.objectName);
      const clauses = attrClauses(op.attrs);
      const body = clauses.length > 0 ? ` ${clauses.join(' ')}` : '';
      return `CREATE SEQUENCE ${qn}${body};`;
    }

    case 'drop':
      return `DROP SEQUENCE IF EXISTS ${quoteQualifiedName(op.objectName)};`;

    case 'alter': {
      const qn = quoteQualifiedName(op.objectName);
      const clauses = attrClauses(op.changes);
      if (clauses.length === 0) return `-- (no changes for ${op.objectName})`;
      return `ALTER SEQUENCE ${qn} ${clauses.join(' ')};`;
    }

    case 'rename': {
      const fromQn = quoteQualifiedName(op.fromName);
      const { name: toName } = splitQualified(op.toName);
      return `ALTER SEQUENCE ${fromQn} RENAME TO ${quoteIdent(toName)};`;
    }
  }
}
