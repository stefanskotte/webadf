import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, like } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import { requireSuperAdmin } from '@/lib/superadmin';
import { firmwareStore } from '@/lib/storage';
import { refuseImageMarkers, FIRMWARE_MAX_BYTES } from '@/lib/firmware-manifest';
import { isTestBuild } from '@/lib/firmware-github-release';
import { TEST_BUILD_NOTES_PATTERN } from '@/lib/firmware-releases';
import { looksLikeTestBuild } from '@/lib/admin-firmware';

const bodySchema = z.object({ notes: z.string().trim().min(1).max(2000) });

/** The image bytes, or 'too_large' past FIRMWARE_MAX_BYTES, or null when the store cannot give them. */
async function readImage(blobPath: string): Promise<Buffer | 'too_large' | null> {
  const blob = await firmwareStore.readStream(blobPath).catch(() => null);
  if (!blob) return null;
  if (blob.sizeBytes !== null && blob.sizeBytes > FIRMWARE_MAX_BYTES) {
    await blob.stream.cancel().catch(() => {});
    return 'too_large';
  }
  const reader = (blob.stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > FIRMWARE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

/**
 * Promote a TEST build to a release (A7 spec §3): its notes are replaced with release notes, and nothing else changes.
 *
 * The notes are not part of the signed manifest (firmwareManifest: version, sequence, sha256, size), so the signature
 * a board checks stays valid; every other column is left alone. Once the notes no longer start "TEST build", every org
 * is offered the build (releaseVisibleToSql), so the image is checked the way the publisher checks a release:
 * the stored bytes must match the row's sha256, then refuseImageMarkers with the NEW notes refuses a bench-only image (debug command, DF1-default, PaulaNET loopback, A2B
 * discard) that the "TEST build" prefix was the only thing letting through.
 *
 * The update's WHERE carries `notes like 'TEST build%'`, so a second promote, or two racing, gets a 409 rather than
 * overwriting release notes.
 *
 * Publishing still happens from the operator's Mac (the signing key is there); the GitHub release is made from the
 * build folder with `pnpm firmware:publish --github-only`, which a browser cannot run.
 */
export async function POST(
  request: Request,
  // Next 16: params is a Promise. Do NOT import RouteContext -- it is ambient.
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSuperAdmin();
  const { id } = await params;

  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_notes' }, { status: 400 });
  const notes = parsed.data.notes;
  if (looksLikeTestBuild(notes)) return Response.json({ error: 'still_test_build' }, { status: 400 });

  const db = getDb();
  const [rel] = await db
    .select({ notes: firmwareReleases.notes, blobPath: firmwareReleases.blobPath, sha256: firmwareReleases.sha256 })
    .from(firmwareReleases)
    .where(eq(firmwareReleases.id, id))
    .limit(1);
  if (!rel) return Response.json({ error: 'not_found' }, { status: 404 });
  if (!isTestBuild(rel.notes)) return Response.json({ error: 'not_test_build' }, { status: 409 });

  const bytes = await readImage(rel.blobPath);
  if (bytes === null) return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  if (bytes === 'too_large') {
    return Response.json({ error: 'image_too_large', reason: 'image is over the 2 MB limit' }, { status: 409 });
  }
  // The bytes checked must be the bytes the row's signature covers (its sha256). A blob replaced under the same path
  // would otherwise have its markers checked while boards are offered the signed image -- or the reverse.
  if (createHash('sha256').update(bytes).digest('hex') !== rel.sha256) {
    return Response.json({ error: 'image_mismatch' }, { status: 409 });
  }
  const refused = refuseImageMarkers(bytes, notes);
  if (refused) return Response.json({ error: 'bench_image', reason: refused }, { status: 409 });

  const [updated] = await db
    .update(firmwareReleases)
    .set({ notes })
    // Pinned to the image just checked: the row's bytes, by hash and path, are the ones that passed.
    .where(and(eq(firmwareReleases.id, id), like(firmwareReleases.notes, TEST_BUILD_NOTES_PATTERN),
      eq(firmwareReleases.sha256, rel.sha256), eq(firmwareReleases.blobPath, rel.blobPath)))
    .returning();
  if (!updated) return Response.json({ error: 'not_test_build' }, { status: 409 });
  return Response.json(updated);
}
