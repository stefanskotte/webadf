import { requireOrg } from '@/lib/session';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';

export default async function IngestPage() {
  await requireOrg();
  return (
    <>
      {/* The nav label and this heading both say "Upload"; the ROUTE stays
          /ingest. The route, the /api/ingest/* namespace, src/proxy.ts's
          matcher and the CLI all key on that word, so renaming it is a
          separate and much wider decision (recorded in HANDOFF's backlog).
          Renaming the nav item and leaving this heading as "Ingest" would
          have been half a rename -- the operator clicks Upload and lands on
          a page titled Ingest. */}
      <PageHeader
        eyebrow="Add disks"
        title="Upload"
        subtitle="hash first, upload only what is missing"
      />
      <Dropzone />
    </>
  );
}
