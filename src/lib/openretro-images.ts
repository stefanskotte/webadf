// The ONLY file in this project that makes a request to openretro.org.
//
// openretro.org is a volunteer-run community database, not a paid API. Every
// rule below exists for that reason and none of them is optional:
//   * one request at a time, never in parallel, with a delay between;
//   * a User-Agent that says who we are, so its operators can find us;
//   * never re-fetch an image already stored.
// The caller additionally enforces a hard cap per sweep run.

import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { imageStore } from '@/lib/storage';
import { openretroImages } from '@/db/schema/openretro';

/**
 * Server-side resize. Measured on a real cover: full size is 1,029,484 bytes,
 * ?size=400 is 381,535 -- a 63% saving. Note ?width= is silently IGNORED and
 * serves full size, and ?w= returns a 500, so this parameter name is the one
 * that works and getting it wrong costs three times the storage.
 */
const IMAGE_SIZE = 400;
const DELAY_MS = 500;
const UA = 'webadf/1.0 (Amiga disk library; +https://webadf.vercel.app)';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function imageUrl(sha1: string): string {
  return `https://openretro.org/image/${sha1}?size=${IMAGE_SIZE}`;
}

export async function ensureImage(
  entryUuid: string, sha1: string,
  kind: 'front' | 'title' | 'screenshot', ordinal: number,
) {
  const db = getDb();
  const existing = await db.select({ sha1: openretroImages.sha1 })
    .from(openretroImages).where(eq(openretroImages.sha1, sha1)).limit(1);
  if (existing.length > 0) return { stored: false, bytes: 0 };

  const url = imageUrl(sha1);
  await wait(DELAY_MS);
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`openretro image ${sha1}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // Stored under OpenRetro's own sha1, in a key namespace separate from the
  // ADFs (which live under adf/<sha256>). imageStore tolerates an object that
  // is already present but has no row -- see its put().
  const stored = await imageStore.put(sha1, bytes, res.headers.get('content-type') ?? 'image/png');

  await db.insert(openretroImages).values({
    sha1, entryUuid, kind, ordinal, storageKey: stored.key, url: stored.url,
    sizeBytes: bytes.byteLength, sourceUrl: url,
  }).onConflictDoNothing();

  return { stored: true, bytes: bytes.byteLength };
}
