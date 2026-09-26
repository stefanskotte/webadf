import { requireOrg } from '@/lib/session';
import { listGames, countAllGames } from '@/lib/queries';
import { listCollections, countUncategorized, collectionMosaics } from '@/lib/collections';
import { countReviewQueue } from '@/lib/demozoo/queries';
import { resolveLibraryView } from '@/lib/library-view';
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

export default async function LibraryPage(props: PageProps<'/library'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  const viewMode = sp.view === 'table' ? 'table' : 'grid';

  const collections = await listCollections(orgId);

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

  const games = await listGames(orgId, view.kind === 'collection'
    ? { collectionId: view.id }
    : view.kind === 'uncategorized'
      ? { uncategorized: true }
      : {});
  const diskTotal = games.reduce((n, g) => n + g.diskCount, 0);

  // The inbox emptying is the ordinary end state of a tidy library, not an
  // error -- fall through to the collections rather than to a blank page.
  //
  // `collections.length > 0` is load-bearing: with no collections either, the
  // library is simply EMPTY, and the grid already has a proper empty state
  // for that ("No disks yet", with a link to Ingest). A second empty state
  // here would be a worse copy of it that only appears on brand-new accounts
  // -- which is exactly what it did on its first e2e run.
  const showOverview = view.kind === 'uncategorized' && games.length === 0 && collections.length > 0;
  const [uncategorizedCount, libraryTotals, reviewQueueCount, mosaics, readers] = await Promise.all([
    countUncategorized(orgId),
    showOverview ? countAllGames(orgId) : Promise.resolve(null),
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
  ]);

  // Only a multi-disk card asks "which disk?", and only an org with a reader
  // draws the button at all -- so the disk list is loaded for exactly those.
  let fob: FobContext = null;
  if (readers.length > 0 && viewMode === 'grid' && !showOverview) {
    const multi = games.filter((g) => g.diskCount > 1).map((g) => g.id);
    const disksByGame: Record<string, FobDisk[]> = {};
    for (const d of await listDisksForNfc(orgId, multi)) {
      (disksByGame[d.gameId] ??= []).push({ id: d.id, diskNo: d.diskNo });
    }
    fob = { devices: readers, disksByGame };
  }

  return (
    <>
      {/* Regression net for the org-bootstrap flow (e2e/auth.spec.ts): captured
          before sign-out and asserted identical after sign-in. Not part of the
          design — kept invisible on screen but present in the DOM. */}
      <span data-testid="active-org" className="sr-only">{orgId}</span>
      <PageHeader
        eyebrow="Amiga collection"
        title="Library"
        subtitle={showOverview
          ? `${(libraryTotals?.titles ?? 0).toLocaleString()} titles · ${(libraryTotals?.disks ?? 0).toLocaleString()} disks`
          : `${games.length.toLocaleString()} titles · ${diskTotal.toLocaleString()} disks`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DemozooBadge count={reviewQueueCount} />
            <CreateAdf />
            <ViewToggle view={viewMode} />
          </div>
        }
      />
      <CollectionsProvider
        collections={collections}
        gameIds={games.map((g) => g.id)}
        filteredCollectionId={filteredCollectionId}
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
                ? <GameTable games={games} collectionId={filteredCollectionId} />
                : <GameGrid games={games} fob={fob} />}
          </div>
        </div>
      </CollectionsProvider>
    </>
  );
}
