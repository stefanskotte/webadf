import { Link } from '@/components/shell/link';

export function ViewToggle({ view }: { view: 'grid' | 'table' }) {
  // Bigger on a phone and back to today's 36x32 from `sm`: this pair lives in
  // the page header's actions, where a thumb is the only pointer there is.
  const base = 'grid h-10 w-11 place-items-center text-[11px] font-semibold sm:h-8 sm:w-9';
  const on  = { background: 'var(--primary-action)', color: '#fff' };
  const off = { color: 'var(--muted)' };
  return (
    <div className="flex overflow-hidden rounded-lg border"
         style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)' }}>
      <Link href="/library?view=grid"  aria-label="Grid view"  aria-pressed={view === 'grid'}
            className={base} style={view === 'grid' ? on : off}>▦</Link>
      <Link href="/library?view=table" aria-label="Table view" aria-pressed={view === 'table'}
            className={base} style={view === 'table' ? on : off}>☰</Link>
    </div>
  );
}
