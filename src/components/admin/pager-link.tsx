import { Link } from '@/components/shell/link';

const BOX = 'inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] font-medium';

/**
 * One pager end (C6 spec §3.3, §6.4, Ruling 12): a link to the page, or at an end an aria-disabled span of the same
 * size -- a disabled link is not a thing, and admin-guard clicks `link 'Next'`. The span never carries the test id:
 * admin-firmware counts `fw-page-newer` as absent on page 1.
 */
export function PagerLink({ href, label, testId }: { href: string | null; label: string; testId?: string }) {
  if (href === null) {
    return (
      <span aria-disabled="true" className={BOX}
            style={{ background: 'var(--surface-2)', color: 'var(--muted-2)', border: '1px solid var(--line)' }}>
        {label}
      </span>
    );
  }
  return (
    // Colours as classes: an inline background would beat the hover.
    <Link href={href} data-testid={testId}
          className={`${BOX} border border-(--line) bg-(--surface) text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)`}>
      {label}
    </Link>
  );
}
