import { and, eq, or } from 'drizzle-orm';
import type { getDb } from '@/db';
import { devices } from '@/db/schema/devices';

/**
 * The device in `orgId` that holds the disk whose bytes are `sha256`, or null.
 *
 * THE RULE (operator, 2026-09-18): "if a volume is mounted, it cannot be
 * modified by the server. If modifications should happen, these must come
 * from the (mounted) Amiga side of things." Every server path that rewrites a
 * disk's BYTES asks this first and refuses when it answers a device: content
 * edits (applyDiskEdit), the volume rename, and the pages that offer both, so
 * the controls can say so up front. It covers the bytes only -- the
 * write-protect flag is a setting and still applies live, and title/metadata
 * edits never touch the disk.
 *
 * D-W-4: checked against EITHER side of a device's state, because a board
 * polling toward a new disk (desiredSha256) is just as much "somewhere this
 * edit would land on hardware" as one that has already converged
 * (mountedSha256). The name comes back so the refusal can say exactly where
 * to eject from, rather than only that something, somewhere, refused.
 */
export async function findHolder(
  db: ReturnType<typeof getDb>,
  orgId: string,
  sha256: string,
): Promise<{ name: string } | null> {
  const rows = await db
    .select({ name: devices.name })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      or(eq(devices.mountedSha256, sha256), eq(devices.desiredSha256, sha256)),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** The refusal reason every caller states, so they all read the same. */
export function mountedReason(holder: { name: string }): string {
  return `mounted on "${holder.name}"`;
}
