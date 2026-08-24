import { requireOrg } from '@/lib/session';
import { listGames } from '@/lib/queries';
import { PageHeader } from '@/components/shell/page-header';
import { GameGrid } from '@/components/library/game-grid';

export default async function LibraryPage() {
  const { orgId } = await requireOrg();
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
      />
      <GameGrid games={games} />
    </>
  );
}
