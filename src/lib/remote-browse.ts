// NET: volumes (spec 2026-10-30): when a board can be browsed, and the pane's words for an error. Pure, CLIENT-SAFE.
import { firmwareAtLeast } from '@/lib/firmware-version';
import { BROWSE_FW, BROWSE_PROTO } from './remote-limits';

const switchOn = (name: string) => `Switch on browsing in Transfer on ${name}`;
const oldWords = (name: string) => `Transfer 2.3 or newer is needed on ${name}`;
const notRunning = (name: string) => `Transfer is not running on ${name}`;

/** Null when the board can be browsed, else the first missing thing in the pane's words. */
export function browseBlock(b: {
  online: boolean; firmware: string | null; rx: string | null; rxProto: number | null; browseOn: boolean; name: string; offlineWords: string;
}): string | null {
  if (!b.online) return b.offlineWords;
  if (!firmwareAtLeast(b.firmware, BROWSE_FW)) return 'Firmware 1.22 or newer is needed';
  if (b.rx !== 'c') return notRunning(b.name);
  if (b.rxProto !== BROWSE_PROTO) return oldWords(b.name);
  if (!b.browseOn) return switchOn(b.name);
  return null;
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
