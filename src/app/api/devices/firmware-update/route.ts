import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { verifyPassword } from '@/lib/step-up';
import { requestFirmwareUpdate, cancelFirmwareUpdate } from '@/lib/firmware-update';
import { firmwareVersionSchema } from '@/lib/firmware-version';

const deviceIdList = z.array(z.string().min(1).max(64)).min(1).max(50);

const body = z.object({
  deviceIds: deviceIdList,
  version: firmwareVersionSchema,
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const { orgId, userId, email } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });

  // BEFORE anything is read or written. A wrong password must leave no trace
  // and reveal nothing about which devices or versions exist.
  if (!(await verifyPassword(email, parsed.data.password))) {
    return Response.json({ error: 'bad_password' }, { status: 401 });
  }

  const result = await requestFirmwareUpdate(
    orgId, userId, parsed.data.deviceIds, parsed.data.version,
  );
  if (result.ok) return Response.json({ count: result.count });
  // An unknown device and an unknown version are the same 404 on purpose:
  // neither answer may tell a caller which of the two it got wrong.
  if (result.kind === 'unknown_device' || result.kind === 'unknown_version') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json({ error: 'refused', refusals: result.refusals }, { status: 409 });
}

const cancelBody = z.object({ deviceIds: deviceIdList });

export async function DELETE(request: Request) {
  const { orgId } = await requireOrg();
  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = cancelBody.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const count = await cancelFirmwareUpdate(orgId, parsed.data.deviceIds);
  return Response.json({ count });
}
