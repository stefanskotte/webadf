// An owner title's cover, proxied (spec §4.2 Browse: "covers longer, by ETag"). The browser keeps it an hour; the
// owner answers 404 once the title leaves scope. Only image bytes pass, typed from the bytes themselves.
import { requireOrg } from '@/lib/session';
import { clientFor, noteRemoteResult, prepareRemote } from '@/lib/remote/store';
import { ID_RE, notFound, ownLibrary, remoteFailure, remotePaths, sniffImage } from '@/lib/remote/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_request: Request, ctx: { params: Promise<{ id: string; titleId: string }> }) {
  const { orgId } = await requireOrg();
  const { id, titleId } = await ctx.params;
  if (!ID_RE.test(titleId)) return notFound();
  const lib = await ownLibrary(orgId, id);
  if (!lib) return notFound();
  const p = await prepareRemote(orgId, id);
  if (!p.ok) return remoteFailure(p.result.ok ? 'protocol' : p.result.failure, lib.host);
  const r = await clientFor().getBytes(p.target, remotePaths.cover(titleId));
  await noteRemoteResult(orgId, id, r);
  if (!r.ok) return remoteFailure(r.failure, lib.host, { detail: r.detail });
  const type = sniffImage(r.value);
  if (!type) return remoteFailure('bad_response', lib.host, { detail: 'cover_type' });
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Length': String(r.value.byteLength),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  if (r.etag && /^[A-Za-z0-9._-]{1,128}$/.test(r.etag)) headers.ETag = `"${r.etag}"`;
  return new Response(r.value as unknown as BodyInit, { headers });
}
