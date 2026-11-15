/**
 * Wi-Fi networks from the web app (operator ruling 2026-11-15): Board settings lists the board's saved networks,
 * removes one, and asks the board to open its setup page while it stays online, so a network can be added there.
 *
 * The wire is the firmware's (wifi-floppy/firmware/src/wifi_ctl.h):
 *  - board -> server: the status report's `wifi` tail -- {nets: hex names, cur, ack, res, setup}; never a password.
 *    It rides only when it changed (and is left out of a report too full for it), so its absence alone says nothing.
 *  - server -> board: a CURSOR. devices.wifi_seq moves on every request; the poll carries {v: seq} to a board that
 *    sends ?wifiAck= and wakes while they differ; the board then fetches GET /api/device/wifi (deliverWifi), handles
 *    the seq once, and acks it. A withdrawal (cancel) is the next seq with op 'none'.
 *
 * No database import: the board settings section (a client component) uses these. The store is
 * wifi-networks-store.ts.
 */
import { SETUP_ADDRESS, SETUP_PASSWORD } from '@/lib/pairing-guide';

export type WifiOp = 'none' | 'open' | 'close' | 'remove';
export type WifiAction = 'open' | 'close' | 'remove' | 'cancel';
export type WifiResult =
  'ok' | 'none' | 'unknown' | 'disk' | 'only_one' | 'in_use' | 'not_saved' | 'write_failed' | 'subnet';

/** A name as the board sends it: 1-32 octets, lowercase hex, no NUL octet. */
export const WIFI_HEX_RE = /^(?:(?!00)[0-9a-f]{2}){1,32}$/;
export const WIFI_NETS_MAX = 4;
/** An open that waited longer than this for the board (offline, say) goes out as 'none': a board coming back an
 *  hour later must not raise a setup network nobody is waiting for. */
export const WIFI_OPEN_TTL_MS = 2 * 60 * 1000;
/** How long the board keeps the setup page open (WIFI_SETUP_MS in wifi_ctl.h). */
export const WIFI_SETUP_MINUTES = 10;

export function isWifiOp(v: string | null): v is WifiOp {
  return v === 'none' || v === 'open' || v === 'close' || v === 'remove';
}

const RESULTS: readonly WifiResult[] = ['ok', 'none', 'unknown', 'disk', 'only_one', 'in_use', 'not_saved', 'write_failed', 'subnet'];
export function asWifiResult(v: string | null): WifiResult | null {
  return v !== null && (RESULTS as readonly string[]).includes(v) ? v as WifiResult : null;
}

/** A name's octets as text: UTF-8 where it is, U+FFFD where it is not; control characters shown as U+FFFD too. */
export function wifiName(hex: string): string {
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/[\u0000-\u001f\u007f]/g, '�');
}

/** A name typed or shown, as the board's hex (UTF-8). */
export function wifiHex(name: string): string {
  return Array.from(new TextEncoder().encode(name), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The board's setup network, named as the firmware names it: the last two octets of the MAC, uppercase. */
export function setupNetworkFor(mac: string | null): string | null {
  const m = mac?.match(/^[0-9a-f]{2}(?::[0-9a-f]{2}){3}:([0-9a-f]{2}):([0-9a-f]{2})$/i);
  return m ? `wifi-floppy-${m[1].toUpperCase()}${m[2].toUpperCase()}` : null;
}

export interface WifiRow {
  wifiSeq: number;
  wifiOp: string;
  wifiOpSsid: string | null;
  wifiOpAt: Date | null;
  wifiAck: number | null;
}

/**
 * GET /api/device/wifi's body. The seq is always the current one; the op is 'none' when the board already reported
 * handling it (a board that restarted acks from 0 and must not do it twice) or for an open that waited past
 * WIFI_OPEN_TTL_MS. At most 105 bytes: the board reads it into 128 (main.c).
 */
export function deliverWifi(row: WifiRow, now: number): { seq: number; op: WifiOp; ssid?: string } {
  const op = isWifiOp(row.wifiOp) ? row.wifiOp : 'none';
  if (row.wifiAck === row.wifiSeq || op === 'none') return { seq: row.wifiSeq, op: 'none' };
  if (op === 'open' && (!row.wifiOpAt || now - row.wifiOpAt.getTime() > WIFI_OPEN_TTL_MS)) {
    return { seq: row.wifiSeq, op: 'none' };
  }
  if (op === 'remove') {
    return row.wifiOpSsid && WIFI_HEX_RE.test(row.wifiOpSsid)
      ? { seq: row.wifiSeq, op, ssid: row.wifiOpSsid }
      : { seq: row.wifiSeq, op: 'none' };
  }
  return { seq: row.wifiSeq, op };
}

// ---------------------------------------------------------------- what the section says

export interface WifiDevice {
  firmwareVersion: string | null;
  macAddress: string | null;
  mountedSha256: string | null;
  wifiNets: string[] | null;
  wifiCurrent: number | null;
  wifiSetupUntil: Date | null;
  wifiSeq: number;
  wifiOp: string;
  wifiOpSsid: string | null;
  wifiAck: number | null;
  wifiResult: string | null;
}

export type WifiSection =
  | { kind: 'unknown' }            // the board has not said which firmware it runs
  | { kind: 'old_firmware' }       // this firmware does not report its networks
  | {
      kind: 'ready';
      nets: { hex: string; name: string; current: boolean; removable: boolean }[];
      current: string | null;
      /** The setup page as the board last reported it: open until, or closed (null). Only while online. */
      setupUntil: Date | null;
      /** A request the board has not handled yet. */
      pending: WifiOp | null;
      /** Why Add a network cannot be pressed now; null when it can. */
      addBlocked: string | null;
      /** Why Remove cannot be pressed now; null when it can (a row's own reason is in the list). */
      removeBlocked: string | null;
      /** The last request's outcome, in words; null when there is nothing to say. */
      outcome: { ok: boolean; text: string } | null;
      setupNetwork: string;
    };

export const DISK_IN_DRIVE = 'Eject the disk first: the board doesn’t change its saved networks while a disk is in the drive.';
export const BOARD_OFFLINE = 'The board is offline.';
export const FULL = `The board holds ${WIFI_NETS_MAX} networks. Remove one to add another.`;

const q = (name: string) => `“${name}”`;

/** The words for what the board did with the last request (ack === seq), or null. */
export function wifiOutcome(op: WifiOp, ssidName: string | null, result: WifiResult | null): { ok: boolean; text: string } | null {
  if (result === null) return null;
  const name = ssidName ? q(ssidName) : 'the network';
  if (op === 'remove') {
    switch (result) {
      case 'ok': return { ok: true, text: `Removed ${name}.` };
      case 'not_saved': return { ok: true, text: `${name} was already gone from the board.` };
      case 'disk': return { ok: false, text: `Could not remove ${name}: a disk is in the drive, and the board doesn’t change its saved networks while one is. Eject it, then try again.` };
      case 'only_one': return { ok: false, text: `Could not remove ${name}: it is the only saved network. Add another first.` };
      case 'in_use': return { ok: false, text: `Could not remove ${name}: the board is on it now.` };
      case 'write_failed': return { ok: false, text: `Could not remove ${name}: the board could not save the change. Try again.` };
      case 'none': return { ok: true, text: 'Cancelled.' };
      default: return { ok: false, text: 'The board did not understand the request. Update its firmware.' };
    }
  }
  if (op === 'open') {
    switch (result) {
      case 'ok': return null;   // the open page speaks for itself
      case 'disk': return { ok: false, text: `The setup page did not open: a disk is in the drive. ${DISK_IN_DRIVE}` };
      case 'subnet': return { ok: false, text: 'The setup page did not open: your network uses 192.168.4.x addresses, the same as the board’s setup Wi-Fi. Add the network from the setup page at power-on instead (switch the board on away from your network).' };
      case 'none': return { ok: false, text: 'The board did not open its setup page in time (it may have been offline). Press Add a network again.' };
      default: return { ok: false, text: 'The board did not understand the request. Update its firmware.' };
    }
  }
  if (op === 'none' && result === 'none') return { ok: true, text: 'Cancelled.' };
  return null;
}

export function wifiSection(d: WifiDevice, online: boolean, now: number): WifiSection {
  if (d.wifiNets === null) return d.firmwareVersion === null ? { kind: 'unknown' } : { kind: 'old_firmware' };
  const nets = d.wifiNets.filter((h) => WIFI_HEX_RE.test(h));
  const cur = d.wifiCurrent !== null && d.wifiCurrent >= 0 && d.wifiCurrent < nets.length ? d.wifiCurrent : -1;
  const op: WifiOp = isWifiOp(d.wifiOp) ? d.wifiOp : 'none';
  const pending = d.wifiAck !== d.wifiSeq && d.wifiSeq > 0 ? op : null;
  const diskIn = d.mountedSha256 !== null;
  const setupUntil = online && d.wifiSetupUntil && d.wifiSetupUntil.getTime() > now ? d.wifiSetupUntil : null;
  const addBlocked = !online ? BOARD_OFFLINE
    : diskIn ? DISK_IN_DRIVE
    : nets.length >= WIFI_NETS_MAX ? FULL
    : null;
  const removeBlocked = diskIn ? DISK_IN_DRIVE : null;
  const outcome = pending === null && d.wifiAck === d.wifiSeq
    ? wifiOutcome(op, d.wifiOpSsid && WIFI_HEX_RE.test(d.wifiOpSsid) ? wifiName(d.wifiOpSsid) : null, asWifiResult(d.wifiResult))
    : null;
  return {
    kind: 'ready',
    nets: nets.map((hex, i) => ({ hex, name: wifiName(hex), current: i === cur, removable: i !== cur && nets.length > 1 })),
    current: cur >= 0 ? wifiName(nets[cur]) : null,
    setupUntil,
    pending,
    addBlocked,
    removeBlocked,
    outcome,
    setupNetwork: setupNetworkFor(d.macAddress) ?? 'wifi-floppy-…',
  };
}

/** The steps shown once the setup page is open. */
export function setupSteps(setupNetwork: string, current: string | null, until: string): string[] {
  return [
    `On your phone or computer, join the Wi-Fi network ${setupNetwork} (password ${SETUP_PASSWORD}).`,
    `The board’s setup page opens by itself. If it doesn’t, open ${SETUP_ADDRESS}.`,
    `Under Add a network, enter the network’s name and password and press Save. The board joins it to check it, so its setup Wi-Fi goes away for up to a minute; then it saves it and goes back to ${current ? q(current) : 'its network'}.`,
    `The setup page closes at ${until}, or when you press Done on it or Close setup page here.`,
  ];
}
