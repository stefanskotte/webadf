import { requireOrg } from '@/lib/session';
import { AboutServer } from '@/components/prefs/about-server';

export const metadata = { title: 'Server settings' };

/** Settings › Server (reorganisation 2026-10-28): this copy of the site. Today that is About this server (C7 §10). */
export default async function ServerSettingsPage() {
  const { orgId } = await requireOrg();
  return (
    <div className="flex max-w-[916px] flex-col gap-5 px-4 pb-10 pt-6 sm:px-7">
      <AboutServer orgId={orgId} />
    </div>
  );
}
