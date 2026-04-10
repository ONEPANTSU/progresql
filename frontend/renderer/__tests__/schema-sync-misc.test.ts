/**
 * Differ / generator tests for the "misc" categories: views, functions,
 * sequences, triggers, domains.
 */

import type { DatabaseInfo, View, Function as PgFunction, Sequence, Trigger, CustomType } from '@/shared/types';
import {
  diffViews,
  diffFunctions,
  diffSequences,
  diffTriggers,
  diffDomains,
  renderChangeOp,
  type ViewOp,
  type RoutineOp,
  type SequenceOp,
  type TriggerOp,
  type DomainOp,
} from '@/features/database-browser/schema-sync';

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

function makeView(name: string, def: string, schema = 'public'): View {
  return {
    view_name: name,
    view_definition: def,
    view_schema: schema,
    view_catalog: 'test',
    is_updatable: false,
    is_insertable_into: false,
    is_trigger_insertable_into: false,
  };
}

function makeFunction(name: string, def: string, schema = 'public'): PgFunction {
  return {
    routine_name: name,
    routine_type: 'FUNCTION',
    data_type: 'text',
    routine_schema: schema,
    routine_catalog: 'test',
    is_deterministic: true,
    sql_data_access: 'CONTAINS',
    is_null_call: false,
    security_type: 'INVOKER',
    routine_definition: def,
  };
}

function makeSequence(name: string, schema = 'public', overrides: Partial<Sequence> = {}): Sequence {
  return {
    sequence_name: name,
    sequence_schema: schema,
    sequence_catalog: 'test',
    data_type: 'bigint',
    start_value: 1,
    minimum_value: 1,
    maximum_value: 9223372036854775807,
    increment: 1,
    cycle_option: false,
    cache_size: 1,
    ...overrides,
  };
}

function makeTrigger(name: string, table: string, action: string): Trigger {
  return {
    trigger_name: name,
    table_name: table,
    event_manipulation: 'INSERT',
    event_object_schema: 'public',
    event_object_table: table,
    action_statement: action,
    action_timing: 'BEFORE',
    action_orientation: 'ROW',
  };
}

function makeDomain(name: string, baseType: string, schema = 'public'): CustomType {
  return {
    name,
    schema,
    owner: 'test',
    // NB: type_category reflects the base-type category (e.g. 'N' for
    // numeric-backed domains). The schema-sync domain differ keys off
    // `type_type === 'd'` instead, because type_category is not a
    // reliable "is this a domain?" predicate.
    type_category: 'N',
    type_type: 'd',
    is_preferred: false,
    is_instantiable: true,
    base_type: baseType,
  };
}

// ---------- Views ---------------------------------------------------------

describe('diffViews', () => {
  it('emits CREATE for new views', () => {
    const src = emptyDb('src');
    src.views.push(makeView('active_users', 'SELECT * FROM users WHERE active'));
    const tgt = emptyDb('tgt');
    const { ops } = diffViews(src, tgt);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('create');
  });

  it('emits REPLACE when definition changes', () => {
    const src = emptyDb('src');
    src.views.push(makeView('v', 'SELECT a, b FROM t'));
    const tgt = emptyDb('tgt');
    tgt.views.push(makeView('v', 'SELECT a FROM t'));
    const { ops } = diffViews(src, tgt);
    const replace = ops.find((o) => o.kind === 'replace') as Extract<ViewOp, { kind: 'replace' }>;
    expect(replace).toBeDefined();
    // Column list changed -> forceRecreate
    expect(replace.forceRecreate).toBe(true);
  });

  it('detects a view rename with identical body as high confidence', () => {
    const src = emptyDb('src');
    src.views.push(makeView('active_users_v2', 'SELECT * FROM users WHERE active'));
    const tgt = emptyDb('tgt');
    tgt.views.push(makeView('active_users', 'SELECT * FROM users WHERE active'));
    const { ops, renameCandidates } = diffViews(src, tgt);
    const rename = ops.find((o) => o.kind === 'rename');
    expect(rename).toBeDefined();
    expect(renameCandidates[0].confidence).toBeGreaterThan(0.7);
  });
});

// ---------- Functions -----------------------------------------------------

describe('diffFunctions', () => {
  it('emits REPLACE when function body changes', () => {
    const src = emptyDb('src');
    src.functions.push(makeFunction('foo', 'SELECT 2'));
    const tgt = emptyDb('tgt');
    tgt.functions.push(makeFunction('foo', 'SELECT 1'));
    const { ops } = diffFunctions(src, tgt);
    expect(ops.some((o) => o.kind === 'replace')).toBe(true);
  });

  it('emits DROP + CREATE when name changes without rename detection match', () => {
    const src = emptyDb('src');
    src.functions.push(makeFunction('zzzxxx', 'SELECT 1'));
    const tgt = emptyDb('tgt');
    tgt.functions.push(makeFunction('aaabbb', 'SELECT 99'));
    const { ops } = diffFunctions(src, tgt);
    const kinds = ops.map((o) => o.kind).sort();
    expect(kinds).toEqual(['create', 'drop']);
  });
});

// ---------- Sequences -----------------------------------------------------

describe('diffSequences', () => {
  it('emits ALTER when increment or bounds change', () => {
    const src = emptyDb('src');
    src.sequences.push(makeSequence('s', 'public', { increment: 5 }));
    const tgt = emptyDb('tgt');
    tgt.sequences.push(makeSequence('s', 'public', { increment: 1 }));
    const { ops } = diffSequences(src, tgt);
    const alter = ops.find((o) => o.kind === 'alter') as Extract<SequenceOp, { kind: 'alter' }>;
    expect(alter).toBeDefined();
    expect(alter.changes.increment).toBe(5);
  });

  it('renders CREATE SEQUENCE with non-default clauses', () => {
    const op: SequenceOp = {
      id: 'sequence:create:public.s',
      category: 'sequence',
      kind: 'create',
      objectName: 'public.s',
      phase: 'main',
      isDestructive: false,
      attrs: { startValue: 10, increment: 2, cycle: true, dataType: 'integer' },
    };
    const sql = renderChangeOp(op);
    expect(sql).toContain('CREATE SEQUENCE');
    expect(sql).toContain('AS integer');
    expect(sql).toContain('START WITH 10');
    expect(sql).toContain('INCREMENT BY 2');
    expect(sql).toContain('CYCLE');
  });
});

// ---------- Triggers ------------------------------------------------------

describe('diffTriggers', () => {
  it('emits REPLACE (destructive) when the action body changes', () => {
    const src = emptyDb('src');
    src.triggers.push(makeTrigger('trg_audit', 'users', 'EXECUTE FUNCTION audit_v2()'));
    const tgt = emptyDb('tgt');
    tgt.triggers.push(makeTrigger('trg_audit', 'users', 'EXECUTE FUNCTION audit_v1()'));
    const { ops } = diffTriggers(src, tgt);
    const replace = ops.find((o) => o.kind === 'replace') as Extract<TriggerOp, { kind: 'replace' }>;
    expect(replace).toBeDefined();
    expect(replace.isDestructive).toBe(true);
    expect(replace.tableName).toBe('public.users');
  });

  it('renders DROP TRIGGER ... ON table for drop ops', () => {
    const op: TriggerOp = {
      id: 'trigger:drop:public.users.trg_audit',
      category: 'trigger',
      kind: 'drop',
      objectName: 'public.users.trg_audit',
      phase: 'main',
      isDestructive: true,
      tableName: 'public.users',
    };
    const sql = renderChangeOp(op);
    expect(sql).toContain('DROP TRIGGER');
    expect(sql).toContain('ON');
    expect(sql).toContain('users');
  });
});

// ---------- Domains -------------------------------------------------------

describe('diffDomains', () => {
  it('emits CREATE DOMAIN for new domains', () => {
    const src = emptyDb('src');
    src.types.push(makeDomain('positive_int', 'integer'));
    const tgt = emptyDb('tgt');
    const { ops } = diffDomains(src, tgt);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('create');
    expect((ops[0] as Extract<DomainOp, { kind: 'create' }>).baseType).toBe('integer');
  });

  it('rebuilds a domain when the base type changes', () => {
    const src = emptyDb('src');
    src.types.push(makeDomain('pi', 'bigint'));
    const tgt = emptyDb('tgt');
    tgt.types.push(makeDomain('pi', 'integer'));
    const { ops } = diffDomains(src, tgt);
    const kinds = ops.map((o) => o.kind).sort();
    expect(kinds).toEqual(['rebuild']);
  });
});
