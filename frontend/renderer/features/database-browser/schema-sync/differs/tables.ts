/**
 * Table differ — produces the legacy `TableDiff[]` shape the UI already
 * understands. Extended with hybrid rename detection for tables and
 * columns: after the naive add/drop split we try to pair up "orphaned"
 * added source objects with dropped target objects by name + structural
 * similarity (Jaccard of column names for tables, type match for columns).
 */

import type { DatabaseInfo, Table, Column, Index, Constraint } from '@/shared/types';
import type { ColumnDiff, IndexDiff, ConstraintDiff, TableDiff } from '../types';
import { normaliseIdent, similarity } from '../util/similarity';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Combined similarity threshold for table renames. The score is a 50/50
 * blend of name similarity and column-set Jaccard, so 0.6 roughly means
 * "either the name is very close OR the columns overlap heavily".
 */
const TABLE_RENAME_THRESHOLD = 0.6;

/**
 * Column rename threshold — stricter, since the blast radius of a wrong
 * rename is higher (silent data preservation under a wrong column name).
 */
const COLUMN_RENAME_THRESHOLD = 0.65;

// ---------------------------------------------------------------------------
// Helpers reused across the file
// ---------------------------------------------------------------------------

function getAllTables(db: DatabaseInfo): Table[] {
  return db.tables || [];
}

/** Schema-qualified key: `schema.table`. */
export function tableQualifiedName(t: Table): string {
  const schema = t.table_schema || 'public';
  return `${schema}.${t.table_name}`;
}

function columnKey(c: Column): string {
  return c.column_name;
}

function columnsEqual(a: Column, b: Column): boolean {
  return (
    a.data_type === b.data_type &&
    a.is_nullable === b.is_nullable &&
    a.column_default === b.column_default &&
    a.character_maximum_length === b.character_maximum_length &&
    a.numeric_precision === b.numeric_precision &&
    a.numeric_scale === b.numeric_scale
  );
}

function columnsSameType(a: Column, b: Column): boolean {
  return (
    a.data_type === b.data_type &&
    a.character_maximum_length === b.character_maximum_length &&
    a.numeric_precision === b.numeric_precision &&
    a.numeric_scale === b.numeric_scale
  );
}

function indexKey(idx: Index): string {
  return idx.index_name;
}

function indexesEqual(a: Index, b: Index): boolean {
  return (
    a.index_definition === b.index_definition &&
    a.is_unique === b.is_unique
  );
}

function constraintKey(c: Constraint): string {
  return c.constraint_name;
}

function constraintsEqual(a: Constraint, b: Constraint): boolean {
  return (
    a.constraint_type === b.constraint_type &&
    a.column_name === b.column_name &&
    a.referenced_table === b.referenced_table &&
    a.referenced_column === b.referenced_column &&
    a.check_condition === b.check_condition
  );
}

// ---------------------------------------------------------------------------
// Structural similarity scoring
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity over the set of column names. Case-insensitive so
 * `user_id` ↔ `UserId` counts as a match — the actual type check happens
 * in the column-rename pass.
 */
function columnSetJaccard(a: Table, b: Table): number {
  const setA = new Set((a.columns || []).map((c) => normaliseIdent(c.column_name)));
  const setB = new Set((b.columns || []).map((c) => normaliseIdent(c.column_name)));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** Combined name + column-set score in [0..1]. Equal weights. */
function tableRenameScore(src: Table, tgt: Table): number {
  const nameScore = similarity(normaliseIdent(src.table_name), normaliseIdent(tgt.table_name));
  const colScore = columnSetJaccard(src, tgt);
  return 0.5 * nameScore + 0.5 * colScore;
}

/**
 * Greedy bipartite matching of tables keyed on the custom score above.
 * Returns the list of accepted pairs and mutates the input arrays to
 * remove matched entries.
 */
function pairTablesByRename(
  addedSrc: Table[],
  droppedTgt: Table[],
): Array<{ src: Table; tgt: Table; score: number }> {
  const pairs: Array<{ src: Table; tgt: Table; score: number }> = [];
  const usedTgt = new Set<number>();

  for (const src of addedSrc) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < droppedTgt.length; i++) {
      if (usedTgt.has(i)) continue;
      const score = tableRenameScore(src, droppedTgt[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= TABLE_RENAME_THRESHOLD) {
      usedTgt.add(bestIdx);
      pairs.push({ src, tgt: droppedTgt[bestIdx], score: bestScore });
    }
  }

  // Remove matched entries from the originals.
  const srcKeep = new Set(pairs.map((p) => tableQualifiedName(p.src)));
  for (let i = addedSrc.length - 1; i >= 0; i--) {
    if (srcKeep.has(tableQualifiedName(addedSrc[i]))) addedSrc.splice(i, 1);
  }
  for (let i = droppedTgt.length - 1; i >= 0; i--) {
    if (usedTgt.has(i)) droppedTgt.splice(i, 1);
  }
  return pairs;
}

/**
 * Detect column renames inside a single table. Runs over the pre-built
 * add/drop column-diff arrays and converts matched pairs into 'rename'
 * diffs. The add/drop entries for matched pairs are removed from the
 * arrays in place.
 */
function detectColumnRenames(
  tableName: string,
  colDiffs: ColumnDiff[],
): void {
  const addIdxs: number[] = [];
  const dropIdxs: number[] = [];
  for (let i = 0; i < colDiffs.length; i++) {
    if (colDiffs[i].kind === 'add' && colDiffs[i].column) addIdxs.push(i);
    if (colDiffs[i].kind === 'drop' && colDiffs[i].column) dropIdxs.push(i);
  }
  if (addIdxs.length === 0 || dropIdxs.length === 0) return;

  const usedDropSet = new Set<number>();
  const matches: Array<{ addIdx: number; dropIdx: number; confidence: number }> = [];

  for (const addIdx of addIdxs) {
    const addCol = colDiffs[addIdx].column!;
    let bestDropIdx = -1;
    let bestScore = 0;
    for (const dropIdx of dropIdxs) {
      if (usedDropSet.has(dropIdx)) continue;
      const dropCol = colDiffs[dropIdx].column!;
      // Require matching data type — renaming across different types is
      // too risky to auto-detect (it collides with legitimate add+drop).
      if (!columnsSameType(addCol, dropCol)) continue;
      const score = similarity(
        normaliseIdent(addCol.column_name),
        normaliseIdent(dropCol.column_name),
      );
      if (score > bestScore) {
        bestScore = score;
        bestDropIdx = dropIdx;
      }
    }
    if (bestDropIdx >= 0 && bestScore >= COLUMN_RENAME_THRESHOLD) {
      usedDropSet.add(bestDropIdx);
      matches.push({ addIdx, dropIdx: bestDropIdx, confidence: bestScore });
    }
  }

  if (matches.length === 0) return;

  // Emit rename diffs and mark the originals for removal.
  const toRemove = new Set<number>();
  const renames: ColumnDiff[] = [];
  for (const m of matches) {
    const addCol = colDiffs[m.addIdx].column!;
    const dropCol = colDiffs[m.dropIdx].column!;
    renames.push({
      kind: 'rename',
      tableName,
      sourceColumn: addCol,
      targetColumn: dropCol,
      renameTo: addCol.column_name,
      confidence: m.confidence,
    });
    toRemove.add(m.addIdx);
    toRemove.add(m.dropIdx);
  }

  // Walk in reverse so indices stay valid.
  for (let i = colDiffs.length - 1; i >= 0; i--) {
    if (toRemove.has(i)) colDiffs.splice(i, 1);
  }
  colDiffs.push(...renames);
}

/**
 * Compute the inner (columns / indexes / constraints) diff for two
 * tables that are known to be the same logical entity under different
 * names. Keyed off `targetNameForDiff` so the resulting DDL emits under
 * the **new** (source-side) identifier.
 */
function diffTwoTables(
  src: Table,
  tgt: Table,
  srcQualifiedName: string,
): { columns: ColumnDiff[]; indexes: IndexDiff[]; constraints: ConstraintDiff[]; isDestructive: boolean } {
  const colDiffs: ColumnDiff[] = [];
  const idxDiffs: IndexDiff[] = [];
  const conDiffs: ConstraintDiff[] = [];

  const srcCols = new Map((src.columns || []).map((c) => [columnKey(c), c]));
  const tgtCols = new Map((tgt.columns || []).map((c) => [columnKey(c), c]));

  for (const [key, col] of srcCols) {
    const tgtCol = tgtCols.get(key);
    if (!tgtCol) {
      colDiffs.push({ kind: 'add', tableName: srcQualifiedName, column: col });
    } else if (!columnsEqual(col, tgtCol)) {
      colDiffs.push({ kind: 'alter', tableName: srcQualifiedName, sourceColumn: col, targetColumn: tgtCol });
    }
  }
  for (const [key, col] of tgtCols) {
    if (!srcCols.has(key)) {
      colDiffs.push({ kind: 'drop', tableName: srcQualifiedName, column: col });
    }
  }

  detectColumnRenames(srcQualifiedName, colDiffs);

  const srcIdxs = new Map((src.indexes || []).map((i) => [indexKey(i), i]));
  const tgtIdxs = new Map((tgt.indexes || []).map((i) => [indexKey(i), i]));

  for (const [key, idx] of srcIdxs) {
    const tgtIdx = tgtIdxs.get(key);
    if (!tgtIdx) {
      idxDiffs.push({ kind: 'add', tableName: srcQualifiedName, index: idx });
    } else if (!indexesEqual(idx, tgtIdx)) {
      idxDiffs.push({ kind: 'alter', tableName: srcQualifiedName, sourceIndex: idx, targetIndex: tgtIdx });
    }
  }
  for (const [key, idx] of tgtIdxs) {
    if (!srcIdxs.has(key)) {
      idxDiffs.push({ kind: 'drop', tableName: srcQualifiedName, index: idx });
    }
  }

  const srcCons = new Map((src.constraints || []).map((c) => [constraintKey(c), c]));
  const tgtCons = new Map((tgt.constraints || []).map((c) => [constraintKey(c), c]));

  for (const [key, con] of srcCons) {
    const tgtCon = tgtCons.get(key);
    if (!tgtCon) {
      conDiffs.push({ kind: 'add', tableName: srcQualifiedName, constraint: con });
    } else if (!constraintsEqual(con, tgtCon)) {
      conDiffs.push({ kind: 'alter', tableName: srcQualifiedName, sourceConstraint: con, targetConstraint: tgtCon });
    }
  }
  for (const [key, con] of tgtCons) {
    if (!srcCons.has(key)) {
      conDiffs.push({ kind: 'drop', tableName: srcQualifiedName, constraint: con });
    }
  }

  const isDestructive = colDiffs.some((d) => d.kind === 'drop') ||
    idxDiffs.some((d) => d.kind === 'drop') ||
    conDiffs.some((d) => d.kind === 'drop');

  return { columns: colDiffs, indexes: idxDiffs, constraints: conDiffs, isDestructive };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function diffTables(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): TableDiff[] {
  const sourceTables = getAllTables(sourceDb);
  const targetTables = getAllTables(targetDb);

  const sourceMap = new Map(sourceTables.map((t) => [tableQualifiedName(t), t]));
  const targetMap = new Map(targetTables.map((t) => [tableQualifiedName(t), t]));

  const tables: TableDiff[] = [];

  // Partition into "only-in-source" (add candidates) and "only-in-target"
  // (drop candidates). Rename detection operates on these two buckets.
  const addedSrc: Table[] = [];
  const droppedTgt: Table[] = [];

  for (const [name, srcTable] of sourceMap) {
    if (!targetMap.has(name)) addedSrc.push(srcTable);
  }
  for (const [name, tgtTable] of targetMap) {
    if (!sourceMap.has(name)) droppedTgt.push(tgtTable);
  }

  // 1. Detect table renames. Pairs are removed from the add/drop buckets.
  const renamePairs = pairTablesByRename(addedSrc, droppedTgt);
  for (const { src, tgt, score } of renamePairs) {
    const srcName = tableQualifiedName(src);
    const tgtName = tableQualifiedName(tgt);
    const inner = diffTwoTables(src, tgt, srcName);
    tables.push({
      tableName: srcName,
      kind: 'rename',
      renamedFrom: tgtName,
      renameConfidence: score,
      columns: inner.columns,
      indexes: inner.indexes,
      constraints: inner.constraints,
      isDestructive: inner.isDestructive,
      // Capture full source-side column/index/constraint lists so the
      // Schema Sync UI can materialise a plain CREATE TABLE statement
      // when the user picks "split" or "keep both" on this rename row.
      sourceColumns: src.columns ? [...src.columns] : undefined,
      sourceIndexes: src.indexes ? [...src.indexes] : undefined,
      sourceConstraints: src.constraints ? [...src.constraints] : undefined,
    });
  }

  // 2. Remaining add-only -> CREATE TABLE
  for (const srcTable of addedSrc) {
    const name = tableQualifiedName(srcTable);
    tables.push({
      tableName: name,
      kind: 'add',
      columns: (srcTable.columns || []).map((c) => ({ kind: 'add', tableName: name, column: c })),
      indexes: (srcTable.indexes || []).map((i) => ({ kind: 'add', tableName: name, index: i })),
      constraints: (srcTable.constraints || []).map((c) => ({ kind: 'add', tableName: name, constraint: c })),
      isDestructive: false,
    });
  }

  // 3. Remaining drop-only -> DROP TABLE (destructive)
  for (const tgtTable of droppedTgt) {
    const name = tableQualifiedName(tgtTable);
    tables.push({
      tableName: name,
      kind: 'drop',
      columns: [],
      indexes: [],
      constraints: [],
      isDestructive: true,
    });
  }

  // 4. Tables present in both -> inner diff (with column rename detection)
  for (const [name, srcTable] of sourceMap) {
    const tgtTable = targetMap.get(name);
    if (!tgtTable) continue;

    const inner = diffTwoTables(srcTable, tgtTable, name);
    if (inner.columns.length > 0 || inner.indexes.length > 0 || inner.constraints.length > 0) {
      tables.push({
        tableName: name,
        kind: 'alter',
        columns: inner.columns,
        indexes: inner.indexes,
        constraints: inner.constraints,
        isDestructive: inner.isDestructive,
      });
    }
  }

  // Sort: CREATE TABLE first, then RENAME, then ALTER, then DROP
  const order = { add: 0, rename: 1, alter: 2, drop: 3 } as const;
  tables.sort((a, b) => order[a.kind] - order[b.kind] || a.tableName.localeCompare(b.tableName));

  return tables;
}
