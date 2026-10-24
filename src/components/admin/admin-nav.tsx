'use client';
import { Link } from '@/components/shell/link';
import { usePathname } from 'next/navigation';

// The app shell's TopNav look (.seg / .seg-item), over the admin routes. Exact
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
      aria-label="Admin"
      // w-max at every width, matching TopNav: inside the layout's clamp the
      // pill is in a clamped scroll container, and at auto width its items
      // would spill outside the track rather than widen it.
      className="seg w-max"
    >
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className="seg-item whitespace-nowrap"
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
