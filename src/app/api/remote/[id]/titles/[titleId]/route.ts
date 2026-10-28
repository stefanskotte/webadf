// One owner title and its disks (ShareTitleDetail), through the listing cache.
import { requireOrg } from '@/lib/session';
import { ID_RE, notFound, proxyListing, remotePaths } from '@/lib/remote/http';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string; titleId: string }> }) {
  const { orgId } = await requireOrg();
  const { id, titleId } = await ctx.params;
  if (!ID_RE.test(titleId)) return notFound();
  return proxyListing(orgId, id, remotePaths.title(titleId));
}
