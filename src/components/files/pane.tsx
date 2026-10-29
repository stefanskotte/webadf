'use client';

import { useMemo, type ReactNode } from 'react';
import type { FsEntry, Listing } from '@/lib/files/types';
import { sortFsEntries, type FilesSort, type FilesSortKey } from '@/lib/files/sort';
import type { Selection } from '@/lib/files/selection';
import { refusalWords } from '@/lib/files/words';
import { entryGlyph } from '@/lib/disk-files-look';
import { ProtectionCells } from '@/components/disks/protection-cells';

/**
 * One side of the Files manager. Presentational: the manager (files-manager.tsx) owns fetching, sort and selection
 * and is called back. EVERY row index here -- `selection`, `onRowClick`, `onRowOpen`, `onDragStartRows` -- is an
 * index into the entries AFTER `sortFsEntries(listing.entries, sort)`, the order the rows are drawn in; the manager
 * sorts the same way to map an index back to its entry.
 */
export type PaneProps = {
  side: 'left' | 'right'; active: boolean; listing: Listing | null; loading: boolean; error: string | null;
  sort: FilesSort; selection: Selection; showComment: boolean;
  onActivate(): void; onNavigate(path: string): void; onSort(key: FilesSortKey): void;
  onRowClick(index: number, mods: { shift: boolean; toggle: boolean }): void; onRowOpen(index: number): void;
  onDragStartRows(indexes: number[], e: React.DragEvent): void; onDropRows(e: React.DragEvent): void;
  strip?: ReactNode;   // the disk strip when listing.disk
  errorAction?: ReactNode;   // under the error, e.g. a way back to LIBRARY: when the place is gone
};

/** Increment 1 has one device (R1); STASH: and NET: join later. */
const DEVICES = ['LIBRARY:'] as const;

const COLUMNS: { key: FilesSortKey; label: string; right?: boolean }[] = [
  { key: 'name', label: 'Name' }, { key: 'size', label: 'Size', right: true },
  { key: 'protection', label: 'Protection' }, { key: 'date', label: 'Date' },
];

/** Bytes as the panes show them: B under a KB, whole KB under a MB, then MB to one place. */
export function paneSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The type chip: the Browse glyph for files and folders; a title and a disk are folders here. */
function glyphOf(e: FsEntry): { label: string; bg: string; fg: string } {
  if (e.kind === 'title') return { label: 'TTL', bg: 'var(--dir-bg)', fg: 'var(--accent-blue)' };
  if (e.kind === 'disk') return { label: 'DSK', bg: 'var(--dir-bg)', fg: 'var(--accent-blue)' };
  return entryGlyph({ kind: e.kind, name: e.name });
}

/** The header's right-hand line: a disk's free space and format, otherwise the listing's own meta. */
function metaOf(l: Listing): string {
  const d = l.disk;
  if (!d) return l.meta;
  const fmt = `${d.filesystem ?? 'No filesystem'} ${d.hd ? 'HD' : 'DD'}`;
  return d.freeBytes === null ? fmt : `${paneSize(d.freeBytes)} free · ${fmt}`;
}

export function Pane(p: PaneProps) {
  const { side, listing, sort, selection } = p;
  const rows = useMemo(() => (listing ? sortFsEntries(listing.entries, sort) : []), [listing, sort]);
  const tid = (s: string) => `pane-${side}-${s}`;
  const device = listing ? listing.path.slice(0, listing.path.indexOf(':') + 1) : 'LIBRARY:';
  const crumbs = listing?.crumbs ?? [];
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;

  const picked = [...selection.picked].filter((i) => i < rows.length).sort((a, b) => a - b);
  const pickedBytes = picked.reduce((n, i) => n + (rows[i].size ?? 0), 0);
  const foot = picked.length > 0 ? `${picked.length} of ${rows.length} selected · ${paneSize(pickedBytes)}` : listing?.meta ?? '';

  const cell = 'border-b px-2.5 py-[7px] whitespace-nowrap';
  const cellStyle = { borderColor: 'var(--hairline)' } as const;

  return (
    <section data-testid={`pane-${side}`} data-active={p.active ? 'true' : 'false'}
             aria-label={side === 'left' ? 'Left pane' : 'Right pane'}
             onMouseDown={p.onActivate} onFocus={p.onActivate}
             onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); p.onDropRows(e); }}
             className="flex min-w-0 flex-col" style={{ background: 'var(--surface)' }}>
      <div className="border-b px-3.5 pt-3 pb-2.5"
           style={{ borderColor: 'var(--line)', background: p.active ? 'var(--viewing-bg)' : undefined }}>
        <div className="mb-2 flex gap-1.5">
          {DEVICES.map((d) => (
            <button key={d} type="button" aria-pressed={device === d} data-testid={tid(`dev-${d.slice(0, -1)}`)}
                    onClick={() => p.onNavigate(d)}
                    className="rounded-[7px] px-2 py-1 font-mono text-[12px] focus-visible:outline-2 focus-visible:outline-(--ring)"
                    style={device === d ? { background: 'var(--ink)', color: 'var(--surface)' } : { background: 'var(--track)', color: 'var(--muted)' }}>
              {d}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <button type="button" aria-label="Up one level" title="Up one level" data-testid={tid('up')} disabled={!parent}
                  onClick={() => parent && p.onNavigate(parent.path)}
                  className="shrink-0 rounded-[6px] border px-1.5 font-mono text-[13px] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-(--ring)"
                  style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>↑</button>
          <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center font-mono text-[13px]">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center">
                {i > 0 && !crumbs[i - 1].label.endsWith(':') && <span aria-hidden style={{ color: 'var(--muted-2)' }}>/</span>}
                <button type="button" data-testid={tid(`crumb-${i}`)} onClick={() => p.onNavigate(c.path)}
                        aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                        className="rounded-[4px] font-medium [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-(--ring)"
                        style={{ color: 'var(--ink)' }}>{c.label}</button>
              </span>
            ))}
          </nav>
          {listing && (
            <span data-testid={tid('meta')} className="ml-auto shrink-0 pl-2 text-[12px]" style={{ color: 'var(--muted-2)' }}>
              {metaOf(listing)}
            </span>
          )}
        </div>
        {listing && !listing.writable && listing.readOnlyReason && (
          <p data-testid={tid('readonly')} className="mt-1.5 text-[12px]" style={{ color: 'var(--warning-fg)' }}>
            {refusalWords('read_only', listing.readOnlyReason)}
          </p>
        )}
      </div>
      {listing?.disk && p.strip}

      {p.error && (
        <p role="alert" data-testid={tid('error')} className="px-3.5 py-3 text-[13px]" style={{ color: 'var(--danger-fg)' }}>{p.error}</p>
      )}
      {p.error && p.errorAction && <div className="px-3.5 pb-3">{p.errorAction}</div>}
      {p.loading && !listing && (
        <p data-testid={tid('loading')} className="px-3.5 py-3 text-[13px]" style={{ color: 'var(--muted)' }}>Loading…</p>
      )}
      {listing && (
        <div className="min-h-0 flex-1 overflow-auto" aria-busy={p.loading || undefined}>
          <table role="grid" aria-multiselectable="true" aria-label={`${side === 'left' ? 'Left' : 'Right'} pane files`}
                 className="w-full border-collapse text-[13px]">
            <thead>
              <tr style={{ background: 'var(--modal-foot)', color: 'var(--muted-2)' }}>
                <th className={`${cell} w-6`} style={cellStyle}><span className="sr-only">Select</span></th>
                {COLUMNS.map((c) => {
                  const on = sort.key === c.key;
                  return (
                    <th key={c.key} data-testid={tid(`sort-${c.key}`)} style={cellStyle}
                        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={`${cell} text-[12px] font-medium ${c.key === 'name' ? 'w-full' : ''}`}>
                      <button type="button" onClick={() => p.onSort(c.key)}
                              className={`flex w-full items-center gap-1 rounded-[4px] ${c.right ? 'justify-end' : ''} focus-visible:outline-2 focus-visible:outline-(--ring)`}>
                        {c.label}
                        {on && <span aria-hidden="true" className="text-[9px]">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                      </button>
                    </th>
                  );
                })}
                {p.showComment && (
                  <th aria-sort="none" data-testid={tid('col-comment')} style={cellStyle}
                      className={`${cell} text-left text-[12px] font-medium`}>Comment</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => {
                const sel = selection.picked.has(i);
                const glyph = glyphOf(e);
                return (
                  <tr key={e.path} data-testid="pane-row" data-name={e.name} data-kind={e.kind} aria-selected={sel}
                      data-cursor={p.active && selection.cursor === i ? 'true' : undefined}
                      draggable
                      onDragStart={(ev) => p.onDragStartRows(sel ? picked : [i], ev)}
                      onClick={(ev) => p.onRowClick(i, { shift: ev.shiftKey, toggle: ev.metaKey || ev.ctrlKey })}
                      onDoubleClick={() => p.onRowOpen(i)}
                      className="cursor-default select-none hover:bg-[var(--surface-2)] data-[cursor=true]:outline data-[cursor=true]:outline-1 data-[cursor=true]:-outline-offset-1 data-[cursor=true]:outline-(--line-strong)"
                      style={sel ? { background: 'var(--warning-bg)' } : undefined}>
                    <td className={cell} style={cellStyle}>
                      <input type="checkbox" checked={sel} aria-label={`Select ${e.name}`}
                             onClick={(ev) => ev.stopPropagation()}
                             onChange={() => p.onRowClick(i, { shift: false, toggle: true })}
                             className="h-3.5 w-3.5 align-middle" style={{ accentColor: 'var(--accent-amber)' }} />
                    </td>
                    <td className={cell} style={cellStyle}>
                      <span className="flex min-w-0 items-center gap-[7px]">
                        <span aria-hidden className="shrink-0 rounded-[4px] px-[5px] py-px font-mono text-[10px] font-semibold"
                              style={{ background: glyph.bg, color: glyph.fg }}>{glyph.label}</span>
                        <span className={`truncate ${e.kind === 'file' ? '' : 'font-semibold'}`} style={{ color: 'var(--ink)' }}>{e.name}</span>
                        {e.marks.map((m) => (
                          <span key={m} className="shrink-0 rounded-full border px-[7px] text-[11px]"
                                style={{ background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--muted-2)' }}>{m}</span>
                        ))}
                      </span>
                    </td>
                    <td className={`${cell} text-right font-mono text-[12px]`} style={{ ...cellStyle, color: 'var(--muted)' }}>
                      {e.kind === 'file' && e.size !== null ? paneSize(e.size) : '—'}
                    </td>
                    <td className={`${cell} font-mono text-[11px] font-semibold`} style={cellStyle}>
                      {e.protection ? <span className="flex gap-0.5"><ProtectionCells protection={e.protection} /></span>
                        : <span style={{ color: 'var(--muted-2)' }}>—</span>}
                    </td>
                    <td className={`${cell} font-mono text-[12px]`} style={{ ...cellStyle, color: 'var(--muted)' }}>
                      {e.date ? e.date.slice(0, 10) : '—'}
                    </td>
                    {p.showComment && (
                      <td className={`${cell} max-w-[16rem] truncate text-[12px]`} style={{ ...cellStyle, color: 'var(--muted)' }}>
                        {e.comment ?? ''}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="px-3.5 py-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>Nothing here.</p>
          )}
        </div>
      )}

      <div data-testid={tid('foot')} className="mt-auto border-t px-3.5 py-[9px] text-[12px]"
           style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
        {foot}
      </div>
    </section>
  );
}
