import { requireOrg } from '@/lib/session';
import { searchDemozoo } from '@/lib/demozoo/queries';

export const maxDuration = 60;

/**
 * Find on Demozoo. Behind a session like every library route, though the
 * productions themselves are global public data. Local table only: this never
 * reaches demozoo.org.
 */
export async function GET(request: Request) {
  await requireOrg();
  const q = new URL(request.url).searchParams.get('q') ?? '';
  return Response.json(await searchDemozoo(q));
}
