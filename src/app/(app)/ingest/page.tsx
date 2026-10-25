import { nowMs } from '@/lib/clock';
import { requireOrg } from '@/lib/session';
import { getDb } from '@/db';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';
import { SendPanel } from '@/components/send/send-panel';
import { StagingProvider } from '@/components/ingest/staging-provider';
import { StagingList } from '@/components/ingest/staging-list';
import { listSendTargets } from '@/lib/send-targets';

export default async function IngestPage(props: PageProps<'/ingest'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  // ?board= comes from the card's line and the disk pages' "See queue"; an id that is not a target is ignored.
  const board = typeof sp.board === 'string' ? sp.board : null;
  // ?from= comes from a device card's "N files from the Amiga" line: the list opens on From the Amiga. Without it,
  // ?board= (the queue) opens it on To the Amiga.
  const from = typeof sp.from === 'string';
  const initialFilter = from ? 'in' : board ? 'out' : 'all';
  const now = nowMs();
  const targets = await listSendTargets(getDb(), orgId, now);
  return (
    <StagingProvider>
      {/* The nav label and this heading both say "Upload"; the ROUTE stays
          /ingest. The route, the /api/ingest/* namespace, src/proxy.ts's
          matcher and the CLI all key on that word (HANDOFF backlog). */}
      <PageHeader size="lg" eyebrow="Move files" title="Upload"
                  subtitle="Disks into the library, files to and from the Amiga — all through one staging list." />
      <div className="flex flex-col gap-6 px-4 pb-10 sm:px-7">
        {/* The two drop cards side by side from 1024 px (spec 2026-10-25 §1), stacked below; then the one Staging
            list of everything both of them (and the Amiga) set moving. */}
        <div className="grid gap-5 lg:grid-cols-2 lg:items-stretch">
          <Dropzone />
          <SendPanel targets={targets} initialBoard={board} serverNow={now} />
        </div>
        <StagingList initialFilter={initialFilter} fallbackTargets={targets} />
      </div>
    </StagingProvider>
  );
}
