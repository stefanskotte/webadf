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
    // The clamp scrolls on a phone (five tabs are ~420 px); w-max keeps the track as wide as its items.
    <div className="max-w-full overflow-x-auto">
      <nav aria-label="Admin sections" data-testid="admin-sections" className="seg w-max">
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
