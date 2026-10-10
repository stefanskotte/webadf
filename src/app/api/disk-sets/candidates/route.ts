import { requireOrg } from '@/lib/session';
import { searchCandidates, CANDIDATE_PAGE } from '@/lib/disk-set-search';

/**
 * Titles the "add to a set" panel can offer, for a manual search or (empty
 * `q`) just the newest (disk-sets spec §4). `exclude` is the title already
 * being built into, so it never offers itself as a candidate. `limit` grows by
 * a page each "Show more" (searchCandidates clamps it); `more` says whether
 * titles beyond it exist.
 */
export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';
  const exclude = params.get('exclude');
  const limit = Number.parseInt(params.get('limit') ?? '', 10);

  const { titles, more } = await searchCandidates(
    orgId, q, exclude && exclude.trim() !== '' ? exclude : null, Number.isFinite(limit) ? limit : CANDIDATE_PAGE);
  return Response.json({ titles, more });
}
