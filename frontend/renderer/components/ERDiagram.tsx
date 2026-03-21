import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
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

interface TableNodeData {
  label: string;
  columns: {
    name: string;
    dataType: string;
    isPK: boolean;
    isFK: boolean;
    fkRef?: string;
    isNullable: boolean;
  }[];
  rowCount?: number;
  [key: string]: unknown;
}

const TableNode = React.memo(function TableNode({
  data,
}: NodeProps<Node<TableNodeData>>) {
  return (
    <div
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
      {/* Handles for edges */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: '#6366f1', width: 8, height: 8 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: '#6366f1', width: 8, height: 8 }}
      />

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
  const { fitView } = useReactFlow();
  const positionsRef = useRef<SavedPositions>(loadPositions());

  // Build nodes
  const initialNodes = useMemo<Node<TableNodeData>[]>(() => {
    const saved = positionsRef.current;

    return tables.map((table, idx) => {
      const colMeta = buildColumnMeta(table.table_name, constraints);

      const columns = (table.columns ?? [])
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
        },
      };
    });
  }, [tables, constraints]);

  // Build edges from FK constraints
  const initialEdges = useMemo<Edge[]>(() => {
    const fkConstraints = constraints.filter(
      (c) =>
        c.constraint_type === 'FOREIGN KEY' &&
        c.referenced_table &&
        c.referenced_column,
    );

    // Deduplicate by constraint_name (composite FKs share constraint_name)
    const seen = new Set<string>();

    return fkConstraints
      .filter((c) => {
        if (seen.has(c.constraint_name)) return false;
        seen.add(c.constraint_name);
        return true;
      })
      .map((c) => ({
        id: `edge-${c.constraint_name}`,
        source: c.table_name,
        target: c.referenced_table!,
        type: 'smoothstep',
        animated: true,
        label: `${c.column_name} -> ${c.referenced_column}`,
        labelStyle: {
          fontSize: 9,
          fill: '#94a3b8',
          fontFamily: 'monospace',
        },
        labelBgStyle: {
          fill: '#1e293b',
          fillOpacity: 0.85,
        },
        style: {
          stroke: '#6366f1',
          strokeWidth: 1.5,
        },
        markerEnd: {
          type: 'arrowclosed' as const,
          color: '#6366f1',
          width: 16,
          height: 16,
        },
      }));
  }, [constraints]);

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

  // Fit view handler
  const handleFitView = useCallback(() => {
    fitView({ padding: 0.15, duration: 300 });
  }, [fitView]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: true,
        }}
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

      {/* Fit-to-screen button */}
      <button
        onClick={handleFitView}
        title="Fit to screen"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 10,
          background: '#334155',
          color: '#e2e8f0',
          border: '1px solid #475569',
          borderRadius: 6,
          padding: '6px 12px',
          fontSize: 12,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#475569';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#334155';
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
        </svg>
        Fit View
      </button>
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
