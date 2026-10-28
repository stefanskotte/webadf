// GET /api/files/download?path= -- one file's bytes (spec 2026-10-29).
import { requireOrg } from '@/lib/session';
import { parsePath } from '@/lib/files/path';
import { readLibraryFile } from '@/lib/files/library';

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const p = parsePath(new URL(request.url).searchParams.get('path') ?? '');
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  if (p.device !== 'LIBRARY') return Response.json({ error: 'not_found' }, { status: 404 });
  let f: Awaited<ReturnType<typeof readLibraryFile>>;
  try { f = await readLibraryFile({ orgId, userId }, p); } catch { return Response.json({ error: 'blob_unavailable' }, { status: 503 }); }
  if (!f) return Response.json({ error: 'not_found' }, { status: 404 });
  return new Response(f.bytes as BodyInit, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
      'content-length': String(f.bytes.byteLength),
    },
  });
}
