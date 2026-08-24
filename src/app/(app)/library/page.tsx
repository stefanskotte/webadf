import { requireOrg } from '@/lib/session';
import { listGames } from '@/lib/queries';
import { PageHeader } from '@/components/shell/page-header';
import { GameGrid } from '@/components/library/game-grid';
import { GameTable } from '@/components/library/game-table';
import { ViewToggle } from '@/components/library/view-toggle';

export default async function LibraryPage(props: PageProps<'/library'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  const view = sp.view === 'table' ? 'table' : 'grid';

  const games = await listGames(orgId);
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
        actions={<ViewToggle view={view} />}
      />
      {view === 'table' ? <GameTable games={games} /> : <GameGrid games={games} />}
    </>
  );
}
