import { headers } from 'next/headers';
import { requireOrg } from '@/lib/session';
import { auth } from '@/lib/auth';
import { getUserPrefs } from '@/lib/user-prefs';
import { PageHeader } from '@/components/shell/page-header';
import { PreferencesForm } from '@/components/prefs/preferences-form';
import { FirmwarePasswordSetting } from '@/components/prefs/firmware-password-setting';
import { AccountSecurity } from '@/components/prefs/account-security';
import { DeleteAccount } from '@/components/prefs/delete-account';

/**
 * The person's own settings, in the approved board's order (A2): Preferences (start page, sort orders), Sign-in &
 * password, Firmware updates (skip the password prompt), Delete account. All of it belongs to the signed-in user --
 * not the org, not a board -- and follows them to any browser.
 */
export default async function SettingsPage() {
  const { userId, email } = await requireOrg();
  const [prefs, sessions] = await Promise.all([
    getUserPrefs(userId),
    auth.api.listSessions({ headers: await headers() }),
  ]);
  return (
    <>
      <PageHeader eyebrow="Your account" title="Settings" help="preferences" />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        <PreferencesForm prefs={prefs} />
        <AccountSecurity email={email} sessionCount={sessions.length} />
        <FirmwarePasswordSetting skipPassword={prefs.firmware.skipPassword} />
        <DeleteAccount />
      </div>
    </>
  );
}
