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

/**
 * Non-redirecting variant, for deciding whether to RENDER something (the
 * app shell's Admin nav link) rather than whether to ALLOW something.
 *
 * It takes the email the caller already has instead of fetching a session,
 * so the app layout does not pay a second getSession() round trip on every
 * page just to decide whether to draw one link. It still reads
 * SUPERADMIN_EMAILS here rather than in the caller, which keeps this file
 * the single place that configuration enters the system.
 *
 * This is NOT an access check and must never be used as one. Hiding a link
 * is not a guard: requireSuperAdmin() is, and every admin page and every
 * /api/admin route calls it for itself. What this does buy is the
 * non-disclosure property the plane is specified with -- a non-admin is
 * redirected to /library rather than 404'd so the response never confirms
 * /admin exists, and a nav link rendered for everyone would have given that
 * away in the markup regardless.
 */
export function isSuperAdminEmail(email: string | undefined): boolean {
  return isAllowed(email, process.env.SUPERADMIN_EMAILS);
}
