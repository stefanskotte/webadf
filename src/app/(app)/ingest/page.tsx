import { requireOrg } from '@/lib/session';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';

export default async function IngestPage() {
  await requireOrg();
  return (
    <>
      <PageHeader
        eyebrow="Add disks"
        title="Ingest"
        subtitle="hash first, upload only what is missing"
      />
      <Dropzone />
    </>
  );
}
