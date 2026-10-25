import { firmwareCellText, signalCell, statusPill } from '@/lib/devices-look';
import { deviceState, isOnline, relative } from '@/lib/device-state';
import { firmwareLabel, updateLabel, type FirmwareState } from '@/lib/firmware-state';
import { isDefaultDeviceName } from '@/lib/device-name';
import { firmwareAtLeast } from '@/lib/firmware-version';
import { NET_PICK_FW } from '@/lib/paulanet-disk';
import type { DeviceListItem } from '@/lib/queries';
import type { NextInfo } from '@/lib/next-disk';
import { preloadText } from '@/lib/drive-chips';
import { describeLastBoot } from '@/lib/last-boot';
import { SecondDriveSetting } from './second-drive-setting';
import { BoardSettings } from './board-settings';
import { HelpTip } from '@/components/help/help-tip';
import { DeviceAlias } from './device-alias';
import { DriveFront } from './drive-front';
import { DriveBox } from './drive-box';
import { TransferBox } from './transfer-box';

/**
 * The Devices card (spec §2): the drive tile and the info column on top, then the offline strip, the drive box (DF0
 * in words, its protection switch and actions), the last error and stuck-start strips, a standalone Transfer box,
 * and the DF1 box. Board settings (Disk at startup, NFC reader, Delete device) is a button in the heading row that
 * opens a modal. The disk is always named in words in the drive box; the glass is a canvas.
 */
export function DeviceCard(
  { device, now, firmware, selection, onCancelUpdate, next, sendLine, transfer, uploadLine }: {
    device: DeviceListItem; now: number; firmware: FirmwareState;
    /** Absent when this board cannot be updated -- no checkbox is drawn at all. */
    selection?: { selected: boolean; onToggle: (id: string) => void };
    /** Absent when no update is pending. */
    onCancelUpdate?: (id: string) => void;
    /** The next-disk verdict (multi-disk plan R3), or null/absent when there is none. */
    next?: NextInfo | null;
    /** Send to Amiga's one line (spec §4), or null when nothing waits or happened lately. */
    sendLine?: string | null;
    /** Whether Transfer runs on the Amiga; null for a board that cannot take files. */
    transfer?: { running: boolean } | null;
    uploadLine?: { text: string; href: boolean } | null;
  },
) {
  const state = deviceState(device, now);
  const online = isOnline(device.lastSeenAt, now);
  // The boot trail (fw 1.18.2): only when the previous boot stopped where it should not have; null otherwise.
  const lastBoot = describeLastBoot(device.lastBoot);

  // An update in flight REPLACES the firmware line: there is no value in
  // telling someone watching a download that they are two releases behind.
  const update = updateLabel({
    state: device.firmwareUpdateState,
    mounted: device.mountedSha256 !== null,
    target: device.desiredFirmwareVersion,
    error: device.firmwareUpdateError,
  });

  // The preload line is about the disk in the drive, which only a converged board has. Not in Network mode before
  // fw 1.12.1: the spare slot held the driver disk then (plan 2026-10-12 ruling 19). From 1.12.1 the driver disk has
  // DF1's own slot and DF0's next disk preloads as in the other modes.
  const preload = next?.preload && state === 'converged'
    && (device.secondDriveReported !== 'net' || firmwareAtLeast(device.firmwareVersion, NET_PICK_FW))
    ? { text: preloadText(next.diskNo, next.preload), kind: next.preload }
    : null;

  const pill = statusPill(online);
  const signal = signalCell(device.rssi, online);
  // The board reports Network (and can take the setting): its Transfer box sits in the DF1 box's Network panel.
  const inNetwork = device.secondDriveReported === 'net' && device.secondDriveCapable;
  const behind = update !== null || firmware.kind === 'behind';

  return (
    <article id={`device-${device.id}`} aria-label={device.name}
             className="glass-card flex scroll-mt-24 flex-col overflow-hidden"
             style={{ borderRadius: 20, boxShadow: '0 24px 48px -28px rgb(36 33 27 / .35)' }}
             data-testid={`device-${device.id}`}
             data-state={state}>
      {/* TOP ROW: the drive tile and the info column. A column below md. */}
      <div className="flex flex-col gap-5 px-5 pb-6 pt-6 sm:px-7 sm:pt-7 md:flex-row md:items-center md:gap-8">
        <DriveFront device={device} online={online} />
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <div className="min-w-0 max-w-full">
              <DeviceAlias deviceId={device.id} name={device.name}
                           isDefault={isDefaultDeviceName(device.name, device.macAddress)} />
            </div>
            <span className="flex-1" />
            <BoardSettings device={device} />
            {/* Both values of "is this device online" are words in a pill, never an absent icon (Ruling 10). */}
            <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold"
                  style={{ background: pill.bg, color: pill.fg }}
                  data-testid={`device-status-${device.id}`}>
              <span className="size-2 rounded-full" style={{ background: pill.dot, boxShadow: `0 0 0 3px ${pill.halo}` }} />
              {pill.label}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-[12px]" style={{ color: 'var(--muted-2)' }}>Network</dt>
              <dd className="break-all font-mono text-[13px]" style={{ color: 'var(--ink)' }}>{device.macAddress ?? '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px]" style={{ color: 'var(--muted-2)' }}>Signal</dt>
              <dd className="flex items-center gap-1.5 font-mono text-[13px]" style={{ color: 'var(--ink)' }}
                  data-testid={`device-signal-${device.id}`}>
                <span className="flex items-end gap-[2px]" aria-hidden="true">
                  {[5, 8, 11].map((h, i) => (
                    <span key={h} style={{
                      width: 3, height: h, borderRadius: 1,
                      background: i < signal.lit ? 'var(--ink)' : 'var(--line-strong)',
                    }} />
                  ))}
                </span>
                {signal.text}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px]" style={{ color: 'var(--muted-2)' }}>Firmware</dt>
              <dd className="flex min-w-0 flex-col items-start gap-1">
                {/* min-w-0 plus overflow-wrap: anywhere -- a real version like "1.1.4+g137a4db" or a failure reason
                    holding a URL has no break point and pushed the page sideways at 390 px (fix round 1). */}
                <span className="flex w-full min-w-0 items-start gap-1">
                  <span className="block min-w-0 flex-1 font-mono text-[13px]"
                        style={{ overflowWrap: 'anywhere', color: behind ? 'var(--amber-text)' : 'var(--ink)' }}
                        data-testid={`device-firmware-${device.id}`}>
                    {firmwareCellText(update ?? firmwareLabel(firmware))}
                  </span>
                  <HelpTip topic="boards" className="-mt-1" />
                </span>
                {selection && (
                  <label className="flex items-center gap-2 font-sans text-[12px]" style={{ color: 'var(--muted)' }}>
                    <input type="checkbox" checked={selection.selected}
                           onChange={() => selection.onToggle(device.id)}
                           data-testid={`device-select-${device.id}`} />
                    Select for update
                  </label>
                )}
                {update && onCancelUpdate && (
                  <button type="button" onClick={() => onCancelUpdate(device.id)}
                          data-testid={`device-cancel-update-${device.id}`}
                          className="font-sans text-[12px] underline"
                          style={{ color: 'var(--muted)' }}>
                    Cancel update
                  </button>
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px]" style={{ color: 'var(--muted-2)' }}>Last seen</dt>
              <dd className="text-[13px]" style={{ color: 'var(--ink)' }} data-testid={`device-seen-${device.id}`}>
                {relative(device.lastSeenAt, now)}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Offline strip (spec §9.3): the card keeps every control, requests queue. Only offline cards carry
          device-last-seen. */}
      {!online && (
        <div className="mx-3 mb-3 rounded-[14px] px-4 py-3" style={{ background: 'var(--danger-bg)' }}
             data-testid={`device-offline-${device.id}`}>
          <p className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{device.name} is offline</p>
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            <span data-testid={`device-last-seen-${device.id}`}>
              {device.lastSeenAt === null ? 'It has not been seen yet.' : `It was last seen ${relative(device.lastSeenAt, now)}.`}
            </span>
            {' '}Mounts, ejects and settings you change now reach it when it reconnects. Check its power and Wi-Fi.
          </p>
        </div>
      )}

      <div className="mx-3 mb-3">
        <DriveBox device={device} state={state} next={next ?? null} preload={preload} />
      </div>

      {device.lastError && (
        // overflowWrap: a device-reported error can be URL-shaped with no natural break point, which once gave the
        // whole page horizontal scroll at 390px.
        <div className="mx-3 mb-3 min-w-0 rounded-[12px] px-3.5 py-2.5 text-[13px]"
             style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)', overflowWrap: 'anywhere' }}
             data-testid={`device-error-${device.id}`}>
          {device.lastError}
        </div>
      )}
      {lastBoot && (
        <div className="mx-3 mb-3 min-w-0 rounded-[12px] px-3.5 py-2.5 text-[13px]"
             style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)', overflowWrap: 'anywhere' }}
             data-testid={`device-last-boot-${device.id}`}>
          {lastBoot}
        </div>
      )}

      {/* A standalone Transfer box only when the board does not report Network: otherwise it sits in the DF1 box's
          Network panel (spec §2, §7). */}
      {!inNetwork && (sendLine || uploadLine) && (
        <TransferBox className="mx-3 mb-3" deviceId={device.id} transfer={transfer ?? null}
                     sendLine={sendLine ?? null} uploadLine={uploadLine ?? null} />
      )}

      <div className="mx-3 mb-3">
        <SecondDriveSetting device={device} next={next} now={now}
                            transfer={inNetwork ? transfer ?? null : null}
                            sendLine={inNetwork ? sendLine ?? null : null}
                            uploadLine={inNetwork ? uploadLine ?? null : null} />
      </div>
    </article>
  );
}
