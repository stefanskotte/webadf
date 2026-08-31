import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

/** Pure. Exported for tests; nothing else should call it. */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Pure. The whole decision. */
export function isAllowed(email: string | undefined, raw: string | undefined): boolean {
  if (!email) return false;
  const list = parseAllowlist(raw);
  // An empty allowlist denies everyone. The opposite default -- "nothing
  // configured, so allow" -- is a plausible reading of the same idea and
  // would hand every tenant's data to the first person who signs up.
  if (list.length === 0) return false;
  return list.includes(email.trim().toLowerCase());
}

/**
 * Mirrors requireOrg()'s shape deliberately -- but returns NO orgId.
 *
 * `auth` is imported dynamically here, not at module top level: `@/lib/auth`
 * eagerly calls getDb() as a module-level side effect (see src/db/index.ts),
 * which throws when DATABASE_URL is unset. Vitest never sets it here. A
 * static top-level import would make even importing parseAllowlist/isAllowed
 * for unit tests blow up, so the DB-touching dependency is deferred to call
 * time, keeping the two pure functions above genuinely import-safe without a
 * database.
 */
export async function requireSuperAdmin(): Promise<{ userId: string; email: string }> {
  const { auth } = await import('@/lib/auth');
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) redirect('/sign-in');
  if (!isAllowed(result.user.email, process.env.SUPERADMIN_EMAILS)) {
    // /library, not notFound(): a 404 here would confirm to a signed-in
    // non-admin that /admin exists and they merely lack access.
    redirect('/library');
  }
  return { userId: result.user.id, email: result.user.email };
}
