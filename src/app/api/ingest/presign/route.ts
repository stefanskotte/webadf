import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { presignBody } from '@/lib/ingest';

export async function POST(request: Request) {
  await requireOrg();

  const parsed = presignBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  const uploads = await Promise.all(
    parsed.data.files.map(async (f) => {
      const { url, expiresAt } = await diskStore.uploadUrl(f.sha256, f.sizeBytes);
      return { sha256: f.sha256, url, expiresAt: expiresAt.toISOString() };
    }),
  );

  return Response.json({ uploads });
}
