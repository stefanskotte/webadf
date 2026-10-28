import { authorizeShare, shareJson } from '@/lib/share/api';
import { libraryOverview } from '@/lib/share/listing';

export const dynamic = 'force-dynamic';

/** The library's name, the collections in scope with their title counts, and the totals in scope. */
export async function GET(req: Request) {
  const auth = await authorizeShare(req, 'list');
  if (auth instanceof Response) return auth;
  return shareJson(await libraryOverview(auth));
}
