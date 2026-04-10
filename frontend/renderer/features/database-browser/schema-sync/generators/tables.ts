/**
 * Table SQL generators. Extracted verbatim from the original SchemaSyncModal
 * so behaviour is preserved during the refactor. Only the module layout and
 * imports changed.
 */

import type { TableDiff } from '../types';
import { quoteIdent, quoteQualifiedName, columnTypeSQL } from '../util/sql';

/**
 * Generate `CREATE TABLE` **without** FK constraints. Foreign keys are added
 * separately (see {@link generateCreateTableFKs}) so all referenced tables can
 * exist before any ALTER TABLE ... ADD FK runs.
 */
export function generateCreateTable(diff: TableDiff): string {
  const qualifiedName = quoteQualifiedName(diff.tableName);

  const cols = diff.columns
    .filter((d) => d.kind === 'add' && d.column)
    .map((d) => {
      const c = d.column!;
      let line = `  ${quoteIdent(c.column_name)} ${columnTypeSQL(c)}`;
      if (c.is_nullable === 'NO') line += ' NOT NULL';
      if (c.column_default !== null && c.column_default !== undefined) line += ` DEFAULT ${c.column_default}`;
      return line;
    });

  const pks = diff.constraints
    .filter((d) => d.kind === 'add' && d.constraint?.constraint_type === 'PRIMARY KEY')
    .map((d) => d.constraint!);

  if (pks.length > 0) {
    const pkCols = pks.map((pk) => quoteIdent(pk.column_name)).join(', ');
    cols.push(`  PRIMARY KEY (${pkCols})`);
  }

  let sql = `CREATE TABLE ${qualifiedName} (\n${cols.join(',\n')}\n);`;

  // Non-FK, non-PK constraints (UNIQUE, CHECK) — safe to add inline.
  const inlineConstraints = diff.constraints
    .filter((d) => d.kind === 'add' && d.constraint &&
      d.constraint.constraint_type !== 'PRIMARY KEY' &&
      d.constraint.constraint_type !== 'FOREIGN KEY');
  for (const cd of inlineConstraints) {
    const c = cd.constraint!;
    if (c.constraint_type === 'UNIQUE') {
      sql += `\nALTER TABLE ${qualifiedName} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} UNIQUE (${quoteIdent(c.column_name)});`;
    } else if (c.constraint_type === 'CHECK' && c.check_condition) {
      sql += `\nALTER TABLE ${qualifiedName} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} CHECK (${c.check_condition});`;
    }
  }

  // Indexes (non-primary)
  for (const id of diff.indexes.filter((d) => d.kind === 'add' && d.index && !d.index.is_primary)) {
    const idx = id.index!;
    if (idx.index_definition) {
      sql += `\n${idx.index_definition};`;
    } else {
      const unique = idx.is_unique ? 'UNIQUE ' : '';
      sql += `\nCREATE ${unique}INDEX ${quoteIdent(idx.index_name)} ON ${qualifiedName} (${idx.columns.map(quoteIdent).join(', ')});`;
    }
  }

  return sql;
}

/** Generate FK constraint statements for a CREATE TABLE diff (added after all tables exist). */
export function generateCreateTableFKs(diff: TableDiff): string {
  const qualifiedName = quoteQualifiedName(diff.tableName);
  const fks = diff.constraints
    .filter((d) => d.kind === 'add' && d.constraint?.constraint_type === 'FOREIGN KEY');
  if (fks.length === 0) return '';
  const statements: string[] = [];
  for (const cd of fks) {
    const c = cd.constraint!;
    let stmt = `ALTER TABLE ${qualifiedName} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} FOREIGN KEY (${quoteIdent(c.column_name)}) REFERENCES ${quoteIdent(c.referenced_table || '')}(${quoteIdent(c.referenced_column || '')})`;
    if (c.on_delete) stmt += ` ON DELETE ${c.on_delete}`;
    if (c.on_update) stmt += ` ON UPDATE ${c.on_update}`;
    statements.push(stmt + ';');
  }
  return statements.join('\n');
}

export function generateAlterTable(diff: TableDiff): string {
  const statements: string[] = [];
  const tbl = quoteQualifiedName(diff.tableName);

  // Column renames — emit first so subsequent ALTER COLUMN statements
  // reference the new (source-side) name.
  for (const cd of diff.columns.filter((d) => d.kind === 'rename' && d.sourceColumn && d.targetColumn)) {
    const oldName = cd.targetColumn!.column_name;
    const newName = cd.sourceColumn!.column_name;
    statements.push(`ALTER TABLE ${tbl} RENAME COLUMN ${quoteIdent(oldName)} TO ${quoteIdent(newName)};`);
  }

  // Add columns
  for (const cd of diff.columns.filter((d) => d.kind === 'add' && d.column)) {
    const c = cd.column!;
    let line = `ALTER TABLE ${tbl} ADD COLUMN ${quoteIdent(c.column_name)} ${columnTypeSQL(c)}`;
    if (c.is_nullable === 'NO') line += ' NOT NULL';
    if (c.column_default !== null && c.column_default !== undefined) line += ` DEFAULT ${c.column_default}`;
    statements.push(line + ';');
  }

  // Alter columns (type change, nullability, default)
  for (const cd of diff.columns.filter((d) => d.kind === 'alter' && d.sourceColumn && d.targetColumn)) {
    const src = cd.sourceColumn!;
    const tgt = cd.targetColumn!;
    const col = quoteIdent(src.column_name);

    if (src.data_type !== tgt.data_type || src.character_maximum_length !== tgt.character_maximum_length) {
      statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} TYPE ${columnTypeSQL(src)};`);
    }
    if (src.is_nullable !== tgt.is_nullable) {
      if (src.is_nullable === 'NO') {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET NOT NULL;`);
      } else {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP NOT NULL;`);
      }
    }
    if (src.column_default !== tgt.column_default) {
      if (src.column_default !== null && src.column_default !== undefined) {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${src.column_default};`);
      } else {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT;`);
      }
    }
  }

  // Drop columns
  for (const cd of diff.columns.filter((d) => d.kind === 'drop' && d.column)) {
    statements.push(`ALTER TABLE ${tbl} DROP COLUMN ${quoteIdent(cd.column!.column_name)};`);
  }

  // Add constraints
  for (const cd of diff.constraints.filter((d) => d.kind === 'add' && d.constraint)) {
    const c = cd.constraint!;
    if (c.constraint_type === 'FOREIGN KEY') {
      let stmt = `ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} FOREIGN KEY (${quoteIdent(c.column_name)}) REFERENCES ${quoteIdent(c.referenced_table || '')}(${quoteIdent(c.referenced_column || '')})`;
      if (c.on_delete) stmt += ` ON DELETE ${c.on_delete}`;
      if (c.on_update) stmt += ` ON UPDATE ${c.on_update}`;
      statements.push(stmt + ';');
    } else if (c.constraint_type === 'UNIQUE') {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} UNIQUE (${quoteIdent(c.column_name)});`);
    } else if (c.constraint_type === 'CHECK' && c.check_condition) {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} CHECK (${c.check_condition});`);
    } else if (c.constraint_type === 'PRIMARY KEY') {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} PRIMARY KEY (${quoteIdent(c.column_name)});`);
    }
  }

  // Drop constraints
  for (const cd of diff.constraints.filter((d) => d.kind === 'drop' && d.constraint)) {
    statements.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${quoteIdent(cd.constraint!.constraint_name)};`);
  }

  // Alter constraints (drop + re-add)
  for (const cd of diff.constraints.filter((d) => d.kind === 'alter' && d.sourceConstraint)) {
    const src = cd.sourceConstraint!;
    statements.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${quoteIdent(src.constraint_name)};`);
    if (src.constraint_type === 'FOREIGN KEY') {
      let stmt = `ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(src.constraint_name)} FOREIGN KEY (${quoteIdent(src.column_name)}) REFERENCES ${quoteIdent(src.referenced_table || '')}(${quoteIdent(src.referenced_column || '')})`;
      if (src.on_delete) stmt += ` ON DELETE ${src.on_delete}`;
      if (src.on_update) stmt += ` ON UPDATE ${src.on_update}`;
      statements.push(stmt + ';');
    } else if (src.constraint_type === 'UNIQUE') {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(src.constraint_name)} UNIQUE (${quoteIdent(src.column_name)});`);
    } else if (src.constraint_type === 'CHECK' && src.check_condition) {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(src.constraint_name)} CHECK (${src.check_condition});`);
    }
  }

  // Add indexes
  for (const id of diff.indexes.filter((d) => d.kind === 'add' && d.index && !d.index.is_primary)) {
    const idx = id.index!;
    if (idx.index_definition) {
      statements.push(`${idx.index_definition};`);
    } else {
      const unique = idx.is_unique ? 'UNIQUE ' : '';
      statements.push(`CREATE ${unique}INDEX ${quoteIdent(idx.index_name)} ON ${tbl} (${idx.columns.map(quoteIdent).join(', ')});`);
    }
  }

  // Drop indexes
  for (const id of diff.indexes.filter((d) => d.kind === 'drop' && d.index)) {
    statements.push(`DROP INDEX ${quoteIdent(id.index!.index_name)};`);
  }

  // Alter indexes (drop + re-create)
  for (const id of diff.indexes.filter((d) => d.kind === 'alter' && d.sourceIndex)) {
    const src = id.sourceIndex!;
    statements.push(`DROP INDEX ${quoteIdent(src.index_name)};`);
    if (src.index_definition) {
      statements.push(`${src.index_definition};`);
    } else {
      const unique = src.is_unique ? 'UNIQUE ' : '';
      statements.push(`CREATE ${unique}INDEX ${quoteIdent(src.index_name)} ON ${tbl} (${src.columns.map(quoteIdent).join(', ')});`);
    }
  }

  return statements.join('\n');
}

export function generateDropTable(diff: TableDiff): string {
  return `DROP TABLE ${quoteQualifiedName(diff.tableName)};`;
}

/**
 * Emit `ALTER TABLE old RENAME TO new;` followed by any inner column/
 * index/constraint alterations that the rename diff also carries. The
 * rename itself must run first so subsequent statements reference the
 * new identifier.
 */
export function generateRenameTable(diff: TableDiff): string {
  if (!diff.renamedFrom) return '';
  const oldQualified = quoteQualifiedName(diff.renamedFrom);
  const newUnqualified = diff.tableName.includes('.')
    ? diff.tableName.split('.', 2)[1]
    : diff.tableName;

  const parts: string[] = [];
  parts.push(`ALTER TABLE ${oldQualified} RENAME TO ${quoteIdent(newUnqualified)};`);

  // Additional alterations use the new name (generateAlterTable reads
  // from diff.tableName, which is already the source-side name).
  const inner = generateAlterTable(diff);
  if (inner.trim().length > 0) parts.push(inner);
  return parts.join('\n');
}

/** Dispatch helper used by the UI to render the per-row SQL snippet. */
export function generateTableSQL(diff: TableDiff): string {
  switch (diff.kind) {
    case 'add':
      return generateCreateTable(diff);
    case 'drop':
      return generateDropTable(diff);
    case 'alter':
      return generateAlterTable(diff);
    case 'rename':
      return generateRenameTable(diff);
  }
}
