import type { ReactNode } from 'react';
import { DiskIcon } from '@/components/ui/disk-icon';
import type { DiskColor } from '@/lib/disk-icon';
import { MAX_ENTRIES, type VolumeResult, type VolumeUsage } from '@/lib/adffs';
import { countTree, densityPill, formatKb, plural } from '@/lib/disk-files-look';

const LIGHT = { in: 'var(--online-dot)', moving: 'var(--fetch-dot)', stale: 'var(--fetch-dot)', none: 'var(--dash)' } as const;
const NO_FILESYSTEM_COPY = {
  'not-adf': 'This image is not a standard 880 KB or 1.76 MB ADF.',
  'no-dos-signature': 'No AmigaDOS filesystem — this disk has no DOS signature, which is normal for a game or demo with a custom bootblock.',
  'no-filesystem': 'No AmigaDOS filesystem — the disk has a DOS signature but no valid root block, which is normal for a cracked or copy-protected game.',
} as const;
/** The no-filesystem sentence (moved from volume-header.tsx, words unchanged); rendered in the Files card (§4.6). */
export function noFilesystemCopy(r: Extract<VolumeResult, { ok: false }>): string { return NO_FILESYSTEM_COPY[r.reason]; }

const Pill = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full px-[9px] py-0.5 font-medium" style={{ background: 'var(--track)', color: 'var(--muted)' }}>
    {children}
  </span>
);

export interface DiskCardProps {
  diskId: string; filename: string; title: string; color: DiskColor; hd: boolean; writeProtected: boolean;
  badge: 'DF0' | 'DF1' | null; volume: VolumeResult | null; usage: VolumeUsage | null; sizeBytes: number;
  rootBlock: number; holder: { text: string; stale: boolean } | null; light: 'in' | 'moving' | 'stale' | 'none';
  actions: ReactNode;
}

export function DiskCard(p: DiskCardProps) {
  const ok = p.volume?.ok === true ? p.volume : null;
  const counts = ok ? countTree(ok.root) : null;
  const unreadable = p.volume === null;   // the stored bytes could not be read: not the same as a disk with no filesystem
  const fsLine = ok ? `${p.hd ? 'HD' : 'DD'} · ${ok.volume.filesystem}` : unreadable ? 'Unreadable' : 'No filesystem';
  return (
    <section aria-label="Disk" data-testid="disk-card"
             className="flex flex-col gap-4 rounded-[20px] p-4 sm:px-6 sm:py-5 lg:flex-row lg:items-center lg:gap-6"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
      <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
        <DiskIcon className="shrink-0 max-sm:hidden" size={76} color={p.color} hd={p.hd} wp={p.writeProtected}
                  mounted={p.badge !== null} drive={p.badge ?? 'DF0'} set={fsLine} title={p.title} />
        <DiskIcon className="shrink-0 sm:hidden" size={56} color={p.color} hd={p.hd} wp={p.writeProtected}
                  mounted={p.badge !== null} drive={p.badge ?? 'DF0'} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5" data-testid={ok ? 'volume-header' : undefined}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 tabIndex={-1}
                className="rounded-[6px] text-[26px] font-bold leading-[1.05] tracking-[-0.02em] [overflow-wrap:anywhere] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring) sm:text-[34px]"
                style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
              {p.title}
            </h1>
            {p.filename !== p.title && (
              <span className="font-mono text-[13px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{p.filename}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]" style={{ color: 'var(--muted)' }}>
            {ok ? <Pill>{ok.volume.filesystem}</Pill> : <Pill>{unreadable ? 'Unreadable' : 'No filesystem'}</Pill>}
            {ok?.volume.intl && <Pill>INTL</Pill>}
            {ok?.volume.dirc && <Pill>DIRC</Pill>}
            <Pill>{densityPill(p.rootBlock, p.sizeBytes)}</Pill>
            {counts && <span>{plural(counts.files, 'file')} · {plural(counts.dirs, 'folder')}</span>}
            {ok?.volume.modifiedAt && <><span aria-hidden>·</span><span>Modified {ok.volume.modifiedAt.toISOString().slice(0, 10)}</span></>}
          </div>
          {ok?.truncated && (
            <p className="text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid="listing-truncated">
              listing truncated at {MAX_ENTRIES.toLocaleString()} entries
            </p>
          )}
          {ok && ok.warnings.length > 0 && (
            <p className="text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid="volume-warnings">{ok.warnings.join('; ')}</p>
          )}
        </div>
      </div>
      {/* Space: A5's words (Ruling 5), the board's two ends over a meter. */}
      <div className="flex w-full flex-col gap-2 lg:w-[300px]">
        {p.usage ? (
          <div className="flex flex-col gap-2" data-testid="volume-usage">
            <div className="flex justify-between gap-3 text-[13px]" data-testid="volume-usage-text">
              <span className="font-semibold" style={{ color: 'var(--ink)' }}>
                {formatKb(p.usage.usedBytes)} used of {formatKb(p.usage.totalBytes)}
              </span>
              <span className="sr-only"> · </span>
              <span style={{ color: 'var(--muted-2)' }}>{formatKb(p.usage.freeBytes)} free</span>
            </div>
            <div role="meter" aria-label="Disk space used" aria-valuemin={0}
                 aria-valuemax={Math.round(p.usage.totalBytes / 1024)} aria-valuenow={Math.round(p.usage.usedBytes / 1024)}
                 aria-valuetext={`${formatKb(p.usage.usedBytes)} used of ${formatKb(p.usage.totalBytes)}`}
                 data-testid="volume-usage-meter" className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
              <div className="h-2 rounded-full" style={{ width: `${p.usage.percentUsed}%`,
                   background: p.usage.percentUsed >= 90 ? 'var(--accent-amber)' : 'var(--ink)' }} />
            </div>
          </div>
        ) : (
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }} data-testid="volume-usage-unknown">
            {unreadable
              ? 'unknown — the stored bytes for this disk could not be read'
              : <>unknown — this disk&apos;s allocation bitmap is not usable</>}
          </span>
        )}
      </div>
      <div aria-hidden className="hidden w-px self-stretch lg:block" style={{ background: 'var(--line)' }} />
      <div className="flex flex-wrap items-center gap-2.5" data-testid="disk-mount-bar">
        <span className="flex items-center gap-2 text-[13px]" data-testid="drive-light" data-state={p.light}>
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: LIGHT[p.light] }} />
          <span data-testid={`holder-${p.diskId}`} className="font-semibold"
                style={{ color: p.holder?.stale ? 'var(--amber-text)' : 'var(--muted)' }}>
            {p.holder ? p.holder.text : 'Not in a drive'}
          </span>
        </span>
        {p.actions}
        <a href={`/api/disks/${p.diskId}/adf`} aria-label={`Download ${p.filename}`} title={`Download ${p.filename}`}
           data-testid={`download-${p.diskId}`}
           className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border hover:bg-[var(--track)]"
           style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></svg>
        </a>
      </div>
    </section>
  );
}
