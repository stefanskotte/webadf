import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { checkBody, splitKnownMissing } from '@/lib/ingest';

export async function POST(request: Request) {
  await requireOrg();

  const parsed = checkBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  const { hashes } = parsed.data;
  const rows = await getDb()
    .select({ sha256: blobs.sha256 })
    .from(blobs)
    .where(inArray(blobs.sha256, hashes));

  return Response.json(splitKnownMissing(hashes, new Set(rows.map((r) => r.sha256))));
}
