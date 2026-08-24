import { requireOrg } from '@/lib/session';
import { PageHeader } from '@/components/shell/page-header';

export default async function LibraryPage() {
  const { orgId } = await requireOrg();
  return (
    <>
      <PageHeader eyebrow="Amiga collection" title="Library" />
      <main className="p-8">
        <p className="text-sm text-neutral-500">
          org <span data-testid="active-org">{orgId}</span>
        </p>
      </main>
    </>
  );
}
