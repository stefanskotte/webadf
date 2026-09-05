import { describe, expect, it } from 'vitest';
import { shortenName, stageDrop } from './staging';

describe('shortenName', () => {
  it('keeps a short name and marks a long one shortened', () => {
    expect(shortenName('README')).toBe('README');
    const long = 'MyVeryLongDocumentFileName.txt'; // 30 exactly
    expect(shortenName(long)).toBe(long);
    const longer = `x${long}`; // 31
    expect(shortenName(longer)).toHaveLength(30);
  });

  it('keeps the extension when it shortens', () => {
    // A name AmigaDOS can hold is worth more than a prefix: "Startup-Seq.txt"
    // is usable, "MyVeryLongDocumentFileNameXX.t" is not.
    const out = shortenName('AnAbsurdlyLongFileNameIndeedYes.info');
    expect(out).toHaveLength(30);
    expect(out.endsWith('.info')).toBe(true);
  });

  it('falls back to plain truncation when the extension alone is 30+ characters', () => {
    // The extension itself is already at the cap, so trimming the stem to
    // fit alongside it would leave nothing -- fall back to a plain cut
    // instead of keeping an "extension" that is really the whole budget.
    const extension = `.${'a'.repeat(29)}`; // 30 characters, including the dot
    const name = `x${extension}`; // 31 characters total
    const out = shortenName(name);
    expect(out).toHaveLength(30);
    expect(out).toBe(name.slice(0, 30));
  });

  it('falls back to plain truncation when there is no dot at all', () => {
    const name = 'x'.repeat(40);
    const out = shortenName(name);
    expect(out).toHaveLength(30);
    expect(out).toBe('x'.repeat(30));
  });
});

describe('stageDrop', () => {
  it('flags a collision with an existing entry', () => {
    const staged = stageDrop(
      [{ path: 'README', kind: 'file', sizeBytes: 10 }],
      new Map([['', ['readme']]]), // case-insensitive: readme === README
      false,
    );
    expect(staged[0].collidesWith).toBe('existing');
  });

  it('flags two dropped files that collide with EACH OTHER after shortening', () => {
    const staged = stageDrop([
      { path: 'AnAbsurdlyLongFileNameIndeedYes1.txt', kind: 'file', sizeBytes: 1 },
      { path: 'AnAbsurdlyLongFileNameIndeedYes2.txt', kind: 'file', sizeBytes: 1 },
    ], new Map(), false);
    // Both shorten into the same 30 characters, which no per-row check against
    // the DISK would ever notice.
    expect(staged[1].collidesWith).toBe('staged');
  });

  it('does not flag the same name in different directories', () => {
    const staged = stageDrop([
      { path: 'C', kind: 'dir', sizeBytes: 0 },
      { path: 'C/README', kind: 'file', sizeBytes: 1 },
      { path: 'README', kind: 'file', sizeBytes: 1 },
    ], new Map(), false);
    expect(staged.filter((e) => e.collidesWith !== null)).toHaveLength(0);
  });

  it('folds extended Latin case only when staging for an INTL disk', () => {
    // hash.ts's INTL fold covers 0xe0-0xfe (excluding 0xf7, the division
    // sign) by subtracting 0x20, same as ASCII a-z. 0xe5 'å' therefore folds
    // to 0xc5 'Å' under INTL -- and 0xc5 itself is outside 0xe0-0xfe, so it
    // passes through unfolded on either side. Under the non-INTL fold,
    // neither byte moves, so the two stay distinct. Same length, differing
    // only in that one trailing character, so this is exactly the pair
    // `nameHash` and `sameName` treat differently depending on `intl`.
    const lower = 'Diskå'; // "Diskå"
    const upper = 'DiskÅ'; // "DiskÅ"
    const dropped = [
      { path: lower, kind: 'file' as const, sizeBytes: 1 },
      { path: upper, kind: 'file' as const, sizeBytes: 1 },
    ];

    const onIntlDisk = stageDrop(dropped, new Map(), true);
    expect(onIntlDisk[1].collidesWith).toBe('staged');

    const onPlainDisk = stageDrop(dropped, new Map(), false);
    expect(onPlainDisk[1].collidesWith).toBe(null);
  });
});
