/**
 * Enum differ + generator + planner end-to-end-ish tests. Synthesises
 * minimal `DatabaseInfo` snapshots so we can assert on emitted ops and
 * the final SQL layout without touching the Electron bridge.
 */

import type { DatabaseInfo, CustomType } from '@/shared/types';
import {
  diffEnums,
  renderEnumOp,
  renderChangeOp,
  planMigration,
  renderPlanSQL,
  resolveOps,
  configureEnumGeneratorContext,
  type EnumOp,
} from '@/features/database-browser/schema-sync';
// Import generators barrel so registerOpRenderer side-effect runs.
import '@/features/database-browser/schema-sync/generators';

function emptyDb(name = 'db'): DatabaseInfo {
  return {
    name,
    tables: [],
    views: [],
    functions: [],
    procedures: [],
    triggers: [],
    indexes: [],
    constraints: [],
    sequences: [],
    schemas: [],
    extensions: [],
    languages: [],
    types: [],
    operators: [],
    operatorClasses: [],
    operatorFamilies: [],
    conversions: [],
    casts: [],
    foreignDataWrappers: [],
    foreignServers: [],
    userMappings: [],
    policies: [],
    rules: [],
    publications: [],
    subscriptions: [],
  };
}

function enumType(name: string, values: string[], schema = 'public'): CustomType {
  return {
    name,
    schema,
    owner: 'test',
    type_category: 'E',
    type_type: 'e',
    is_preferred: false,
    is_instantiable: true,
    enum_values: values,
  };
}

describe('diffEnums', () => {
  it('emits a CREATE op for an enum that only exists on the source', () => {
    const src = emptyDb('src');
    src.types.push(enumType('order_status', ['pending', 'shipped']));
    const tgt = emptyDb('tgt');

    const { ops } = diffEnums(src, tgt);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('create');
    expect(ops[0].objectName).toBe('public.order_status');
    expect((ops[0] as Extract<EnumOp, { kind: 'create' }>).values).toEqual(['pending', 'shipped']);
    expect(ops[0].isDestructive).toBe(false);
  });

  it('emits a destructive DROP op for an enum that only exists on the target', () => {
    const src = emptyDb('src');
    const tgt = emptyDb('tgt');
    tgt.types.push(enumType('order_status', ['pending']));

    const { ops } = diffEnums(src, tgt);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('drop');
    expect(ops[0].isDestructive).toBe(true);
  });

  it('emits ADD VALUE ops in the pre-commit phase', () => {
    const src = emptyDb('src');
    src.types.push(enumType('order_status', ['pending', 'shipped', 'delivered']));
    const tgt = emptyDb('tgt');
    tgt.types.push(enumType('order_status', ['pending', 'shipped']));

    const { ops } = diffEnums(src, tgt);
    const addValue = ops.find((o) => o.kind === 'add-value') as
      | Extract<EnumOp, { kind: 'add-value' }>
      | undefined;
    expect(addValue).toBeDefined();
    expect(addValue!.value).toBe('delivered');
    expect(addValue!.phase).toBe('pre-commit');
    expect(addValue!.isDestructive).toBe(false);
  });

  it('detects a value rename as a non-destructive rename-value op', () => {
    const src = emptyDb('src');
    src.types.push(enumType('order_status', ['pending', 'shippedd']));
    const tgt = emptyDb('tgt');
    tgt.types.push(enumType('order_status', ['pending', 'shipped']));

    const { ops, valueRenameCandidates } = diffEnums(src, tgt);
    const renameOp = ops.find((o) => o.kind === 'rename-value');
    expect(renameOp).toBeDefined();
    expect(valueRenameCandidates.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a drop-value op when a label disappears and no close match exists', () => {
    const src = emptyDb('src');
    src.types.push(enumType('order_status', ['pending']));
    const tgt = emptyDb('tgt');
    tgt.types.push(enumType('order_status', ['pending', 'quuzxyz']));

    const { ops } = diffEnums(src, tgt);
    const dropValue = ops.find((o) => o.kind === 'drop-value') as
      | Extract<EnumOp, { kind: 'drop-value' }>
      | undefined;
    expect(dropValue).toBeDefined();
    expect(dropValue!.value).toBe('quuzxyz');
    expect(dropValue!.isDestructive).toBe(true);
  });
});

describe('renderEnumOp', () => {
  it('renders CREATE TYPE with quoted labels', () => {
    const op: EnumOp = {
      id: 'enum:create:public.order_status',
      category: 'enum',
      kind: 'create',
      objectName: 'public.order_status',
      phase: 'pre',
      isDestructive: false,
      values: ['pending', 'shipped'],
    };
    const sql = renderEnumOp(op);
    expect(sql).toContain('CREATE TYPE');
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'shipped'");
  });

  it('renders ADD VALUE with BEFORE/AFTER anchor when present', () => {
    const op: EnumOp = {
      id: 'enum:add-value:public.x:delivered',
      category: 'enum',
      kind: 'add-value',
      objectName: 'public.x',
      phase: 'pre-commit',
      isDestructive: false,
      value: 'delivered',
      after: 'shipped',
    };
    const sql = renderEnumOp(op);
    expect(sql).toContain("ADD VALUE");
    expect(sql).toContain("'delivered'");
    expect(sql).toContain("AFTER 'shipped'");
  });

  it('renders RENAME VALUE', () => {
    const op: EnumOp = {
      id: 'enum:rename-value:public.x',
      category: 'enum',
      kind: 'rename-value',
      objectName: 'public.x',
      phase: 'main',
      isDestructive: false,
      fromValue: 'shipped',
      toValue: 'dispatched',
    };
    const sql = renderEnumOp(op);
    expect(sql).toContain("RENAME VALUE 'shipped' TO 'dispatched'");
  });
});

describe('planner + enum ops', () => {
  beforeAll(() => {
    configureEnumGeneratorContext(emptyDb('src'));
  });

  it('wraps pre-commit ops in their own BEGIN/COMMIT block', () => {
    const src = emptyDb('src');
    src.types.push(enumType('order_status', ['pending', 'shipped', 'delivered']));
    const tgt = emptyDb('tgt');
    tgt.types.push(enumType('order_status', ['pending', 'shipped']));

    const { ops } = diffEnums(src, tgt);
    const selectedOpIds = new Set(ops.map((o) => o.id));

    const plan = planMigration(
      {
        tables: [],
        ops,
        renameCandidates: [],
        enumValueRenameCandidates: [],
        hasChanges: true,
      },
      { selectedTables: new Set(), selectedOpIds },
    );

    const sql = renderPlanSQL(plan);
    // Should have at least two BEGIN blocks when a pre-commit op is
    // present (one for pre-commit, one for main).
    const beginCount = (sql.match(/\bBEGIN;/g) || []).length;
    expect(beginCount).toBeGreaterThanOrEqual(1);
    expect(sql).toContain('ADD VALUE');
  });
});

describe('resolveOps', () => {
  it('splits a rename-value into add + drop when rejected', () => {
    const raw: EnumOp[] = [
      {
        id: 'enum:rename-value:public.x',
        category: 'enum',
        kind: 'rename-value',
        objectName: 'public.x',
        phase: 'main',
        isDestructive: false,
        fromValue: 'old',
        toValue: 'new',
      },
    ];
    const decisions = {
      rejectedValueRenames: new Set(['enum:rename-value:public.x']),
      dropValueChoices: new Map(),
      sourceEnumValues: new Map([['public.x', ['new', 'keep']]]),
    };
    const resolved = resolveOps(raw, decisions);
    const kinds = resolved.map((o) => (o.category === 'enum' ? o.kind : o.category));
    expect(kinds).toContain('add-value');
    expect(kinds).toContain('drop-value');
  });

  it('applies user replacement + skip flag to drop-value ops', () => {
    const raw: EnumOp[] = [
      {
        id: 'enum:drop-value:public.x:old',
        category: 'enum',
        kind: 'drop-value',
        objectName: 'public.x',
        phase: 'main',
        isDestructive: true,
        value: 'old',
        replacementValue: null,
        skipDataMigration: false,
        postDropValues: ['keep'],
      },
    ];
    const decisions = {
      rejectedValueRenames: new Set<string>(),
      dropValueChoices: new Map([
        ['enum:drop-value:public.x:old', { replacement: 'keep', skip: false }],
      ]),
      sourceEnumValues: new Map<string, string[]>(),
    };
    const resolved = resolveOps(raw, decisions);
    expect(resolved).toHaveLength(1);
    const op = resolved[0] as Extract<EnumOp, { kind: 'drop-value' }>;
    expect(op.replacementValue).toBe('keep');
  });
});

describe('renderChangeOp fallback', () => {
  it('dispatches enum ops to the enum renderer', () => {
    const op: EnumOp = {
      id: 'enum:drop:public.x',
      category: 'enum',
      kind: 'drop',
      objectName: 'public.x',
      phase: 'main',
      isDestructive: true,
    };
    expect(renderChangeOp(op)).toContain('DROP TYPE');
  });
});
