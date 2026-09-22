import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getDb } from '@/db';
import { auth } from '@/lib/auth';
import { liveFingerprint, liveStateRows } from '@/lib/live-state';
import { latestReleaseSequence } from '@/lib/firmware-releases';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * The fingerprint every open browser polls (LiveRefresh). One query over the
 * org's devices. Never cached: a cached answer is the stale page this prevents.
 *
 * Session scoping matches `requireOrg()` (src/lib/session.ts) exactly -- the
 * same `auth.api.getSession` call, the same `activeOrganizationId` check --
 * but this route answers 401 JSON instead of redirecting when either is
 * missing. `requireOrg()`'s redirect makes sense for a page navigation; for
 * `fetch()` a redirect response is just followed and resolved as a 200 with
 * the sign-in page's HTML, which LiveRefresh would parse as JSON and fail on
 * (or worse, treat as a fingerprint that never matches). A plain 401 is a
 * response LiveRefresh already ignores by design (spec §4), same as any other
 * non-2xx answer.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  const orgId = session?.session.activeOrganizationId;
  if (!session || !orgId) return unauthorized();

  const [rows, latestRelease] = await Promise.all([
    liveStateRows(getDb(), orgId),
    latestReleaseSequence(),
  ]);
  const fingerprint = liveFingerprint(rows, Date.now(), latestRelease);
  return NextResponse.json({ fingerprint }, { headers: { 'Cache-Control': 'no-store' } });
}
