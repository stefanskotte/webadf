// GET /api/files/list?path= -- one folder of the Files manager (spec 2026-10-29).
import { requireOrg } from '@/lib/session';
import { parsePath } from '@/lib/files/path';
import { driverFor } from '@/lib/files/drivers';
import { Pending, Refused } from '@/lib/files/driver';

// Reads (and an op writes) disk images from the store: the same 60 s every byte-touching handler sets.
export const maxDuration = 60;

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const url = new URL(request.url);
  const p = parsePath(url.searchParams.get('path') ?? '');
  // NET: volumes (spec 2026-10-30 §4.4): Refresh asks the Amiga again rather than reuse a remembered answer.
  const fresh = url.searchParams.get('fresh') === '1';
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  const driver = driverFor(p.device);
  if (!driver) return Response.json({ error: 'not_found' }, { status: 404 });
  let listing: Awaited<ReturnType<typeof driver.list>>;
  try { listing = await driver.list({ orgId, userId }, p, { fresh }); } catch (e) {
    // Asked and not answered yet: the pane shows the label and asks again (never cached: the answer is on its way).
    if (e instanceof Pending) return Response.json({ pending: true, label: e.label }, { status: 202, headers: { 'cache-control': 'no-store' } });
    if (e instanceof Refused) return Response.json({ error: e.refusal.code, ...(e.refusal.detail ? { detail: e.refusal.detail } : {}) }, { status: e.status });
    throw e;
  }
  if (!listing) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(listing);
}
