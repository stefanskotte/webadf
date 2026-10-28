// Download a remote disk (spec §4.2): streamed through this server from the owner, the bytes checked against their
// ETag, never kept as a disk row. GET ?titleId= (the share API names a disk through its title).
import { createHash } from 'node:crypto';
import { requireOrg } from '@/lib/session';
import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { contentDisposition, downloadFilename } from '@/lib/download-name';
import { clientFor, noteRemoteResult, prepareRemote, remoteCall } from '@/lib/remote/store';
import { ID_RE, notFound, ownLibrary, remoteFailure, remotePaths } from '@/lib/remote/http';
import type { ShareTitleDetail } from '@/lib/share/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) : '');

export async function GET(request: Request, ctx: { params: Promise<{ id: string; diskId: string }> }) {
  const { orgId } = await requireOrg();
  const { id, diskId } = await ctx.params;
  const titleId = new URL(request.url).searchParams.get('titleId') ?? '';
  if (!ID_RE.test(diskId)) return notFound();
  if (!ID_RE.test(titleId)) return Response.json({ error: 'invalid_query' }, { status: 400 });

  const lib = await ownLibrary(orgId, id);
  if (!lib) return notFound();
  // The name (cached listing is fine: the bytes route checks scope again at the owner, right now).
  const t = await remoteCall<ShareTitleDetail>(orgId, id, remotePaths.title(titleId));
  if (!t.ok) return remoteFailure(t.failure, lib.host, { disk: true, detail: t.detail });
  const entry = Array.isArray(t.value?.disks) ? t.value.disks.find((d) => d && d.id === diskId) : undefined;
  if (!entry) return remoteFailure('not_shared', lib.host, { disk: true });

  const p = await prepareRemote(orgId, id);
  if (!p.ok) return remoteFailure(p.result.ok ? 'protocol' : p.result.failure, lib.host, { disk: true });
  const r = await clientFor().getBytes(p.target, remotePaths.bytes(diskId));
  await noteRemoteResult(orgId, id, r);
  if (!r.ok) return remoteFailure(r.failure, lib.host, { disk: true, detail: r.detail });
  if (r.value.byteLength > MAX_DISK_BYTES) return remoteFailure('too_large', lib.host, { disk: true });
  const sha256 = createHash('sha256').update(r.value).digest('hex');
  // Altered or changed mid-flight: nothing is handed over.
  if (sha256 !== r.etag) return remoteFailure('mismatch', lib.host, { disk: true });

  const title = oneLine(t.value.title?.title) || 'Disk';
  const diskNo = Number.isInteger(entry.diskNo) ? entry.diskNo : 1;
  const ext = entry.imageFormat === 'hfe' ? '.hfe' : '.adf';
  const name = downloadFilename(`${title} - Disk ${diskNo}${ext}`, null, sha256, ext);
  return new Response(r.value as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(r.value.byteLength),
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
