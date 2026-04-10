/**
 * Top-level schema differ. Delegates to per-category differs and assembles a
 * single `SchemaDiff` that the UI can render.
 *
 * At this refactor stage only `diffTables` produces output — the other
 * categories will add entries to `ops` / `renameCandidates` in later phases.
 */

import type { DatabaseInfo } from '@/shared/types';
import type { SchemaDiff, ChangeOp } from '../types';
import { diffTables } from './tables';
import { diffEnums } from './enums';
import { diffViews } from './views';
import { diffFunctions, diffProcedures } from './routines';
import { diffSequences } from './sequences';
import { diffTriggers } from './triggers';
import { diffDomains } from './domains';

export function diffSchemas(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): SchemaDiff {
  const tables = diffTables(sourceDb, targetDb);

  const ops: ChangeOp[] = [];
  const renameCandidates: SchemaDiff['renameCandidates'] = [];
  const enumValueRenameCandidates: SchemaDiff['enumValueRenameCandidates'] = [];

  // Enum ops + rename candidates
  const enumDiff = diffEnums(sourceDb, targetDb);
  ops.push(...enumDiff.ops);
  renameCandidates.push(...enumDiff.renameCandidates);
  enumValueRenameCandidates.push(...enumDiff.valueRenameCandidates);

  // View ops + rename candidates
  const viewDiff = diffViews(sourceDb, targetDb);
  ops.push(...viewDiff.ops);
  renameCandidates.push(...viewDiff.renameCandidates);

  // Function ops + rename candidates
  const fnDiff = diffFunctions(sourceDb, targetDb);
  ops.push(...fnDiff.ops);
  renameCandidates.push(...fnDiff.renameCandidates);

  // Procedure ops + rename candidates
  const procDiff = diffProcedures(sourceDb, targetDb);
  ops.push(...procDiff.ops);
  renameCandidates.push(...procDiff.renameCandidates);

  // Sequence ops
  const seqDiff = diffSequences(sourceDb, targetDb);
  ops.push(...seqDiff.ops);
  renameCandidates.push(...seqDiff.renameCandidates);

  // Trigger ops
  const trigDiff = diffTriggers(sourceDb, targetDb);
  ops.push(...trigDiff.ops);
  renameCandidates.push(...trigDiff.renameCandidates);

  // Domain ops
  const domDiff = diffDomains(sourceDb, targetDb);
  ops.push(...domDiff.ops);
  renameCandidates.push(...domDiff.renameCandidates);

  const hasChanges = tables.length > 0 || ops.length > 0;

  return { tables, ops, renameCandidates, enumValueRenameCandidates, hasChanges };
}

export { diffTables, tableQualifiedName } from './tables';
export { diffEnums } from './enums';
export { diffViews } from './views';
export { diffFunctions, diffProcedures } from './routines';
export { diffSequences } from './sequences';
export { diffTriggers } from './triggers';
export { diffDomains } from './domains';
