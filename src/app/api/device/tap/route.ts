import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { tapDevice, tapNext } from '@/lib/nfc/store';
import { DISK_ID_RE } from '@/lib/nfc/rules';
import { parseBoot } from '@/lib/boot-disk';
import { noteBoot } from '@/lib/boot-disk-store';

export const maxDuration = 60;
const NO_STORE = { 'cache-control': 'no-store' };
// Not .strict(): an extra key (e.g. a body-supplied orgId) is ignored, not
// refused -- the org always comes from the device token. `action:'next'` and
// `diskId` together is refused explicitly below, since a union of two
// .strict() branches would reject it via {action, diskId} matching neither
// branch for the wrong reason (extra key) rather than the right one
// (both present).
const body = z.union([
  z.object({ diskId: z.string().regex(DISK_ID_RE) }),
  z.object({ action: z.literal('next') }),
]);

/** A tag read on the board (spec 2026-09-25 §5.2). Always 200 with an outcome:
 *  a 404 for a disk would tell a foreign id from an unknown one (D4). */
export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  // Neither branch's schema is .strict() (an extra body key like orgId must
  // still be ignored), so {action, diskId} together would otherwise match the
  // diskId branch with action silently stripped. Refuse that combination
  // explicitly, before the schema ever sees it.
  if (raw && typeof raw === 'object' && 'action' in raw && 'diskId' in raw) {
    return Response.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  // Disk at startup (boot-disk.ts): a tag tapped at the Kickstart screen arrives before the boot's first poll. The
  // boot is decided first, so "No disk" empties the OLD disk and the tap then mounts the new one -- never the reverse.
  const boot = parseBoot(new URL(request.url).searchParams);
  if (boot) await noteBoot(device.deviceId, boot);
  const result = 'action' in parsed.data
    ? await tapNext(device.deviceId, device.orgId, new Date())
    : await tapDevice(device.deviceId, device.orgId, parsed.data.diskId, new Date());
  return Response.json(result, { headers: NO_STORE });
}
