import { notFound } from 'next/navigation';
import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements, games, blobs } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { orgFilter } from '@/db/scope';
import { findHolder } from '@/lib/disk-holder';
import { ejectMessage, mountedReason } from '@/lib/mount-wording';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readVolume, readUsage, type AdfEntry } from '@/lib/adffs';
import { listCollections } from '@/lib/collections';
import { resolveFrom, libraryTrail, fromQuery } from '@/lib/trail';
import { loadEntries } from '@/lib/disk-history/store';
import { materialise } from '@/lib/disk-history/chain';
import { loadHistory, type HistoryVersion } from '@/lib/disk-history/history';
import { PageHeader } from '@/components/shell/page-header';
import { VolumeHeader } from '@/components/disks/volume-header';
import { FileTree } from '@/components/disks/file-tree';
import { DropStaging } from '@/components/disks/drop-staging';
import { FileEditProvider, FileToolbar, type EditDisabled } from '@/components/disks/file-actions';
import { HistoryPanel } from '@/components/disks/history-panel';

export const dynamic = 'force-dynamic';

// The same 60s every byte-touching handler in this app sets (volume-name,
// files, files/[block], files/batch, disks/[id]/adf, restore), and this page
// does more blob I/O than any of them: materialising a `?version=` can read a
// snapshot plus up to MAX_CHAIN_DEPTH deltas, and the History panel then walks
// the newest stretch of the chain. The platform default would cut a
// long-history disk off mid-render.
export const maxDuration = 60;

/**
 * Every directory already on this disk, keyed by its root-relative path
 * ('' for the root itself) to the entries it already holds -- what
 * `stageDrop` (Task 3) calls `existingNamesByDir`, and what the staging
 * area re-derives live as a person edits a name (drop-staging.tsx). Built
 * here, once, from the same `AdfEntry[]` the tree already renders, rather
 * than a second read of the volume.
 *
 * Carries each entry's `kind` alongside its `name` (fix round 1, Finding
 * 2) -- a name-only map cannot tell a same-named FILE from a same-named
 * DIRECTORY apart, and that distinction is exactly what decides whether
 * "replace" is even a sound offer for a colliding row (`replaceFile`
 * requires `ST_FILE`; the batch route refuses a mismatched replace
 * correctly, but only after the whole batch has already been attempted).
 */
function existingNamesByDir(
  entries: AdfEntry[],
  prefix = '',
): Record<string, { name: string; kind: 'file' | 'dir' }[]> {
  const out: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    [prefix]: entries.map((e) => ({ name: e.name, kind: e.kind })),
  };
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      Object.assign(out, existingNamesByDir(entry.children, path));
    }
  }
  return out;
}

export default async function DiskFilesPage(props: PageProps<'/disks/[id]/files'>) {
  const { orgId } = await requireOrg();
  const { id } = await props.params;
  // Same untrusted-input rule as the game page: resolved against this org's
  // own collections before its name is rendered.
  const sp = await props.searchParams;
  const from = typeof sp.from === 'string' ? sp.from : undefined;
  const collections = await listCollections(orgId);

  // `?version=<seq>` (time machine, Task 3): browse an earlier version of
  // this disk instead of its head. Validated strictly against digits only --
  // `Number('')`, `Number(' ')` and `Number('1e3')` all coerce to something
  // that LOOKS numeric, so a regex on the raw string is the actual gate, not
  // Number.isInteger on its own. Anything else here is a 404, never a
  // silent fallback to the head: a URL that says version 3 must never show
  // version 7 (task brief).
  //
  // `sp.version` is a `string[]` when the param is repeated
  // (`?version=1&version=2`) -- Task 3 fix round 1's carried-over finding.
  // The old `typeof === 'string'` check treated that shape the same as
  // "absent", so a repeated param silently fell through to the head with no
  // banner at all: the one case this whole gate exists to prevent, reached
  // by a different route. `sp.version !== undefined` catches it alongside
  // every other malformed value, and the `typeof` check below turns it into
  // the same 404 as any other malformed version rather than a silent
  // fallback.
  let historicalSeq: number | null = null;
  if (sp.version !== undefined) {
    if (typeof sp.version !== 'string' || !/^\d+$/.test(sp.version)) notFound();
    historicalSeq = Number(sp.version);
    if (!Number.isSafeInteger(historicalSeq)) notFound();
  }

  // THE ENTITLEMENT is the boundary, not the disk row -- disks.orgId is an
  // independent column that can drift from its game's org. Identical to the
  // pair /api/disks/[id]/adf uses.
  const rows = await getDb()
    .select({
      sha256: disks.sha256, diskNo: disks.diskNo, gameId: disks.gameId,
      tosecName: disks.tosecName, sourceFilename: entitlements.sourceFilename,
      gameTitle: games.title,
      // NOT the same question as `tosecName IS NOT NULL`: that column holds
      // the uploaded (or, for an authored disk, the volume-derived) filename
      // right up until a real match overwrites it (HANDOFF.md's own
      // cross-reference trap, and /api/disks/create stamps
      // `${volumeName}.adf` into every blank disk it creates). matchState is
      // the actual verdict -- 'matched' | 'none' | 'ambiguous' | null (not
      // yet checked) -- and only 'matched' means this disk really has a
      // TOSEC identity to lose.
      matchState: blobs.matchState,
    })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    // Global, not per-tenant (blobs has no orgId), and LEFT: a blob the
    // sweeper hasn't reached yet has no row-level state to report beyond
    // matchState being null, which the D-W-3 gate below already treats the
    // same as 'none'.
    .leftJoin(blobs, eq(blobs.sha256, disks.sha256))
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

  // D-W-3's warning is for a disk that REALLY has a TOSEC identity to drop,
  // not any disk whose (frequently uploader-chosen) tosecName happens to be
  // non-null -- see the query comment above. `tosecName` here still carries
  // the canonical rom name, because applyMatch only ever overwrites it WHEN
  // it also stamps matchState 'matched' (tosec-apply.ts / tosec-sweep.ts),
  // so the two stay in lockstep for exactly the disks this should fire for.
  const matchedTosecName = disk.matchState === 'matched' ? disk.tosecName : null;

  // A version other than the head must exist in THIS disk's own history --
  // checked against loadEntries(id), not against the seq space in general,
  // so version 3 of a different disk can never be reached through this
  // disk's URL. An unwritten disk has no rows here at all (version 0 is
  // created lazily at the first change, store.ts), so any `?version=` on it
  // is unknown -- correctly a 404, not a re-derived "version 0".
  let historyEntries: Awaited<ReturnType<typeof loadEntries>> | null = null;
  if (historicalSeq !== null) {
    historyEntries = await loadEntries(id);
    if (!historyEntries.some((entry) => entry.seq === historicalSeq)) notFound();
  }

  // Read the bytes to show: the materialised historical version when one was
  // asked for, the disk's own head blob otherwise. Both failure modes land
  // on the same "stored bytes could not be read" branch below, including a
  // broken delta chain (HistoryError) -- a person browsing history gets a
  // clear degrade rather than a crashed page for what is, either way, bytes
  // this page cannot show.
  let bytes: Uint8Array | null = null;
  try {
    bytes = historicalSeq !== null && historyEntries
      ? await materialise(historyEntries, historicalSeq, (sha256) => diskStore.read(sha256))
      : await diskStore.read(disk.sha256);
  } catch {
    bytes = null;
  }

  const volume = bytes ? readVolume(bytes) : null;
  // Null for a disk whose bitmap cannot be trusted; the header says so
  // rather than showing a figure someone might act on.
  const usage = bytes ? readUsage(bytes) : null;
  const title = volume?.ok ? volume.volume.name || filename : filename;

  // Same holder check applyDiskEdit runs before any write (D-W-4, findHolder): a device
  // that has this disk mounted OR merely desires it is a reason to refuse,
  // because a board polling toward it is just as much "somewhere this edit
  // would land on hardware" as one already converged. Run here too, before
  // any edit is attempted, so the controls can say so up front instead of
  // only failing once someone tries.
  //
  // Computed regardless of `historicalSeq` -- Task 5's History panel needs
  // it too (a Restore always rewrites the CURRENT head, `disk.sha256`,
  // whichever version happens to be on screen), even though `disabled`
  // below still ignores it while browsing a historical version, for the
  // reason its own comment gives.
  const holder = bytes ? await findHolder(getDb(), orgId, disk.sha256) : null;

  // The four ways editing is refused. Browsing a historical version takes
  // priority over every other reason -- mounted, no-filesystem and
  // bitmap-untrusted all describe the CURRENT disk, and while looking at an
  // old version none of them is the reason editing is off; the reason is
  // that this isn't the disk's current state at all. Reusing the SAME
  // `EditDisabled` mechanism (not a second gate) is what already turns off
  // every edit control, the toolbar, and drop staging in one place -- see
  // file-actions.tsx, file-tree.tsx and drop-staging.tsx, all of which read
  // `disabled` from this one context.
  //
  // The other three, in the same priority applyDiskEdit itself would hit
  // them: mounted is checked BEFORE the bytes are even read (D-W-4), so it
  // takes precedence here too; no-filesystem and bitmap-untrusted only
  // arise once the (pure) edit is actually attempted against the volume,
  // no-filesystem first since it is the more fundamental refusal. A disk
  // that isn't even readable never reaches this (the blob-unavailable
  // branch below skips the editor entirely). Stated as a reason, never by
  // just hiding the controls (§6) -- "this disk is unusual" has to read
  // differently from "this feature is missing".
  const disabled: EditDisabled | null =
    historicalSeq !== null
      ? {
          reason: 'historical',
          message: `This is version ${historicalSeq} of this disk, shown read-only. Return to the current version to make changes.`,
        }
      : holder
        ? { reason: 'mounted', message: ejectMessage(mountedReason(holder.name), 'editing') }
        : volume && !volume.ok
          ? { reason: 'no-filesystem', message: 'This disk has no filesystem, so there is nothing to add files to.' }
          : usage === null
            ? {
                reason: 'bitmap-untrusted',
                message: "This disk's allocation bitmap can't be trusted, so blocks can't be safely allocated. Editing is disabled.",
              }
            : null;

  // The mounted-refusal wording for the History panel's Restore action --
  // reusing the exact ejectMessage/mountedReason pair `disabled` above
  // already builds for editing, per the task brief ("do not invent an eject
  // here"). Restore has no "editing"/"renaming" action word of its own, so
  // it is left off, landing on ejectMessage's own default ("eject it there
  // first").
  const mountedMessage = holder ? ejectMessage(mountedReason(holder.name)) : null;

  // Every version of this disk, newest first, for the History panel below
  // the tree -- always attempted, whether the page is showing the head or a
  // historical version, since the panel itself is the one place both are
  // reachable from. `deviceNames` is looked up once here rather than by
  // `loadHistory` itself, so a disk with a long history costs one query for
  // every device label, not one per version (loadHistory's own doc comment).
  //
  // A broken chain here is NOT folded into the same `bytes === null` /
  // blob-unavailable branch the volume read above uses: that branch is
  // about today's readable bytes, and a broken OLDER link in the chain must
  // not hide a disk whose current bytes are perfectly fine. Reported as its
  // own degrade instead (`historyUnavailable`), distinct from "this disk
  // has never been edited" (`historyVersions` simply empty, no error) --
  // conflating the two would show a person a false "nothing has changed
  // here" for what is actually a server-side fault.
  let historyVersions: HistoryVersion[] = [];
  let historyUnavailable = false;
  try {
    const deviceRows = await getDb()
      .select({ id: devices.id, name: devices.name })
      .from(devices)
      .where(orgFilter(devices, orgId));
    const deviceNames = new Map(deviceRows.map((d) => [d.id, d.name] as const));
    historyVersions = await loadHistory(orgId, id, deviceNames);
  } catch (err) {
    // EVERY failure here degrades to the banner, deliberately. `loadHistory`
    // throws three unrelated classes -- HistoryError for a broken chain,
    // DeltaError for a delta payload that will not decode or apply, and a
    // plain Error from `diskStore.read` for a blob that is missing or
    // unreachable -- and catching only the first would let the other two
    // replace this ENTIRE page (tree, toolbar, volume header, chrome) with
    // Next's default error page, for a disk whose current bytes are perfectly
    // readable. There is no error.tsx anywhere under src/app to soften that.
    // The read failure is the likely one: it happens once per version, with
    // useCache false, so the chance of catching a transient 5xx rises with
    // history length. Logged, because a broken chain or an unreadable blob is
    // a server-side fault worth seeing, not a normal state.
    console.error(`disk files page: history unavailable for disk ${id}`, err);
    historyUnavailable = true;
  }

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
        {/*
          Shown above everything else, including the blob-unavailable
          branch below -- a person who asked for version 3 and got "could
          not be read" still needs to know WHICH version failed and how to
          get back, not just that something did.
        */}
        {historicalSeq !== null && (
          <div
            className="glass-card p-4 text-[13px]"
            style={{ color: 'var(--amber-text)' }}
            data-testid="version-banner"
            data-version={historicalSeq}
          >
            Viewing version {historicalSeq} of this disk, read-only.{' '}
            <Link
              href={`/disks/${id}/files${fromQuery(from)}`}
              className="font-semibold underline underline-offset-2"
            >
              Return to the current version
            </Link>
          </div>
        )}
        {volume === null ? (
          <div className="glass-card p-5 text-[13px]" style={{ color: 'var(--amber-text)' }}
               data-testid="blob-unavailable">
            The stored bytes for this disk could not be read.
          </div>
        ) : (
          <FileEditProvider diskId={id} disabled={disabled} tosecName={matchedTosecName}>
            <VolumeHeader result={volume} filename={filename} usage={usage} />
            {/*
              Shown even when there is no filesystem to browse -- a disk
              with nothing to add a file to still gets the toolbar, disabled
              with that reason, rather than the controls simply not existing.
            */}
            <FileToolbar />
            {volume.ok && <FileTree entries={volume.root} diskId={id} />}
            {/*
              Below the tree, always rendered -- even with no filesystem to
              browse, matching FileToolbar's own always-shown-but-disabled
              pattern -- so the page keeps advertising it accepts a drop
              rather than the control simply not existing (§6).
            */}
            <DropStaging
              filesystem={volume.ok ? volume.volume.filesystem : 'OFS'}
              intl={volume.ok ? volume.volume.intl : false}
              existingNamesByDir={volume.ok ? existingNamesByDir(volume.root) : {}}
              freeBlocks={usage?.freeBlocks ?? 0}
              entries={volume.ok ? volume.root : []}
            />
          </FileEditProvider>
        )}
        {/*
          Rendered regardless of whether today's bytes could be read above --
          a disk whose CURRENT blob is unavailable is exactly a disk someone
          might want to restore an earlier, readable version onto, so the
          history is not hidden behind that same failure.
        */}
        {historyUnavailable ? (
          <div className="glass-card p-4 text-[13px]" style={{ color: 'var(--amber-text)' }}
               data-testid="history-unavailable">
            This disk&apos;s version history could not be loaded.
          </div>
        ) : (
          <HistoryPanel
            diskId={id}
            from={from}
            versions={historyVersions}
            viewingSeq={historicalSeq}
            mountedMessage={mountedMessage}
          />
        )}
      </div>
    </>
  );
}
