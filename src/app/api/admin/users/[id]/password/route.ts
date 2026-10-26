import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/superadmin';
import { stepUpGate } from '@/lib/step-up-gate';
import { generateTempPassword, resetUserPassword } from '@/lib/admin-password-reset';

const Body = z.object({ password: z.string().min(1).max(256) }).strict();

/**
 * An admin gives another account a new password (operator 2026-10-26). The server generates it and answers it ONCE;
 * the admin hands it to the user, who can change it in Settings › Account. The user is signed out everywhere.
 *
 * The ADMIN's own current password is required, through the same throttled step-up gate as the firmware update: an
 * admin session cookie is otherwise the key to every account on the server, and a stolen one must not be enough.
 * requireSuperAdmin() is called here and not merely in the (admin) layout -- the fetch is its own request.
 *
 * The admin's own account is refused: changing your own password is Settings › Account, which asks for the current
 * one, and a reset here would sign the admin out mid-task. The route param is a USER id.
 */
export async function POST(
  request: Request,
  // Next 16: params is a Promise. Do NOT import RouteContext -- it is ambient.
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireSuperAdmin();
  const id = (await params).id;

  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'bad_request' }, { status: 400 }); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'bad_request' }, { status: 400 });

  const refused = await stepUpGate(admin.userId, parsed.data.password);
  if (refused) return refused;

  if (id === admin.userId) return Response.json({ error: 'self' }, { status: 409 });

  const password = generateTempPassword();
  const result = await resetUserPassword(id, password);
  if (result === 'unknown') return Response.json({ error: 'unknown' }, { status: 404 });
  if (result === 'no_password') return Response.json({ error: 'no_password' }, { status: 409 });
  return Response.json({ password }, { headers: { 'cache-control': 'no-store' } });
}
