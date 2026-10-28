import { requireOrg } from '@/lib/session';
import { createShare, listShares } from '@/lib/share/store';
import { localRootPinState, shareLink } from '@/lib/share/instance';
import { toShareView } from '@/lib/share/view';
import { createShareBody, readBody } from './body';

export const maxDuration = 60;

/** Settings > Sharing's table (spec §3.4). */
export async function GET() {
  const { orgId } = await requireOrg();
  const shares = await listShares(orgId);
  return Response.json({ shares: shares.map(toShareView) });
}

/**
 * New share. The answer carries the link -- the only time it exists: the code is stored hashed. `pinProblem` is set
 * when this server's certificate root could not be read, so the link has no pin and may not work for others.
 */
export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  const body = await readBody(request, createShareBody);
  if (!body.ok) return body.res;

  const created = await createShare(orgId, userId, body.data);
  if (!created.ok) return Response.json({ error: created.reason }, { status: 400 });

  const { pin, error } = await localRootPinState();
  return Response.json({
    share: toShareView(created.share),
    link: shareLink(created.code, pin),
    ...(error ? { pinProblem: error } : {}),
  }, { headers: { 'cache-control': 'no-store' } });
}
