import { deviceState } from '@/lib/device-state';
import type { DeviceListItem } from '@/lib/queries';
import { EjectButton } from './eject-button';

function relative(from: Date | null, now: number): string {
  if (!from) return 'never';
  const s = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function DeviceCard({ device, now }: { device: DeviceListItem; now: number }) {
  const state = deviceState(device, now);

  // A pending state means desired and actual differ. That is a MOUNT when a
  // disk is desired and an EJECT when none is -- same state, opposite words.
  // Heading "Mounting..." over detail "Ejecting" is the bug this branch avoids.
  const ejecting = state === 'pending' && device.desiredSha256 === null;

  const heading =
    state === 'empty' ? 'No disk'
    : state === 'converged' ? 'In the drive'
    : state === 'pending' ? (ejecting ? 'Ejecting…' : 'Mounting…')
    : 'Requested';

  const detail =
    state === 'empty' ? 'Mount one from the library'
    : state === 'converged'
      ? `${device.mountedGame ?? 'Unknown'} — disk ${device.mountedDiskNo ?? '?'}`
        + (device.desiredDiskCount ? ` of ${device.desiredDiskCount}` : '')
    : state === 'pending'
      ? ejecting
        ? `Removing ${device.mountedGame ?? 'a disk'} disk ${device.mountedDiskNo ?? '?'}`
        : `${device.desiredGame ?? 'Unknown'} disk ${device.desiredDiskNo ?? '?'}`
          + (device.mountedSha256 ? ` · currently holding ${device.mountedGame ?? 'a disk'} disk ${device.mountedDiskNo ?? '?'}` : '')
    : `${device.desiredGame ?? 'Unknown'} disk ${device.desiredDiskNo ?? '?'} · device last seen ${relative(device.lastSeenAt, now)}`;

  return (
    <div className="glass-card flex flex-col gap-3 p-5" data-testid={`device-${device.id}`}
         data-state={state}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[16px] font-bold" style={{ color: 'var(--ink)' }}>{device.name}</span>
          <span className="font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
            {[device.macAddress, device.firmwareVersion && `fw ${device.firmwareVersion}`,
              device.rssi !== null && `${device.rssi} dBm`].filter(Boolean).join(' · ')}
          </span>
        </div>
        {(device.desiredSha256 || device.mountedSha256) && <EjectButton deviceId={device.id} />}
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: state === 'stale' ? 'var(--amber-text)' : 'var(--muted)' }}>
          {heading}
        </span>
        <span className="text-[13px]" style={{ color: 'var(--ink)' }}>{detail}</span>
      </div>

      {device.lastError && (
        <div className="rounded-lg px-3 py-2 text-[12px]"
             style={{ background: 'var(--input-bg)', color: 'var(--amber-text)' }}
             data-testid={`device-error-${device.id}`}>
          {device.lastError}
        </div>
      )}
    </div>
  );
}
