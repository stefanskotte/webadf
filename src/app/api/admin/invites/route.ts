import { requireSuperAdmin } from '@/lib/superadmin';
import { requireOrg } from '@/lib/session';
import { issueInvite } from '@/lib/invites';

/**
 * Issue an invite code.
 *
 * requireSuperAdmin() is called HERE, not merely in the (admin) layout. The
 * page guard is not the API guard: a page render and a later fetch are
 * separate requests, and only the second is what an attacker sends. It
 * redirects rather than returning JSON, which is this codebase's established
 * convention for an unauthenticated API caller (see the anonymous-caller test
 * in e2e/mount-actions.spec.ts, which asserts a 307 to /sign-in) -- and for a
 * non-admin it redirects to /library, so the response still never confirms
 * that /api/admin exists.
 *
 * requireOrg() then supplies the org to bill the invite to. requireSuperAdmin
 * deliberately returns no orgId -- an admin acts across tenants and has no
 * "current" one in that role -- but an invite row needs an issuer, and the
 * operator is an ordinary user of this app too, with an organization of their
 * own. That is the one it gets.
 */
export async function POST() {
  await requireSuperAdmin();
  const { userId, orgId } = await requireOrg();
  const code = await issueInvite(orgId, userId);
  return Response.json({ code });
}
