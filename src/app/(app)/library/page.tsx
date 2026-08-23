import { requireOrg } from '@/lib/session';
import { SignOutButton } from '@/components/sign-out-button';

export default async function LibraryPage() {
  const { orgId } = await requireOrg();
  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold tracking-tight">Library</h1>
      <p className="text-sm text-neutral-500">org {orgId}</p>
      <SignOutButton />
    </main>
  );
}
