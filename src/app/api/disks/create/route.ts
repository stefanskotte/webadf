import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { MAX_VOLUME_NAME } from '@/lib/adffs/format';
import { createBlankDisk } from '@/lib/blank-disk';

export const maxDuration = 60;

const body = z.object({
  volumeName: z.string().trim().min(1).max(MAX_VOLUME_NAME).optional(),
  filesystem: z.enum(['OFS', 'FFS']).optional(),
  /** 'dd' (880 KB) unless asked for 'hd' (1.76 MB) -- HD writes spec §6.3. */
  density: z.enum(['dd', 'hd']).optional(),
  /** The collection currently being viewed, so a disk lands where you stand. */
  collectionId: z.string().optional(),
});

/** What a disk is called before anyone names it. */
const DEFAULT_NAME = 'Empty';

/** Make a blank, formatted Amiga disk (createBlankDisk: real the moment this returns). */
export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  let raw: unknown = {};
  try { raw = await request.json(); } catch { /* an empty body is a fine request */ }
  const parsed = body.safeParse(raw ?? {});
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const volumeName = parsed.data.volumeName ?? DEFAULT_NAME;
  // FFS by default (operator's ruling): faster, the norm from Workbench 2.0,
  // and more room per disk. OFS stays selectable for 1.3-era hardware.
  const filesystem = parsed.data.filesystem ?? 'FFS';

  // DD by default: the drive and most software expect it, and HD needs
  // Kickstart 3.0+ and firmware 1.4.1+ to play at all.
  const density = parsed.data.density ?? 'dd';

  // An unknown or foreign collectionId (a stale ?collection=) is ignored, never refused: without mustFile, never null.
  const made = (await createBlankDisk(orgId, { volumeName, filesystem, density, collectionId: parsed.data.collectionId ?? null }))!;
  return Response.json({ gameId: made.gameId, diskId: made.diskId, sha256: made.sha256, volumeName, filesystem, density, collectionId: made.collectionId });
}
