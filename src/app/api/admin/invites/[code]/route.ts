import { requireSuperAdmin } from '@/lib/superadmin';
import { revokeInvite } from '@/lib/invites';

/**
 * Revoke an unconsumed invite code.
 *
 * Sets revoked_at (the row stays, so the list shows it as Revoked). Revoking
 * an already revoked code is 204 again. A consumed row is the record that an
 * account was created against this code, so it is not the operator's to
 * quietly erase -- 409 says which. 404 for a code that does not exist.
 */
export async function DELETE(
  _request: Request,
  // Next 16: params is a Promise. Do NOT import RouteContext -- it is ambient.
  { params }: { params: Promise<{ code: string }> },
) {
  await requireSuperAdmin();

  // revokeInvite normalizes, the same as at redemption, so a code copied with
  // stray whitespace or in the wrong case still revokes.
  const result = await revokeInvite((await params).code);
  if (result === 'revoked') return new Response(null, { status: 204 });
  if (result === 'consumed') return Response.json({ error: 'consumed' }, { status: 409 });
  return Response.json({ error: 'unknown' }, { status: 404 });
}
