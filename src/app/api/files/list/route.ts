// GET /api/files/list?path= -- one folder of the Files manager (spec 2026-10-29).
import { requireOrg } from '@/lib/session';
import { parsePath } from '@/lib/files/path';
import { BlobUnavailableError, listLibrary } from '@/lib/files/library';

// Reads (and an op writes) disk images from the store: the same 60 s every byte-touching handler sets.
export const maxDuration = 60;

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const p = parsePath(new URL(request.url).searchParams.get('path') ?? '');
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  if (p.device !== 'LIBRARY') return Response.json({ error: 'not_found' }, { status: 404 });
  let listing: Awaited<ReturnType<typeof listLibrary>>;
  try { listing = await listLibrary({ orgId, userId }, p); } catch (e) {
    if (e instanceof BlobUnavailableError) return Response.json({ error: 'blob_unavailable' }, { status: 503 });
    throw e;
  }
  if (!listing) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(listing);
}
