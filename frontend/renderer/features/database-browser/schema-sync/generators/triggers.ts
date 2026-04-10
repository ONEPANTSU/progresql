/**
 * Trigger SQL generator. Replaces always emit `DROP TRIGGER ... ON table`
 * followed by the captured `CREATE TRIGGER` body.
 */

import type { TriggerOp } from '../types';
import { quoteIdent, quoteQualifiedName } from '../util/sql';

/** Extract the trigger short-name from an `objectName` of form `schema.table.trigger`. */
function extractTriggerName(objectName: string): string {
  const parts = objectName.split('.');
  return parts[parts.length - 1];
}

export function renderTriggerOp(op: TriggerOp): string {
  switch (op.kind) {
    case 'create':
      return op.definition;

    case 'drop': {
      const name = extractTriggerName(op.objectName);
      return `DROP TRIGGER IF EXISTS ${quoteIdent(name)} ON ${quoteQualifiedName(op.tableName)};`;
    }

    case 'replace': {
      const name = extractTriggerName(op.objectName);
      return [
        `DROP TRIGGER IF EXISTS ${quoteIdent(name)} ON ${quoteQualifiedName(op.tableName)};`,
        op.definition,
      ].join('\n');
    }

    case 'rename': {
      return `ALTER TRIGGER ${quoteIdent(op.fromName)} ON ${quoteQualifiedName(op.tableName)} RENAME TO ${quoteIdent(op.toName)};`;
    }
  }
}
