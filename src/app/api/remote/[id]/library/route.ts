// The owner's library: name, collections in scope, counts (ShareLibrary), through the listing cache.
import { requireOrg } from '@/lib/session';
import { proxyListing, remotePaths } from '@/lib/remote/http';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  return proxyListing(orgId, id, remotePaths.library());
}
