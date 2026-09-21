import { z } from 'zod';
import { requireSuperAdmin } from '@/lib/superadmin';
import { requireOrg } from '@/lib/session';
import { publishRelease, PublishRefused } from '@/lib/firmware-releases';
import { firmwareVersionSchema } from '@/lib/firmware-version';

/**
 * Publish a firmware release.
 *
 * requireSuperAdmin() is called HERE, not merely in the (admin) layout. The
 * page guard is not the API guard: a page render and a later fetch are
 * separate requests, and only the second is what an attacker sends. Same
 * reasoning, and the same redirect-rather-than-JSON convention, as
 * /api/admin/invites.
 *
 * `sequence` is deliberately NOT in this schema. It is the ordering authority
 * and is assigned server-side; accepting it from a client would let a publish
 * insert itself anywhere in the history.
 *
 * Nothing here verifies the signature -- no code does, until increment 2
 * compiles the public key into the firmware (spec §4). It is recorded from
 * the first release so that increment 2 adds a check rather than re-signing a
 * registry's worth of history.
 */
const body = z.object({
  version: firmwareVersionSchema,
  semver: z.string().min(1).max(32),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  blobPath: z.string().min(1).max(256),
  signature: z.string().min(1).max(256),
  signingKeyId: z.string().min(1).max(64),
  notes: z.string().max(4000).nullable().default(null),
  security: z.boolean().default(false),
});

export async function POST(request: Request) {
  await requireSuperAdmin();
  // requireSuperAdmin deliberately returns no orgId -- an admin acts across
  // tenants. The row still needs a publisher, and the operator is an ordinary
  // user of this app too; that is the id it gets, exactly as issueInvite does.
  const { userId } = await requireOrg();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { id, sequence } = await publishRelease(parsed.data, userId);
    return Response.json({ id, sequence }, { status: 201 });
  } catch (e) {
    // A refusal is the caller's mistake, not a server fault: it names which
    // rule said no, so the publish script can print something actionable.
    if (e instanceof PublishRefused) {
      return Response.json({ error: e.reason }, { status: 409 });
    }
    throw e;
  }
}
