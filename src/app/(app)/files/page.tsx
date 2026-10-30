import { requireOrg } from '@/lib/session';
import { getDb } from '@/db';
import { nowMs } from '@/lib/clock';
import { listSendTargets } from '@/lib/send-targets';
import { getUserPrefs } from '@/lib/user-prefs';
import { formatPath, PANE_DEVICES, parsePath } from '@/lib/files/path';
import { paneDefaults } from '@/lib/files/view';
import { driverFor } from '@/lib/files/drivers';
import { Refused } from '@/lib/files/driver';
import { refusalWords } from '@/lib/files/words';
import { diskStripData } from '@/lib/files/disk-strip-data';
import { stripDiskOf } from '@/lib/files/manager-rules';
import type { Listing, StripData } from '@/lib/files/types';
import { PageHeader } from '@/components/shell/page-header';
import { FilesManager } from '@/components/files/files-manager';

export const metadata = { title: 'Files' };

// Listing a disk reads its image from the store, twice when both panes are inside disks: the same 60 s every
// byte-touching page and handler in this app sets.
export const maxDuration = 60;

/** A query value as a pane path: canonical when it parses on a pane's device (R1), `fallback` otherwise. */
function paneParam(raw: string | string[] | undefined, fallback: string): string {
  const p = typeof raw === 'string' ? parsePath(raw) : null;
  return p && PANE_DEVICES.includes(p.device) ? formatPath(p) : fallback;
}

/**
 * The pane's first listing; null when the place is gone, with the words when it cannot be read: a disk image the
 * store did not give back (with the disk the refusal named, for its strip), or an archive that does not open (Task 4).
 */
type First = { listing: Listing | null; error?: string; errorDisk?: string };
async function firstListing(ctx: { orgId: string; userId: string }, path: string): Promise<First> {
  try {
    const p = parsePath(path)!;
    return { listing: await driverFor(p.device)!.list(ctx, p) };
  } catch (e) {
    if (e instanceof Refused && (e.refusal.code === 'blob_unavailable' || e.refusal.code === 'archive_unreadable')) {
      return {
        listing: null, error: refusalWords(e.refusal.code),
        errorDisk: e.refusal.code === 'blob_unavailable' ? e.refusal.detail : undefined,
      };
    }
    throw e;
  }
}

/**
 * Files (spec 2026-10-29 §5): two panes over STASH: and LIBRARY: with the button column between them. The state lives
 * in the URL -- `?left=<path>&right=<path>&active=left|right` -- so Back and reload restore both panes; the manager
 * keeps it there as it navigates.
 */
export default async function FilesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { orgId, userId } = await requireOrg();
  const sp = await searchParams;
  // R5: a pane the address does not name opens where the Files settings say (a bare /files, the top nav, Back to it).
  const prefs = await getUserPrefs(userId);
  const d = paneDefaults(prefs.files.panes);
  const leftPath = paneParam(sp.left, d.left);
  const rightPath = paneParam(sp.right, d.right);
  const active = sp.active === 'right' ? 'right' : 'left';
  const ctx = { orgId, userId };
  const now = nowMs();
  const [left, right, targets] = await Promise.all([
    firstListing(ctx, leftPath), firstListing(ctx, rightPath), listSendTargets(getDb(), orgId, now),
  ]);
  // A pane at NET:/<board> names the board the Send zone starts on.
  const netBoard = [leftPath, rightPath].map((p) => parsePath(p)).find((p) => p?.device === 'NET' && p.segments.length >= 1)?.segments[0] ?? null;
  // The disk strip of each pane inside a disk (Task 9): one read per disk, even with both panes in it. A disk whose
  // image cannot be read still gets one (stripDiskOf, by the id its refusal named): the strip needs only the database,
  // and its History mends it.
  const pane = (r: First) => stripDiskOf({ listing: r.listing, errorDisk: r.errorDisk ?? null });
  const diskIds = [...new Set([pane(left), pane(right)].filter((x): x is string => !!x))];
  const strips = (await Promise.all(diskIds.map((id) => diskStripData(orgId, id)))).filter((x): x is StripData => x !== null);

  return (
    <>
      <PageHeader size="lg" eyebrow="Move files" title="Files" help="files" />
      <div className="px-4 pb-10 sm:px-7">
        <FilesManager
          initial={{ left: left.listing, right: right.listing, leftPath, rightPath, active, leftError: left.error, rightError: right.error,
            leftErrorDisk: left.errorDisk, rightErrorDisk: right.errorDisk, strips }}
          prefs={{ files: prefs.files, hideInfo: prefs.browse.hideInfo }}
          send={{ targets, initialBoard: netBoard, serverNow: now }}
        />
      </div>
    </>
  );
}
