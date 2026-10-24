import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { invites } from '@/db/schema/devices';
import { user } from '@/db/schema/auth';

/** Self-hosting P2 (spec D10). An invite's org is unused at sign-up (every user gets their own). */
export const BOOTSTRAP_ORG = 'bootstrap';
const ALPHABET = '23456789ABCDEFGHJKMNPRSTUVWXYZ'; // same as src/lib/invites.ts
const CODE_LEN = 8;
const TTL_MS = 365 * 24 * 3600 * 1000;

export async function ensureBootstrapInvite(url: string, adminEmail: string): Promise<string | null> {
  const db = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(user);
  if (n > 0) return null;
  const live = await db.select({ code: invites.code }).from(invites).where(and(
    eq(invites.orgId, BOOTSTRAP_ORG), isNull(invites.consumedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date()),
  )).limit(1);
  let code = live[0]?.code;
  if (!code) {
    code = Array.from({ length: CODE_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    await db.insert(invites).values({ code, orgId: BOOTSTRAP_ORG, createdByUserId: 'system', expiresAt: new Date(Date.now() + TTL_MS) });
  }
  return `Sign up as the first admin (use ${adminEmail}): ${url}/sign-up?invite=${code}`;
}
