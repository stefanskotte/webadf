'use client';
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Link } from '@/components/shell/link';
import { PageHeader } from '@/components/shell/page-header';
import type { HelpTopicId } from '@/lib/help/topics';

/**
 * Settings' tabs (reorganisation 2026-10-28): Account is the signed-in person's (follows them to any browser),
 * Library is the organization's (Sharing), Server is this copy of the site (About). Separate pages so each group can
 * grow. Exact match on href, as AdminSections: '/settings' is a prefix of the other two.
 */
export const SETTINGS_SECTIONS = [
  { href: '/settings', label: 'Account', help: 'preferences' },
  { href: '/settings/library', label: 'Library', help: 'sharing' },
  // About this server's card carries its own "?" (C7), so the heading has none here.
  { href: '/settings/server', label: 'Server', help: undefined },
] as const satisfies readonly { href: string; label: string; help: HelpTopicId | undefined }[];

export function settingsHelpTopic(pathname: string): HelpTopicId | undefined {
  return (SETTINGS_SECTIONS.find((s) => s.href === pathname) ?? SETTINGS_SECTIONS[0]).help;
}

/** Settings was one page until 2026-10-28; its #sharing and #about anchors now live on their own tabs. */
export function legacySettingsHash(hash: string): string | null {
  if (hash === '#sharing') return '/settings/library';
  if (hash === '#about') return '/settings/server';
  return null;
}

export function SettingsSections() {
  const pathname = usePathname();
  return (
    <div className="max-w-full overflow-x-auto">
      <nav aria-label="Settings sections" data-testid="settings-sections" className="seg w-max">
        {SETTINGS_SECTIONS.map((item) => (
          <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}
                className="seg-item whitespace-nowrap">
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** The heading and the tabs over every Settings page; the "?" follows the tab. */
export function SettingsHead() {
  const pathname = usePathname();
  return (
    <div className="flex flex-col items-start gap-4 px-4 pt-6 sm:px-7">
      <PageHeader flush size="lg" title="Settings" help={settingsHelpTopic(pathname)} />
      <SettingsSections />
    </div>
  );
}

/** On Account: a bookmark to the old one-page /settings#sharing or #about goes on to its tab. */
export function LegacySettingsHash() {
  const router = useRouter();
  useEffect(() => {
    const to = legacySettingsHash(window.location.hash);
    if (to) router.replace(to);
  }, [router]);
  return null;
}
