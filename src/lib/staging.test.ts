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
});

describe('stageDrop', () => {
  it('flags a collision with an existing entry', () => {
    const staged = stageDrop(
      [{ path: 'README', kind: 'file', sizeBytes: 10 }],
      new Map([['', ['readme']]]), // case-insensitive: readme === README
    );
    expect(staged[0].collidesWith).toBe('existing');
  });

  it('flags two dropped files that collide with EACH OTHER after shortening', () => {
    const staged = stageDrop([
      { path: 'AnAbsurdlyLongFileNameIndeedYes1.txt', kind: 'file', sizeBytes: 1 },
      { path: 'AnAbsurdlyLongFileNameIndeedYes2.txt', kind: 'file', sizeBytes: 1 },
    ], new Map());
    // Both shorten into the same 30 characters, which no per-row check against
    // the DISK would ever notice.
    expect(staged[1].collidesWith).toBe('staged');
  });

  it('does not flag the same name in different directories', () => {
    const staged = stageDrop([
      { path: 'C', kind: 'dir', sizeBytes: 0 },
      { path: 'C/README', kind: 'file', sizeBytes: 1 },
      { path: 'README', kind: 'file', sizeBytes: 1 },
    ], new Map());
    expect(staged.filter((e) => e.collidesWith !== null)).toHaveLength(0);
  });
});
