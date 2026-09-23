import { deviceState, isOnline, relative } from '@/lib/device-state';
import { firmwareLabel, updateLabel, type FirmwareState } from '@/lib/firmware-state';
import { isDefaultDeviceName } from '@/lib/device-name';
import type { DeviceListItem } from '@/lib/queries';
import { EjectButton } from './eject-button';
import { DeviceAlias } from './device-alias';

/**
 * Layout A from the approved redesign (.superpowers/brainstorm/79975-1790191889):
 * name + online badge at the TOP, the mounted disk as the big text in the
 * MIDDLE, write-protect/firmware/actions along the BOTTOM. A square-ish card
 * (device-list.tsx puts it in an aspect-square grid cell) rather than the old
 * full-width row.
 */
export function DeviceCard(
  { device, now, firmware, selection, onCancelUpdate }: {
    device: DeviceListItem; now: number; firmware: FirmwareState;
    /** Absent when this board cannot be updated -- no checkbox is drawn at all. */
    selection?: { selected: boolean; onToggle: (id: string) => void };
    /** Absent when no update is pending. */
    onCancelUpdate?: (id: string) => void;
  },
) {
  const state = deviceState(device, now);
  const online = isOnline(device.lastSeenAt, now);

  // An update in flight REPLACES the firmware line: there is no value in
  // telling someone watching a download that they are two releases behind.
  const update = updateLabel({
    state: device.firmwareUpdateState,
    mounted: device.mountedSha256 !== null,
    target: device.desiredFirmwareVersion,
    error: device.firmwareUpdateError,
  });

  // A pending state means desired and actual differ. That is a MOUNT when a
  // disk is desired and an EJECT when none is -- same state, opposite words.
  // Heading "Mounting..." over detail "Ejecting" is the bug this branch avoids.
  const ejecting = state === 'pending' && device.desiredSha256 === null;

  const heading =
    state === 'empty' ? 'No disk'
    : state === 'converged' ? 'In the drive'
    : state === 'pending' ? (ejecting ? 'Ejecting…' : 'Mounting…')
    : 'Requested';

  // The heading says WHAT is happening; bigText says WHICH disk (the big
  // text option A calls for) and subText carries the rest -- split from one
  // `detail` string so the disk's own title can get its own visual weight.
  // Every fact the old single string carried is still here; only where it
  // sits moved. See the per-state case below for where each piece landed.
  const bigText =
    state === 'empty' ? 'No disk'
    : state === 'converged' ? (device.mountedGame ?? 'Unknown')
    : state === 'pending'
      ? (ejecting ? (device.mountedGame ?? 'a disk') : (device.desiredGame ?? 'Unknown'))
    : (device.desiredGame ?? 'Unknown'); // stale: what was requested, same as before

  const subText =
    state === 'empty' ? 'Mount one from the library'
    : state === 'converged'
      ? `disk ${device.mountedDiskNo ?? '?'}`
        // desiredDiskCount is a SQL count(*), so it is 0 -- never null --
        // when nothing is desired. Compare numerically, not by truthiness, so
        // the "0 means don't show it" intent doesn't read as a null-check.
        // (The `?? 0` is only to satisfy the nullable column type; the value
        // itself is never actually null.)
        + ((device.desiredDiskCount ?? 0) > 0 ? ` of ${device.desiredDiskCount}` : '')
    : state === 'pending'
      ? ejecting
        ? `Removing disk ${device.mountedDiskNo ?? '?'}`
        : `disk ${device.desiredDiskNo ?? '?'}`
          + (device.mountedSha256 ? ` · currently holding ${device.mountedGame ?? 'a disk'} disk ${device.mountedDiskNo ?? '?'}` : '')
    : `disk ${device.desiredDiskNo ?? '?'} · device last seen ${relative(device.lastSeenAt, now)}`; // stale

  const protection: 'protected' | 'writable' | 'none' =
    device.mountedWriteProtected === true ? 'protected'
    : device.mountedWriteProtected === false ? 'writable'
    : 'none';

  return (
    <div className="glass-card flex aspect-square flex-col gap-2 p-5" data-testid={`device-${device.id}`}
         data-state={state}>
      {/*
        TOP: identity. min-w-0 on the name column and shrink-0 on the badge --
        same reasoning file-wide as the MAC/RSSI line below -- a long name has
        to wrap or truncate before it pushes the badge off a card this narrow.
      */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <DeviceAlias deviceId={device.id} name={device.name}
                       isDefault={isDefaultDeviceName(device.name, device.macAddress)} />
        </div>
        {/*
          Both values of "is this device online" are rendered as a badge --
          never an absent icon standing in for one of them. Offline additionally
          gets its own "last seen" line right below, so the badge is not the
          only thing telling a person how stale the card in front of them is.
        */}
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{
                background: online ? 'var(--success-bg)' : 'var(--danger-bg)',
                color: online ? 'var(--success-fg)' : 'var(--danger-fg)',
              }}
              data-testid={`device-status-${device.id}`}>
          <span className="h-1.5 w-1.5 rounded-full"
                style={{ background: online ? 'var(--online-dot)' : 'var(--danger-fg)' }} />
          {online ? 'Online' : 'Offline'}
        </span>
      </div>
      <span className="break-words font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
        {[device.macAddress,
          device.rssi !== null && `${device.rssi} dBm`].filter(Boolean).join(' · ')}
      </span>
      {!online && (
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}
              data-testid={`device-last-seen-${device.id}`}>
          last seen {relative(device.lastSeenAt, now)}
        </span>
      )}

      {/* Spacers push the identity block up and the actions block down,
          leaving the disk in the middle -- literally, per the approved
          option A. Both collapse to nothing once the card's real content
          already fills it, which is how it grows taller instead of clipping
          when a long name or a long error needs the room (see the aspect-
          square note on the grid in device-list.tsx). */}
      <div className="flex-1" />

      <div className="flex flex-col items-start gap-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: state === 'stale' ? 'var(--amber-text)' : 'var(--muted)' }}>
          {heading}
        </span>
        <span className="text-[17px] font-bold leading-tight"
              style={{ color: state === 'empty' ? 'var(--muted)' : 'var(--ink)' }}>
          {bigText}
        </span>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{subText}</span>
      </div>

      <div className="flex-1" />

      {/* BOTTOM: write protection, firmware, and every existing action. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  borderColor: 'var(--hairline)',
                  color: protection === 'none' ? 'var(--muted)' : 'var(--ink)',
                  // Amber is FILL ONLY (globals.css: --accent-amber "fails AA
                  // as text") -- Writable gets an accent bar, never amber
                  // text, which is exactly what --amber-text exists to avoid.
                  boxShadow: protection === 'writable' ? 'inset 3px 0 0 var(--accent-amber)' : undefined,
                }}
                data-testid={`device-protection-${device.id}`}>
            {protection === 'protected' ? 'Protected' : protection === 'writable' ? 'Writable' : '—'}
          </span>
          {/*
            Its own element rather than joined into the identity string above:
            the firmware state is a sentence rather than a token, and it is
            the one thing on this card a human acts on.
          */}
          <span className="break-words text-right font-mono text-[11px]"
                style={{
                  color: update || firmware.kind === 'behind'
                    ? 'var(--amber-text)' : 'var(--muted)',
                }}
                data-testid={`device-firmware-${device.id}`}>
            {update ?? firmwareLabel(firmware)}
          </span>
        </div>

        {update && onCancelUpdate && (
          <button type="button" onClick={() => onCancelUpdate(device.id)}
                  data-testid={`device-cancel-update-${device.id}`}
                  className="self-start text-[11px] underline"
                  style={{ color: 'var(--muted)' }}>
            Cancel update
          </button>
        )}

        <div className="flex items-center justify-between gap-2">
          {selection ? (
            <label className="flex items-center gap-2 text-[11px]"
                   style={{ color: 'var(--muted)' }}>
              <input type="checkbox" checked={selection.selected}
                     onChange={() => selection.onToggle(device.id)}
                     data-testid={`device-select-${device.id}`} />
              Select for update
            </label>
          ) : <span />}
          {(device.desiredSha256 || device.mountedSha256) && <EjectButton deviceId={device.id} />}
        </div>
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
