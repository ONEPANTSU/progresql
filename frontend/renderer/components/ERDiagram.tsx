import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  ReactFlowProvider,
  type Node,
  type NodeTypes,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { Table, Constraint } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'er-diagram-positions';
const NODE_WIDTH = 260;
const NODE_ESTIMATED_HEIGHT = 200;
const GRID_GAP_X = 320;
const GRID_GAP_Y = 300;
const COLUMNS_PER_ROW = 5;

// ---------------------------------------------------------------------------
// Helpers – localStorage positions
// ---------------------------------------------------------------------------

interface SavedPositions {
  [tableName: string]: { x: number; y: number };
}

function loadPositions(): SavedPositions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SavedPositions;
  } catch {
    // ignore
  }
  return {};
}

function savePositions(positions: SavedPositions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // ignore – quota exceeded etc.
  }
}

// ---------------------------------------------------------------------------
// Derive PK / FK sets per table from constraints
// ---------------------------------------------------------------------------

interface ColumnMeta {
  isPK: boolean;
  isFK: boolean;
  fkRef?: string; // "referenced_table.referenced_column"
}

function buildColumnMeta(
  tableName: string,
  constraints: Constraint[],
): Map<string, ColumnMeta> {
  const map = new Map<string, ColumnMeta>();

  for (const c of constraints) {
    if (c.table_name !== tableName) continue;

    const existing = map.get(c.column_name) ?? { isPK: false, isFK: false };

    if (c.constraint_type === 'PRIMARY KEY') {
      existing.isPK = true;
    }
    if (c.constraint_type === 'FOREIGN KEY') {
      existing.isFK = true;
      if (c.referenced_table && c.referenced_column) {
        existing.fkRef = `${c.referenced_table}.${c.referenced_column}`;
      }
    }

    map.set(c.column_name, existing);
  }

  return map;
}

// ---------------------------------------------------------------------------
// TableNode – custom node rendered for each table
// ---------------------------------------------------------------------------

interface TableColumnInfo {
  name: string;
  dataType: string;
  isPK: boolean;
  isFK: boolean;
  fkRef?: string;
  isNullable: boolean;
}

interface TableConstraintInfo {
  name: string;
  type: string;
  columns: string;
  detail?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  tableName: string;
  columns: TableColumnInfo[];
  constraints: TableConstraintInfo[];
  rowCount?: number;
}

interface TableNodeData {
  label: string;
  columns: TableColumnInfo[];
  rowCount?: number;
  tableConstraints: TableConstraintInfo[];
  onContextMenu?: (
    e: React.MouseEvent,
    tableName: string,
    columns: TableColumnInfo[],
    constraints: TableConstraintInfo[],
    rowCount?: number,
  ) => void;
  [key: string]: unknown;
}

const TableNode = React.memo(function TableNode({
  data,
}: NodeProps<Node<TableNodeData>>) {
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      data.onContextMenu?.(e, data.label, data.columns, data.tableConstraints, data.rowCount);
    },
    [data],
  );

  return (
    <div
      onContextMenu={handleContextMenu}
      style={{
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: 8,
        minWidth: NODE_WIDTH,
        maxWidth: NODE_WIDTH,
        overflow: 'hidden',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#334155',
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            color: '#f1f5f9',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {data.label}
        </span>
        {data.rowCount !== undefined && (
          <span
            style={{
              fontSize: 10,
              color: '#94a3b8',
              flexShrink: 0,
            }}
          >
            {data.rowCount.toLocaleString()} rows
          </span>
        )}
      </div>

      {/* Columns */}
      <div
        style={{
          maxHeight: 260,
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {data.columns.map((col) => (
          <div
            key={col.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 12px',
              fontSize: 11,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              background: col.isPK ? 'rgba(99,102,241,0.08)' : 'transparent',
              borderLeft: col.isPK
                ? '2px solid #6366f1'
                : col.isFK
                  ? '2px solid #f59e0b'
                  : '2px solid transparent',
            }}
          >
            {/* Icon */}
            <span
              style={{
                width: 16,
                textAlign: 'center',
                flexShrink: 0,
                fontSize: 10,
              }}
            >
              {col.isPK && (
                <span style={{ color: '#6366f1' }} title="Primary Key">
                  PK
                </span>
              )}
              {col.isFK && !col.isPK && (
                <span style={{ color: '#f59e0b' }} title={`FK -> ${col.fkRef ?? ''}`}>
                  FK
                </span>
              )}
            </span>

            {/* Column name */}
            <span
              style={{
                color: '#e2e8f0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              title={col.name}
            >
              {col.name}
            </span>

            {/* Data type */}
            <span
              style={{
                color: '#64748b',
                flexShrink: 0,
                fontSize: 10,
              }}
              title={col.dataType}
            >
              {col.dataType}
            </span>

            {/* Nullable */}
            {!col.isNullable && (
              <span
                style={{
                  color: '#ef4444',
                  fontSize: 9,
                  flexShrink: 0,
                }}
                title="NOT NULL"
              >
                NN
              </span>
            )}
          </div>
        ))}
        {data.columns.length === 0 && (
          <div
            style={{
              padding: '8px 12px',
              color: '#64748b',
              fontSize: 11,
              fontStyle: 'italic',
            }}
          >
            No columns
          </div>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Build constraint info for context menu
// ---------------------------------------------------------------------------

function buildConstraintInfos(
  tableName: string,
  constraints: Constraint[],
): TableConstraintInfo[] {
  const seen = new Map<string, TableConstraintInfo>();

  for (const c of constraints) {
    if (c.table_name !== tableName) continue;

    const key = c.constraint_name;
    const existing = seen.get(key);
    if (existing) {
      // Append column for composite constraints
      if (!existing.columns.includes(c.column_name)) {
        existing.columns += `, ${c.column_name}`;
      }
      continue;
    }

    let detail: string | undefined;
    if (c.constraint_type === 'FOREIGN KEY' && c.referenced_table) {
      detail = `→ ${c.referenced_table}${c.referenced_column ? `.${c.referenced_column}` : ''}`;
    } else if (c.constraint_type === 'CHECK' && c.check_condition) {
      detail = c.check_condition;
    }

    seen.set(key, {
      name: c.constraint_name,
      type: c.constraint_type,
      columns: c.column_name,
      detail,
    });
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// TableContextMenu – popover shown on right-click
// ---------------------------------------------------------------------------

const CONSTRAINT_TYPE_COLORS: Record<string, string> = {
  'PRIMARY KEY': '#6366f1',
  'FOREIGN KEY': '#f59e0b',
  'UNIQUE': '#06b6d4',
  'CHECK': '#a78bfa',
};

interface TableContextMenuProps {
  menu: ContextMenuState;
  onClose: () => void;
}

const TableContextMenu: React.FC<TableContextMenuProps> = ({ menu, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const badgeStyle = (color: string): React.CSSProperties => ({
    fontSize: 9,
    fontWeight: 600,
    color,
    border: `1px solid ${color}`,
    borderRadius: 3,
    padding: '0 3px',
    lineHeight: '14px',
    flexShrink: 0,
  });

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: menu.x,
        top: menu.y,
        zIndex: 10000,
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        minWidth: 280,
        maxWidth: 360,
        maxHeight: 420,
        overflowY: 'auto',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 12px',
          background: '#334155',
          borderRadius: '8px 8px 0 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, color: '#f1f5f9' }}>
          {menu.tableName}
        </span>
        {menu.rowCount !== undefined && (
          <span style={{ fontSize: 10, color: '#94a3b8' }}>
            {menu.rowCount.toLocaleString()} rows
          </span>
        )}
      </div>

      {/* Columns section */}
      <div style={{ padding: '6px 0' }}>
        <div
          style={{
            padding: '2px 12px 4px',
            fontSize: 10,
            fontWeight: 600,
            color: '#64748b',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Columns
        </div>
        {menu.columns.map((col) => (
          <div
            key={col.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 12px',
              fontSize: 11,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              borderLeft: col.isPK
                ? '2px solid #6366f1'
                : col.isFK
                  ? '2px solid #f59e0b'
                  : '2px solid transparent',
              background: col.isPK ? 'rgba(99,102,241,0.08)' : 'transparent',
            }}
          >
            {col.isPK && <span style={badgeStyle('#6366f1')}>PK</span>}
            {col.isFK && <span style={badgeStyle('#f59e0b')}>FK</span>}
            <span
              style={{
                color: '#e2e8f0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              title={col.name}
            >
              {col.name}
            </span>
            <span style={{ color: '#64748b', fontSize: 10, flexShrink: 0 }}>
              {col.dataType}
            </span>
            {!col.isNullable && (
              <span style={{ color: '#ef4444', fontSize: 9, flexShrink: 0 }} title="NOT NULL">
                NN
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Constraints section */}
      {menu.constraints.length > 0 && (
        <div style={{ borderTop: '1px solid #334155', padding: '6px 0' }}>
          <div
            style={{
              padding: '2px 12px 4px',
              fontSize: 10,
              fontWeight: 600,
              color: '#64748b',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Constraints
          </div>
          {menu.constraints.map((cst) => (
            <div
              key={cst.name}
              style={{
                padding: '3px 12px',
                fontSize: 11,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={badgeStyle(CONSTRAINT_TYPE_COLORS[cst.type] ?? '#64748b')}
                >
                  {cst.type}
                </span>
                <span
                  style={{
                    color: '#94a3b8',
                    fontSize: 10,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={cst.name}
                >
                  {cst.name}
                </span>
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  color: '#cbd5e1',
                  paddingLeft: 2,
                }}
              >
                ({cst.columns})
                {cst.detail && (
                  <span style={{ color: '#64748b', marginLeft: 4 }}>{cst.detail}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Node types map (stable reference)
// ---------------------------------------------------------------------------

const nodeTypes: NodeTypes = {
  tableNode: TableNode as unknown as NodeTypes['tableNode'],
};

// ---------------------------------------------------------------------------
// Inner component (needs ReactFlowProvider above it)
// ---------------------------------------------------------------------------

interface ERDiagramInnerProps {
  tables: Table[];
  constraints: Constraint[];
}

function ERDiagramInner({ tables, constraints }: ERDiagramInnerProps) {
  const positionsRef = useRef<SavedPositions>(loadPositions());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleNodeContextMenu = useCallback(
    (
      e: React.MouseEvent,
      tableName: string,
      columns: TableColumnInfo[],
      tableConstraints: TableConstraintInfo[],
      rowCount?: number,
    ) => {
      setContextMenu({ x: e.clientX, y: e.clientY, tableName, columns, constraints: tableConstraints, rowCount });
    },
    [],
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Build nodes
  const initialNodes = useMemo<Node<TableNodeData>[]>(() => {
    const saved = positionsRef.current;

    return tables.map((table, idx) => {
      const colMeta = buildColumnMeta(table.table_name, constraints);

      const columns: TableColumnInfo[] = (table.columns ?? [])
        .slice()
        .sort((a, b) => a.ordinal_position - b.ordinal_position)
        .map((col) => {
          const meta = colMeta.get(col.column_name);
          return {
            name: col.column_name,
            dataType: col.data_type,
            isPK: meta?.isPK ?? false,
            isFK: meta?.isFK ?? false,
            fkRef: meta?.fkRef,
            isNullable: col.is_nullable === 'YES',
          };
        });

      const tableConstraints = buildConstraintInfos(table.table_name, constraints);

      const savedPos = saved[table.table_name];
      const gridCol = idx % COLUMNS_PER_ROW;
      const gridRow = Math.floor(idx / COLUMNS_PER_ROW);

      return {
        id: table.table_name,
        type: 'tableNode',
        position: savedPos ?? {
          x: gridCol * GRID_GAP_X + 40,
          y: gridRow * GRID_GAP_Y + 40,
        },
        data: {
          label: table.table_name,
          columns,
          rowCount: table.row_count,
          tableConstraints,
          onContextMenu: handleNodeContextMenu,
        },
      };
    });
  }, [tables, constraints, handleNodeContextMenu]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  // Re-sync when props change
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);

  // Save positions on drag stop
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      positionsRef.current[node.id] = { x: node.position.x, y: node.position.y };
      savePositions(positionsRef.current);
    },
    [],
  );

  const onPaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Dark-theme overrides for ReactFlow Controls buttons */}
      <style>{`
        .react-flow__controls button {
          background: #1e293b !important;
          border-color: #334155 !important;
          fill: #e2e8f0 !important;
          color: #e2e8f0 !important;
        }
        .react-flow__controls button:hover {
          background: #334155 !important;
        }
        .react-flow__controls button svg {
          fill: #e2e8f0 !important;
        }
      `}</style>
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#111827' }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#1e293b"
        />
        <MiniMap
          nodeColor="#334155"
          maskColor="rgba(17, 24, 39, 0.85)"
          style={{
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 4,
          }}
          pannable
          zoomable
        />
        <Controls
          style={{
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 4,
          }}
          showInteractive={false}
        />
      </ReactFlow>
      {contextMenu && (
        <TableContextMenu menu={contextMenu} onClose={handleCloseContextMenu} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component (wraps with ReactFlowProvider)
// ---------------------------------------------------------------------------

export interface ERDiagramProps {
  tables: Table[];
  constraints: Constraint[];
}

const ERDiagram: React.FC<ERDiagramProps> = React.memo(function ERDiagram({
  tables,
  constraints,
}) {
  return (
    <ReactFlowProvider>
      <ERDiagramInner tables={tables} constraints={constraints} />
    </ReactFlowProvider>
  );
});

export default ERDiagram;
