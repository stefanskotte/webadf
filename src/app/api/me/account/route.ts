import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { stepUpGate } from '@/lib/step-up-gate';
import { deleteUserCascade, otherMemberCount } from '@/lib/admin-delete';

/**
 * Delete your own account (A2, Settings > Delete account): the same cascade the admin delete runs -- titles, disks,
 * collections, boards, uploads, invites, then the user and their sessions. Shared disk files (blobs) are never
 * touched. A deleted board's next check-in gets 401, which the firmware takes as "erase the token and pair again".
 *
 * Guarded three ways: DELETE typed out (checked first, so a slip of the hand costs no password attempt), the
 * password through the same throttled step-up gate as a firmware update (a stolen session cookie must not be enough
 * to wipe a library), and a refusal while anyone else is a member of the organization.
 *
 *   DELETE { password, confirm: "DELETE" } -> 200 { ok } | 400 | 401 bad_password | 409 shared_organization | 429
 */
const body = z.object({ password: z.string().min(1).max(200), confirm: z.literal('DELETE') });

// The password check plus the cascade's transaction.
export const maxDuration = 60;

export async function DELETE(request: Request) {
  const { userId } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });

  const refused = await stepUpGate(userId, parsed.data.password);
  if (refused) return refused;

  if ((await otherMemberCount(userId)) > 0) {
    return Response.json({ error: 'shared_organization' }, { status: 409 });
  }

  const result = await deleteUserCascade(userId);
  console.info(`[account] user ${userId} deleted their account`, result);
  return Response.json({ ok: true });
}
