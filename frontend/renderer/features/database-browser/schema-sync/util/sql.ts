/**
 * Low-level SQL identifier / literal helpers used by every generator.
 *
 * Kept deliberately small and dependency-free so that differs/generators can
 * import them without pulling in React or MUI. Anything that needs to format a
 * Postgres identifier, qualified name, or column type goes here.
 */

import type { Column } from '@/shared/types';

/** Quote a bare identifier — escapes embedded double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a potentially schema-qualified name like "myschema.mytable".
 * If `name` contains no dot, the unqualified identifier is returned.
 */
export function quoteQualifiedName(name: string): string {
  if (name.includes('.')) {
    const [schema, rest] = name.split('.', 2);
    return `${quoteIdent(schema)}.${quoteIdent(rest)}`;
  }
  return quoteIdent(name);
}

/**
 * Quote a literal string for embedding inside SQL (`'foo''bar'`).
 * Used for enum labels, function bodies, etc.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the type portion of a column declaration, honouring
 * character_maximum_length / numeric_precision when applicable.
 *
 * `data_type` coming from `pg_catalog.format_type(atttypid, atttypmod)` may
 * already include parameters — e.g. `numeric(10,2)`, `character varying(255)`.
 * In that case we must NOT append them a second time.
 */
export function columnTypeSQL(col: Column): string {
  let t = col.data_type;
  // If the type string already contains parenthesised parameters, skip.
  if (/\(.*\)/.test(t)) return t;
  if (col.character_maximum_length) {
    t += `(${col.character_maximum_length})`;
  } else if (col.numeric_precision && col.data_type.toLowerCase().includes('numeric')) {
    t += `(${col.numeric_precision}${col.numeric_scale ? `, ${col.numeric_scale}` : ''})`;
  }
  return t;
}
