import { notFound } from 'next/navigation';
import { and, eq, or } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, games } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readVolume, readUsage } from '@/lib/adffs';
import { listCollections } from '@/lib/collections';
import { resolveFrom, libraryTrail, fromQuery } from '@/lib/trail';
import { PageHeader } from '@/components/shell/page-header';
import { VolumeHeader } from '@/components/disks/volume-header';
import { FileTree } from '@/components/disks/file-tree';
import { FileEditProvider, FileToolbar, type EditDisabled } from '@/components/disks/file-actions';

export const dynamic = 'force-dynamic';

export default async function DiskFilesPage(props: PageProps<'/disks/[id]/files'>) {
  const { orgId } = await requireOrg();
  const { id } = await props.params;
  // Same untrusted-input rule as the game page: resolved against this org's
  // own collections before its name is rendered.
  const sp = await props.searchParams;
  const from = typeof sp.from === 'string' ? sp.from : undefined;
  const collections = await listCollections(orgId);

  // THE ENTITLEMENT is the boundary, not the disk row -- disks.orgId is an
  // independent column that can drift from its game's org. Identical to the
  // pair /api/disks/[id]/adf uses.
  const rows = await getDb()
    .select({
      sha256: disks.sha256, diskNo: disks.diskNo, gameId: disks.gameId,
      tosecName: disks.tosecName, sourceFilename: entitlements.sourceFilename,
      gameTitle: games.title,
    })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    // Only to label the back link with where it actually goes. A LEFT join,
    // and scoped on orgId as well as the id: nothing in the schema guarantees
    // disks.orgId matches its game's org (listGames documents the same
    // drift), and a missing title must degrade the label, never the page.
    .leftJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, orgId)))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);

  // notFound(), never a 403: the page must not confirm that another
  // organization's disk exists.
  const disk = rows[0];
  if (!disk) notFound();

  const filename = disk.tosecName ?? disk.sourceFilename ?? `${disk.sha256.slice(0, 12)}.adf`;

  let bytes: Uint8Array | null = null;
  try {
    bytes = await diskStore.read(disk.sha256);
  } catch {
    bytes = null;
  }

  const volume = bytes ? readVolume(bytes) : null;
  // Null for a disk whose bitmap cannot be trusted; the header says so
  // rather than showing a figure someone might act on.
  const usage = bytes ? readUsage(bytes) : null;
  const title = volume?.ok ? volume.volume.name || filename : filename;

  // Same holder check applyDiskEdit runs before any write (D-W-4): a device
  // that has this disk mounted OR merely desires it is a reason to refuse,
  // because a board polling toward it is just as much "somewhere this edit
  // would land on hardware" as one already converged. Run here too, before
  // any edit is attempted, so the controls can say so up front instead of
  // only failing once someone tries.
  const holders = bytes ? await getDb()
    .select({ name: devices.name })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      or(eq(devices.mountedSha256, disk.sha256), eq(devices.desiredSha256, disk.sha256)),
    ))
    .limit(1) : [];
  const holder = holders[0] ?? null;

  // The three ways editing is refused, in the same priority applyDiskEdit
  // itself would hit them: mounted is checked BEFORE the bytes are even
  // read (D-W-4), so it takes precedence here too; no-filesystem and
  // bitmap-untrusted only arise once the (pure) edit is actually attempted
  // against the volume, no-filesystem first since it is the more
  // fundamental refusal. A disk that isn't even readable never reaches
  // this (the blob-unavailable branch below skips the editor entirely).
  // Stated as a reason, never by just hiding the controls (§6) -- "this
  // disk is unusual" has to read differently from "this feature is
  // missing".
  const disabled: EditDisabled | null =
    holder
      ? { reason: 'mounted', message: `This disk is mounted on "${holder.name}" — eject it there before editing.` }
      : volume && !volume.ok
        ? { reason: 'no-filesystem', message: 'This disk has no filesystem, so there is nothing to add files to.' }
        : usage === null
          ? {
              reason: 'bitmap-untrusted',
              message: "This disk's allocation bitmap can't be trusted, so blocks can't be safely allocated. Editing is disabled.",
            }
          : null;

  return (
    <>
      <PageHeader
        // The full chain, and the middle crumb is named for the entry rather
        // than typed as "Game" -- the `games` table's vocabulary is simply
        // wrong on a Workbench or utility disk, which is the exact case this
        // browser is most useful for. That naming rule came from the back
        // link this trail replaces; it is kept, not rediscovered.
        //
        // "Disk N" is a crumb rather than a duplicate of the heading: the h1
        // here is the VOLUME's name, which is a different fact, and on a
        // multi-disk set the number is the only thing saying which one you
        // opened.
        eyebrow={[
          ...libraryTrail(resolveFrom(from, collections)),
          // The collection is carried onward here too, so stepping back up to
          // the title does not silently lose it.
          { label: disk.gameTitle ?? 'Untitled', href: `/games/${disk.gameId}${fromQuery(from)}` },
          { label: `Disk ${disk.diskNo}` },
        ]}
        title={title}
        subtitle={filename}
      />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        {volume === null ? (
          <div className="glass-card p-5 text-[13px]" style={{ color: 'var(--amber-text)' }}
               data-testid="blob-unavailable">
            The stored bytes for this disk could not be read.
          </div>
        ) : (
          <FileEditProvider diskId={id} disabled={disabled} tosecName={disk.tosecName}>
            <VolumeHeader result={volume} filename={filename} usage={usage} />
            {/*
              Shown even when there is no filesystem to browse -- a disk
              with nothing to add a file to still gets the toolbar, disabled
              with that reason, rather than the controls simply not existing.
            */}
            <FileToolbar />
            {volume.ok && <FileTree entries={volume.root} diskId={id} />}
          </FileEditProvider>
        )}
      </div>
    </>
  );
}
