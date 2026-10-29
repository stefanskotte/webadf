// GET /api/files/list?path= -- one folder of the Files manager (spec 2026-10-29).
import { requireOrg } from '@/lib/session';
import { parsePath } from '@/lib/files/path';
import { driverFor } from '@/lib/files/drivers';
import { Refused } from '@/lib/files/driver';

// Reads (and an op writes) disk images from the store: the same 60 s every byte-touching handler sets.
export const maxDuration = 60;

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const p = parsePath(new URL(request.url).searchParams.get('path') ?? '');
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  const driver = driverFor(p.device);
  if (!driver) return Response.json({ error: 'not_found' }, { status: 404 });
  let listing: Awaited<ReturnType<typeof driver.list>>;
  try { listing = await driver.list({ orgId, userId }, p); } catch (e) {
    if (e instanceof Refused) return Response.json({ error: e.refusal.code }, { status: e.status });
    throw e;
  }
  if (!listing) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(listing);
}
