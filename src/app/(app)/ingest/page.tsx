import { requireOrg } from '@/lib/session';
import { getDb } from '@/db';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';
import { SendPanel } from '@/components/send/send-panel';
import { HelpTip } from '@/components/help/help-tip';
import { listSendTargets } from '@/lib/send-targets';

export default async function IngestPage(props: PageProps<'/ingest'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  // ?board= comes from the card's line and the disk pages' "See queue"; an id that is not a target is ignored.
  const board = typeof sp.board === 'string' ? sp.board : null;
  const now = Date.now();
  const targets = await listSendTargets(getDb(), orgId, now);
  const h2 = 'text-[12px] font-bold uppercase tracking-wide';
  return (
    <>
      {/* The nav label and this heading both say "Upload"; the ROUTE stays
          /ingest. The route, the /api/ingest/* namespace, src/proxy.ts's
          matcher and the CLI all key on that word (HANDOFF backlog). */}
      <PageHeader eyebrow="Add disks" title="Upload" subtitle="hash first, upload only what is missing" />
      {/* Two columns from lg (operator, 2026-10-16), stacked below: the library upload unchanged on the left. */}
      <div className="grid items-start gap-y-6 pb-10 lg:grid-cols-2">
        <section aria-labelledby="add-heading" className="flex min-w-0 flex-col gap-3">
          <h2 id="add-heading" className={`mx-4 sm:mx-7 lg:mr-3.5 ${h2}`} style={{ color: 'var(--muted)' }}>Add to library</h2>
          <Dropzone />
        </section>
        <section aria-labelledby="send-heading" className="flex min-w-0 flex-col gap-3">
          <h2 id="send-heading" className={`mx-4 flex items-center gap-1 sm:mx-7 lg:ml-3.5 ${h2}`} style={{ color: 'var(--muted)' }}>
            Send to Amiga <HelpTip topic="send" />
          </h2>
          <SendPanel targets={targets} initialBoard={board} serverNow={now} />
        </section>
      </div>
    </>
  );
}
