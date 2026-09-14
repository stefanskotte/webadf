import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { acceptSuggestions } from '@/lib/demozoo/apply';

export const maxDuration = 60;

const body = z.object({
  items: z.array(z.object({ gameId: z.string().min(1), productionId: z.number().int().positive() })).min(1).max(500),
});

/** Review queue: Accept selected. Items not in this org are skipped, not errors. */
export async function POST(request: Request) {
  const { orgId } = await requireOrg();
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(json);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  return Response.json({ accepted: await acceptSuggestions(orgId, parsed.data.items) });
}
