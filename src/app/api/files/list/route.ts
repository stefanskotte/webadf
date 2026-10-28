// GET /api/files/list?path= -- one folder of the Files manager (spec 2026-10-29).
import { requireOrg } from '@/lib/session';
import { parsePath } from '@/lib/files/path';
import { listLibrary } from '@/lib/files/library';

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const p = parsePath(new URL(request.url).searchParams.get('path') ?? '');
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  if (p.device !== 'LIBRARY') return Response.json({ error: 'not_found' }, { status: 404 });
  const listing = await listLibrary({ orgId, userId }, p);
  if (!listing) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(listing);
}
