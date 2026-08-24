import { z } from 'zod';
import { BlobServiceRateLimited } from '@vercel/blob';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { presignBody } from '@/lib/ingest';
import { mapLimit } from '@/lib/pool';

// Signing is fast but network-bound, and a batch is up to MAX_BATCH (500).
export const maxDuration = 60;

/**
 * issueSignedToken + presignUrl pairs in flight at once. This used to be an
 * unbounded Promise.all over the whole batch: 500 signing round trips fired
 * simultaneously from a single invocation, which is exactly the shape that
 * trips the Blob service's rate limiter.
 */
const SIGN_CONCURRENCY = 12;

export async function POST(request: Request) {
  await requireOrg();

  const parsed = presignBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  try {
    const uploads = await mapLimit(parsed.data.files, SIGN_CONCURRENCY, async (f) => {
      const { url, expiresAt } = await diskStore.uploadUrl(f.sha256, f.sizeBytes);
      return { sha256: f.sha256, url, expiresAt: expiresAt.toISOString() };
    });

    return Response.json({ uploads });
  } catch (err) {
    // Transient and retryable — say so instead of letting it become a 500
    // that looks like a bug in the batch.
    if (err instanceof BlobServiceRateLimited) {
      return Response.json(
        { error: 'blob store rate limited, retry this batch' },
        { status: 503, headers: { 'retry-after': String(err.retryAfter ?? 10) } },
      );
    }
    throw err;
  }
}
