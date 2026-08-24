"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/library", label: "Library" },
  { href: "/devices", label: "Devices" },
  { href: "/ingest", label: "Ingest" },
];

export function TopNav() {
  const pathname = usePathname();
  return (
    <nav
      className="mx-auto flex items-center gap-[3px] rounded-full border p-1"
      style={{
        background: "rgb(255 255 255 / 0.12)",
        borderColor: "rgb(255 255 255 / 0.16)",
      }}
    >
      {ITEMS.map((item) => {
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
