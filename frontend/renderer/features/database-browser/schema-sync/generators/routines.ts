/**
 * Function / procedure SQL generator.
 *
 * The `definition` stored on the op is assumed to be the full output of
 * `pg_get_functiondef` — a ready-to-run `CREATE FUNCTION ...` block.
 * The generator only has to:
 *   - `CREATE`  → emit the definition verbatim
 *   - `REPLACE` → rewrite the leading `CREATE` to `CREATE OR REPLACE`
 *   - `DROP`    → emit `DROP FUNCTION|PROCEDURE schema.name(argSig)`
 *   - `RENAME`  → emit `ALTER FUNCTION|PROCEDURE ... RENAME TO ...`
 */

import type { RoutineOp } from '../types';
import { quoteIdent, quoteQualifiedName } from '../util/sql';

function normaliseBody(def: string): string {
  return def.replace(/[;\s]+$/g, '').trim() + ';';
}

/**
 * Rewrite `CREATE FUNCTION` / `CREATE PROCEDURE` to `CREATE OR REPLACE ...`
 * if needed. Runs a case-insensitive replace on the leading keyword only.
 */
function toCreateOrReplace(def: string): string {
  const trimmed = def.trimStart();
  if (/^create\s+or\s+replace\s+(function|procedure)/i.test(trimmed)) {
    return normaliseBody(trimmed);
  }
  const replaced = trimmed.replace(
    /^create\s+(function|procedure)/i,
    (_m, kind: string) => `CREATE OR REPLACE ${kind.toUpperCase()}`,
  );
  return normaliseBody(replaced);
}

function splitQualified(qualified: string): { schema: string; name: string } {
  if (qualified.includes('.')) {
    const [schema, name] = qualified.split('.', 2);
    return { schema, name };
  }
  return { schema: 'public', name: qualified };
}

function routineKeyword(category: 'function' | 'procedure'): string {
  return category === 'function' ? 'FUNCTION' : 'PROCEDURE';
}

export function renderRoutineOp(op: RoutineOp): string {
  const kw = routineKeyword(op.category);

  switch (op.kind) {
    case 'create': {
      // Emit the pg_get_functiondef output verbatim.
      return normaliseBody(op.definition);
    }

    case 'replace': {
      if (!op.definition.trim()) {
        return `-- (no body captured for ${op.objectName})`;
      }
      return toCreateOrReplace(op.definition);
    }

    case 'drop': {
      const qn = quoteQualifiedName(op.objectName);
      const sig = op.argSignature || '';
      return `DROP ${kw} IF EXISTS ${qn}${sig};`;
    }

    case 'rename': {
      const fromQn = quoteQualifiedName(op.fromName);
      const { name: toName } = splitQualified(op.toName);
      const sig = op.argSignature || '';
      return `ALTER ${kw} ${fromQn}${sig} RENAME TO ${quoteIdent(toName)};`;
    }
  }
}
