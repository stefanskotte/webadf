// GET /api/files/download?path= -- one file's bytes; ?paths=…&paths=… -- several files and folders, from any disks,
// as one .zip (spec 2026-10-29 §3.3), named by `?name=` (default "Files.zip").
import { requireOrg } from '@/lib/session';
import { parsePath, type FsPath } from '@/lib/files/path';
import { BlobUnavailableError, readLibraryFile, zipLibraryPaths, ZIP_LIMITS } from '@/lib/files/library';

/** RFC 5987 `filename*`: encodeURIComponent leaves ' ( ) * unescaped, which attr-char does not allow. */
function attachment(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const q = new URL(request.url).searchParams;
  if (q.has('paths')) return zip(orgId, userId, q);
  const p = parsePath(q.get('path') ?? '');
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  if (p.device !== 'LIBRARY') return Response.json({ error: 'not_found' }, { status: 404 });
  let f: Awaited<ReturnType<typeof readLibraryFile>>;
  try { f = await readLibraryFile({ orgId, userId }, p); } catch (e) {
    if (e instanceof BlobUnavailableError) return Response.json({ error: 'blob_unavailable' }, { status: 503 });
    throw e;
  }
  if (!f) return Response.json({ error: 'not_found' }, { status: 404 });
  return new Response(f.bytes as BodyInit, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': attachment(f.name),
      'content-length': String(f.bytes.byteLength),
    },
  });
}

async function zip(orgId: string, userId: string, q: URLSearchParams): Promise<Response> {
  const raw = q.getAll('paths');
  if (raw.length > ZIP_LIMITS.maxEntries) return Response.json({ error: 'too_large' }, { status: 413 });
  const paths: FsPath[] = [];
  for (const r of raw) {
    const p = parsePath(r);
    if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
    if (p.device !== 'LIBRARY') return Response.json({ error: 'not_found' }, { status: 404 });
    paths.push(p);
  }
  let result: Awaited<ReturnType<typeof zipLibraryPaths>>;
  try { result = await zipLibraryPaths({ orgId, userId }, paths); } catch (e) {
    if (e instanceof BlobUnavailableError) return Response.json({ error: 'blob_unavailable' }, { status: 503 });
    throw e;
  }
  if (!result || (!result.ok && result.reason === 'not_found')) return Response.json({ error: 'not_found' }, { status: 404 });
  if (!result.ok && result.reason === 'too_large') return Response.json({ error: 'too_large' }, { status: 413 });
  // The same 422 the disk zip route answers for a file it cannot read.
  if (!result.ok) return Response.json({ error: 'unreadable', name: result.name }, { status: 422 });
  const name = (q.get('name') ?? '').trim().slice(0, 200) || 'Files';
  return new Response(result.zip as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': attachment(name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`),
      'content-length': String(result.zip.byteLength),
    },
  });
}
