import { notFound } from 'next/navigation';
import { Link } from '@/components/shell/link';
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
        eyebrow={`Library / Disk ${disk.diskNo}`}
        title={title}
        subtitle={filename}
        actions={
          // Named for where it goes, which is that entry's own page -- and
          // that page's heading IS this title. It used to read "← Game",
          // which is the `games` table's vocabulary leaking into the UI and
          // is simply wrong on a Workbench or utility disk, the exact case
          // this browser is most useful for.
          <Link href={`/games/${disk.gameId}`}
                title={disk.gameTitle ?? undefined}
                className="inline-block max-w-[16rem] shrink-0 truncate text-[12.5px] font-semibold"
                style={{ color: 'var(--on-dark-muted)' }}>
            ← {disk.gameTitle ?? 'Back'}
          </Link>
        }
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
