/**
 * Migration planner.
 *
 * Takes a `SchemaDiff` plus the user's selection and returns a *plan*: an
 * ordered list of phases, each phase containing an ordered list of SQL
 * statements wrapped in its own `BEGIN; ... COMMIT;` block.
 *
 * Why phases matter
 * -----------------
 * Postgres has a handful of DDL rules that cannot be satisfied inside a single
 * transaction:
 *
 *  - `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that
 *    later references the new label. We therefore commit enum extensions in
 *    their own `pre-commit` phase before the main migration body.
 *
 *  - Some destructive follow-ups (e.g. `DROP TYPE old_enum` after swapping a
 *    column to a new type) are cleaner to run after the main body has
 *    committed so that a failure in the swap does not strand the old type.
 *    These go into the `post-commit` phase.
 *
 * Topological ordering
 * --------------------
 * Within each phase, ops are ordered via a Kahn topological sort over the
 * `dependsOn` edges. Cycles (which should not occur for well-formed diffs)
 * fall back to alphabetical order with a console warning so the migration
 * still runs, just in a less-optimal order.
 *
 * The planner also folds the legacy `TableDiff[]` into the plan by wrapping
 * the existing `assembleFinalSQL` output as a single statement of the `main`
 * phase. Future phases of the refactor will replace this bridge once tables
 * move to the ChangeOp model.
 */

import type { SchemaDiff, ChangeOp, MigrationPhase, TableDiff } from './types';
import { assembleFinalSQL } from './generators';

export interface MigrationPhaseBlock {
  phase: MigrationPhase;
  /** Header comment rendered above the BEGIN, purely informational. */
  header: string;
  /** Already-ordered statements for this phase (no trailing semicolons expected to be managed by callers). */
  statements: string[];
}

export interface MigrationPlan {
  phases: MigrationPhaseBlock[];
  /** True when every phase is empty — caller should render "no changes". */
  isEmpty: boolean;
  /** Warnings collected during planning (cycles, missing deps, destructive ops). */
  warnings: string[];
}

export interface PlanOptions {
  selectedTables: Set<string>;
  selectedOpIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn)
// ---------------------------------------------------------------------------

interface TopoNode<T> {
  id: string;
  value: T;
  deps: Set<string>;
}

function topoSort<T>(nodes: TopoNode<T>[]): { ordered: T[]; cycleDetected: boolean } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>();
  const reverseEdges = new Map<string, string[]>();

  for (const n of nodes) {
    indegree.set(n.id, 0);
    reverseEdges.set(n.id, []);
  }

  for (const n of nodes) {
    for (const dep of n.deps) {
      // Only count edges whose source is also in this phase — external deps
      // are considered already satisfied by an earlier phase.
      if (byId.has(dep)) {
        indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
        reverseEdges.get(dep)!.push(n.id);
      }
    }
  }

  // Priority: alphabetical for stable output.
  const ready: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) ready.push(id);
  }
  ready.sort();

  const ordered: T[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const node = byId.get(id)!;
    ordered.push(node.value);
    for (const dependant of reverseEdges.get(id) ?? []) {
      const next = (indegree.get(dependant) ?? 0) - 1;
      indegree.set(dependant, next);
      if (next === 0) {
        ready.push(dependant);
        ready.sort();
      }
    }
  }

  if (ordered.length !== nodes.length) {
    // Cycle (or dangling edge the guard above missed) — append remaining in
    // alphabetical order so we still produce a migration.
    const emitted = new Set(ordered);
    const leftover = nodes
      .filter((n) => !emitted.has(n.value))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => n.value);
    return { ordered: [...ordered, ...leftover], cycleDetected: true };
  }

  return { ordered, cycleDetected: false };
}

// ---------------------------------------------------------------------------
// Grouping ops by phase
// ---------------------------------------------------------------------------

/**
 * Per-op SQL rendering is delegated to category-specific generators. Phase 2
 * of the refactor only knows how to render enum ops; other categories will
 * be added in later phases.
 *
 * Kept as a separate lookup so tests can stub it without touching the planner.
 */
type OpRenderer = (op: ChangeOp) => string;

let opRenderer: OpRenderer = () => {
  // Default renderer used until enum/view/function generators register
  // themselves via `registerOpRenderer`. Emits a placeholder comment so a
  // planner-only unit test can still assert phase layout without pulling in
  // the SQL side.
  return '-- (renderer not yet registered for this op)';
};

export function registerOpRenderer(renderer: OpRenderer): void {
  opRenderer = renderer;
}

function phaseOrder(phase: MigrationPhase): number {
  switch (phase) {
    case 'pre': return 0;
    case 'pre-commit': return 1;
    case 'main': return 2;
    case 'post-commit': return 3;
  }
}

const phaseHeader: Record<MigrationPhase, string> = {
  'pre': '-- PHASE: pre (runs in main tx, before the body)',
  'pre-commit':
    '-- PHASE: pre-commit (own tx — required by Postgres for ALTER TYPE ADD VALUE)',
  'main': '-- PHASE: main',
  'post-commit': '-- PHASE: post-commit (own tx, clean-up after main)',
};

// ---------------------------------------------------------------------------
// Table-diff bridge: the legacy assembler is plugged into the `main` phase
// as one big block so tables keep working while we migrate categories over.
// ---------------------------------------------------------------------------

function buildTableMainStatement(diff: SchemaDiff, selectedTables: Set<string>): string | null {
  const filteredDiff: SchemaDiff = {
    ...diff,
    tables: diff.tables.filter((t: TableDiff) => selectedTables.has(t.tableName)),
  };
  if (filteredDiff.tables.length === 0) return null;
  // assembleFinalSQL already emits BEGIN/COMMIT; strip them so the planner
  // can wrap each phase in its own transaction block.
  const wrapped = assembleFinalSQL(filteredDiff, { selectedTables });
  if (!wrapped) return null;
  return wrapped
    .replace(/^BEGIN;\s*/i, '')
    .replace(/\s*COMMIT;\s*$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function planMigration(diff: SchemaDiff, opts: PlanOptions): MigrationPlan {
  const warnings: string[] = [];
  const selectedOps = diff.ops.filter((op) => opts.selectedOpIds.has(op.id));

  // Bucket ops by phase
  const buckets = new Map<MigrationPhase, ChangeOp[]>();
  for (const op of selectedOps) {
    const bucket = buckets.get(op.phase) ?? [];
    bucket.push(op);
    buckets.set(op.phase, bucket);
    if (op.isDestructive) {
      warnings.push(`Destructive op: ${op.label ?? op.objectName} (${op.category})`);
    }
  }

  const phases: MigrationPhaseBlock[] = [];

  // Ordered phase keys
  const phaseKeys: MigrationPhase[] = ['pre', 'pre-commit', 'main', 'post-commit'];

  for (const phase of phaseKeys) {
    const ops = buckets.get(phase) ?? [];
    const statements: string[] = [];

    // In the main phase, table DDL (legacy assembler) must run AFTER types
    // / domains / sequences (which table columns may reference) but BEFORE
    // views / functions / triggers (which may reference the new tables).
    // We therefore split ChangeOps into "before tables" and "after tables".
    const beforeTableCategories: Set<string> = new Set([
      'enum', 'domain', 'sequence',
    ]);

    const opsBeforeTables = phase === 'main'
      ? ops.filter((op) => beforeTableCategories.has(op.category))
      : ops;
    const opsAfterTables = phase === 'main'
      ? ops.filter((op) => !beforeTableCategories.has(op.category))
      : [];

    // Render a batch of ops through topo sort.
    const renderBatch = (batch: ChangeOp[]) => {
      if (batch.length === 0) return;
      const nameToIds = new Map<string, string[]>();
      for (const op of batch) {
        const ids = nameToIds.get(op.objectName) ?? [];
        ids.push(op.id);
        nameToIds.set(op.objectName, ids);
      }
      const nodes: TopoNode<ChangeOp>[] = batch.map((op) => {
        const expandedDeps = new Set<string>();
        for (const depName of op.dependsOn ?? []) {
          for (const depId of nameToIds.get(depName) ?? []) {
            if (depId !== op.id) expandedDeps.add(depId);
          }
        }
        return { id: op.id, value: op, deps: expandedDeps };
      });
      const { ordered, cycleDetected } = topoSort(nodes);
      if (cycleDetected) {
        warnings.push(
          `Cycle detected while ordering ${phase} phase — falling back to alphabetical order.`
        );
      }
      for (const op of ordered) {
        const sql = opRenderer(op);
        if (sql && sql.trim()) statements.push(sql.trim());
      }
    };

    // 1. Types / domains / sequences (before tables)
    renderBatch(opsBeforeTables);

    // 2. Legacy table diffs (main phase only)
    if (phase === 'main') {
      const tableStmt = buildTableMainStatement(diff, opts.selectedTables);
      if (tableStmt) statements.push(tableStmt);
    }

    // 3. Views / functions / triggers (after tables)
    renderBatch(opsAfterTables);

    if (statements.length > 0) {
      phases.push({
        phase,
        header: phaseHeader[phase],
        statements,
      });
    }
  }

  // Sort by canonical phase order (cheap; already in order, but safe if
  // future code inserts phases non-sequentially).
  phases.sort((a, b) => phaseOrder(a.phase) - phaseOrder(b.phase));

  return {
    phases,
    isEmpty: phases.length === 0,
    warnings,
  };
}

/**
 * Render a `MigrationPlan` as a single SQL script with separate BEGIN/COMMIT
 * blocks per phase. Phases are separated by a blank line and a header
 * comment.
 */
export function renderPlanSQL(plan: MigrationPlan): string {
  if (plan.isEmpty) return '';
  const blocks: string[] = [];

  if (plan.warnings.length > 0) {
    blocks.push(
      ['-- Planner warnings:', ...plan.warnings.map((w) => `--   * ${w}`)].join('\n')
    );
  }

  for (const block of plan.phases) {
    const body = block.statements.join('\n\n').trim();
    if (!body) continue;
    blocks.push(`${block.header}\nBEGIN;\n\n${body}\n\nCOMMIT;`);
  }

  return blocks.join('\n\n');
}
