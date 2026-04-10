/**
 * View SQL generator. Emits statements for the `ViewOp` union:
 *
 *  - create  → `CREATE VIEW ... AS <definition>;`
 *  - drop    → `DROP VIEW IF EXISTS ...;`
 *  - replace → `CREATE OR REPLACE VIEW ... AS <definition>;`
 *              (or `DROP + CREATE` when `forceRecreate` is set, e.g. the
 *              output column list changed)
 *  - rename  → `ALTER VIEW ... RENAME TO ...;`
 *
 * Definitions coming from pg_catalog already end in the raw SELECT body,
 * so we do minimal formatting — just trim trailing semicolons and
 * re-apply a single semicolon terminator so the UI shows something
 * consistent.
 */

import type { ViewOp } from '../types';
import { quoteIdent, quoteQualifiedName } from './../util/sql';

/** Trim trailing whitespace and any number of trailing semicolons. */
function normaliseBody(def: string): string {
  return def.replace(/[;\s]+$/g, '').trim();
}

function splitQualified(qualified: string): { schema: string; name: string } {
  if (qualified.includes('.')) {
    const [schema, name] = qualified.split('.', 2);
    return { schema, name };
  }
  return { schema: 'public', name: qualified };
}

export function renderViewOp(op: ViewOp): string {
  switch (op.kind) {
    case 'create': {
      const qn = quoteQualifiedName(op.objectName);
      const body = normaliseBody(op.definition);
      return `CREATE VIEW ${qn} AS\n${body};`;
    }

    case 'drop': {
      const qn = quoteQualifiedName(op.objectName);
      return `DROP VIEW IF EXISTS ${qn};`;
    }

    case 'replace': {
      const qn = quoteQualifiedName(op.objectName);
      const body = normaliseBody(op.definition);
      if (op.forceRecreate) {
        return [
          `-- Column list changed — ${op.objectName} is dropped and recreated.`,
          `DROP VIEW IF EXISTS ${qn};`,
          `CREATE VIEW ${qn} AS\n${body};`,
        ].join('\n');
      }
      return `CREATE OR REPLACE VIEW ${qn} AS\n${body};`;
    }

    case 'rename': {
      // ALTER VIEW uses the unqualified target name.
      const fromQualified = quoteQualifiedName(op.fromName);
      const { name: toUnqualified } = splitQualified(op.toName);
      return `ALTER VIEW ${fromQualified} RENAME TO ${quoteIdent(toUnqualified)};`;
    }
  }
}
