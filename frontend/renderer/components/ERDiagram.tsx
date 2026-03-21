import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  MarkerType,
  type Node,
  type Edge,
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
// Helpers -- localStorage positions
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
    // ignore -- quota exceeded etc.
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
// TableNode -- custom node rendered for each table
// ---------------------------------------------------------------------------

interface TableColumnInfo {
  name: string;
  dataType: string;
  isPK: boolean;
  isFK: boolean;
  fkRef?: string;
  isNullable: boolean;
}

interface TableNodeData {
  label: string;
  columns: TableColumnInfo[];
  rowCount?: number;
  onContextMenu?: (e: React.MouseEvent, tableName: string) => void;
  [key: string]: unknown;
}

const badgeStyle = (bg: string, fg: string): React.CSSProperties => ({
  fontSize: 8,
  fontWeight: 700,
  color: fg,
  background: bg,
  borderRadius: 3,
  padding: '1px 4px',
  lineHeight: '13px',
  flexShrink: 0,
  letterSpacing: '0.02em',
});

const TableNode = React.memo(function TableNode({
  data,
}: NodeProps<Node<TableNodeData>>) {
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      data.onContextMenu?.(e, data.label);
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
            {/* PK / FK badges */}
            <span
              style={{
                display: 'flex',
                gap: 3,
                flexShrink: 0,
                minWidth: col.isPK || col.isFK ? 'auto' : 16,
              }}
            >
              {col.isPK && (
                <span style={badgeStyle('#eab308', '#422006')} title="Primary Key">
                  PK
                </span>
              )}
              {col.isFK && (
                <span style={badgeStyle('#6366f1', '#eef2ff')} title={`FK -> ${col.fkRef ?? ''}`}>
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
// Build FK edges from constraints
// ---------------------------------------------------------------------------

function buildFKEdges(constraints: Constraint[], tableNames: Set<string>): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const c of constraints) {
    if (c.constraint_type !== 'FOREIGN KEY') continue;
    if (!c.referenced_table) continue;
    // Only create edge if both tables exist in the diagram
    if (!tableNames.has(c.table_name) || !tableNames.has(c.referenced_table)) continue;

    const edgeId = `fk-${c.table_name}-${c.column_name}-${c.referenced_table}`;
    if (seen.has(edgeId)) continue;
    seen.add(edgeId);

    edges.push({
      id: edgeId,
      source: c.table_name,
      target: c.referenced_table,
      type: 'smoothstep',
      animated: false,
      label: c.column_name,
      labelStyle: {
        fontSize: 9,
        fontWeight: 600,
        fill: '#a5b4fc',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      },
      labelBgStyle: {
        fill: '#1e293b',
        fillOpacity: 0.9,
      },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      style: {
        stroke: '#6366f1',
        strokeWidth: 1.5,
        opacity: 0.6,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: '#6366f1',
        width: 16,
        height: 16,
      },
    });
  }

  return edges;
}

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
  onViewTableInfo?: (tableName: string) => void;
}

function ERDiagramInner({ tables, constraints, onViewTableInfo }: ERDiagramInnerProps) {
  const positionsRef = useRef<SavedPositions>(loadPositions());

  // Debug: log constraints received
  useEffect(() => {
    console.log('[ERDiagram] tables:', tables.length, 'constraints:', constraints.length);
    if (constraints.length > 0) {
      console.log('[ERDiagram] sample constraint:', constraints[0]);
      console.log('[ERDiagram] PK constraints:', constraints.filter(c => c.constraint_type === 'PRIMARY KEY').length);
      console.log('[ERDiagram] FK constraints:', constraints.filter(c => c.constraint_type === 'FOREIGN KEY').length);
    }
  }, [tables, constraints]);

  const handleNodeContextMenu = useCallback(
    (_e: React.MouseEvent, tableName: string) => {
      onViewTableInfo?.(tableName);
    },
    [onViewTableInfo],
  );

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
          onContextMenu: handleNodeContextMenu,
        },
      };
    });
  }, [tables, constraints, handleNodeContextMenu]);

  // Build edges from FK constraints
  const initialEdges = useMemo<Edge[]>(() => {
    const tableNames = new Set(tables.map(t => t.table_name));
    return buildFKEdges(constraints, tableNames);
  }, [tables, constraints]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Re-sync when props change
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  // Save positions on drag stop
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      positionsRef.current[node.id] = { x: node.position.x, y: node.position.y };
      savePositions(positionsRef.current);
    },
    [],
  );

  // Hover animation for edges
  const onEdgeMouseEnter = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === edge.id
            ? {
                ...e,
                animated: true,
                style: { ...e.style, opacity: 1, strokeWidth: 2.5 },
              }
            : e,
        ),
      );
    },
    [setEdges],
  );

  const onEdgeMouseLeave = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === edge.id
            ? {
                ...e,
                animated: false,
                style: { ...e.style, opacity: 0.6, strokeWidth: 1.5 },
              }
            : e,
        ),
      );
    },
    [setEdges],
  );

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
        .react-flow__edge-textbg {
          rx: 3;
        }
      `}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component (wraps with ReactFlowProvider)
// ---------------------------------------------------------------------------

export interface ERDiagramProps {
  tables: Table[];
  constraints: Constraint[];
  onViewTableInfo?: (tableName: string) => void;
}

const ERDiagram: React.FC<ERDiagramProps> = React.memo(function ERDiagram({
  tables,
  constraints,
  onViewTableInfo,
}) {
  return (
    <ReactFlowProvider>
      <ERDiagramInner tables={tables} constraints={constraints} onViewTableInfo={onViewTableInfo} />
    </ReactFlowProvider>
  );
});

export default ERDiagram;
