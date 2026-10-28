import { requireOrg } from '@/lib/session';
import { PageHeader } from '@/components/shell/page-header';
import { AddRemoteForm } from '@/components/remote/add-remote-form';

export const metadata = { title: 'Add a shared library' };

/** Remote › Add (library sharing spec §4.2). The owner's landing page sends people here with `#link=<link>`. */
export default async function AddRemotePage() {
  await requireOrg();
  return (
    <>
      <PageHeader size="lg" eyebrow={[{ label: 'Remote', href: '/remote' }]} title="Add a shared library" />
      <div className="px-4 pb-10 sm:px-7">
        <AddRemoteForm />
      </div>
    </>
  );
}
