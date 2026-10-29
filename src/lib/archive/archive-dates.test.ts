// src/lib/archive/archive-dates.test.ts
// Expected instants come from the fixtures' own headers (made by /opt/homebrew/bin/lha and the system zip at
// 16:47:48 local time, UTC+2): a DOS stamp says 16:47:48 with no zone (R10: read as that wall clock), a Unix stamp
// (LHA ext 0x54, LHA level 2, zip "UT") says 14:47:48Z and wins.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLha } from './lha';
import { readZip } from './zip';
import { dosDateTime } from './dos-date';
import { expandArchive } from './index';

const read = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', n)));
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

describe('dosDateTime', () => {
  it('reads date and time as a wall clock, and refuses a zero date', () => {
    expect(iso(dosDateTime((((2026 - 1980) << 9 | 9 << 5 | 11) << 16) | (16 << 11 | 47 << 5 | 24)))).toBe('2026-09-11T16:47:48.000Z');
    expect(dosDateTime(0)).toBeNull();
  });
});

describe('LHA dates (comments are dropped on purpose, see lha.ts)', () => {
  it('level 0 has only the DOS stamp', () => {
    expect(readLha(read('h0.lha')).entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T16:47:48.000Z'));
  });
  it('level 1 prefers its Unix-time extension (0x54); level 2 its Unix header time', () => {
    expect(readLha(read('h1.lha')).entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T14:47:48.000Z'));
    expect(readLha(read('h2.lha')).entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T14:47:48.000Z'));
    expect(iso(readLha(read('lh1.lzh')).entries[0].date)).toBe('2026-10-18T20:46:53.000Z');
  });
});

describe('zip dates and Amiga bits', () => {
  it('prefers the UT extra field', async () => {
    const { entries } = await readZip(read('t.zip'));
    expect(entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T14:47:48.000Z'));
    expect(entries.every((e) => e.protection === null)).toBe(true);   // made on Unix
  });
  it('falls back to the DOS stamp without UT, and reads protection from an Amiga-made member', async () => {
    const buf = read('t.zip').slice();
    // Every central-directory record: hide the UT extra (0x5455 → 0xffff) and say "made by Amiga" with bits 0x05.
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 1 && buf[i + 3] === 2) {
        const nameLen = buf[i + 28] | (buf[i + 29] << 8);
        const extra = i + 46 + nameLen;
        if (buf[extra] === 0x55 && buf[extra + 1] === 0x54) { buf[extra] = 0xff; buf[extra + 1] = 0xff; }
        buf[i + 5] = 1;                                   // version made by: host 1 = Amiga
        buf[i + 38] = 0; buf[i + 39] = 0; buf[i + 40] = 0x05; buf[i + 41] = 0;   // external attrs = 0x00050000
      }
    }
    const { entries } = await readZip(buf);
    expect(entries.map((e) => iso(e.date))).toEqual(Array(4).fill('2026-09-11T16:47:48.000Z'));
    expect(entries.map((e) => e.protection)).toEqual([5, 5, 5, 5]);
  });
  it('expandArchive passes date and comment through', async () => {
    const r = await expandArchive('t.zip', read('t.zip'));
    expect(r && 'members' in r && r.members[0]).toMatchObject({ date: expect.any(Date), comment: null });
  });
});
