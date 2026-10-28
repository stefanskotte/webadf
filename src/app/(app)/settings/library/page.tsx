import { requireOrg } from '@/lib/session';
import { SharingSettings } from '@/components/prefs/sharing-settings';
import { listShares } from '@/lib/share/store';
import { toShareView } from '@/lib/share/view';
import { listCollections } from '@/lib/collections';

export const metadata = { title: 'Library settings' };

/**
 * Settings › Library (reorganisation 2026-10-28): what belongs to the organization's library rather than to one
 * person. Today that is Sharing (library sharing spec §3.4), at the page's full width for its table.
 */
export default async function LibrarySettingsPage() {
  const { orgId } = await requireOrg();
  const [shares, collections] = await Promise.all([listShares(orgId), listCollections(orgId)]);
  return (
    <div className="flex max-w-[1188px] flex-col gap-5 px-4 pb-10 pt-6 sm:px-7">
      <SharingSettings initialShares={shares.map(toShareView)}
                       collections={collections.map((c) => ({ id: c.id, name: c.name }))} />
    </div>
  );
}
