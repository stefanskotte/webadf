import type { PreviewState } from '@/lib/display-wasm';
import { DC_TITLE_MAX } from '@/lib/device-limits';
import { boardDiskLabel } from '@/lib/disk-label';
import { firmwareAtLeast } from '@/lib/firmware-version';

/**
 * The first firmware whose mounted line has no word "Disk": "3/13 Locale"
 * (nfc_ui_disk_line). Older firmware prints "Disk 3/13 Locale", and "Disk
 * 3/13 " -- its own trailing space -- with no name. A TEST build of 1.14.0
 * made before the change also says 1.14.0; it is drawn the new way.
 */
export const NO_DISK_WORD_FW = '1.14.0';

/**
 * What a board's OLED is showing, as far as the server knows, in the shape
 * display.wasm renders -- so the device card's bezel can draw the board's own
 * screen with the board's own code.
 *
 * Built from what the board last REPORTED (the mounted disk), never from what
 * was asked for: a board fetching a new disk is still showing the old one, and
 * the card says "Mounting…" in words for exactly that case. The strings follow
 * the firmware's ui_observe (wifi-floppy/firmware/src/main.c): the game title,
 * then "n/c label" on a set ("Disk n/c label" before NO_DISK_WORD_FW, chosen
 * by the board's reported version) -- or the label alone on a one-disk title --
 * and the label is the one mount.ts sends (disk-label.ts: the disk row's label,
 * else the uploaded file name, else nothing).
 *
 * Not drawn, because the server never hears them: download progress, the
 * track the head is on, an NFC tap's line. The track is left off rather than
 * shown as a made-up cylinder.
 */
export interface LiveDisplayFields {
  rssi: number | null;
  mountedSha256: string | null;
  mountedGame: string | null;
  mountedDiskNo: number | null;
  mountedLabel: string | null;
  /** The org's uploaded file name for the mounted bytes: the label's fallback. */
  mountedSourceFilename: string | null;
  mountedDiskCount: number | null;
  mountedWriteProtected: boolean | null;
  /** The reader as last reported; only a layout listing the 'nfc' element draws it. */
  nfcReader: 'present' | 'absent' | null;
  /** The board's reported version: which spelling of the mounted line it draws. */
  firmwareVersion: string | null;
}

/** The detail line as the board's firmware formats it (ui_observe). */
function mountedLine(diskNo: number, count: number, label: string, firmwareVersion: string | null): string {
  if (count <= 1) return label;
  if (!firmwareAtLeast(firmwareVersion, NO_DISK_WORD_FW)) return `Disk ${diskNo}/${count} ${label}`;
  return label ? `${diskNo}/${count} ${label}` : `${diskNo}/${count}`;
}

/** RSSI to arcs, the thresholds of the firmware's rssi_bars. Null: not associated. */
export function rssiBars(rssi: number | null): number {
  if (rssi === null || rssi === 0) return -1;
  if (rssi >= -60) return 3;
  if (rssi >= -70) return 2;
  if (rssi >= -80) return 1;
  return 0;
}

export function liveDisplayState(d: LiveDisplayFields, online: boolean, tick: number): PreviewState {
  const base: PreviewState = {
    status: 'ready', bars: online ? rssiBars(d.rssi) : -1, title: 'No disk', detail: '',
    showTrack: false, cyl: 0, maxCyl: 79, pct: -1, tick, writable: false,
    // An unreachable board's uploads are not reaching the server either.
    sync: online ? 'synced' : 'offline',
    // Present or absent as the board last said. Not 'armed': the server knows
    // a write was ASKED for, not whether the board has armed it yet.
    nfc: d.nfcReader === 'present' ? 'present' : 'absent',
  };
  if (d.mountedSha256 === null) return base;
  const diskNo = d.mountedDiskNo ?? 1;
  const count = d.mountedDiskCount ?? 1;
  const label = boardDiskLabel({ label: d.mountedLabel, sourceFilename: d.mountedSourceFilename });
  return {
    ...base,
    status: 'loaded',
    title: (d.mountedGame ?? 'Disk mounted').slice(0, DC_TITLE_MAX),
    detail: mountedLine(diskNo, count, label, d.firmwareVersion),
    writable: d.mountedWriteProtected === false,
  };
}

/** The same screen in words, for the canvas's accessible name. */
export function liveDisplayText(s: PreviewState): string {
  return s.detail ? `${s.title} — ${s.detail}` : s.title;
}
