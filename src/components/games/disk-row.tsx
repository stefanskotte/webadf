import { Link } from '@/components/shell/link';
import type { GameDetailDisk } from '@/lib/queries';
import { WriteProtectToggle } from './write-protect-toggle';
import { MountAction, type MountTarget } from './mount-action';

/** What some device is doing with this particular disk, if anything. */
export interface DiskHolder { deviceName: string; state: 'converged' | 'pending' | 'stale' }

export function DiskRow({ disk, devices, holder }: {
  disk: GameDetailDisk;
  devices: MountTarget[];
  holder: DiskHolder | null;
}) {
  const holderText =
    !holder ? null
    : holder.state === 'converged' ? `In ${holder.deviceName}`
    : holder.state === 'pending' ? `Mounting to ${holder.deviceName}…`
    : `Requested on ${holder.deviceName} — not confirmed`;

  return (
    <div
      // Five controls plus the name on one line leave under 60px for the
      // name at 390px, and the name is the thing the row is about. Below
      // `sm` the controls drop to a second line of their own; from `sm` up
      // this is the single row it has always been.
      className="glass-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4"
      data-testid={`disk-${disk.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-bold" style={{ color: 'var(--ink)' }}>
            Disk {disk.diskNo}
          </span>
          {disk.isBoot && (
            <span className="rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-white"
                  style={{ background: 'var(--accent-amber)' }}>Boot</span>
          )}
        </div>
        {/*
          Both names, TOSEC first, and the uploaded one only when it actually
          differs. They disagree more often than you would expect -- one disk
          here is "[cr Nemesis]" to its uploader and "[cr NMS]" to TOSEC --
          and collapsing them to one line would hide that. `title` carries the
          full string, since either can be far wider than the row.
        */}
        {disk.tosecName && (
          <span className="truncate font-mono text-[11px]" title={disk.tosecName}
                style={{ color: 'var(--ink)' }} data-testid={`tosec-name-${disk.id}`}>
            {disk.tosecName}
          </span>
        )}
        {disk.sourceFilename && disk.sourceFilename !== disk.tosecName && (
          <span className="truncate font-mono text-[11px]" title={disk.sourceFilename}
                style={{ color: 'var(--muted)' }} data-testid={`source-name-${disk.id}`}>
            {disk.tosecName ? 'uploaded as ' : ''}{disk.sourceFilename}
          </span>
        )}
        <span className="truncate font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
          {(disk.sizeBytes / 1024).toFixed(0)} KB · {disk.sha256.slice(0, 12)}
        </span>
        {holderText && (
          <span className="text-[11.5px] font-semibold"
                style={{ color: holder!.state === 'stale' ? 'var(--amber-text)' : 'var(--muted)' }}
                data-testid={`holder-${disk.id}`}>
            {holderText}
          </span>
        )}
      </div>
      {/*
        `sm:contents` so the controls are a wrapped block of their own on a
        phone and, from `sm` up, generate no box at all -- the row's flex
        then lays out these four exactly as it did before this wrapper
        existed. Nothing here is portalled or absolutely positioned: the
        mount picker expands INLINE (see mount-action.tsx), and
        game-detail.spec.ts asserts that the next row's trigger sits below
        an open picker rather than under it.
      */}
      <div className="flex flex-wrap items-center gap-2 sm:contents">
        {/*
          A plain anchor, not a fetch: the browser streams the response straight
          to disk and shows its own progress. Pulling 880 KB into JS first would
          buffer the whole image in memory to achieve exactly the same save.
          No `download` attribute -- the server's Content-Disposition already
          names the file, and it knows the canonical name while the client does
          not.
        */}
        <a
          href={`/api/disks/${disk.id}/adf`}
          data-testid={`download-${disk.id}`}
          className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
          style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
        >
          Download
        </a>
        {/*
          Link, not <a>: this is an internal navigation to the file browser
          page and should be client-side, unlike Download above which must be
          a real request so the browser streams the response to disk.
        */}
        <Link
          href={`/disks/${disk.id}/files`}
          data-testid={`browse-${disk.id}`}
          className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
          style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
        >
          Browse
        </Link>
        <WriteProtectToggle diskId={disk.id} writeProtected={disk.writeProtected} />
        <MountAction diskId={disk.id} devices={devices} />
      </div>
    </div>
  );
}
