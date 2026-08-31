import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { invites } from '@/db/schema/devices';
import { requireSuperAdmin } from '@/lib/superadmin';
import { normalizeInviteCode } from '@/lib/invites';

/**
 * Revoke an unconsumed invite code.
 *
 * Deletes ONLY where consumed_at is null. A consumed row is the record that
 * an account was created against this code, so it is not the operator's to
 * quietly erase -- and silently answering 204 would tell them they had
 * revoked something when what they actually had was a user. 409 says which.
 *
 * 404 for a code that does not exist. The delete and the disambiguating read
 * are two statements, which is a benign race here: the only writer that can
 * turn a live row into a consumed one is a sign-up, and if it lands between
 * them the operator gets 409 -- the truthful answer, arrived at late.
 */
export async function DELETE(
  _request: Request,
  // Next 16: params is a Promise. Do NOT import RouteContext -- it is ambient.
  { params }: { params: Promise<{ code: string }> },
) {
  await requireSuperAdmin();

  // Normalized on the way in, the same as at redemption, so a code copied
  // with stray whitespace or in the wrong case still revokes.
  const code = normalizeInviteCode((await params).code);
  const db = getDb();

  const deleted = await db
    .delete(invites)
    .where(and(eq(invites.code, code), isNull(invites.consumedAt)))
    .returning({ code: invites.code });

  if (deleted.length > 0) return new Response(null, { status: 204 });

  const existing = await db
    .select({ code: invites.code })
    .from(invites)
    .where(eq(invites.code, code))
    .limit(1);

  // It exists but the delete did not match it, so it is consumed.
  if (existing.length > 0) return Response.json({ error: 'consumed' }, { status: 409 });
  return Response.json({ error: 'unknown' }, { status: 404 });
}
