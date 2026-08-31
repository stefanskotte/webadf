"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/library", label: "Library" },
  { href: "/devices", label: "Devices" },
  // Label only -- the route stays /ingest. "Ingest" was jargon for what is
  // plainly an upload; the route and the /api/ingest/* namespace are
  // referenced by the CLI, the proxy matcher and the design docs, so renaming
  // those is a separate, much wider decision.
  { href: "/ingest", label: "Upload" },
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
      className="mx-auto flex items-center gap-[3px] rounded-full border p-1"
      style={{
        background: "rgb(255 255 255 / 0.12)",
        borderColor: "rgb(255 255 255 / 0.16)",
      }}
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="flex h-[34px] items-center rounded-full px-4 text-[13px] transition-colors"
            style={
              active
                ? { background: "var(--on-dark)", color: "#16273a", fontWeight: 600 }
                : { color: "rgb(233 240 244 / 0.78)", fontWeight: 500 }
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
