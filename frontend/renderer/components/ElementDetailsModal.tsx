import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  Divider,
  IconButton,
  Tooltip,
  CircularProgress,
  TextField,
  MenuItem,
  Checkbox,
  FormControlLabel,
} from '@mui/material';
import { createLogger } from '../utils/logger';
import { useAgent } from '../contexts/AgentContext';
import { getDescription, setDescription as saveDescription, getDescriptionsForContext } from '../utils/descriptionStorage';

const log = createLogger('ElementDetailsModal');

import {
  Close as CloseIcon,
  Info as InfoIcon,
  Key as KeyIcon,
  Speed as SpeedIcon,
  Security as SecurityIcon,
  FlashOn as FlashIcon,
  ViewColumn as ColumnIcon,
  ContentCopy as CopyIcon,
  AutoAwesome as ExplainIcon,
  Description as DescriptionIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
} from '@mui/icons-material';

interface ElementDetailsModalProps {
  open: boolean;
  onClose: () => void;
  element: any;
  elementType: 'table' | 'column' | 'index' | 'constraint' | 'trigger' | 'function' | 'procedure' | 'view' | 'sequence' | 'extension' | 'type';
  onApplySQL?: (sql: string) => void;
}

// Common PostgreSQL data types for the Add/Alter Column forms
const PG_DATA_TYPES = [
  'integer', 'bigint', 'smallint', 'serial', 'bigserial',
  'text', 'varchar', 'char',
  'boolean',
  'numeric', 'real', 'double precision',
  'date', 'timestamp', 'timestamptz', 'time', 'timetz',
  'uuid', 'jsonb', 'json',
  'bytea', 'inet', 'cidr', 'macaddr',
  'interval', 'money',
  'int[]', 'text[]', 'jsonb[]',
];

function escapeIdent(name: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

export default function ElementDetailsModal({
  open,
  onClose,
  element,
  elementType,
  onApplySQL,
}: ElementDetailsModalProps) {
  const agent = useAgent();
  const [explanation, setExplanation] = useState('');
  const [isExplaining, setIsExplaining] = useState(false);
  const explanationRef = useRef('');
  const [userDescription, setUserDescription] = useState('');
  const [descriptionSaved, setDescriptionSaved] = useState(false);
  const [columnDescriptions, setColumnDescriptions] = useState<Record<string, string>>({});
  const [editingColName, setEditingColName] = useState<string | null>(null);
  const [editingColDescValue, setEditingColDescValue] = useState('');

  // Add Column form state
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState('text');
  const [newColNullable, setNewColNullable] = useState(true);
  const [newColDefault, setNewColDefault] = useState('');

  // Drop Column confirmation state
  const [dropColTarget, setDropColTarget] = useState<string | null>(null);

  // Alter Column inline edit state
  const [alteringCol, setAlteringCol] = useState<string | null>(null);
  const [alterColType, setAlterColType] = useState('');
  const [alterColNullable, setAlterColNullable] = useState(true);

  const supportsExplain = ['table', 'function', 'procedure', 'view'].includes(elementType);

  const getObjectSchema = useCallback((): string => {
    if (!element) return 'public';
    return element.table_schema || element.routine_schema || element.procedure_schema || element.view_schema || 'public';
  }, [element]);

  const getObjectName = useCallback((): string => {
    if (!element) return '';
    return element.table_name || element.routine_name || element.procedure_name || element.view_name ||
           element.column_name || element.index_name || element.constraint_name || element.trigger_name ||
           element.sequence_name || element.name || '';
  }, [element]);

  // Load description when element changes; reset explanation
  useEffect(() => {
    setExplanation('');
    setIsExplaining(false);
    explanationRef.current = '';
    setDescriptionSaved(false);
    setEditingColName(null);
    setShowAddColumn(false);
    setDropColTarget(null);
    setAlteringCol(null);
    if (element) {
      const schema = element.table_schema || element.routine_schema || element.procedure_schema || element.view_schema || 'public';
      const name = element.table_name || element.routine_name || element.procedure_name || element.view_name ||
                   element.column_name || element.index_name || element.constraint_name || element.trigger_name ||
                   element.sequence_name || element.name || '';
      if (name) {
        setUserDescription(getDescription(elementType, schema, name));
      } else {
        setUserDescription('');
      }
      // Load column descriptions for table view
      if (elementType === 'table' && element.columns) {
        const descs: Record<string, string> = {};
        for (const col of element.columns) {
          const desc = getDescription('column', schema, col.column_name);
          if (desc) descs[col.column_name] = desc;
        }
        setColumnDescriptions(descs);
      } else {
        setColumnDescriptions({});
      }
    } else {
      setUserDescription('');
      setColumnDescriptions({});
    }
  }, [element, elementType]);

  const handleSaveDescription = useCallback(() => {
    const schema = getObjectSchema();
    const name = getObjectName();
    if (!name) return;
    saveDescription(elementType, schema, name, userDescription);
    setDescriptionSaved(true);
    setTimeout(() => setDescriptionSaved(false), 2000);
  }, [elementType, getObjectSchema, getObjectName, userDescription]);

  const handleSaveColumnDescription = useCallback((columnName: string, value: string) => {
    const schema = getObjectSchema();
    saveDescription('column', schema, columnName, value);
    setColumnDescriptions(prev => {
      const next = { ...prev };
      if (value.trim()) {
        next[columnName] = value.trim();
      } else {
        delete next[columnName];
      }
      return next;
    });
    setEditingColName(null);
  }, [getObjectSchema]);

  const getFullTableName = useCallback((): string => {
    if (!element) return '';
    const schema = getObjectSchema();
    const table = element.table_name || '';
    return schema !== 'public'
      ? `${escapeIdent(schema)}.${escapeIdent(table)}`
      : escapeIdent(table);
  }, [element, getObjectSchema]);

  const handleAddColumn = useCallback(() => {
    if (!newColName.trim() || !element) return;
    const tableName = getFullTableName();
    let sql = `ALTER TABLE ${tableName} ADD COLUMN ${escapeIdent(newColName.trim())} ${newColType}`;
    if (!newColNullable) sql += ' NOT NULL';
    if (newColDefault.trim()) sql += ` DEFAULT ${newColDefault.trim()}`;
    sql += ';';
    onApplySQL?.(sql);
    setShowAddColumn(false);
    setNewColName('');
    setNewColType('text');
    setNewColNullable(true);
    setNewColDefault('');
  }, [element, newColName, newColType, newColNullable, newColDefault, getFullTableName, onApplySQL]);

  const handleDropColumn = useCallback((columnName: string) => {
    if (!element) return;
    const tableName = getFullTableName();
    const sql = `ALTER TABLE ${tableName} DROP COLUMN ${escapeIdent(columnName)};`;
    onApplySQL?.(sql);
    setDropColTarget(null);
  }, [element, getFullTableName, onApplySQL]);

  const handleAlterColumn = useCallback((columnName: string, originalType: string, originalNullable: string) => {
    if (!element) return;
    const tableName = getFullTableName();
    const statements: string[] = [];
    if (alterColType && alterColType !== originalType) {
      statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${escapeIdent(columnName)} TYPE ${alterColType};`);
    }
    const wasNullable = originalNullable === 'YES';
    if (alterColNullable !== wasNullable) {
      if (alterColNullable) {
        statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${escapeIdent(columnName)} DROP NOT NULL;`);
      } else {
        statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${escapeIdent(columnName)} SET NOT NULL;`);
      }
    }
    if (statements.length > 0) {
      onApplySQL?.(statements.join('\n'));
    }
    setAlteringCol(null);
  }, [element, alterColType, alterColNullable, getFullTableName, onApplySQL]);

  const getObjectDefinition = useCallback((): string => {
    if (!element) return '';
    switch (elementType) {
      case 'table': {
        const cols = (element.columns || [])
          .map((c: any) => `  ${c.column_name} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}${c.column_default ? ` DEFAULT ${c.column_default}` : ''}`)
          .join(',\n');
        const indexes = (element.indexes || [])
          .map((i: any) => `-- INDEX: ${i.index_name}${i.is_unique ? ' (UNIQUE)' : ''}`)
          .join('\n');
        const constraints = (element.constraints || [])
          .map((c: any) => `-- CONSTRAINT: ${c.constraint_name} (${c.constraint_type}) on ${c.column_name || 'N/A'}`)
          .join('\n');
        return `-- Table: ${element.table_schema || 'public'}.${element.table_name}\nCREATE TABLE ${element.table_name} (\n${cols}\n);\n${indexes}\n${constraints}`.trim();
      }
      case 'function':
        return element.routine_definition || `-- Function: ${element.routine_name}`;
      case 'procedure':
        return element.procedure_definition || `-- Procedure: ${element.procedure_name}`;
      case 'view':
        return element.view_definition || `-- View: ${element.view_name}`;
      default:
        return '';
    }
  }, [element, elementType]);

  const handleExplain = useCallback(() => {
    if (!agent.isConnected || isExplaining) return;
    const definition = getObjectDefinition();
    if (!definition) return;

    setIsExplaining(true);
    setExplanation('');
    explanationRef.current = '';

    const userDescs = getDescriptionsForContext();
    agent.sendRequest(
      { action: 'explain_sql', context: { selected_sql: definition, ...(userDescs ? { user_descriptions: userDescs } : {}) } },
      {
        onStream: (delta: string) => {
          explanationRef.current += delta;
          setExplanation(explanationRef.current);
        },
        onResponse: (response) => {
          setIsExplaining(false);
          if (response.result.explanation) {
            setExplanation(response.result.explanation);
          }
        },
        onError: (err) => {
          setIsExplaining(false);
          setExplanation(`Error: ${err.message}`);
          log.error('Explain failed:', err);
        },
      },
    );
  }, [agent, isExplaining, getObjectDefinition]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // Можно добавить уведомление об успешном копировании
    } catch (err) {
      log.error('Failed to copy text:', err);
    }
  };
  const getConstraintTypeLabel = (constraintType: string) => {
    switch (constraintType?.toLowerCase()) {
      case 'p':
      case 'primary key':
        return 'Primary Key';
      case 'f':
      case 'foreign key':
        return 'Foreign Key';
      case 'u':
      case 'unique':
        return 'Unique';
      case 'c':
      case 'check':
        return 'Check';
      case 'n':
      case 'not null':
        return 'Not Null';
      case 'd':
      case 'default':
        return 'Default';
      default:
        return constraintType || 'Unknown';
    }
  };

  const getElementIcon = (type: string) => {
    switch (type) {
      case 'table':
        return <InfoIcon color="primary" />;
      case 'column':
        return <ColumnIcon color="info" />;
      case 'index':
        return <SpeedIcon color="warning" />;
      case 'constraint':
        return <SecurityIcon color="error" />;
      case 'trigger':
        return <FlashIcon color="secondary" />;
      case 'function':
      case 'procedure':
        return <KeyIcon color="primary" />;
      default:
        return <InfoIcon color="primary" />;
    }
  };

  const getElementTitle = () => {
    if (!element) return '';
    
    switch (elementType) {
      case 'table':
        return `Table: ${element.table_name}`;
      case 'column':
        return `Column: ${element.column_name}`;
      case 'index':
        return `Index: ${element.index_name}`;
      case 'constraint':
        return `Constraint: ${element.constraint_name}`;
      case 'trigger':
        return `Trigger: ${element.trigger_name}`;
      case 'function':
        return `Function: ${element.routine_name}`;
      case 'procedure':
        return `Procedure: ${element.procedure_name}`;
      case 'view':
        return `View: ${element.view_name}`;
      case 'sequence':
        return `Sequence: ${element.sequence_name}`;
      case 'extension':
        return `Extension: ${element.name}`;
      case 'type':
        return `Type: ${element.name}`;
      default:
        return 'Element Details';
    }
  };

  const renderTableDetails = () => {
    if (elementType !== 'table' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          Table Information
        </Typography>
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Table Name</TableCell>
                <TableCell>{element.table_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Schema</TableCell>
                <TableCell>{element.table_schema}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Type</TableCell>
                <TableCell>
                  <Chip label={element.table_type} size="small" variant="outlined" sx={{ color: 'text.secondary', borderColor: 'divider' }} />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>

        {element.columns && element.columns.length > 0 && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary' }}>
                Columns ({element.columns.length})
              </Typography>
              {onApplySQL && (
                <Tooltip title="Add Column">
                  <IconButton size="small" onClick={() => { setShowAddColumn(true); setAlteringCol(null); }}>
                    <AddIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Box>

            {/* Add Column Form */}
            {showAddColumn && onApplySQL && (
              <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                <Typography variant="body2" sx={{ fontWeight: 500, mb: 1.5 }}>Add Column</Typography>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <TextField
                    autoFocus
                    size="small"
                    label="Name"
                    value={newColName}
                    onChange={(e) => setNewColName(e.target.value)}
                    sx={{ minWidth: 140 }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddColumn(); if (e.key === 'Escape') setShowAddColumn(false); }}
                  />
                  <TextField
                    select
                    size="small"
                    label="Type"
                    value={newColType}
                    onChange={(e) => setNewColType(e.target.value)}
                    sx={{ minWidth: 150 }}
                  >
                    {PG_DATA_TYPES.map((t) => (
                      <MenuItem key={t} value={t}>{t}</MenuItem>
                    ))}
                  </TextField>
                  <FormControlLabel
                    control={<Checkbox size="small" checked={newColNullable} onChange={(e) => setNewColNullable(e.target.checked)} />}
                    label={<Typography variant="body2">Nullable</Typography>}
                  />
                  <TextField
                    size="small"
                    label="Default"
                    value={newColDefault}
                    onChange={(e) => setNewColDefault(e.target.value)}
                    sx={{ minWidth: 120 }}
                    placeholder="e.g. 0, 'text', now()"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddColumn(); if (e.key === 'Escape') setShowAddColumn(false); }}
                  />
                </Box>
                <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
                  <Button size="small" variant="contained" disabled={!newColName.trim()} onClick={handleAddColumn}>
                    Generate SQL
                  </Button>
                  <Button size="small" onClick={() => setShowAddColumn(false)}>Cancel</Button>
                </Box>
              </Paper>
            )}

            <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Name</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Type</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Nullable</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Default</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Description</TableCell>
                    {onApplySQL && (
                      <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem', width: 80 }}>Actions</TableCell>
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {element.columns.map((column: any, index: number) => (
                    <TableRow key={index}>
                      <TableCell>{column.column_name}</TableCell>
                      <TableCell>
                        {alteringCol === column.column_name ? (
                          <TextField
                            select
                            size="small"
                            variant="standard"
                            value={alterColType}
                            onChange={(e) => setAlterColType(e.target.value)}
                            sx={{ minWidth: 120, '& .MuiInput-input': { fontSize: '0.8125rem' } }}
                          >
                            {PG_DATA_TYPES.map((t) => (
                              <MenuItem key={t} value={t}>{t}</MenuItem>
                            ))}
                          </TextField>
                        ) : (
                          column.data_type
                        )}
                      </TableCell>
                      <TableCell>
                        {alteringCol === column.column_name ? (
                          <FormControlLabel
                            control={<Checkbox size="small" checked={alterColNullable} onChange={(e) => setAlterColNullable(e.target.checked)} />}
                            label={<Typography variant="body2" sx={{ fontSize: '0.7rem' }}>{alterColNullable ? 'Nullable' : 'NOT NULL'}</Typography>}
                          />
                        ) : (
                          <Chip
                            label={column.is_nullable === 'YES' ? 'Nullable' : 'NOT NULL'}
                            size="small"
                            variant="outlined"
                            sx={{
                              color: 'text.secondary',
                              borderColor: 'divider',
                              fontSize: '0.7rem',
                              height: 22,
                            }}
                          />
                        )}
                      </TableCell>
                      <TableCell>{column.column_default || '-'}</TableCell>
                      <TableCell
                        sx={{ cursor: 'pointer', minWidth: 150, maxWidth: 300 }}
                        onClick={() => {
                          if (editingColName !== column.column_name) {
                            setEditingColName(column.column_name);
                            setEditingColDescValue(columnDescriptions[column.column_name] || '');
                          }
                        }}
                      >
                        {editingColName === column.column_name ? (
                          <TextField
                            autoFocus
                            size="small"
                            variant="standard"
                            fullWidth
                            placeholder="Add description..."
                            value={editingColDescValue}
                            onChange={(e) => setEditingColDescValue(e.target.value)}
                            onBlur={() => handleSaveColumnDescription(column.column_name, editingColDescValue)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleSaveColumnDescription(column.column_name, editingColDescValue);
                              } else if (e.key === 'Escape') {
                                setEditingColName(null);
                              }
                            }}
                            sx={{ '& .MuiInput-input': { fontSize: '0.8125rem', py: 0 } }}
                          />
                        ) : (
                          <Typography
                            variant="body2"
                            sx={{
                              color: columnDescriptions[column.column_name] ? 'text.primary' : 'text.disabled',
                              fontSize: '0.8125rem',
                              fontStyle: columnDescriptions[column.column_name] ? 'normal' : 'italic',
                            }}
                          >
                            {columnDescriptions[column.column_name] || 'Click to add...'}
                          </Typography>
                        )}
                      </TableCell>
                      {onApplySQL && (
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          {alteringCol === column.column_name ? (
                            <Box sx={{ display: 'flex', gap: 0.5 }}>
                              <Tooltip title="Apply changes">
                                <IconButton size="small" color="primary" onClick={() => handleAlterColumn(column.column_name, column.data_type, column.is_nullable)}>
                                  <EditIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Cancel">
                                <IconButton size="small" onClick={() => setAlteringCol(null)}>
                                  <CloseIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </Box>
                          ) : (
                            <Box sx={{ display: 'flex', gap: 0.5 }}>
                              <Tooltip title="Alter Column">
                                <IconButton size="small" onClick={() => {
                                  setAlteringCol(column.column_name);
                                  setAlterColType(column.data_type);
                                  setAlterColNullable(column.is_nullable === 'YES');
                                }}>
                                  <EditIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Drop Column">
                                <IconButton size="small" onClick={() => setDropColTarget(column.column_name)}>
                                  <DeleteIcon fontSize="small" color="error" />
                                </IconButton>
                              </Tooltip>
                            </Box>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            {/* Drop Column Confirmation Dialog */}
            <Dialog open={dropColTarget !== null} onClose={() => setDropColTarget(null)} maxWidth="xs">
              <DialogTitle>Drop Column</DialogTitle>
              <DialogContent>
                <Typography>
                  Are you sure you want to generate SQL to drop column <strong>{dropColTarget}</strong>? This will insert the ALTER TABLE DROP COLUMN statement into the editor.
                </Typography>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setDropColTarget(null)}>Cancel</Button>
                <Button color="error" variant="contained" onClick={() => dropColTarget && handleDropColumn(dropColTarget)}>
                  Generate DROP SQL
                </Button>
              </DialogActions>
            </Dialog>
          </Box>
        )}

        {element.indexes && element.indexes.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
              Indexes ({element.indexes.length})
            </Typography>
            <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Name</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Type</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Unique</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {element.indexes.map((index: any, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell>{index.index_name}</TableCell>
                      <TableCell>{index.index_type || 'BTREE'}</TableCell>
                      <TableCell>
                        <Chip
                          label={index.is_unique ? 'Unique' : 'Non-unique'}
                          size="small"
                          variant="outlined"
                          sx={{
                            color: 'text.secondary',
                            borderColor: 'divider',
                            fontSize: '0.7rem',
                            height: 22,
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {element.constraints && element.constraints.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
              Constraints ({element.constraints.length})
            </Typography>
            <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Name</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Type</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Columns</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {element.constraints.map((constraint: any, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell>{constraint.constraint_name}</TableCell>
                      <TableCell>
                        <Chip
                          label={getConstraintTypeLabel(constraint.constraint_type)}
                          size="small"
                          variant="outlined"
                          sx={{
                            color: 'text.secondary',
                            borderColor: 'divider',
                            fontSize: '0.7rem',
                            height: 22,
                          }}
                        />
                      </TableCell>
                      <TableCell>{constraint.column_name || '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {element.triggers && element.triggers.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
              Triggers ({element.triggers.length})
            </Typography>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Name</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Event</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Timing</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {element.triggers.map((trigger: any, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell>{trigger.trigger_name}</TableCell>
                      <TableCell>{trigger.event_manipulation}</TableCell>
                      <TableCell>{trigger.action_timing}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}
      </Box>
    );
  };

  const renderColumnDetails = () => {
    if (elementType !== 'column' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          Column Information
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Column Name</TableCell>
                <TableCell>{element.column_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Data Type</TableCell>
                <TableCell>{element.data_type}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Nullable</TableCell>
                <TableCell>
                  <Chip
                    label={element.is_nullable === 'YES' ? 'Nullable' : 'NOT NULL'}
                    size="small"
                    variant="outlined"
                    sx={{
                      color: 'text.secondary',
                      borderColor: 'divider',
                      fontSize: '0.7rem',
                      height: 22,
                    }}
                  />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Default Value</TableCell>
                <TableCell>{element.column_default || 'None'}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Character Maximum Length</TableCell>
                <TableCell>{element.character_maximum_length || '-'}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Numeric Precision</TableCell>
                <TableCell>{element.numeric_precision || '-'}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Numeric Scale</TableCell>
                <TableCell>{element.numeric_scale || '-'}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  const renderIndexDetails = () => {
    if (elementType !== 'index' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          Index Information
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Index Name</TableCell>
                <TableCell>{element.index_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Type</TableCell>
                <TableCell>{element.index_type || 'BTREE'}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Unique</TableCell>
                <TableCell>
                  <Chip
                    label={element.is_unique ? 'Unique' : 'Non-unique'}
                    size="small"
                    variant="outlined"
                    sx={{
                      color: 'text.secondary',
                      borderColor: 'divider',
                      fontSize: '0.7rem',
                      height: 22,
                    }}
                  />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Primary Key</TableCell>
                <TableCell>
                  <Chip
                    label={element.is_primary ? 'Primary' : 'Non-primary'}
                    size="small"
                    variant="outlined"
                    sx={{
                      color: 'text.secondary',
                      borderColor: 'divider',
                      fontSize: '0.7rem',
                      height: 22,
                    }}
                  />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  const renderConstraintDetails = () => {
    if (elementType !== 'constraint' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          Constraint Information
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Constraint Name</TableCell>
                <TableCell>{element.constraint_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Type</TableCell>
                <TableCell>
                  <Chip
                    label={getConstraintTypeLabel(element.constraint_type)}
                    size="small"
                    variant="outlined"
                    sx={{
                      color: 'text.secondary',
                      borderColor: 'divider',
                      fontSize: '0.7rem',
                      height: 22,
                    }}
                  />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Column</TableCell>
                <TableCell>{element.column_name || '-'}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Referenced Table</TableCell>
                <TableCell>{element.referenced_table_name || '-'}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Referenced Column</TableCell>
                <TableCell>{element.referenced_column_name || '-'}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  const renderTriggerDetails = () => {
    if (elementType !== 'trigger' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          Trigger Information
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Trigger Name</TableCell>
                <TableCell>{element.trigger_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Event</TableCell>
                <TableCell>{element.event_manipulation}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Timing</TableCell>
                <TableCell>{element.action_timing}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Table</TableCell>
                <TableCell>{element.event_object_table}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  const renderFunctionDetails = () => {
    if (elementType !== 'function' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          Function Information
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Function Name</TableCell>
                <TableCell>{element.routine_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Return Type</TableCell>
                <TableCell>{element.data_type}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Schema</TableCell>
                <TableCell>{element.routine_schema}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Function Code</TableCell>
                <TableCell>
                  <Box sx={{ position: 'relative' }}>
                    <Box sx={{ 
                      maxHeight: 500, 
                      overflow: 'auto', 
                      bgcolor: 'background.paper',
                      border: '1px solid',
                      borderColor: 'divider',
                      p: 2, 
                      borderRadius: 2,
                      fontFamily: 'monospace',
                      fontSize: '0.875rem',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      '&::-webkit-scrollbar': {
                        width: '8px',
                        height: '8px',
                      },
                      '&::-webkit-scrollbar-track': {
                        bgcolor: 'grey.100',
                        borderRadius: '4px',
                      },
                      '&::-webkit-scrollbar-thumb': {
                        bgcolor: 'grey.400',
                        borderRadius: '4px',
                        '&:hover': {
                          bgcolor: 'grey.500',
                        },
                      },
                    }}>
                      {element.routine_definition || 'No function code available'}
                    </Box>
                    {element.routine_definition && (
                      <Tooltip title="Copy code to clipboard">
                        <IconButton
                          size="small"
                          onClick={() => copyToClipboard(element.routine_definition)}
                          sx={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            bgcolor: 'background.paper',
                            '&:hover': {
                              bgcolor: 'action.hover',
                            }
                          }}
                        >
                          <CopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  const renderViewDetails = () => {
    if (elementType !== 'view' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          View Information
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>View Name</TableCell>
                <TableCell>{element.view_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Schema</TableCell>
                <TableCell>{element.view_schema}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>View Code</TableCell>
                <TableCell>
                  <Box sx={{ position: 'relative' }}>
                    <Box sx={{ 
                      maxHeight: 500, 
                      overflow: 'auto', 
                      bgcolor: 'background.paper',
                      border: '1px solid',
                      borderColor: 'divider',
                      p: 2, 
                      borderRadius: 2,
                      fontFamily: 'monospace',
                      fontSize: '0.875rem',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      '&::-webkit-scrollbar': {
                        width: '8px',
                        height: '8px',
                      },
                      '&::-webkit-scrollbar-track': {
                        bgcolor: 'grey.100',
                        borderRadius: '4px',
                      },
                      '&::-webkit-scrollbar-thumb': {
                        bgcolor: 'grey.400',
                        borderRadius: '4px',
                        '&:hover': {
                          bgcolor: 'grey.500',
                        },
                      },
                    }}>
                      {element.view_definition || 'No view code available'}
                    </Box>
                    {element.view_definition && (
                      <Tooltip title="Copy code to clipboard">
                        <IconButton
                          size="small"
                          onClick={() => copyToClipboard(element.view_definition)}
                          sx={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            bgcolor: 'background.paper',
                            '&:hover': {
                              bgcolor: 'action.hover',
                            }
                          }}
                        >
                          <CopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  const renderProcedureDetails = () => {
    if (elementType !== 'procedure' || !element) return null;

    return (
      <Box>
        <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
          Procedure Information
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Procedure Name</TableCell>
                <TableCell>{element.procedure_name}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Schema</TableCell>
                <TableCell>{element.procedure_schema}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 500, fontSize: '0.8125rem' }}>Procedure Code</TableCell>
                <TableCell>
                  <Box sx={{ position: 'relative' }}>
                    <Box sx={{ 
                      maxHeight: 500, 
                      overflow: 'auto', 
                      bgcolor: 'background.paper',
                      border: '1px solid',
                      borderColor: 'divider',
                      p: 2, 
                      borderRadius: 2,
                      fontFamily: 'monospace',
                      fontSize: '0.875rem',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      '&::-webkit-scrollbar': {
                        width: '8px',
                        height: '8px',
                      },
                      '&::-webkit-scrollbar-track': {
                        bgcolor: 'grey.100',
                        borderRadius: '4px',
                      },
                      '&::-webkit-scrollbar-thumb': {
                        bgcolor: 'grey.400',
                        borderRadius: '4px',
                        '&:hover': {
                          bgcolor: 'grey.500',
                        },
                      },
                    }}>
                      {element.procedure_definition || 'No procedure code available'}
                    </Box>
                    {element.procedure_definition && (
                      <Tooltip title="Copy code to clipboard">
                        <IconButton
                          size="small"
                          onClick={() => copyToClipboard(element.procedure_definition)}
                          sx={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            bgcolor: 'background.paper',
                            '&:hover': {
                              bgcolor: 'action.hover',
                            }
                          }}
                        >
                          <CopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  const renderUserDescription = () => {
    const name = getObjectName();
    if (!name) return null;

    return (
      <Box sx={{ mt: 3 }}>
        <Divider sx={{ mb: 2 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <DescriptionIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary' }}>
            User Description
          </Typography>
        </Box>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          size="small"
          placeholder="Add your description for this object..."
          value={userDescription}
          onChange={(e) => setUserDescription(e.target.value)}
          onBlur={handleSaveDescription}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              handleSaveDescription();
            }
          }}
          sx={{ mb: 1 }}
        />
        <Typography variant="caption" color={descriptionSaved ? 'success.main' : 'text.secondary'}>
          {descriptionSaved ? 'Saved' : 'Saves on blur or Cmd+Enter. Used as AI context.'}
        </Typography>
      </Box>
    );
  };

  const renderExplanation = () => {
    if (!explanation && !isExplaining) return null;

    return (
      <Box sx={{ mt: 3 }}>
        <Divider sx={{ mb: 2 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <ExplainIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary' }}>
            AI Explanation
          </Typography>
          {isExplaining && <CircularProgress size={14} />}
        </Box>
        <Box
          sx={{
            bgcolor: 'action.hover',
            borderRadius: 1,
            p: 2,
            fontFamily: 'inherit',
            fontSize: '0.875rem',
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 400,
            overflow: 'auto',
            '&::-webkit-scrollbar': { width: '6px' },
            '&::-webkit-scrollbar-track': { bgcolor: 'transparent' },
            '&::-webkit-scrollbar-thumb': { bgcolor: 'grey.400', borderRadius: '3px' },
          }}
        >
          {explanation || 'Analyzing...'}
        </Box>
      </Box>
    );
  };

  const renderDetails = () => {
    switch (elementType) {
      case 'table':
        return renderTableDetails();
      case 'column':
        return renderColumnDetails();
      case 'index':
        return renderIndexDetails();
      case 'constraint':
        return renderConstraintDetails();
      case 'trigger':
        return renderTriggerDetails();
      case 'function':
        return renderFunctionDetails();
      case 'view':
        return renderViewDetails();
      case 'procedure':
        return renderProcedureDetails();
      default:
        return (
          <Box>
            <Typography variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1 }}>
              Element Information
            </Typography>
            <Typography color="text.secondary">
              No detailed information available for this element type.
            </Typography>
          </Box>
        );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: { minHeight: '60vh' }
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 1.5, px: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {getElementIcon(elementType)}
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{getElementTitle()}</Typography>
        </Box>
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      
      <Divider />
      
      <DialogContent sx={{ p: 3 }}>
        {renderDetails()}
        {renderUserDescription()}
        {renderExplanation()}
      </DialogContent>

      <Divider />

      <DialogActions>
        {supportsExplain && (
          <Button
            onClick={handleExplain}
            disabled={!agent.isConnected || isExplaining}
            startIcon={isExplaining ? <CircularProgress size={16} /> : <ExplainIcon />}
            variant="outlined"
            color="primary"
            aria-label="Explain object with AI"
          >
            {isExplaining ? 'Explaining...' : 'Explain'}
          </Button>
        )}
        <Button onClick={onClose} variant="outlined">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
