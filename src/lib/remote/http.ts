// The recipient's /api/remote/* answers (spec §4.2-4.4, Task 8). SERVER ONLY.
//
// One mapping from what the owner answered (or materialise concluded) to HTTP, so every remote route says the same
// thing for the same failure:
//   ended                         410 {error:'ended'}
//   unreachable                   502 {error:'unreachable', host}
//   protocol                      409 {error:'protocol', host, detail?}  (detail: which side is older)
//   bad_response                  502 {error:'bad_response', host}       (not a WebFloppy, or a garbled answer)
//   token_unreadable              409 {error:'token_unreadable'}         (this server cannot open its sealed token)
//   not_found / not_shared        404 {error:'not_shared'} for a disk action, else {error:'not_found'}
//   rate_limited                  429 {error:'rate_limited'}
//   too_large / mismatch          502 {error: reason}
// A library id that is not this org's is always 404 {error:'not_found'} (global constraints), before any call.
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { remoteLibraries } from '@/db/schema/sharing';
import type { ShareFailure } from '@/lib/share/client';
import type { MaterialiseResult } from './materialise';
import { remoteCall, type RemoteStatus } from './store';

type MaterialiseReason = Extract<MaterialiseResult, { ok: false }>['reason'];

export const notFound = () => Response.json({ error: 'not_found' }, { status: 404 });

/** The host a person recognises ("Can't reach <host>"), from the stored origin. */
export function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

/** This org's remote library (id, host, status), or null: the routes answer 404 before calling anyone. */
export async function ownLibrary(orgId: string, id: string): Promise<{ id: string; host: string; status: RemoteStatus } | null> {
  const [r] = await getDb().select({ id: remoteLibraries.id, baseUrl: remoteLibraries.baseUrl, status: remoteLibraries.status })
    .from(remoteLibraries).where(and(eq(remoteLibraries.id, id), eq(remoteLibraries.orgId, orgId))).limit(1);
  return r ? { id: r.id, host: hostOf(r.baseUrl), status: r.status as RemoteStatus } : null;
}

/** The answer for a failure. `disk`: the request was a disk action (mount, send, download), where 404 means "no longer shared". */
export function remoteFailure(
  failure: ShareFailure | MaterialiseReason, host: string, opts: { disk?: boolean; detail?: string } = {},
): Response {
  switch (failure) {
    case 'ended':
      return Response.json({ error: 'ended' }, { status: 410 });
    case 'unreachable':
      return Response.json({ error: 'unreachable', host }, { status: 502 });
    case 'rate_limited':
      return Response.json({ error: 'rate_limited' }, { status: 429 });
    case 'too_large':
    case 'mismatch':
      return Response.json({ error: failure }, { status: 502 });
    case 'bad_response':
      return Response.json({ error: 'bad_response', host }, { status: 502 });
    case 'token_unreadable':
      return Response.json({ error: 'token_unreadable' }, { status: 409 });
    case 'not_found':
    case 'not_shared':
    case 'invalid_or_used':
      return Response.json({ error: opts.disk ? 'not_shared' : 'not_found' }, { status: 404 });
    default:
      return Response.json(opts.detail ? { error: 'protocol', host, detail: opts.detail } : { error: 'protocol', host }, { status: 409 });
  }
}

const enc = encodeURIComponent;
export const remotePaths = {
  library: () => 'library',
  titles: (q: URLSearchParams) => (q.size > 0 ? `titles?${q.toString()}` : 'titles'),
  title: (titleId: string) => `titles/${enc(titleId)}`,
  files: (diskId: string) => `disks/${enc(diskId)}/files`,
  bytes: (diskId: string) => `disks/${enc(diskId)}/bytes`,
  cover: (titleId: string) => `covers/${enc(titleId)}`,
};

/** Only the owner's documented query parameters pass through (spec §3.2 titles), each bounded. */
export function titlesQuery(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of ['collection', 'q', 'cursor', 'limit'] as const) {
    const v = sp.get(k);
    if (v) out.set(k, v.slice(0, 200));
  }
  return out;
}

/** An id from the URL or a body: what the owner's ids look like (uuid-ish), never a path. */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A cover's type, from its bytes: the owner's Content-Type is not trusted, and only images pass. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * GET one listing from the owner through the 60 s cache (remoteCall) and pass its JSON on as the owner sent it (the
 * wire types in src/lib/share/types.ts). Never cached by the browser: the status can change on the next call.
 */
export async function proxyListing(orgId: string, id: string, path: string): Promise<Response> {
  const lib = await ownLibrary(orgId, id);
  if (!lib) return notFound();
  const r = await remoteCall<unknown>(orgId, id, path);
  if (!r.ok) return remoteFailure(r.failure, lib.host, { detail: r.detail });
  return Response.json(r.value, { headers: { 'Cache-Control': 'private, no-store' } });
}
