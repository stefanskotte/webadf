import { requireOrg } from '@/lib/session';
import { search, EMPTY_RESULTS } from '@/lib/search';

export const maxDuration = 60;

/**
 * Fired on every keystroke, so it does the least it can: one org id from the
 * session, one query, one shape of answer.
 *
 * There is no 404 and no error that distinguishes "you have no such title"
 * from "that title belongs to someone else" -- both are an empty array with a
 * 200 (D-5-6). /api/ingest/check is a deliberate global existence oracle on
 * DIGESTS (D13); titles are not digests and no equivalent decision covers
 * them, so this one is scoped and says nothing.
 */
export async function GET(request: Request) {
  const { orgId } = await requireOrg();

  const q = new URL(request.url).searchParams.get('q');
  if (q === null) return Response.json(EMPTY_RESULTS);

  return Response.json(await search(orgId, q));
}
