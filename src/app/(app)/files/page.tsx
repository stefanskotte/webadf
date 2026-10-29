import { requireOrg } from '@/lib/session';
import { getUserPrefs } from '@/lib/user-prefs';
import { formatPath, parsePath } from '@/lib/files/path';
import { BlobUnavailableError, listLibrary } from '@/lib/files/library';
import { refusalWords } from '@/lib/files/words';
import { diskStripData } from '@/lib/files/disk-strip-data';
import type { Listing, StripData } from '@/lib/files/types';
import { PageHeader } from '@/components/shell/page-header';
import { FilesManager } from '@/components/files/files-manager';

export const metadata = { title: 'Files' };

// Listing a disk reads its image from the store, twice when both panes are inside disks: the same 60 s every
// byte-touching page and handler in this app sets.
export const maxDuration = 60;

const DEFAULT_PATH = 'LIBRARY:';

/** A query value as a pane path: canonical when it parses, the default otherwise. Increment 1 lists LIBRARY: only. */
function paneParam(raw: string | string[] | undefined): string {
  const p = typeof raw === 'string' ? parsePath(raw) : null;
  return p && p.device === 'LIBRARY' ? formatPath(p) : DEFAULT_PATH;
}

/** The pane's first listing; null when the place is gone, with the words when the image itself cannot be read. */
async function firstListing(ctx: { orgId: string; userId: string }, path: string): Promise<{ listing: Listing | null; error?: string }> {
  try {
    return { listing: await listLibrary(ctx, parsePath(path)!) };
  } catch (e) {
    if (e instanceof BlobUnavailableError) return { listing: null, error: refusalWords('blob_unavailable') };
    throw e;
  }
}

/**
 * Files (spec 2026-10-29 §5): two panes over LIBRARY: with the button column between them. The state lives in the
 * URL -- `?left=<path>&right=<path>&active=left|right` -- so Back and reload restore both panes; the manager keeps
 * it there as it navigates.
 */
export default async function FilesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { orgId, userId } = await requireOrg();
  const sp = await searchParams;
  const leftPath = paneParam(sp.left);
  const rightPath = paneParam(sp.right);
  const active = sp.active === 'right' ? 'right' : 'left';
  const ctx = { orgId, userId };
  const [left, right, prefs] = await Promise.all([firstListing(ctx, leftPath), firstListing(ctx, rightPath), getUserPrefs(userId)]);
  // The disk strip of each pane inside a disk (Task 9): one read per disk, even with both panes in it.
  const diskIds = [...new Set([left.listing?.disk?.diskId, right.listing?.disk?.diskId].filter((x): x is string => !!x))];
  const strips = (await Promise.all(diskIds.map((id) => diskStripData(orgId, id)))).filter((x): x is StripData => x !== null);

  return (
    <>
      <PageHeader size="lg" eyebrow="Move files" title="Files" />
      <div className="px-4 pb-10 sm:px-7">
        <FilesManager
          initial={{ left: left.listing, right: right.listing, leftPath, rightPath, active, leftError: left.error, rightError: right.error, strips }}
          prefs={{ sort: prefs.files.sort }}
        />
      </div>
    </>
  );
}
