import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, games } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readVolume } from '@/lib/adffs';
import { PageHeader } from '@/components/shell/page-header';
import { VolumeHeader } from '@/components/disks/volume-header';
import { FileTree } from '@/components/disks/file-tree';

export const dynamic = 'force-dynamic';

export default async function DiskFilesPage(props: PageProps<'/disks/[id]/files'>) {
  const { orgId } = await requireOrg();
  const { id } = await props.params;

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
  const title = volume?.ok ? volume.volume.name || filename : filename;

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
          { label: 'Library', href: '/library' },
          { label: disk.gameTitle ?? 'Untitled', href: `/games/${disk.gameId}` },
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
          <>
            <VolumeHeader result={volume} filename={filename} />
            {volume.ok && <FileTree entries={volume.root} diskId={id} />}
          </>
        )}
      </div>
    </>
  );
}
