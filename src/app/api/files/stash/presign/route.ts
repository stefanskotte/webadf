// POST /api/files/stash/presign -- upload URLs for a browser drop into STASH: (Files spec 2026-10-29 §4.2, R6). Only
// non-empty files come here, one URL per sha-256 (ruling 15): an empty file or a folder goes straight to the commit.
// A blob the store already holds needs no PUT; the commit verifies whatever is there.
import { z } from 'zod';
import { BlobServiceRateLimited } from '@vercel/blob';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { mapLimit } from '@/lib/pool';
import { STASH_COMMIT_MAX_ENTRIES, STASH_FILE_MAX } from '@/lib/files/stash-paths';

// Signing is fast but network-bound: the same 60 s every Files handler sets.
export const maxDuration = 60;

/** Signing round trips in flight at once, as /api/ingest/presign bounds them for the Blob service's rate limiter. */
const SIGN_CONCURRENCY = 12;

const Body = z.object({
  files: z.array(z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().min(1).max(STASH_FILE_MAX),
  })).min(1).max(STASH_COMMIT_MAX_ENTRIES),
});

export async function POST(request: Request) {
  await requireOrg();
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const unique = [...new Map(body.data.files.map((f) => [f.sha256, f])).values()];
  try {
    const signed = await mapLimit(unique, SIGN_CONCURRENCY, async (f) => {
      if (await diskStore.stat(f.sha256)) return null;
      const { url } = await diskStore.uploadUrl(f.sha256, f.sizeBytes);
      return { sha256: f.sha256, url };
    });
    return Response.json({ uploads: signed.filter((u) => u !== null) });
  } catch (err) {
    if (err instanceof BlobServiceRateLimited) {
      return Response.json({ error: 'blob store rate limited, retry this batch' },
        { status: 503, headers: { 'retry-after': String(err.retryAfter ?? 10) } });
    }
    throw err;
  }
}
