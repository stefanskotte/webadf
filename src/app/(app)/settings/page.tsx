import { headers } from 'next/headers';
import { requireOrg } from '@/lib/session';
import { auth } from '@/lib/auth';
import { getUserPrefs } from '@/lib/user-prefs';
import { PageHeader } from '@/components/shell/page-header';
import { SideNav, type SideNavGroup } from '@/components/shell/side-nav';
import { PreferencesForm } from '@/components/prefs/preferences-form';
import { FirmwarePasswordSetting } from '@/components/prefs/firmware-password-setting';
import { AccountSecurity } from '@/components/prefs/account-security';
import { DeleteAccount } from '@/components/prefs/delete-account';
import { AboutServer } from '@/components/prefs/about-server';

export const metadata = { title: 'Settings' };

// The board's section list (C5 spec §2.1, Ruling 2; C7 §10.2): in-page anchors, About this server among them.
const SECTIONS: SideNavGroup[] = [{
  label: 'Your account',
  items: [
    { href: '#prefs', label: 'Preferences', focusId: 'prefs-heading' },
    { href: '#account', label: 'Sign-in & password', focusId: 'account-heading' },
    { href: '#firmware', label: 'Firmware updates', focusId: 'firmware-heading' },
    { href: '#about', label: 'About this server', focusId: 'about-heading' },
    { href: '#danger', label: 'Delete account', focusId: 'danger-heading', tone: 'danger' },
  ],
}];

/**
 * The person's own settings (A2; layout C5, board InfSettings): Preferences, Sign-in & password, Firmware updates,
 * About this server, Delete account (C7 spec §10.2). All of it belongs to the signed-in user -- not the org, not a board -- and follows them to any
 * browser. From lg a sticky section list sits beside the cards; below lg the cards stand alone.
 */
export default async function SettingsPage() {
  const { userId, email, orgId } = await requireOrg();
  const [prefs, sessions] = await Promise.all([
    getUserPrefs(userId),
    auth.api.listSessions({ headers: await headers() }),
  ]);
  return (
    <div className="px-4 pb-10 pt-6 sm:px-7 lg:grid lg:grid-cols-[240px_minmax(0,860px)] lg:items-start lg:gap-8">
      <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
        <SideNav label="Settings sections" testId="settings-nav" groups={SECTIONS} />
      </aside>
      <div className="flex min-w-0 flex-col gap-5">
        <PageHeader flush size="lg" eyebrow="Your account" title="Settings" help="preferences" />
        <PreferencesForm prefs={prefs} />
        <AccountSecurity email={email} sessionCount={sessions.length} />
        <FirmwarePasswordSetting skipPassword={prefs.firmware.skipPassword} />
        <AboutServer orgId={orgId} />
        <DeleteAccount />
      </div>
    </div>
  );
}
