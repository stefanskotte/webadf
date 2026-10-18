import { requireOrg } from '@/lib/session';
import { getUserPrefs } from '@/lib/user-prefs';
import { PageHeader } from '@/components/shell/page-header';
import { PreferencesForm } from '@/components/prefs/preferences-form';
import { FirmwarePasswordSetting } from '@/components/prefs/firmware-password-setting';

/**
 * The person's own settings: Preferences (start page, sort orders) and
 * Firmware updates (skip the password prompt), which belong to the signed-in user -- not the org, not a
 * board -- and follow them to any browser.
 */
export default async function SettingsPage() {
  const { userId } = await requireOrg();
  const prefs = await getUserPrefs(userId);
  return (
    <>
      <PageHeader eyebrow="Your account" title="Settings" help="preferences" />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        <PreferencesForm prefs={prefs} />
        <FirmwarePasswordSetting skipPassword={prefs.firmware.skipPassword} />
      </div>
    </>
  );
}
