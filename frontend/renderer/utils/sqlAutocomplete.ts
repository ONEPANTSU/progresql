import type { SQLNamespace } from '@codemirror/lang-sql';
import type { DatabaseInfo } from '../types';

/**
 * Convert DatabaseInfo to CodeMirror SQLNamespace for autocomplete.
 * Supports: schemas → tables → columns, views, functions.
 */
export function buildSQLSchema(dbInfo: DatabaseInfo | null | undefined): SQLNamespace {
  if (!dbInfo) return {};

  const schema: Record<string, SQLNamespace> = {};

  // Add tables with their columns
  for (const table of dbInfo.tables ?? []) {
    const key = table.table_schema && table.table_schema !== 'public'
      ? `${table.table_schema}.${table.table_name}`
      : table.table_name;

    const columns: string[] = (table.columns ?? []).map(col => col.column_name);
    schema[key] = columns;

    // Also add schema-qualified version for public tables
    if (table.table_schema === 'public') {
      schema[`public.${table.table_name}`] = columns;
    }
  }

  // Add views (no columns, but completable as table-like entities)
  for (const view of dbInfo.views ?? []) {
    const key = view.view_schema && view.view_schema !== 'public'
      ? `${view.view_schema}.${view.view_name}`
      : view.view_name;

    if (!schema[key]) {
      schema[key] = [];
    }
  }

  // Add functions as completable names
  for (const fn of dbInfo.functions ?? []) {
    const key = fn.routine_schema && fn.routine_schema !== 'public'
      ? `${fn.routine_schema}.${fn.routine_name}`
      : fn.routine_name;

    if (!schema[key]) {
      schema[key] = [];
    }
  }

  return schema;
}
