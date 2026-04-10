/**
 * Type definitions for the Schema Sync / migration generator.
 *
 * This file is deliberately split in two sections:
 *
 *  1. **Legacy table-diff types** (`TableDiff` & friends) — the exact shape
 *     used by the original `SchemaSyncModal` component. They remain the
 *     canonical representation for the "tables" category during the refactor
 *     so we can move code between files without changing behaviour.
 *
 *  2. **New `ChangeOp` types** — a richer, category-agnostic operation model
 *     used by enums / views / functions / sequences / triggers / domains and,
 *     eventually, tables. These will drive the planner (topological sort and
 *     phase splitting) introduced in later phases. For now only a handful of
 *     enum-specific ops are defined; other categories will extend the union.
 */

import type { Column, Index, Constraint, CustomType, View, Function as PgFunction, Sequence, Trigger } from '@/shared/types';

// ---------------------------------------------------------------------------
// Legacy table-diff types
// ---------------------------------------------------------------------------

export type DiffKind = 'add' | 'drop' | 'alter' | 'rename';

export interface ColumnDiff {
  kind: DiffKind;
  tableName: string;
  column?: Column;
  sourceColumn?: Column;
  targetColumn?: Column;
  /** Only set when `kind === 'rename'`: source-side (new) column name. */
  renameTo?: string;
  /** Only set when `kind === 'rename'`: confidence score in [0..1]. */
  confidence?: number;
}

export interface IndexDiff {
  kind: DiffKind;
  tableName: string;
  index?: Index;
  sourceIndex?: Index;
  targetIndex?: Index;
}

export interface ConstraintDiff {
  kind: DiffKind;
  tableName: string;
  constraint?: Constraint;
  sourceConstraint?: Constraint;
  targetConstraint?: Constraint;
}

export interface TableDiff {
  /** For 'rename' this is the **source** (new) name; for 'drop' it is the target (old) name. */
  tableName: string;
  /**
   * 'add' = exists only in source,
   * 'drop' = exists only in target,
   * 'alter' = differs,
   * 'rename' = target-side table was matched to a differently-named source
   *            table (also carries column/index/constraint diffs between the two).
   */
  kind: DiffKind;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  constraints: ConstraintDiff[];
  isDestructive: boolean;
  /** Only for 'rename': the target-side (old) table name. */
  renamedFrom?: string;
  /** Only for 'rename': 0..1 similarity score. */
  renameConfidence?: number;
  /**
   * Only for 'rename': full source-side column list. Carried along so the UI
   * can materialise a `CREATE TABLE` statement when the user downgrades the
   * rename into "split" (DROP+CREATE) or "keep both" (CREATE only).
   */
  sourceColumns?: Column[];
  sourceIndexes?: Index[];
  sourceConstraints?: Constraint[];
}

// ---------------------------------------------------------------------------
// Category enum — which database object a change operation targets
// ---------------------------------------------------------------------------

export type ObjectCategory =
  | 'schema'
  | 'enum'
  | 'domain'
  | 'sequence'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'trigger';

// ---------------------------------------------------------------------------
// New ChangeOp model (used by enums and all future categories)
// ---------------------------------------------------------------------------

/**
 * Phase groups. Postgres forbids `ALTER TYPE ... ADD VALUE` inside the same
 * transaction that later uses the new value, so we must commit the enum
 * extension in its own transaction before running the data migration. The
 * planner uses these phases to split the final SQL into multiple BEGIN/COMMIT
 * blocks when required.
 */
export type MigrationPhase =
  /** Everything that can happen in the main transaction with the rest of the migration. */
  | 'pre'
  /** Must run in its own transaction *before* `main` (e.g. ALTER TYPE ADD VALUE). */
  | 'pre-commit'
  /** The bulk of the migration — table CREATE/ALTER/DROP, etc. */
  | 'main'
  /** Must run in its own transaction *after* `main` (e.g. DROP TYPE post-swap). */
  | 'post-commit';

export interface BaseChangeOp {
  /** Stable id for UI selection / deselection. */
  id: string;
  category: ObjectCategory;
  /** Schema-qualified object name, e.g. `public.order_status`. */
  objectName: string;
  /** Phase the op belongs to; planner may downgrade/upgrade when mixing ops. */
  phase: MigrationPhase;
  /** True if executing this op can lose data. */
  isDestructive: boolean;
  /** Human-readable label used in the accordion row (falls back to objectName). */
  label?: string;
  /** Dependency object-names this op requires to already exist. */
  dependsOn?: string[];
}

// ---- Enum ops -------------------------------------------------------------

export interface EnumCreateOp extends BaseChangeOp {
  category: 'enum';
  kind: 'create';
  values: string[];
}

export interface EnumDropOp extends BaseChangeOp {
  category: 'enum';
  kind: 'drop';
}

/** Non-destructive rename of the enum type itself (schema.name → schema.name). */
export interface EnumRenameTypeOp extends BaseChangeOp {
  category: 'enum';
  kind: 'rename-type';
  fromName: string;
  toName: string;
}

/** Non-destructive `ALTER TYPE ... ADD VALUE`. Must run in its own tx. */
export interface EnumAddValueOp extends BaseChangeOp {
  category: 'enum';
  kind: 'add-value';
  value: string;
  /** Optional BEFORE/AFTER anchor to preserve order. */
  before?: string;
  after?: string;
}

/** Non-destructive `ALTER TYPE ... RENAME VALUE` (v10+). */
export interface EnumRenameValueOp extends BaseChangeOp {
  category: 'enum';
  kind: 'rename-value';
  fromValue: string;
  toValue: string;
}

/**
 * Destructive drop of an enum value. Postgres has no native DROP VALUE, so
 * this requires the rebuild dance:
 *   1. Create tmp type with the new labels
 *   2. ALTER every dependent column to tmp type, mapping the dropped value
 *      to `replacementValue` (or NULL if user allows it).
 *   3. Drop old type, rename tmp.
 * Resolved by the generator in a later phase; here we only capture intent.
 */
export interface EnumDropValueOp extends BaseChangeOp {
  category: 'enum';
  kind: 'drop-value';
  value: string;
  /** Label to migrate existing rows to; null means "leave NULL / fail if NOT NULL". */
  replacementValue: string | null;
  /** User opted in to skip the data migration — emits a warning comment only. */
  skipDataMigration: boolean;
  /**
   * Remaining enum labels after `value` is dropped, in source order. Used by
   * the generator to emit `CREATE TYPE tmp AS ENUM (...)`.
   */
  postDropValues: string[];
}

export type EnumOp =
  | EnumCreateOp
  | EnumDropOp
  | EnumRenameTypeOp
  | EnumAddValueOp
  | EnumRenameValueOp
  | EnumDropValueOp;

// ---- View ops -------------------------------------------------------------

/**
 * Views are rendered as `CREATE OR REPLACE VIEW` whenever possible so
 * dependent objects (other views, functions) keep working. If the new
 * definition changes the output column list/types, Postgres rejects the
 * REPLACE and we fall back to `DROP + CREATE` — that decision is taken at
 * generation time, not diff time, so the op just carries the full new
 * definition.
 */
export interface ViewCreateOp extends BaseChangeOp {
  category: 'view';
  kind: 'create';
  definition: string;
}

export interface ViewDropOp extends BaseChangeOp {
  category: 'view';
  kind: 'drop';
}

/**
 * Non-destructive replace. The generator will emit `CREATE OR REPLACE
 * VIEW` first; callers that want the brute-force DROP+CREATE should
 * supply `forceRecreate: true`.
 */
export interface ViewReplaceOp extends BaseChangeOp {
  category: 'view';
  kind: 'replace';
  definition: string;
  /** When true, generator emits DROP VIEW IF EXISTS + CREATE VIEW instead of CREATE OR REPLACE. */
  forceRecreate: boolean;
}

/** Schema-level rename: `ALTER VIEW old RENAME TO new`. */
export interface ViewRenameOp extends BaseChangeOp {
  category: 'view';
  kind: 'rename';
  fromName: string;
  toName: string;
  /**
   * Source-side view body, preserved so the UI can downgrade the rename
   * into split (DROP+CREATE) or keep-both (CREATE only) — without it we
   * can't materialise the full `CREATE VIEW` statement later.
   */
  definition?: string;
}

export type ViewOp = ViewCreateOp | ViewDropOp | ViewReplaceOp | ViewRenameOp;

// ---- Function / procedure ops --------------------------------------------

/**
 * Functions and procedures share the same DDL shape (`CREATE [OR REPLACE]
 * FUNCTION` / `PROCEDURE`, `DROP`, `ALTER ... RENAME TO`). We encode them
 * under two separate categories so the UI can group them, but they share
 * the same op kinds.
 */
export interface RoutineCreateOp extends BaseChangeOp {
  category: 'function' | 'procedure';
  kind: 'create';
  /**
   * Full `CREATE FUNCTION ...` or `CREATE PROCEDURE ...` statement as
   * returned by pg_get_functiondef. The generator emits it verbatim
   * (optionally swapping CREATE → CREATE OR REPLACE for replace ops).
   */
  definition: string;
  /** Parameter signature, e.g. `(int, text)` — used for DROP and to build IDs. */
  argSignature: string;
  /** Language (sql, plpgsql, ...). Informational only. */
  language?: string;
}

export interface RoutineDropOp extends BaseChangeOp {
  category: 'function' | 'procedure';
  kind: 'drop';
  argSignature: string;
}

export interface RoutineReplaceOp extends BaseChangeOp {
  category: 'function' | 'procedure';
  kind: 'replace';
  definition: string;
  argSignature: string;
  language?: string;
}

export interface RoutineRenameOp extends BaseChangeOp {
  category: 'function' | 'procedure';
  kind: 'rename';
  fromName: string;
  toName: string;
  argSignature: string;
  /** Source-side routine body, used by the split / keep-both resolvers. */
  definition?: string;
  language?: string;
}

export type RoutineOp = RoutineCreateOp | RoutineDropOp | RoutineReplaceOp | RoutineRenameOp;

// ---- Sequence ops ---------------------------------------------------------

export interface SequenceAttributes {
  dataType?: string;
  startValue?: number;
  minValue?: number;
  maxValue?: number;
  increment?: number;
  cycle?: boolean;
  cache?: number;
}

export interface SequenceCreateOp extends BaseChangeOp {
  category: 'sequence';
  kind: 'create';
  attrs: SequenceAttributes;
}

export interface SequenceDropOp extends BaseChangeOp {
  category: 'sequence';
  kind: 'drop';
}

/** `ALTER SEQUENCE` for non-destructive attribute changes (min/max/inc/cycle/cache). */
export interface SequenceAlterOp extends BaseChangeOp {
  category: 'sequence';
  kind: 'alter';
  changes: Partial<SequenceAttributes>;
}

export interface SequenceRenameOp extends BaseChangeOp {
  category: 'sequence';
  kind: 'rename';
  fromName: string;
  toName: string;
}

export type SequenceOp = SequenceCreateOp | SequenceDropOp | SequenceAlterOp | SequenceRenameOp;

// ---- Trigger ops ----------------------------------------------------------

/**
 * Triggers belong to a table. Postgres can't ALTER a trigger's body, so
 * anything beyond a rename is a `DROP + CREATE`.
 */
export interface TriggerCreateOp extends BaseChangeOp {
  category: 'trigger';
  kind: 'create';
  /** Parent table the trigger fires on, schema-qualified. */
  tableName: string;
  /** Full `CREATE TRIGGER ...` statement. */
  definition: string;
}

export interface TriggerDropOp extends BaseChangeOp {
  category: 'trigger';
  kind: 'drop';
  tableName: string;
}

/** Drop + recreate — used when the body changed. Destructive for an instant. */
export interface TriggerReplaceOp extends BaseChangeOp {
  category: 'trigger';
  kind: 'replace';
  tableName: string;
  definition: string;
}

export interface TriggerRenameOp extends BaseChangeOp {
  category: 'trigger';
  kind: 'rename';
  tableName: string;
  fromName: string;
  toName: string;
}

export type TriggerOp = TriggerCreateOp | TriggerDropOp | TriggerReplaceOp | TriggerRenameOp;

// ---- Domain ops -----------------------------------------------------------

/**
 * Minimal domain support: create / drop / rename. Changes to the base
 * type or constraints force a DROP + CREATE since we don't have the
 * constraint bodies in the snapshot.
 */
export interface DomainCreateOp extends BaseChangeOp {
  category: 'domain';
  kind: 'create';
  baseType: string;
}

export interface DomainDropOp extends BaseChangeOp {
  category: 'domain';
  kind: 'drop';
}

/**
 * Destructive rebuild: base type changed → DROP + CREATE in a single op.
 * Emitted as one op so the user can't accidentally select CREATE without DROP.
 */
export interface DomainRebuildOp extends BaseChangeOp {
  category: 'domain';
  kind: 'rebuild';
  /** New base type (source side). */
  baseType: string;
  /** Old base type (target side), shown in the UI label. */
  oldBaseType: string;
}

export interface DomainRenameOp extends BaseChangeOp {
  category: 'domain';
  kind: 'rename';
  fromName: string;
  toName: string;
  /** Source-side base type, used by split / keep-both resolvers. */
  baseType?: string;
}

export type DomainOp = DomainCreateOp | DomainDropOp | DomainRebuildOp | DomainRenameOp;

// ---- Union of every op ----------------------------------------------------

export type ChangeOp = EnumOp | ViewOp | RoutineOp | SequenceOp | TriggerOp | DomainOp;

// ---------------------------------------------------------------------------
// Rename-resolution UI state (hybrid auto-detect + user override)
// ---------------------------------------------------------------------------

/**
 * Candidate rename suggested by the differ. The UI presents these so the user
 * can confirm ("yes, rename") or reject ("no, create + drop separately").
 */
export interface RenameCandidate {
  category: ObjectCategory;
  /** Name on the source side. */
  fromName: string;
  /** Name on the target side. */
  toName: string;
  /** 0..1 similarity — purely informational, driven by a Levenshtein heuristic. */
  confidence: number;
  /** Extra human-readable hint ("same columns / same position"). */
  hint?: string;
}

/**
 * Enum value rename candidate inside a single type. Same idea as
 * RenameCandidate but scoped to a parent enum.
 */
export interface EnumValueRenameCandidate {
  enumName: string;
  fromValue: string;
  toValue: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Top-level diff result consumed by the UI
// ---------------------------------------------------------------------------

export interface SchemaDiff {
  /** Legacy table diffs — unchanged for backwards compatibility. */
  tables: TableDiff[];
  /** New-style ops for all non-table categories. */
  ops: ChangeOp[];
  /** Rename candidates the user may accept. */
  renameCandidates: RenameCandidate[];
  enumValueRenameCandidates: EnumValueRenameCandidate[];
  hasChanges: boolean;
}

// ---------------------------------------------------------------------------
// Minimal convenience re-exports (used by differs to avoid importing from
// shared/types directly, keeping the module boundary obvious).
// ---------------------------------------------------------------------------

export type { Column, Index, Constraint, CustomType, View, PgFunction, Sequence, Trigger };
