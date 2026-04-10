/**
 * Enum differ.
 *
 * Produces `ChangeOp` entries for every enum-type change plus a set of
 * rename candidates that the UI can present to the user (hybrid model:
 * the differ auto-suggests, the user confirms or overrides).
 *
 * Strategy
 * --------
 * 1. Build a map of enum types by schema-qualified name (`schema.name`).
 * 2. "added" = present in source only, "dropped" = present in target only,
 *    "common" = present in both.
 * 3. For common types, diff the value lists:
 *    - Values only on the source side are candidates for ADD VALUE or,
 *      together with target-only values, candidates for RENAME VALUE.
 *    - Rename detection uses Levenshtein similarity; anything above the
 *      threshold (0.6 by default) becomes a RenameCandidate attached to
 *      the type. The UI can later flip "rename" to "add + drop".
 *    - Any remaining target-only value becomes a DROP VALUE candidate (which
 *      requires the rebuild dance — generator implements this in Phase 4).
 * 4. For added/dropped types themselves we also run rename detection across
 *    the type-name set so renaming an entire type survives.
 *
 * This file intentionally emits ops with `phase: 'pre-commit'` for
 * ADD VALUE and `phase: 'main'` for everything else; the planner takes
 * it from there.
 */

import type { DatabaseInfo, CustomType } from '@/shared/types';
import type {
  EnumOp,
  RenameCandidate,
  EnumValueRenameCandidate,
} from '../types';
import { bestMatches, similarity } from '../util/similarity';

/** Similarity threshold for enum *value* rename suggestions. */
const VALUE_RENAME_THRESHOLD = 0.35;

/** Similarity threshold for enum *type* rename suggestions (stricter). */
const TYPE_RENAME_THRESHOLD = 0.7;

/** Result of running the enum differ on two DatabaseInfo snapshots. */
export interface EnumDiffResult {
  ops: EnumOp[];
  renameCandidates: RenameCandidate[];
  valueRenameCandidates: EnumValueRenameCandidate[];
}

function enumQualifiedName(t: CustomType): string {
  const schema = t.schema || 'public';
  return `${schema}.${t.name}`;
}

function isEnumType(t: CustomType): boolean {
  // Primary: check type_type (from pg_type.typtype) — the authoritative flag.
  // Fallback: enum_values being a non-empty array for older data paths.
  return (t as any).type_type === 'e' || (Array.isArray(t.enum_values) && t.enum_values.length > 0);
}

/** Ensure enum_values is always a string[] for enum types. */
function ensureEnumValues(t: CustomType): string[] {
  if (Array.isArray(t.enum_values)) return t.enum_values;
  if (typeof t.enum_values === 'string') {
    return (t.enum_values as string)
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((v) => v.trim().replace(/^"|"$/g, ''))
      .filter((v) => v.length > 0);
  }
  return [];
}

/** Small helper — build a stable op id so the UI can track selection. */
function opId(parts: string[]): string {
  return parts.join(':');
}

/**
 * Cheap heuristic for "which target value was the user most likely
 * renaming when they typed a new source value". Filters by confidence and
 * returns the best per-pair assignment.
 */
function pairEnumValueRenames(
  sourceOnly: string[],
  targetOnly: string[],
): Array<{ from: string; to: string; confidence: number }> {
  return bestMatches(
    targetOnly, // "lefts" = values that disappeared from target
    sourceOnly, // "rights" = new values in source
    (x) => x,
    VALUE_RENAME_THRESHOLD,
  ).map(({ left, right, confidence }) => ({
    from: left,
    to: right,
    confidence,
  }));
}

export function diffEnums(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): EnumDiffResult {
  const sourceEnums = (sourceDb.types || []).filter(isEnumType);
  const targetEnums = (targetDb.types || []).filter(isEnumType);

  const sourceMap = new Map(sourceEnums.map((t) => [enumQualifiedName(t), t]));
  const targetMap = new Map(targetEnums.map((t) => [enumQualifiedName(t), t]));

  const ops: EnumOp[] = [];
  const renameCandidates: RenameCandidate[] = [];
  const valueRenameCandidates: EnumValueRenameCandidate[] = [];

  // -------------------------------------------------------------------------
  // Type-level rename detection (before we pick the add/drop sides).
  // -------------------------------------------------------------------------
  const addedTypes: CustomType[] = [];
  const droppedTypes: CustomType[] = [];

  for (const [name, src] of sourceMap) {
    if (!targetMap.has(name)) addedTypes.push(src);
  }
  for (const [name, tgt] of targetMap) {
    if (!sourceMap.has(name)) droppedTypes.push(tgt);
  }

  // Rename candidates: a dropped target type paired with an added source type
  // whose values overlap heavily.
  const typeRenames = bestMatches(
    droppedTypes,
    addedTypes,
    (t) => enumQualifiedName(t),
    TYPE_RENAME_THRESHOLD,
  );

  // Boost or reject rename suggestions by comparing value sets: if the two
  // enums share >= 70% of labels we consider it a strong rename, even when
  // the name similarity was only borderline.
  const acceptedTypeRenames = new Set<string>(); // keyed by "from|to"
  for (const match of typeRenames) {
    const from = match.left;
    const to = match.right;
    const srcVals = new Set(ensureEnumValues(from));
    const tgtVals = new Set(ensureEnumValues(to));
    const intersection = [...srcVals].filter((v) => tgtVals.has(v)).length;
    const union = new Set([...srcVals, ...tgtVals]).size || 1;
    const jaccard = intersection / union;
    // Combined score weights name similarity and value overlap equally.
    const combined = 0.5 * match.confidence + 0.5 * jaccard;
    if (combined >= 0.6) {
      const fromName = enumQualifiedName(from);
      const toName = enumQualifiedName(to);
      renameCandidates.push({
        category: 'enum',
        fromName,
        toName,
        confidence: combined,
        hint: `name≈${match.confidence.toFixed(2)}, values≈${jaccard.toFixed(2)}`,
      });
      acceptedTypeRenames.add(`${fromName}|${toName}`);

      // Generate a rename-type op (auto-accepted like views/routines).
      ops.push({
        id: opId(['enum', 'rename-type', fromName, toName]),
        category: 'enum',
        kind: 'rename-type',
        objectName: toName,
        phase: 'main',
        isDestructive: false,
        label: `${fromName} → ${toName}`,
        fromName,
        toName,
        values: ensureEnumValues(to),
      } as EnumOp);
    }
  }

  // -------------------------------------------------------------------------
  // CREATE / DROP ops for types with no rename suggestion.
  // -------------------------------------------------------------------------
  for (const src of addedTypes) {
    const qn = enumQualifiedName(src);
    // Skip if we already suggested this as the "to" side of a rename.
    if ([...acceptedTypeRenames].some((k) => k.endsWith(`|${qn}`))) continue;
    ops.push({
      id: opId(['enum', 'create', qn]),
      category: 'enum',
      kind: 'create',
      objectName: qn,
      phase: 'main',
      isDestructive: false,
      label: `CREATE TYPE ${qn}`,
      values: ensureEnumValues(src),
    });
  }

  for (const tgt of droppedTypes) {
    const qn = enumQualifiedName(tgt);
    // Skip if this type is slated to be renamed into a source type.
    if ([...acceptedTypeRenames].some((k) => k.startsWith(`${qn}|`))) continue;
    ops.push({
      id: opId(['enum', 'drop', qn]),
      category: 'enum',
      kind: 'drop',
      objectName: qn,
      phase: 'main',
      isDestructive: true,
      label: `DROP TYPE ${qn}`,
    });
  }

  // -------------------------------------------------------------------------
  // Value-level diff for types present in both sides.
  // -------------------------------------------------------------------------
  for (const [name, src] of sourceMap) {
    const tgt = targetMap.get(name);
    if (!tgt) continue;

    const srcVals = ensureEnumValues(src);
    const tgtVals = ensureEnumValues(tgt);
    const srcSet = new Set(srcVals);
    const tgtSet = new Set(tgtVals);

    const addedVals = srcVals.filter((v) => !tgtSet.has(v));
    const droppedVals = tgtVals.filter((v) => !srcSet.has(v));

    // Short-circuit when lists are identical.
    if (addedVals.length === 0 && droppedVals.length === 0) continue;

    // ---- rename suggestions -------------------------------------------------
    let renames = pairEnumValueRenames(addedVals, droppedVals);
    // Fallback: when there's exactly one added and one dropped value and
    // bestMatches didn't pair them (similarity too low), still suggest rename —
    // the user can always reject it via the Split button.
    if (renames.length === 0 && addedVals.length === 1 && droppedVals.length === 1) {
      const sim = similarity(droppedVals[0], addedVals[0]);
      renames = [{ from: droppedVals[0], to: addedVals[0], confidence: sim }];
    }
    const renamedSources = new Set(renames.map((r) => r.to));
    const renamedTargets = new Set(renames.map((r) => r.from));

    for (const r of renames) {
      valueRenameCandidates.push({
        enumName: name,
        fromValue: r.from,
        toValue: r.to,
        confidence: r.confidence,
      });
      ops.push({
        id: opId(['enum', 'rename-value', name, r.from, r.to]),
        category: 'enum',
        kind: 'rename-value',
        objectName: name,
        phase: 'main',
        isDestructive: false,
        label: `${name}: RENAME VALUE ${r.from} → ${r.to}`,
        fromValue: r.from,
        toValue: r.to,
      });
    }

    // ---- true additions ------------------------------------------------------
    const netAdded = addedVals.filter((v) => !renamedSources.has(v));
    for (const v of netAdded) {
      // Preserve source ordering — record the label that appears just before
      // the new one so the generator can pass BEFORE/AFTER anchors when the
      // dialect supports them (Postgres 11+).
      // IMPORTANT: only use anchors that already exist in the target enum,
      // otherwise Postgres will error ("X is not an existing enum label").
      // Walk the source list to find the nearest anchor that exists in target.
      const idx = srcVals.indexOf(v);
      let before: string | undefined;
      let after: string | undefined;
      // Search backward for nearest existing target value.
      for (let i = idx - 1; i >= 0; i--) {
        if (tgtSet.has(srcVals[i])) { after = srcVals[i]; break; }
      }
      // Search forward for nearest existing target value.
      if (!after) {
        for (let i = idx + 1; i < srcVals.length; i++) {
          if (tgtSet.has(srcVals[i])) { before = srcVals[i]; break; }
        }
      }
      ops.push({
        id: opId(['enum', 'add-value', name, v]),
        category: 'enum',
        kind: 'add-value',
        objectName: name,
        // ADD VALUE must run in its own transaction when other statements
        // reference the new label — planner moves it to pre-commit.
        phase: 'pre-commit',
        isDestructive: false,
        label: `${name}: ADD VALUE '${v}'`,
        value: v,
        before,
        after,
      });
    }

    // ---- true drops (destructive, need the rebuild dance) -------------------
    // The "post drop" value list is just the source values minus any
    // still-being-renamed labels — the source side is the target shape.
    const netDropped = droppedVals.filter((v) => !renamedTargets.has(v));
    const postDropValues = srcVals.slice();
    for (const v of netDropped) {
      ops.push({
        id: opId(['enum', 'drop-value', name, v]),
        category: 'enum',
        kind: 'drop-value',
        objectName: name,
        phase: 'main',
        isDestructive: true,
        label: `${name}: DROP VALUE '${v}'`,
        value: v,
        // Default: no replacement chosen — the UI must prompt the user.
        replacementValue: null,
        skipDataMigration: false,
        postDropValues,
      });
    }
  }

  return { ops, renameCandidates, valueRenameCandidates };
}

/** Exposed so tests can reach the heuristic directly. */
export { similarity as __similarity };
