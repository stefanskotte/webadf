import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { chooseNfcDevice, DISK_ID_RE, nfcWriteStatus } from '@/lib/nfc/rules';
import {
  cancelNfcWrite, listNfcDevices, readDiskForNfc, readNfcWriteState, requestNfcWrite,
} from '@/lib/nfc/store';

export const maxDuration = 60;
const NO_STORE = { 'cache-control': 'no-store' };

/*
 * The fob button: write one of your disks onto an NFC tag from the web, the
 * same request `pnpm nfc:write` arms (spec 2026-09-25 §5.5), for a person
 * rather than the operator's shell.
 *
 * No password step-up, unlike the firmware update: the worst a forged request
 * can do is put your own disk id on your own tag, and only if someone taps
 * one within two minutes. CSRF rests on Better Auth's SameSite=Lax cookie,
 * as the mount route's does -- see the note there.
 *
 * Every lookup is org-scoped in the store, and a board or disk of another org
 * gets the same 404 not_found as one that never existed.
 */

// The tag carries this id and the tap endpoint accepts only DISK_ID_RE's
// shape, so a disk id outside it would make a tag that can never mount.
const postBody = z.object({
  diskId: z.string().regex(DISK_ID_RE),
  deviceId: z.string().min(1).max(64).optional(),
});
const cancelBody = z.object({ deviceId: z.string().min(1).max(64), seq: z.number().int().min(1) });
const statusQuery = z.object({ deviceId: z.string().min(1).max(64), seq: z.coerce.number().int().min(1) });

const invalid = () => Response.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
const notFound = () => Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });

async function json(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

/** Arm a board: {diskId, deviceId?} -> {seq, deviceId, deviceName, title}. */
export async function POST(request: Request) {
  const { orgId } = await requireOrg();
  const parsed = postBody.safeParse(await json(request));
  if (!parsed.success) return invalid();
  const { diskId, deviceId } = parsed.data;

  const choice = chooseNfcDevice(await listNfcDevices(orgId), deviceId);
  if (!choice.ok) {
    if (choice.error === 'not_found') return notFound();
    // 409: the board is real and yours, it just cannot do this.
    if (choice.error === 'no_reader') return Response.json({ error: 'no_reader' }, { status: 409, headers: NO_STORE });
    return Response.json({ error: 'device_required' }, { status: 400, headers: NO_STORE });
  }
  const { device } = choice;

  const disk = await readDiskForNfc(orgId, diskId);
  if (!disk) return notFound();
  // requestNfcWrite re-checks the disk against the org itself; null here is
  // a disk deleted between the two reads, and gets the same answer.
  const seq = await requestNfcWrite(orgId, device.id, diskId, new Date());
  if (seq === null) return notFound();
  return Response.json({ seq, deviceId: device.id, deviceName: device.name, title: disk.title }, { headers: NO_STORE });
}

/** Where one request stands: ?deviceId&seq -> {state, reason?, uid?}. */
export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const sp = new URL(request.url).searchParams;
  const parsed = statusQuery.safeParse({ deviceId: sp.get('deviceId') ?? undefined, seq: sp.get('seq') ?? undefined });
  if (!parsed.success) return invalid();
  const { deviceId, seq } = parsed.data;

  const row = await readNfcWriteState(orgId, deviceId);
  if (!row) return notFound();
  const status = nfcWriteStatus(row, seq, new Date());
  if (!status) return notFound();
  return Response.json(status, { headers: NO_STORE });
}

/**
 * Withdraw one request: {deviceId, seq}. Only that seq -- cancelNfcWrite does
 * nothing if something newer (a CLI write, another tab) has replaced it, so a
 * dialog closing late cannot disarm someone else's request.
 */
export async function DELETE(request: Request) {
  const { orgId } = await requireOrg();
  const parsed = cancelBody.safeParse(await json(request));
  if (!parsed.success) return invalid();
  const { deviceId, seq } = parsed.data;

  // The org check: cancelNfcWrite itself is keyed by device id alone.
  if (!(await readNfcWriteState(orgId, deviceId))) return notFound();
  await cancelNfcWrite(deviceId, seq);
  return new Response(null, { status: 204, headers: NO_STORE });
}
