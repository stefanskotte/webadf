import { nowMs } from '@/lib/clock';
import { requireOrg } from '@/lib/session';
import { getDb } from '@/db';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';
import { SendPanel } from '@/components/send/send-panel';
import { UploadCard } from '@/components/ingest/upload-card';
import { StagingProvider } from '@/components/ingest/staging-provider';
import { StagingList } from '@/components/ingest/staging-list';
import { listSendTargets } from '@/lib/send-targets';

export default async function IngestPage(props: PageProps<'/ingest'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  // ?board= comes from the card's line and the disk pages' "See queue"; an id that is not a target is ignored.
  const board = typeof sp.board === 'string' ? sp.board : null;
  // ?from= comes from a device card's "N files from the Amiga" line: the list opens on From the Amiga.
  const from = typeof sp.from === 'string';
  const now = nowMs();
  const targets = await listSendTargets(getDb(), orgId, now);
  return (
    <StagingProvider>
      {/* The nav label and this heading both say "Upload"; the ROUTE stays
          /ingest. The route, the /api/ingest/* namespace, src/proxy.ts's
          matcher and the CLI all key on that word (HANDOFF backlog). */}
      <PageHeader eyebrow="Add disks" title="Upload"
                  subtitle="Disks into the library, files to and from the Amiga — all through one staging list." />
      {/* The two drop areas side by side from 640 px (spec 2026-10-23 §1), stacked below, stretched to one height;
          then the one Staging list of everything both of them (and the Amiga) set moving. */}
      <div className="mx-4 grid gap-6 pb-6 sm:mx-7 sm:grid-cols-2 sm:items-stretch">
        <UploadCard id="add-heading" title="Add disks to the library">
          <Dropzone />
        </UploadCard>
        <SendPanel targets={targets} initialBoard={board} serverNow={now} />
      </div>
      <StagingList initialFilter={from ? 'in' : 'all'} fallbackTargets={targets} />
    </StagingProvider>
  );
}
