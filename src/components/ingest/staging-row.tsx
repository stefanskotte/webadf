'use client';
import { DiskIcon } from '@/components/ui/disk-icon';
import { HdTag } from '@/components/disks/hd-tag';
import { adfDensity, isHfeFilename } from '@/lib/disk-format';
import { directionPill, rowDiskColor, toneLook } from '@/lib/upload-look';
import type { ViewRow } from '@/lib/upload-staging';

const XL = 'xl:col-auto xl:row-auto xl:col-start-auto xl:row-start-auto xl:row-span-1 xl:col-span-1';

/** One Staging row (C3 spec §5): the board's one-line grid from xl, a three-line card below. */
export function StagingRow({ v, children }: { v: ViewRow; children?: React.ReactNode }) {
  const pill = directionPill(v.kind);
  const tone = toneLook(v.tone);
  const hd = v.kind === 'lib' && !isHfeFilename(v.name) && adfDensity(v.row.sizeBytes) === 'hd';
  // A refused library file says why in its status ("Failed · No disk images inside"); the reason keeps ingest-note.
  const failNote = v.row.source === 'lib' && v.row.state === 'failed' && v.row.note ? v.row.note : null;
  return (
    <li data-testid="staging-row" data-kind={v.kind} data-state={v.state} data-key={v.key}
        className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 rounded-[10px] px-2 py-2 hover:bg-[var(--modal-foot)] xl:min-h-[58px] xl:grid-cols-[40px_140px_minmax(0,1fr)_90px_190px_400px] xl:items-center xl:gap-3.5"
        style={{ borderBottom: '1px solid var(--hairline)' }}>
      <span className={`row-span-3 self-start xl:self-center ${XL}`}><DiskIcon color={rowDiskColor(v)} size={32} /></span>
      <span data-testid={`staging-dir-${v.key}`} className={`col-start-3 row-start-1 flex items-center gap-1.5 justify-self-end whitespace-nowrap rounded-full px-[9px] py-0.5 text-[12px] font-semibold xl:justify-self-start ${XL}`}
            style={{ background: pill.bg, color: pill.fg }}>
        <span aria-hidden="true">{pill.arrow}</span>{pill.label}
      </span>
      <span className={`col-start-2 row-start-1 flex min-w-0 flex-col gap-0.5 ${XL}`}>
        <span style={{ overflowWrap: 'anywhere' }}>
          <span className="font-mono text-[13px] font-medium" style={{ color: 'var(--ink)' }}>{v.name}</span>
          {v.note && <span className="ml-2 text-[12px]" data-testid="ingest-note" style={{ color: 'var(--muted)' }}>{v.note}</span>}
        </span>
        <span data-testid={`staging-where-${v.key}`} className="text-[12px]" style={{ color: 'var(--muted-2)', overflowWrap: 'anywhere' }}>{v.where}</span>
      </span>
      <span data-testid={`staging-size-${v.key}`} className={`col-start-3 row-start-2 flex items-center justify-end gap-1 font-mono text-[12px] ${XL}`}
            style={{ color: 'var(--muted-2)' }}>
        {v.size}{hd && <HdTag testId="ingest-hd-tag" />}
      </span>
      <span className={`col-start-2 row-start-2 flex min-w-0 flex-col gap-[5px] ${XL}`}>
        <span data-testid={`staging-status-${v.key}`} className="flex items-center gap-1.5 text-[12px] font-semibold"
              style={{ color: tone.fg, overflowWrap: 'anywhere' }}>
          <span aria-hidden="true" className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: tone.dot }} />
          {failNote ? <span>Failed · <span data-testid="ingest-note">{failNote}</span></span> : v.status}
        </span>
        {v.pct !== null && (
          <span data-testid={`staging-progress-${v.key}`} aria-hidden="true" className="block h-[5px] overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
            <span className="block h-[5px]" style={{ width: `${v.pct}%`, background: 'var(--fetch-dot)' }} />
          </span>
        )}
      </span>
      <span data-testid={`staging-actions-${v.key}`} className={`col-span-2 col-start-2 row-start-3 flex flex-wrap items-center gap-1.5 xl:justify-end ${XL}`}>
        {children}
      </span>
    </li>
  );
}
