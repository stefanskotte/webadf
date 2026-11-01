// NET: volumes (spec 2026-10-30): when a board can be browsed, and the pane's words for an error. Phase 2 (spec
// 2026-10-31 §4.1-4.2): when it can be written to, and the words for each refusal of a write. Pure, CLIENT-SAFE.
import { firmwareAtLeast } from '@/lib/firmware-version';
import { BROWSE_FW, BROWSE_PROTO, WRITE_FW, WRITE_PROTO } from './remote-limits';

const switchOn = (name: string) => `Switch on browsing in Transfer on ${name}`;
const oldWords = (name: string) => `Transfer 2.3 or newer is needed on ${name}`;
const notRunning = (name: string) => `Transfer is not running on ${name}`;
/** Spec 2026-10-31 §4.2: the reason line and the greyed write buttons' tooltip. */
export const WRITE_OFF = 'Writing is off in Transfer';
export const WRITE_OLD_TRANSFER = 'Transfer 2.5 or newer writes to the Amiga';
export const WRITE_OLD_FIRMWARE = 'Board firmware 1.23.0 or newer writes to the Amiga';
/** Spec 2026-10-31 §9: a Move that copies off a volume removes only what it copied, which needs Transfer 2.6 (protocol 5). */
export const MOVE_OLD_TRANSFER = 'Move needs Transfer 2.6 — use Copy';
/** Why a move kept a drawer when what it holds was not there at the copy (spec 2026-10-31 §9). */
export const KEPT_NEW = 'something new is in it';
/** Why, when nothing more is known than that the drawer still holds something the move did not copy. */
export const KEPT_UNKNOWN = 'something not copied is in it';
/**
 * What a move left in its source, and why (plan 2026-11-01-net-consistency, item 9): "Kept Work:Pack: a changed on the
 * Amiga", "… could not be removed", "… is empty and was not copied", "… something new is in it".
 */
export const keptWords = (label: string, why: string = KEPT_NEW) => `Kept ${label}: ${why}`;
export const isKeptWords = (s: string) => /^Kept .+: .+$/.test(s);
/** The why of keptWords' words (the text after the label), or null. */
export const keptWhyOf = (s: string, label: string) => (s.startsWith(`Kept ${label}: `) ? s.slice(`Kept ${label}: `.length) : null);
/** One name, or how many: "a", "3 files". */
export const oneOrMany = (names: string[], what = 'files') => (names.length === 1 ? names[0] : `${names.length} ${what}`);

export type BrowseInput = {
  online: boolean; firmware: string | null; rx: string | null; rxProto: number | null; browseOn: boolean; name: string; offlineWords: string;
};

/** Null when the board can be browsed, else the first missing thing in the pane's words. Protocol 3 or newer browses. */
export function browseBlock(b: BrowseInput): string | null {
  if (!b.online) return b.offlineWords;
  if (!firmwareAtLeast(b.firmware, BROWSE_FW)) return 'Firmware 1.22 or newer is needed';
  if (b.rx !== 'c') return notRunning(b.name);
  if ((b.rxProto ?? 0) < BROWSE_PROTO) return oldWords(b.name);
  if (!b.browseOn) return switchOn(b.name);
  return null;
}

/**
 * Null when the board's Amiga can be written to now (spec 2026-10-31 §4.2), else the first missing thing: what keeps it
 * from being read first (browseBlock), then the firmware, Transfer's protocol, and Transfer's writing switch.
 */
export function writeBlock(b: BrowseInput & { writeOn: boolean }): string | null {
  const read = browseBlock(b);
  if (read) return read;
  if (!firmwareAtLeast(b.firmware, WRITE_FW)) return WRITE_OLD_FIRMWARE;
  if ((b.rxProto ?? 0) < WRITE_PROTO) return WRITE_OLD_TRANSFER;
  if (!b.writeOn) return WRITE_OFF;
  return null;
}

/**
 * The NET: root row's mark (spec §5): "browsable", or the one missing thing in a few words. Null when the row already
 * says it: offline, or Transfer not running (`running`: the row's own "Transfer running" test, receiverRunning).
 */
export function browseMark(b: { online: boolean; firmware: string | null; running: boolean; rxProto: number | null; browseOn: boolean }): string | null {
  if (!b.online) return null;
  if (!firmwareAtLeast(b.firmware, BROWSE_FW)) return 'needs firmware 1.22';
  if (!b.running) return null;
  if ((b.rxProto ?? 0) < BROWSE_PROTO) return 'needs Transfer 2.3';
  if (!b.browseOn) return 'browsing off in Transfer';
  return 'browsable';
}

export function errorWords(code: string, text: string, board: string): string {
  switch (code) {
    case 'off': return switchOn(board);
    case 'old': return oldWords(board);
    case 'norx': return notRunning(board);
    case 'notfound': return 'Object not found';
    case 'timeout': return `${board} didn't answer — Refresh to try again`;
    default: return text || 'Failed';
  }
}

/** A refused write in the pane's words (spec 2026-10-31 §4.1); the read codes as errorWords says them. */
export function writeErrorWords(code: string, text: string, board: string): string {
  switch (code) {
    case 'wprot': return 'The disk is write-protected';
    case 'full': case 'space': return 'The disk is full';
    case 'denied': return 'Protected against deletion';
    case 'busy': return 'In use on the Amiga';
    case 'readonly': return WRITE_OFF;
    case 'exists': return 'Already exists';
    case 'xvol': return 'Rename works within one volume';
    case 'notempty': return 'The drawer is not empty';
    default: return errorWords(code, text, board);
  }
}
