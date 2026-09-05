import { describe, expect, it } from 'vitest';
import {
  shortenName, stageDrop, joinDestination, existingCollisionAt, type ExistingEntry,
} from './staging';

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
      // case-insensitive: readme === README
      new Map([['', [{ name: 'readme', kind: 'file' }]]]),
      false,
    );
    expect(staged[0].collidesWith).toBe('existing');
    expect(staged[0].existingKind).toBe('file');
  });

  it('carries the existing entry\'s kind, not the dropped one\'s, so a caller can tell "replace" is unsound', () => {
    // Fix round 1, Finding 2: a dropped FILE colliding with an existing
    // DIRECTORY of the same name must be reported as a collision whose
    // existingKind is 'dir' -- replaceFile requires ST_FILE, so a caller
    // that only checked collidesWith === 'existing' (and the DROPPED
    // entry's own kind, which is 'file' here) would wrongly offer replace
    // for a target that can never accept one.
    const staged = stageDrop(
      [{ path: 'C', kind: 'file', sizeBytes: 10 }],
      new Map([['', [{ name: 'C', kind: 'dir' }]]]),
      false,
    );
    expect(staged[0].collidesWith).toBe('existing');
    expect(staged[0].existingKind).toBe('dir');
    // The field a caller checks before offering replace: kind must match on
    // BOTH sides, dropped and existing.
    expect(staged[0].kind === 'file' && staged[0].existingKind === 'file').toBe(false);
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

  it('masks a name above Latin-1 down to the byte putName actually writes, and marks the row', () => {
    // 'Ω' is U+03A9 (0x3A9). putName (write-blocks.ts) stores
    // `charCodeAt(i) & 0xff`, so the byte actually written is 0xA9 -- '©'.
    // Without this fix the staged `name` would still read "Ω.txt", lying
    // about what's on the disk.
    const staged = stageDrop(
      [{ path: 'Ω.txt', kind: 'file', sizeBytes: 1 }],
      new Map(),
      false,
    );
    expect(staged[0].name).toBe('©.txt'); // '©.txt'
    expect(staged[0].name).not.toBe('Ω.txt');
    // Reuses the SAME flag an over-long name gets -- this is "corrected
    // visibly in the editable field" too, not a second kind of marker.
    expect(staged[0].shortened).toBe(true);
  });

  it('flags two names that mask into the SAME byte-identical name as colliding', () => {
    // 'Ω' (U+03A9) and '©' (U+00A9) both mask to the byte 0xA9: `putName`
    // would write byte-for-byte identical stored names for two dropped
    // items that look completely different pre-mask -- a collision no
    // per-row check against the unmasked names would ever catch.
    const staged = stageDrop([
      { path: 'Ω.txt', kind: 'file', sizeBytes: 1 },
      { path: '©.txt', kind: 'file', sizeBytes: 1 },
    ], new Map(), false);
    expect(staged[0].name).toBe(staged[1].name);
    expect(staged[1].collidesWith).toBe('staged');
  });

  it('substitutes a masked byte that lands on "/", the path separator, and marks the row', () => {
    // 'į' is U+012F (0x12F); masked per `putName`'s rule that is
    // `0x12F & 0xff` = 0x2F = '/'. Unfixed, "į.txt" staged (and would have
    // been written) as "/.txt" -- a name with an embedded path separator,
    // which `diskPathFor` turns into the manifest path "/.txt", which the
    // batch route's `isPathSafe` refuses as an empty leading segment,
    // failing the ENTIRE batch over one character in one row.
    const staged = stageDrop(
      [{ path: 'į.txt', kind: 'file', sizeBytes: 1 }],
      new Map(),
      false,
    );
    expect(staged[0].name).not.toContain('/');
    expect(staged[0].name).toBe('_.txt');
    expect(staged[0].shortened).toBe(true);
  });

  it('substitutes a masked byte that lands on ":", the device separator, and marks the row', () => {
    // 'ĺ' is U+013A (0x13A); masked, `0x13A & 0xff` = 0x3A = ':'.
    const staged = stageDrop(
      [{ path: 'ĺ.txt', kind: 'file', sizeBytes: 1 }],
      new Map(),
      false,
    );
    expect(staged[0].name).not.toContain(':');
    expect(staged[0].name).toBe('_.txt');
    expect(staged[0].shortened).toBe(true);
  });
});

describe('joinDestination / existingCollisionAt (DropStaging\'s destination selector)', () => {
  it('joins onto the disk root when no destination is chosen', () => {
    expect(joinDestination('', '')).toBe('');
    expect(joinDestination('', 'Nested')).toBe('Nested');
  });

  it('joins a within-drop directory onto the chosen destination', () => {
    expect(joinDestination('Sub', '')).toBe('Sub');
    expect(joinDestination('Sub', 'Nested')).toBe('Sub/Nested');
  });

  it('evaluates the collision check against the CHOSEN destination\'s existing names, not the root\'s', () => {
    // THE ONE THAT MATTERS (the reviewer's own words): a disk with
    // DIFFERENT contents at the root and inside "Sub" -- "readme.txt" only
    // at the root, "readme.txt" ALSO inside "Sub" but with a different
    // kind (a directory there, not a file). If the destination selector's
    // collision check looked at the root while the write actually goes to
    // "Sub" (or vice-versa), the staging verdict shown to a person and
    // what the batch route would actually do could disagree.
    const existingNamesByDir = new Map<string, ExistingEntry[]>([
      ['', [{ name: 'readme.txt', kind: 'file' }]],
      ['Sub', [{ name: 'readme.txt', kind: 'dir' }]],
    ]);

    // Staged for the ROOT (no destination chosen): collides with the
    // root's own "readme.txt", a FILE.
    const atRoot = existingCollisionAt('readme.txt', '', '', existingNamesByDir, false);
    expect(atRoot).toEqual({ name: 'readme.txt', kind: 'file' });

    // The IDENTICAL row and name, staged for destination "Sub" instead:
    // must collide with Sub's own "readme.txt" -- a DIRECTORY -- not the
    // root's file. Getting this wrong would silently offer "Replace" (only
    // ever sound against a file) for a name that is really a directory at
    // the chosen destination.
    const atSub = existingCollisionAt('readme.txt', '', 'Sub', existingNamesByDir, false);
    expect(atSub).toEqual({ name: 'readme.txt', kind: 'dir' });
  });

  it('reports no collision at a destination that holds nothing by that name, even though the root does', () => {
    const existingNamesByDir = new Map<string, ExistingEntry[]>([
      ['', [{ name: 'unique.txt', kind: 'file' }]],
      ['Sub', []],
    ]);
    expect(existingCollisionAt('unique.txt', '', 'Sub', existingNamesByDir, false)).toBeNull();
  });
});
