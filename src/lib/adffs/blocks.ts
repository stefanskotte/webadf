// Raw block access for the AmigaDOS filesystem reader. The ONLY file here
// that does arithmetic on byte offsets; everything above it works in terms
// of whole blocks and decoded fields.
//
// Reference: http://lclevy.free.fr/adflib/adf_info.html

import { BLOCK_BYTES, BLOCK_COUNT } from './constants';

/**
 * The 512 bytes of one block, or null when that block cannot be read.
 *
 * Null rather than a throw, and null rather than a zero-filled block: this is
 * the single choke point for spec section 5's bounds guard. Every block
 * pointer in an ADF is attacker-controlled, so every read goes through here
 * and every caller handles null. A zero-filled fallback would look like a
 * valid empty block and silently corrupt a traversal.
 */
export function blockAt(adf: Uint8Array, block: number): Uint8Array | null {
  if (!Number.isInteger(block) || block < 0 || block >= BLOCK_COUNT) return null;
  const start = block * BLOCK_BYTES;
  if (start + BLOCK_BYTES > adf.length) return null;
  return adf.subarray(start, start + BLOCK_BYTES);
}

/** Unsigned big-endian 32-bit read. AmigaDOS is big-endian throughout. */
export function be32(block: Uint8Array, offset: number): number {
  return (
    (block[offset] << 24)
    | (block[offset + 1] << 16)
    | (block[offset + 2] << 8)
    | block[offset + 3]
  ) >>> 0;
}

/**
 * Signed big-endian 32-bit read.
 *
 * Needed because ST_FILE is -3, stored as 0xfffffffd. Comparing the unsigned
 * form against -3 matches nothing and every file silently disappears from
 * the listing -- a failure that looks like an empty disk, not like a bug.
 */
export function i32(block: Uint8Array, offset: number): number {
  return be32(block, offset) | 0;
}

/**
 * The AmigaDOS block checksum: the negated sum of the block's 128 big-endian
 * words, with the checksum's own word excluded.
 */
export function blockChecksum(block: Uint8Array, skipWord: number): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_BYTES / 4; i++) {
    if (i === skipWord) continue;
    sum = (sum + be32(block, i * 4)) >>> 0;
  }
  return (-sum) >>> 0;
}

export function checksumOk(block: Uint8Array, skipWord: number): boolean {
  return be32(block, skipWord * 4) === blockChecksum(block, skipWord);
}

/**
 * A BCPL string: one length byte followed by that many characters.
 *
 * The length byte is attacker-controlled, so it is clamped to `max` and to
 * what the block can hold. Control characters are replaced rather than
 * carried: these names reach both the DOM and a Content-Disposition header
 * (spec section 5 guard 6). Decoded as latin-1, which is what AmigaDOS used.
 */
export function bcplString(block: Uint8Array, lengthOffset: number, max: number): string {
  const declared = block[lengthOffset] ?? 0;
  const room = Math.max(0, Math.min(max, block.length - lengthOffset - 1));
  const len = Math.min(declared, room);
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = block[lengthOffset + 1 + i];
    out += c >= 0x20 && c !== 0x7f ? String.fromCharCode(c) : '_';
  }
  return out;
}

/** 1978-01-01T00:00:00Z, the AmigaDOS epoch. */
const AMIGA_EPOCH_MS = Date.UTC(1978, 0, 1);
/** A tick is 1/50 s. */
const TICK_MS = 20;
/** Roughly year 2100. Anything beyond is a corrupt field, not a date. */
const MAX_DAYS = 45_000;

/**
 * A three-word AmigaDOS date: days, minutes and ticks since 1978-01-01.
 *
 * Returns null for an unset (all-zero) date AND for an out-of-range one. A
 * crafted day count would otherwise produce an Invalid Date that throws only
 * later, at the point something formats it.
 */
export function amigaDate(block: Uint8Array, offset: number): Date | null {
  const days = be32(block, offset);
  const mins = be32(block, offset + 4);
  const ticks = be32(block, offset + 8);
  if (days === 0 && mins === 0 && ticks === 0) return null;
  if (days > MAX_DAYS || mins >= 1440 || ticks >= 3000) return null;
  return new Date(AMIGA_EPOCH_MS + days * 86_400_000 + mins * 60_000 + ticks * TICK_MS);
}
