// The phone and tablet tab bar's rules (C7 spec §2.3, Rulings 4, 8): pure and client-safe.

/** The routes the bar's More tab stands for. More is current on any of them. */
export const MORE_ROUTES = ['/help', '/settings', '/admin'] as const;

const under = (pathname: string, route: string) => pathname === route || pathname.startsWith(`${route}/`);

/** Whether the More tab is the current one. The menu items name the page, so the reading is in words too. */
export function isMoreCurrent(pathname: string): boolean {
  return MORE_ROUTES.some((r) => under(pathname, r));
}

/**
 * Whether a More menu item is the current page. An item with a hash (About this server) is never current: a pathname
 * cannot see a hash, and Settings already names /settings (Plan ruling, C7 Task 1).
 */
export function isMoreItemCurrent(pathname: string, href: string): boolean {
  return !href.includes('#') && under(pathname, href);
}

export type MoreItem = { id: 'more-help' | 'more-settings' | 'more-about' | 'more-admin'; href: string; label: string };

/** The More menu's links, in the spec's order. Admin is included only when the server decided so (`showAdmin`). */
export function moreItems(showAdmin: boolean): MoreItem[] {
  return [
    { id: 'more-help', href: '/help', label: 'Help' },
    { id: 'more-settings', href: '/settings', label: 'Settings' },
    { id: 'more-about', href: '/settings#about', label: 'About this server' },
    ...(showAdmin ? [{ id: 'more-admin' as const, href: '/admin', label: 'Admin' }] : []),
  ];
}
