import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { firmwareVersionSchema } from '@/lib/firmware-version';
import { updateProtocolSchema } from '@/lib/firmware-update-state';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices, pairingCodes } from '@/db/schema/devices';
import { mintDeviceToken } from '@/lib/device-token';
import { defaultDeviceName } from '@/lib/device-name';

// Device plane: deliberately unauthenticated. The device has no bearer token
// yet -- the pairing code it presents here IS the credential for this one
// call. Never gate this route behind requireOrg()/a session cookie, and
// never let src/proxy.ts's matcher cover it.
export const maxDuration = 60;

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

const registerBody = z.object({
  pairingCode: z.string().min(1).max(32),
  firmwareVersion: firmwareVersionSchema,
  updateProtocol: updateProtocolSchema.optional(),
  macAddress: z.string().regex(MAC_RE),
});

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    // Malformed JSON from an unauthenticated caller must still be a clean
    // 400, not an unhandled exception that surfaces as a 500.
    return null;
  }
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (body === null) {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = registerBody.safeParse(body);
  if (!parsed.success) {
    // { error: 'invalid_body', detail: ... } rather than the flattened object
    // living directly under `error` -- a C client parsing `error` as a string
    // could not otherwise tell this 400 apart from every other error shape
    // in the protocol, all of which put a plain string there.
    return Response.json(
      { error: 'invalid_body', detail: z.flattenError(parsed.error) },
      { status: 400 },
    );
  }

  // Codes are generated uppercase from an alphabet with no ambiguous
  // characters; folding case here is a courtesy for a device that echoes
  // back exactly what was keyed into it.
  const code = parsed.data.pairingCode.trim().toUpperCase();
  const db = getDb();

  // The claim must be atomic -- set consumed_at only if it is still null and
  // unexpired -- so two devices racing the same code cannot both win. A
  // read-then-write here would leave a window between the SELECT and the
  // UPDATE where a second request could read the same still-unconsumed row.
  const claimed = await db.update(pairingCodes)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(pairingCodes.code, code),
      isNull(pairingCodes.consumedAt),
      gt(pairingCodes.expiresAt, new Date()),
    ))
    .returning({ orgId: pairingCodes.orgId });

  if (claimed.length === 0) {
    return Response.json({ error: 'invalid_or_used_code' }, { status: 400 });
  }

  const { orgId } = claimed[0];
  const { plaintext, hash } = mintDeviceToken();
  const deviceId = randomUUID();
  // No name is collected at register time (the pairing body's optional name
  // isn't persisted anywhere -- see the pair route), so a device starts life
  // labelled by the one identifying detail it supplies about itself.
  //
  // Shared with the rename flow rather than inlined here: clearing an alias
  // RESETS to this exact string, so if the two ever diverged a "reset" would
  // produce a label the device never had.
  const name = defaultDeviceName(parsed.data.macAddress);

  // Only the hash is ever written. `plaintext` is returned once, below, and
  // never logged or stored.
  await db.insert(devices).values({
    id: deviceId,
    orgId,
    name,
    tokenHash: hash,
    firmwareVersion: parsed.data.firmwareVersion,
    updateProtocol: parsed.data.updateProtocol,
    macAddress: parsed.data.macAddress,
  });

  return Response.json({ token: plaintext, deviceId, name });
}
