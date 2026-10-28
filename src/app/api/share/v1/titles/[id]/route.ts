import { authorizeShare, notFound, shareJson } from '@/lib/share/api';
import { scopedTitle } from '@/lib/share/listing';

export const dynamic = 'force-dynamic';

/** One title in scope and its disks; anything else is 404. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorizeShare(req, 'list');
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const detail = await scopedTitle(auth, id);
  return detail ? shareJson(detail) : notFound();
}
