import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { verifyPassword } from '@/lib/step-up';
import { requestFirmwareUpdate, cancelFirmwareUpdate } from '@/lib/firmware-update';
import { firmwareVersionSchema } from '@/lib/firmware-version';
import { lockoutRemaining, recordFailure, clearFailures } from '@/lib/step-up-throttle';
import { MAX_UPDATE_BATCH } from '@/lib/firmware-update-rules';

// The cap is shared with the update bar, which disables Update past it and
// says how many to untick -- so a 400 here means a hand-rolled caller, not
// an operator who ticked one board too many.
const deviceIdList = z.array(z.string().min(1).max(64)).min(1).max(MAX_UPDATE_BATCH);

const body = z.object({
  deviceIds: deviceIdList,
  version: firmwareVersionSchema,
  password: z.string().min(1).max(200),
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

  // Throttled BEFORE the password is even checked. Without this the endpoint
  // is an unlimited oracle for the account's real password, aimed at exactly
  // the attacker step-up exists to stop -- one who already holds the session
  // cookie. better-auth's own limiter lives in its HTTP router and is
  // bypassed by direct auth.api calls.
  const locked = await lockoutRemaining(userId);
  if (locked > 0) {
    return Response.json(
      { error: 'too_many_attempts', retryAfterMs: locked },
      { status: 429, headers: { 'retry-after': String(Math.ceil(locked / 1000)) } },
    );
  }

  // A wrong password must leave no trace beyond the failure count, and reveal
  // nothing about which devices or versions exist.
  if (!(await verifyPassword(parsed.data.password))) {
    const lockedFor = await recordFailure(userId);
    return Response.json(
      lockedFor > 0
        ? { error: 'too_many_attempts', retryAfterMs: lockedFor }
        : { error: 'bad_password' },
      { status: lockedFor > 0 ? 429 : 401 },
    );
  }
  await clearFailures(userId);

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
