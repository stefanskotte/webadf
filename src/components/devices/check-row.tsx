import type { Line } from '@/lib/network-checklist';
import { splitCheckLine } from '@/lib/network-checklist';

/** One Network checklist row (Devices spec §6): a round mark, then the line split at its first ": ". The element's
 *  text stays the line as written (`Driver disk: in DF1`); the mark is a picture, the words carry the state. */
export function CheckRow({ testid, l }: { testid: string; l: Line }) {
  const { label, detail } = splitCheckLine(l.text);
  return (
    <li data-testid={testid} data-ok={String(l.ok)} className="flex items-center gap-2.5 text-[13px]"
        style={{ color: 'var(--ink)' }}>
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
            style={{ background: l.ok ? 'var(--success-bg)' : 'var(--warning-bg)', color: l.ok ? 'var(--success-fg)' : 'var(--warning-fg)' }}>
        {l.ok ? '✓' : '•'}
      </span>
      <span className="min-w-0" style={{ overflowWrap: 'anywhere' }}>
        {label !== null && <><span className="font-medium">{label}:</span>{' '}</>}
        <span style={{ color: l.ok ? 'var(--muted)' : 'var(--warning-fg)' }}>{detail}</span>
      </span>
    </li>
  );
}
