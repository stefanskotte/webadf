// GET /api/files/download?path= -- one file's bytes, from any device; ?paths=…&paths=… -- several files and folders,
// from any disks and STASH:, as one .zip (spec 2026-10-29 §3.3, R9), named by `?name=` (default "Files.zip").
import { requireOrg } from '@/lib/session';
import { parsePath, type FsPath } from '@/lib/files/path';
import { BlobUnavailableError, zipLibraryPaths, ZIP_LIMITS } from '@/lib/files/library';
import { driverFor } from '@/lib/files/drivers';
import { refuse, Refused, type FsCtx, type IncomingItem } from '@/lib/files/driver';
import { tallyIncoming, zipIncoming } from '@/lib/disk-zip';
import { diskStore } from '@/lib/storage';

// Reads (and an op writes) disk images from the store: the same 60 s every byte-touching handler sets.
export const maxDuration = 60;

/** Why a selection is refused as too large, for anyone reading the 413 itself (the manager words it on its own). */
const TOO_LARGE = {
  error: 'too_large',
  detail: `A download holds at most ${ZIP_LIMITS.maxBytes / (1024 * 1024)} MB or ${ZIP_LIMITS.maxEntries} files and folders at once.`,
};

/** RFC 5987 `filename*`: encodeURIComponent leaves ' ( ) * unescaped, which attr-char does not allow. */
function attachment(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** Every download is an attachment the browser must not sniff or cache, whichever device it came from (R9). */
const PRIVATE = { 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' };

const refused = (e: Refused) => Response.json({ error: e.refusal.code, ...(e.refusal.detail ? { detail: e.refusal.detail } : {}) }, { status: e.status });

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const q = new URL(request.url).searchParams;
  if (q.has('paths')) return zip(orgId, userId, q);
  const p = parsePath(q.get('path') ?? '');
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  const driver = driverFor(p.device);
  if (!driver) return Response.json({ error: 'not_found' }, { status: 404 });
  let f: Awaited<ReturnType<typeof driver.read>>;
  try { f = await driver.read({ orgId, userId }, p); } catch (e) {
    if (e instanceof Refused) return refused(e);
    throw e;
  }
  if (!f) return Response.json({ error: 'not_found' }, { status: 404 });
  return new Response(f.bytes as BodyInit, {
    headers: {
      ...PRIVATE,
      'content-type': 'application/octet-stream',
      'content-disposition': attachment(f.name),
      'content-length': String(f.bytes.byteLength),
    },
  });
}

async function zip(orgId: string, userId: string, q: URLSearchParams): Promise<Response> {
  const raw = q.getAll('paths');
  if (raw.length > ZIP_LIMITS.maxEntries) return Response.json(TOO_LARGE, { status: 413 });
  const paths: FsPath[] = [];
  for (const r of raw) {
    const p = parsePath(r);
    if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
    if (!driverFor(p.device)) return Response.json({ error: 'not_found' }, { status: 404 });
    paths.push(p);
  }
  if (paths.some((p) => p.device !== 'LIBRARY')) return zipAcross(orgId, userId, paths, q);
  let result: Awaited<ReturnType<typeof zipLibraryPaths>>;
  try { result = await zipLibraryPaths({ orgId, userId }, paths); } catch (e) {
    if (e instanceof BlobUnavailableError) return Response.json({ error: 'blob_unavailable' }, { status: 503 });
    throw e;
  }
  if (!result) return Response.json({ error: 'not_found' }, { status: 404 });
  if (!result.ok && result.reason === 'too_large') return Response.json(TOO_LARGE, { status: 413 });
  // The same 422 the disk zip route answers for a file it cannot read.
  if (!result.ok) return Response.json({ error: 'unreadable', name: result.name }, { status: 422 });
  return zipResponse(result.zip, q);
}

/** `p` is `outer` itself or inside it (names compare case-insensitively, as AmigaDOS and STASH: compare them). */
function within(p: FsPath, outer: FsPath): boolean {
  return p.device === outer.device && p.segments.length >= outer.segments.length
    && outer.segments.every((s, i) => s.toLowerCase() === p.segments[i].toLowerCase());
}

/**
 * A selection that reaches beyond LIBRARY: each path through its own driver's `collect`, in order, the caps counted as
 * each comes (a STASH: file by its row's size, before its blob is read), then the bytes the collect left in the store
 * read, then one zip. An entry selected twice, or inside another selected folder, goes in once.
 */
async function zipAcross(orgId: string, userId: string, paths: FsPath[], q: URLSearchParams): Promise<Response> {
  const ctx: FsCtx = { orgId, userId };
  const picked = paths.filter((p, k) => !paths.some((o, j) => j !== k
    && (o.segments.length === p.segments.length ? j < k && within(p, o) : within(p, o))));
  const tops: { items: IncomingItem[] }[] = [];
  try {
    for (const p of picked) {
      const items = await driverFor(p.device)!.collect(ctx, p);
      if (!items) return Response.json({ error: 'not_found' }, { status: 404 });
      tops.push({ items });
      const n = tallyIncoming(tops);
      if (n.entries > ZIP_LIMITS.maxEntries || n.bytes > ZIP_LIMITS.maxBytes) return Response.json(TOO_LARGE, { status: 413 });
    }
    const blobs = new Map<string, Uint8Array>();
    for (const t of tops) for (const i of t.items) {
      if (i.kind !== 'file' || i.bytes || !i.sha256) continue;
      if (!blobs.has(i.sha256)) blobs.set(i.sha256, await diskStore.read(i.sha256).catch((): never => refuse('blob_unavailable', 503)));
      i.bytes = blobs.get(i.sha256);
    }
  } catch (e) {
    if (e instanceof Refused) return refused(e);
    throw e;
  }
  const result = zipIncoming(tops, ZIP_LIMITS);
  if (!result.ok && result.reason === 'too_large') return Response.json(TOO_LARGE, { status: 413 });
  if (!result.ok && result.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (!result.ok) return Response.json({ error: 'unreadable', name: result.name }, { status: 422 });
  return zipResponse(result.zip, q);
}

function zipResponse(zip: Uint8Array, q: URLSearchParams): Response {
  const name = (q.get('name') ?? '').trim().slice(0, 200) || 'Files';
  return new Response(zip as BodyInit, {
    headers: {
      ...PRIVATE,
      'content-type': 'application/zip',
      'content-disposition': attachment(name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`),
      'content-length': String(zip.byteLength),
    },
  });
}
