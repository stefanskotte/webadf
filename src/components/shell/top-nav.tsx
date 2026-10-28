"use client";
import { usePathname } from "next/navigation";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Link } from '@/components/shell/link';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_ITEM } from "@/components/ui/menu-item-look";
import { cn } from "@/lib/utils";
import { useSignOut } from "@/components/sign-out-button";
import { isMoreCurrent, isMoreItemCurrent, moreItems } from "@/lib/nav-tabs";

const ITEMS = [
  { href: "/library", label: "Library", phone: true },
  // Libraries shared with this team (library sharing spec §4.5). Below lg it is in the More menu: the bar is four cells.
  { href: "/remote", label: "Remote", phone: false },
  { href: "/devices", label: "Devices", phone: true },
  // Label only -- the route stays /ingest. "Ingest" was jargon for what is
  // plainly an upload; the route and the /api/ingest/* namespace are
  // referenced by the CLI, the proxy matcher and the design docs, so renaming
  // those is a separate, much wider decision.
  { href: "/ingest", label: "Upload", phone: true },
  // Below lg Help is in the More menu (C7 spec §2.3, Ruling 4).
  { href: "/help", label: "Help", phone: false },
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
const ADMIN_ITEM = { href: "/admin", label: "Admin", phone: false };

/**
 * The tab's mark below lg (C7 Ruling 5): a 32 x 4 bar above the word, --accent-amber on the current tab (4.86:1 on the
 * surface; the board's #EE8A2A is 2.49:1) and transparent on the others. Weight, ink and aria-current mark it too.
 * Empty and aria-hidden, so a tab's text and accessible name are just its word.
 */
function TabBar({ current }: { current: boolean }) {
  return (
    <span aria-hidden="true" data-tab-bar="" className="hidden h-1 w-8 rounded-full max-lg:block"
          style={{ background: current ? "var(--accent-amber)" : "transparent" }} />
  );
}

/**
 * The bar's fourth tab below lg (C7 spec §2.3, Ruling 4): a menu of Remote, Help, Settings, About this server, Admin
 * (only when the server said so) and Sign out. Current on /remote, /settings, /help and /admin. From lg the header carries Help,
 * the gear and Sign out instead, and this button is display:none.
 */
function MoreTab({ showAdmin, pathname }: { showAdmin: boolean; pathname: string }) {
  const current = isMoreCurrent(pathname);
  const signOut = useSignOut();
  // MENU_ITEM is 44 px below sm and 36 px from sm; this menu exists only below lg, so 44 px throughout.
  const item = cn(MENU_ITEM, "sm:h-11");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="nav-more" aria-haspopup="menu" aria-current={current ? "page" : undefined}
                           className="seg-item whitespace-nowrap lg:hidden">
        <TabBar current={current} />
        More
      </DropdownMenuTrigger>
      {/* side="top", align="end": the tab is at the bottom right, and Base UI does not pull an over-wide popup back on
          screen by itself (HANDOFF §3t), so the width is capped to the viewport less its gutters. */}
      <DropdownMenuContent side="top" align="end" data-testid="nav-more-menu"
                           className="w-[min(280px,calc(100vw-32px))] rounded-2xl"
                           style={{ background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", boxShadow: "var(--shadow-card)" }}>
        {moreItems(showAdmin).map((it) => {
          const here = isMoreItemCurrent(pathname, it.href);
          return (
            <MenuPrimitive.LinkItem key={it.id} data-testid={it.id} closeOnClick render={<Link href={it.href} />}
                                    aria-current={here ? "page" : undefined}
                                    className={cn("flex w-full items-center outline-none", item, here ? "font-semibold" : "font-medium")}>
              {it.label}
            </MenuPrimitive.LinkItem>
          );
        })}
        <DropdownMenuSeparator className="my-1" style={{ background: "var(--line)" }} />
        <DropdownMenuItem data-testid="more-sign-out" aria-disabled={signOut.busy || undefined}
                          onClick={() => void signOut.run()} className={cn(item, "font-medium")}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopNav({ showAdmin = false }: { showAdmin?: boolean }) {
  const pathname = usePathname();
  const items = showAdmin ? [...ITEMS, ADMIN_ITEM] : ITEMS;
  return (
    <nav
      aria-label="Main"
      // From lg: the .seg pill, w-max so it stays as wide as its items when the layout clamps it and scrolls. Below lg:
      // .nav-tabs (globals.css) makes the same element a four-cell tab bar (C7 spec §2.3). One nav at every width:
      // a second, phone-only copy would make getByRole('link') ambiguous in the 1280 suite.
      className="seg nav-tabs lg:w-max"
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={item.phone ? "seg-item whitespace-nowrap" : "seg-item whitespace-nowrap max-lg:hidden"}
          >
            <TabBar current={active} />
            {item.label}
          </Link>
        );
      })}
      <MoreTab showAdmin={showAdmin} pathname={pathname} />
    </nav>
  );
}
