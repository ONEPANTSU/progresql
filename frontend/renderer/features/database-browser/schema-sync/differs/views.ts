/**
 * View differ.
 *
 * Emits the new-style `ChangeOp` model — one op per view plus rename
 * candidates for the UI. Semantics:
 *
 *  - exists only in source  -> `ViewCreateOp`
 *  - exists only in target  -> `ViewDropOp` (destructive)
 *  - exists in both, definitions differ -> `ViewReplaceOp`
 *     * `CREATE OR REPLACE VIEW` is tried first (non-destructive)
 *     * if the column list changed we set `forceRecreate: true`
 *  - exists on both sides under different names -> `ViewRenameOp` +
 *    follow-up `ViewReplaceOp` if the body also changed
 *
 * All ops run in the `main` phase: views have no transaction restriction
 * like `ALTER TYPE ADD VALUE`, so phase splitting is only needed when a
 * downstream op depends on the view being dropped first.
 */

import type { DatabaseInfo, View } from '@/shared/types';
import type { ViewOp, RenameCandidate } from '../types';
import { normaliseIdent, similarity } from '../util/similarity';

const VIEW_RENAME_THRESHOLD = 0.62;

function qualifiedName(v: View): string {
  const schema = v.view_schema || 'public';
  return `${schema}.${v.view_name}`;
}

/** Normalise view definition for comparison: trim, collapse whitespace. */
function normaliseDefinition(def: string | undefined | null): string {
  if (!def) return '';
  return def.replace(/\s+/g, ' ').trim();
}

/**
 * Very rough "column list changed?" heuristic. Postgres' rule is that
 * `CREATE OR REPLACE VIEW` must preserve the existing output column list
 * (you can only append new columns at the end). We do not have the
 * parsed column list here, so we extract the leading `SELECT ... FROM`
 * chunk and compare those blobs.
 */
function columnListChanged(oldDef: string, newDef: string): boolean {
  const extract = (def: string): string => {
    const normalised = normaliseDefinition(def);
    const fromIdx = normalised.toLowerCase().search(/\bfrom\b/);
    const selectIdx = normalised.toLowerCase().indexOf('select');
    if (selectIdx < 0 || fromIdx < 0 || fromIdx < selectIdx) return normalised;
    return normalised.slice(selectIdx + 'select'.length, fromIdx).trim();
  };
  return extract(oldDef) !== extract(newDef);
}

function renderOpLabel(kind: string, name: string): string {
  return `${name}: ${kind}`;
}

export interface DiffViewsResult {
  ops: ViewOp[];
  renameCandidates: RenameCandidate[];
}

export function diffViews(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): DiffViewsResult {
  const srcViews = sourceDb.views || [];
  const tgtViews = targetDb.views || [];

  const srcMap = new Map(srcViews.map((v) => [qualifiedName(v), v]));
  const tgtMap = new Map(tgtViews.map((v) => [qualifiedName(v), v]));

  const ops: ViewOp[] = [];
  const renameCandidates: RenameCandidate[] = [];

  // Added / dropped buckets for rename detection.
  const addedOnly: View[] = [];
  const droppedOnly: View[] = [];

  for (const [name, v] of srcMap) {
    if (!tgtMap.has(name)) addedOnly.push(v);
  }
  for (const [name, v] of tgtMap) {
    if (!srcMap.has(name)) droppedOnly.push(v);
  }

  // Rename detection: greedy bipartite match on normalised name; boost
  // score by +0.1 when the definitions are byte-identical.
  const usedTgt = new Set<number>();
  for (const src of addedOnly.slice()) {
    let bestIdx = -1;
    let bestScore = 0;
    const srcKey = normaliseIdent(src.view_name);
    for (let i = 0; i < droppedOnly.length; i++) {
      if (usedTgt.has(i)) continue;
      const tgt = droppedOnly[i];
      let score = similarity(srcKey, normaliseIdent(tgt.view_name));
      if (normaliseDefinition(src.view_definition) === normaliseDefinition(tgt.view_definition)) {
        score = Math.min(1, score + 0.1);
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= VIEW_RENAME_THRESHOLD) {
      const tgt = droppedOnly[bestIdx];
      const srcName = qualifiedName(src);
      const tgtName = qualifiedName(tgt);
      usedTgt.add(bestIdx);

      renameCandidates.push({
        category: 'view',
        fromName: tgtName,
        toName: srcName,
        confidence: bestScore,
        hint:
          normaliseDefinition(src.view_definition) === normaliseDefinition(tgt.view_definition)
            ? 'same definition'
            : undefined,
      });

      ops.push({
        id: `view:rename:${tgtName}->${srcName}`,
        category: 'view',
        kind: 'rename',
        objectName: srcName,
        phase: 'main',
        isDestructive: false,
        label: `${tgtName} -> ${srcName}: RENAME VIEW`,
        fromName: tgtName,
        toName: srcName,
        definition: src.view_definition,
      });

      // If the definition also changed, queue a follow-up replace under
      // the new name so downstream consumers see the updated body.
      if (normaliseDefinition(src.view_definition) !== normaliseDefinition(tgt.view_definition)) {
        const forceRecreate = columnListChanged(tgt.view_definition || '', src.view_definition || '');
        ops.push({
          id: `view:replace:${srcName}:post-rename`,
          category: 'view',
          kind: 'replace',
          objectName: srcName,
          phase: 'main',
          isDestructive: forceRecreate,
          label: renderOpLabel(forceRecreate ? 'REBUILD VIEW' : 'REPLACE VIEW', srcName),
          definition: src.view_definition,
          forceRecreate,
          dependsOn: [srcName],
        });
      }
    }
  }

  // Remove matched entries — remaining are true add/drop.
  const remainingAdds = addedOnly.filter(
    (v) => !renameCandidates.some((c) => c.toName === qualifiedName(v) && c.category === 'view'),
  );
  const remainingDrops = droppedOnly.filter(
    (_, i) => !usedTgt.has(i),
  );

  for (const v of remainingAdds) {
    const name = qualifiedName(v);
    ops.push({
      id: `view:create:${name}`,
      category: 'view',
      kind: 'create',
      objectName: name,
      phase: 'main',
      isDestructive: false,
      label: renderOpLabel('CREATE VIEW', name),
      definition: v.view_definition,
    });
  }

  for (const v of remainingDrops) {
    const name = qualifiedName(v);
    ops.push({
      id: `view:drop:${name}`,
      category: 'view',
      kind: 'drop',
      objectName: name,
      phase: 'main',
      isDestructive: true,
      label: renderOpLabel('DROP VIEW', name),
    });
  }

  // Views present in both — definition diff.
  for (const [name, srcView] of srcMap) {
    const tgtView = tgtMap.get(name);
    if (!tgtView) continue;
    const srcDef = normaliseDefinition(srcView.view_definition);
    const tgtDef = normaliseDefinition(tgtView.view_definition);
    if (srcDef === tgtDef) continue;

    const forceRecreate = columnListChanged(tgtView.view_definition || '', srcView.view_definition || '');
    ops.push({
      id: `view:replace:${name}`,
      category: 'view',
      kind: 'replace',
      objectName: name,
      phase: 'main',
      isDestructive: forceRecreate,
      label: renderOpLabel(forceRecreate ? 'REBUILD VIEW' : 'REPLACE VIEW', name),
      definition: srcView.view_definition,
      forceRecreate,
    });
  }

  return { ops, renameCandidates };
}
