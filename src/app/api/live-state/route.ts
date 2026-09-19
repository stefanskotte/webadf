import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { liveFingerprint, liveStateRows } from '@/lib/live-state';

export const dynamic = 'force-dynamic';

/**
 * The fingerprint every open browser polls (LiveRefresh). One query over the
 * org's devices. Never cached: a cached answer is the stale page this prevents.
 */
export async function GET() {
  const { orgId } = await requireOrg();
  const fingerprint = liveFingerprint(await liveStateRows(getDb(), orgId), Date.now());
  return NextResponse.json({ fingerprint }, { headers: { 'Cache-Control': 'no-store' } });
}
