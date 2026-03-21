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
  FormControlLabel,
  Chip,
  Divider,
  IconButton,
  Tooltip,
  CircularProgress,
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Switch,
} from '@mui/material';
import {
  CompareArrows as CompareIcon,
  ExpandMore as ExpandMoreIcon,
  ContentCopy as CopyIcon,
  Code as CodeIcon,
  Warning as WarningIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import type { DatabaseServer, DatabaseInfo, Table, Column, Index, Constraint } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DiffKind = 'add' | 'drop' | 'alter';

interface ColumnDiff {
  kind: DiffKind;
  tableName: string;
  column?: Column;
  sourceColumn?: Column;
  targetColumn?: Column;
}

interface IndexDiff {
  kind: DiffKind;
  tableName: string;
  index?: Index;
  sourceIndex?: Index;
  targetIndex?: Index;
}

interface ConstraintDiff {
  kind: DiffKind;
  tableName: string;
  constraint?: Constraint;
  sourceConstraint?: Constraint;
  targetConstraint?: Constraint;
}

interface TableDiff {
  tableName: string;
  kind: DiffKind; // 'add' = exists only in source, 'drop' = exists only in target, 'alter' = differs
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  constraints: ConstraintDiff[];
  isDestructive: boolean;
}

interface SchemaDiff {
  tables: TableDiff[];
  hasChanges: boolean;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SchemaSyncModalProps {
  open: boolean;
  onClose: () => void;
  connections: DatabaseServer[];
  onApplySQL?: (sql: string) => void;
}

// ---------------------------------------------------------------------------
// Diff engine (public schema only in MVP)
// ---------------------------------------------------------------------------

function getPublicTables(db: DatabaseInfo): Table[] {
  return (db.tables || []).filter(
    (t) => !t.table_schema || t.table_schema === 'public'
  );
}

function columnKey(c: Column): string {
  return c.column_name;
}

function columnsEqual(a: Column, b: Column): boolean {
  return (
    a.data_type === b.data_type &&
    a.is_nullable === b.is_nullable &&
    a.column_default === b.column_default &&
    a.character_maximum_length === b.character_maximum_length &&
    a.numeric_precision === b.numeric_precision &&
    a.numeric_scale === b.numeric_scale
  );
}

function indexKey(idx: Index): string {
  return idx.index_name;
}

function indexesEqual(a: Index, b: Index): boolean {
  return (
    a.index_definition === b.index_definition &&
    a.is_unique === b.is_unique
  );
}

function constraintKey(c: Constraint): string {
  return c.constraint_name;
}

function constraintsEqual(a: Constraint, b: Constraint): boolean {
  return (
    a.constraint_type === b.constraint_type &&
    a.column_name === b.column_name &&
    a.referenced_table === b.referenced_table &&
    a.referenced_column === b.referenced_column &&
    a.check_condition === b.check_condition
  );
}

function diffSchemas(sourceDb: DatabaseInfo, targetDb: DatabaseInfo): SchemaDiff {
  const sourceTables = getPublicTables(sourceDb);
  const targetTables = getPublicTables(targetDb);

  const sourceMap = new Map(sourceTables.map((t) => [t.table_name, t]));
  const targetMap = new Map(targetTables.map((t) => [t.table_name, t]));

  const tables: TableDiff[] = [];

  // Tables in source but not in target → CREATE TABLE
  for (const [name, srcTable] of sourceMap) {
    if (!targetMap.has(name)) {
      tables.push({
        tableName: name,
        kind: 'add',
        columns: (srcTable.columns || []).map((c) => ({ kind: 'add', tableName: name, column: c })),
        indexes: (srcTable.indexes || []).map((i) => ({ kind: 'add', tableName: name, index: i })),
        constraints: (srcTable.constraints || []).map((c) => ({ kind: 'add', tableName: name, constraint: c })),
        isDestructive: false,
      });
    }
  }

  // Tables in target but not in source → DROP TABLE (destructive)
  for (const [name, tgtTable] of targetMap) {
    if (!sourceMap.has(name)) {
      tables.push({
        tableName: name,
        kind: 'drop',
        columns: [],
        indexes: [],
        constraints: [],
        isDestructive: true,
      });
    }
  }

  // Tables in both → compare columns, indexes, constraints
  for (const [name, srcTable] of sourceMap) {
    const tgtTable = targetMap.get(name);
    if (!tgtTable) continue;

    const colDiffs: ColumnDiff[] = [];
    const idxDiffs: IndexDiff[] = [];
    const conDiffs: ConstraintDiff[] = [];

    const srcCols = new Map((srcTable.columns || []).map((c) => [columnKey(c), c]));
    const tgtCols = new Map((tgtTable.columns || []).map((c) => [columnKey(c), c]));

    for (const [key, col] of srcCols) {
      const tgtCol = tgtCols.get(key);
      if (!tgtCol) {
        colDiffs.push({ kind: 'add', tableName: name, column: col });
      } else if (!columnsEqual(col, tgtCol)) {
        colDiffs.push({ kind: 'alter', tableName: name, sourceColumn: col, targetColumn: tgtCol });
      }
    }
    for (const [key, col] of tgtCols) {
      if (!srcCols.has(key)) {
        colDiffs.push({ kind: 'drop', tableName: name, column: col });
      }
    }

    const srcIdxs = new Map((srcTable.indexes || []).map((i) => [indexKey(i), i]));
    const tgtIdxs = new Map((tgtTable.indexes || []).map((i) => [indexKey(i), i]));

    for (const [key, idx] of srcIdxs) {
      const tgtIdx = tgtIdxs.get(key);
      if (!tgtIdx) {
        idxDiffs.push({ kind: 'add', tableName: name, index: idx });
      } else if (!indexesEqual(idx, tgtIdx)) {
        idxDiffs.push({ kind: 'alter', tableName: name, sourceIndex: idx, targetIndex: tgtIdx });
      }
    }
    for (const [key] of tgtIdxs) {
      if (!srcIdxs.has(key)) {
        idxDiffs.push({ kind: 'drop', tableName: name, index: tgtIdxs.get(key)! });
      }
    }

    const srcCons = new Map((srcTable.constraints || []).map((c) => [constraintKey(c), c]));
    const tgtCons = new Map((tgtTable.constraints || []).map((c) => [constraintKey(c), c]));

    for (const [key, con] of srcCons) {
      const tgtCon = tgtCons.get(key);
      if (!tgtCon) {
        conDiffs.push({ kind: 'add', tableName: name, constraint: con });
      } else if (!constraintsEqual(con, tgtCon)) {
        conDiffs.push({ kind: 'alter', tableName: name, sourceConstraint: con, targetConstraint: tgtCon });
      }
    }
    for (const [key] of tgtCons) {
      if (!srcCons.has(key)) {
        conDiffs.push({ kind: 'drop', tableName: name, constraint: tgtCons.get(key)! });
      }
    }

    if (colDiffs.length > 0 || idxDiffs.length > 0 || conDiffs.length > 0) {
      const isDestructive = colDiffs.some((d) => d.kind === 'drop') ||
        idxDiffs.some((d) => d.kind === 'drop') ||
        conDiffs.some((d) => d.kind === 'drop');
      tables.push({
        tableName: name,
        kind: 'alter',
        columns: colDiffs,
        indexes: idxDiffs,
        constraints: conDiffs,
        isDestructive,
      });
    }
  }

  // Sort: CREATE TABLE first, then ALTER, then DROP
  const order: Record<DiffKind, number> = { add: 0, alter: 1, drop: 2 };
  tables.sort((a, b) => order[a.kind] - order[b.kind] || a.tableName.localeCompare(b.tableName));

  return { tables, hasChanges: tables.length > 0 };
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function columnTypeSQL(col: Column): string {
  let t = col.data_type;
  if (col.character_maximum_length) {
    t += `(${col.character_maximum_length})`;
  } else if (col.numeric_precision && col.data_type.toLowerCase().includes('numeric')) {
    t += `(${col.numeric_precision}${col.numeric_scale ? `, ${col.numeric_scale}` : ''})`;
  }
  return t;
}

function generateCreateTable(diff: TableDiff): string {
  const cols = diff.columns
    .filter((d) => d.kind === 'add' && d.column)
    .map((d) => {
      const c = d.column!;
      let line = `  ${quoteIdent(c.column_name)} ${columnTypeSQL(c)}`;
      if (c.is_nullable === 'NO') line += ' NOT NULL';
      if (c.column_default !== null && c.column_default !== undefined) line += ` DEFAULT ${c.column_default}`;
      return line;
    });

  const pks = diff.constraints
    .filter((d) => d.kind === 'add' && d.constraint?.constraint_type === 'PRIMARY KEY')
    .map((d) => d.constraint!);

  if (pks.length > 0) {
    const pkCols = pks.map((pk) => quoteIdent(pk.column_name)).join(', ');
    cols.push(`  PRIMARY KEY (${pkCols})`);
  }

  let sql = `CREATE TABLE ${quoteIdent(diff.tableName)} (\n${cols.join(',\n')}\n);`;

  // Non-PK constraints
  const otherConstraints = diff.constraints
    .filter((d) => d.kind === 'add' && d.constraint && d.constraint.constraint_type !== 'PRIMARY KEY');
  for (const cd of otherConstraints) {
    const c = cd.constraint!;
    if (c.constraint_type === 'FOREIGN KEY') {
      sql += `\nALTER TABLE ${quoteIdent(diff.tableName)} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} FOREIGN KEY (${quoteIdent(c.column_name)}) REFERENCES ${quoteIdent(c.referenced_table || '')}(${quoteIdent(c.referenced_column || '')})`;
      if (c.on_delete) sql += ` ON DELETE ${c.on_delete}`;
      if (c.on_update) sql += ` ON UPDATE ${c.on_update}`;
      sql += ';';
    } else if (c.constraint_type === 'UNIQUE') {
      sql += `\nALTER TABLE ${quoteIdent(diff.tableName)} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} UNIQUE (${quoteIdent(c.column_name)});`;
    } else if (c.constraint_type === 'CHECK' && c.check_condition) {
      sql += `\nALTER TABLE ${quoteIdent(diff.tableName)} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} CHECK (${c.check_condition});`;
    }
  }

  // Indexes (non-primary)
  for (const id of diff.indexes.filter((d) => d.kind === 'add' && d.index && !d.index.is_primary)) {
    const idx = id.index!;
    if (idx.index_definition) {
      sql += `\n${idx.index_definition};`;
    } else {
      const unique = idx.is_unique ? 'UNIQUE ' : '';
      sql += `\nCREATE ${unique}INDEX ${quoteIdent(idx.index_name)} ON ${quoteIdent(diff.tableName)} (${idx.columns.map(quoteIdent).join(', ')});`;
    }
  }

  return sql;
}

function generateAlterTable(diff: TableDiff): string {
  const statements: string[] = [];
  const tbl = quoteIdent(diff.tableName);

  // Add columns
  for (const cd of diff.columns.filter((d) => d.kind === 'add' && d.column)) {
    const c = cd.column!;
    let line = `ALTER TABLE ${tbl} ADD COLUMN ${quoteIdent(c.column_name)} ${columnTypeSQL(c)}`;
    if (c.is_nullable === 'NO') line += ' NOT NULL';
    if (c.column_default !== null && c.column_default !== undefined) line += ` DEFAULT ${c.column_default}`;
    statements.push(line + ';');
  }

  // Alter columns (type change, nullability, default)
  for (const cd of diff.columns.filter((d) => d.kind === 'alter' && d.sourceColumn && d.targetColumn)) {
    const src = cd.sourceColumn!;
    const tgt = cd.targetColumn!;
    const col = quoteIdent(src.column_name);

    if (src.data_type !== tgt.data_type || src.character_maximum_length !== tgt.character_maximum_length) {
      statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} TYPE ${columnTypeSQL(src)};`);
    }
    if (src.is_nullable !== tgt.is_nullable) {
      if (src.is_nullable === 'NO') {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET NOT NULL;`);
      } else {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP NOT NULL;`);
      }
    }
    if (src.column_default !== tgt.column_default) {
      if (src.column_default !== null && src.column_default !== undefined) {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${src.column_default};`);
      } else {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT;`);
      }
    }
  }

  // Drop columns
  for (const cd of diff.columns.filter((d) => d.kind === 'drop' && d.column)) {
    statements.push(`ALTER TABLE ${tbl} DROP COLUMN ${quoteIdent(cd.column!.column_name)};`);
  }

  // Add constraints
  for (const cd of diff.constraints.filter((d) => d.kind === 'add' && d.constraint)) {
    const c = cd.constraint!;
    if (c.constraint_type === 'FOREIGN KEY') {
      let stmt = `ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} FOREIGN KEY (${quoteIdent(c.column_name)}) REFERENCES ${quoteIdent(c.referenced_table || '')}(${quoteIdent(c.referenced_column || '')})`;
      if (c.on_delete) stmt += ` ON DELETE ${c.on_delete}`;
      if (c.on_update) stmt += ` ON UPDATE ${c.on_update}`;
      statements.push(stmt + ';');
    } else if (c.constraint_type === 'UNIQUE') {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} UNIQUE (${quoteIdent(c.column_name)});`);
    } else if (c.constraint_type === 'CHECK' && c.check_condition) {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} CHECK (${c.check_condition});`);
    } else if (c.constraint_type === 'PRIMARY KEY') {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(c.constraint_name)} PRIMARY KEY (${quoteIdent(c.column_name)});`);
    }
  }

  // Drop constraints
  for (const cd of diff.constraints.filter((d) => d.kind === 'drop' && d.constraint)) {
    statements.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${quoteIdent(cd.constraint!.constraint_name)};`);
  }

  // Alter constraints (drop + re-add)
  for (const cd of diff.constraints.filter((d) => d.kind === 'alter' && d.sourceConstraint)) {
    const src = cd.sourceConstraint!;
    statements.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${quoteIdent(src.constraint_name)};`);
    if (src.constraint_type === 'FOREIGN KEY') {
      let stmt = `ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(src.constraint_name)} FOREIGN KEY (${quoteIdent(src.column_name)}) REFERENCES ${quoteIdent(src.referenced_table || '')}(${quoteIdent(src.referenced_column || '')})`;
      if (src.on_delete) stmt += ` ON DELETE ${src.on_delete}`;
      if (src.on_update) stmt += ` ON UPDATE ${src.on_update}`;
      statements.push(stmt + ';');
    } else if (src.constraint_type === 'UNIQUE') {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(src.constraint_name)} UNIQUE (${quoteIdent(src.column_name)});`);
    } else if (src.constraint_type === 'CHECK' && src.check_condition) {
      statements.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteIdent(src.constraint_name)} CHECK (${src.check_condition});`);
    }
  }

  // Add indexes
  for (const id of diff.indexes.filter((d) => d.kind === 'add' && d.index && !d.index.is_primary)) {
    const idx = id.index!;
    if (idx.index_definition) {
      statements.push(`${idx.index_definition};`);
    } else {
      const unique = idx.is_unique ? 'UNIQUE ' : '';
      statements.push(`CREATE ${unique}INDEX ${quoteIdent(idx.index_name)} ON ${tbl} (${idx.columns.map(quoteIdent).join(', ')});`);
    }
  }

  // Drop indexes
  for (const id of diff.indexes.filter((d) => d.kind === 'drop' && d.index)) {
    statements.push(`DROP INDEX ${quoteIdent(id.index!.index_name)};`);
  }

  // Alter indexes (drop + re-create)
  for (const id of diff.indexes.filter((d) => d.kind === 'alter' && d.sourceIndex)) {
    const src = id.sourceIndex!;
    statements.push(`DROP INDEX ${quoteIdent(src.index_name)};`);
    if (src.index_definition) {
      statements.push(`${src.index_definition};`);
    } else {
      const unique = src.is_unique ? 'UNIQUE ' : '';
      statements.push(`CREATE ${unique}INDEX ${quoteIdent(src.index_name)} ON ${tbl} (${src.columns.map(quoteIdent).join(', ')});`);
    }
  }

  return statements.join('\n');
}

function generateDropTable(diff: TableDiff): string {
  return `DROP TABLE ${quoteIdent(diff.tableName)};`;
}

function generateSQL(diff: TableDiff): string {
  switch (diff.kind) {
    case 'add':
      return generateCreateTable(diff);
    case 'drop':
      return generateDropTable(diff);
    case 'alter':
      return generateAlterTable(diff);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const kindIcon: Record<DiffKind, React.ReactNode> = {
  add: <AddIcon sx={{ fontSize: 14, color: 'success.main' }} />,
  drop: <RemoveIcon sx={{ fontSize: 14, color: 'error.main' }} />,
  alter: <EditIcon sx={{ fontSize: 14, color: 'warning.main' }} />,
};

const kindLabel: Record<DiffKind, string> = {
  add: 'CREATE',
  drop: 'DROP',
  alter: 'ALTER',
};

const kindColor: Record<DiffKind, 'success' | 'error' | 'warning'> = {
  add: 'success',
  drop: 'error',
  alter: 'warning',
};

export default function SchemaSyncModal({ open, onClose, connections, onApplySQL }: SchemaSyncModalProps) {
  const [sourceId, setSourceId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDestructive, setShowDestructive] = useState(false);
  const [previewSQL, setPreviewSQL] = useState(false);
  const [copied, setCopied] = useState(false);

  const activeConnections = useMemo(
    () => connections.filter((c) => c.isActive),
    [connections]
  );

  const handleCompare = useCallback(async () => {
    if (!sourceId || !targetId) return;
    if (sourceId === targetId) {
      setError('Source and Target must be different connections');
      return;
    }

    setLoading(true);
    setError(null);
    setDiff(null);
    setSelected(new Set());

    try {
      const [sourceResult, targetResult] = await Promise.all([
        window.electronAPI.getDatabaseStructure(sourceId),
        window.electronAPI.getDatabaseStructure(targetId),
      ]);

      if (!sourceResult.success || !sourceResult.databases?.length) {
        throw new Error('Failed to fetch Source schema. Ensure the connection is active and has a database.');
      }
      if (!targetResult.success || !targetResult.databases?.length) {
        throw new Error('Failed to fetch Target schema. Ensure the connection is active and has a database.');
      }

      const sourceDb = sourceResult.databases[0];
      const targetDb = targetResult.databases[0];
      const result = diffSchemas(sourceDb, targetDb);
      setDiff(result);

      // Select all non-destructive by default
      const defaultSelected = new Set<string>();
      for (const td of result.tables) {
        if (!td.isDestructive) {
          defaultSelected.add(td.tableName);
        }
      }
      setSelected(defaultSelected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [sourceId, targetId]);

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

  const toggleAll = useCallback(() => {
    if (!diff) return;
    const visibleTables = diff.tables.filter((t) => showDestructive || !t.isDestructive);
    const allSelected = visibleTables.every((t) => selected.has(t.tableName));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleTables.map((t) => t.tableName)));
    }
  }, [diff, showDestructive, selected]);

  const visibleTables = useMemo(() => {
    if (!diff) return [];
    return diff.tables.filter((t) => showDestructive || !t.isDestructive);
  }, [diff, showDestructive]);

  const finalSQL = useMemo(() => {
    if (!diff) return '';
    const parts: string[] = [];
    for (const td of diff.tables) {
      if (!selected.has(td.tableName)) continue;
      if (!showDestructive && td.isDestructive && td.kind === 'drop') continue;
      parts.push(`-- ${kindLabel[td.kind]} TABLE: ${td.tableName}`);
      parts.push(generateSQL(td));
      parts.push('');
    }
    return parts.join('\n').trim();
  }, [diff, selected, showDestructive]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(finalSQL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [finalSQL]);

  const handleInsertToEditor = useCallback(() => {
    if (onApplySQL && finalSQL) {
      onApplySQL(finalSQL);
      onClose();
    }
  }, [onApplySQL, finalSQL, onClose]);

  const getConnectionLabel = (conn: DatabaseServer) => {
    return `${conn.connectionName || conn.database} (${conn.host}:${conn.port}/${conn.database})`;
  };

  const diffSummary = useMemo(() => {
    if (!diff) return { add: 0, alter: 0, drop: 0 };
    return {
      add: diff.tables.filter((t) => t.kind === 'add').length,
      alter: diff.tables.filter((t) => t.kind === 'alter').length,
      drop: diff.tables.filter((t) => t.kind === 'drop').length,
    };
  }, [diff]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          maxHeight: '85vh',
          bgcolor: 'background.paper',
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <CompareIcon sx={{ color: 'primary.main' }} />
        <Typography variant="h6" component="span">
          Schema Sync
        </Typography>
        <Chip label="MVP: public schema" size="small" variant="outlined" sx={{ ml: 'auto' }} />
      </DialogTitle>

      <DialogContent dividers sx={{ p: 2 }}>
        {/* Connection selectors */}
        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <FormControl fullWidth size="small">
            <InputLabel>Source (reference)</InputLabel>
            <Select
              value={sourceId}
              label="Source (reference)"
              onChange={(e) => { setSourceId(e.target.value); setDiff(null); }}
            >
              {activeConnections.map((c) => (
                <MenuItem key={c.id} value={c.id} disabled={c.id === targetId}>
                  {getConnectionLabel(c)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <CompareIcon sx={{ color: 'text.secondary' }} />
          </Box>

          <FormControl fullWidth size="small">
            <InputLabel>Target (to migrate)</InputLabel>
            <Select
              value={targetId}
              label="Target (to migrate)"
              onChange={(e) => { setTargetId(e.target.value); setDiff(null); }}
            >
              {activeConnections.map((c) => (
                <MenuItem key={c.id} value={c.id} disabled={c.id === sourceId}>
                  {getConnectionLabel(c)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
          <Button
            variant="contained"
            onClick={handleCompare}
            disabled={!sourceId || !targetId || loading}
            startIcon={loading ? <CircularProgress size={16} /> : <CompareIcon />}
            size="small"
          >
            {loading ? 'Comparing...' : 'Compare Schemas'}
          </Button>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {activeConnections.length < 2 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            At least 2 active connections are required for schema comparison.
          </Alert>
        )}

        {/* Diff results */}
        {diff && !diff.hasChanges && (
          <Alert severity="success">
            Schemas are identical. No migration needed.
          </Alert>
        )}

        {diff && diff.hasChanges && (
          <>
            {/* Summary bar */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
              {diffSummary.add > 0 && (
                <Chip icon={<AddIcon />} label={`${diffSummary.add} create`} size="small" color="success" variant="outlined" />
              )}
              {diffSummary.alter > 0 && (
                <Chip icon={<EditIcon />} label={`${diffSummary.alter} alter`} size="small" color="warning" variant="outlined" />
              )}
              {diffSummary.drop > 0 && (
                <Chip icon={<RemoveIcon />} label={`${diffSummary.drop} drop`} size="small" color="error" variant="outlined" />
              )}

              <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={showDestructive}
                      onChange={(e) => setShowDestructive(e.target.checked)}
                    />
                  }
                  label={
                    <Typography variant="caption" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <WarningIcon sx={{ fontSize: 14, color: 'warning.main' }} />
                      Show destructive
                    </Typography>
                  }
                />
              </Box>
            </Box>

            {/* Select all */}
            <Box sx={{ mb: 1 }}>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={visibleTables.length > 0 && visibleTables.every((t) => selected.has(t.tableName))}
                    indeterminate={
                      visibleTables.some((t) => selected.has(t.tableName)) &&
                      !visibleTables.every((t) => selected.has(t.tableName))
                    }
                    onChange={toggleAll}
                  />
                }
                label={
                  <Typography variant="caption" color="text.secondary">
                    Select all ({visibleTables.length} tables)
                  </Typography>
                }
              />
            </Box>

            {/* Table diffs */}
            {visibleTables.map((td) => (
              <Accordion
                key={td.tableName}
                disableGutters
                sx={{
                  boxShadow: 'none',
                  '&:before': { display: 'none' },
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: '4px !important',
                  mb: 0.5,
                  overflow: 'hidden',
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon />}
                  sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5, alignItems: 'center', gap: 1 } }}
                >
                  <Checkbox
                    size="small"
                    checked={selected.has(td.tableName)}
                    onChange={() => toggleTable(td.tableName)}
                    onClick={(e) => e.stopPropagation()}
                    sx={{ p: 0 }}
                  />
                  {kindIcon[td.kind]}
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8125rem', fontWeight: 500 }}>
                    {td.tableName}
                  </Typography>
                  <Chip
                    label={kindLabel[td.kind]}
                    size="small"
                    color={kindColor[td.kind]}
                    variant="outlined"
                    sx={{ height: 20, fontSize: '0.625rem' }}
                  />
                  {td.isDestructive && (
                    <WarningIcon sx={{ fontSize: 14, color: 'warning.main', ml: 0.5 }} />
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto', mr: 1 }}>
                    {td.kind === 'add' ? `${td.columns.length} cols` :
                      td.kind === 'drop' ? '' :
                        `${td.columns.length} col, ${td.indexes.length} idx, ${td.constraints.length} con`}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0, pb: 1, px: 2 }}>
                  {td.kind === 'drop' ? (
                    <Typography variant="caption" color="error.main">
                      This table exists in Target but not in Source. It will be dropped.
                    </Typography>
                  ) : (
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        p: 1,
                        bgcolor: 'action.hover',
                        borderRadius: 1,
                        fontSize: '0.75rem',
                        fontFamily: 'monospace',
                        overflow: 'auto',
                        maxHeight: 200,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {generateSQL(td)}
                    </Box>
                  )}
                </AccordionDetails>
              </Accordion>
            ))}

            <Divider sx={{ my: 2 }} />

            {/* Preview SQL */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<CodeIcon />}
                onClick={() => setPreviewSQL(!previewSQL)}
              >
                {previewSQL ? 'Hide' : 'Preview'} SQL
              </Button>
              <Tooltip title={copied ? 'Copied!' : 'Copy as migration'}>
                <span>
                  <IconButton
                    size="small"
                    onClick={handleCopy}
                    disabled={!finalSQL}
                  >
                    <CopyIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Typography variant="caption" color="text.secondary">
                {selected.size} of {visibleTables.length} tables selected
              </Typography>
            </Box>

            {previewSQL && (
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1.5,
                  bgcolor: 'grey.900',
                  color: 'grey.100',
                  borderRadius: 1,
                  fontSize: '0.75rem',
                  fontFamily: 'monospace',
                  overflow: 'auto',
                  maxHeight: 300,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {finalSQL || '-- No changes selected'}
              </Box>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button onClick={onClose} size="small">
          Close
        </Button>
        {onApplySQL && (
          <Button
            variant="contained"
            size="small"
            onClick={handleInsertToEditor}
            disabled={!finalSQL}
            startIcon={<CodeIcon />}
          >
            Insert to Editor
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
