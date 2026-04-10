/**
 * User-decision resolver.
 *
 * The differ emits a baseline of `ChangeOp`s with reasonable defaults:
 *   - every detected value-rename becomes a RENAME VALUE op
 *   - every drop-value becomes a destructive op with no replacement picked
 *   - every detected object rename becomes a RENAME op
 *
 * The UI then lets the user tweak those defaults (reject a rename, pick a
 * replacement label for a dropped value, skip the data migration, or
 * downgrade an object rename into "split into drop+create" / "keep both
 * sides"). This module folds those tweaks back into a final list of ops
 * before the planner sees it. Keeping the resolver outside the React
 * component makes it unit-testable and means the planner never has to
 * know about UI state.
 */

import type {
  ChangeOp,
  EnumOp,
  ViewOp,
  RoutineOp,
  DomainOp,
  TableDiff,
} from './types';

/**
 * How the user wants an object rename handled:
 *
 *   - `accept`    — emit a real `RENAME` statement (differ's default)
 *   - `split`     — drop the old name, create the new name (data is lost)
 *   - `keep-both` — create the new name, leave the old one untouched
 */
export type RenameMode = 'accept' | 'split' | 'keep-both';

export interface UserDecisions {
  /** Op ids where the user rejected the auto-detected rename-value suggestion. */
  rejectedValueRenames: Set<string>;
  /** Per drop-value op: which label to migrate existing rows to (or null for NULL), plus skip flag. */
  dropValueChoices: Map<string, { replacement: string | null; skip: boolean }>;
  /** unqualified enum name -> ordered source-side value list (for synthesising split ops). */
  sourceEnumValues: Map<string, string[]>;
  /** unqualified enum name -> ordered target-side value list (for safe anchor selection in splits). */
  targetEnumValues?: Map<string, string[]>;
  /**
   * Per-op rename resolution choice. Keyed by the rename op id for
   * view/routine/domain renames. Tables use a parallel map keyed by table
   * name — see `resolveTableRenames()` below.
   */
  renameResolutions?: Map<string, RenameMode>;
  /** Override rename-value target: opId → new toValue. */
  renameValueTargets?: Map<string, string>;
}

/**
 * Replace a rename-value op with an add-value + drop-value pair. Used when
 * the user rejects the differ's auto-rename suggestion: the intent becomes
 * "these are two unrelated changes".
 */
function splitRenameValue(
  op: Extract<EnumOp, { kind: 'rename-value' }>,
  sourceEnumValues: Map<string, string[]>,
  targetEnumValues?: Map<string, string[]>,
): EnumOp[] {
  const sourceVals = sourceEnumValues.get(op.objectName) ?? [];
  const tgtVals = new Set(targetEnumValues?.get(op.objectName) ?? []);
  const idx = sourceVals.indexOf(op.toValue);

  // IMPORTANT: only use anchors that already exist in the TARGET enum,
  // otherwise Postgres will error ("X is not an existing enum label").
  // ADD VALUE runs in pre-commit phase before RENAME VALUE, so renamed
  // values don't exist yet at that point.
  let before: string | undefined;
  let after: string | undefined;
  // Search backward for nearest existing target value.
  for (let i = idx - 1; i >= 0; i--) {
    if (tgtVals.has(sourceVals[i])) { after = sourceVals[i]; break; }
  }
  // Search forward for nearest existing target value.
  if (!after) {
    for (let i = idx + 1; i < sourceVals.length; i++) {
      if (tgtVals.has(sourceVals[i])) { before = sourceVals[i]; break; }
    }
  }

  return [
    {
      id: `${op.id}:split-add`,
      category: 'enum',
      kind: 'add-value',
      objectName: op.objectName,
      phase: 'pre-commit',
      isDestructive: false,
      label: `${op.objectName}: ADD VALUE '${op.toValue}'`,
      value: op.toValue,
      before,
      after,
    },
    {
      id: `${op.id}:split-drop`,
      category: 'enum',
      kind: 'drop-value',
      objectName: op.objectName,
      phase: 'main',
      isDestructive: true,
      label: `${op.objectName}: DROP VALUE '${op.fromValue}'`,
      value: op.fromValue,
      replacementValue: null,
      skipDataMigration: false,
      // The resolved source-side list (after add-value) minus the dropped label.
      postDropValues: sourceVals,
    },
  ];
}

// ---------------------------------------------------------------------------
// Object rename resolvers
// ---------------------------------------------------------------------------

/**
 * Materialise a view rename as its equivalent DROP+CREATE pair (when
 * `mode === 'split'`) or a CREATE of the new name while leaving the old
 * alone (when `mode === 'keep-both'`). Falls back to the original rename
 * op when no definition was captured (e.g. from an older diff) or when
 * `mode === 'accept'`.
 */
function resolveViewRename(
  op: Extract<ViewOp, { kind: 'rename' }>,
  mode: RenameMode,
): ViewOp[] {
  if (mode === 'accept') return [op];

  const def = op.definition ?? '';
  if (!def) {
    // No definition captured — we can't split safely, so fall back to accept.
    return [op];
  }

  const createOp: Extract<ViewOp, { kind: 'create' }> = {
    id: `${op.id}:split-create`,
    category: 'view',
    kind: 'create',
    objectName: op.toName,
    phase: 'main',
    isDestructive: false,
    label: `${op.toName}: CREATE VIEW (from split rename)`,
    definition: def,
  };

  if (mode === 'keep-both') {
    return [createOp];
  }

  // split → drop old + create new
  const dropOp: Extract<ViewOp, { kind: 'drop' }> = {
    id: `${op.id}:split-drop`,
    category: 'view',
    kind: 'drop',
    objectName: op.fromName,
    phase: 'main',
    isDestructive: true,
    label: `${op.fromName}: DROP VIEW (from split rename)`,
  };
  return [dropOp, createOp];
}

function resolveRoutineRename(
  op: Extract<RoutineOp, { kind: 'rename' }>,
  mode: RenameMode,
): RoutineOp[] {
  if (mode === 'accept') return [op];

  const def = op.definition ?? '';
  if (!def) return [op];

  const createOp: Extract<RoutineOp, { kind: 'create' }> = {
    id: `${op.id}:split-create`,
    category: op.category,
    kind: 'create',
    objectName: op.toName,
    phase: 'main',
    isDestructive: false,
    label: `${op.toName}: CREATE ${op.category.toUpperCase()} (from split rename)`,
    definition: def,
    argSignature: op.argSignature,
    language: op.language,
  };

  if (mode === 'keep-both') {
    return [createOp];
  }

  const dropOp: Extract<RoutineOp, { kind: 'drop' }> = {
    id: `${op.id}:split-drop`,
    category: op.category,
    kind: 'drop',
    objectName: op.fromName,
    phase: 'main',
    isDestructive: true,
    label: `${op.fromName}: DROP ${op.category.toUpperCase()} (from split rename)`,
    argSignature: op.argSignature,
  };
  return [dropOp, createOp];
}

function resolveDomainRename(
  op: Extract<DomainOp, { kind: 'rename' }>,
  mode: RenameMode,
): DomainOp[] {
  if (mode === 'accept') return [op];

  const baseType = op.baseType ?? '';
  if (!baseType) return [op];

  const createOp: Extract<DomainOp, { kind: 'create' }> = {
    id: `${op.id}:split-create`,
    category: 'domain',
    kind: 'create',
    objectName: op.toName,
    phase: 'main',
    isDestructive: false,
    label: `${op.toName}: CREATE DOMAIN (from split rename)`,
    baseType,
  };

  if (mode === 'keep-both') {
    return [createOp];
  }

  const dropOp: Extract<DomainOp, { kind: 'drop' }> = {
    id: `${op.id}:split-drop`,
    category: 'domain',
    kind: 'drop',
    objectName: op.fromName,
    phase: 'main',
    isDestructive: true,
    label: `${op.fromName}: DROP DOMAIN (from split rename)`,
  };
  return [dropOp, createOp];
}

/**
 * Resolve an enum rename-type op based on the user's chosen mode.
 * - `accept` → keep the RENAME statement
 * - `split`  → DROP old + CREATE new (destructive)
 * - `keep-both` → CREATE new only (old stays)
 */
function resolveEnumRename(
  op: Extract<EnumOp, { kind: 'rename-type' }>,
  mode: RenameMode,
): EnumOp[] {
  if (mode === 'accept') return [op];

  const values = (op as any).values ?? [];

  const createOp: Extract<EnumOp, { kind: 'create' }> = {
    id: `${op.id}:split-create`,
    category: 'enum',
    kind: 'create',
    objectName: op.toName,
    phase: 'main',
    isDestructive: false,
    label: `CREATE TYPE ${op.toName}`,
    values,
  };

  if (mode === 'keep-both') {
    return [createOp];
  }

  // split → DROP old + CREATE new
  const dropOp: Extract<EnumOp, { kind: 'drop' }> = {
    id: `${op.id}:split-drop`,
    category: 'enum',
    kind: 'drop',
    objectName: op.fromName,
    phase: 'main',
    isDestructive: true,
    label: `DROP TYPE ${op.fromName}`,
  };
  return [dropOp, createOp];
}

/**
 * Apply every UI decision to the raw differ output. Returns a new array —
 * the input is not mutated so React state stays stable.
 */
export function resolveOps(rawOps: ChangeOp[], decisions: UserDecisions): ChangeOp[] {
  const out: ChangeOp[] = [];
  const renameModes = decisions.renameResolutions ?? new Map<string, RenameMode>();

  for (const op of rawOps) {
    // --- Enum ops -------------------------------------------------------
    if (op.category === 'enum') {
      if (op.kind === 'rename-value' && decisions.rejectedValueRenames.has(op.id)) {
        out.push(...splitRenameValue(op, decisions.sourceEnumValues, decisions.targetEnumValues));
        continue;
      }

      // User may have overridden the rename target.
      if (op.kind === 'rename-value' && decisions.renameValueTargets?.has(op.id)) {
        const newTo = decisions.renameValueTargets.get(op.id)!;
        if (newTo !== op.toValue) {
          out.push({ ...op, toValue: newTo, label: `${op.objectName}: RENAME VALUE ${op.fromValue} → ${newTo}` });
          continue;
        }
      }

      if (op.kind === 'drop-value') {
        const choice = decisions.dropValueChoices.get(op.id);
        if (choice) {
          out.push({
            ...op,
            replacementValue: choice.replacement,
            skipDataMigration: choice.skip,
          });
          continue;
        }
      }

      if (op.kind === 'rename-type') {
        const mode = renameModes.get(op.id) ?? 'accept';
        out.push(...resolveEnumRename(op as Extract<EnumOp, { kind: 'rename-type' }>, mode));
        continue;
      }

      out.push(op);
      continue;
    }

    // --- View / routine / domain rename resolution ---------------------
    if (op.category === 'view' && op.kind === 'rename') {
      const mode = renameModes.get(op.id) ?? 'accept';
      out.push(...resolveViewRename(op, mode));
      continue;
    }
    if ((op.category === 'function' || op.category === 'procedure') && op.kind === 'rename') {
      const mode = renameModes.get(op.id) ?? 'accept';
      out.push(...resolveRoutineRename(op, mode));
      continue;
    }
    if (op.category === 'domain' && op.kind === 'rename') {
      const mode = renameModes.get(op.id) ?? 'accept';
      out.push(...resolveDomainRename(op, mode));
      continue;
    }

    out.push(op);
  }

  // ---- Safety net: sanitize ADD VALUE anchors against target values --------
  // Any add-value op whose before/after anchor references a value that does
  // NOT exist in the target enum (and thus won't exist at pre-commit time)
  // must have that anchor stripped. This catches edge cases where anchors
  // leak through from rename targets, split ops, or code paths we missed.
  if (decisions.targetEnumValues && decisions.targetEnumValues.size > 0) {
    for (let i = 0; i < out.length; i++) {
      const op = out[i];
      if (op.category !== 'enum' || op.kind !== 'add-value') continue;
      const tgtVals = new Set(decisions.targetEnumValues.get(op.objectName) ?? []);
      if (tgtVals.size === 0) continue;
      const addOp = op as Extract<EnumOp, { kind: 'add-value' }>;
      let needsFix = false;
      if (addOp.before && !tgtVals.has(addOp.before)) needsFix = true;
      if (addOp.after && !tgtVals.has(addOp.after)) needsFix = true;
      if (needsFix) {
        out[i] = {
          ...addOp,
          before: addOp.before && tgtVals.has(addOp.before) ? addOp.before : undefined,
          after: addOp.after && tgtVals.has(addOp.after) ? addOp.after : undefined,
        };
      }
    }
  }

  return out;
}

/**
 * Helper used by the UI to synthesise the "when a drop-value op gets split
 * out of a rejected rename" id pair without importing the internal shape.
 */
export function splitOpIds(renameValueOpId: string): { add: string; drop: string } {
  return {
    add: `${renameValueOpId}:split-add`,
    drop: `${renameValueOpId}:split-drop`,
  };
}

// ---------------------------------------------------------------------------
// Table-rename resolution (separate because tables still use `TableDiff`)
// ---------------------------------------------------------------------------

/**
 * Apply the user's rename resolution choice to the legacy `TableDiff[]`.
 * Tables haven't migrated to the `ChangeOp` model yet, so this lives
 * alongside `resolveOps` as a parallel helper. The caller threads its
 * output back into `SchemaDiff.tables` before invoking the planner.
 *
 * Modes:
 *
 *   - `accept`    — keep the rename diff as-is
 *   - `split`     — emit a DROP of the old name + ADD of the new name
 *                   using the full source column/index/constraint lists
 *                   captured at diff time. Destroys the target's data.
 *   - `keep-both` — emit only an ADD of the new name; leave the old
 *                   table (and its data) untouched.
 *
 * Tables that have neither kind === 'rename' nor a source-side snapshot
 * to build a CREATE from are passed through unchanged.
 */
export function resolveTableRenames(
  tables: TableDiff[],
  renameModes: Map<string, RenameMode>,
): TableDiff[] {
  if (renameModes.size === 0) return tables;
  const out: TableDiff[] = [];

  for (const td of tables) {
    if (td.kind !== 'rename') {
      out.push(td);
      continue;
    }

    const mode = renameModes.get(td.tableName) ?? 'accept';
    if (mode === 'accept') {
      out.push(td);
      continue;
    }

    // Need source-side columns to materialise a CREATE TABLE statement;
    // fall back to accept if the differ didn't capture them.
    const srcCols = td.sourceColumns;
    if (!srcCols || srcCols.length === 0) {
      out.push(td);
      continue;
    }

    const addDiff: TableDiff = {
      tableName: td.tableName,
      kind: 'add',
      columns: srcCols.map((c) => ({
        kind: 'add',
        tableName: td.tableName,
        column: c,
      })),
      indexes: (td.sourceIndexes ?? []).map((i) => ({
        kind: 'add',
        tableName: td.tableName,
        index: i,
      })),
      constraints: (td.sourceConstraints ?? []).map((c) => ({
        kind: 'add',
        tableName: td.tableName,
        constraint: c,
      })),
      isDestructive: false,
    };

    if (mode === 'keep-both') {
      out.push(addDiff);
      continue;
    }

    // split → drop the old target name + create the new source name
    if (td.renamedFrom) {
      out.push({
        tableName: td.renamedFrom,
        kind: 'drop',
        columns: [],
        indexes: [],
        constraints: [],
        isDestructive: true,
      });
    }
    out.push(addDiff);
  }

  return out;
}
