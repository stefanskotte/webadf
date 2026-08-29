import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@/db';
import { pairingCodes } from '@/db/schema/devices';
import { requireOrg } from '@/lib/session';
import { ALPHABET as CODE_ALPHABET } from '@/lib/invites';

// Human plane: a signed-in user mints a code to hand to a device. Nothing
// here is network-bound, but a maxDuration is required on every route.
export const maxDuration = 60;

const CODE_LEN = 6;
const TTL_MS = 10 * 60 * 1000;
// A collision (two live, unexpired codes drawn identically) is astronomically
// unlikely at 31^6 combinations, but the insert is a unique-key write, so a
// single retry loop turns "astronomically unlikely" into "the request never
// fails for this reason" for a cost of one extra query in the worst case.
const MAX_ATTEMPTS = 5;

// The body carries a human-chosen label for the device the user is about to
// pair. There is nowhere to persist it yet (pairing_codes has no name
// column -- see Task 2's schema), so it is validated and otherwise ignored
// by this endpoint; a later task can thread it through to the device once
// there is a place to put it. Validating it now still rejects a malformed
// body with 400 instead of silently accepting garbage.
const pairBody = z.object({
  name: z.string().min(1).max(100).optional(),
});

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export async function POST(request: Request) {
  const { userId, orgId } = await requireOrg();

  const parsed = pairBody.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  const db = getDb();
  const expiresAt = new Date(Date.now() + TTL_MS);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode();
    const inserted = await db.insert(pairingCodes)
      .values({ code, orgId, createdByUserId: userId, expiresAt })
      .onConflictDoNothing()
      .returning({ code: pairingCodes.code });

    if (inserted.length > 0) {
      return Response.json({ code, expiresAt: expiresAt.toISOString() });
    }
    // Collided with a still-live code -- draw again.
  }

  return Response.json({ error: 'could_not_mint_code' }, { status: 500 });
}
