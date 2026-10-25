import { Link } from '@/components/shell/link';

export function VersionBanner({ seq, time, backHref, restore = null }: {
  seq: number; time: string | null; backHref: string; restore?: React.ReactNode;
}) {
  return (
    <div role="status" data-testid="version-banner" data-version={seq}
         className="flex flex-wrap items-center gap-3 rounded-[12px] border px-4 py-3 text-[14px]"
         style={{ background: 'var(--warning-bg)', borderColor: 'var(--fw-line)', color: 'var(--warning-fg)' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
      </svg>
      <span className="min-w-[200px] flex-1">
        You’re browsing <b>version {seq}</b>{time ? ` (${time})` : ''}. It’s read-only — restore it to make it current.
      </span>
      {restore}
      <Link href={backHref} data-testid="version-banner-back"
            className="inline-flex h-8 items-center rounded-[8px] border px-3 text-[13px] font-medium"
            style={{ borderColor: 'var(--warning-line)', color: 'var(--warning-fg)' }}>
        Back to current
      </Link>
    </div>
  );
}
