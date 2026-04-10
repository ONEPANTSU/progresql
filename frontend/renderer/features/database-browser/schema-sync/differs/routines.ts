/**
 * Function / procedure differ.
 *
 * Postgres stores functions and procedures in slightly different catalogs
 * but the DDL shape is the same: `CREATE [OR REPLACE] FUNCTION|PROCEDURE
 * schema.name(args) ... AS $$...$$ LANGUAGE ...`. We emit one op per
 * (schema, name, arg-signature) tuple.
 *
 * Unlike views, functions can be overloaded (same name, different
 * argument lists count as separate objects), so we key by
 * `schema.name(argsig)` — this stable key doubles as the op id.
 *
 * The backend type used here (`Function`) mirrors information_schema and
 * emits one row per parameter. We collapse those rows into one routine
 * entry via the shared (schema, name, specific-name) triple so overloads
 * stay distinct.
 */

import type { DatabaseInfo, Function as PgFunction, Procedure } from '@/shared/types';
import type { RoutineOp, RenameCandidate, ObjectCategory } from '../types';
import { normaliseIdent, similarity } from '../util/similarity';

const ROUTINE_RENAME_THRESHOLD = 0.65;

/** Normalised routine record used internally by the differ. */
interface RoutineSig {
  category: Extract<ObjectCategory, 'function' | 'procedure'>;
  schema: string;
  name: string;
  /** Argument signature as `(type, type, ...)` — the part after the name. */
  argSig: string;
  /** Fully-qualified name without arg sig: `schema.name`. */
  qualifiedName: string;
  /** Stable id: `schema.name(argSig)`. */
  key: string;
  definition: string;
  language?: string;
}

/**
 * information_schema flattens functions into one row per parameter. We
 * group rows by (specific_name) when available, or fall back to
 * (schema, name) which loses overload information.
 *
 * Since the current `Function` type doesn't expose specific_name or a
 * parsed parameter list, this implementation is a best-effort: we key
 * purely by (schema, name) and append a `()` placeholder for the arg
 * signature. Overload detection is a follow-up (needs a backend change
 * to include specific_name + pg_get_function_identity_arguments).
 */
function collectFunctions(funcs: PgFunction[] | undefined): RoutineSig[] {
  if (!funcs) return [];
  const byKey = new Map<string, RoutineSig>();
  for (const f of funcs) {
    const schema = f.routine_schema || 'public';
    const name = f.routine_name;
    // Without identity_arguments we can't build a real arg signature; use
    // an empty signature and accept that overloads collapse. The generator
    // will emit `DROP FUNCTION schema.name` which Postgres rejects for
    // ambiguous overloads — user can still edit the SQL afterwards.
    const argSig = '';
    const qn = `${schema}.${name}`;
    const key = `${qn}(${argSig})`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      category: 'function',
      schema,
      name,
      argSig,
      qualifiedName: qn,
      key,
      definition: f.routine_definition || '',
      language: f.external_language,
    });
  }
  return Array.from(byKey.values());
}

function collectProcedures(procs: Procedure[] | undefined): RoutineSig[] {
  if (!procs) return [];
  const byKey = new Map<string, RoutineSig>();
  for (const p of procs) {
    const schema = p.procedure_schema || 'public';
    const name = p.procedure_name;
    const argSig = '';
    const qn = `${schema}.${name}`;
    const key = `${qn}(${argSig})`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      category: 'procedure',
      schema,
      name,
      argSig,
      qualifiedName: qn,
      key,
      definition: p.procedure_definition || '',
      language: p.external_language,
    });
  }
  return Array.from(byKey.values());
}

function normaliseBody(def: string | undefined | null): string {
  if (!def) return '';
  return def.replace(/\s+/g, ' ').trim();
}

function buildOpLabel(kind: string, sig: RoutineSig): string {
  return `${sig.qualifiedName}${sig.argSig}: ${kind}`;
}

export interface DiffRoutinesResult {
  ops: RoutineOp[];
  renameCandidates: RenameCandidate[];
}

/**
 * Shared rename/create/drop/replace engine for both functions and
 * procedures. Pulled out so both categories share the same logic.
 */
function diffRoutineList(
  srcList: RoutineSig[],
  tgtList: RoutineSig[],
  category: Extract<ObjectCategory, 'function' | 'procedure'>,
): DiffRoutinesResult {
  const srcMap = new Map(srcList.map((r) => [r.key, r]));
  const tgtMap = new Map(tgtList.map((r) => [r.key, r]));

  const ops: RoutineOp[] = [];
  const renameCandidates: RenameCandidate[] = [];

  const addedOnly: RoutineSig[] = [];
  const droppedOnly: RoutineSig[] = [];

  for (const [key, r] of srcMap) {
    if (!tgtMap.has(key)) addedOnly.push(r);
  }
  for (const [key, r] of tgtMap) {
    if (!srcMap.has(key)) droppedOnly.push(r);
  }

  // Rename detection: greedy match on name similarity, boosted by
  // identical definition.
  const usedTgt = new Set<number>();
  const matchedSrcKeys = new Set<string>();

  for (const src of addedOnly) {
    let bestIdx = -1;
    let bestScore = 0;
    const srcNameKey = normaliseIdent(src.name);
    for (let i = 0; i < droppedOnly.length; i++) {
      if (usedTgt.has(i)) continue;
      const tgt = droppedOnly[i];
      if (tgt.schema !== src.schema) continue; // rename across schemas is too risky to auto-detect
      let score = similarity(srcNameKey, normaliseIdent(tgt.name));
      if (normaliseBody(src.definition) === normaliseBody(tgt.definition)) {
        score = Math.min(1, score + 0.15);
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= ROUTINE_RENAME_THRESHOLD) {
      const tgt = droppedOnly[bestIdx];
      usedTgt.add(bestIdx);
      matchedSrcKeys.add(src.key);

      renameCandidates.push({
        category,
        fromName: tgt.qualifiedName,
        toName: src.qualifiedName,
        confidence: bestScore,
        hint:
          normaliseBody(src.definition) === normaliseBody(tgt.definition)
            ? 'same body'
            : undefined,
      });

      ops.push({
        id: `${category}:rename:${tgt.qualifiedName}->${src.qualifiedName}`,
        category,
        kind: 'rename',
        objectName: src.qualifiedName,
        phase: 'main',
        isDestructive: false,
        label: `${tgt.qualifiedName} -> ${src.qualifiedName}: RENAME ${category.toUpperCase()}`,
        fromName: tgt.qualifiedName,
        toName: src.qualifiedName,
        argSignature: src.argSig,
        definition: src.definition,
        language: src.language,
      });

      // If body also differs, queue a follow-up replace after the rename.
      if (normaliseBody(src.definition) !== normaliseBody(tgt.definition)) {
        ops.push({
          id: `${category}:replace:${src.key}:post-rename`,
          category,
          kind: 'replace',
          objectName: src.qualifiedName,
          phase: 'main',
          isDestructive: false,
          label: buildOpLabel('REPLACE', src),
          definition: src.definition,
          argSignature: src.argSig,
          language: src.language,
          dependsOn: [src.qualifiedName],
        });
      }
    }
  }

  // Remaining add-only -> CREATE
  for (const src of addedOnly) {
    if (matchedSrcKeys.has(src.key)) continue;
    ops.push({
      id: `${category}:create:${src.key}`,
      category,
      kind: 'create',
      objectName: src.qualifiedName,
      phase: 'main',
      isDestructive: false,
      label: buildOpLabel(`CREATE ${category.toUpperCase()}`, src),
      definition: src.definition,
      argSignature: src.argSig,
      language: src.language,
    });
  }

  // Remaining drop-only -> DROP (destructive)
  for (let i = 0; i < droppedOnly.length; i++) {
    if (usedTgt.has(i)) continue;
    const tgt = droppedOnly[i];
    ops.push({
      id: `${category}:drop:${tgt.key}`,
      category,
      kind: 'drop',
      objectName: tgt.qualifiedName,
      phase: 'main',
      isDestructive: true,
      label: buildOpLabel(`DROP ${category.toUpperCase()}`, tgt),
      argSignature: tgt.argSig,
    });
  }

  // Present in both: body diff -> REPLACE
  for (const [key, src] of srcMap) {
    const tgt = tgtMap.get(key);
    if (!tgt) continue;
    if (normaliseBody(src.definition) === normaliseBody(tgt.definition)) continue;
    ops.push({
      id: `${category}:replace:${src.key}`,
      category,
      kind: 'replace',
      objectName: src.qualifiedName,
      phase: 'main',
      isDestructive: false,
      label: buildOpLabel(`REPLACE ${category.toUpperCase()}`, src),
      definition: src.definition,
      argSignature: src.argSig,
      language: src.language,
    });
  }

  return { ops, renameCandidates };
}

export function diffFunctions(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): DiffRoutinesResult {
  return diffRoutineList(
    collectFunctions(sourceDb.functions),
    collectFunctions(targetDb.functions),
    'function',
  );
}

export function diffProcedures(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): DiffRoutinesResult {
  return diffRoutineList(
    collectProcedures(sourceDb.procedures),
    collectProcedures(targetDb.procedures),
    'procedure',
  );
}
