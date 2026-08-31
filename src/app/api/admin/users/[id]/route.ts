import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { user } from '@/db/schema/auth';
import { requireSuperAdmin, isSuperAdminEmail } from '@/lib/superadmin';
import { deleteUserCascade } from '@/lib/admin-delete';

/**
 * Delete a user and everything their organization owns.
 *
 * requireSuperAdmin() is called here and not merely in the (admin) layout: a
 * page render and a later fetch are separate requests, and only the second is
 * what an attacker sends.
 *
 * The route param is a USER id, not an org id.
 */
export async function DELETE(
  _request: Request,
  // Next 16: params is a Promise. Do NOT import RouteContext -- it is ambient.
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const id = (await params).id;

  const rows = await getDb()
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  const target = rows[0];
  if (!target) return Response.json({ error: 'unknown' }, { status: 404 });

  // An allowlisted address is what grants admin in the first place, and the
  // allowlist is matched on the EMAIL, not on a user id -- so deleting this
  // row would not remove anyone's access, it would just free the address for
  // whoever registers it next. The plane's own bootstrap ordering exists
  // because an unclaimed allowlisted address is a prize; this refuses to
  // create one. It also stops an admin removing their own account by
  // misreading a row.
  if (isSuperAdminEmail(target.email)) {
    return Response.json({ error: 'allowlisted' }, { status: 409 });
  }

  const removed = await deleteUserCascade(id);
  return Response.json(removed);
}
