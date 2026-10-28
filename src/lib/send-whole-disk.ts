// Send a whole disk to a board as <name>.adf (spec §4 "Shortcuts on the disk pages"), on its own blob. Shared by
// POST /api/transfers/from-disk {whole:true} and the remote libraries' Send (POST /api/remote/[id]/disks/[diskId]/send,
// which first materialises the remote disk as a hidden row). SERVER ONLY.
import type { Db } from '@/db';
import { queueTransferFromBlob } from '@/lib/transfers';
import { findSendTarget, loadSendDisk } from '@/lib/send-targets';
import { adfSendName } from '@/lib/send-ui';
import { queueResponse } from '@/lib/send-http';

/**
 * The answer the route gives: 404 no_device / not_found, 400 not_adf for an HFE, else the queue's (201 {ids} or the
 * refusal). `includeHidden` is for the remote Send only: a local route never sends a hidden remote disk (R-6b).
 */
export async function queueWholeDiskSend(
  db: Db, orgId: string, userId: string, deviceId: string, diskId: string, opts: { includeHidden?: boolean } = {},
): Promise<Response> {
  if (!(await findSendTarget(db, orgId, deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });
  const disk = await loadSendDisk(db, orgId, diskId, opts);
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });
  if (disk.imageFormat === 'hfe') return Response.json({ error: 'not_adf' }, { status: 400 });
  return queueResponse(await queueTransferFromBlob(db, { orgId, deviceId, userId, path: adfSendName(disk), sha256: disk.sha256 }));
}
