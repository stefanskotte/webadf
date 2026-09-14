import { requireOrg } from '@/lib/session';
import { listReviewQueue } from '@/lib/demozoo/queries';
import { PageHeader } from '@/components/shell/page-header';
import { DemozooReview } from '@/components/library/demozoo-review';

/** Org-scoped review of Demozoo suggestions (operator ruling 2026-09-14). Not admin. */
export default async function DemozooReviewPage() {
  const { orgId } = await requireOrg();
  const items = await listReviewQueue(orgId);
  return (
    <>
      <PageHeader
        eyebrow={[{ label: 'Library', href: '/library' }]}
        title="Demozoo suggestions"
        subtitle="Single matches are ticked. Untick anything that looks wrong, then accept."
      />
      <DemozooReview items={items} />
    </>
  );
}
