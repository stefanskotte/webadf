// POST /api/files/stash/url -- Paste URL into STASH: (Files spec 2026-10-29 §4.2, R7): ONE file, fetched under every
// rule /api/ingest/url fetches under (fetchUrlSafely: the SSRF guard, 20 MB, the deadline; takeUrlFetch's rate limit),
// stored at the STASH: root under the name the server gave, cleaned by the Amiga's rules (R3), keep-both on a clash.
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { fetchUrlSafely, URL_FETCH_LIMITS, type UrlFetchCode } from '@/lib/url-fetch';
import { takeUrlFetch } from '@/lib/url-fetch-limit';
import { nameFromResponse } from '@/lib/url-ingest';
import { cleanAmigaPath } from '@/lib/transfers';
import { storeOwnBytes } from '@/lib/files/stash-commit';
import { writeStash } from '@/lib/files/stash-driver';
import { Refused } from '@/lib/files/driver';
import type { RefusalCode } from '@/lib/files/types';

// The fetch has its own 25 s deadline (URL_FETCH_LIMITS.timeoutMs); storing needs the rest of the 60 s.
export const maxDuration = 60;

const Body = z.object({ url: z.string().min(1).max(URL_FETCH_LIMITS.maxUrlLength) });

/** As /api/ingest/url answers the same codes: the body carries only the code, never what the upstream sent. */
const STATUS: Record<UrlFetchCode, number> = {
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
};

/** A refusal of the one file stored, as a status (writeStash refuses per item). */
const ITEM_STATUS: Partial<Record<RefusalCode, number>> = { too_large: 413, bad_name: 400, not_found: 404 };

export async function POST(request: Request) {
  // Session and active org first: nothing is fetched for an anonymous caller.
  const { orgId, userId } = await requireOrg();
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'invalid_url' }, { status: 400 });

  const allowed = takeUrlFetch(userId, orgId);
  if (!allowed.ok) {
    const seconds = Math.max(1, Math.ceil(allowed.retryAfterMs / 1000));
    return Response.json({ error: 'rate_limited', retryAfter: seconds }, { status: 429, headers: { 'retry-after': String(seconds) } });
  }

  const got = await fetchUrlSafely(body.data.url);
  if (!got.ok) {
    return Response.json({ error: got.code, ...(got.code === 'upstream_status' && got.status ? { status: got.status } : {}) },
      { status: STATUS[got.code] });
  }
  const name = cleanAmigaPath(nameFromResponse(got.finalUrl, got.contentDisposition).replace(/\//g, '_')) ?? 'download';
  try {
    const sha256 = await storeOwnBytes(got.bytes);
    const r = await writeStash({ orgId, userId, versions: [] }, { device: 'STASH', segments: [] },
      [{ source: body.data.url, items: [{ rel: [name], kind: 'file', sha256, size: got.bytes.length, date: null, protection: 0, comment: null }] }],
      'keep-both', 'browser');
    if (r.kind !== 'done') return Response.json({ error: 'failed' }, { status: 500 });   // keep-both never asks
    const item = r.items[0];
    if (!item.ok) return Response.json({ error: item.refusal.code, detail: item.refusal.detail }, { status: ITEM_STATUS[item.refusal.code] ?? 409 });
    return Response.json({ path: r.placed![0].path }, { status: 201 });
  } catch (e) {
    if (e instanceof Refused) return Response.json({ error: e.refusal.code, detail: e.refusal.detail }, { status: e.status });
    throw e;
  }
}
