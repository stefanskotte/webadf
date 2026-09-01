import { describe, it, expect } from 'vitest';
import { BLOCK_BYTES, BLOCK_COUNT, CHECKSUM_WORD } from './constants';
import { blockAt, be32, i32, blockChecksum, checksumOk, bcplString, amigaDate } from './blocks';

const image = () => new Uint8Array(BLOCK_BYTES * BLOCK_COUNT);

function writeBe32(b: Uint8Array, off: number, v: number) {
  b[off] = (v >>> 24) & 0xff; b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff; b[off + 3] = v & 0xff;
}

describe('blockAt', () => {
  it('returns the 512 bytes of the requested block', () => {
    const adf = image();
    adf[880 * BLOCK_BYTES] = 0xab;
    expect(blockAt(adf, 880)!.length).toBe(BLOCK_BYTES);
    expect(blockAt(adf, 880)![0]).toBe(0xab);
  });

  it('returns null for a block past the end of the image', () => {
    // Spec section 5 guard 1. A crafted pointer must be ignored, never read.
    expect(blockAt(image(), BLOCK_COUNT)).toBeNull();
    expect(blockAt(image(), 99_999)).toBeNull();
  });

  it('returns null for a negative or non-integer block', () => {
    expect(blockAt(image(), -1)).toBeNull();
    expect(blockAt(image(), 1.5)).toBeNull();
  });

  it('returns null when the image is too short to hold that block', () => {
    // A truncated upload must not yield a short slice that later reads
    // walk off the end of.
    expect(blockAt(new Uint8Array(BLOCK_BYTES * 10), 20)).toBeNull();
  });
});

describe('be32 / i32', () => {
  it('reads big-endian, which is the only byte order AmigaDOS uses', () => {
    const b = new Uint8Array(BLOCK_BYTES);
    b.set([0x12, 0x34, 0x56, 0x78], 0);
    expect(be32(b, 0)).toBe(0x12345678);
  });

  it('be32 stays unsigned where i32 goes negative', () => {
    // Secondary type ST_FILE is -3, stored as 0xfffffffd. Reading it
    // unsigned and comparing against -3 silently matches nothing.
    const b = new Uint8Array(BLOCK_BYTES);
    b.set([0xff, 0xff, 0xff, 0xfd], 0);
    expect(be32(b, 0)).toBe(0xfffffffd);
    expect(i32(b, 0)).toBe(-3);
  });
});

describe('blockChecksum', () => {
  it('is the negated sum of all words except the checksum word', () => {
    const b = new Uint8Array(BLOCK_BYTES);
    writeBe32(b, 0, 2);
    writeBe32(b, 8, 5);
    const sum = (2 + 5) >>> 0;
    expect(blockChecksum(b, CHECKSUM_WORD)).toBe((-sum) >>> 0);
  });

  it('round-trips: storing the computed value makes the block verify', () => {
    const b = new Uint8Array(BLOCK_BYTES);
    writeBe32(b, 0, 2);
    writeBe32(b, 500, 0x1234);
    writeBe32(b, CHECKSUM_WORD * 4, blockChecksum(b, CHECKSUM_WORD));
    expect(checksumOk(b, CHECKSUM_WORD)).toBe(true);
  });

  it('fails when any byte changes', () => {
    const b = new Uint8Array(BLOCK_BYTES);
    writeBe32(b, CHECKSUM_WORD * 4, blockChecksum(b, CHECKSUM_WORD));
    b[100] ^= 0xff;
    expect(checksumOk(b, CHECKSUM_WORD)).toBe(false);
  });

  it('rejects the Project-X shape: a plausible block with a bogus checksum', () => {
    // Measured, spec section 3.3. All four Project-X disks store 0x31313131
    // -- ASCII "1111" -- where the checksum belongs. This is THE case that
    // makes the checksum non-optional.
    const b = new Uint8Array(BLOCK_BYTES);
    writeBe32(b, 0, 2);
    writeBe32(b, 508, 1);
    writeBe32(b, CHECKSUM_WORD * 4, 0x31313131);
    expect(checksumOk(b, CHECKSUM_WORD)).toBe(false);
  });
});

describe('bcplString', () => {
  it('reads a length-prefixed name', () => {
    const b = new Uint8Array(BLOCK_BYTES);
    b[432] = 4;
    b.set([0x57, 0x6f, 0x72, 0x6b], 433); // "Work"
    expect(bcplString(b, 432, 30)).toBe('Work');
  });

  it('clamps a length longer than the field allows', () => {
    // The length byte is attacker-controlled; 255 must not read past the
    // block or into the next field.
    const b = new Uint8Array(BLOCK_BYTES);
    b[432] = 255;
    b.fill(0x41, 433, 433 + 30);
    expect(bcplString(b, 432, 30)).toHaveLength(30);
  });

  it('strips control characters so a name cannot reach the DOM raw', () => {
    // Spec section 5 guard 6.
    const b = new Uint8Array(BLOCK_BYTES);
    b[432] = 5;
    b.set([0x41, 0x0a, 0x42, 0x00, 0x43], 433);
    expect(bcplString(b, 432, 30)).toBe('A_B_C');
  });

  it('returns an empty string for a zero length', () => {
    expect(bcplString(new Uint8Array(BLOCK_BYTES), 432, 30)).toBe('');
  });
});

describe('amigaDate', () => {
  it('decodes days/minutes/ticks since 1978-01-01 UTC', () => {
    const b = new Uint8Array(BLOCK_BYTES);
    writeBe32(b, 0, 1);    // 1 day
    writeBe32(b, 4, 2);    // 2 minutes
    writeBe32(b, 8, 50);   // 50 ticks = 1 second
    expect(amigaDate(b, 0)!.toISOString()).toBe('1978-01-02T00:02:01.000Z');
  });

  it('returns null for an all-zero (unset) date', () => {
    expect(amigaDate(new Uint8Array(BLOCK_BYTES), 0)).toBeNull();
  });

  it('returns null rather than an absurd date for a corrupt field', () => {
    // A crafted day count must not produce an Invalid Date that then throws
    // when something calls toISOString on it.
    const b = new Uint8Array(BLOCK_BYTES);
    writeBe32(b, 0, 0xffffffff);
    expect(amigaDate(b, 0)).toBeNull();
  });
});
