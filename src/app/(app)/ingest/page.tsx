import { nowMs } from '@/lib/clock';
import { requireOrg } from '@/lib/session';
import { getDb } from '@/db';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';
import { SendPanel } from '@/components/send/send-panel';
import { UploadCard } from '@/components/ingest/upload-card';
import { FromAmigaCard } from '@/components/uploads/from-amiga-card';
import { listSendTargets } from '@/lib/send-targets';

export default async function IngestPage(props: PageProps<'/ingest'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  // ?board= comes from the card's line and the disk pages' "See queue"; an id that is not a target is ignored.
  const board = typeof sp.board === 'string' ? sp.board : null;
  // ?from= comes from a device card's "N files from the Amiga" line (it filters the area to that board).
  const from = typeof sp.from === 'string' ? sp.from : null;
  const now = nowMs();
  const targets = await listSendTargets(getDb(), orgId, now);
  return (
    <>
      {/* The nav label and this heading both say "Upload"; the ROUTE stays
          /ingest. The route, the /api/ingest/* namespace, src/proxy.ts's
          matcher and the CLI all key on that word (HANDOFF backlog). */}
      <PageHeader eyebrow="Add disks" title="Upload" subtitle="hash first, upload only what is missing" />
      {/* Two matching cards from lg (operator, 2026-10-16; layout 2026-10-18), stacked below. Stretched to one
          height: each card's bottom list takes up whatever the other card's content leaves over. */}
      <div className="mx-4 grid gap-6 pb-10 sm:mx-7 lg:grid-cols-2 lg:items-stretch">
        <UploadCard id="add-heading" title="Add to library">
          <Dropzone />
        </UploadCard>
        <SendPanel targets={targets} initialBoard={board} serverNow={now} />
      </div>
      <FromAmigaCard targets={targets} initialBoard={from} />
    </>
  );
}
