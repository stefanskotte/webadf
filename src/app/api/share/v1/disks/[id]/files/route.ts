import { readUsage, readVolume, type AdfEntry } from '@/lib/adffs';
import { authorizeShare, notFound, shareJson } from '@/lib/share/api';
import { scopedDisk } from '@/lib/share/listing';
import type { ShareEntry, ShareFiles } from '@/lib/share/types';
import { diskStore } from '@/lib/storage';

export const dynamic = 'force-dynamic';
// Reads the whole image from the store, like every byte-touching handler here.
export const maxDuration = 60;

function toEntry(e: AdfEntry): ShareEntry {
  const out: ShareEntry = {
    name: e.name, kind: e.kind, sizeBytes: e.sizeBytes,
    modifiedAt: e.modifiedAt ? e.modifiedAt.toISOString() : null,
    protection: e.protection, comment: e.comment,
  };
  if (e.kind === 'dir') out.children = e.children.map(toEntry);
  return out;
}

/** The disk's file listing, as the local disk files page reads it; `{unreadable}` when it has no readable volume. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorizeShare(req, 'list');
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const disk = await scopedDisk(auth, id);
  if (!disk) return notFound();

  // An HFE image is not an ADF; the local page does not list one either.
  if (disk.imageFormat === 'hfe') return shareJson({ unreadable: disk.extractReason ?? 'hfe' } satisfies ShareFiles);

  let bytes: Uint8Array;
  try { bytes = await diskStore.read(disk.sha256); } catch { return shareJson({ error: 'unavailable' }, 503); }
  const vol = readVolume(bytes);
  if (!vol.ok) return shareJson({ unreadable: vol.reason } satisfies ShareFiles);
  const body: ShareFiles = {
    volume: {
      filesystem: vol.volume.filesystem, intl: vol.volume.intl, dirc: vol.volume.dirc, name: vol.volume.name,
      createdAt: vol.volume.createdAt ? vol.volume.createdAt.toISOString() : null,
      modifiedAt: vol.volume.modifiedAt ? vol.volume.modifiedAt.toISOString() : null,
    },
    root: vol.root.map(toEntry),
    usage: readUsage(bytes),
  };
  return shareJson(body);
}
