import { requireOrg } from '@/lib/session';
import { deleteShare, listShares, updateShareScope } from '@/lib/share/store';
import { readBody, scopeBody } from '../body';

export const maxDuration = 60;

const NOT_FOUND = () => Response.json({ error: 'not_found' }, { status: 404 });

/** Edit collections: Everything, or a set of this org's collections. Revoked or another org's share: 404. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const body = await readBody(request, scopeBody);
  if (!body.ok) return body.res;
  if (!body.data.everything && body.data.collectionIds.length === 0) {
    return Response.json({ error: 'no_scope' }, { status: 400 });
  }
  const ok = await updateShareScope(orgId, id, body.data);
  return ok ? Response.json({ ok: true }) : NOT_FOUND();
}

/** Only revoked and expired shares leave the list; a live one answers 409 (revoke it first). */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  if (await deleteShare(orgId, id)) return Response.json({ ok: true });
  const own = (await listShares(orgId)).some((s) => s.id === id);
  return own ? Response.json({ error: 'not_deletable' }, { status: 409 }) : NOT_FOUND();
}
