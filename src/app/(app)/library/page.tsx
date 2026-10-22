import { nowMs } from '@/lib/clock';
import { requireOrg } from '@/lib/session';
import { listGames, countGames, countAllGames, listDevices } from '@/lib/queries';
import { holdsByGame } from '@/lib/drive-holds';
import { df1BoardOf } from '@/lib/df1-pick';
import type { DriveContext, DriveDisk } from '@/components/library/card-mount-button';
import { listCollections, countUncategorized, collectionMosaics, listCollectionGameIds } from '@/lib/collections';
import { countReviewQueue } from '@/lib/demozoo/queries';
import { resolveLibraryView, resolveViewMode } from '@/lib/library-view';
import { CategoryOverview } from '@/components/collections/category-overview';
import { PageHeader } from '@/components/shell/page-header';
import { GameGrid } from '@/components/library/game-grid';
import { GameTable } from '@/components/library/game-table';
import { ViewToggle } from '@/components/library/view-toggle';
import { CreateAdf } from '@/components/library/create-adf';
import { DemozooBadge } from '@/components/library/demozoo-badge';
import { CollectionsProvider } from '@/components/collections/collection-provider';
import { CollectionRail } from '@/components/collections/collection-rail';
import { listNfcReaders, listDisksForNfc } from '@/lib/nfc/store';
import type { FobContext, FobDisk } from '@/components/nfc/fob-button';
import { getUserPrefs } from '@/lib/user-prefs';
import { LibrarySortPicker } from '@/components/library/library-sort-picker';
import { LibraryPager } from '@/components/library/library-pager';
import { resolvePage, librarySubtitle } from '@/lib/library-paging';

export default async function LibraryPage(props: PageProps<'/library'>) {
  const { orgId, userId } = await requireOrg();
  const sp = await props.searchParams;

  const [collections, prefs] = await Promise.all([listCollections(orgId), getUserPrefs(userId)]);
  // `?view=` when the address names one, else the person's own default.
  const viewMode = resolveViewMode(sp.view, prefs.library.view);

  /*
   * sp.collection is untrusted input straight off the query string, and it is
   * NEVER handed to listGames directly: collection_games carries no org_id of
   * its own (D-4-5), so the query layer trusts its caller entirely to have
   * proven the id belongs to this org. resolveLibraryView does that proof
   * against this org's OWN collections; anything unknown falls back to the
   * whole library rather than 404ing, because a stale link should be harmless.
   *
   * An ABSENT parameter now means "Uncategorized", not "everything" -- see
   * src/lib/library-view.ts for why the landing is the inbox.
   */
  const view = resolveLibraryView(sp.collection, collections.map((c) => c.id));
  const filteredCollectionId = view.kind === 'collection' ? view.id : null;

  // The person's remembered sort (user prefs) orders the whole library and the
  // inbox. A collection keeps its own hand-made order: that order is shared
  // with everyone in the org and is what dragging a card reorders, so a
  // per-person sort laid over it would make the drag look broken.
  const sort = prefs.library.sort;
  const scope = view.kind === 'collection'
    ? { collectionId: view.id }
    : view.kind === 'uncategorized'
      ? { uncategorized: true, sort }
      : { sort };
  // Library paging (operator 2026-10-22): the whole view is counted, one page of it is loaded -- and with it only that
  // page's disks, boards and NFC data below. `?page=` past the end shows the last page.
  const totals = await countGames(orgId, scope);
  const paging = resolvePage(sp.page, totals.titles, prefs.library.pageSize);
  const [games, collectionOrder] = await Promise.all([
    listGames(orgId, { ...scope, limit: paging.limit, offset: paging.offset }),
    // Dragging inside one page of a collection reorders the whole collection: the drag needs its full order.
    view.kind === 'collection' && paging.pages > 1 ? listCollectionGameIds(orgId, view.id) : Promise.resolve(undefined),
  ]);

  // The inbox emptying is the ordinary end state of a tidy library, not an
  // error -- fall through to the collections rather than to a blank page.
  //
  // `collections.length > 0` is load-bearing: with no collections either, the
  // library is simply EMPTY, and the grid already has a proper empty state
  // for that ("No disks yet", with a link to Ingest). A second empty state
  // here would be a worse copy of it that only appears on brand-new accounts
  // -- which is exactly what it did on its first e2e run.
  //
  // That fall-through is the GRID's: the table lists the collections as
  // folder rows at its root whatever the inbox holds, so it has no overview.
  const emptyInbox = view.kind === 'uncategorized' && totals.titles === 0 && collections.length > 0;
  const showOverview = emptyInbox && viewMode === 'grid';
  // The grid's cards and the table's rows carry the mount control and the
  // NFC button, both of which need the boards and the disks of the titles on
  // the page. Loaded with everything else, in parallel; the disk list is one
  // query for both.
  const cards = !showOverview;
  const [uncategorizedCount, libraryTotals, reviewQueueCount, mosaics, readers, boards, pageDisks] = await Promise.all([
    countUncategorized(orgId),
    emptyInbox ? countAllGames(orgId) : Promise.resolve(null),
    // R15: the badge is a count, not the review queue's full item list --
    // listReviewQueue also loads productions and screenshots, which this
    // page must not pay for on every load. Only /library/demozoo does that.
    countReviewQueue(orgId),
    // Only for the overview, and only then: every other view of this page
    // renders the game cards themselves, which carry their own covers.
    showOverview
      ? collectionMosaics(orgId, collections.map((c) => c.id))
      : Promise.resolve(null),
    // The fob button's visibility, decided here with the page rather than by
    // a client fetch: every card would otherwise flash it in or out.
    listNfcReaders(orgId),
    cards ? listDevices(orgId) : Promise.resolve([]),
    cards ? listDisksForNfc(orgId, games.map((g) => g.id)) : Promise.resolve([]),
  ]);

  // "Which disk?" on a set: the mount picker and the fob picker both use it.
  const disksByGame: Record<string, DriveDisk[]> = {};
  for (const d of pageDisks) (disksByGame[d.gameId] ??= []).push({ id: d.id, diskNo: d.diskNo, imageFormat: d.imageFormat, sizeBytes: d.sizeBytes });

  // The card mount control and its ring (card-mount-button.tsx): every board
  // and what each holds, decided here with the page so a card's ring is right
  // on first paint. Null without a board: no control, no ring.
  let drives: DriveContext = null;
  if (cards && boards.length > 0) {
    // One clock for the render, as devices/page.tsx does.
    const now = nowMs();
    drives = {
      // DF1's rules need the board's setting, firmware and disks (spec 2026-10-14 §3.1) -- those fields only.
      devices: boards.map((b) => ({ id: b.id, name: b.name, df1: b.secondDrive === 'df1' ? df1BoardOf(b) : null })),
      holds: holdsByGame(boards, pageDisks, now),
      disksByGame,
    };
  }

  // Only an org with a reader draws the fob button at all.
  const fob: FobContext = cards && readers.length > 0
    ? { devices: readers, disksByGame: disksByGame as Record<string, FobDisk[]> }
    : null;

  return (
    <>
      {/* Regression net for the org-bootstrap flow (e2e/auth.spec.ts): captured
          before sign-out and asserted identical after sign-in. Not part of the
          design — kept invisible on screen but present in the DOM. */}
      <span data-testid="active-org" className="sr-only">{orgId}</span>
      <PageHeader
        eyebrow="Amiga collection"
        title="Library"
        help="library"
        subtitle={emptyInbox
          ? `${(libraryTotals?.titles ?? 0).toLocaleString()} titles · ${(libraryTotals?.disks ?? 0).toLocaleString()} disks`
          : librarySubtitle(totals, view.kind)}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DemozooBadge count={reviewQueueCount} />
            <CreateAdf />
            {view.kind !== 'collection' && !emptyInbox && <LibrarySortPicker sort={sort} />}
            <ViewToggle mode={viewMode} view={view} page={paging.page} />
          </div>
        }
      />
      <CollectionsProvider
        collections={collections}
        gameIds={games.map((g) => g.id)}
        filteredCollectionId={filteredCollectionId}
        collectionOrder={collectionOrder}
        view={view}
        uncategorizedCount={uncategorizedCount}
      >
        {/* Two columns from `md` up, which is what it has always been; below
            that the rail stacks above the grid, because a 224px rail beside a
            390px screen leaves the grid about 66px of it. `items-start` is
            deliberately NOT the base rule: in a column it governs the
            horizontal axis, so it would shrink the rail and the grid to their
            content width instead of letting them fill the screen. */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <CollectionRail />
          <div className="min-w-0 flex-1">
            {showOverview
              ? (
                <CategoryOverview
                  collections={collections}
                  totalTitles={libraryTotals?.titles ?? 0}
                  totalDisks={libraryTotals?.disks ?? 0}
                  mosaics={mosaics ?? undefined}
                />
              )
              : viewMode === 'table'
                ? (
                  <GameTable games={games} collectionId={filteredCollectionId} fob={fob} drives={drives}
                             folderDisks={Object.fromEntries(collections.map((c) => [c.id, c.diskCount]))}
                             firstPage={paging.page === 1} />
                  )
                : <GameGrid games={games} fob={fob} drives={drives} />}
            {!showOverview && (
              <LibraryPager page={paging.page} pages={paging.pages} pageSize={prefs.library.pageSize} total={totals.titles} />
            )}
          </div>
        </div>
      </CollectionsProvider>
    </>
  );
}
