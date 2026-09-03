import { requireOrg } from '@/lib/session';
import { listGames } from '@/lib/queries';
import { listCollections } from '@/lib/collections';
import { PageHeader } from '@/components/shell/page-header';
import { GameGrid } from '@/components/library/game-grid';
import { GameTable } from '@/components/library/game-table';
import { ViewToggle } from '@/components/library/view-toggle';
import { CreateAdf } from '@/components/library/create-adf';
import { CollectionsProvider } from '@/components/collections/collection-provider';
import { CollectionRail } from '@/components/collections/collection-rail';

export default async function LibraryPage(props: PageProps<'/library'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  const view = sp.view === 'table' ? 'table' : 'grid';

  const collections = await listCollections(orgId);

  // sp.collection is untrusted input straight off the query string. It is
  // NEVER handed to listGames directly: collection_games carries no org_id
  // of its own (D-4-5), so listGames' filtered join trusts its caller
  // entirely to have already proven the id belongs to this org. Resolving
  // it against listCollections(orgId) -- this org's OWN collections -- is
  // that proof. An id absent from that list (unknown, or another tenant's)
  // falls back to unfiltered rather than ever reaching listGames, and never
  // a 404: a stale link should quietly show the whole library, not break it.
  const requestedCollectionId = typeof sp.collection === 'string' ? sp.collection : undefined;
  const filteredCollectionId = requestedCollectionId && collections.some((c) => c.id === requestedCollectionId)
    ? requestedCollectionId
    : null;

  const games = await listGames(orgId, filteredCollectionId ? { collectionId: filteredCollectionId } : {});
  const diskTotal = games.reduce((n, g) => n + g.diskCount, 0);

  return (
    <>
      {/* Regression net for the org-bootstrap flow (e2e/auth.spec.ts): captured
          before sign-out and asserted identical after sign-in. Not part of the
          design — kept invisible on screen but present in the DOM. */}
      <span data-testid="active-org" className="sr-only">{orgId}</span>
      <PageHeader
        eyebrow="Amiga collection"
        title="Library"
        subtitle={`${games.length.toLocaleString()} titles · ${diskTotal.toLocaleString()} disks`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <CreateAdf />
            <ViewToggle view={view} />
          </div>
        }
      />
      <CollectionsProvider
        collections={collections}
        gameIds={games.map((g) => g.id)}
        filteredCollectionId={filteredCollectionId}
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
            {view === 'table' ? <GameTable games={games} /> : <GameGrid games={games} />}
          </div>
        </div>
      </CollectionsProvider>
    </>
  );
}
