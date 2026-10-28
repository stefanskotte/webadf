import { requireOrg } from '@/lib/session';
import { revokeShare } from '@/lib/share/store';

export const maxDuration = 60;

/** Revoke: the recipient loses access at once. Idempotent. Another org's share: 404. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const ok = await revokeShare(orgId, id);
  return ok ? Response.json({ ok: true }) : Response.json({ error: 'not_found' }, { status: 404 });
}
