// Send from a library disk (spec §4 "Shortcuts on the disk pages"): chosen files and folders, each file one row
// with its relative path, protection and comment (R3-R5), or the whole disk as <name>.adf on its own blob. Reads
// the disk's CURRENT bytes, as Download does. All or nothing against the board's limits (Review Focus 3).
import { z } from 'zod';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readFile, readVolume } from '@/lib/adffs';
import { cleanAmigaPath, queueLoad, queueTransferFromBlob } from '@/lib/transfers';
import { findSendTarget, loadSendDisk } from '@/lib/send-targets';
import { pickFiles } from '@/lib/send-from-disk';
import { SEND_FILE_MAX, SEND_QUEUE_MAX_BYTES, SEND_QUEUE_MAX_FILES } from '@/lib/send-limits';
import { adfSendName } from '@/lib/send-ui';
import { queueResponse, refusalCode, storeSendBytes } from '@/lib/send-http';

export const maxDuration = 60;

const body = z.object({
  deviceId: z.string().min(1), diskId: z.string().min(1),
  whole: z.literal(true).optional(),
  blocks: z.array(z.number().int().nonnegative()).min(1).max(64).optional(),
}).refine((b) => (b.whole === true) !== (b.blocks !== undefined), { message: 'whole or blocks' });

export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const { deviceId, diskId, whole, blocks } = p.data;
  const db = getDb();
  if (!(await findSendTarget(db, orgId, deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });
  const disk = await loadSendDisk(db, orgId, diskId);
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });

  if (whole) {
    if (disk.imageFormat === 'hfe') return Response.json({ error: 'not_adf' }, { status: 400 });
    return queueResponse(await queueTransferFromBlob(db, { orgId, deviceId, userId, path: adfSendName(disk), sha256: disk.sha256 }));
  }

  let adf: Uint8Array;
  try { adf = await diskStore.read(disk.sha256); } catch { return Response.json({ error: 'blob_unavailable' }, { status: 503 }); }
  const vol = readVolume(adf);
  if (!vol.ok) return Response.json({ error: 'no_filesystem' }, { status: 404 });
  const picked = pickFiles(vol.root, blocks!);
  if (picked.length === 0) return Response.json({ error: 'not_found' }, { status: 404 });

  const files: { path: string; protection: number; comment: string; bytes: Uint8Array }[] = [];
  for (const f of picked) {
    const content = readFile(adf, f.block);
    if (!content || !content.complete) return Response.json({ error: 'unreadable', path: f.path }, { status: 422 });
    if (content.bytes.byteLength > SEND_FILE_MAX) return Response.json({ error: 'too_large', path: f.path }, { status: 413 });
    // A path the Amiga cannot take (over 255 bytes deep down a folder) refuses the lot here, before anything is queued.
    if (!cleanAmigaPath(f.path)) return Response.json({ error: 'bad_name', path: f.path }, { status: 400 });
    files.push({ path: f.path, protection: f.protection, comment: f.comment, bytes: content.bytes });
  }
  const load = await queueLoad(db, deviceId);
  const total = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  if (load.files + files.length > SEND_QUEUE_MAX_FILES || load.bytes + total > SEND_QUEUE_MAX_BYTES) {
    return Response.json({ error: 'queue_full' }, { status: 409 });
  }
  const ids: string[] = [];
  for (const f of files) {
    const sha256 = await storeSendBytes(f.bytes);
    const r = await queueTransferFromBlob(db, { orgId, deviceId, userId, path: f.path, sha256, protection: f.protection,
      comment: f.comment, bytes: f.bytes });
    // Only a race with another send can refuse here (the load was checked above); what was queued stays queued and
    // is named, and the answer is still a refusal, so the page never says "Queued" for a half-sent folder.
    if (!r.ok) return Response.json({ error: refusalCode(r.reason), ids }, { status: 409 });
    ids.push(r.id);
  }
  return Response.json({ ids }, { status: 201 });
}
