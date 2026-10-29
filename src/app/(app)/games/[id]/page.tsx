import { nowMs } from '@/lib/clock';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/lib/session';
import { getGameDetail, listDevices } from '@/lib/queries';
import { listCollections } from '@/lib/collections';
import { resolveFrom, libraryTrail, parseTrailView } from '@/lib/trail';
import { mountChoices } from '@/lib/mount-choice';
import { copiedFromText } from '@/lib/remote/copy';
import { Breadcrumb } from '@/components/shell/breadcrumb';
import { DiskRow } from '@/components/games/disk-row';
import { DiskSetSection } from '@/components/games/disk-set-section';
import { GameFacts } from '@/components/games/game-facts';
import { EditDetails, EDIT_SLOT_ID } from '@/components/games/edit-details';
import { CoverControl } from '@/components/games/cover-control';
import { DemozooPanel, DemozooIdentify } from '@/components/games/demozoo-panel';
import { TitleHero } from '@/components/games/title-hero';
import { holdsByGame } from '@/lib/drive-holds';
import { isHdAdf } from '@/lib/disk-format';
import { listNfcReaders } from '@/lib/nfc/store';
import { getDb } from '@/db';
import { listSendTargets } from '@/lib/send-targets';
import { SendBoardPicker } from '@/components/send/send-button';

export default async function GamePage(props: PageProps<'/games/[id]'>) {
  const { orgId } = await requireOrg();
  const { id } = await props.params;
  // Untrusted, straight off the query string, and resolved against THIS org's
  // own collections before its name is rendered -- collection_games carries no
  // org_id (D-4-5), so an unchecked id would put another tenant's collection
  // name on the page.
  const sp = await props.searchParams;
  const from = typeof sp.from === 'string' ? sp.from : undefined;
  // The library's grid or table, carried back to it by the breadcrumb (library table final review M1).
  const view = parseTrailView(sp.view);

  const [game, devices, collections, readers, sendTargets] = await Promise.all([
    getGameDetail(orgId, id), listDevices(orgId), listCollections(orgId),
    // The fob button's boards: empty means the button is not drawn.
    listNfcReaders(orgId),
    // Send .adf to Amiga: the boards that can take files; none = no button.
    listSendTargets(getDb(), orgId),
  ]);
  // Null covers "does not exist" and "belongs to another organization"
  // indistinguishably, so an id from another tenant reveals nothing.
  if (!game) notFound();

  const now = nowMs();
  const send = sendTargets.length > 0 ? { targets: sendTargets, now } : null;

  // The one precedence rule (cover-image.ts effectiveCoverUrl): the org's own choice, else OpenRetro's front cover,
  // else its title screen.
  const cover = game.coverOverrideUrl ? { url: game.coverOverrideUrl } : (game.front ?? game.title_);

  // The drive pill: a disk of this title CONFIRMED in a drive (the library card's rule, drive-holds.ts, for DF0; the
  // mount choices' df1Held for DF1). A request still in flight is not a hold yet, so it draws nothing.
  const holdDisk = holdsByGame(
    devices, game.disks.map((d) => ({ id: d.id, gameId: game.id, diskNo: d.diskNo, sha256: d.sha256 })), now,
  )[game.id]?.find((h) => h.state === 'mounted');
  const df0Disk = holdDisk ? game.disks.find((d) => d.id === holdDisk.diskId) : undefined;
  const df1Disk = game.disks.find((d) => mountChoices(devices, d, now).some((c) => c.df1Held));
  const mountedText = df0Disk ? `DF0 · ${df0Disk.imageFormat.toUpperCase()}`
    : df1Disk ? `DF1 · ${df1Disk.imageFormat.toUpperCase()}` : null;

  const fromName = resolveFrom(from, collections)?.name;

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-7">
      {/* Library, plus the collection you came from when a ?from= names one of this org's own. It cannot be
          derived here: a game is in many collections and collection_games is many-to-many, so an unfiltered
          "Library" is the honest answer when nothing was carried.

          The KIND is still deliberately not a crumb: it is null for the ~54% of the archive TOSEC does not
          recognise and it is not somewhere you can navigate to. It is a pill in the hero (getGameDetail.kind). */}
      <Breadcrumb crumbs={libraryTrail(resolveFrom(from, collections), view)} />
      <TitleHero
        id={game.id} title={game.title} year={game.year} publisher={game.publisher} kind={game.kind}
        diskCount={game.disks.length} cover={cover} formats={game.disks.map((d) => d.imageFormat)}
        hasHd={game.disks.some(isHdAdf)} authored={game.authored} mounted={mountedText}
        setLabel={fromName ?? game.kind ?? 'Unidentified'}
        copiedFrom={copiedFromText(game.copiedFrom)}
        // Above GameFacts, and outside it: GameFacts renders nothing at all for a title nothing has enriched, which
        // is exactly the title a person most wants to fill in by hand.
        editSlot={<EditDetails game={game} />}
        // Same reason as EditDetails: reachable on titles nothing has enriched.
        coverSlot={<CoverControl gameId={game.id} hasOverride={game.coverOverrideUrl !== null} />}
        identifySlot={<DemozooIdentify game={game} />}
      />
      {/* The open edit panel lands here (EditDetails portals into it); empty, it takes no gap. */}
      <div id={EDIT_SLOT_ID} className="empty:hidden" />
      <DemozooPanel game={game} />
      <GameFacts game={game} />
      <section aria-label="Disks" className="flex flex-col gap-3">
        {game.disks.length >= 2 ? (
          // A disk set: the same rows, under a heading line with the set's name, Add disks… and Reorder, each row
          // gaining a ⋯ menu. A client component, so the mount choices are computed here and handed over as data.
          <DiskSetSection
            gameId={game.id} title={game.title} from={from} view={view} fobDevices={readers} send={send}
            kind={game.kind} authored={game.authored} sendPicker={<SendBoardPicker ctx={send} />}
            entries={game.disks.map((disk) => ({
              disk, choices: mountChoices(devices, disk, now),
            }))}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Disks</h2>
              <SendBoardPicker ctx={send} />
            </div>
            {game.disks.map((disk, i) => (
          /*
            Per disk, not once for the page: whether a device offers "Mount
            here" or "Eject" is a fact about THIS disk and that device, so one
            shared list of targets cannot express it. devices x disks is a
            handful of rows either way.
          */
          <DiskRow key={disk.id} disk={disk} gameId={game.id} from={from} view={view} fobDevices={readers} send={send}
                   // One "?" per feature per page: NFC on the first row, write
                   // protection on the first row that has the toggle (not HFE),
                   // HFE on the first HFE row.
                   helpNfc={i === 0}
                   helpProtect={disk.id === game.disks.find((d) => d.imageFormat !== 'hfe')?.id}
                   helpHfe={disk.id === game.disks.find((d) => d.imageFormat === 'hfe')?.id}
                   choices={mountChoices(devices, disk, now)}
                   // A lone disk: its ⋯ menu offers "Add to a disk set…".
                   loneGameId={game.id} kind={game.kind} authored={game.authored} />
            ))}
          </>
        )}
      </section>
    </div>
  );
}
