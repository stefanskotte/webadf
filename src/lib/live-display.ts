import type { PreviewState } from '@/lib/display-wasm';
import { DC_LABEL_MAX, DC_TITLE_MAX } from '@/lib/device-limits';

/**
 * What a board's OLED is showing, as far as the server knows, in the shape
 * display.wasm renders -- so the device card's bezel can draw the board's own
 * screen with the board's own code.
 *
 * Built from what the board last REPORTED (the mounted disk), never from what
 * was asked for: a board fetching a new disk is still showing the old one, and
 * the card says "Mounting…" in words for exactly that case. The strings follow
 * the firmware's ui_observe (wifi-floppy/firmware/src/main.c): the game title,
 * then "Disk n/c label" -- or the label alone on a one-disk title -- and the
 * label is the one mount.ts sends (the disk row's, else "Disk n").
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
  mountedDiskCount: number | null;
  mountedWriteProtected: boolean | null;
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
  };
  if (d.mountedSha256 === null) return base;
  const diskNo = d.mountedDiskNo ?? 1;
  const label = (d.mountedLabel ?? `Disk ${diskNo}`).slice(0, DC_LABEL_MAX);
  const count = d.mountedDiskCount ?? 1;
  return {
    ...base,
    status: 'loaded',
    title: (d.mountedGame ?? 'Disk mounted').slice(0, DC_TITLE_MAX),
    detail: count > 1 ? `Disk ${diskNo}/${count} ${label}` : label,
    writable: d.mountedWriteProtected === false,
  };
}

/** The same screen in words, for the canvas's accessible name. */
export function liveDisplayText(s: PreviewState): string {
  return s.detail ? `${s.title} — ${s.detail}` : s.title;
}
