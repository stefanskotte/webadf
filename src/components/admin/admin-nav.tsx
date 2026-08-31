'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Mirrors the app shell's TopNav styling, but over the admin routes. Exact
// matching on href, not startsWith: '/admin' is a prefix of every other entry,
// so startsWith would light up Overview on all three pages.
// Invites is added by task 4, together with the page it points at -- a nav
// entry linking at a route that does not exist yet would 404 the operator.
const ITEMS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      className="flex items-center gap-[3px] rounded-full border p-1"
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
