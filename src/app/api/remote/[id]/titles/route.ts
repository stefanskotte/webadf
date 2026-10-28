// One page of the owner's titles in scope (ShareTitlesPage): ?collection=&q=&cursor=&limit=, through the listing cache.
import { requireOrg } from '@/lib/session';
import { proxyListing, remotePaths, titlesQuery } from '@/lib/remote/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  return proxyListing(orgId, id, remotePaths.titles(titlesQuery(new URL(request.url).searchParams)));
}
