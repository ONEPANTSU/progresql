/**
 * Domain SQL generator.
 */

import type { DomainOp } from '../types';
import { quoteIdent, quoteQualifiedName } from '../util/sql';

function splitQualified(qualified: string): { schema: string; name: string } {
  if (qualified.includes('.')) {
    const [schema, name] = qualified.split('.', 2);
    return { schema, name };
  }
  return { schema: 'public', name: qualified };
}

export function renderDomainOp(op: DomainOp): string {
  switch (op.kind) {
    case 'create':
      return `CREATE DOMAIN ${quoteQualifiedName(op.objectName)} AS ${op.baseType};`;

    case 'drop':
      return `DROP DOMAIN IF EXISTS ${quoteQualifiedName(op.objectName)};`;

    case 'rebuild': {
      const qn = quoteQualifiedName(op.objectName);
      return [
        `-- Rebuild domain ${op.objectName} (${op.oldBaseType} → ${op.baseType})`,
        `DROP DOMAIN IF EXISTS ${qn};`,
        `CREATE DOMAIN ${qn} AS ${op.baseType};`,
      ].join('\n');
    }

    case 'rename': {
      const fromQn = quoteQualifiedName(op.fromName);
      const { name: toName } = splitQualified(op.toName);
      return `ALTER DOMAIN ${fromQn} RENAME TO ${quoteIdent(toName)};`;
    }
  }
}
