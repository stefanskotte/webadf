import Link from 'next/link';

/** "N Demozoo suggestions" -- absent, not zero, when there is nothing to review. */
export function DemozooBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Link href="/library/demozoo" data-testid="demozoo-badge"
      className="flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold"
      style={{ borderColor: 'rgb(255 255 255 / 0.22)', color: 'var(--on-dark-muted)' }}>
      {count} Demozoo suggestion{count === 1 ? '' : 's'}
    </Link>
  );
}
