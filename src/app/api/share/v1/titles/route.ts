import { authorizeShare, notFound, shareJson, withShare } from '@/lib/share/api';
import { decodeCursor, listScopedTitles, TITLES_DEFAULT_LIMIT, TITLES_MAX_LIMIT } from '@/lib/share/listing';

export const dynamic = 'force-dynamic';

/** ?collection=&q=&cursor=&limit= -- one page of titles in scope. An unshared collection is 404. */
export const GET = withShare(async (req: Request) => {
  const auth = await authorizeShare(req, 'list');
  if (auth instanceof Response) return auth;

  const sp = new URL(req.url).searchParams;
  const cursor = sp.get('cursor') || null;
  if (cursor && !decodeCursor(cursor)) return shareJson({ error: 'bad_request' }, 400);
  const n = Number.parseInt(sp.get('limit') ?? '', 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, TITLES_MAX_LIMIT) : TITLES_DEFAULT_LIMIT;

  const page = await listScopedTitles(auth, {
    collectionId: sp.get('collection') || undefined,
    q: (sp.get('q') ?? '').slice(0, 200),
    cursor, limit,
  });
  return page ? shareJson(page) : notFound();
});
