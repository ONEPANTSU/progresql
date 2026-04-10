/**
 * Final-SQL assembler. Takes a `SchemaDiff` plus the set of user-selected
 * identifiers and emits a single BEGIN/COMMIT-wrapped migration script.
 *
 * Ordering rules implemented here:
 *   1. CREATE SCHEMA (deduplicated, before any tables)
 *   2. CREATE TABLE (without FKs, so tables can reference each other)
 *   3. FK constraints for new tables
 *   4. RENAME TABLE (must run before ALTER so renamed tables are
 *      addressed by their new name in subsequent statements)
 *   5. ALTER TABLE
 *   6. DROP TABLE
 *
 * Non-table `ops` are ignored for now — later phases add enum / view /
 * function sections wrapped by the planner's phase splitter.
 */

import type { SchemaDiff, TableDiff } from '../types';
import { quoteIdent } from '../util/sql';
import {
  generateCreateTable,
  generateCreateTableFKs,
  generateAlterTable,
  generateDropTable,
  generateRenameTable,
} from './tables';

export interface AssembleOptions {
  /** Schema-qualified table names the user wants included. */
  selectedTables: Set<string>;
  /** Op IDs the user wants included (future phases). */
  selectedOpIds?: Set<string>;
}

export function assembleFinalSQL(diff: SchemaDiff, opts: AssembleOptions): string {
  const selectedTables: TableDiff[] = diff.tables.filter((t) => opts.selectedTables.has(t.tableName));
  const parts: string[] = [];

  // 1. CREATE SCHEMA (deduplicated, before any tables)
  const schemas = new Set<string>();
  for (const td of selectedTables) {
    if (td.kind === 'add' && td.tableName.includes('.')) {
      const schema = td.tableName.split('.', 2)[0];
      if (schema !== 'public') schemas.add(schema);
    }
  }
  if (schemas.size > 0) {
    for (const s of schemas) {
      parts.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`);
    }
    parts.push('');
  }

  // 2. CREATE TABLE (without FK constraints)
  const creates = selectedTables.filter((t) => t.kind === 'add');
  for (const td of creates) {
    parts.push(`-- CREATE TABLE: ${td.tableName}`);
    parts.push(generateCreateTable(td));
    parts.push('');
  }

  // 3. FK constraints for new tables (after ALL tables exist)
  const fkParts: string[] = [];
  for (const td of creates) {
    const fkSQL = generateCreateTableFKs(td);
    if (fkSQL) fkParts.push(fkSQL);
  }
  if (fkParts.length > 0) {
    parts.push('-- FOREIGN KEY CONSTRAINTS');
    parts.push(fkParts.join('\n'));
    parts.push('');
  }

  // 4. RENAME TABLE (+ any inner alterations under the new name)
  const renames = selectedTables.filter((t) => t.kind === 'rename');
  for (const td of renames) {
    parts.push(`-- RENAME TABLE: ${td.renamedFrom} -> ${td.tableName}`);
    parts.push(generateRenameTable(td));
    parts.push('');
  }

  // 5. ALTER TABLE
  const alters = selectedTables.filter((t) => t.kind === 'alter');
  for (const td of alters) {
    parts.push(`-- ALTER TABLE: ${td.tableName}`);
    parts.push(generateAlterTable(td));
    parts.push('');
  }

  // 6. DROP TABLE
  const drops = selectedTables.filter((t) => t.kind === 'drop');
  if (drops.length > 0) {
    for (const td of drops) {
      parts.push(`-- DROP TABLE: ${td.tableName}`);
      parts.push(generateDropTable(td));
      parts.push('');
    }
  }

  const body = parts.join('\n').trim();
  if (!body) return '';
  return `BEGIN;\n\n${body}\n\nCOMMIT;`;
}

export {
  generateCreateTable,
  generateCreateTableFKs,
  generateAlterTable,
  generateDropTable,
  generateRenameTable,
  generateTableSQL,
} from './tables';
export {
  renderEnumOp,
  configureEnumGeneratorContext,
  getConfiguredEnumContext,
  getDependenciesForEnum,
  type EnumDependency,
} from './enums';
export { renderViewOp } from './views';
export { renderRoutineOp } from './routines';
export { renderSequenceOp } from './sequences';
export { renderTriggerOp } from './triggers';
export { renderDomainOp } from './domains';

import type { ChangeOp } from '../types';
import { renderEnumOp } from './enums';
import { renderViewOp } from './views';
import { renderRoutineOp } from './routines';
import { renderSequenceOp } from './sequences';
import { renderTriggerOp } from './triggers';
import { renderDomainOp } from './domains';
import { registerOpRenderer } from '../planner';

/**
 * Central renderer that dispatches to the right category-specific function.
 * Kept as a single registration hook so the planner only needs to know one
 * entry point — new categories plug in here in future phases.
 */
export function renderChangeOp(op: ChangeOp): string {
  switch (op.category) {
    case 'enum':
      return renderEnumOp(op);
    case 'view':
      return renderViewOp(op);
    case 'function':
    case 'procedure':
      return renderRoutineOp(op);
    case 'sequence':
      return renderSequenceOp(op);
    case 'trigger':
      return renderTriggerOp(op);
    case 'domain':
      return renderDomainOp(op);
    default:
      return `-- (no renderer for category ${(op as ChangeOp).category})`;
  }
}

// Wire into the planner at module import time. Importing anything from
// `../generators` thus arms the planner with real SQL rendering.
registerOpRenderer(renderChangeOp);
