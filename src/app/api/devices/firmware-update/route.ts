import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { stepUpGate } from '@/lib/step-up-gate';
import { getUserPrefs } from '@/lib/user-prefs';
import { requestFirmwareUpdate, cancelFirmwareUpdate } from '@/lib/firmware-update';
import { firmwareVersionSchema } from '@/lib/firmware-version';
import { MAX_UPDATE_BATCH } from '@/lib/firmware-update-rules';

// The cap is shared with the update bar, which disables Update past it and
// says how many to untick -- so a 400 here means a hand-rolled caller, not
// an operator who ticked one board too many.
const deviceIdList = z.array(z.string().min(1).max(64)).min(1).max(MAX_UPDATE_BATCH);

const body = z.object({
  deviceIds: deviceIdList,
  version: firmwareVersionSchema,
  // Optional ONLY for a user whose skipPassword preference is on; POST
  // refuses its absence otherwise, with the same 400 a bad body gets.
  password: z.string().min(1).max(200).optional(),
});

// The password check plus two DB round trips. Every sibling route under
// api/devices/ declares this; pair/route.ts states the convention.
export const maxDuration = 60;

export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });

  // The step-up password, unless THIS user has turned the prompt off
  // (UserPrefs.firmware.skipPassword, which itself took the password to turn
  // on: api/me/prefs/firmware-skip-password). Per user, not per org. With it
  // off -- the default, and also what a failed preference read gives --
  // everything below is exactly as it always was: a missing password is the
  // same 400, a wrong one the same counted 401/429 (src/lib/step-up-gate.ts).
  // With it on, a password sent anyway is not checked.
  const skip = await getUserPrefs(userId).then((p) => p.firmware.skipPassword === true, () => false);
  if (!skip) {
    if (parsed.data.password === undefined) return Response.json({ error: 'invalid_body' }, { status: 400 });
    const refused = await stepUpGate(userId, parsed.data.password);
    if (refused) return refused;
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
