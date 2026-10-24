"use client";
import { Link } from '@/components/shell/link';
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/library", label: "Library" },
  { href: "/devices", label: "Devices" },
  // Label only -- the route stays /ingest. "Ingest" was jargon for what is
  // plainly an upload; the route and the /api/ingest/* namespace are
  // referenced by the CLI, the proxy matcher and the design docs, so renaming
  // those is a separate, much wider decision.
  { href: "/ingest", label: "Upload" },
  { href: "/help", label: "Help" },
];

// Rendered only when the layout says so. `showAdmin` is decided on the server
// by isSuperAdminEmail(); this component must never work it out for itself,
// because a client component cannot read SUPERADMIN_EMAILS and shipping the
// allowlist to the browser to let it try would publish the very thing the
// env var exists to keep out of the database and off the wire.
//
// Hiding the link is presentation, NOT access control -- /admin is guarded by
// requireSuperAdmin() in the (admin) layout, and each /api/admin route guards
// itself. What omitting it preserves is non-disclosure: the plane redirects a
// non-admin to /library rather than 404ing precisely so the response never
// confirms /admin exists, and a link rendered for everyone would leak that in
// the markup anyway.
const ADMIN_ITEM = { href: "/admin", label: "Admin" };

export function TopNav({ showAdmin = false }: { showAdmin?: boolean }) {
  const pathname = usePathname();
  const items = showAdmin ? [...ITEMS, ADMIN_ITEM] : ITEMS;
  return (
    <nav
      aria-label="Main"
      // w-max at every width so the pill stays as wide as its items when the
      // layout clamps it and scrolls (the phone bar, and the in-flow header
      // at narrow sm widths): at the clamp's own width
      // the items would spill outside the track instead of taking it with
      // them. The look is .seg / .seg-item (globals.css): muted on the
      // track, the current page a raised surface in ink.
      className="seg w-max"
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="seg-item whitespace-nowrap"
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
