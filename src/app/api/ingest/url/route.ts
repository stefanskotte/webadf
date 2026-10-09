import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { ingestFromUrl, type UrlIngestCode } from '@/lib/url-ingest';
import { takeUrlFetch } from '@/lib/url-fetch-limit';
import { URL_FETCH_LIMITS } from '@/lib/url-fetch';

// The fetch has its own 25 s deadline (URL_FETCH_LIMITS.timeoutMs); storing
// and registering up to MAX_IMAGES_PER_URL images needs the rest. 60 s, like
// /api/ingest/complete, whose code this runs.
export const maxDuration = 60;

const body = z.object({ url: z.string().min(1).max(URL_FETCH_LIMITS.maxUrlLength) });

/**
 * HTTP status per refusal. The body only ever carries the code (and, for
 * upstream_status, the public host's status number): nothing the upstream
 * sent is passed through, so the route cannot be used to read or probe
 * anything the server can reach and the user cannot.
 */
const STATUS: Record<UrlIngestCode, number> = {
  invalid_url: 400,
  unsupported_scheme: 400,
  credentials_not_allowed: 400,
  port_not_allowed: 400,
  address_not_allowed: 400,
  unreachable: 502,
  too_many_redirects: 502,
  upstream_status: 502,
  too_large: 413,
  timeout: 504,
  not_a_disk_image: 422,
  no_disk_images: 422,
  too_many_images: 422,
  unsupported_archive: 422,
  store_busy: 503,
  ingest_failed: 500,
};

export async function POST(request: Request) {
  // Session and active org first: nothing is fetched for an anonymous caller.
  const { userId, orgId } = await requireOrg();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: 'invalid_url' }, { status: 400 });
  }
  const parsed = body.safeParse(json);
  if (!parsed.success) return Response.json({ error: 'invalid_url' }, { status: 400 });

  const allowed = takeUrlFetch(userId, orgId);
  if (!allowed.ok) {
    const seconds = Math.max(1, Math.ceil(allowed.retryAfterMs / 1000));
    return Response.json({ error: 'rate_limited', retryAfter: seconds }, { status: 429, headers: { 'retry-after': String(seconds) } });
  }

  // orgId from the session only; the body carries nothing but the URL.
  const result = await ingestFromUrl(orgId, parsed.data.url);
  if (!result.ok) {
    return Response.json(
      { error: result.code, ...(result.code === 'upstream_status' && result.status ? { status: result.status } : {}) },
      { status: STATUS[result.code] },
    );
  }
  return Response.json({ rows: result.rows });
}
