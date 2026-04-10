/**
 * Trigger differ. Triggers are scoped to a table, so the object key is
 * `schema.table.trigger_name`. Because Postgres cannot ALTER the body of
 * an existing trigger, any body change becomes a `replace` (DROP +
 * CREATE). The only in-place ALTER is RENAME TO.
 *
 * Note: the `Trigger` type in `shared/types` does not carry the full
 * `CREATE TRIGGER` DDL — only the action body. We re-assemble a minimal
 * statement from the fields we do have. If the schema snapshot grows a
 * `definition` field in future, switch to that here.
 */

import type { DatabaseInfo, Trigger } from '@/shared/types';
import type { TriggerOp, RenameCandidate } from '../types';
import { normaliseIdent, similarity } from '../util/similarity';

const TRIGGER_RENAME_THRESHOLD = 0.65;

function tableQualifiedName(t: Trigger): string {
  const schema = t.event_object_schema || 'public';
  return `${schema}.${t.event_object_table}`;
}

/** Unique key within a schema: `schema.table.trigger`. */
function triggerKey(t: Trigger): string {
  return `${tableQualifiedName(t)}.${t.trigger_name}`;
}

/** Returns true when two triggers differ in *body* (anything but name). */
function bodyEqual(a: Trigger, b: Trigger): boolean {
  return (
    a.event_manipulation === b.event_manipulation &&
    a.action_timing === b.action_timing &&
    a.action_orientation === b.action_orientation &&
    (a.action_statement || '').trim() === (b.action_statement || '').trim() &&
    (a.action_condition || '') === (b.action_condition || '')
  );
}

/** Assemble a best-effort `CREATE TRIGGER` from the fields we do have. */
function assembleCreate(t: Trigger): string {
  const timing = t.action_timing; // BEFORE / AFTER / INSTEAD OF
  const event = t.event_manipulation; // INSERT / UPDATE / DELETE
  const forEach = t.action_orientation === 'ROW' ? 'FOR EACH ROW' : 'FOR EACH STATEMENT';
  const when = t.action_condition ? ` WHEN (${t.action_condition})` : '';
  const body = t.action_statement || '';
  const tbl = tableQualifiedName(t);
  return `CREATE TRIGGER ${t.trigger_name} ${timing} ${event} ON ${tbl} ${forEach}${when} ${body};`;
}

export interface DiffTriggersResult {
  ops: TriggerOp[];
  renameCandidates: RenameCandidate[];
}

export function diffTriggers(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): DiffTriggersResult {
  const src = sourceDb.triggers || [];
  const tgt = targetDb.triggers || [];

  const srcMap = new Map(src.map((t) => [triggerKey(t), t]));
  const tgtMap = new Map(tgt.map((t) => [triggerKey(t), t]));

  const ops: TriggerOp[] = [];
  const renameCandidates: RenameCandidate[] = [];

  const addedOnly: Trigger[] = [];
  const droppedOnly: Trigger[] = [];
  for (const [k, t] of srcMap) if (!tgtMap.has(k)) addedOnly.push(t);
  for (const [k, t] of tgtMap) if (!srcMap.has(k)) droppedOnly.push(t);

  // Rename detection scoped to the same table.
  const usedTgt = new Set<number>();
  const matchedSrcKeys = new Set<string>();
  for (const s of addedOnly) {
    let bestIdx = -1;
    let bestScore = 0;
    const srcKey = normaliseIdent(s.trigger_name);
    const srcTable = tableQualifiedName(s);
    for (let i = 0; i < droppedOnly.length; i++) {
      if (usedTgt.has(i)) continue;
      const t = droppedOnly[i];
      if (tableQualifiedName(t) !== srcTable) continue; // only within same table
      let score = similarity(srcKey, normaliseIdent(t.trigger_name));
      if (bodyEqual(s, t)) score = Math.min(1, score + 0.15);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= TRIGGER_RENAME_THRESHOLD) {
      const t = droppedOnly[bestIdx];
      usedTgt.add(bestIdx);
      matchedSrcKeys.add(triggerKey(s));

      const fromName = t.trigger_name;
      const toName = s.trigger_name;
      const tableName = tableQualifiedName(s);

      renameCandidates.push({
        category: 'trigger',
        fromName: `${tableName}.${fromName}`,
        toName: `${tableName}.${toName}`,
        confidence: bestScore,
        hint: bodyEqual(s, t) ? 'same body' : undefined,
      });

      ops.push({
        id: `trigger:rename:${tableName}.${fromName}->${toName}`,
        category: 'trigger',
        kind: 'rename',
        objectName: `${tableName}.${toName}`,
        phase: 'main',
        isDestructive: false,
        label: `${fromName} -> ${toName}: RENAME TRIGGER on ${tableName}`,
        tableName,
        fromName,
        toName,
      });

      // Body change after the rename -> replace op.
      if (!bodyEqual(s, t)) {
        ops.push({
          id: `trigger:replace:${tableName}.${toName}:post-rename`,
          category: 'trigger',
          kind: 'replace',
          objectName: `${tableName}.${toName}`,
          phase: 'main',
          isDestructive: true,
          label: `${toName}: REPLACE TRIGGER on ${tableName}`,
          tableName,
          definition: assembleCreate(s),
          dependsOn: [`${tableName}.${toName}`],
        });
      }
    }
  }

  // Remaining add/drop.
  for (const s of addedOnly) {
    if (matchedSrcKeys.has(triggerKey(s))) continue;
    const tableName = tableQualifiedName(s);
    const objectName = `${tableName}.${s.trigger_name}`;
    ops.push({
      id: `trigger:create:${objectName}`,
      category: 'trigger',
      kind: 'create',
      objectName,
      phase: 'main',
      isDestructive: false,
      label: `${objectName}: CREATE TRIGGER`,
      tableName,
      definition: assembleCreate(s),
    });
  }

  for (let i = 0; i < droppedOnly.length; i++) {
    if (usedTgt.has(i)) continue;
    const t = droppedOnly[i];
    const tableName = tableQualifiedName(t);
    const objectName = `${tableName}.${t.trigger_name}`;
    ops.push({
      id: `trigger:drop:${objectName}`,
      category: 'trigger',
      kind: 'drop',
      objectName,
      phase: 'main',
      isDestructive: true,
      label: `${objectName}: DROP TRIGGER`,
      tableName,
    });
  }

  // Present in both: body diff -> replace (destructive swap).
  for (const [key, s] of srcMap) {
    const t = tgtMap.get(key);
    if (!t) continue;
    if (bodyEqual(s, t)) continue;
    const tableName = tableQualifiedName(s);
    const objectName = `${tableName}.${s.trigger_name}`;
    ops.push({
      id: `trigger:replace:${objectName}`,
      category: 'trigger',
      kind: 'replace',
      objectName,
      phase: 'main',
      isDestructive: true,
      label: `${objectName}: REPLACE TRIGGER`,
      tableName,
      definition: assembleCreate(s),
    });
  }

  return { ops, renameCandidates };
}
