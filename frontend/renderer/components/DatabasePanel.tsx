import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Divider,
  Menu,
  MenuItem,
  ListItemSecondaryAction,
  Collapse,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Avatar,
  Badge,
  CircularProgress,
  Alert,
} from '@mui/material';
import ElementDetailsModal from './ElementDetailsModal';
import SchemaSyncModal from './SchemaSyncModal';
import { createLogger } from '../utils/logger';
import { useTranslation } from '../contexts/LanguageContext';

const log = createLogger('DatabasePanel');
import {
  Add as AddIcon,
  PowerSettingsNew as ConnectIcon,
  PowerSettingsNew as DisconnectIcon,
  MoreVert as MoreIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Refresh as RefreshIcon,
  CheckCircle as ActiveIcon,
  RadioButtonUnchecked as InactiveIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Functions as FunctionIcon,
  Visibility as ViewIcon,
  Schema as SchemaIcon,
  Extension as ExtensionIcon,
  Language as LanguageIcon,
  Category as TypeIcon,
  Timeline as SequenceIcon,
  PlayArrow as ProcedureIcon,
  Cloud as CloudIcon,
  Computer as ServerIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Report as ReportIcon,
  Backup as BackupIcon,
  QueryBuilder as QueryIcon,
  Storage as DatabaseIconNew,
  TableRows as TableIconNew,
  TableView as TablesListIcon,
  GridView as TableIcon,
  ViewColumn as ColumnIcon,
  Speed as IndexIcon,
  Security as ConstraintIcon,
  FlashOn as TriggerIcon,
  Info as InfoIcon,
  TipsAndUpdates as AnalyzeIcon,
  Replay as RetryIcon,
  Code as CodeIcon,
  ContentCopy as CopyIcon,
  CompareArrows as CompareArrowsIcon,
} from '@mui/icons-material';
import { DatabaseServer, AuthUser } from '../types';
import ConnectionForm from './ConnectionForm';

interface DatabasePanelProps {
  connections: DatabaseServer[];
  activeConnection: DatabaseServer | null;
  onAddConnection: (connection: Omit<DatabaseServer, 'id' | 'databases' | 'isActive'>) => void;
  onConnect: (connectionId: string) => void;
  onDisconnect: (connectionId: string) => void;
  onDeleteConnection: (connectionId: string) => void;
  onEditConnection: (connection: DatabaseServer) => void;
  onRefreshConnection: (connectionId: string) => void;
  onSelectTable: (tableName: string) => void;
  onSelectView: (viewName: string) => void;
  onSelectFunction: (functionName: string) => void;
  onSelectProcedure: (procedureName: string) => void;
  onAnalyzeSchema?: () => void;
  onExplainObject?: (objectName: string, objectType: string, definition?: string) => void;
  onQueryTable?: (tableName: string) => void;
  onApplySQL?: (sql: string) => void;
  isRestoringConnections?: boolean;
  connectingId?: string | null;
  connectionErrors?: Record<string, string>;
}

// --- Reusable style constants for IDE-compact tree ---

const accordionSx = {
  boxShadow: 'none',
  '&:before': { display: 'none' },
  backgroundColor: 'transparent',
  '&.MuiPaper-root': { backgroundColor: 'transparent' },
  '&.Mui-expanded': {
    margin: '0',
    '&:before': { opacity: 0 },
  },
  '& .MuiCollapse-root': {
    transition: 'height 250ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
} as const;

const sectionSummarySx = {
  minHeight: '26px !important',
  height: '26px',
  px: 1,
  py: 0,
  borderRadius: 1,
  mx: 0.5,
  transition: 'background-color 0.15s ease',
  '&:hover': { bgcolor: 'action.hover' },
  '& .MuiAccordionSummary-content': {
    my: 0,
    alignItems: 'center',
  },
} as const;

const treeItemSx = {
  py: 0,
  px: 1,
  minHeight: '26px',
  height: '26px',
  borderRadius: 1,
  mx: 0.5,
  transition: 'background-color 0.15s ease',
  '&:hover': { bgcolor: 'action.hover' },
} as const;

const leafItemSx = {
  py: 0,
  px: 1,
  minHeight: '24px',
  height: '24px',
  borderRadius: 1,
  mx: 0.5,
  transition: 'background-color 0.15s ease',
  '&:hover': { bgcolor: 'action.hover' },
} as const;

const TREE_ICON_SIZE = 16;
const LEAF_ICON_SIZE = 14;
const DETAIL_ICON_SIZE = 12;

const sectionHeaderTypography = {
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  color: 'text.secondary',
};

const treeTextProps = { sx: { fontSize: '0.8125rem', lineHeight: 1.3 } };
const leafTextProps = { sx: { fontSize: '0.8125rem', lineHeight: 1.3 } };

const collapseSx = {
  '& .MuiCollapse-wrapper': {
    transition: 'height 250ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
} as const;

// Scrollbar mixin — uses theme-aware colors (inherits from MuiCssBaseline global overrides)
const scrollbarSx = {
  scrollbarWidth: 'thin',
  scrollbarColor: 'rgba(255,255,255,0.15) transparent',
  '&::-webkit-scrollbar': { width: 6 },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.15)', borderRadius: 3, '&:hover': { background: 'rgba(255,255,255,0.25)' } },
} as const;

export default function DatabasePanel({
  connections,
  activeConnection,
  onAddConnection,
  onConnect,
  onDisconnect,
  onDeleteConnection,
  onEditConnection,
  onRefreshConnection,
  onSelectTable,
  onSelectView,
  onSelectFunction,
  onSelectProcedure,
  onAnalyzeSchema,
  onExplainObject,
  onQueryTable,
  onApplySQL,
  isRestoringConnections = false,
  connectingId = null,
  connectionErrors = {},
}: DatabasePanelProps) {
  const { t } = useTranslation();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedConnection, setSelectedConnection] = useState<DatabaseServer | null>(null);
  const [expandedConnections, setExpandedConnections] = useState<Set<string>>(new Set());
  const [expandedDatabases, setExpandedDatabases] = useState<Set<string>>(new Set());
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [expandedTableDetails, setExpandedTableDetails] = useState<Set<string>>(new Set());
  const [expandedSequences, setExpandedSequences] = useState<Set<string>>(new Set());
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [selectedElement, setSelectedElement] = useState<any>(null);
  const [selectedElementType, setSelectedElementType] = useState<string>('');
  const [schemaSyncOpen, setSchemaSyncOpen] = useState(false);

  const handleAddConnection = (connectionData: any) => {
    const newConnection: Omit<DatabaseServer, 'id' | 'databases' | 'isActive'> = {
      ...connectionData,
      isActive: false,
    };
    onAddConnection(newConnection);
    setIsAddDialogOpen(false);
  };

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, connection: DatabaseServer) => {
    setAnchorEl(event.currentTarget);
    setSelectedConnection(connection);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setSelectedConnection(null);
  };

  const handleMenuAction = (action: string) => {
    if (!selectedConnection) return;

    switch (action) {
      case 'connect':
        onConnect(selectedConnection.id);
        break;
      case 'disconnect':
        onDisconnect(selectedConnection.id);
        break;
      case 'edit':
        onEditConnection(selectedConnection);
        break;
      case 'delete':
        onDeleteConnection(selectedConnection.id);
        break;
      case 'refresh':
        onRefreshConnection(selectedConnection.id);
        break;
      case 'create_schema':
        if (onQueryTable) {
          onQueryTable(`CREATE SCHEMA new_schema;\n`);
        }
        break;
    }
    handleMenuClose();
  };

  const toggleConnectionExpansion = (connectionId: string) => {
    const newExpanded = new Set(expandedConnections);
    if (newExpanded.has(connectionId)) {
      newExpanded.delete(connectionId);
    } else {
      newExpanded.add(connectionId);
    }
    setExpandedConnections(newExpanded);
  };

  const toggleDatabaseExpansion = (connectionId: string, dbName: string) => {
    const key = `${connectionId}-${dbName}`;
    const newExpanded = new Set(expandedDatabases);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedDatabases(newExpanded);
  };

  const toggleSchemaExpansion = (connectionId: string, schemaName: string) => {
    const key = `${connectionId}-${schemaName}`;
    const newExpanded = new Set(expandedSchemas);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedSchemas(newExpanded);
  };

  const toggleTableExpansion = (connectionId: string, tableName: string) => {
    const key = `${connectionId}-${tableName}`;
    const newExpanded = new Set(expandedTables);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedTables(newExpanded);
  };

  const toggleSectionExpansion = (connectionId: string, sectionName: string) => {
    const key = `${connectionId}-${sectionName}`;
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedSections(newExpanded);
  };

  const toggleTableDetailsExpansion = (connectionId: string, tableKey: string) => {
    const key = `${connectionId}-${tableKey}`;
    const newExpanded = new Set(expandedTableDetails);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedTableDetails(newExpanded);
  };

  const toggleSequenceExpansion = (connectionId: string, sequenceKey: string) => {
    const key = `${connectionId}-${sequenceKey}`;
    const newExpanded = new Set(expandedSequences);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedSequences(newExpanded);
  };

  const toggleTypeExpansion = (connectionId: string, typeKey: string) => {
    const key = `${connectionId}-${typeKey}`;
    const newExpanded = new Set(expandedTypes);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedTypes(newExpanded);
  };

  const handleShowDetails = (element: any, elementType: string) => {
    log.debug('Showing details for element:', {
      elementType,
      has_routine_definition: !!element.routine_definition,
      has_procedure_definition: !!element.procedure_definition,
      has_view_definition: !!element.view_definition
    });
    setSelectedElement(element);
    setSelectedElementType(elementType);
    setDetailsModalOpen(true);
  };

  const handleCloseDetails = () => {
    setDetailsModalOpen(false);
    setSelectedElement(null);
    setSelectedElementType('');
  };

  // --- Object context menu state ---
  const [objectMenuPosition, setObjectMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [contextMenuObject, setContextMenuObject] = useState<{ element: any; type: string; schemaName?: string } | null>(null);
  const objectMenuPaperRef = useRef<HTMLDivElement | null>(null);

  const handleObjectContextMenu = (e: React.MouseEvent, element: any, type: string, schemaName?: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Directly set new position and context — React batches these so menu repositions seamlessly
    setObjectMenuPosition({ top: e.clientY, left: e.clientX });
    setContextMenuObject({ element, type, schemaName });
  };

  const handleObjectMenuClose = () => {
    setObjectMenuPosition(null);
    setContextMenuObject(null);
  };

  // Close object context menu on outside left-click only (button === 0).
  // Right-clicks pass through the pointer-events-disabled backdrop and are handled
  // by onContextMenu handlers on tree items, which reposition the menu.
  useEffect(() => {
    if (!objectMenuPosition) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only close on left-click
      const paper = objectMenuPaperRef.current;
      if (paper && paper.contains(e.target as Node)) return;
      handleObjectMenuClose();
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [objectMenuPosition]);

  const getObjectName = (obj: any, type: string): string => {
    switch (type) {
      case 'table': return obj.table_name;
      case 'view': return obj.view_name;
      case 'function': return obj.routine_name;
      case 'procedure': return obj.procedure_name;
      case 'schema': return obj.schema_name;
      case 'sequence': return obj.sequence_name;
      case 'extension': return obj.name;
      case 'type': return obj.name;
      case 'column': return obj.column_name;
      case 'index': return obj.index_name;
      case 'constraint': return obj.constraint_name;
      case 'trigger': return obj.trigger_name;
      default: return obj.name || '';
    }
  };

  const getObjectDefinition = (obj: any, type: string): string | undefined => {
    switch (type) {
      case 'view': return obj.view_definition;
      case 'function': return obj.routine_definition;
      case 'procedure': return obj.procedure_definition;
      default: return undefined;
    }
  };

  const handleObjectMenuAction = (action: string) => {
    if (!contextMenuObject) return;
    const { element, type, schemaName } = contextMenuObject;
    const name = getObjectName(element, type);
    const qualifiedName = schemaName ? `${schemaName}.${name}` : name;

    switch (action) {
      case 'view_info':
        handleShowDetails(element, type);
        break;
      case 'query_tool':
        if (onQueryTable) {
          onQueryTable(qualifiedName);
        } else {
          onSelectTable(qualifiedName);
        }
        break;
      case 'insert_name':
        switch (type) {
          case 'table': onSelectTable(name); break;
          case 'view': onSelectView(name); break;
          case 'function': onSelectFunction(name); break;
          case 'procedure': onSelectProcedure(name); break;
        }
        break;
      case 'view_source': {
        const definition = getObjectDefinition(element, type);
        if (definition) {
          handleShowDetails(element, type);
        }
        break;
      }
      case 'explain_ai':
        if (onExplainObject) {
          const definition = getObjectDefinition(element, type);
          onExplainObject(name, type, definition);
        }
        break;
      case 'refresh':
        if (activeConnection) {
          onRefreshConnection(activeConnection.id);
        }
        break;
      case 'copy_name':
        navigator.clipboard.writeText(qualifiedName);
        break;
      case 'create_schema':
        if (onQueryTable) {
          onQueryTable(`CREATE SCHEMA new_schema;\n`);
        }
        break;
      case 'create_table': {
        const s = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(
            `CREATE TABLE ${"${s}"}.new_table (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT NOW()\n);\n`
          );
        }
        break;
      }
      case 'create_view': {
        const sv = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(
            `CREATE VIEW "${sv}".new_view AS\nSELECT * FROM "${sv}".table_name;\n`
          );
        }
        break;
      }
      case 'create_function': {
        const sf = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(
            `CREATE OR REPLACE FUNCTION "${sf}".new_function()\nRETURNS void AS $$\nBEGIN\n  -- function body\nEND;\n$$ LANGUAGE plpgsql;\n`
          );
        }
        break;
      }
      case 'create_sequence': {
        const ss = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`CREATE SEQUENCE "${ss}".new_sequence\n  INCREMENT 1\n  START 1\n  MINVALUE 1\n  NO MAXVALUE\n  CACHE 1;\n`);
        }
        break;
      }
      case 'create_type': {
        const st = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`CREATE TYPE "${st}".new_type AS (\n  field1 TEXT,\n  field2 INTEGER\n);\n`);
        }
        break;
      }
      case 'create_extension':
        if (onQueryTable) {
          onQueryTable(`CREATE EXTENSION IF NOT EXISTS "extension_name";\n`);
        }
        break;
      case 'select_top':
        if (onQueryTable) {
          onQueryTable(`"${schemaName || 'public'}"."${name}"`);
        }
        break;
      case 'drop_table':
        if (onQueryTable) {
          onQueryTable(`DROP TABLE IF EXISTS "${schemaName || 'public'}"."${name}" CASCADE;\n`);
        }
        break;
      case 'drop_view':
        if (onQueryTable) {
          onQueryTable(`DROP VIEW IF EXISTS "${schemaName || 'public'}"."${name}" CASCADE;\n`);
        }
        break;
      case 'drop_function':
        if (onQueryTable) {
          onQueryTable(`DROP FUNCTION IF EXISTS "${schemaName || 'public'}"."${name}";\n`);
        }
        break;
      case 'drop_procedure':
        if (onQueryTable) {
          onQueryTable(`DROP PROCEDURE IF EXISTS "${schemaName || 'public'}"."${name}";\n`);
        }
        break;
      case 'drop_schema':
        if (onQueryTable) {
          onQueryTable(`DROP SCHEMA IF EXISTS "${name}" CASCADE;\n`);
        }
        break;
      case 'drop_sequence':
        if (onQueryTable) {
          onQueryTable(`DROP SEQUENCE IF EXISTS "${schemaName || 'public'}"."${name}";\n`);
        }
        break;
      case 'drop_extension':
        if (onQueryTable) {
          onQueryTable(`DROP EXTENSION IF EXISTS "${name}";\n`);
        }
        break;
      case 'drop_type':
        if (onQueryTable) {
          onQueryTable(`DROP TYPE IF EXISTS "${schemaName || 'public'}"."${name}";\n`);
        }
        break;
      case 'alter_table': {
        const sa = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`ALTER TABLE "${sa}"."${name}"\n  ADD COLUMN new_column VARCHAR(255);\n`);
        }
        break;
      }
      case 'add_column': {
        const tableName = element._tableName || '';
        const sc = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`ALTER TABLE "${sc}"."${tableName}"\n  ADD COLUMN new_column VARCHAR(255);\n`);
        }
        break;
      }
      case 'drop_column': {
        const colTableName = element._tableName || '';
        const sc2 = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`ALTER TABLE "${sc2}"."${colTableName}"\n  DROP COLUMN "${name}";\n`);
        }
        break;
      }
      case 'alter_column': {
        const altTableName = element._tableName || '';
        const sc3 = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`ALTER TABLE "${sc3}"."${altTableName}"\n  ALTER COLUMN "${name}" TYPE VARCHAR(255);\n`);
        }
        break;
      }
      case 'create_index': {
        const idxTableName = element._tableName || 'table_name';
        const sc4 = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`CREATE INDEX idx_name\n  ON "${sc4}"."${idxTableName}" (column_name);\n`);
        }
        break;
      }
      case 'drop_index': {
        if (onQueryTable) {
          onQueryTable(`DROP INDEX IF EXISTS "${name}";\n`);
        }
        break;
      }
      case 'add_constraint': {
        const conTableName = element._tableName || 'table_name';
        const sc5 = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`ALTER TABLE "${sc5}"."${conTableName}"\n  ADD CONSTRAINT constraint_name CHECK (column_name IS NOT NULL);\n`);
        }
        break;
      }
      case 'drop_constraint': {
        const conDropTable = element._tableName || '';
        const sc6 = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`ALTER TABLE "${sc6}"."${conDropTable}"\n  DROP CONSTRAINT "${name}";\n`);
        }
        break;
      }
      case 'create_trigger': {
        const trigTableName = element._tableName || 'table_name';
        const sc7 = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`CREATE TRIGGER trigger_name\n  BEFORE INSERT ON "${sc7}"."${trigTableName}"\n  FOR EACH ROW\n  EXECUTE FUNCTION function_name();\n`);
        }
        break;
      }
      case 'drop_trigger': {
        const trigDropTable = element._tableName || '';
        const sc8 = schemaName || 'public';
        if (onQueryTable) {
          onQueryTable(`DROP TRIGGER IF EXISTS "${name}" ON "${sc8}"."${trigDropTable}";\n`);
        }
        break;
      }
    }
    handleObjectMenuClose();
  };

  const getEntityIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case 'table':
        return <TableIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'info.main' }} />;
      case 'view':
        return <ViewIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'success.main' }} />;
      case 'function':
        return <FunctionIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'secondary.main' }} />;
      case 'procedure':
        return <ProcedureIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.light' }} />;
      case 'trigger':
        return <TriggerIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'warning.main' }} />;
      case 'index':
        return <IndexIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'grey.500' }} />;
      case 'constraint':
        return <ConstraintIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} />;
      case 'sequence':
        return <SequenceIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'grey.600' }} />;
      case 'extension':
        return <ExtensionIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'primary.main' }} />;
      case 'language':
        return <LanguageIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'info.light' }} />;
      case 'type':
        return <TypeIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'success.light' }} />;
      default:
        return <TableIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'info.main' }} />;
    }
  };


  const renderConnectionItem = (connection: DatabaseServer) => {
    const isConnecting = connectingId === connection.id;
    const connError = connectionErrors[connection.id];

    return (
    <Box key={connection.id}>
      {/* Connection Header */}
      <ListItemButton
        onClick={() => toggleConnectionExpansion(connection.id)}
        sx={{
          py: 0,
          px: 1,
          minHeight: '26px',
          height: '26px',
          borderRadius: 1,
          mx: 0.5,
          mb: 0.25,
          transition: 'background-color 0.15s ease',
          '&:hover': {
            bgcolor: 'action.hover',
          }
        }}
      >
        <ListItemIcon sx={{ minWidth: '22px' }}>
          {isConnecting ? (
            <CircularProgress size={TREE_ICON_SIZE} thickness={4} sx={{ color: 'warning.main' }} />
          ) : (
            <DatabaseIconNew sx={{ fontSize: TREE_ICON_SIZE, color: connection.isActive ? 'primary.main' : connError ? 'error.main' : 'text.secondary' }} />
          )}
        </ListItemIcon>
        <ListItemText
          primary={connection.connectionName}
          secondary={isConnecting ? 'Connecting...' : undefined}
          primaryTypographyProps={{ sx: { fontSize: '0.75rem', fontWeight: 500, lineHeight: 1.3 } }}
          secondaryTypographyProps={{ sx: { fontSize: '0.6875rem', color: 'warning.main', lineHeight: 1 } }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
          {!connection.isActive && !isConnecting && (
            <Tooltip title="Connect to this database">
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onConnect(connection.id);
                }}
                sx={{ p: 0.25 }}
              >
                <ConnectIcon sx={{ fontSize: TREE_ICON_SIZE }} />
              </IconButton>
            </Tooltip>
          )}
          {isConnecting && (
            <CircularProgress size={14} thickness={4} sx={{ color: 'warning.main', mr: 0.25 }} />
          )}
          <IconButton
            edge="end"
            onClick={(e) => {
              e.stopPropagation();
              handleMenuOpen(e, connection);
            }}
            aria-label={`Connection options for ${connection.connectionName || connection.host}`}
            size="small"
            sx={{ p: 0.25 }}
          >
            <MoreIcon sx={{ fontSize: TREE_ICON_SIZE }} />
          </IconButton>
          {expandedConnections.has(connection.id) ?
            <ExpandLessIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'text.secondary' }} className="expand-icon expanded" /> :
            <ExpandMoreIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'text.secondary' }} className="expand-icon" />
          }
        </Box>
      </ListItemButton>

      {/* Connection Error with Retry */}
      {connError && !isConnecting && (
        <Alert
          severity="error"
          sx={{
            mx: 1,
            mb: 0.5,
            py: 0,
            px: 1,
            fontSize: '0.75rem',
            '& .MuiAlert-icon': { fontSize: '1rem', py: 0.5 },
            '& .MuiAlert-message': { py: 0.5 },
            '& .MuiAlert-action': { pt: 0, pr: 0 },
          }}
          action={
            <Tooltip title="Retry connection">
              <IconButton
                size="small"
                color="inherit"
                onClick={() => onConnect(connection.id)}
                sx={{ p: 0.25 }}
                aria-label="Retry connection"
              >
                <RetryIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          }
        >
          {connError}
        </Alert>
      )}

      {/* Connection Content */}
      <Collapse
        in={expandedConnections.has(connection.id)}
        timeout={250}
        unmountOnExit
        sx={collapseSx}
      >
        <Box sx={{ pl: 0.5 }}>
          {/* Schemas (flattened — no database level) */}
          {connection.databases && connection.databases.length > 0 ? (
            connection.databases.map((database) => (
              <Box key={database.name}>
                    {database.schemas.map((schema) => (
                      <Box key={schema.schema_name}>
                        <ListItemButton
                          onClick={() => toggleSchemaExpansion(connection.id, schema.schema_name)}
                          onContextMenu={(e) => handleObjectContextMenu(e, schema, 'schema')}
                          sx={{
                            py: 0.125,
                            px: 1,
                            minHeight: '26px',
                            height: '26px',
                            borderRadius: 1,
                            mx: 0.5,
                            transition: 'background-color 0.15s ease',
                            '&:hover': {
                              bgcolor: 'action.hover',
                            }
                          }}
                        >
                          <ListItemIcon sx={{ minWidth: '18px' }}>
                            {expandedSchemas.has(`${connection.id}-${schema.schema_name}`) ?
                              <FolderOpenIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'warning.main' }} /> :
                              <FolderIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'warning.main' }} />
                            }
                          </ListItemIcon>
                          <ListItemText
                            primary={schema.schema_name}
                            primaryTypographyProps={treeTextProps}
                          />
                          {expandedSchemas.has(`${connection.id}-${schema.schema_name}`) ?
                            <ExpandLessIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'text.secondary' }} className="expand-icon expanded" /> :
                            <ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'text.secondary' }} className="expand-icon" />
                          }
                        </ListItemButton>

                        {/* Schema Content */}
                        <Collapse
                          in={expandedSchemas.has(`${connection.id}-${schema.schema_name}`)}
                          timeout={250}
                          unmountOnExit
                          sx={collapseSx}
                        >
                          <Box sx={{ pl: 1.5 }}>
                            {/* Tables */}
                            {(() => {
                              const tablesInSchema = database.tables.filter(t => t.table_schema === schema.schema_name);
                              return tablesInSchema.length > 0;
                            })() && (
                              <Accordion
                                expanded={expandedSections.has(`${connection.id}-tables-${schema.schema_name}`)}
                                onChange={() => toggleSectionExpansion(connection.id, `tables-${schema.schema_name}`)}
                                sx={accordionSx}
                              >
                                <AccordionSummary
                                  expandIcon={<ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE }} />}
                                  sx={sectionSummarySx}
                                  onContextMenu={(e) => handleObjectContextMenu(e, { schema_name: schema.schema_name }, 'section_tables', schema.schema_name)}
                                >
                                  <TablesListIcon sx={{ fontSize: LEAF_ICON_SIZE, mr: 0.5, color: 'info.main' }} />
                                  <Typography sx={sectionHeaderTypography}>
                                    {t('db.sections.tables')}
                                  </Typography>
                                  <Chip
                                    label={database.tables.filter(t => t.table_schema === schema.schema_name).length}
                                    size="small"
                                    sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                  />
                                </AccordionSummary>
                                <AccordionDetails sx={{ p: 0 }}>
                                  <List dense disablePadding>
                                    {database.tables
                                      .filter(t => t.table_schema === schema.schema_name)
                                      .map((table, index) => {
                                        const tableKey = `${schema.schema_name}.${table.table_name}`;
                                        return (
                                          <Box key={`${table.table_name}-${index}`}>
                                              <ListItem disablePadding>
                                                <ListItemButton
                                                  onClick={() => toggleTableDetailsExpansion(connection.id, tableKey)}
                                                  onContextMenu={(e) => handleObjectContextMenu(e, table, 'table', schema.schema_name)}
                                                  sx={treeItemSx}
                                                >
                                                <ListItemIcon sx={{ minWidth: '18px' }}>
                                                  <TableIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'info.main' }} />
                                                </ListItemIcon>
                                                <ListItemText
                                                  primary={table.table_name}
                                                  primaryTypographyProps={leafTextProps}
                                                />
                                                {expandedTableDetails.has(`${connection.id}-${tableKey}`) ?
                                                  <ExpandLessIcon sx={{ fontSize: DETAIL_ICON_SIZE, color: 'text.secondary' }} className="expand-icon expanded" /> :
                                                  <ExpandMoreIcon sx={{ fontSize: DETAIL_ICON_SIZE, color: 'text.secondary' }} className="expand-icon" />
                                                }
                                                </ListItemButton>
                                              </ListItem>

                                              {/* Table Details */}
                                              <Collapse
                                                in={expandedTableDetails.has(`${connection.id}-${tableKey}`)}
                                                timeout={250}
                                                unmountOnExit
                                                sx={collapseSx}
                                              >
                                              <Box sx={{ pl: 3 }}>
                                                {/* Columns */}
                                                {table.columns && table.columns.length > 0 && (
                                                  <Accordion
                                                    expanded={expandedSections.has(`${connection.id}-columns-${tableKey}`)}
                                                    onChange={() => toggleSectionExpansion(connection.id, `columns-${tableKey}`)}
                                                    sx={accordionSx}
                                                  >
                                                    <AccordionSummary
                                                      expandIcon={<ExpandMoreIcon sx={{ fontSize: DETAIL_ICON_SIZE }} />}
                                                      sx={sectionSummarySx}
                                                      onContextMenu={(e) => handleObjectContextMenu(e, { _tableName: table.table_name }, 'section_columns', schema.schema_name)}
                                                    >
                                                      <ColumnIcon sx={{ fontSize: DETAIL_ICON_SIZE, mr: 0.5, color: 'info.main' }} />
                                                      <Typography sx={sectionHeaderTypography}>
                                                        Columns
                                                      </Typography>
                                                      <Chip
                                                        label={table.columns.length}
                                                        size="small"
                                                        sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                                      />
                                                    </AccordionSummary>
                                                    <AccordionDetails sx={{ p: 0 }}>
                                                      <List dense disablePadding>
                                                        {table.columns.map((column, colIndex) => (
                                                          <ListItem key={`${column.column_name}-${colIndex}`} disablePadding>
                                                            <ListItemButton
                                                              onContextMenu={(e) => handleObjectContextMenu(e, { ...column, _tableName: table.table_name }, 'column', schema.schema_name)}
                                                              sx={leafItemSx}
                                                            >
                                                              <ListItemIcon sx={{ minWidth: '16px' }}>
                                                                <ColumnIcon sx={{ fontSize: DETAIL_ICON_SIZE, color: 'info.main' }} />
                                                              </ListItemIcon>
                                                              <ListItemText
                                                                primary={column.column_name}
                                                                primaryTypographyProps={leafTextProps}
                                                              />
                                                            </ListItemButton>
                                                          </ListItem>
                                                        ))}
                                                      </List>
                                                    </AccordionDetails>
                                                  </Accordion>
                                                )}

                                                {/* Indexes */}
                                                {table.indexes && table.indexes.length > 0 && (
                                                  <Accordion
                                                    expanded={expandedSections.has(`${connection.id}-indexes-${tableKey}`)}
                                                    onChange={() => toggleSectionExpansion(connection.id, `indexes-${tableKey}`)}
                                                    sx={accordionSx}
                                                  >
                                                    <AccordionSummary
                                                      expandIcon={<ExpandMoreIcon sx={{ fontSize: DETAIL_ICON_SIZE }} />}
                                                      sx={sectionSummarySx}
                                                      onContextMenu={(e) => handleObjectContextMenu(e, { _tableName: table.table_name }, 'section_indexes', schema.schema_name)}
                                                    >
                                                      <IndexIcon sx={{ fontSize: DETAIL_ICON_SIZE, mr: 0.5, color: 'warning.main' }} />
                                                      <Typography sx={sectionHeaderTypography}>
                                                        Indexes
                                                      </Typography>
                                                      <Chip
                                                        label={table.indexes.length}
                                                        size="small"
                                                        sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                                      />
                                                    </AccordionSummary>
                                                    <AccordionDetails sx={{ p: 0 }}>
                                                      <List dense disablePadding>
                                                        {table.indexes.map((index, idxIndex) => (
                                                          <ListItem key={`${index.index_name}-${idxIndex}`} disablePadding>
                                                            <ListItemButton
                                                              onContextMenu={(e) => handleObjectContextMenu(e, { ...index, _tableName: table.table_name }, 'index', schema.schema_name)}
                                                              sx={leafItemSx}
                                                            >
                                                              <ListItemIcon sx={{ minWidth: '16px' }}>
                                                                <IndexIcon sx={{ fontSize: DETAIL_ICON_SIZE, color: 'warning.main' }} />
                                                              </ListItemIcon>
                                                              <ListItemText
                                                                primary={index.index_name}
                                                                primaryTypographyProps={leafTextProps}
                                                              />
                                                            </ListItemButton>
                                                          </ListItem>
                                                        ))}
                                                      </List>
                                                    </AccordionDetails>
                                                  </Accordion>
                                                )}

                                                {/* Constraints */}
                                                {table.constraints && table.constraints.length > 0 && (
                                                  <Accordion
                                                    expanded={expandedSections.has(`${connection.id}-constraints-${tableKey}`)}
                                                    onChange={() => toggleSectionExpansion(connection.id, `constraints-${tableKey}`)}
                                                    sx={accordionSx}
                                                  >
                                                    <AccordionSummary
                                                      expandIcon={<ExpandMoreIcon sx={{ fontSize: DETAIL_ICON_SIZE }} />}
                                                      sx={sectionSummarySx}
                                                      onContextMenu={(e) => handleObjectContextMenu(e, { _tableName: table.table_name }, 'section_constraints', schema.schema_name)}
                                                    >
                                                      <ConstraintIcon sx={{ fontSize: DETAIL_ICON_SIZE, mr: 0.5, color: 'error.main' }} />
                                                      <Typography sx={sectionHeaderTypography}>
                                                        Constraints
                                                      </Typography>
                                                      <Chip
                                                        label={table.constraints.length}
                                                        size="small"
                                                        sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                                      />
                                                    </AccordionSummary>
                                                    <AccordionDetails sx={{ p: 0 }}>
                                                      <List dense disablePadding>
                                                        {table.constraints.map((constraint, constIndex) => (
                                                          <ListItem key={`${constraint.constraint_name}-${constIndex}`} disablePadding>
                                                            <ListItemButton
                                                              onContextMenu={(e) => handleObjectContextMenu(e, { ...constraint, _tableName: table.table_name }, 'constraint', schema.schema_name)}
                                                              sx={leafItemSx}
                                                            >
                                                              <ListItemIcon sx={{ minWidth: '16px' }}>
                                                                <ConstraintIcon sx={{ fontSize: DETAIL_ICON_SIZE, color: 'error.main' }} />
                                                              </ListItemIcon>
                                                              <ListItemText
                                                                primary={constraint.constraint_name}
                                                                primaryTypographyProps={leafTextProps}
                                                              />
                                                            </ListItemButton>
                                                          </ListItem>
                                                        ))}
                                                      </List>
                                                    </AccordionDetails>
                                                  </Accordion>
                                                )}

                                                {/* Triggers */}
                                                {table.triggers && table.triggers.length > 0 && (
                                                  <Accordion
                                                    expanded={expandedSections.has(`${connection.id}-triggers-${tableKey}`)}
                                                    onChange={() => toggleSectionExpansion(connection.id, `triggers-${tableKey}`)}
                                                    sx={accordionSx}
                                                  >
                                                    <AccordionSummary
                                                      expandIcon={<ExpandMoreIcon sx={{ fontSize: DETAIL_ICON_SIZE }} />}
                                                      sx={sectionSummarySx}
                                                      onContextMenu={(e) => handleObjectContextMenu(e, { _tableName: table.table_name }, 'section_triggers', schema.schema_name)}
                                                    >
                                                      <TriggerIcon sx={{ fontSize: DETAIL_ICON_SIZE, mr: 0.5, color: 'secondary.main' }} />
                                                      <Typography sx={sectionHeaderTypography}>
                                                        Triggers
                                                      </Typography>
                                                      <Chip
                                                        label={table.triggers.length}
                                                        size="small"
                                                        sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                                      />
                                                    </AccordionSummary>
                                                    <AccordionDetails sx={{ p: 0 }}>
                                                      <List dense disablePadding>
                                                        {table.triggers.map((trigger, trigIndex) => (
                                                          <ListItem key={`${trigger.trigger_name}-${trigIndex}`} disablePadding>
                                                            <ListItemButton
                                                              onContextMenu={(e) => handleObjectContextMenu(e, { ...trigger, _tableName: table.table_name }, 'trigger', schema.schema_name)}
                                                              sx={leafItemSx}
                                                            >
                                                              <ListItemIcon sx={{ minWidth: '16px' }}>
                                                                <TriggerIcon sx={{ fontSize: DETAIL_ICON_SIZE, color: 'secondary.main' }} />
                                                              </ListItemIcon>
                                                              <ListItemText
                                                                primary={trigger.trigger_name}
                                                                primaryTypographyProps={leafTextProps}
                                                              />
                                                            </ListItemButton>
                                                          </ListItem>
                                                        ))}
                                                      </List>
                                                    </AccordionDetails>
                                                  </Accordion>
                                                )}
                                              </Box>
                                            </Collapse>
                                          </Box>
                                        );
                                      })}
                                  </List>
                                </AccordionDetails>
                              </Accordion>
                            )}

                            {/* Views */}
                            {database.views.filter(v => v.view_schema === schema.schema_name).length > 0 && (
                              <Accordion
                                expanded={expandedSections.has(`${connection.id}-views-${schema.schema_name}`)}
                                onChange={() => toggleSectionExpansion(connection.id, `views-${schema.schema_name}`)}
                                sx={accordionSx}
                              >
                                <AccordionSummary
                                  expandIcon={<ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE }} />}
                                  sx={sectionSummarySx}
                                  onContextMenu={(e) => handleObjectContextMenu(e, { schema_name: schema.schema_name }, 'section_views', schema.schema_name)}
                                >
                                  <ViewIcon sx={{ fontSize: LEAF_ICON_SIZE, mr: 0.5, color: 'success.main' }} />
                                  <Typography sx={sectionHeaderTypography}>
                                    {t('db.sections.views')}
                                  </Typography>
                                  <Chip
                                    label={database.views.filter(v => v.view_schema === schema.schema_name).length}
                                    size="small"
                                    sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                  />
                                </AccordionSummary>
                                <AccordionDetails sx={{ p: 0 }}>
                                  <List dense disablePadding>
                                    {database.views
                                      .filter(v => v.view_schema === schema.schema_name)
                                      .map((view, index) => (
                                        <ListItem key={`${view.view_name}-${index}`} disablePadding>
                                          <ListItemButton
                                            onContextMenu={(e) => handleObjectContextMenu(e, view, 'view', schema.schema_name)}
                                            sx={treeItemSx}
                                          >
                                            <ListItemIcon sx={{ minWidth: '18px' }}>
                                              <ViewIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'success.main' }} />
                                            </ListItemIcon>
                                            <ListItemText
                                              primary={view.view_name}
                                              primaryTypographyProps={leafTextProps}
                                            />
                                          </ListItemButton>
                                        </ListItem>
                                      ))}
                                  </List>
                                </AccordionDetails>
                              </Accordion>
                            )}

                            {/* Functions */}
                            {database.functions.filter(f => f.routine_schema === schema.schema_name).length > 0 && (
                              <Accordion
                                expanded={expandedSections.has(`${connection.id}-functions-${schema.schema_name}`)}
                                onChange={() => toggleSectionExpansion(connection.id, `functions-${schema.schema_name}`)}
                                sx={accordionSx}
                              >
                                <AccordionSummary
                                  expandIcon={<ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE }} />}
                                  sx={sectionSummarySx}
                                  onContextMenu={(e) => handleObjectContextMenu(e, { schema_name: schema.schema_name }, 'section_functions', schema.schema_name)}
                                >
                                  <FunctionIcon sx={{ fontSize: LEAF_ICON_SIZE, mr: 0.5, color: 'secondary.main' }} />
                                  <Typography sx={sectionHeaderTypography}>
                                    {t('db.sections.functions')}
                                  </Typography>
                                  <Chip
                                    label={database.functions.filter(f => f.routine_schema === schema.schema_name).length}
                                    size="small"
                                    sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                  />
                                </AccordionSummary>
                                <AccordionDetails sx={{ p: 0 }}>
                                  <List dense disablePadding>
                                    {database.functions
                                      .filter(f => f.routine_schema === schema.schema_name)
                                      .map((func, index) => (
                                        <ListItem key={`${func.routine_name}-${index}`} disablePadding>
                                          <ListItemButton
                                            onContextMenu={(e) => handleObjectContextMenu(e, func, 'function', schema.schema_name)}
                                            sx={treeItemSx}
                                          >
                                            <ListItemIcon sx={{ minWidth: '18px' }}>
                                              <FunctionIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'secondary.main' }} />
                                            </ListItemIcon>
                                            <ListItemText
                                              primary={func.routine_name}
                                              primaryTypographyProps={leafTextProps}
                                            />
                                          </ListItemButton>
                                        </ListItem>
                                      ))}
                                  </List>
                                </AccordionDetails>
                              </Accordion>
                            )}

                            {/* Procedures */}
                            {database.procedures.filter(p => p.procedure_schema === schema.schema_name).length > 0 && (
                              <Accordion
                                expanded={expandedSections.has(`${connection.id}-procedures-${schema.schema_name}`)}
                                onChange={() => toggleSectionExpansion(connection.id, `procedures-${schema.schema_name}`)}
                                sx={accordionSx}
                              >
                                <AccordionSummary
                                  expandIcon={<ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE }} />}
                                  sx={sectionSummarySx}
                                >
                                  <ProcedureIcon sx={{ fontSize: LEAF_ICON_SIZE, mr: 0.5, color: 'error.light' }} />
                                  <Typography sx={sectionHeaderTypography}>
                                    Procedures
                                  </Typography>
                                  <Chip
                                    label={database.procedures.filter(p => p.procedure_schema === schema.schema_name).length}
                                    size="small"
                                    sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                  />
                                </AccordionSummary>
                                <AccordionDetails sx={{ p: 0 }}>
                                  <List dense disablePadding>
                                    {database.procedures
                                      .filter(p => p.procedure_schema === schema.schema_name)
                                      .map((proc, index) => (
                                        <ListItem key={`${proc.procedure_name}-${index}`} disablePadding>
                                          <ListItemButton
                                            onContextMenu={(e) => handleObjectContextMenu(e, proc, 'procedure', schema.schema_name)}
                                            sx={treeItemSx}
                                          >
                                            <ListItemIcon sx={{ minWidth: '18px' }}>
                                              <ProcedureIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'error.light' }} />
                                            </ListItemIcon>
                                            <ListItemText
                                              primary={proc.procedure_name}
                                              primaryTypographyProps={leafTextProps}
                                            />
                                          </ListItemButton>
                                        </ListItem>
                                      ))}
                                  </List>
                                </AccordionDetails>
                              </Accordion>
                            )}

                            {/* Sequences */}
                            {(() => {
                              const sequencesInSchema = database.sequences?.filter(s => s.sequence_schema === schema.schema_name) || [];
                              return sequencesInSchema.length > 0;
                            })() && (
                              <Accordion
                                expanded={expandedSections.has(`${connection.id}-sequences-${schema.schema_name}`)}
                                onChange={() => toggleSectionExpansion(connection.id, `sequences-${schema.schema_name}`)}
                                sx={accordionSx}
                              >
                                <AccordionSummary
                                  expandIcon={<ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE }} />}
                                  sx={sectionSummarySx}
                                  onContextMenu={(e) => handleObjectContextMenu(e, { schema_name: schema.schema_name }, 'section_sequences', schema.schema_name)}
                                >
                                  <SequenceIcon sx={{ fontSize: LEAF_ICON_SIZE, mr: 0.5, color: 'grey.600' }} />
                                  <Typography sx={sectionHeaderTypography}>
                                    {t('db.sections.sequences')}
                                  </Typography>
                                  <Chip
                                    label={database.sequences.filter(s => s.sequence_schema === schema.schema_name).length}
                                    size="small"
                                    sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                  />
                                </AccordionSummary>
                                <AccordionDetails sx={{ p: 0 }}>
                                  <List dense disablePadding>
                                    {database.sequences
                                      .filter(s => s.sequence_schema === schema.schema_name)
                                      .map((seq, index) => (
                                        <ListItem key={`${seq.sequence_name}-${index}`} disablePadding>
                                          <ListItemButton sx={treeItemSx} onContextMenu={(e) => handleObjectContextMenu(e, seq, 'sequence', schema.schema_name)}>
                                            <ListItemIcon sx={{ minWidth: '18px' }}>
                                              <SequenceIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'grey.600' }} />
                                            </ListItemIcon>
                                            <ListItemText
                                              primary={seq.sequence_name}
                                              primaryTypographyProps={leafTextProps}
                                            />
                                          </ListItemButton>
                                        </ListItem>
                                      ))}
                                  </List>
                                </AccordionDetails>
                              </Accordion>
                            )}

                            {/* Extensions */}
                            {database.extensions && database.extensions.length > 0 && (
                              <Accordion
                                expanded={expandedSections.has(`${connection.id}-extensions-${schema.schema_name}`)}
                                onChange={() => toggleSectionExpansion(connection.id, `extensions-${schema.schema_name}`)}
                                sx={accordionSx}
                              >
                                <AccordionSummary
                                  expandIcon={<ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE }} />}
                                  sx={sectionSummarySx}
                                  onContextMenu={(e) => handleObjectContextMenu(e, {}, 'section_extensions', schema.schema_name)}
                                >
                                  <ExtensionIcon sx={{ fontSize: LEAF_ICON_SIZE, mr: 0.5, color: 'primary.main' }} />
                                  <Typography sx={sectionHeaderTypography}>
                                    {t('db.sections.extensions')}
                                  </Typography>
                                  <Chip
                                    label={database.extensions.length}
                                    size="small"
                                    sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                  />
                                </AccordionSummary>
                                <AccordionDetails sx={{ p: 0 }}>
                                  <List dense disablePadding>
                                    {database.extensions.map((ext, index) => (
                                      <ListItem key={`${ext.name}-${index}`} disablePadding>
                                        <ListItemButton sx={treeItemSx} onContextMenu={(e) => handleObjectContextMenu(e, ext, 'extension')}>
                                            <ListItemIcon sx={{ minWidth: '18px' }}>
                                              <ExtensionIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'primary.main' }} />
                                            </ListItemIcon>
                                          <ListItemText
                                            primary={ext.name}
                                            primaryTypographyProps={leafTextProps}
                                          />
                                        </ListItemButton>
                                      </ListItem>
                                    ))}
                                  </List>
                                </AccordionDetails>
                              </Accordion>
                            )}

                            {/* Types */}
                            {(() => {
                              const typesInSchema = database.types?.filter(t => t.schema === schema.schema_name) || [];
                              return typesInSchema.length > 0;
                            })() && (
                              <Accordion
                                expanded={expandedSections.has(`${connection.id}-types-${schema.schema_name}`)}
                                onChange={() => toggleSectionExpansion(connection.id, `types-${schema.schema_name}`)}
                                sx={accordionSx}
                              >
                                <AccordionSummary
                                  expandIcon={<ExpandMoreIcon sx={{ fontSize: LEAF_ICON_SIZE }} />}
                                  sx={sectionSummarySx}
                                  onContextMenu={(e) => handleObjectContextMenu(e, { schema_name: schema.schema_name }, 'section_types', schema.schema_name)}
                                >
                                  <TypeIcon sx={{ fontSize: LEAF_ICON_SIZE, mr: 0.5, color: 'success.light' }} />
                                  <Typography sx={sectionHeaderTypography}>
                                    {t('db.sections.types')}
                                  </Typography>
                                  <Chip
                                    label={database.types.filter(t => t.schema === schema.schema_name).length}
                                    size="small"
                                    sx={{ ml: 0.5, height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
                                  />
                                </AccordionSummary>
                                <AccordionDetails sx={{ p: 0 }}>
                                  <List dense disablePadding>
                                    {database.types
                                      .filter(t => t.schema === schema.schema_name)
                                      .map((type, index) => (
                                        <ListItem key={`${type.name}-${index}`} disablePadding>
                                          <ListItemButton sx={treeItemSx} onContextMenu={(e) => handleObjectContextMenu(e, type, 'type', schema.schema_name)}>
                                            <ListItemIcon sx={{ minWidth: '18px' }}>
                                              <TypeIcon sx={{ fontSize: LEAF_ICON_SIZE, color: 'success.light' }} />
                                            </ListItemIcon>
                                            <ListItemText
                                              primary={type.name}
                                              primaryTypographyProps={leafTextProps}
                                            />
                                          </ListItemButton>
                                        </ListItem>
                                      ))}
                                  </List>
                                </AccordionDetails>
                              </Accordion>
                            )}
                          </Box>
                        </Collapse>
                      </Box>
                    ))}
              </Box>
            ))
          ) : (
            <Box sx={{ p: 1.5, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
                No databases available
              </Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
    );
  };

  if (connections.length === 0) {
    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.paper' }}>
        <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="subtitle2" sx={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary' }}>
              {t('db.sections.connections')}
            </Typography>
            <Tooltip title="Add New Connection">
              <IconButton
                color="primary"
                onClick={() => setIsAddDialogOpen(true)}
                size="small"
                sx={{ p: 0.25, color: 'primary.main' }}
              >
                <AddIcon sx={{ fontSize: TREE_ICON_SIZE }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        <Box sx={{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary" gutterBottom sx={{ fontSize: '0.8125rem' }}>
              {t('db.noConnections')}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
              {t('db.noConnectionsHint')}
            </Typography>
          </Box>
        </Box>

        <Dialog
          open={isAddDialogOpen}
          onClose={() => setIsAddDialogOpen(false)}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>Add New Database Connection</DialogTitle>
          <DialogContent>
            <ConnectionForm
              onConnect={handleAddConnection}
              isDialog={true}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setIsAddDialogOpen(false)}>Cancel</Button>
          </DialogActions>
        </Dialog>
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', bgcolor: 'background.paper' }} className="sidebar-container">
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography variant="subtitle2" sx={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary' }}>
              {t('db.sections.connections')}
            </Typography>
            <Chip
              label={connections.length}
              size="small"
              sx={{ height: 16, fontSize: '0.625rem', '& .MuiChip-label': { px: 0.5 } }}
            />
            {isRestoringConnections && (
              <Typography component="span" variant="caption" sx={{ fontSize: '0.6875rem', color: 'primary.main' }}>
                Restoring...
              </Typography>
            )}
          </Box>
          <Box sx={{ display: 'flex', gap: 0.25 }}>
            {activeConnection && onAnalyzeSchema && (
              <Tooltip title="Analyze Schema">
                <IconButton
                  onClick={onAnalyzeSchema}
                  aria-label="Analyze database schema"
                  size="small"
                  sx={{ p: 0.25, color: 'text.secondary', '&:hover': { color: 'info.main' } }}
                >
                  <AnalyzeIcon sx={{ fontSize: TREE_ICON_SIZE }} />
                </IconButton>
              </Tooltip>
            )}
            {activeConnection && (
              <Tooltip title="Refresh Database Structure">
                <IconButton
                  onClick={() => onRefreshConnection(activeConnection.id)}
                  aria-label="Refresh database structure"
                  size="small"
                  sx={{ p: 0.25, color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
                >
                  <RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} />
                </IconButton>
              </Tooltip>
            )}
            {connections.filter((c) => c.isActive).length >= 2 && (
              <Tooltip title="Schema Sync">
                <IconButton
                  onClick={() => setSchemaSyncOpen(true)}
                  aria-label="Compare and sync schemas"
                  size="small"
                  sx={{ p: 0.25, color: 'text.secondary', '&:hover': { color: 'secondary.main' } }}
                >
                  <CompareArrowsIcon sx={{ fontSize: TREE_ICON_SIZE }} />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Add New Connection">
              <IconButton
                onClick={() => setIsAddDialogOpen(true)}
                aria-label="Add new database connection"
                size="small"
                sx={{ p: 0.25, color: 'primary.main' }}
              >
                <AddIcon sx={{ fontSize: TREE_ICON_SIZE }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      <Box
        sx={{
          flexGrow: 1,
          overflow: 'auto',
          py: 0.25,
          ...scrollbarSx,
        }}
        role="navigation"
        aria-label="Database connections"
      >
        {/* All Connections - Unified Style */}
        {connections.map(renderConnectionItem)}

        {/* Show message if no connections */}
        {connections.length === 0 && (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <CloudIcon sx={{ fontSize: 36, color: 'text.secondary', mb: 1 }} />
            <Typography variant="body2" color="text.secondary" gutterBottom sx={{ fontSize: '0.8125rem' }}>
              {t('db.noConnections')}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
              {t('db.noConnectionsHint')}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Connection Menu */}
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'left',
        }}
        slotProps={{
          paper: {
            sx: {
              minWidth: 140,
              '& .MuiMenuItem-root': {
                py: 0.5,
                fontSize: '0.8125rem',
              },
              '& .MuiListItemIcon-root': {
                minWidth: 28,
              },
            },
          },
        }}
      >
        {selectedConnection?.isActive ? (
          <MenuItem onClick={() => handleMenuAction('disconnect')}>
            <ListItemIcon>
              <DisconnectIcon sx={{ fontSize: TREE_ICON_SIZE }} />
            </ListItemIcon>
            Disconnect
          </MenuItem>
        ) : (
          <MenuItem onClick={() => handleMenuAction('connect')}>
            <ListItemIcon>
              <ConnectIcon sx={{ fontSize: TREE_ICON_SIZE }} />
            </ListItemIcon>
            Connect
          </MenuItem>
        )}
        <MenuItem onClick={() => handleMenuAction('refresh')}>
          <ListItemIcon>
            <RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} />
          </ListItemIcon>
          Refresh
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleMenuAction('create_schema')}>
          <ListItemIcon>
            <AddIcon sx={{ fontSize: TREE_ICON_SIZE }} />
          </ListItemIcon>
          Create Schema
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleMenuAction('edit')}>
          <ListItemIcon>
            <EditIcon sx={{ fontSize: TREE_ICON_SIZE }} />
          </ListItemIcon>
          Edit
        </MenuItem>
        <MenuItem onClick={() => handleMenuAction('delete')}>
          <ListItemIcon>
            <DeleteIcon sx={{ fontSize: TREE_ICON_SIZE }} />
          </ListItemIcon>
          Delete
        </MenuItem>
      </Menu>

      {/* Object Context Menu */}
      <Menu
        open={objectMenuPosition !== null}
        onClose={handleObjectMenuClose}
        anchorReference="anchorPosition"
        anchorPosition={objectMenuPosition ?? undefined}
        BackdropProps={{
          invisible: true,
          sx: { pointerEvents: 'none' },
        }}
        slotProps={{
          paper: {
            ref: objectMenuPaperRef,
            sx: {
              pointerEvents: 'auto',
              minWidth: 160,
              '& .MuiMenuItem-root': {
                py: 0.5,
                fontSize: '0.8125rem',
              },
              '& .MuiListItemIcon-root': {
                minWidth: 28,
              },
            },
          },
        }}
      >
        {/* Table context menu */}
        {contextMenuObject?.type === 'table' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="select_top" onClick={() => handleObjectMenuAction('select_top')}>
            <ListItemIcon><TableIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            SELECT TOP 100
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          onExplainObject && <Divider key="div1" />,
          onExplainObject && (
            <MenuItem key="explain_ai" onClick={() => handleObjectMenuAction('explain_ai')}>
              <ListItemIcon><AnalyzeIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
              Explain
            </MenuItem>
          ),
          <Divider key="div2" />,
          <MenuItem key="drop_table" onClick={() => handleObjectMenuAction('drop_table')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Table
          </MenuItem>,
          <Divider key="div3" />,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}

        {/* View context menu */}
        {contextMenuObject?.type === 'view' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="view_source" onClick={() => handleObjectMenuAction('view_source')}>
            <ListItemIcon><CodeIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Source
          </MenuItem>,
          <MenuItem key="insert_name" onClick={() => handleObjectMenuAction('insert_name')}>
            <ListItemIcon><ViewIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Insert Name
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          onExplainObject && <Divider key="div1" />,
          onExplainObject && (
            <MenuItem key="explain_ai" onClick={() => handleObjectMenuAction('explain_ai')}>
              <ListItemIcon><AnalyzeIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
              Explain
            </MenuItem>
          ),
          <Divider key="div2" />,
          <MenuItem key="drop_view" onClick={() => handleObjectMenuAction('drop_view')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop View
          </MenuItem>,
          <Divider key="div3" />,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}

        {/* Function context menu */}
        {contextMenuObject?.type === 'function' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="view_source" onClick={() => handleObjectMenuAction('view_source')}>
            <ListItemIcon><CodeIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Source
          </MenuItem>,
          <MenuItem key="insert_name" onClick={() => handleObjectMenuAction('insert_name')}>
            <ListItemIcon><FunctionIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Insert Name
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          onExplainObject && <Divider key="div1" />,
          onExplainObject && (
            <MenuItem key="explain_ai" onClick={() => handleObjectMenuAction('explain_ai')}>
              <ListItemIcon><AnalyzeIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
              Explain
            </MenuItem>
          ),
          <Divider key="div2" />,
          <MenuItem key="drop_function" onClick={() => handleObjectMenuAction('drop_function')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Function
          </MenuItem>,
          <Divider key="div3" />,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}

        {/* Procedure context menu */}
        {contextMenuObject?.type === 'procedure' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="view_source" onClick={() => handleObjectMenuAction('view_source')}>
            <ListItemIcon><CodeIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Source
          </MenuItem>,
          <MenuItem key="insert_name" onClick={() => handleObjectMenuAction('insert_name')}>
            <ListItemIcon><ProcedureIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Insert Name
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          onExplainObject && <Divider key="div1" />,
          onExplainObject && (
            <MenuItem key="explain_ai" onClick={() => handleObjectMenuAction('explain_ai')}>
              <ListItemIcon><AnalyzeIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
              Explain
            </MenuItem>
          ),
          <Divider key="div2" />,
          <MenuItem key="drop_procedure" onClick={() => handleObjectMenuAction('drop_procedure')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Procedure
          </MenuItem>,
          <Divider key="div3" />,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}

        {/* Schema context menu */}
        {contextMenuObject?.type === 'schema' && [
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="drop_schema" onClick={() => handleObjectMenuAction('drop_schema')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Schema
          </MenuItem>,
        ]}

        {/* Section header context menus */}
        {contextMenuObject?.type === 'section_tables' && [
          <MenuItem key="create_table" onClick={() => handleObjectMenuAction('create_table')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create Table
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_views' && [
          <MenuItem key="create_view" onClick={() => handleObjectMenuAction('create_view')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create View
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_functions' && [
          <MenuItem key="create_function" onClick={() => handleObjectMenuAction('create_function')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create Function
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_sequences' && [
          <MenuItem key="create_sequence" onClick={() => handleObjectMenuAction('create_sequence')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create Sequence
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_extensions' && [
          <MenuItem key="create_extension" onClick={() => handleObjectMenuAction('create_extension')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create Extension
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_types' && [
          <MenuItem key="create_type" onClick={() => handleObjectMenuAction('create_type')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create Type
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}

        {/* Individual sequence/extension/type item menus */}
        {contextMenuObject?.type === 'sequence' && [
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="drop_sequence" onClick={() => handleObjectMenuAction('drop_sequence')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Sequence
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'extension' && [
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="drop_extension" onClick={() => handleObjectMenuAction('drop_extension')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Extension
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'type' && [
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="drop_type" onClick={() => handleObjectMenuAction('drop_type')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Type
          </MenuItem>,
        ]}

        {/* Table detail section headers */}
        {contextMenuObject?.type === 'section_columns' && [
          <MenuItem key="add_column" onClick={() => handleObjectMenuAction('add_column')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Add Column
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_indexes' && [
          <MenuItem key="create_index" onClick={() => handleObjectMenuAction('create_index')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create Index
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_constraints' && [
          <MenuItem key="add_constraint" onClick={() => handleObjectMenuAction('add_constraint')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Add Constraint
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'section_triggers' && [
          <MenuItem key="create_trigger" onClick={() => handleObjectMenuAction('create_trigger')}>
            <ListItemIcon><AddIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Create Trigger
          </MenuItem>,
          <MenuItem key="refresh" onClick={() => handleObjectMenuAction('refresh')}>
            <ListItemIcon><RefreshIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Refresh
          </MenuItem>,
        ]}

        {/* Individual column/index/constraint/trigger items */}
        {contextMenuObject?.type === 'column' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="alter_column" onClick={() => handleObjectMenuAction('alter_column')}>
            <ListItemIcon><EditIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Alter Column
          </MenuItem>,
          <MenuItem key="drop_column" onClick={() => handleObjectMenuAction('drop_column')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Column
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'index' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="drop_index" onClick={() => handleObjectMenuAction('drop_index')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Index
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'constraint' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="drop_constraint" onClick={() => handleObjectMenuAction('drop_constraint')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Constraint
          </MenuItem>,
        ]}
        {contextMenuObject?.type === 'trigger' && [
          <MenuItem key="view_info" onClick={() => handleObjectMenuAction('view_info')}>
            <ListItemIcon><InfoIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            View Info
          </MenuItem>,
          <MenuItem key="copy_name" onClick={() => handleObjectMenuAction('copy_name')}>
            <ListItemIcon><CopyIcon sx={{ fontSize: TREE_ICON_SIZE }} /></ListItemIcon>
            Copy Name
          </MenuItem>,
          <Divider key="div1" />,
          <MenuItem key="drop_trigger" onClick={() => handleObjectMenuAction('drop_trigger')} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon sx={{ fontSize: TREE_ICON_SIZE, color: 'error.main' }} /></ListItemIcon>
            Drop Trigger
          </MenuItem>,
        ]}
      </Menu>

      {/* Add Connection Dialog */}
      <Dialog
        open={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add New Database Connection</DialogTitle>
        <DialogContent>
          <ConnectionForm
            onConnect={handleAddConnection}
            isDialog={true}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsAddDialogOpen(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      {/* Element Details Modal */}
      <ElementDetailsModal
        open={detailsModalOpen}
        onClose={handleCloseDetails}
        element={selectedElement}
        elementType={selectedElementType as any}
        onApplySQL={onApplySQL}
      />

      {/* Schema Sync Modal */}
      <SchemaSyncModal
        open={schemaSyncOpen}
        onClose={() => setSchemaSyncOpen(false)}
        connections={connections}
        onApplySQL={onApplySQL}
      />

    </Box>
  );
}
