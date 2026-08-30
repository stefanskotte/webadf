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
    <div className="glass-card flex items-center gap-4 p-4" data-testid={`disk-${disk.id}`}>
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
      <WriteProtectToggle diskId={disk.id} writeProtected={disk.writeProtected} />
      <MountAction diskId={disk.id} devices={devices} />
    </div>
  );
}
