// An owner disk's file listing (ShareFiles), through the listing cache. Read-only: no file operations on a remote disk.
import { requireOrg } from '@/lib/session';
import { ID_RE, notFound, proxyListing, remotePaths } from '@/lib/remote/http';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string; diskId: string }> }) {
  const { orgId } = await requireOrg();
  const { id, diskId } = await ctx.params;
  if (!ID_RE.test(diskId)) return notFound();
  return proxyListing(orgId, id, remotePaths.files(diskId));
}
