import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

type OrgScoped = PgTable & { orgId: PgColumn };

/**
 * The single chokepoint for tenant isolation. Every catalog read and write
 * goes through this; an empty org id throws rather than silently matching
 * every row in the table.
 */
export function orgFilter<T extends OrgScoped>(table: T, orgId: string, extra?: SQL): SQL {
  if (!orgId) throw new Error('orgFilter: refusing to build a query with an empty org id');
  const base = eq(table.orgId, orgId);
  return extra ? and(base, extra)! : base;
}
