// The one place Amiga names are folded for comparison (plan 2026-11-01-net-consistency, item 7). AmigaDOS compares names
// case-insensitively with international folding: ASCII and the Latin-1 capitals À-Þ (but ×) are their small letters.
// Postgres's lower() folds only what the database's collation knows -- ASCII alone under C -- so lower() alone, or a
// JS toLowerCase() against it, misses Ä, Ö, Ü, Å, É… Every comparison of remembered Amiga paths folds both sides with
// this, in SQL, whatever the collation. SERVER ONLY (drizzle).
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

const UPPER = 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ';
const LOWER = 'àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþ';

/** `x` (a column, an expression, or a value bound as a parameter) folded as AmigaDOS folds names. */
export const amigaFoldSql = (x: SQLWrapper | string): SQL => sql`translate(lower(${x}::text), ${UPPER}::text, ${LOWER}::text)`;
