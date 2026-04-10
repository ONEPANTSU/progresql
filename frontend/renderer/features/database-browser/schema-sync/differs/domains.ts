/**
 * Domain differ. Domains live in `DatabaseInfo.types` alongside enums
 * and composite types; we pick them by `typtype === 'd'`.
 *
 * NOTE: `type_category` is pg_type.typcategory, which for a domain reflects
 * the *base type's* category (e.g. 'N' for integer-backed domains). It is
 * NOT a reliable "is domain?" indicator — 'D' in pg_catalog means
 * DateTime, not Domain. Use `type_type` (pg_type.typtype) instead; the
 * backend populates it for each row.
 *
 * The current schema snapshot does not include domain constraint bodies
 * (`CHECK`, `NOT NULL`, etc.), so we only detect create / drop / rename
 * and base-type changes. Base-type changes are destructive (DROP +
 * CREATE) because `ALTER DOMAIN ... TYPE` requires an explicit USING
 * cast per dependent column.
 */

import type { DatabaseInfo, CustomType } from '@/shared/types';
import type { DomainOp, RenameCandidate } from '../types';
import { normaliseIdent, similarity } from '../util/similarity';

const DOMAIN_RENAME_THRESHOLD = 0.62;

function collectDomains(db: DatabaseInfo): CustomType[] {
  return (db.types || []).filter((t) => t.type_type === 'd');
}

function qualifiedName(t: CustomType): string {
  const schema = t.schema || 'public';
  return `${schema}.${t.name}`;
}

export interface DiffDomainsResult {
  ops: DomainOp[];
  renameCandidates: RenameCandidate[];
}

export function diffDomains(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): DiffDomainsResult {
  const src = collectDomains(sourceDb);
  const tgt = collectDomains(targetDb);

  const srcMap = new Map(src.map((t) => [qualifiedName(t), t]));
  const tgtMap = new Map(tgt.map((t) => [qualifiedName(t), t]));

  const ops: DomainOp[] = [];
  const renameCandidates: RenameCandidate[] = [];

  const addedOnly: CustomType[] = [];
  const droppedOnly: CustomType[] = [];
  for (const [k, t] of srcMap) if (!tgtMap.has(k)) addedOnly.push(t);
  for (const [k, t] of tgtMap) if (!srcMap.has(k)) droppedOnly.push(t);

  // Rename detection within the same schema, base type must match.
  const usedTgt = new Set<number>();
  const matchedSrcKeys = new Set<string>();
  for (const s of addedOnly) {
    let bestIdx = -1;
    let bestScore = 0;
    const srcKey = normaliseIdent(s.name);
    for (let i = 0; i < droppedOnly.length; i++) {
      if (usedTgt.has(i)) continue;
      const t = droppedOnly[i];
      if ((t.schema || 'public') !== (s.schema || 'public')) continue;
      if (t.base_type !== s.base_type) continue;
      const score = similarity(srcKey, normaliseIdent(t.name));
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= DOMAIN_RENAME_THRESHOLD) {
      const t = droppedOnly[bestIdx];
      usedTgt.add(bestIdx);
      matchedSrcKeys.add(qualifiedName(s));

      const fromName = qualifiedName(t);
      const toName = qualifiedName(s);

      renameCandidates.push({ category: 'domain', fromName, toName, confidence: bestScore });

      ops.push({
        id: `domain:rename:${fromName}->${toName}`,
        category: 'domain',
        kind: 'rename',
        objectName: toName,
        phase: 'main',
        isDestructive: false,
        label: `${fromName} -> ${toName}: RENAME DOMAIN`,
        fromName,
        toName,
        baseType: s.base_type || 'text',
      });
    }
  }

  // Remaining add/drop.
  for (const s of addedOnly) {
    const name = qualifiedName(s);
    if (matchedSrcKeys.has(name)) continue;
    ops.push({
      id: `domain:create:${name}`,
      category: 'domain',
      kind: 'create',
      objectName: name,
      phase: 'main',
      isDestructive: false,
      label: `${name}: CREATE DOMAIN`,
      baseType: s.base_type || 'text',
    });
  }

  for (let i = 0; i < droppedOnly.length; i++) {
    if (usedTgt.has(i)) continue;
    const t = droppedOnly[i];
    const name = qualifiedName(t);
    ops.push({
      id: `domain:drop:${name}`,
      category: 'domain',
      kind: 'drop',
      objectName: name,
      phase: 'main',
      isDestructive: true,
      label: `${name}: DROP DOMAIN`,
    });
  }

  // Present in both: base type changed -> single rebuild op (DROP + CREATE).
  // Emitted as one op so the user can't accidentally select CREATE without
  // DROP, which would fail with "type already exists".
  for (const [name, s] of srcMap) {
    const t = tgtMap.get(name);
    if (!t) continue;
    if (s.base_type === t.base_type) continue;
    ops.push({
      id: `domain:rebuild:${name}`,
      category: 'domain',
      kind: 'rebuild',
      objectName: name,
      phase: 'main',
      isDestructive: true,
      label: `${name}: REBUILD DOMAIN (${t.base_type} → ${s.base_type})`,
      baseType: s.base_type || 'text',
      oldBaseType: t.base_type || 'text',
    });
  }

  return { ops, renameCandidates };
}
