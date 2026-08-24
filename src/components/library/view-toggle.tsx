import Link from 'next/link';

export function ViewToggle({ view }: { view: 'grid' | 'table' }) {
  const base = 'grid h-8 w-9 place-items-center text-[11px] font-semibold';
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
