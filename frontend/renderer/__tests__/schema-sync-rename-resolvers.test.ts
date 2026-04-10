/**
 * Unit tests for the rename resolution helpers introduced in Phase 11d.
 *
 * Covers:
 *   - `resolveOps` for view/routine/domain rename modes (accept/split/keep-both)
 *   - `resolveTableRenames` for the legacy TableDiff[] model
 *
 * Each test walks through the minimum ChangeOp/TableDiff shape needed to
 * trigger the resolver and asserts the synthesised op ids + kinds. We don't
 * care about SQL rendering here — that's covered by the generator tests.
 */

import {
  resolveOps,
  resolveTableRenames,
  type RenameMode,
  type UserDecisions,
} from '@/features/database-browser/schema-sync';
import type {
  ChangeOp,
  EnumOp,
  ViewOp,
  RoutineOp,
  DomainOp,
  TableDiff,
  Column,
} from '@/features/database-browser/schema-sync';

function emptyDecisions(
  renameResolutions?: Map<string, RenameMode>,
): UserDecisions {
  return {
    rejectedValueRenames: new Set(),
    dropValueChoices: new Map(),
    sourceEnumValues: new Map(),
    renameResolutions,
  };
}

describe('resolveOps — view rename modes', () => {
  const viewRename: Extract<ViewOp, { kind: 'rename' }> = {
    id: 'view:rename:users_old->users_new',
    category: 'view',
    kind: 'rename',
    objectName: 'users_new',
    phase: 'main',
    isDestructive: false,
    label: 'RENAME VIEW users_old -> users_new',
    fromName: 'users_old',
    toName: 'users_new',
    definition: 'SELECT id, name FROM app_users',
  };

  test('accept mode (default) keeps the original rename op', () => {
    const out = resolveOps([viewRename], emptyDecisions());
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(viewRename);
  });

  test('split mode synthesises drop + create', () => {
    const modes = new Map<string, RenameMode>([[viewRename.id, 'split']]);
    const out = resolveOps([viewRename], emptyDecisions(modes)) as ViewOp[];
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('drop');
    expect(out[0].objectName).toBe('users_old');
    expect(out[0].isDestructive).toBe(true);
    expect(out[0].id).toBe(`${viewRename.id}:split-drop`);
    expect(out[1].kind).toBe('create');
    expect(out[1].objectName).toBe('users_new');
    expect(out[1].id).toBe(`${viewRename.id}:split-create`);
  });

  test('keep-both mode emits only a create for the new name', () => {
    const modes = new Map<string, RenameMode>([[viewRename.id, 'keep-both']]);
    const out = resolveOps([viewRename], emptyDecisions(modes)) as ViewOp[];
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('create');
    expect(out[0].objectName).toBe('users_new');
    expect(out[0].id).toBe(`${viewRename.id}:split-create`);
  });

  test('falls back to accept when definition is missing', () => {
    const bare: ViewOp = { ...viewRename, definition: undefined };
    const modes = new Map<string, RenameMode>([[bare.id, 'split']]);
    const out = resolveOps([bare], emptyDecisions(modes));
    expect(out).toEqual([bare]);
  });
});

describe('resolveOps — routine rename modes', () => {
  const fnRename: Extract<RoutineOp, { kind: 'rename' }> = {
    id: 'function:rename:foo->bar',
    category: 'function',
    kind: 'rename',
    objectName: 'bar',
    phase: 'main',
    isDestructive: false,
    label: 'RENAME FUNCTION foo -> bar',
    fromName: 'foo',
    toName: 'bar',
    definition: 'CREATE FUNCTION bar() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
    argSignature: '',
    language: 'sql',
  };

  test('split emits drop + create with matching category', () => {
    const modes = new Map<string, RenameMode>([[fnRename.id, 'split']]);
    const out = resolveOps([fnRename], emptyDecisions(modes)) as RoutineOp[];
    expect(out).toHaveLength(2);
    expect(out[0].category).toBe('function');
    expect(out[0].kind).toBe('drop');
    expect(out[0].objectName).toBe('foo');
    expect(out[1].kind).toBe('create');
    expect(out[1].objectName).toBe('bar');
  });

  test('keep-both emits only a create', () => {
    const modes = new Map<string, RenameMode>([[fnRename.id, 'keep-both']]);
    const out = resolveOps([fnRename], emptyDecisions(modes)) as RoutineOp[];
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('create');
    expect(out[0].objectName).toBe('bar');
  });

  test('procedure rename uses procedure category in synthesised ops', () => {
    const procRename: Extract<RoutineOp, { kind: 'rename' }> = {
      ...fnRename,
      id: 'procedure:rename:p_old->p_new',
      category: 'procedure',
      fromName: 'p_old',
      toName: 'p_new',
      objectName: 'p_new',
    };
    const modes = new Map<string, RenameMode>([[procRename.id, 'split']]);
    const out = resolveOps([procRename], emptyDecisions(modes)) as RoutineOp[];
    expect(out.every((o) => o.category === 'procedure')).toBe(true);
  });
});

describe('resolveOps — domain rename modes', () => {
  const domRename: Extract<DomainOp, { kind: 'rename' }> = {
    id: 'domain:rename:email_old->email_new',
    category: 'domain',
    kind: 'rename',
    objectName: 'email_new',
    phase: 'main',
    isDestructive: false,
    label: 'RENAME DOMAIN email_old -> email_new',
    fromName: 'email_old',
    toName: 'email_new',
    baseType: 'text',
  };

  test('split emits drop + create', () => {
    const modes = new Map<string, RenameMode>([[domRename.id, 'split']]);
    const out = resolveOps([domRename], emptyDecisions(modes)) as DomainOp[];
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('drop');
    expect(out[1].kind).toBe('create');
    expect((out[1] as Extract<DomainOp, { kind: 'create' }>).baseType).toBe('text');
  });

  test('keep-both emits only a create', () => {
    const modes = new Map<string, RenameMode>([[domRename.id, 'keep-both']]);
    const out = resolveOps([domRename], emptyDecisions(modes)) as DomainOp[];
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('create');
  });
});

describe('resolveOps — enum rename-type op (pass-through)', () => {
  // Enum type-level renames don't support the same three-way resolver
  // as view/routine/domain renames because Postgres is happy with
  // `ALTER TYPE ... RENAME TO ...` and there's no CREATE-from-definition
  // fallback. The resolver should leave the op untouched regardless of
  // whether a mode is set in `renameResolutions`.
  const typeRename: Extract<EnumOp, { kind: 'rename-type' }> = {
    id: 'enum:rename-type:old_enum->new_enum',
    category: 'enum',
    kind: 'rename-type',
    objectName: 'new_enum',
    phase: 'main',
    isDestructive: false,
    label: 'RENAME TYPE old_enum -> new_enum',
    fromName: 'old_enum',
    toName: 'new_enum',
  };

  test('passes through with no decisions', () => {
    const out = resolveOps([typeRename], emptyDecisions());
    expect(out).toEqual([typeRename]);
  });

  test('passes through even if a split mode is set (enum rename-type is not resolvable)', () => {
    // The resolver only dispatches on view/function/procedure/domain, so
    // setting a mode for an enum rename-type id is a no-op.
    const modes = new Map<string, RenameMode>([[typeRename.id, 'split']]);
    const out = resolveOps([typeRename], emptyDecisions(modes));
    expect(out).toEqual([typeRename]);
  });
});

describe('resolveOps — enum rename-value rejection (splits to add + drop)', () => {
  // Value-level renames have a simpler two-state resolver: either the user
  // accepts the rename (default) or rejects it, which expands into an
  // ADD VALUE + DROP VALUE pair using the captured source-side ordering.
  const renameValue: Extract<EnumOp, { kind: 'rename-value' }> = {
    id: 'enum:rename-value:shipment_status:std_ship->standard_shipping',
    category: 'enum',
    kind: 'rename-value',
    objectName: 'shipment_status',
    phase: 'main',
    isDestructive: false,
    label: 'RENAME VALUE shipment_status std_ship -> standard_shipping',
    fromValue: 'std_ship',
    toValue: 'standard_shipping',
  };

  test('not rejected → passes through', () => {
    const out = resolveOps([renameValue], emptyDecisions());
    expect(out).toEqual([renameValue]);
  });

  test('rejected → expands to add-value + drop-value with split ids', () => {
    const decisions: UserDecisions = {
      rejectedValueRenames: new Set([renameValue.id]),
      dropValueChoices: new Map(),
      sourceEnumValues: new Map([
        ['shipment_status', ['pending', 'standard_shipping', 'delivered']],
      ]),
    };
    const out = resolveOps([renameValue], decisions) as EnumOp[];
    expect(out).toHaveLength(2);

    const add = out[0] as Extract<EnumOp, { kind: 'add-value' }>;
    expect(add.kind).toBe('add-value');
    expect(add.value).toBe('standard_shipping');
    expect(add.id).toBe(`${renameValue.id}:split-add`);
    // BEFORE/AFTER anchors come from the source-side ordering.
    expect(add.before).toBe('pending');
    expect(add.after).toBe('delivered');

    const drop = out[1] as Extract<EnumOp, { kind: 'drop-value' }>;
    expect(drop.kind).toBe('drop-value');
    expect(drop.value).toBe('std_ship');
    expect(drop.id).toBe(`${renameValue.id}:split-drop`);
    expect(drop.isDestructive).toBe(true);
  });

  test('rejected with no source ordering → add has no anchors', () => {
    const decisions: UserDecisions = {
      rejectedValueRenames: new Set([renameValue.id]),
      dropValueChoices: new Map(),
      sourceEnumValues: new Map(),
    };
    const out = resolveOps([renameValue], decisions) as EnumOp[];
    const add = out[0] as Extract<EnumOp, { kind: 'add-value' }>;
    expect(add.kind).toBe('add-value');
    expect(add.before).toBeUndefined();
    expect(add.after).toBeUndefined();
  });
});

describe('resolveOps — enum drop-value choice application', () => {
  // When the user picks a replacement label (or opts to skip the data
  // migration), the resolver should merge those fields into the op without
  // changing its id or kind.
  const dropValue: Extract<EnumOp, { kind: 'drop-value' }> = {
    id: 'enum:drop-value:task_priority:obsolete',
    category: 'enum',
    kind: 'drop-value',
    objectName: 'task_priority',
    phase: 'main',
    isDestructive: true,
    label: "DROP VALUE task_priority 'obsolete'",
    value: 'obsolete',
    replacementValue: null,
    skipDataMigration: false,
    postDropValues: ['low', 'medium', 'high'],
  };

  test('no choice → passes through unchanged', () => {
    const out = resolveOps([dropValue], emptyDecisions());
    expect(out).toEqual([dropValue]);
  });

  test('replacement label is merged into op', () => {
    const decisions: UserDecisions = {
      rejectedValueRenames: new Set(),
      dropValueChoices: new Map([
        [dropValue.id, { replacement: 'high', skip: false }],
      ]),
      sourceEnumValues: new Map(),
    };
    const out = resolveOps([dropValue], decisions) as EnumOp[];
    expect(out).toHaveLength(1);
    const resolved = out[0] as Extract<EnumOp, { kind: 'drop-value' }>;
    expect(resolved.replacementValue).toBe('high');
    expect(resolved.skipDataMigration).toBe(false);
    expect(resolved.id).toBe(dropValue.id);
  });

  test('skip data migration flag is honoured', () => {
    const decisions: UserDecisions = {
      rejectedValueRenames: new Set(),
      dropValueChoices: new Map([
        [dropValue.id, { replacement: null, skip: true }],
      ]),
      sourceEnumValues: new Map(),
    };
    const out = resolveOps([dropValue], decisions) as EnumOp[];
    const resolved = out[0] as Extract<EnumOp, { kind: 'drop-value' }>;
    expect(resolved.skipDataMigration).toBe(true);
    expect(resolved.replacementValue).toBeNull();
  });
});

describe('resolveOps — non-rename ops pass through unchanged', () => {
  test('alter-table and create-view ops are not touched', () => {
    const createView: ViewOp = {
      id: 'view:create:v1',
      category: 'view',
      kind: 'create',
      objectName: 'v1',
      phase: 'main',
      isDestructive: false,
      label: 'CREATE VIEW v1',
      definition: 'SELECT 1',
    };
    const out = resolveOps([createView] as ChangeOp[], emptyDecisions());
    expect(out).toEqual([createView]);
  });
});

describe('resolveTableRenames — legacy TableDiff[] resolver', () => {
  const col = (name: string): Column => ({
    table_name: 'users_v2',
    column_name: name,
    data_type: 'text',
    is_nullable: 'YES',
    column_default: null,
    udt_name: 'text',
    ordinal_position: 1,
    is_identity: false,
  });

  const renameDiff: TableDiff = {
    tableName: 'users_v2',
    kind: 'rename',
    renamedFrom: 'users',
    columns: [],
    indexes: [],
    constraints: [],
    isDestructive: false,
    sourceColumns: [col('id'), col('name')],
    sourceIndexes: [],
    sourceConstraints: [],
  };

  test('empty map is a no-op', () => {
    const out = resolveTableRenames([renameDiff], new Map());
    expect(out).toBe([renameDiff].length === 1 ? out : out); // identity-ish
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(renameDiff);
  });

  test('accept mode keeps rename diff unchanged', () => {
    const modes = new Map<string, RenameMode>([[renameDiff.tableName, 'accept']]);
    const out = resolveTableRenames([renameDiff], modes);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(renameDiff);
  });

  test('split mode emits drop(renamedFrom) + add(tableName)', () => {
    const modes = new Map<string, RenameMode>([[renameDiff.tableName, 'split']]);
    const out = resolveTableRenames([renameDiff], modes);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('drop');
    expect(out[0].tableName).toBe('users');
    expect(out[0].isDestructive).toBe(true);
    expect(out[1].kind).toBe('add');
    expect(out[1].tableName).toBe('users_v2');
    expect(out[1].columns).toHaveLength(2);
    expect(out[1].columns[0].kind).toBe('add');
  });

  test('keep-both mode emits add(tableName) only', () => {
    const modes = new Map<string, RenameMode>([[renameDiff.tableName, 'keep-both']]);
    const out = resolveTableRenames([renameDiff], modes);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('add');
    expect(out[0].tableName).toBe('users_v2');
    expect(out[0].columns).toHaveLength(2);
  });

  test('falls back to accept when source columns are missing', () => {
    const bare: TableDiff = { ...renameDiff, sourceColumns: undefined };
    const modes = new Map<string, RenameMode>([[bare.tableName, 'split']]);
    const out = resolveTableRenames([bare], modes);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(bare);
  });

  test('non-rename table diffs pass through unchanged', () => {
    const add: TableDiff = {
      tableName: 'orders',
      kind: 'add',
      columns: [],
      indexes: [],
      constraints: [],
      isDestructive: false,
    };
    const modes = new Map<string, RenameMode>([['orders', 'split']]);
    const out = resolveTableRenames([add], modes);
    expect(out).toEqual([add]);
  });
});
