import { deviceState, relative } from '@/lib/device-state';
import { firmwareLabel, type FirmwareState } from '@/lib/firmware-state';
import { isDefaultDeviceName } from '@/lib/device-name';
import type { DeviceListItem } from '@/lib/queries';
import { EjectButton } from './eject-button';
import { DeviceAlias } from './device-alias';

export function DeviceCard(
  { device, now, firmware }: { device: DeviceListItem; now: number; firmware: FirmwareState },
) {
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
        // desiredDiskCount is a SQL count(*), so it is 0 -- never null --
        // when nothing is desired. Compare numerically, not by truthiness, so
        // the "0 means don't show it" intent doesn't read as a null-check.
        // (The `?? 0` is only to satisfy the nullable column type; the value
        // itself is never actually null.)
        + ((device.desiredDiskCount ?? 0) > 0 ? ` of ${device.desiredDiskCount}` : '')
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
        {/*
          min-w-0 + break-words on the identity line: MAC, firmware and RSSI
          joined together run past 300px, and a flex item refuses to shrink
          below its content by default, so without this the card grows wider
          than the phone instead of the line wrapping. Both are inert at a
          width where the line already fits.
        */}
        <div className="flex min-w-0 flex-col gap-0.5">
          <DeviceAlias deviceId={device.id} name={device.name}
                       isDefault={isDefaultDeviceName(device.name, device.macAddress)} />
          <span className="break-words font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
            {[device.macAddress,
              device.rssi !== null && `${device.rssi} dBm`].filter(Boolean).join(' · ')}
          </span>
          {/*
            Its own line rather than joined into the identity string above:
            the firmware state is now a sentence rather than a token, and it
            is the one thing on this card a human acts on.
          */}
          <span className="break-words font-mono text-[11px]"
                style={{ color: firmware.kind === 'behind' ? 'var(--amber-text)' : 'var(--muted)' }}
                data-testid={`device-firmware-${device.id}`}>
            {firmwareLabel(firmware)}
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
