/**
 * Sequence differ. Emits `SequenceOp`s keyed on `schema.name`. Supported
 * mutations: create, drop, rename, alter (non-destructive attribute change).
 */

import type { DatabaseInfo, Sequence } from '@/shared/types';
import type {
  SequenceOp,
  SequenceAttributes,
  RenameCandidate,
} from '../types';
import { normaliseIdent, similarity } from '../util/similarity';

const SEQUENCE_RENAME_THRESHOLD = 0.62;

function qualifiedName(s: Sequence): string {
  const schema = s.sequence_schema || 'public';
  return `${schema}.${s.sequence_name}`;
}

function extractAttrs(s: Sequence): SequenceAttributes {
  return {
    dataType: s.data_type,
    startValue: s.start_value,
    minValue: s.minimum_value,
    maxValue: s.maximum_value,
    increment: s.increment,
    cycle: s.cycle_option,
    cache: s.cache_size,
  };
}

/** Diff two attribute objects — returns only the fields that differ. */
function diffAttrs(src: SequenceAttributes, tgt: SequenceAttributes): Partial<SequenceAttributes> {
  const out: Partial<SequenceAttributes> = {};
  const keys: Array<keyof SequenceAttributes> = [
    'dataType',
    'startValue',
    'minValue',
    'maxValue',
    'increment',
    'cycle',
    'cache',
  ];
  for (const k of keys) {
    if (src[k] !== tgt[k]) {
      (out as Record<string, unknown>)[k] = src[k];
    }
  }
  return out;
}

export interface DiffSequencesResult {
  ops: SequenceOp[];
  renameCandidates: RenameCandidate[];
}

export function diffSequences(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): DiffSequencesResult {
  const srcList = sourceDb.sequences || [];
  const tgtList = targetDb.sequences || [];

  const srcMap = new Map(srcList.map((s) => [qualifiedName(s), s]));
  const tgtMap = new Map(tgtList.map((s) => [qualifiedName(s), s]));

  const ops: SequenceOp[] = [];
  const renameCandidates: RenameCandidate[] = [];

  const addedOnly: Sequence[] = [];
  const droppedOnly: Sequence[] = [];
  for (const [name, s] of srcMap) if (!tgtMap.has(name)) addedOnly.push(s);
  for (const [name, s] of tgtMap) if (!srcMap.has(name)) droppedOnly.push(s);

  // Rename detection on orphans.
  const usedTgt = new Set<number>();
  const matchedSrcNames = new Set<string>();
  for (const src of addedOnly) {
    let bestIdx = -1;
    let bestScore = 0;
    const srcKey = normaliseIdent(src.sequence_name);
    for (let i = 0; i < droppedOnly.length; i++) {
      if (usedTgt.has(i)) continue;
      const tgt = droppedOnly[i];
      if (tgt.sequence_schema !== src.sequence_schema) continue;
      const score = similarity(srcKey, normaliseIdent(tgt.sequence_name));
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= SEQUENCE_RENAME_THRESHOLD) {
      const tgt = droppedOnly[bestIdx];
      usedTgt.add(bestIdx);
      matchedSrcNames.add(qualifiedName(src));

      const fromName = qualifiedName(tgt);
      const toName = qualifiedName(src);

      renameCandidates.push({
        category: 'sequence',
        fromName,
        toName,
        confidence: bestScore,
      });
      ops.push({
        id: `sequence:rename:${fromName}->${toName}`,
        category: 'sequence',
        kind: 'rename',
        objectName: toName,
        phase: 'main',
        isDestructive: false,
        label: `${fromName} -> ${toName}: RENAME SEQUENCE`,
        fromName,
        toName,
      });

      // Attribute changes after rename?
      const attrDiff = diffAttrs(extractAttrs(src), extractAttrs(tgt));
      if (Object.keys(attrDiff).length > 0) {
        ops.push({
          id: `sequence:alter:${toName}:post-rename`,
          category: 'sequence',
          kind: 'alter',
          objectName: toName,
          phase: 'main',
          isDestructive: false,
          label: `${toName}: ALTER SEQUENCE`,
          changes: attrDiff,
          dependsOn: [toName],
        });
      }
    }
  }

  // Remaining add/drop.
  for (const src of addedOnly) {
    const qn = qualifiedName(src);
    if (matchedSrcNames.has(qn)) continue;
    ops.push({
      id: `sequence:create:${qn}`,
      category: 'sequence',
      kind: 'create',
      objectName: qn,
      phase: 'main',
      isDestructive: false,
      label: `${qn}: CREATE SEQUENCE`,
      attrs: extractAttrs(src),
    });
  }

  for (let i = 0; i < droppedOnly.length; i++) {
    if (usedTgt.has(i)) continue;
    const tgt = droppedOnly[i];
    const qn = qualifiedName(tgt);
    ops.push({
      id: `sequence:drop:${qn}`,
      category: 'sequence',
      kind: 'drop',
      objectName: qn,
      phase: 'main',
      isDestructive: true,
      label: `${qn}: DROP SEQUENCE`,
    });
  }

  // Present in both: attribute diff.
  for (const [name, src] of srcMap) {
    const tgt = tgtMap.get(name);
    if (!tgt) continue;
    const attrDiff = diffAttrs(extractAttrs(src), extractAttrs(tgt));
    if (Object.keys(attrDiff).length === 0) continue;
    ops.push({
      id: `sequence:alter:${name}`,
      category: 'sequence',
      kind: 'alter',
      objectName: name,
      phase: 'main',
      isDestructive: false,
      label: `${name}: ALTER SEQUENCE`,
      changes: attrDiff,
    });
  }

  return { ops, renameCandidates };
}
