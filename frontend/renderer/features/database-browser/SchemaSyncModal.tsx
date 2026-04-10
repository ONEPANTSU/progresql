/**
 * Schema Sync modal — UI shell.
 *
 * All diff/SQL logic lives under `./schema-sync`. This file is purely the
 * React/MUI surface: connection pickers, the compare button, the result
 * accordion list, and the "insert to editor" action.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  Chip,
  Divider,
  IconButton,
  Tooltip,
  CircularProgress,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import {
  CompareArrows as CompareIcon,
  SwapHoriz as SwapIcon,
  Warning as WarningIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  Edit as EditIcon,
  Category as CategoryIcon,
  CallSplit as CallSplitIcon,
  Visibility as VisibilityIcon,
  Functions as FunctionsIcon,
  Numbers as NumbersIcon,
  FlashOn as FlashOnIcon,
  Label as LabelIcon,
  TableChart as TableChartIcon,
} from '@mui/icons-material';
import type { DatabaseServer, DatabaseInfo } from '@/shared/types';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import {
  diffSchemas,
  generateTableSQL,
  renderChangeOp,
  configureEnumGeneratorContext,
  getDependenciesForEnum,
  planMigration,
  renderPlanSQL,
  resolveOps,
  resolveTableRenames,
  type DiffKind,
  type SchemaDiff,
  type ChangeOp,
  type ObjectCategory,
  type EnumOp,
  type ViewOp,
  type RoutineOp,
  type SequenceOp,
  type TriggerOp,
  type DomainOp,
  type UserDecisions,
  type RenameMode,
} from './schema-sync';
import { OpSection, OpRow, RenameResolverButtons } from './schema-sync/components';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SchemaSyncModalProps {
  open: boolean;
  onClose: () => void;
  connections: DatabaseServer[];
  onApplySQL?: (sql: string, targetConnectionId?: string, targetDatabase?: string) => void;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

const kindIcon: Record<DiffKind, React.ReactNode> = {
  add: <AddIcon sx={{ fontSize: 14, color: 'success.main' }} />,
  drop: <RemoveIcon sx={{ fontSize: 14, color: 'error.main' }} />,
  alter: <EditIcon sx={{ fontSize: 14, color: 'warning.main' }} />,
  rename: <SwapIcon sx={{ fontSize: 14, color: 'info.main' }} />,
};

const kindLabel: Record<DiffKind, string> = {
  add: 'CREATE',
  drop: 'DROP',
  alter: 'ALTER',
  rename: 'RENAME',
};

const kindColor: Record<DiffKind, 'success' | 'error' | 'warning' | 'info'> = {
  add: 'success',
  drop: 'error',
  alter: 'warning',
  rename: 'info',
};

// ---------------------------------------------------------------------------
// Enum op presentation
// ---------------------------------------------------------------------------

/** Group enum ops by their `objectName` so they render as one row per enum. */
function groupEnumOps(ops: ChangeOp[]): Array<{ enumName: string; ops: EnumOp[] }> {
  const groups = new Map<string, EnumOp[]>();
  for (const op of ops) {
    if (op.category !== 'enum') continue;
    const bucket = groups.get(op.objectName) ?? [];
    bucket.push(op);
    groups.set(op.objectName, bucket);
  }
  return Array.from(groups.entries())
    .map(([enumName, opList]) => ({ enumName, ops: opList }))
    .sort((a, b) => a.enumName.localeCompare(b.enumName));
}

// ---------------------------------------------------------------------------
// View op presentation
// ---------------------------------------------------------------------------

type ViewKindStyle = {
  chip: string;
  color: 'success' | 'error' | 'warning' | 'info';
  icon: React.ReactNode;
};

const viewKindStyles: Record<ViewOp['kind'], ViewKindStyle> = {
  'create':  { chip: 'CREATE VIEW',  color: 'success', icon: <AddIcon sx={{ fontSize: 14, color: 'success.main' }} /> },
  'drop':    { chip: 'DROP VIEW',    color: 'error',   icon: <RemoveIcon sx={{ fontSize: 14, color: 'error.main' }} /> },
  'replace': { chip: 'REPLACE VIEW', color: 'warning', icon: <EditIcon sx={{ fontSize: 14, color: 'warning.main' }} /> },
  'rename':  { chip: 'RENAME VIEW',  color: 'info',    icon: <SwapIcon sx={{ fontSize: 14, color: 'info.main' }} /> },
};

/** Group view ops by `objectName`. */
function groupViewOps(ops: ChangeOp[]): Array<{ viewName: string; ops: ViewOp[] }> {
  const groups = new Map<string, ViewOp[]>();
  for (const op of ops) {
    if (op.category !== 'view') continue;
    const bucket = groups.get(op.objectName) ?? [];
    bucket.push(op);
    groups.set(op.objectName, bucket);
  }
  return Array.from(groups.entries())
    .map(([viewName, opList]) => ({ viewName, ops: opList }))
    .sort((a, b) => a.viewName.localeCompare(b.viewName));
}

// ---------------------------------------------------------------------------
// Routine (function / procedure) op presentation
// ---------------------------------------------------------------------------

type RoutineKindStyle = {
  chip: string;
  color: 'success' | 'error' | 'warning' | 'info';
  icon: React.ReactNode;
};

const routineKindStyles: Record<RoutineOp['kind'], RoutineKindStyle> = {
  'create':  { chip: 'CREATE',  color: 'success', icon: <AddIcon sx={{ fontSize: 14, color: 'success.main' }} /> },
  'drop':    { chip: 'DROP',    color: 'error',   icon: <RemoveIcon sx={{ fontSize: 14, color: 'error.main' }} /> },
  'replace': { chip: 'REPLACE', color: 'warning', icon: <EditIcon sx={{ fontSize: 14, color: 'warning.main' }} /> },
  'rename':  { chip: 'RENAME',  color: 'info',    icon: <SwapIcon sx={{ fontSize: 14, color: 'info.main' }} /> },
};

/** Group routine ops (functions + procedures) by `objectName`. */
function groupRoutineOps(
  ops: ChangeOp[],
  category: 'function' | 'procedure',
): Array<{ routineName: string; ops: RoutineOp[] }> {
  const groups = new Map<string, RoutineOp[]>();
  for (const op of ops) {
    if (op.category !== category) continue;
    const bucket = groups.get(op.objectName) ?? [];
    bucket.push(op);
    groups.set(op.objectName, bucket);
  }
  return Array.from(groups.entries())
    .map(([routineName, opList]) => ({ routineName, ops: opList }))
    .sort((a, b) => a.routineName.localeCompare(b.routineName));
}

// ---------------------------------------------------------------------------
// Sequence / trigger / domain op presentation (shared compact style)
// ---------------------------------------------------------------------------

type MiscOp = SequenceOp | TriggerOp | DomainOp;

const miscColorByKind: Record<string, 'success' | 'error' | 'warning' | 'info'> = {
  create: 'success',
  drop: 'error',
  alter: 'warning',
  replace: 'warning',
  rename: 'info',
};

const miscKindIcon: Record<string, React.ReactNode> = {
  create: <AddIcon sx={{ fontSize: 14, color: 'success.main' }} />,
  drop: <RemoveIcon sx={{ fontSize: 14, color: 'error.main' }} />,
  alter: <EditIcon sx={{ fontSize: 14, color: 'warning.main' }} />,
  replace: <EditIcon sx={{ fontSize: 14, color: 'warning.main' }} />,
  rename: <SwapIcon sx={{ fontSize: 14, color: 'info.main' }} />,
};

function miscChipLabel(op: MiscOp): string {
  const prefix = op.category.toUpperCase();
  return `${op.kind.toUpperCase()} ${prefix}`;
}

function filterMiscOps(ops: ChangeOp[], category: 'sequence' | 'trigger' | 'domain'): MiscOp[] {
  return ops.filter((o) => o.category === category) as MiscOp[];
}

/** Normalise enum_values that may arrive as a Postgres array literal string. */
function parseEnumValues(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    return raw
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((v) => v.trim().replace(/^"|"$/g, ''))
      .filter((v) => v.length > 0);
  }
  return [];
}

/** Build a lookup of qualified enum name -> ordered source value list. */
function indexSourceEnumValues(db: DatabaseInfo | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!db) return map;
  for (const t of db.types || []) {
    const vals = parseEnumValues(t.enum_values);
    if (vals.length > 0) {
      const qn = `${t.schema || 'public'}.${t.name}`;
      map.set(qn, vals);
    }
  }
  return map;
}

export default function SchemaSyncModal({ open, onClose, connections, onApplySQL }: SchemaSyncModalProps) {
  const { t } = useTranslation();
  const [sourceId, setSourceId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [sourceDatabase, setSourceDatabase] = useState<string>('');
  const [targetDatabase, setTargetDatabase] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Schema snapshots kept so the enum generator context (dependency lookup)
  // can be refreshed without a second network round-trip and so rejected
  // rename-value suggestions can derive their post-drop value list.
  const [sourceSnap, setSourceSnap] = useState<DatabaseInfo | null>(null);
  const [targetSnap, setTargetSnap] = useState<DatabaseInfo | null>(null);

  // User decisions for enum ops — applied via `resolveOps` before the
  // planner turns ops into SQL.
  const [selectedOpIds, setSelectedOpIds] = useState<Set<string>>(new Set());
  const [rejectedValueRenames, setRejectedValueRenames] = useState<Set<string>>(new Set());
  const [dropValueChoices, setDropValueChoices] = useState<
    Map<string, { replacement: string | null; skip: boolean }>
  >(new Map());

  // Override rename-value target: opId → new toValue.
  const [renameValueTargets, setRenameValueTargets] = useState<Map<string, string>>(new Map());

  // Rename mode choice per rename op id (views/routines/domains).
  const [opRenameModes, setOpRenameModes] = useState<Map<string, RenameMode>>(new Map());
  // Rename mode choice per table name (the new / source-side name).
  const [tableRenameModes, setTableRenameModes] = useState<Map<string, RenameMode>>(new Map());

  // Reset state when modal opens
  React.useEffect(() => {
    if (open) {
      setDiff(null);
      setError(null);
      setSelected(new Set());
      setSourceSnap(null);
      setTargetSnap(null);
      setSelectedOpIds(new Set());
      setRejectedValueRenames(new Set());
      setRenameValueTargets(new Map());
      setDropValueChoices(new Map());
      setOpRenameModes(new Map());
      setTableRenameModes(new Map());
    }
  }, [open]);

  const activeConnections = useMemo(
    () => connections.filter((c) => c.isActive),
    [connections]
  );

  const handleCompare = useCallback(async () => {
    if (!sourceId || !targetId) return;
    if (sourceId === targetId && sourceDatabase === targetDatabase) {
      setError(t('schemaSync.sameConnection'));
      return;
    }

    setLoading(true);
    setError(null);
    setDiff(null);
    setSelected(new Set());

    try {
      // Sequential calls to avoid race condition when both use the same
      // connection — pg.Client is not safe for concurrent queries.
      const sourceResult = await window.electronAPI.getDatabaseStructure(sourceId, sourceDatabase || undefined);
      const targetResult = await window.electronAPI.getDatabaseStructure(targetId, targetDatabase || undefined);

      if (!sourceResult.success || !sourceResult.databases?.length) {
        throw new Error('Failed to fetch Source schema. Ensure the connection is active and has a database.');
      }
      if (!targetResult.success || !targetResult.databases?.length) {
        throw new Error('Failed to fetch Target schema. Ensure the connection is active and has a database.');
      }

      const sourceDb = sourceResult.databases[0];
      const targetDb = targetResult.databases[0];

      // Arm the enum generator with column-dependency info from the TARGET
      // snapshot — the rebuild dance must ALTER columns that currently exist
      // in the live DB, not columns being ADDed by the same migration.
      configureEnumGeneratorContext(targetDb);
      setSourceSnap(sourceDb);
      setTargetSnap(targetDb);

      const result = diffSchemas(sourceDb, targetDb);
      setDiff(result);

      // Pre-select non-destructive, non-ambiguous tables + ops.
      // Rename candidates require user decision → leave unchecked.
      const renameKinds = new Set(['rename', 'rename-type', 'rename-value']);
      const defaultSelectedTables = new Set<string>();
      for (const td of result.tables) {
        if (!td.isDestructive && td.kind !== 'rename') defaultSelectedTables.add(td.tableName);
      }
      setSelected(defaultSelectedTables);

      // Collect enum names that have any rename op → leave entire group unchecked.
      const enumsWithRenames = new Set<string>();
      for (const op of result.ops) {
        if (op.category === 'enum' && renameKinds.has(op.kind)) {
          enumsWithRenames.add(op.objectName);
        }
      }

      const defaultSelectedOps = new Set<string>();
      for (const op of result.ops) {
        if (op.isDestructive) continue;
        if (renameKinds.has(op.kind)) continue;
        // Skip all ops in an enum group that contains a rename.
        if (op.category === 'enum' && enumsWithRenames.has(op.objectName)) continue;
        defaultSelectedOps.add(op.id);
      }
      setSelectedOpIds(defaultSelectedOps);

      // Reset user decisions from a previous run.
      setRejectedValueRenames(new Set());
      setRenameValueTargets(new Map());
      setDropValueChoices(new Map());
      setOpRenameModes(new Map());
      setTableRenameModes(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('schemaSync.unknownError'));
    } finally {
      setLoading(false);
    }
  }, [sourceId, targetId, sourceDatabase, targetDatabase, t]);

  const toggleTable = useCallback((tableName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) {
        next.delete(tableName);
      } else {
        next.add(tableName);
      }
      return next;
    });
  }, []);

  const visibleTables = useMemo(() => {
    if (!diff) return [];
    return diff.tables;
  }, [diff]);

  const toggleAll = useCallback(() => {
    if (!diff) return;
    const allSelected = visibleTables.every((t) => selected.has(t.tableName));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleTables.map((t) => t.tableName)));
    }
  }, [diff, selected, visibleTables]);

  // Source-side enum value lookup — fed into resolveOps so a rejected
  // rename-value suggestion can derive the post-drop value list.
  const sourceEnumValues = useMemo(() => indexSourceEnumValues(sourceSnap), [sourceSnap]);
  const targetEnumValues = useMemo(() => indexSourceEnumValues(targetSnap), [targetSnap]);

  // Raw diff → resolved ops (user decisions applied) → migration plan → SQL.
  const finalSQL = useMemo(() => {
    if (!diff) return '';
    // Nothing selected → no SQL to generate.
    if (selected.size === 0 && selectedOpIds.size === 0) return '';
    const decisions: UserDecisions = {
      rejectedValueRenames,
      dropValueChoices,
      sourceEnumValues,
      targetEnumValues,
      renameResolutions: opRenameModes,
      renameValueTargets,
    };
    const resolvedOps = resolveOps(diff.ops, decisions);
    // Apply per-table rename resolutions (split / keep-both) to the
    // legacy TableDiff list before feeding it into the planner.
    const resolvedTables = resolveTableRenames(diff.tables, tableRenameModes);

    // Extend selection sets to include synthetic split ops / split tables
    // spawned from rename resolution. Both use the `:split-*` id suffix.
    const effectiveSelectedOps = new Set(selectedOpIds);
    for (const op of resolvedOps) {
      const parentId = op.id.replace(/:split-(add|drop|create)$/, '');
      if (parentId !== op.id && selectedOpIds.has(parentId)) {
        effectiveSelectedOps.add(op.id);
      }
    }

    // For tables, a rename that was downgraded to split/keep-both produces
    // new TableDiff entries keyed by their new names. Propagate selection
    // only when the original rename table was selected by the user.
    const effectiveSelectedTables = new Set(selected);
    for (const td of resolvedTables) {
      // Synthetic split entries share the same tableName or renamedFrom
      // as the original rename table. Only propagate if the user had
      // the original selected.
      if (td.renamedFrom && selected.has(td.renamedFrom)) {
        effectiveSelectedTables.add(td.tableName);
      }
    }

    const resolvedDiff: SchemaDiff = { ...diff, ops: resolvedOps, tables: resolvedTables };
    const plan = planMigration(resolvedDiff, {
      selectedTables: effectiveSelectedTables,
      selectedOpIds: effectiveSelectedOps,
    });
    return renderPlanSQL(plan);
  }, [
    diff,
    selected,
    selectedOpIds,
    rejectedValueRenames,
    dropValueChoices,
    sourceEnumValues,
    targetEnumValues,
    opRenameModes,
    renameValueTargets,
    tableRenameModes,
  ]);

  const handleInsertToEditor = useCallback(() => {
    if (onApplySQL && finalSQL) {
      // Save values before closing modal (onClose may unmount and clear state).
      const connId = targetId || undefined;
      const db = targetDatabase || undefined;
      const sql = finalSQL;
      onClose();
      // Apply after modal is closed so editor state is ready.
      setTimeout(() => onApplySQL(sql, connId, db), 100);
    }
  }, [onApplySQL, finalSQL, targetId, targetDatabase, onClose]);

  const getConnectionLabel = (conn: DatabaseServer) => {
    return `${conn.connectionName || conn.host} (${conn.host}:${conn.port})`;
  };

  const diffSummary = useMemo(() => {
    if (!diff) return { create: 0, alter: 0, drop: 0, rename: 0, destructive: 0 };

    // Map every op kind to a unified bucket.
    const kindBucket = (k: string): 'create' | 'alter' | 'drop' | 'rename' => {
      if (k === 'add' || k === 'create' || k === 'add-value') return 'create';
      if (k === 'drop' || k === 'drop-value') return 'drop';
      if (k === 'rename' || k === 'rename-type' || k === 'rename-value') return 'rename';
      return 'alter'; // alter, replace, etc.
    };

    const counts = { create: 0, alter: 0, drop: 0, rename: 0, destructive: 0 };

    // Tables
    for (const t of diff.tables) {
      counts[kindBucket(t.kind)]++;
      if (t.isDestructive) counts.destructive++;
    }
    // All other ops
    for (const op of diff.ops) {
      counts[kindBucket(op.kind)]++;
      if (op.isDestructive) counts.destructive++;
    }

    return counts;
  }, [diff]);

  // Group ops by enum name for rendering a per-type accordion.
  const enumGroups = useMemo(
    () => groupEnumOps(diff?.ops ?? []),
    [diff],
  );

  // Group ops by view name for rendering a per-view accordion.
  const viewGroups = useMemo(
    () => groupViewOps(diff?.ops ?? []),
    [diff],
  );

  // Group ops by function / procedure qualified name.
  const functionGroups = useMemo(
    () => groupRoutineOps(diff?.ops ?? [], 'function'),
    [diff],
  );
  const procedureGroups = useMemo(
    () => groupRoutineOps(diff?.ops ?? [], 'procedure'),
    [diff],
  );

  const sequenceOps = useMemo(() => filterMiscOps(diff?.ops ?? [], 'sequence'), [diff]);
  const triggerOps = useMemo(() => filterMiscOps(diff?.ops ?? [], 'trigger'), [diff]);
  const domainOps = useMemo(() => filterMiscOps(diff?.ops ?? [], 'domain'), [diff]);

  const toggleOp = useCallback((opId: string) => {
    setSelectedOpIds((prev) => {
      const next = new Set(prev);
      if (next.has(opId)) next.delete(opId);
      else next.add(opId);
      return next;
    });
  }, []);

  const toggleRenameValueRejected = useCallback((opId: string) => {
    setRejectedValueRenames((prev) => {
      const next = new Set(prev);
      if (next.has(opId)) next.delete(opId);
      else next.add(opId);
      return next;
    });
  }, []);

  const setDropValueChoice = useCallback(
    (opId: string, patch: Partial<{ replacement: string | null; skip: boolean }>) => {
      setDropValueChoices((prev) => {
        const next = new Map(prev);
        const current = next.get(opId) ?? { replacement: null, skip: false };
        next.set(opId, { ...current, ...patch });
        return next;
      });
    },
    [],
  );

  /** Set rename mode for an op-level rename (view / routine / domain). */
  const setOpRenameMode = useCallback((opId: string, mode: RenameMode) => {
    setOpRenameModes((prev) => {
      const next = new Map(prev);
      if (mode === 'accept') {
        next.delete(opId);
      } else {
        next.set(opId, mode);
      }
      return next;
    });
  }, []);

  /** Set rename mode for a table rename (keyed by the new / source-side name). */
  const setTableRenameMode = useCallback((tableName: string, mode: RenameMode) => {
    setTableRenameModes((prev) => {
      const next = new Map(prev);
      if (mode === 'accept') {
        next.delete(tableName);
      } else {
        next.set(tableName, mode);
      }
      return next;
    });
  }, []);

  /**
   * Select-all / deselect-all for every op in a given category. If not ALL
   * ops are selected → select all; if all are selected → deselect all.
   * Same logic as table toggleAll for consistent UX.
   */
  const toggleAllInCategory = useCallback(
    (category: ObjectCategory | 'routine') => {
      if (!diff) return;
      const categoryOps = diff.ops.filter((o) =>
        category === 'routine'
          ? o.category === 'function' || o.category === 'procedure'
          : o.category === category,
      );
      if (categoryOps.length === 0) return;
      setSelectedOpIds((prev) => {
        const next = new Set(prev);
        const allSelected = categoryOps.every((o) => next.has(o.id));
        if (allSelected) {
          for (const o of categoryOps) next.delete(o.id);
        } else {
          for (const o of categoryOps) next.add(o.id);
        }
        return next;
      });
    },
    [diff],
  );

  /**
   * Compute the SQL preview for a single op, applying the user's current
   * rename-mode decision. Used by the view / routine / domain sections so
   * the in-row preview updates live when the user toggles accept / split /
   * keep-both — the old `renderChangeOp(op)` call always showed the
   * original rename statement regardless of mode.
   */
  const previewOpSQL = useCallback(
    (op: ChangeOp): string => {
      // Only rename ops care about the mode; everything else is a straight
      // render.
      const isRename =
        (op.category === 'view' ||
          op.category === 'function' ||
          op.category === 'procedure' ||
          op.category === 'domain') &&
        op.kind === 'rename';
      if (!isRename) return renderChangeOp(op);

      const mode = opRenameModes.get(op.id) ?? 'accept';
      if (mode === 'accept') return renderChangeOp(op);

      const decisions: UserDecisions = {
        rejectedValueRenames: new Set(),
        dropValueChoices: new Map(),
        sourceEnumValues: new Map(),
        renameResolutions: new Map([[op.id, mode]]),
      };
      const resolved = resolveOps([op], decisions);
      return resolved.map((o) => renderChangeOp(o)).join('\n\n');
    },
    [opRenameModes],
  );

  /** How many ops in a given category are currently selected. */
  const selectedCountInCategory = useCallback(
    (category: ObjectCategory | 'routine'): number => {
      if (!diff) return 0;
      return diff.ops.reduce((acc, o) => {
        const matches =
          category === 'routine'
            ? o.category === 'function' || o.category === 'procedure'
            : o.category === category;
        return matches && selectedOpIds.has(o.id) ? acc + 1 : acc;
      }, 0);
    },
    [diff, selectedOpIds],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          maxHeight: '85vh',
          bgcolor: 'background.paper',
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1, px: 2 }}>
        <CompareIcon sx={{ color: 'primary.main', fontSize: 20 }} />
        <Typography variant="subtitle1" component="span" fontWeight={600}>
          {t('schemaSync.title')}
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 1.5 }}>
        {/* Connection selectors — vertical layout */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1.5 }}>
          <FormControl fullWidth size="small">
            <InputLabel>{t('schemaSync.source')}</InputLabel>
            <Select
              value={sourceId}
              label={t('schemaSync.source')}
              onChange={(e) => {
                const id = e.target.value;
                setSourceId(id);
                const conn = activeConnections.find(c => c.id === id);
                setSourceDatabase(conn?.activeDatabase || conn?.database || '');
                setDiff(null);
              }}
            >
              {activeConnections.map((c) => (
                <MenuItem key={c.id} value={c.id} disabled={c.id === targetId && sourceDatabase === targetDatabase}>
                  {getConnectionLabel(c)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Source database selector */}
          {sourceId && (() => {
            const conn = activeConnections.find(c => c.id === sourceId);
            const dbs = conn?.availableDatabases;
            return dbs && dbs.length > 1 ? (
              <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                <InputLabel>DB</InputLabel>
                <Select
                  value={sourceDatabase}
                  label="DB"
                  onChange={(e) => { setSourceDatabase(e.target.value); setDiff(null); }}
                >
                  {dbs.map((db) => (
                    <MenuItem key={db.name} value={db.name}>{db.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : null;
          })()}

          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <Tooltip title={t('schemaSync.swap')}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => {
                    const tmpId = sourceId;
                    const tmpDb = sourceDatabase;
                    setSourceId(targetId);
                    setSourceDatabase(targetDatabase);
                    setTargetId(tmpId);
                    setTargetDatabase(tmpDb);
                    setDiff(null);
                  }}
                  disabled={!sourceId && !targetId}
                >
                  <SwapIcon sx={{ color: 'text.secondary', transform: 'rotate(90deg)' }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>

          <FormControl fullWidth size="small">
            <InputLabel>{t('schemaSync.target')}</InputLabel>
            <Select
              value={targetId}
              label={t('schemaSync.target')}
              onChange={(e) => {
                const id = e.target.value;
                setTargetId(id);
                const conn = activeConnections.find(c => c.id === id);
                setTargetDatabase(conn?.activeDatabase || conn?.database || '');
                setDiff(null);
              }}
            >
              {activeConnections.map((c) => (
                <MenuItem key={c.id} value={c.id} disabled={c.id === sourceId && sourceDatabase === targetDatabase}>
                  {getConnectionLabel(c)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Target database selector */}
          {targetId && (() => {
            const conn = activeConnections.find(c => c.id === targetId);
            const dbs = conn?.availableDatabases;
            return dbs && dbs.length > 1 ? (
              <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                <InputLabel>DB</InputLabel>
                <Select
                  value={targetDatabase}
                  label="DB"
                  onChange={(e) => { setTargetDatabase(e.target.value); setDiff(null); }}
                >
                  {dbs.map((db) => (
                    <MenuItem key={db.name} value={db.name}>{db.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : null;
          })()}
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1.5 }}>
          <Button
            variant="contained"
            onClick={handleCompare}
            disabled={!sourceId || !targetId || loading}
            startIcon={loading ? <CircularProgress size={16} /> : undefined}
            size="small"
            sx={{
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6, #7c3aed)',
              '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6d28d9)' },
              '&.Mui-disabled': { background: 'rgba(99, 102, 241, 0.3)', color: 'rgba(255,255,255,0.5)' },
            }}
          >
            {loading ? t('schemaSync.comparing') : t('schemaSync.compare')}
          </Button>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {activeConnections.length < 2 && !activeConnections.some(c => c.availableDatabases && c.availableDatabases.length >= 2) && (
          <Alert severity="info" sx={{ mb: 1 }}>
            {t('schemaSync.minConnections')}
          </Alert>
        )}

        {/* Diff results */}
        {diff && !diff.hasChanges && (
          <Alert severity="success">
            {t('schemaSync.identical')}
          </Alert>
        )}

        {diff && diff.hasChanges && (
          <>
            {/* Summary bar */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
              {diffSummary.create > 0 && (
                <Chip icon={<AddIcon />} label={`${diffSummary.create} create`} size="small" color="success" variant="outlined" />
              )}
              {diffSummary.alter > 0 && (
                <Chip icon={<EditIcon />} label={`${diffSummary.alter} alter`} size="small" color="warning" variant="outlined" />
              )}
              {diffSummary.drop > 0 && (
                <Chip icon={<RemoveIcon />} label={`${diffSummary.drop} drop`} size="small" color="error" variant="outlined" />
              )}
              {diffSummary.rename > 0 && (
                <Chip icon={<SwapIcon />} label={`${diffSummary.rename} rename`} size="small" color="info" variant="outlined" />
              )}
              {diffSummary.destructive > 0 && (
                <Tooltip title="Destructive ops detected — review carefully before running">
                  <Chip
                    icon={<WarningIcon />}
                    label={`${diffSummary.destructive} destructive`}
                    size="small"
                    color="warning"
                  />
                </Tooltip>
              )}
            </Box>

            {/* Enum ops section ------------------------------------------------ */}
            {enumGroups.length > 0 && (() => {
              const allEnumOps = enumGroups.flatMap((g) => g.ops);
              const enumHasDestructive = allEnumOps.some((o) => o.isDestructive);
              return (
                <OpSection
                  title={t('schemaSync.enums')}
                  icon={<CategoryIcon sx={{ fontSize: 14 }} />}
                  count={enumGroups.length}
                  selectedCount={enumGroups.filter((g) => g.ops.every((op) => selectedOpIds.has(op.id))).length}
                  onToggleAll={() => toggleAllInCategory('enum')}
                  hasDestructive={enumHasDestructive}
                >
                  {enumGroups.map((group) => {
                    // Determine overall kind for the enum group.
                    const typeOp = group.ops.find(
                      (op) => op.kind === 'create' || op.kind === 'drop' || op.kind === 'rename-type',
                    );
                    const valueOps = group.ops.filter(
                      (op) => op.kind === 'add-value' || op.kind === 'drop-value' || op.kind === 'rename-value',
                    );

                    let overallKind: 'create' | 'drop' | 'rename' | 'alter';
                    if (typeOp?.kind === 'create') overallKind = 'create';
                    else if (typeOp?.kind === 'drop') overallKind = 'drop';
                    else if (typeOp?.kind === 'rename-type') overallKind = 'rename';
                    else overallKind = 'alter';

                    const chipMap: Record<string, { label: string; color: 'success' | 'error' | 'info' | 'warning'; icon: React.ReactNode }> = {
                      create: { label: t('schemaSync.enumChip.create'), color: 'success', icon: <AddIcon sx={{ fontSize: 14, color: 'success.main' }} /> },
                      drop:   { label: t('schemaSync.enumChip.drop'),   color: 'error',   icon: <RemoveIcon sx={{ fontSize: 14, color: 'error.main' }} /> },
                      rename: { label: t('schemaSync.enumChip.rename'), color: 'info',     icon: <SwapIcon sx={{ fontSize: 14, color: 'info.main' }} /> },
                      alter:  { label: t('schemaSync.enumChip.alter'),  color: 'warning',  icon: <EditIcon sx={{ fontSize: 14, color: 'warning.main' }} /> },
                    };
                    const chip = chipMap[overallKind];

                    const groupSelected = group.ops.every((op) => selectedOpIds.has(op.id));
                    const isDestructive = group.ops.some((op) => op.isDestructive);

                    // Display name: rename shows "old → new", others show enum name.
                    const name =
                      overallKind === 'rename' && typeOp?.kind === 'rename-type'
                        ? `${(typeOp as any).fromName} → ${(typeOp as any).toName}`
                        : group.enumName;

                    // Toggle all ops in the group at once.
                    const toggleGroup = () => {
                      setSelectedOpIds((prev) => {
                        const next = new Set(prev);
                        if (groupSelected) {
                          group.ops.forEach((op) => next.delete(op.id));
                        } else {
                          group.ops.forEach((op) => next.add(op.id));
                        }
                        return next;
                      });
                    };

                    // Rename-type resolver (shown on expand).
                    let renameResolver: React.ReactNode = null;
                    if (overallKind === 'rename' && typeOp?.kind === 'rename-type') {
                      const renameMode = opRenameModes.get(typeOp.id) ?? 'accept';
                      renameResolver = (
                        <RenameResolverButtons
                          value={renameMode}
                          onChange={(mode) => setOpRenameMode(typeOp.id, mode)}
                        />
                      );
                    }

                    // Collapsed extras: rename resolver + value-level changes (shown on expand).
                    const collapsedParts: React.ReactNode[] = [];
                    if (renameResolver) collapsedParts.push(<Box key="rr">{renameResolver}</Box>);

                    if (valueOps.length > 0) {
                      collapsedParts.push(
                        <Box
                          key="value-ops"
                          data-op-extras
                          sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: collapsedParts.length > 0 ? 0.5 : 0 }}
                        >
                          <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            {t('schemaSync.enumValueChanges')}
                          </Typography>
                          {valueOps.map((op) => {
                            if (op.kind === 'add-value') {
                              return (
                                <Box key={op.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, pl: 0.5 }}>
                                  <AddIcon sx={{ fontSize: 12, color: 'success.main' }} />
                                  <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>
                                    {op.value}
                                  </Typography>
                                </Box>
                              );
                            }
                            if (op.kind === 'drop-value') {
                              const choice = dropValueChoices.get(op.id) ?? { replacement: null, skip: false };
                              const sVals = sourceEnumValues.get(op.objectName) ?? [];
                              const pdv = Array.isArray(op.postDropValues) ? op.postDropValues : sVals;
                              const remaining = pdv.filter((v: string) => v !== op.value);
                              return (
                                <Box key={op.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, pl: 0.5, flexWrap: 'wrap' }}>
                                  <RemoveIcon sx={{ fontSize: 12, color: 'error.main' }} />
                                  <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'error.main', fontWeight: 600 }}>
                                    {op.value}
                                  </Typography>
                                  {remaining.length > 0 && (
                                    <>
                                      <Typography variant="caption" sx={{ fontSize: '0.68rem', color: 'text.secondary', mx: 0.25 }}>→</Typography>
                                      <Select
                                        size="small"
                                        value={choice.replacement ?? '__null__'}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          setDropValueChoice(op.id, { replacement: v === '__null__' ? null : String(v) });
                                        }}
                                        sx={{ fontSize: '0.68rem', height: 22, minWidth: 100, '& .MuiSelect-select': { py: 0.25, px: 0.75 } }}
                                      >
                                        <MenuItem value="__null__" sx={{ fontSize: '0.68rem' }}><em>NULL</em></MenuItem>
                                        {remaining.map((v: string) => (
                                          <MenuItem key={v} value={v} sx={{ fontSize: '0.68rem' }}>{v}</MenuItem>
                                        ))}
                                      </Select>
                                    </>
                                  )}
                                </Box>
                              );
                            }
                            if (op.kind === 'rename-value') {
                              const isRejected = rejectedValueRenames.has(op.id);
                              // Effective rename target (user may have overridden).
                              const effectiveToValue = renameValueTargets.get(op.id) ?? op.toValue;
                              // All "added" values in this group that could serve as rename targets.
                              const addedInGroup = valueOps
                                .filter((o) => o.kind === 'add-value')
                                .map((o) => o.value);
                              // Rename target candidates: the differ's pick + all add-values.
                              const renameTargetCandidates = Array.from(new Set([op.toValue, ...addedInGroup]));
                              const showTargetSelector = renameTargetCandidates.length > 1 && !isRejected;

                              const toggleBtns = (
                                <ToggleButtonGroup
                                  size="small"
                                  exclusive
                                  value={isRejected ? 'split' : 'rename'}
                                  onChange={(_, v) => { if (v) toggleRenameValueRejected(op.id); }}
                                  sx={{
                                    ml: 'auto',
                                    '& .MuiToggleButton-root': {
                                      px: 0.75, py: 0, minHeight: 20,
                                      textTransform: 'none', fontSize: '0.6rem', fontWeight: 600, gap: 0.25,
                                    },
                                  }}
                                >
                                  <Tooltip title={t('schemaSync.renameValueTooltip')}>
                                    <ToggleButton value="rename" color="info">
                                      <SwapIcon sx={{ fontSize: 12 }} /> Rename
                                    </ToggleButton>
                                  </Tooltip>
                                  <Tooltip title={t('schemaSync.splitValueTooltip')}>
                                    <ToggleButton value="split" color="warning">
                                      <CallSplitIcon sx={{ fontSize: 12 }} /> Split
                                    </ToggleButton>
                                  </Tooltip>
                                </ToggleButtonGroup>
                              );

                              if (isRejected) {
                                // Split mode: show ADD + DROP lines, toggle stays on right of DROP.
                                const sVals = sourceEnumValues.get(op.objectName) ?? [];
                                const splitDropId = `${op.id}:split-drop`;
                                const choice = dropValueChoices.get(splitDropId) ?? { replacement: null, skip: false };
                                const remaining = sVals.filter((v: string) => v !== op.fromValue);
                                return (
                                  <Box key={op.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, pl: 0.5 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                      <AddIcon sx={{ fontSize: 12, color: 'success.main' }} />
                                      <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>{op.toValue}</Typography>
                                    </Box>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                                      <RemoveIcon sx={{ fontSize: 12, color: 'error.main' }} />
                                      <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'error.main', fontWeight: 600 }}>{op.fromValue}</Typography>
                                      {remaining.length > 0 && (
                                        <>
                                          <Typography variant="caption" sx={{ fontSize: '0.68rem', color: 'text.secondary', mx: 0.25 }}>→</Typography>
                                          <Select
                                            size="small"
                                            value={choice.replacement ?? '__null__'}
                                            onChange={(e) => {
                                              const v = e.target.value;
                                              setDropValueChoice(splitDropId, { replacement: v === '__null__' ? null : String(v) });
                                            }}
                                            sx={{ fontSize: '0.68rem', height: 22, minWidth: 100, '& .MuiSelect-select': { py: 0.25, px: 0.75 } }}
                                          >
                                            <MenuItem value="__null__" sx={{ fontSize: '0.68rem' }}><em>NULL</em></MenuItem>
                                            {remaining.map((v: string) => (
                                              <MenuItem key={v} value={v} sx={{ fontSize: '0.68rem' }}>{v}</MenuItem>
                                            ))}
                                          </Select>
                                        </>
                                      )}
                                      {toggleBtns}
                                    </Box>
                                  </Box>
                                );
                              }
                              // Rename mode: show fromValue → target selector (or plain text).
                              return (
                                <Box key={op.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, pl: 0.5 }}>
                                  <SwapIcon sx={{ fontSize: 12, color: 'info.main' }} />
                                  <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>
                                    {op.fromValue} →
                                  </Typography>
                                  {showTargetSelector ? (
                                    <Select
                                      size="small"
                                      value={effectiveToValue}
                                      onChange={(e) => {
                                        setRenameValueTargets((prev) => {
                                          const next = new Map(prev);
                                          next.set(op.id, String(e.target.value));
                                          return next;
                                        });
                                      }}
                                      sx={{ fontSize: '0.68rem', height: 22, minWidth: 100, '& .MuiSelect-select': { py: 0.25, px: 0.75 } }}
                                    >
                                      {renameTargetCandidates.map((v) => (
                                        <MenuItem key={v} value={v} sx={{ fontSize: '0.68rem' }}>{v}</MenuItem>
                                      ))}
                                    </Select>
                                  ) : (
                                    <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>
                                      {effectiveToValue}
                                    </Typography>
                                  )}
                                  {toggleBtns}
                                </Box>
                              );
                            }
                            return null;
                          })}
                        </Box>,
                      );
                    }

                    const collapsedExtras = collapsedParts.length > 0 ? <Box>{collapsedParts}</Box> : null;

                    // Combined SQL preview for all ops in the group,
                    // respecting user decisions (rename mode, drop-value replacements,
                    // rejected value renames).
                    const previewSQL = (() => {
                      const decisions: UserDecisions = {
                        rejectedValueRenames,
                        dropValueChoices,
                        sourceEnumValues,
                        targetEnumValues,
                        renameResolutions: opRenameModes,
                        renameValueTargets,
                      };
                      const resolved = resolveOps(group.ops, decisions);
                      return resolved.map((o) => renderChangeOp(o)).filter(Boolean).join('\n\n');
                    })();

                    return (
                      <OpRow
                        key={group.enumName}
                        id={group.enumName}
                        selected={groupSelected}
                        onToggle={toggleGroup}
                        kindIcon={chip.icon}
                        chipLabel={chip.label}
                        chipColor={chip.color}
                        name={name}
                        isDestructive={isDestructive}
                        collapsedExtras={collapsedExtras}
                        sql={previewSQL}
                        sqlMaxHeight={200}
                      />
                    );
                  })}
                </OpSection>
              );
            })()}

            {/* View ops section ------------------------------------------------ */}
            {viewGroups.length > 0 && (() => {
              const allViewOps = viewGroups.flatMap((g) => g.ops);
              const viewHasDestructive = allViewOps.some((o) => o.isDestructive);
              return (
                <OpSection
                  title={t('schemaSync.views')}
                  icon={<VisibilityIcon sx={{ fontSize: 14 }} />}
                  count={allViewOps.length}
                  selectedCount={selectedCountInCategory('view')}
                  onToggleAll={() => toggleAllInCategory('view')}
                  hasDestructive={viewHasDestructive}
                >
                  {allViewOps.map((op) => {
                    const style = viewKindStyles[op.kind];
                    const isSelected = selectedOpIds.has(op.id);
                    const renameMode = opRenameModes.get(op.id) ?? 'accept';
                    const renameExtras =
                      op.kind === 'rename' ? (
                        <RenameResolverButtons
                          value={renameMode}
                          onChange={(mode) => setOpRenameMode(op.id, mode)}
                        />
                      ) : null;
                    return (
                      <OpRow
                        key={op.id}
                        id={op.id}
                        selected={isSelected}
                        onToggle={() => toggleOp(op.id)}
                        kindIcon={style.icon}
                        chipLabel={style.chip}
                        chipColor={style.color}
                        name={op.objectName}
                        isDestructive={op.isDestructive}
                        collapsedExtras={renameExtras}
                        sql={previewOpSQL(op)}
                        sqlMaxHeight={200}
                      />
                    );
                  })}
                </OpSection>
              );
            })()}

            {/* Function / procedure ops section -------------------------------- */}
            {(functionGroups.length > 0 || procedureGroups.length > 0) && (() => {
              const allRoutineOps = [...functionGroups, ...procedureGroups].flatMap((g) => g.ops);
              const routineHasDestructive = allRoutineOps.some((o) => o.isDestructive);
              return (
                <OpSection
                  title={t('schemaSync.routines')}
                  icon={<FunctionsIcon sx={{ fontSize: 14 }} />}
                  count={allRoutineOps.length}
                  selectedCount={selectedCountInCategory('routine')}
                  onToggleAll={() => toggleAllInCategory('routine')}
                  hasDestructive={routineHasDestructive}
                >
                  {allRoutineOps.map((op) => {
                    const style = routineKindStyles[op.kind];
                    const isSelected = selectedOpIds.has(op.id);
                    const renameMode = opRenameModes.get(op.id) ?? 'accept';
                    const renameExtras =
                      op.kind === 'rename' ? (
                        <RenameResolverButtons
                          value={renameMode}
                          onChange={(mode) => setOpRenameMode(op.id, mode)}
                        />
                      ) : null;
                    return (
                      <OpRow
                        key={op.id}
                        id={op.id}
                        selected={isSelected}
                        onToggle={() => toggleOp(op.id)}
                        kindIcon={style.icon}
                        chipLabel={`${style.chip} ${op.category.toUpperCase()}`}
                        chipColor={style.color}
                        name={op.objectName}
                        isDestructive={op.isDestructive}
                        collapsedExtras={renameExtras}
                        sql={previewOpSQL(op)}
                        sqlMaxHeight={240}
                      />
                    );
                  })}
                </OpSection>
              );
            })()}

            {/* Sequences section ----------------------------------------------- */}
            {sequenceOps.length > 0 && (
              <OpSection
                title={t('schemaSync.sequences')}
                icon={<NumbersIcon sx={{ fontSize: 14 }} />}
                count={sequenceOps.length}
                selectedCount={selectedCountInCategory('sequence')}
                onToggleAll={() => toggleAllInCategory('sequence')}
                hasDestructive={sequenceOps.some((o) => o.isDestructive)}
              >
                {sequenceOps.map((op) => {
                  const isSelected = selectedOpIds.has(op.id);
                  return (
                    <OpRow
                      key={op.id}
                      id={op.id}
                      selected={isSelected}
                      onToggle={() => toggleOp(op.id)}
                      kindIcon={miscKindIcon[op.kind]}
                      chipLabel={miscChipLabel(op)}
                      chipColor={miscColorByKind[op.kind] || 'info'}
                      name={op.objectName}
                      isDestructive={op.isDestructive}
                      sql={previewOpSQL(op)}
                      sqlMaxHeight={160}
                    />
                  );
                })}
              </OpSection>
            )}

            {/* Triggers section ------------------------------------------------ */}
            {triggerOps.length > 0 && (
              <OpSection
                title={t('schemaSync.triggers')}
                icon={<FlashOnIcon sx={{ fontSize: 14 }} />}
                count={triggerOps.length}
                selectedCount={selectedCountInCategory('trigger')}
                onToggleAll={() => toggleAllInCategory('trigger')}
                hasDestructive={triggerOps.some((o) => o.isDestructive)}
              >
                {triggerOps.map((op) => {
                  const isSelected = selectedOpIds.has(op.id);
                  return (
                    <OpRow
                      key={op.id}
                      id={op.id}
                      selected={isSelected}
                      onToggle={() => toggleOp(op.id)}
                      kindIcon={miscKindIcon[op.kind]}
                      chipLabel={miscChipLabel(op)}
                      chipColor={miscColorByKind[op.kind] || 'info'}
                      name={op.objectName}
                      isDestructive={op.isDestructive}
                      sql={previewOpSQL(op)}
                      sqlMaxHeight={160}
                    />
                  );
                })}
              </OpSection>
            )}

            {/* Domains section ------------------------------------------------- */}
            {domainOps.length > 0 && (
              <OpSection
                title={t('schemaSync.domains')}
                icon={<LabelIcon sx={{ fontSize: 14 }} />}
                count={domainOps.length}
                selectedCount={selectedCountInCategory('domain')}
                onToggleAll={() => toggleAllInCategory('domain')}
                hasDestructive={domainOps.some((o) => o.isDestructive)}
              >
                {domainOps.map((op) => {
                  const isSelected = selectedOpIds.has(op.id);
                  const renameMode = opRenameModes.get(op.id) ?? 'accept';
                  const renameExtras =
                    op.kind === 'rename' ? (
                      <RenameResolverButtons
                        value={renameMode}
                        onChange={(mode) => setOpRenameMode(op.id, mode)}
                      />
                    ) : null;
                  return (
                    <OpRow
                      key={op.id}
                      id={op.id}
                      selected={isSelected}
                      onToggle={() => toggleOp(op.id)}
                      kindIcon={miscKindIcon[op.kind]}
                      chipLabel={miscChipLabel(op)}
                      chipColor={miscColorByKind[op.kind] || 'info'}
                      name={op.objectName}
                      isDestructive={op.isDestructive}
                      collapsedExtras={renameExtras}
                      sql={previewOpSQL(op)}
                      sqlMaxHeight={160}
                    />
                  );
                })}
              </OpSection>
            )}

            {/* Tables section -------------------------------------------------- */}
            {visibleTables.length > 0 && (
              <OpSection
                title={t('schemaSync.tables') || 'Tables'}
                icon={<TableChartIcon sx={{ fontSize: 14 }} />}
                count={visibleTables.length}
                selectedCount={visibleTables.filter((tbl) => selected.has(tbl.tableName)).length}
                onToggleAll={toggleAll}
                hasDestructive={visibleTables.some((tbl) => tbl.isDestructive)}
              >
                {visibleTables.map((td) => {
                  const isSelected = selected.has(td.tableName);
                  const name =
                    td.kind === 'rename' && td.renamedFrom
                      ? `${td.renamedFrom} → ${td.tableName}`
                      : td.tableName;
                  const meta = undefined;
                  const renameMode = tableRenameModes.get(td.tableName) ?? 'accept';
                  const renameExtras =
                    td.kind === 'rename' ? (
                      <RenameResolverButtons
                        value={renameMode}
                        onChange={(mode) => setTableRenameMode(td.tableName, mode)}
                      />
                    ) : null;
                  const sql = (() => {
                    if (td.kind === 'rename' && renameMode !== 'accept') {
                      const resolved = resolveTableRenames(
                        [td],
                        new Map([[td.tableName, renameMode]]),
                      );
                      return resolved.map((r) => generateTableSQL(r)).join('\n\n');
                    }
                    return generateTableSQL(td);
                  })();
                  return (
                    <OpRow
                      key={td.tableName}
                      id={td.tableName}
                      selected={isSelected}
                      onToggle={() => toggleTable(td.tableName)}
                      kindIcon={kindIcon[td.kind]}
                      chipLabel={`${kindLabel[td.kind]} TABLE`}
                      chipColor={kindColor[td.kind]}
                      name={name}
                      meta={meta}
                      isDestructive={td.isDestructive}
                      collapsedExtras={renameExtras}
                      sql={sql}
                      sqlMaxHeight={240}
                    />
                  );
                })}
              </OpSection>
            )}

            <Divider sx={{ my: 1.5 }} />
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button onClick={onClose} size="small">
          {t('schemaSync.close')}
        </Button>
        {onApplySQL && (
          <Button
            variant="contained"
            size="small"
            onClick={handleInsertToEditor}
            disabled={!finalSQL}
            sx={{
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
              '&.Mui-disabled': { background: 'rgba(99, 102, 241, 0.3)', color: 'rgba(255,255,255,0.5)' },
            }}
          >
            {t('schemaSync.insertToEditor')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
