import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { completeBody } from '@/lib/ingest';
import { registerUploads } from '@/lib/ingest-complete';
import { fileIngestedTitles } from '@/lib/collections';

// A batch is up to MAX_BATCH (500) files. Verification reads back every
// genuinely-new blob (~880 KB each), so this is the one ingest route that can
// legitimately run for a while. 60s is the ceiling available on every Vercel
// plan; the clients batch at 500 and retry, so a batch that does run out of
// time is re-driven rather than lost.
export const maxDuration = 60;

export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  const parsed = completeBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  // Everything past auth and parsing lives in src/lib/ingest-complete.ts, so
  // /api/ingest/url registers server-fetched bytes through the same code.
  const res = await registerUploads(orgId, parsed.data.files);
  if (parsed.data.collectionId) {
    // A batch partly refused answers its placed titles too; a body with none (a refusal of everything) files nothing.
    const { titles } = (await res.clone().json()) as { titles?: Record<string, { gameId: string }> };
    await fileIngestedTitles(orgId, parsed.data.collectionId, Object.values(titles ?? {}).map((t) => t.gameId));
  }
  return res;
}
