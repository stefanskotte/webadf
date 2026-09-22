'use client';
import { Link } from '@/components/shell/link';
import { usePathname } from 'next/navigation';

// Mirrors the app shell's TopNav styling, but over the admin routes. Exact
// matching on href, not startsWith: '/admin' is a prefix of every other entry,
// so startsWith would light up Overview on every other page.
const ITEMS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/invites', label: 'Invites' },
  { href: '/admin/scan', label: 'Scan' },
  { href: '/admin/firmware', label: 'Firmware' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      // w-max below sm, matching TopNav: inside the layout's bottom bar the
      // pill is in a clamped scroll container, and at auto width its items
      // would spill outside the pill's own border rather than widen it.
      className="flex w-max items-center gap-[3px] rounded-full border p-1 sm:w-auto"
      style={{
        background: 'rgb(255 255 255 / 0.12)',
        borderColor: 'rgb(255 255 255 / 0.16)',
      }}
    >
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className="flex h-[34px] items-center rounded-full px-4 text-[13px] transition-colors"
            style={
              active
                ? { background: 'var(--on-dark)', color: '#16273a', fontWeight: 600 }
                : { color: 'rgb(233 240 244 / 0.78)', fontWeight: 500 }
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
