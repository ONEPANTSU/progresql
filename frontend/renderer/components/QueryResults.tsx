import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Chip,
  Tooltip,
  IconButton,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Checkbox,
} from '@mui/material';
import {
  Delete as DeleteIcon,
  Add as AddIcon,
  Check as CheckIcon,
  Close as CloseIcon,
  CheckBoxOutlineBlank as UncheckedIcon,
  CheckBox as CheckedIcon,
  AutoFixHigh as FixIcon,
} from '@mui/icons-material';
import { QueryResult } from '../types';
import { useTranslation } from '../contexts/LanguageContext';

interface QueryResultsProps {
  result: QueryResult | null;
  executedQuery?: string;
  onExecuteQuery?: (query: string) => Promise<void>;
  onMutateQuery?: (query: string) => Promise<{ success: boolean; message?: string }>;
  onFixInChat?: (sql: string, error: string) => void;
}

function detectTableFromQuery(query: string): { schema: string | null; table: string | null; isSelectStar: boolean } {
  const normalized = query.replace(/\s+/g, ' ').trim();
  const selectStarMatch = normalized.match(
    /^SELECT\s+\*\s+FROM\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i
  );
  if (selectStarMatch) {
    return {
      schema: selectStarMatch[1] || null,
      table: selectStarMatch[2],
      isSelectStar: true,
    };
  }
  const selectMatch = normalized.match(
    /^SELECT\s+.+?\s+FROM\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i
  );
  if (selectMatch) {
    return {
      schema: selectMatch[1] || null,
      table: selectMatch[2],
      isSelectStar: false,
    };
  }
  return { schema: null, table: null, isSelectStar: false };
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function formatSQLValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildWhereClause(row: Record<string, unknown>, fields: { name: string }[]): string {
  // Prefer primary key columns (id) for WHERE to avoid type-mismatch issues with JSON/timestamp/etc.
  const idField = fields.find((f) => f.name === 'id');
  if (idField && row[idField.name] !== null && row[idField.name] !== undefined) {
    return `${quoteIdentifier(idField.name)} = ${formatSQLValue(row[idField.name])}`;
  }

  // Fallback: use all simple (non-object, non-date) columns
  const conditions = fields
    .filter((f) => {
      const val = row[f.name];
      if (val === null || val === undefined) return true;
      if (val instanceof Date || typeof val === 'object') return false;
      return true;
    })
    .map((f) => {
      const val = row[f.name];
      if (val === null || val === undefined) {
        return `${quoteIdentifier(f.name)} IS NULL`;
      }
      return `${quoteIdentifier(f.name)} = ${formatSQLValue(val)}`;
    });
  return conditions.join(' AND ');
}

function qualifiedTable(schema: string | null, table: string): string {
  if (schema) return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  return quoteIdentifier(table);
}

export default function QueryResults({ result, executedQuery, onExecuteQuery, onMutateQuery, onFixInChat }: QueryResultsProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  // Sorting
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  // Column widths for resizing
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  // Column order
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  // Inline editing
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; fieldName: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  // Pending edits (batched, committed on "Save changes")
  const [pendingEdits, setPendingEdits] = useState<Map<string, { rowIndex: number; fieldName: string; newValue: string; row: any }>>(new Map());
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  // Row selection & deletion
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<boolean>(false);
  // Add row
  const [isAddingRow, setIsAddingRow] = useState(false);
  const [newRowValues, setNewRowValues] = useState<Record<string, string>>({});
  // Resize state
  const resizeRef = useRef<{ field: string; startX: number; startWidth: number } | null>(null);
  // Drag-n-drop column reorder
  const dragRef = useRef<{ dragIndex: number } | null>(null);

  const queryInfo = executedQuery ? detectTableFromQuery(executedQuery) : { schema: null, table: null, isSelectStar: false };
  const canMutate = !!queryInfo.table && !!(onExecuteQuery || onMutateQuery);

  // Reset column order when result changes
  useEffect(() => {
    if (result?.fields) {
      setColumnOrder(result.fields.map((f) => f.name));
      setColumnWidths({});
      setEditingCell(null);
      setIsAddingRow(false);
      setSelectedRows(new Set());
      setPendingEdits(new Map());
      setSortField(null);
    }
  }, [result]);

  const orderedFields = result
    ? columnOrder
        .map((name) => result.fields.find((f) => f.name === name))
        .filter(Boolean) as typeof result.fields
    : [];

  const sortedRows = React.useMemo(() => {
    if (!result || !sortField) return result?.rows || [];
    return [...result.rows].sort((a, b) => {
      const va = a[sortField];
      const vb = b[sortField];
      if (va === null || va === undefined) return sortDirection === 'asc' ? 1 : -1;
      if (vb === null || vb === undefined) return sortDirection === 'asc' ? -1 : 1;
      if (typeof va === 'number' && typeof vb === 'number') return sortDirection === 'asc' ? va - vb : vb - va;
      const sa = String(va);
      const sb = String(vb);
      return sortDirection === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
  }, [result, sortField, sortDirection]);

  // --- Resize handlers ---
  const handleResizeStart = useCallback((e: React.MouseEvent, fieldName: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = columnWidths[fieldName] || 150;
    resizeRef.current = { field: fieldName, startX: e.clientX, startWidth };

    const handleMouseMove = (ev: MouseEvent) => {
      const ref = resizeRef.current;
      if (!ref) return;
      const diff = ev.clientX - ref.startX;
      const newWidth = Math.max(60, ref.startWidth + diff);
      setColumnWidths((prev) => ({ ...prev, [ref.field]: newWidth }));
    };
    const handleMouseUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [columnWidths]);

  // --- Drag-n-drop column reorder ---
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    dragRef.current = { dragIndex: index };
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires setData
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (!dragRef.current) return;
    const { dragIndex } = dragRef.current;
    if (dragIndex === dropIndex) return;
    setColumnOrder((prev) => {
      const updated = [...prev];
      const [moved] = updated.splice(dragIndex, 1);
      updated.splice(dropIndex, 0, moved);
      return updated;
    });
    dragRef.current = null;
  }, []);

  // --- Inline editing ---
  const handleCellDoubleClick = useCallback((rowIndex: number, fieldName: string, currentValue: unknown) => {
    if (!canMutate) return;
    setEditingCell({ rowIndex, fieldName });
    if (currentValue === null || currentValue === undefined) {
      setEditValue('');
    } else if (currentValue instanceof Date) {
      setEditValue(currentValue.toISOString());
    } else if (typeof currentValue === 'object') {
      setEditValue(JSON.stringify(currentValue));
    } else {
      setEditValue(String(currentValue));
    }
  }, [canMutate]);

  const handleEditCancel = useCallback(() => {
    setEditingCell(null);
    setEditValue('');
  }, []);

  const handleEditSave = useCallback(() => {
    if (!editingCell || !result) return;
    const row = sortedRows[editingCell.rowIndex];
    if (!row) return;

    // Compare with original value — skip if nothing actually changed
    const originalRaw = row[editingCell.fieldName];
    let originalStr: string;
    if (originalRaw === null || originalRaw === undefined) {
      originalStr = '';
    } else if (originalRaw instanceof Date) {
      originalStr = originalRaw.toISOString();
    } else if (typeof originalRaw === 'object') {
      originalStr = JSON.stringify(originalRaw);
    } else {
      originalStr = String(originalRaw);
    }

    if (editValue === originalStr) {
      // Value unchanged — just cancel editing without marking as pending
      setEditingCell(null);
      setEditValue('');
      return;
    }

    const key = `${editingCell.rowIndex}:${editingCell.fieldName}`;
    setPendingEdits(prev => {
      const next = new Map(prev);
      next.set(key, { rowIndex: editingCell.rowIndex, fieldName: editingCell.fieldName, newValue: editValue, row });
      return next;
    });
    setEditingCell(null);
    setEditValue('');
  }, [editingCell, editValue, result, sortedRows]);

  const handleCommitEdits = useCallback(async () => {
    if (!result || !queryInfo.table || pendingEdits.size === 0) return;
    setIsSavingEdits(true);
    const tbl = qualifiedTable(queryInfo.schema, queryInfo.table);
    for (const { rowIndex, fieldName, newValue, row } of pendingEdits.values()) {
      const newVal = newValue === '' ? 'NULL' : formatSQLValue(newValue);
      const where = buildWhereClause(row, result.fields);
      const sql = `UPDATE ${tbl} SET ${quoteIdentifier(fieldName)} = ${newVal} WHERE ctid = (SELECT ctid FROM ${tbl} WHERE ${where} LIMIT 1)`;
      if (onMutateQuery) {
        const res = await onMutateQuery(sql);
        if (!res.success) { setIsSavingEdits(false); return; }
      } else if (onExecuteQuery) {
        await onExecuteQuery(sql);
      }
    }
    setPendingEdits(new Map());
    setIsSavingEdits(false);
    if (executedQuery && onExecuteQuery) await onExecuteQuery(executedQuery);
  }, [pendingEdits, result, queryInfo, onMutateQuery, onExecuteQuery, executedQuery]);

  const handleDiscardEdits = useCallback(() => {
    setPendingEdits(new Map());
    setEditingCell(null);
    setEditValue('');
  }, []);

  // --- Row selection ---
  const handleToggleRow = useCallback((rowIndex: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    if (!result) return;
    setSelectedRows((prev) => {
      if (prev.size === result.rows.length) return new Set();
      return new Set(result.rows.map((_, i) => i));
    });
  }, [result]);

  // --- Row deletion ---
  const handleDeleteSelected = useCallback(async () => {
    if (!result || !queryInfo.table || selectedRows.size === 0) return;
    if (!onMutateQuery && !onExecuteQuery) return;
    const tbl = qualifiedTable(queryInfo.schema, queryInfo.table);

    for (const rowIndex of Array.from(selectedRows).sort((a, b) => b - a)) {
      const row = sortedRows[rowIndex];
      if (!row) continue;
      const where = buildWhereClause(row, result.fields);
      const sql = `DELETE FROM ${tbl} WHERE ctid = (SELECT ctid FROM ${tbl} WHERE ${where} LIMIT 1)`;
      if (onMutateQuery) {
        await onMutateQuery(sql);
      } else if (onExecuteQuery) {
        await onExecuteQuery(sql);
      }
    }

    setDeleteConfirm(false);
    setSelectedRows(new Set());
    // Refresh
    if (executedQuery && onExecuteQuery) await onExecuteQuery(executedQuery);
  }, [selectedRows, result, sortedRows, queryInfo, onExecuteQuery, onMutateQuery, executedQuery]);

  // --- Add row ---
  const handleAddRowStart = useCallback(() => {
    if (!result) return;
    const defaults: Record<string, string> = {};
    result.fields.forEach((f) => { defaults[f.name] = ''; });
    setNewRowValues(defaults);
    setIsAddingRow(true);
  }, [result]);

  const handleAddRowCancel = useCallback(() => {
    setIsAddingRow(false);
    setNewRowValues({});
  }, []);

  const handleAddRowSave = useCallback(async () => {
    if (!result || !queryInfo.table) return;
    if (!onMutateQuery && !onExecuteQuery) return;
    const columns = result.fields.map((f) => quoteIdentifier(f.name)).join(', ');
    const values = result.fields.map((f) => {
      const v = newRowValues[f.name];
      if (v === '' || v === undefined) return 'DEFAULT';
      if (v.toUpperCase() === 'NULL') return 'NULL';
      return formatSQLValue(v);
    }).join(', ');
    const sql = `INSERT INTO ${qualifiedTable(queryInfo.schema, queryInfo.table)} (${columns}) VALUES (${values})`;

    if (onMutateQuery) {
      const res = await onMutateQuery(sql);
      if (!res.success) return;
    } else if (onExecuteQuery) {
      await onExecuteQuery(sql);
    }
    setIsAddingRow(false);
    setNewRowValues({});
    // Refresh
    if (executedQuery && onExecuteQuery) await onExecuteQuery(executedQuery);
  }, [result, queryInfo, newRowValues, onExecuteQuery, onMutateQuery, executedQuery]);

  const handleChangePage = (_event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleSort = useCallback((fieldName: string) => {
    setSortField((prev) => {
      if (prev === fieldName) {
        setSortDirection((d) => d === 'asc' ? 'desc' : 'asc');
        return fieldName;
      }
      setSortDirection('asc');
      return fieldName;
    });
  }, []);

  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  if (!result) {
    return (
      <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          Execute a SQL query to see results here
        </Typography>
      </Box>
    );
  }

  const paginatedRows = sortedRows.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: '6px 8px', borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" component="div" sx={{ color: 'text.primary' }}>
            Query Results
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {canMutate && pendingEdits.size > 0 && (
              <>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<CheckIcon />}
                  onClick={handleCommitEdits}
                  disabled={isSavingEdits}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.75rem',
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
                    '&.Mui-disabled': { background: 'linear-gradient(135deg, #a5b4fc, #c4b5fd)', color: 'rgba(255,255,255,0.7)' },
                  }}
                >
                  {t('results.saveChanges')} ({pendingEdits.size})
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  startIcon={<CloseIcon />}
                  onClick={handleDiscardEdits}
                  disabled={isSavingEdits}
                  sx={{ textTransform: 'none', fontSize: '0.75rem' }}
                >
                  {t('results.discardChanges')}
                </Button>
              </>
            )}
            {canMutate && selectedRows.size > 0 && (
              <Button
                size="small"
                variant="outlined"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={() => setDeleteConfirm(true)}
                sx={{ textTransform: 'none', fontSize: '0.75rem' }}
              >
                Delete ({selectedRows.size})
              </Button>
            )}
            {canMutate && queryInfo.isSelectStar && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={handleAddRowStart}
                disabled={isAddingRow}
                sx={{ textTransform: 'none', fontSize: '0.75rem' }}
              >
                {t("results.addRow")}
              </Button>
            )}
            <Chip
              label={t('results.rows', { count: String(result.rowCount) })}
              color="primary"
              variant="outlined"
              size="small"
            />
            <Chip
              label={t('results.columns', { count: String(result.fields.length) })}
              color="secondary"
              variant="outlined"
              size="small"
            />
          </Box>
        </Box>
      </Box>

      {result.rows.length > 0 && (
        <>
          <TableContainer sx={{
            flexGrow: 1,
            bgcolor: 'background.default',
            maxWidth: '100%',
            overflow: 'auto',
            width: '100%',
          }}>
            <Table stickyHeader size="small" aria-label="Query results table" sx={{
              tableLayout: 'auto',
              '& .MuiTableHead-root .MuiTableCell-root': {
                bgcolor: 'grey.100',
                color: 'text.primary',
                fontWeight: 600,
                fontSize: '0.8125rem',
                borderBottom: '2px solid',
                borderColor: 'grey.300',
              },
              '& .MuiTableBody-root .MuiTableRow-root': {
                '&:nth-of-type(even)': { bgcolor: 'grey.50' },
                '&:hover': { bgcolor: 'action.hover' },
              },
            }}>
              <TableHead>
                <TableRow>
                  {canMutate && (
                    <TableCell sx={{ width: 36, minWidth: 36, maxWidth: 36, p: 0, textAlign: 'center' }}>
                      <Checkbox
                        size="small"
                        checked={result.rows.length > 0 && selectedRows.size === result.rows.length}
                        indeterminate={selectedRows.size > 0 && selectedRows.size < result.rows.length}
                        onChange={handleToggleAll}
                        sx={{ p: 0.25, '& .MuiSvgIcon-root': { fontSize: 16 } }}
                      />
                    </TableCell>
                  )}
                  {orderedFields.map((field, index) => (
                    <TableCell
                      key={`${field.name}-${index}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, index)}
                      sx={{
                        fontWeight: 600,
                        fontSize: '0.8125rem',
                        py: 0.75,
                        position: 'relative',
                        width: columnWidths[field.name] || 150,
                        minWidth: 60,
                        maxWidth: columnWidths[field.name] || 300,
                        cursor: 'grab',
                        userSelect: 'none',
                        overflow: 'visible',
                        pr: 2,
                      }}
                    >
                      <Box sx={{ overflow: 'hidden', cursor: 'pointer' }} onClick={() => handleSort(field.name)}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Typography variant="subtitle2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {field.name}
                          </Typography>
                          {sortField === field.name && (
                            <Typography sx={{ fontSize: '0.7rem', color: 'primary.main', lineHeight: 1 }}>
                              {sortDirection === 'asc' ? '\u25B2' : '\u25BC'}
                            </Typography>
                          )}
                        </Box>
                        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.6875rem' }}>
                          {field.dataTypeName}
                        </Typography>
                      </Box>
                      {/* Resize handle — double-click to auto-fit */}
                      <Box
                        onMouseDown={(e) => handleResizeStart(e, field.name)}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!field) return;
                          // Auto-fit: measure max content width
                          const contentLengths = sortedRows.slice(0, 100).map(r => {
                            if (!r) return 4;
                            const v = r[field.name];
                            if (v === null || v === undefined) return 4;
                            if (typeof v === 'object') return JSON.stringify(v).length;
                            return String(v).length;
                          });
                          const maxLen = Math.max(field.name.length, ...contentLengths);
                          setColumnWidths(prev => ({ ...prev, [field.name]: Math.max(60, Math.min(maxLen * 9 + 24, 500)) }));
                        }}
                        sx={{
                          position: 'absolute',
                          right: -5,
                          top: 0,
                          bottom: 0,
                          width: 10,
                          cursor: 'col-resize',
                          zIndex: 2,
                          // Visible thin line in the center via pseudo-element
                          '&::after': {
                            content: '""',
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            width: '1px',
                            bgcolor: 'grey.300',
                          },
                          '&:hover': {
                            '&::after': {
                              width: '3px',
                              bgcolor: 'primary.main',
                              opacity: 0.7,
                            },
                          },
                        }}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {paginatedRows.map((row, rowIndex) => {
                  const globalRowIndex = page * rowsPerPage + rowIndex;
                  return (
                    <TableRow key={globalRowIndex} hover selected={selectedRows.has(globalRowIndex)}>
                      {canMutate && (
                        <TableCell sx={{ p: 0, width: 36, textAlign: 'center' }}>
                          <Checkbox
                            size="small"
                            checked={selectedRows.has(globalRowIndex)}
                            onChange={() => handleToggleRow(globalRowIndex)}
                            sx={{ p: 0.25, '& .MuiSvgIcon-root': { fontSize: 16 } }}
                          />
                        </TableCell>
                      )}
                      {orderedFields.map((field, colIndex) => {
                        const isEditing = editingCell?.rowIndex === globalRowIndex && editingCell?.fieldName === field.name;
                        const pendingKey = `${globalRowIndex}:${field.name}`;
                        const isPending = pendingEdits.has(pendingKey);
                        return (
                          <TableCell
                            key={`${field.name}-${colIndex}`}
                            onDoubleClick={() => handleCellDoubleClick(globalRowIndex, field.name, row[field.name])}
                            sx={{
                              py: 0.5,
                              fontSize: '0.875rem',
                              width: columnWidths[field.name] || 150,
                              minWidth: 60,
                              maxWidth: columnWidths[field.name] || 300,
                              overflow: 'hidden',
                              ...(isPending && { bgcolor: 'rgba(99, 102, 241, 0.08)', outline: '1px solid rgba(99, 102, 241, 0.3)' }),
                            }}
                          >
                            {isEditing ? (
                              <TextField
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleEditSave();
                                  if (e.key === 'Escape') handleEditCancel();
                                }}
                                onBlur={handleEditSave}
                                size="small"
                                autoFocus
                                variant="standard"
                                sx={{ width: '100%', '& input': { fontSize: '0.875rem', py: 0 } }}
                              />
                            ) : (
                              <Tooltip title={isPending ? pendingEdits.get(pendingKey)!.newValue : formatValue(row[field.name])} placement="top">
                                <Box sx={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  maxWidth: '100%',
                                  cursor: canMutate ? 'text' : 'pointer',
                                  color: isPending ? 'primary.main' : (row[field.name] === null || row[field.name] === undefined) ? 'text.disabled' : 'inherit',
                                  fontStyle: (row[field.name] === null || row[field.name] === undefined) && !isPending ? 'italic' : 'normal',
                                  '&:hover': { color: 'primary.main' },
                                }}>
                                  {isPending ? pendingEdits.get(pendingKey)!.newValue || 'NULL' : formatValue(row[field.name])}
                                </Box>
                              </Tooltip>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
                {/* Add row form */}
                {isAddingRow && (
                  <TableRow>
                    {canMutate && (
                      <TableCell sx={{ p: 0, width: 36, textAlign: 'center' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                          <IconButton size="small" onClick={handleAddRowSave} color="success" sx={{ p: 0.25 }}>
                            <CheckIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                          <IconButton size="small" onClick={handleAddRowCancel} sx={{ p: 0.25 }}>
                            <CloseIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Box>
                      </TableCell>
                    )}
                    {orderedFields.map((field) => (
                      <TableCell key={`new-${field.name}`} sx={{ py: 0.5 }}>
                        <TextField
                          value={newRowValues[field.name] || ''}
                          onChange={(e) => setNewRowValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                          placeholder={field.dataTypeName}
                          size="small"
                          variant="standard"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddRowSave();
                            if (e.key === 'Escape') handleAddRowCancel();
                          }}
                          sx={{ width: '100%', '& input': { fontSize: '0.8125rem', py: 0 } }}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>

          <TablePagination
            rowsPerPageOptions={[10, 25, 50, 100]}
            component="div"
            count={result.rows.length}
            rowsPerPage={rowsPerPage}
            page={page}
            onPageChange={handleChangePage}
            onRowsPerPageChange={handleChangeRowsPerPage}
            labelRowsPerPage={t('results.rowsPerPage')}
            labelDisplayedRows={({ from, to, count }) =>
              t('results.displayedRows', { from: String(from), to: String(to), count: String(count !== -1 ? count : `>${to}`) })
            }
            data-testid="query-results-pagination"
            sx={{ borderTop: 1, borderColor: 'divider' }}
          />
        </>
      )}

      {result.rows.length === 0 && result.message !== 'Query executed successfully' && (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          {result.message.startsWith('Error:') ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
              <Typography variant="body2" color="error.main" sx={{ fontFamily: 'monospace', fontSize: '0.8125rem', whiteSpace: 'pre-wrap', textAlign: 'left', maxWidth: '100%', wordBreak: 'break-word' }}>
                {result.message}
              </Typography>
              {onFixInChat && executedQuery && (
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<FixIcon />}
                  onClick={() => onFixInChat(executedQuery, result.message)}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.75rem',
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' },
                  }}
                >
                  Fix in Chat
                </Button>
              )}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No results to display
            </Typography>
          )}
        </Box>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirm} onClose={() => setDeleteConfirm(false)} maxWidth="xs">
        <DialogTitle>{t('results.deleteConfirmTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('results.deleteConfirmText')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirm(false)}>{t('results.cancel')}</Button>
          <Button onClick={handleDeleteSelected} color="error" variant="contained">
            {t("results.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
