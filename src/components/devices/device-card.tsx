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
    // stale: NOT "device last seen ..." any more (fix round 1, minor 2) --
    // every offline card now carries its own "last seen" line up in the
    // badge row (isOnline and 'stale' share the same STALE_AFTER_MS
    // threshold, so a stale device is always offline), and repeating the
    // same fact here just cluttered the sub-line. The disk number is the
    // one piece of information that line alone still carries.
    : `disk ${device.desiredDiskNo ?? '?'}`;

  // While a mount or eject is still in flight (state === 'pending'), the
  // MOUNTED disk is the OLD one -- bigText above is already showing the NEW
  // disk's title (what's being mounted) or, while ejecting, the disk on its
  // way out. Either way, tagging that title with the OLD disk's write-protect
  // would describe the wrong disk, so the tag reads "--" until convergence
  // (fix round 1, controller ruling).
  const protection: 'protected' | 'writable' | 'none' =
    state === 'pending' ? 'none'
    : device.mountedWriteProtected === true ? 'protected'
    : device.mountedWriteProtected === false ? 'writable'
    : 'none';

  return (
    <div className="glass-card flex aspect-square flex-col gap-2 p-5" data-testid={`device-${device.id}`}
         data-state={state}>
      {/*
        TOP: identity. Below `lg` this is a NARROW card (two per row on a
        phone -- 173px measured at 390px, 133px once p-5 is subtracted), and
        the badge sharing a row with the name plus DeviceAlias's own
        Name/Rename control left the name 0-2px wide there (fix round 1,
        critical 1). Below `lg` the badge drops to its own line UNDER the
        name, so the name gets the full row to itself minus only the Rename
        control; at `lg` and up the card is wide enough that the badge goes
        back to sharing the name's row.
      */}
      <div className="flex flex-col gap-1 lg:flex-row lg:items-start lg:justify-between lg:gap-2">
        <div className="min-w-0 lg:flex-1">
          <DeviceAlias deviceId={device.id} name={device.name}
                       isDefault={isDefaultDeviceName(device.name, device.macAddress)} />
        </div>
        {/*
          Both values of "is this device online" are rendered as a badge --
          never an absent icon standing in for one of them. Offline additionally
          gets its own "last seen" line right below, so the badge is not the
          only thing telling a person how stale the card in front of them is.
          `self-start` stops it stretching to the row's full width in the
          column layout below `lg`.
        */}
        <span className="inline-flex w-fit shrink-0 items-center gap-1 self-start rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
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

      <div className="flex w-full min-w-0 flex-col items-start gap-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: state === 'stale' ? 'var(--amber-text)' : 'var(--muted)' }}>
          {heading}
        </span>
        {/*
          A disk's title is often a filename-derived string with no spaces
          (fix round 1, minor 1) -- overflow-wrap: anywhere lets it break
          instead of stretching the card (and the grid row) past its column.
        */}
        <span className="w-full text-[17px] font-bold leading-tight"
              style={{ overflowWrap: 'anywhere', color: state === 'empty' ? 'var(--muted)' : 'var(--ink)' }}>
          {bigText}
        </span>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{subText}</span>
      </div>

      <div className="flex-1" />

      {/* BOTTOM: write protection, firmware, and every existing action. */}
      <div className="flex flex-col gap-2">
        <span className="w-fit shrink-0 self-start rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
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
          Its OWN full-width row rather than sharing one with the tag above
          (fix round 1, critical 2): a flex item next to a shrink-0 sibling
          with no min-w-0 cannot shrink below its content's intrinsic width,
          and a real version string like "1.1.4+g137a4db" or a failure
          reason containing a URL has no natural break point -- that pushed
          the whole PAGE into horizontal scroll at 390px. min-w-0 plus
          overflow-wrap: anywhere (the update bar's break-all is the same
          escape hatch for the same shape of content) lets it wrap instead.
        */}
        <span className="block min-w-0 w-full font-mono text-[11px]"
              style={{
                overflowWrap: 'anywhere',
                color: update || firmware.kind === 'behind'
                  ? 'var(--amber-text)' : 'var(--muted)',
              }}
              data-testid={`device-firmware-${device.id}`}>
          {update ?? firmwareLabel(firmware)}
        </span>

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
        // overflowWrap: same reasoning as the firmware line above (fix round
        // 1, critical 2) -- a device-reported error can be URL-shaped with no
        // natural break point, which overflowed the card by 238px and gave
        // the whole page horizontal scroll at 390px (re-review finding).
        <div className="min-w-0 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: 'var(--input-bg)', color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
             data-testid={`device-error-${device.id}`}>
          {device.lastError}
        </div>
      )}
    </div>
  );
}
