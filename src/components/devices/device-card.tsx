import { driveBoxText, firmwareCellText, signalCell, statusPill } from '@/lib/devices-look';
import { deviceState, isOnline, relative } from '@/lib/device-state';
import { firmwareLabel, updateLabel, type FirmwareState } from '@/lib/firmware-state';
import { isDefaultDeviceName } from '@/lib/device-name';
import { firmwareAtLeast } from '@/lib/firmware-version';
import { NET_PICK_FW } from '@/lib/paulanet-disk';
import type { DeviceListItem } from '@/lib/queries';
import type { NextInfo } from '@/lib/next-disk';
import { preloadText } from '@/lib/drive-chips';
import { describeI2cScan } from '@/lib/i2c-scan';
import { describeLastBoot } from '@/lib/last-boot';
import { Link } from '@/components/shell/link';
import { SecondDriveReadings } from './second-drive-readings';
import { SecondDriveSetting } from './second-drive-setting';
import { BootDiskSetting } from './boot-disk-setting';
import { HelpTip } from '@/components/help/help-tip';
import { NextDiskButton } from './next-disk-button';
import { DeviceAlias } from './device-alias';
import { DriveFront } from './drive-front';
import { DeleteDeviceDialog } from './delete-device-dialog';
import { ReinsertButton } from './reinsert-button';

/**
 * The drive-bezel card (design A2, 2026-10-07): name, online badge and MAC on
 * TOP; then the front of the drive -- the board's own OLED, drawn by
 * display.wasm, its LEDs and eject -- with the Display drawer under it; then
 * write-protect, firmware and actions along the BOTTOM. The card is exactly
 * as tall as its content, growing when the drawer opens and shrinking when it
 * closes: it was square until 2026-10-08, which left an empty band between
 * the bezel and the bottom row (the operator asked for it to go).
 *
 * The disk is named in words only while the OLED cannot be trusted to name
 * it: a mount or eject in flight, or a request the board has not confirmed.
 * Once the board reports, its screen says which disk, and repeating it was
 * the duplicate this design removed. The words stay in the DOM (sr-only) for
 * screen readers either way.
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
    /** Whether Transfer runs on the Amiga; null for a board that cannot take files. Not drawn until Task 3. */
    transfer?: { running: boolean } | null;
    uploadLine?: { text: string; href: boolean } | null;
  },
) {
  const state = deviceState(device, now);
  const online = isOnline(device.lastSeenAt, now);
  // The boot I2C scan in words (fw 1.17.0+); null from older firmware, which keeps the card as it was. The version
  // decides whether a PN532 at 0x24 is a reader (1.18.0+) or a module that needs the update.
  // The boot trail (fw 1.18.2): only when the previous boot stopped where it should not have; null otherwise.
  const lastBoot = describeLastBoot(device.lastBoot);
  const i2c = describeI2cScan(device.nfcReader, device.i2cAddrs, device.firmwareVersion);

  // An update in flight REPLACES the firmware line: there is no value in
  // telling someone watching a download that they are two releases behind.
  const update = updateLabel({
    state: device.firmwareUpdateState,
    mounted: device.mountedSha256 !== null,
    target: device.desiredFirmwareVersion,
    error: device.firmwareUpdateError,
  });

  // The disk in words (heading, title, detail): the look rules live in devices-look.ts (spec §4.2).
  const { label: heading, title: bigText, meta: subText } = driveBoxText(device, state);

  // Words on screen only while the OLED shows something other than the disk
  // asked for: the old disk (pending, stale). Converged and empty: the glass
  // already says it.
  const spelled = state === 'pending' || state === 'stale';

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

  const pill = statusPill(online);
  const signal = signalCell(device.rssi, online);
  const behind = update !== null || firmware.kind === 'behind';

  return (
    <article id={`device-${device.id}`} aria-label={device.name}
             className="glass-card flex scroll-mt-24 flex-col overflow-hidden"
             style={{ borderRadius: 20, boxShadow: '0 24px 48px -28px rgb(36 33 27 / .35)' }}
             data-testid={`device-${device.id}`}
             data-state={state}>
      {/* TOP ROW: the drive tile's slot (Task 3 puts the tile here; today's bezel stays in the lower half) and the
          info column. A column below md. */}
      <div className="flex flex-col gap-5 px-5 pb-6 pt-6 sm:px-7 sm:pt-7 md:flex-row md:items-center md:gap-8">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <div className="min-w-0 max-w-full">
              <DeviceAlias deviceId={device.id} name={device.name}
                           isDefault={isDefaultDeviceName(device.name, device.macAddress)} />
            </div>
            <span className="flex-1" />
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
            <span data-testid={`device-last-seen-${device.id}`}>It was last seen {relative(device.lastSeenAt, now)}.</span>
            {' '}Mounts, ejects and settings you change now reach it when it reconnects. Check its power and Wi-Fi.
          </p>
        </div>
      )}

      {/* The lower half keeps today's pieces until Tasks 3-6 replace them. */}
      <div className="mx-3 mb-3 flex flex-col gap-2">
      <DriveFront device={device} online={online} />

      {/* The disk in words. Visible only while the OLED would name the wrong
          disk (see the doc comment); converged and empty keep it for screen
          readers, since the glass is a canvas. */}
      {/* Layout classes only when shown: `w-full` would override sr-only's 1px
          width and push the hidden block past the card (2px of page scroll at
          390px, mobile.spec.ts). */}
      <div className={spelled ? 'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border-2 border-dashed px-3 py-2' : 'sr-only'}
           style={spelled ? { borderColor: 'var(--primary-action)' } : undefined}
           data-testid={`device-disk-${device.id}`}>
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
              style={{ overflowWrap: 'anywhere', color: 'var(--ink)' }}>
          {bigText}
        </span>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{subText}</span>
      </div>
      {/* Converged and empty only: while an eject is still in flight the drive is not empty yet (A4). */}
      {state === 'empty' && device.lastDiskId && device.lastDiskTitle && (
        <ReinsertButton deviceId={device.id} diskId={device.lastDiskId} title={device.lastDiskTitle} diskNo={device.lastDiskNo} />
      )}
      {/* Gated like the Next button below: the line is about the disk in the
          drive, which only a converged board has. Not on the OLED, so it
          stays visible. */}
      {/* Not in Network mode before fw 1.12.1: the spare slot held the driver disk then (plan 2026-10-12 ruling 19).
          From 1.12.1 the driver disk has DF1's own slot and DF0's next disk preloads as in the other modes. */}
      {next?.preload && state === 'converged'
        && (device.secondDriveReported !== 'net' || firmwareAtLeast(device.firmwareVersion, NET_PICK_FW)) && (
        <span className="flex items-center gap-1">
          <span className="text-[11px]" style={{ color: 'var(--muted)' }} data-testid={`device-preload-${device.id}`}
                data-preload={next.preload}>
            {preloadText(next.diskNo, next.preload)}
          </span>
          <HelpTip topic="next-disk" />
        </span>
      )}

      {sendLine && (
        <Link href={`/ingest?board=${encodeURIComponent(device.id)}`} data-testid={`device-send-${device.id}`}
              className="w-fit text-[11px] font-semibold underline underline-offset-2" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
          {sendLine}
        </Link>
      )}
      {uploadLine && (uploadLine.href ? (
        <Link href={`/ingest?from=${encodeURIComponent(device.id)}#from-amiga`} data-testid={`device-upload-${device.id}`}
              className="w-fit text-[11px] font-semibold underline underline-offset-2" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
          {uploadLine.text}
        </Link>
      ) : (
        <span data-testid={`device-upload-${device.id}`} className="text-[11px]" style={{ color: 'var(--muted)' }}>{uploadLine.text}</span>
      ))}
      {/* BOTTOM: write protection, firmware, and every existing action. */}
      <div className="flex flex-col gap-2">
        <SecondDriveReadings device={device} />
        <SecondDriveSetting device={device} next={next} now={now} />
        <BootDiskSetting device={device} />
        {lastBoot && (
          <span className="text-[11px]" style={{ color: 'var(--warning-fg)', overflowWrap: 'anywhere' }}
                data-testid={`device-last-boot-${device.id}`}>
            {lastBoot}
          </span>
        )}
        {i2c && (
          <span className="flex min-w-0 items-start gap-1" data-testid={`device-nfc-${device.id}`} data-ok={i2c.ok}>
            <span className="flex min-w-0 flex-col text-[11px]" style={{ overflowWrap: 'anywhere' }}>
              <span style={{ color: 'var(--ink)' }}>{i2c.line}</span>
              {i2c.seen && <span style={{ color: 'var(--muted)' }} data-testid={`device-i2c-${device.id}`}>{i2c.seen}</span>}
            </span>
            <HelpTip topic="nfc" className="-mt-1" />
          </span>
        )}
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

        <div className="flex items-center justify-end gap-2">
          {next && state === 'converged' && <NextDiskButton deviceId={device.id} next={next} />}
          <DeleteDeviceDialog deviceId={device.id} name={device.name} />
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
    </article>
  );
}
