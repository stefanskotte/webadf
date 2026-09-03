import { Link } from '@/components/shell/link';

/**
 * One step in the trail. `href` is what makes it a link; a crumb without one
 * is a place you are, not a place you can go.
 */
export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The trail above a page's title.
 *
 * Replaces two conventions that were never navigation: `eyebrow` as a plain
 * string, which nine pages filled in six mutually inconsistent ways, and a
 * hand-written back link in the `actions` slot, which had already been
 * spelled two different ways ("← Library" on a game, the entry's own name on
 * a disk) and would have invented a third at the next drill-down.
 *
 * WHAT THIS TRAIL DELIBERATELY DOES NOT DO. It does not carry the collection
 * you came from. `?collection=<id>` is a real second axis on /library, but a
 * game can be in many collections and `collection_games` is many-to-many by
 * design, so the trail cannot be DERIVED from a game id -- it would have to be
 * threaded through every link as a `?from=` param and resolved on the way
 * back. Operator's ruling (2026-09-03): the root is hardcoded "Library". So a
 * person who opened a title from inside a collection returns to the whole
 * library, and the trail says so honestly rather than guessing at one of the
 * collections that title belongs to.
 *
 * The LAST crumb is the nearest ancestor, not the current page -- the page's
 * own <h1> underneath is the current page, and repeating it at 12.5px directly
 * above the same words at 34px reads as a rendering bug. The one exception is
 * a crumb that identifies WHICH of something you are looking at ("Disk 2"),
 * where the h1 is showing a different fact entirely (the volume's name).
 */
export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumb">
      {/* flex-wrap, not truncate-the-row: at 390px a trail with a real game
          title in it is wider than the screen, and a person who cannot read
          the middle of the trail cannot use it. Wrapping costs a line; the
          alternative loses the information. */}
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] font-semibold">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-x-1.5">
              {i > 0 && (
                <span aria-hidden className="select-none" style={{ color: 'rgb(233 240 244 / 0.45)' }}>
                  /
                </span>
              )}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  title={crumb.label}
                  className="max-w-[14rem] truncate transition-colors hover:underline"
                  style={{ color: 'var(--on-dark-muted)' }}
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  // aria-current only on a crumb with no href: it marks where
                  // you are, and every href crumb here is somewhere else.
                  aria-current={last ? 'page' : undefined}
                  title={crumb.label}
                  className="max-w-[14rem] truncate"
                  style={{ color: 'var(--on-dark-muted)' }}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
