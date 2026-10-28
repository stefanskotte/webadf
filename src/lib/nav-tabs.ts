// The phone and tablet tab bar's rules (C7 spec §2.3, Rulings 4, 8): pure and client-safe.

/**
 * The routes the bar's More tab stands for. More is current on any of them. Remote (library sharing spec §4.5) lives
 * here below lg: the bar is four cells, and the top nav carries it from lg.
 */
export const MORE_ROUTES = ['/remote', '/help', '/settings', '/admin'] as const;

const under = (pathname: string, route: string) => pathname === route || pathname.startsWith(`${route}/`);

/** Whether the More tab is the current one. The menu items name the page, so the reading is in words too. */
export function isMoreCurrent(pathname: string): boolean {
  return MORE_ROUTES.some((r) => under(pathname, r));
}

/**
 * Whether a More menu item is the current page. An item with a hash (About this server) is never current: a pathname
 * cannot see a hash, and Settings already names /settings (Plan ruling, C7 Task 1).
 */
export function isMoreItemCurrent(pathname: string, href: string, siblings: readonly string[] = []): boolean {
  if (href.includes('#') || !under(pathname, href)) return false;
  // Settings (/settings) and About this server (/settings/server) both contain /settings/server: the longer one wins.
  return !siblings.some((s) => s.length > href.length && !s.includes('#') && under(pathname, s));
}

export type MoreItem = {
  id: 'more-remote' | 'more-help' | 'more-settings' | 'more-about' | 'more-admin'; href: string; label: string;
};

/**
 * The More menu's links, in the spec's order. Remote first: "on the phone, Remote sits with Library" (library sharing
 * spec §4.5), and the bar has no fifth cell for it. Admin is included only when the server decided so (`showAdmin`).
 */
export function moreItems(showAdmin: boolean): MoreItem[] {
  return [
    { id: 'more-remote', href: '/remote', label: 'Remote' },
    { id: 'more-help', href: '/help', label: 'Help' },
    { id: 'more-settings', href: '/settings', label: 'Settings' },
    { id: 'more-about', href: '/settings/server', label: 'About this server' },
    ...(showAdmin ? [{ id: 'more-admin' as const, href: '/admin', label: 'Admin' }] : []),
  ];
}
