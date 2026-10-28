import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireOrg } from '@/lib/session';
import { auth } from '@/lib/auth';
import { getUserPrefs } from '@/lib/user-prefs';
import { SideNav, type SideNavGroup } from '@/components/shell/side-nav';
import { PreferencesForm } from '@/components/prefs/preferences-form';
import { FirmwarePasswordSetting } from '@/components/prefs/firmware-password-setting';
import { AccountSecurity } from '@/components/prefs/account-security';
import { DeleteAccount } from '@/components/prefs/delete-account';
import { LegacySettingsHash } from '@/components/prefs/settings-sections';
import { expiredSignInHref, isSessionNotFresh } from '@/lib/sign-in-return';

export const metadata = { title: 'Settings' };

// The Account tab's section list (C5 spec §2.1, Ruling 2): in-page anchors. Sharing and About this server have their
// own tabs since the reorganisation (2026-10-28).
const SECTIONS: SideNavGroup[] = [{
  label: 'Your account',
  items: [
    { href: '#prefs', label: 'Preferences', focusId: 'prefs-heading' },
    { href: '#account', label: 'Sign-in & password', focusId: 'account-heading' },
    { href: '#firmware', label: 'Firmware updates', focusId: 'firmware-heading' },
    { href: '#danger', label: 'Delete account', focusId: 'danger-heading', tone: 'danger' },
  ],
}];

/**
 * Settings › Account (A2; layout C5, board InfSettings; tab since 2026-10-28): Preferences, Sign-in & password,
 * Firmware updates, Delete account. All of it belongs to the signed-in user -- not the org, not a board -- and follows
 * them to any browser. From lg a sticky section list sits beside the cards; below lg the cards stand alone.
 */
export default async function SettingsPage() {
  const { userId, email } = await requireOrg();
  const [prefs, sessions] = await Promise.all([
    getUserPrefs(userId),
    // listSessions wants a session younger than Better Auth's freshAge (a day); an older one is still signed in
    // everywhere else, so send it back through sign-in instead of failing the page.
    auth.api.listSessions({ headers: await headers() }).catch((err: unknown) => {
      if (isSessionNotFresh(err)) return null;
      throw err;
    }),
  ]);
  if (!sessions) redirect(expiredSignInHref('/settings'));
  return (
    <div className="px-4 pb-10 pt-6 sm:px-7 lg:grid lg:grid-cols-[240px_minmax(0,860px)] lg:items-start lg:gap-8">
      <LegacySettingsHash />
      <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
        <SideNav label="Account sections" testId="settings-nav" groups={SECTIONS} />
      </aside>
      <div className="flex min-w-0 flex-col gap-5">
        <PreferencesForm prefs={prefs} />
        <AccountSecurity email={email} sessionCount={sessions.length} />
        <FirmwarePasswordSetting skipPassword={prefs.firmware.skipPassword} />
        <DeleteAccount />
      </div>
    </div>
  );
}
