'use client';
import { Link } from '@/components/shell/link';
import { usePathname } from 'next/navigation';

/**
 * The in-page Admin sections tabs (C6 spec §1.2, Ruling 2): the header holds the app's Main nav now, so the five
 * sections move under each page's heading. Exact match on href, not startsWith: '/admin' is a prefix of every other
 * entry, so startsWith would light up Overview everywhere. No count badge (Ruling 2): the Overview tile, its
 * attention item and the Invites subtitle already say "0 live" in words.
 */
export const ADMIN_SECTIONS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/invites', label: 'Invites' },
  { href: '/admin/scan', label: 'Scan' },
  { href: '/admin/firmware', label: 'Firmware' },
] as const;

export function AdminSections() {
  const pathname = usePathname();
  return (
    // The clamp scrolls where one row nearly fits; below sm the track wraps onto two rows of 44 px (C7 Ruling 10), so it
    // is the clamp's width there rather than w-max.
    <div className="max-w-full overflow-x-auto">
      <nav aria-label="Admin sections" data-testid="admin-sections" className="seg w-max max-sm:w-full">
        {ADMIN_SECTIONS.map((item) => (
          <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}
                className="seg-item whitespace-nowrap">
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
