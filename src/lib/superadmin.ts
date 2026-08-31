import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { isAllowed } from '@/lib/superadmin-allowlist';

/**
 * Mirrors requireOrg()'s shape deliberately -- but returns NO orgId.
 *
 * SUPERADMIN_EMAILS is read HERE, and only here: superadmin-allowlist.ts's
 * isAllowed()/parseAllowlist() take the raw string as a parameter and read
 * no environment variables themselves, so this is the single place the
 * allowlist configuration enters the system.
 */
export async function requireSuperAdmin(): Promise<{ userId: string; email: string }> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) redirect('/sign-in');
  if (!isAllowed(result.user.email, process.env.SUPERADMIN_EMAILS)) {
    // /library, not notFound(): a 404 here would confirm to a signed-in
    // non-admin that /admin exists and they merely lack access.
    redirect('/library');
  }
  return { userId: result.user.id, email: result.user.email };
}
