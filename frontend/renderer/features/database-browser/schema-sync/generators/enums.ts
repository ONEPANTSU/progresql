/**
 * Enum SQL generator.
 *
 * Renders every `EnumOp` produced by the differ. Two shapes of statement
 * live here:
 *
 *  - One-shot ops: CREATE TYPE / DROP TYPE / ALTER TYPE ... RENAME TO /
 *    ALTER TYPE ... ADD VALUE / ALTER TYPE ... RENAME VALUE. These are
 *    straight-forward single-statement emissions, routed to the correct
 *    planner phase (`pre-commit` for ADD VALUE so it lands in its own tx).
 *
 *  - DROP VALUE: Postgres has no `DROP VALUE` syntax, so we run the
 *    **rebuild dance**:
 *
 *        CREATE TYPE tmp AS ENUM (remaining values…);
 *        ALTER TABLE a ALTER COLUMN c TYPE tmp USING (
 *          CASE c::text WHEN 'dropped' THEN 'replacement'::tmp
 *                       ELSE c::text::tmp END);
 *        DROP TYPE old CASCADE;  -- only after every dep has been switched
 *        ALTER TYPE tmp RENAME TO old;
 *
 *    The set of dependent columns is discovered from the `DatabaseInfo`
 *    passed in via `configureEnumGeneratorContext` — the differ has no
 *    knowledge of tables, so the generator owns this extra context.
 *
 * Dependency context
 * ------------------
 * `EnumGeneratorContext` carries the source-side DatabaseInfo so we can
 * locate every table column that uses the enum (`udt_name` match). We
 * purposefully look at the **source** snapshot because that represents the
 * post-migration shape we are heading to; the user already agreed to drop
 * the value there, so every column still using the enum is expected to
 * remain on the rebuilt type.
 */

import type { DatabaseInfo, Column, Table } from '@/shared/types';
import type {
  EnumOp,
  EnumCreateOp,
  EnumDropOp,
  EnumRenameTypeOp,
  EnumAddValueOp,
  EnumRenameValueOp,
  EnumDropValueOp,
} from '../types';
import { quoteIdent, quoteLiteral, quoteQualifiedName } from '../util/sql';

// ---------------------------------------------------------------------------
// Context — table column index keyed by unqualified enum name.
// ---------------------------------------------------------------------------

export interface EnumDependency {
  /** Schema-qualified table name, e.g. `public.orders`. */
  tableName: string;
  column: Column;
}

interface EnumGeneratorContext {
  /** unqualified enum name -> list of dependent columns */
  enumDeps: Map<string, EnumDependency[]>;
}

let ctx: EnumGeneratorContext = { enumDeps: new Map() };

/**
 * Build the dependency index from the **target** database snapshot. The
 * DROP VALUE rebuild dance must ALTER every column that *currently* uses
 * the enum type in the live DB. Using the source snapshot would include
 * columns that don't exist yet (they'll be ADDed by the same migration
 * and will already reference the rebuilt type).
 */
export function configureEnumGeneratorContext(targetDb: DatabaseInfo): void {
  const enumDeps = new Map<string, EnumDependency[]>();
  for (const tbl of targetDb.tables || []) {
    const tableName = `${tbl.table_schema || 'public'}.${tbl.table_name}`;
    for (const col of tbl.columns || []) {
      // information_schema surfaces custom types as USER-DEFINED with
      // `udt_name` set to the type's unqualified name. Array columns use
      // the element type with a leading underscore — handle both.
      const udt = (col.udt_name || '').replace(/^_/, '');
      if (!udt) continue;
      if (!enumDeps.has(udt)) enumDeps.set(udt, []);
      enumDeps.get(udt)!.push({ tableName, column: col });
    }
  }
  ctx = { enumDeps };
}

/** Exposed for tests / callers that want to inspect the resolved map. */
export function getConfiguredEnumContext(): Readonly<EnumGeneratorContext> {
  return ctx;
}

function unqualifiedName(qn: string): string {
  const dot = qn.indexOf('.');
  return dot >= 0 ? qn.slice(dot + 1) : qn;
}

// ---------------------------------------------------------------------------
// One-shot renderers
// ---------------------------------------------------------------------------

function renderCreate(op: EnumCreateOp): string {
  const values = op.values.map(quoteLiteral).join(', ');
  return `CREATE TYPE ${quoteQualifiedName(op.objectName)} AS ENUM (${values});`;
}

function renderDrop(op: EnumDropOp): string {
  // CASCADE is intentional — `DROP TYPE` without it fails when any column
  // still references the type; we expect the user to have already handled
  // dependent columns via the matching DROP TABLE / ALTER COLUMN ops, so
  // CASCADE is only a safety net. A warning comment makes the intent clear.
  return [
    `-- WARNING: drops enum type and any dependent columns/defaults that remain`,
    `DROP TYPE ${quoteQualifiedName(op.objectName)} CASCADE;`,
  ].join('\n');
}

function renderRenameType(op: EnumRenameTypeOp): string {
  return `ALTER TYPE ${quoteQualifiedName(op.fromName)} RENAME TO ${quoteIdent(
    unqualifiedName(op.toName),
  )};`;
}

function renderAddValue(op: EnumAddValueOp): string {
  let sql = `ALTER TYPE ${quoteQualifiedName(op.objectName)} ADD VALUE IF NOT EXISTS ${quoteLiteral(op.value)}`;
  // Postgres 11+: BEFORE/AFTER positioning. We prefer BEFORE when both are
  // set because it anchors the new label in the exact requested slot.
  if (op.before) sql += ` BEFORE ${quoteLiteral(op.before)}`;
  else if (op.after) sql += ` AFTER ${quoteLiteral(op.after)}`;
  return sql + ';';
}

function renderRenameValue(op: EnumRenameValueOp): string {
  return `ALTER TYPE ${quoteQualifiedName(op.objectName)} RENAME VALUE ${quoteLiteral(op.fromValue)} TO ${quoteLiteral(op.toValue)};`;
}

// ---------------------------------------------------------------------------
// DROP VALUE rebuild dance
// ---------------------------------------------------------------------------

function buildCaseExpression(
  columnRef: string,
  tmpTypeQn: string,
  droppedValue: string,
  replacement: string | null,
): string {
  // When we have a replacement, map the dropped label to it. Otherwise the
  // CASE collapses to a plain cast and rows still holding the dropped value
  // will fail — matching the user's explicit "skip data migration" intent.
  const replacementExpr =
    replacement !== null
      ? `${quoteLiteral(replacement)}::${tmpTypeQn}`
      : `NULL::${tmpTypeQn}`;
  return (
    `CASE ${columnRef}::text ` +
    `WHEN ${quoteLiteral(droppedValue)} THEN ${replacementExpr} ` +
    `ELSE ${columnRef}::text::${tmpTypeQn} END`
  );
}

/**
 * `DROP VALUE` rebuild dance. The op carries `postDropValues` (set by the
 * differ) which is the ordered list of labels that should remain after the
 * drop. We use it to create a temporary enum, swap every dependent column
 * over with a CASE expression mapping the removed label to
 * `replacementValue` (or NULL when the user explicitly chose "no
 * replacement"), then drop the old type and rename the tmp.
 */
function renderDropValue(op: EnumDropValueOp): string {
  const qn = op.objectName;
  const tmpTypeQn = quoteQualifiedName(`${qn}__progresql_tmp`);
  const oldTypeQn = quoteQualifiedName(qn);

  const deps = ctx.enumDeps.get(unqualifiedName(qn)) ?? [];
  const lines: string[] = [];

  lines.push(`-- Rebuild enum ${qn} to drop value '${op.value}'`);
  if (op.skipDataMigration) {
    lines.push(
      `-- SKIP_DATA_MIGRATION: rows still holding '${op.value}' will cause the ALTER to FAIL.`,
      `-- You asked to skip the data migration — handle cleanup manually before running this.`,
    );
  }

  // 1. Create the tmp enum with the post-drop value list.
  const pdv = Array.isArray(op.postDropValues) ? op.postDropValues : [];
  const remaining = pdv.filter((v) => v !== op.value);
  if (remaining.length === 0) {
    lines.push(
      `-- ERROR: dropping '${op.value}' would leave ${qn} empty; Postgres requires ≥ 1 label.`,
      `-- Add a replacement label first, or drop the type entirely.`,
    );
    return lines.join('\n');
  }
  lines.push(
    `CREATE TYPE ${tmpTypeQn} AS ENUM (${remaining.map(quoteLiteral).join(', ')});`,
  );

  // 2. Switch every dependent column to the tmp type.
  if (deps.length === 0) {
    lines.push(`-- (no dependent columns detected for ${qn})`);
  }
  for (const dep of deps) {
    const tbl = quoteQualifiedName(dep.tableName);
    const col = quoteIdent(dep.column.column_name);
    // Preserve defaults: drop first, reapply after the type swap.
    if (dep.column.column_default != null) {
      lines.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT;`);
    }
    const expr = op.skipDataMigration
      ? `${col}::text::${tmpTypeQn}`
      : buildCaseExpression(col, tmpTypeQn, op.value, op.replacementValue);
    lines.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} TYPE ${tmpTypeQn} USING ${expr};`);
    if (dep.column.column_default != null) {
      lines.push(
        `ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${dep.column.column_default};`,
      );
    }
  }

  // 3. Drop the old type.
  lines.push(`DROP TYPE ${oldTypeQn};`);

  // 4. Rename tmp → original name.
  lines.push(
    `ALTER TYPE ${tmpTypeQn} RENAME TO ${quoteIdent(unqualifiedName(qn))};`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function renderEnumOp(op: EnumOp): string {
  switch (op.kind) {
    case 'create':       return renderCreate(op);
    case 'drop':         return renderDrop(op);
    case 'rename-type':  return renderRenameType(op);
    case 'add-value':    return renderAddValue(op);
    case 'rename-value': return renderRenameValue(op);
    case 'drop-value':   return renderDropValue(op);
  }
}

// Small helper so callers can resolve the list of dependency rows for a UI tooltip.
export function getDependenciesForEnum(qn: string): EnumDependency[] {
  return ctx.enumDeps.get(unqualifiedName(qn)) ?? [];
}

// Re-export for tests
export type { Table };
