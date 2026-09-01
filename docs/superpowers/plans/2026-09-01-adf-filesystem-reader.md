# ADF Filesystem Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the AmigaDOS OFS/FFS filesystem out of a stored ADF so a human can see what is on a disk and pull a single file out of it, without mounting anything.

**Architecture:** A new pure module `src/lib/adffs/`, shaped exactly like the existing `src/lib/adfmfm/`: pure functions over a `Uint8Array`, no I/O and no database, so the entire format is testable in vitest. Two surfaces sit on top — a server-rendered page that parses once and hands the whole tree to the client, and a route that streams one file. Nothing is persisted: `blobs` is content-addressed, so a parse is a pure function of the sha-256 and the HTTP response can be `immutable`.

**Tech Stack:** Next.js 16.3.2 (App Router, Server Components) · React 19.2 · Tailwind 4 · shadcn v4 (**Base UI, not Radix**) · Drizzle 0.45 · Postgres (Neon HTTP) · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-09-01-adf-filesystem-reader-design.md` — **§3 carries the measured on-disk facts; read it before Task 1.**

## Global Constraints

- **Read-only. This increment writes nothing to any disk image, ever.** Bitmap and hash-chain maintenance are deliberately absent; writing is a separate backlog increment.
- **The reader must never throw for malformed input and must always terminate.** Its input is a tenant-uploaded blob. Every traversal is bounds-checked, cycle-guarded and capped (spec §5).
- **"No filesystem" is a RESULT, not an error** (D-3-3). 20% of the real archive answers this way. `readVolume` returns a discriminated union.
- **Validity requires the ROOT-block checksum** (D-3-1). Type and secondary-type checks alone admit Project-X, whose block 880 is game data.
- **The BOOT-block checksum is never a validity test** (D-3-2). Only 19 of 49 readable archive disks have a valid one.
- **The boundary is `entitlements(orgId, sha256)`, not the disk row.** `disks.orgId` can drift from its game's org. Cross-tenant access answers **404, never 403**.
- **`db.transaction()` THROWS on neon-http**; `db.batch()` is the atomic primitive. `getDb().execute()` returns `{ rows }`, never an array.
- **Vitest never opens a database connection** and has no `DATABASE_URL`. Pure logic → Vitest; anything touching Postgres or a page → Playwright.
- **No test may make a live third-party request.**
- Next 16: `params`/`searchParams`/`cookies()`/`headers()` are Promises. `PageProps`/`RouteContext` are ambient — never import them.
- **`--accent-amber` (`#f5822e`) is fill-only** and fails WCAG AA as text; amber text is `--amber-text`. The grey ramp (`--muted`, `--muted-2`, `--faint`) is contrast-checked — do not lighten it.
- Every e2e spec cleans up what it seeded. The suite runs **`workers: 1`** against a live database, and `e2e/global-teardown.ts` sweeps `@example.test` accounts afterwards.
- Run `pnpm vitest run`, `pnpm build` and the affected e2e before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/adffs/constants.ts` | **Create.** Block size, root block number, hash-table size, sector-type codes, caps. |
| `src/lib/adffs/blocks.ts` | **Create.** Block slicing, big-endian reads, the AmigaDOS checksum, AmigaDOS date decoding. The only file doing arithmetic on raw offsets. |
| `src/lib/adffs/blocks.test.ts` | **Create.** |
| `src/lib/adffs/boot.ts` | **Create.** DOS signature and flag nibble → filesystem/INTL/DIRC. |
| `src/lib/adffs/boot.test.ts` | **Create.** |
| `src/lib/adffs/root.ts` | **Create.** Root-block validation (owns D-3-1) and the volume header. |
| `src/lib/adffs/root.test.ts` | **Create.** |
| `src/lib/adffs/dir.ts` | **Create.** Hash-table and chain traversal, entry decoding, all §5 guards. |
| `src/lib/adffs/dir.test.ts` | **Create.** |
| `src/lib/adffs/file.ts` | **Create.** Data-block lists, extension blocks, the OFS/FFS data split. |
| `src/lib/adffs/file.test.ts` | **Create.** |
| `src/lib/adffs/synthetic.ts` | **Create.** Deterministic in-test image builder, mirroring `adfmfm/synthetic.ts`. Test-only. |
| `src/lib/adffs/index.ts` | **Create.** `readVolume` / `readFile`. The only exports callers use. |
| `src/lib/adffs/index.test.ts` | **Create.** End-to-end over synthetic images. |
| `src/lib/adffs/archive.test.ts` | **Create.** Asserts the measured verdicts over `adf-archive/`; skips when absent. |
| `src/app/(app)/disks/[id]/files/page.tsx` | **Create.** Server component: entitlement check, parse, render. |
| `src/components/disks/file-tree.tsx` | **Create.** Client component: expandable tree. |
| `src/components/disks/volume-header.tsx` | **Create.** Volume facts, or the no-filesystem state. |
| `src/app/api/disks/[id]/files/[block]/route.ts` | **Create.** One file's bytes. |
| `src/components/games/disk-row.tsx` | **Modify.** Add the Browse link. |
| `e2e/adf-browser.spec.ts` | **Create.** |

---

### Task 1: Blocks, checksums and dates

**Files:**
- Create: `src/lib/adffs/constants.ts`, `src/lib/adffs/blocks.ts`, `src/lib/adffs/blocks.test.ts`

**Interfaces:**
- Produces:

```ts
// constants.ts
export const BLOCK_BYTES = 512;
export const BLOCK_COUNT = 1760;
export const ROOT_BLOCK = 880;
export const HASH_TABLE_SIZE = 72;
export const CHECKSUM_WORD = 5;          // root/dir/file-header blocks
export const OFS_DATA_CHECKSUM_WORD = 5; // OFS data block header
export const OFS_DATA_BYTES = 488;
export const T_HEADER = 2;
export const T_DATA = 8;
export const T_LIST = 16;
export const ST_ROOT = 1;
export const ST_USERDIR = 2;
export const ST_FILE = -3;
export const MAX_ENTRIES = 10_000;
export const MAX_DEPTH = 32;

// blocks.ts
export function blockAt(adf: Uint8Array, block: number): Uint8Array | null;
export function be32(block: Uint8Array, offset: number): number;
export function i32(block: Uint8Array, offset: number): number;
export function blockChecksum(block: Uint8Array, skipWord: number): number;
export function checksumOk(block: Uint8Array, skipWord: number): boolean;
export function bcplString(block: Uint8Array, lengthOffset: number, max: number): string;
export function amigaDate(block: Uint8Array, offset: number): Date | null;
```

**Read spec §3.1 and §3.3 first.** `blockAt` returning `null` for an out-of-range index is the mechanism behind spec §5 guard 1 — every caller checks it, so no other file needs a bounds test.

- [ ] **Step 1: Write the failing test**

`src/lib/adffs/blocks.test.ts`:

```ts
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
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/adffs/blocks.test.ts`
Expected: FAIL — cannot resolve `./constants`.

- [ ] **Step 3: Implement**

`src/lib/adffs/constants.ts`:

```ts
// Every value here comes from docs/superpowers/specs/2026-09-01-adf-filesystem-reader-design.md
// section 3, which measured them against the operator's archive rather than
// taking them from the format documentation. Do not "tidy" any of them.

export const BLOCK_BYTES = 512;
/** 880 KB / 512. A non-standard image is out of scope; assertAdf rejects it. */
export const BLOCK_COUNT = 1760;
/** The midpoint of the disk. Fixed, not derived: see spec section 3.1. */
export const ROOT_BLOCK = 880;
export const HASH_TABLE_SIZE = 72;

/** Word index of the checksum in root, directory and file-header blocks. */
export const CHECKSUM_WORD = 5;
/** Word index of the checksum in an OFS data block's 24-byte header. */
export const OFS_DATA_CHECKSUM_WORD = 5;
/** An OFS data block spends 24 bytes on a header, leaving this much payload. */
export const OFS_DATA_BYTES = 488;

export const T_HEADER = 2;
export const T_DATA = 8;
export const T_LIST = 16;

export const ST_ROOT = 1;
export const ST_USERDIR = 2;
/** Stored as 0xfffffffd. MUST be compared as a SIGNED value -- see i32. */
export const ST_FILE = -3;

/**
 * Caps from spec section 5. The real archive's largest disk holds a few
 * hundred entries at depth 4, so these bound a crafted image without
 * constraining any real one.
 */
export const MAX_ENTRIES = 10_000;
export const MAX_DEPTH = 32;
```

`src/lib/adffs/blocks.ts`:

```ts
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
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/adffs/blocks.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/adffs/constants.ts src/lib/adffs/blocks.ts src/lib/adffs/blocks.test.ts
git commit -m "Add AmigaDOS block access, checksums and date decoding"
```

---

### Task 2: Boot block and the synthetic image builder

**Files:**
- Create: `src/lib/adffs/boot.ts`, `src/lib/adffs/boot.test.ts`, `src/lib/adffs/synthetic.ts`

**Interfaces:**
- Consumes: `blockAt`, `be32` (Task 1).
- Produces:

```ts
// boot.ts
export type Filesystem = 'OFS' | 'FFS';
export interface BootInfo { filesystem: Filesystem; intl: boolean; dirc: boolean }
export function readBoot(adf: Uint8Array): BootInfo | null;   // null = no DOS signature

// synthetic.ts  (TEST-ONLY, but shipped in src so vitest resolves it)
export interface SyntheticFile { name: string; bytes: Uint8Array }
export interface SyntheticDir { name: string; entries: SyntheticEntry[] }
export type SyntheticEntry = SyntheticFile | SyntheticDir;
export interface SyntheticOptions {
  filesystem?: Filesystem;
  intl?: boolean;
  dirc?: boolean;
  volumeName?: string;
  entries?: SyntheticEntry[];
  /** Corrupt the root checksum, reproducing the Project-X shape. */
  breakRootChecksum?: boolean;
  /** Corrupt the boot checksum, which must NOT affect validity (D-3-2). */
  breakBootChecksum?: boolean;
  /** Omit the DOS signature entirely. */
  noSignature?: boolean;
}
export function syntheticVolume(opts?: SyntheticOptions): Uint8Array;
```

`synthetic.ts` is the workhorse for Tasks 3–6 — every later test builds its fixture with it, exactly as `adfmfm/synthetic.ts` does, so **no real disk image ever enters the repository**.

- [ ] **Step 1: Write the failing test**

`src/lib/adffs/boot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readBoot } from './boot';
import { syntheticVolume } from './synthetic';

describe('readBoot', () => {
  it('reads a plain OFS volume', () => {
    expect(readBoot(syntheticVolume({ filesystem: 'OFS' })))
      .toEqual({ filesystem: 'OFS', intl: false, dirc: false });
  });

  it('reads the FFS flag', () => {
    expect(readBoot(syntheticVolume({ filesystem: 'FFS' })!).filesystem).toBe('FFS');
  });

  it('reads INTL and DIRC independently of the filesystem bit', () => {
    // 6 archive disks are INTL; none are DIRC. Both are read anyway, because
    // INTL changes the hash function and DIRC is reported to the operator.
    const b = readBoot(syntheticVolume({ filesystem: 'FFS', intl: true, dirc: true }))!;
    expect(b).toEqual({ filesystem: 'FFS', intl: true, dirc: true });
  });

  it('returns null without a DOS signature', () => {
    expect(readBoot(syntheticVolume({ noSignature: true }))).toBeNull();
  });

  it('IGNORES a broken boot checksum', () => {
    // D-3-2, and this is the common case rather than an edge case: only 19
    // of the 49 readable archive disks have a valid boot checksum. Enforcing
    // it would discard 61% of what this reader exists to read.
    const b = readBoot(syntheticVolume({ filesystem: 'FFS', breakBootChecksum: true }));
    expect(b).toEqual({ filesystem: 'FFS', intl: false, dirc: false });
  });

  it('returns null for an image too short to hold a boot block', () => {
    expect(readBoot(new Uint8Array(16))).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/adffs/boot.test.ts`
Expected: FAIL — cannot resolve `./boot`.

- [ ] **Step 3: Implement `boot.ts`**

```ts
// The boot block: the DOS signature and the filesystem flag nibble.
//
// Reference: http://lclevy.free.fr/adflib/adf_info.html

import { blockAt } from './blocks';

export type Filesystem = 'OFS' | 'FFS';

export interface BootInfo {
  filesystem: Filesystem;
  /** International mode: changes the directory hash function. */
  intl: boolean;
  /** Directory cache. A cache OVER the hash chains, never a replacement. */
  dirc: boolean;
}

const FLAG_FFS = 0x01;
const FLAG_INTL = 0x02;
const FLAG_DIRC = 0x04;

/**
 * Null when there is no DOS signature at all -- one archive disk in 61.
 *
 * THE BOOT BLOCK'S OWN CHECKSUM IS DELIBERATELY NOT VERIFIED (design decision
 * D-3-2). It looks like the obvious validity test and is the opposite of one:
 * measured against the operator's archive, only 19 of the 49 disks with a
 * sound filesystem have a valid boot checksum. Non-bootable data disks and
 * disks with custom boot code routinely fail it while reading perfectly.
 * Enforcing it here would discard 61% of what this module exists to read.
 */
export function readBoot(adf: Uint8Array): BootInfo | null {
  const boot = blockAt(adf, 0);
  if (!boot) return null;
  if (boot[0] !== 0x44 || boot[1] !== 0x4f || boot[2] !== 0x53) return null; // 'DOS'
  const flags = boot[3];
  return {
    filesystem: (flags & FLAG_FFS) ? 'FFS' : 'OFS',
    intl: (flags & FLAG_INTL) !== 0,
    dirc: (flags & FLAG_DIRC) !== 0,
  };
}
```

- [ ] **Step 4: Implement `synthetic.ts`**

Build a real, checksum-correct volume so later tasks test against something an Amiga would accept. Allocate data blocks from block 882 upward, directory blocks downward from 879.

```ts
// Deterministic synthetic volumes, built in memory for tests.
//
// Mirrors adfmfm/synthetic.ts and exists for the same reason (parent spec
// section 14): no real disk image, and nothing derived from one, belongs in
// this repository. Everything here writes CORRECT checksums unless a test
// asks for a broken one, so a fixture is something a real Amiga would mount.

import {
  BLOCK_BYTES, BLOCK_COUNT, ROOT_BLOCK, HASH_TABLE_SIZE, CHECKSUM_WORD,
  OFS_DATA_CHECKSUM_WORD, OFS_DATA_BYTES, T_HEADER, T_DATA, T_LIST,
  ST_ROOT, ST_USERDIR, ST_FILE,
} from './constants';
import { blockChecksum } from './blocks';
import type { Filesystem } from './boot';

export interface SyntheticFile { name: string; bytes: Uint8Array }
export interface SyntheticDir { name: string; entries: SyntheticEntry[] }
export type SyntheticEntry = SyntheticFile | SyntheticDir;

export interface SyntheticOptions {
  filesystem?: Filesystem;
  intl?: boolean;
  dirc?: boolean;
  volumeName?: string;
  entries?: SyntheticEntry[];
  breakRootChecksum?: boolean;
  breakBootChecksum?: boolean;
  noSignature?: boolean;
}

const isDir = (e: SyntheticEntry): e is SyntheticDir =>
  Array.isArray((e as SyntheticDir).entries);

function putBe32(a: Uint8Array, off: number, v: number) {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

function putName(a: Uint8Array, blockStart: number, name: string) {
  const n = name.slice(0, 30);
  a[blockStart + 432] = n.length;
  for (let i = 0; i < n.length; i++) a[blockStart + 433 + i] = n.charCodeAt(i) & 0xff;
}

/**
 * The AmigaDOS directory hash. INTL folds the extended Latin range as well as
 * ASCII, which is why 6 archive disks need the second variant.
 */
export function nameHash(name: string, intl: boolean): number {
  let hash = name.length;
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    const upper = intl
      ? ((c >= 0x61 && c <= 0x7a) || (c >= 0xe0 && c <= 0xfe && c !== 0xf7) ? c - 32 : c)
      : (c >= 0x61 && c <= 0x7a ? c - 32 : c);
    hash = ((hash * 13) + upper) >>> 0;
    hash = hash & 0x7ff;
  }
  return hash % HASH_TABLE_SIZE;
}

export function syntheticVolume(opts: SyntheticOptions = {}): Uint8Array {
  const {
    filesystem = 'OFS', intl = false, dirc = false,
    volumeName = 'TestVol', entries = [],
    breakRootChecksum = false, breakBootChecksum = false, noSignature = false,
  } = opts;

  const adf = new Uint8Array(BLOCK_BYTES * BLOCK_COUNT);

  // ---- boot block ----
  if (!noSignature) {
    adf.set([0x44, 0x4f, 0x53], 0);
    adf[3] = (filesystem === 'FFS' ? 1 : 0) | (intl ? 2 : 0) | (dirc ? 4 : 0);
    putBe32(adf, 8, ROOT_BLOCK);
  }

  let nextData = ROOT_BLOCK + 2;   // data blocks grow upward from 882
  let nextMeta = ROOT_BLOCK - 1;   // dir/file headers grow downward from 879
  const allocData = () => nextData++;
  const allocMeta = () => nextMeta--;

  /** Write one file's data blocks and its header; returns the header block. */
  function writeFile(name: string, bytes: Uint8Array, parent: number): number {
    const perBlock = filesystem === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
    const dataBlocks: number[] = [];
    for (let off = 0; off < Math.max(bytes.length, 1); off += perBlock) {
      dataBlocks.push(allocData());
      if (bytes.length === 0) break;
    }
    const header = allocMeta();

    // Data blocks.
    dataBlocks.forEach((blk, i) => {
      const start = blk * BLOCK_BYTES;
      const chunk = bytes.subarray(i * perBlock, (i + 1) * perBlock);
      if (filesystem === 'OFS') {
        putBe32(adf, start, T_DATA);
        putBe32(adf, start + 4, header);
        putBe32(adf, start + 8, i + 1);              // sequence number, 1-based
        putBe32(adf, start + 12, chunk.length);
        putBe32(adf, start + 16, dataBlocks[i + 1] ?? 0);
        adf.set(chunk, start + 24);
        putBe32(adf, start + OFS_DATA_CHECKSUM_WORD * 4,
          blockChecksum(adf.subarray(start, start + BLOCK_BYTES), OFS_DATA_CHECKSUM_WORD));
      } else {
        adf.set(chunk, start);
      }
    });

    // File header. Data pointers live at 24..307 in REVERSE order.
    const hs = header * BLOCK_BYTES;
    putBe32(adf, hs, T_HEADER);
    putBe32(adf, hs + 4, header);
    putBe32(adf, hs + 8, Math.min(dataBlocks.length, HASH_TABLE_SIZE));
    putBe32(adf, hs + 16, dataBlocks[0] ?? 0);
    putBe32(adf, hs + 324, bytes.length);
    const inHeader = dataBlocks.slice(0, HASH_TABLE_SIZE);
    inHeader.forEach((blk, i) => {
      putBe32(adf, hs + 24 + (HASH_TABLE_SIZE - 1 - i) * 4, blk);
    });

    // Extension blocks for anything beyond 72 data blocks. 112 real files
    // need this, so it is exercised, not theoretical.
    let remaining = dataBlocks.slice(HASH_TABLE_SIZE);
    let prev = hs + 504;
    while (remaining.length > 0) {
      const ext = allocMeta();
      putBe32(adf, prev, ext);
      const es = ext * BLOCK_BYTES;
      const take = remaining.slice(0, HASH_TABLE_SIZE);
      putBe32(adf, es, T_LIST);
      putBe32(adf, es + 4, ext);
      putBe32(adf, es + 8, take.length);
      putBe32(adf, es + 500, header);
      take.forEach((blk, i) => {
        putBe32(adf, es + 24 + (HASH_TABLE_SIZE - 1 - i) * 4, blk);
      });
      putBe32(adf, es + 508, ST_FILE);
      putBe32(adf, es + CHECKSUM_WORD * 4,
        blockChecksum(adf.subarray(es, es + BLOCK_BYTES), CHECKSUM_WORD));
      remaining = remaining.slice(HASH_TABLE_SIZE);
      prev = es + 504;
    }

    putName(adf, hs, name);
    putBe32(adf, hs + 500, parent);
    putBe32(adf, hs + 508, ST_FILE >>> 0);
    putBe32(adf, hs + CHECKSUM_WORD * 4,
      blockChecksum(adf.subarray(hs, hs + BLOCK_BYTES), CHECKSUM_WORD));
    return header;
  }

  /** Link a child into a parent directory's hash chain. */
  function link(parent: number, child: number, name: string) {
    const slot = nameHash(name, intl);
    const ps = parent * BLOCK_BYTES;
    const head = (adf[ps + 24 + slot * 4] << 24 | adf[ps + 24 + slot * 4 + 1] << 16
      | adf[ps + 24 + slot * 4 + 2] << 8 | adf[ps + 24 + slot * 4 + 3]) >>> 0;
    putBe32(adf, child * BLOCK_BYTES + 496, head);
    putBe32(adf, ps + 24 + slot * 4, child);
  }

  function writeDir(name: string, list: SyntheticEntry[], parent: number): number {
    const dir = allocMeta();
    const ds = dir * BLOCK_BYTES;
    putBe32(adf, ds, T_HEADER);
    putBe32(adf, ds + 4, dir);
    putName(adf, ds, name);
    putBe32(adf, ds + 500, parent);
    putBe32(adf, ds + 508, ST_USERDIR);
    fill(dir, list);
    putBe32(adf, ds + CHECKSUM_WORD * 4,
      blockChecksum(adf.subarray(ds, ds + BLOCK_BYTES), CHECKSUM_WORD));
    return dir;
  }

  function fill(parent: number, list: SyntheticEntry[]) {
    for (const e of list) {
      const child = isDir(e)
        ? writeDir(e.name, e.entries, parent)
        : writeFile(e.name, e.bytes, parent);
      link(parent, child, e.name);
    }
  }

  // ---- root block ----
  const rs = ROOT_BLOCK * BLOCK_BYTES;
  putBe32(adf, rs, T_HEADER);
  putBe32(adf, rs + 12, HASH_TABLE_SIZE);
  putBe32(adf, rs + 508, ST_ROOT);
  putName(adf, rs, volumeName);
  putBe32(adf, rs + 16, 1);   // days: a non-zero date so amigaDate returns one
  putBe32(adf, rs + 420, 1);
  fill(ROOT_BLOCK, entries);
  putBe32(adf, rs + CHECKSUM_WORD * 4,
    blockChecksum(adf.subarray(rs, rs + BLOCK_BYTES), CHECKSUM_WORD));

  // Reproduces the Project-X shape: structurally plausible, checksum bogus.
  if (breakRootChecksum) putBe32(adf, rs + CHECKSUM_WORD * 4, 0x31313131);
  if (breakBootChecksum) putBe32(adf, 4, 0xdeadbeef);

  return adf;
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm vitest run src/lib/adffs/boot.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/adffs/boot.ts src/lib/adffs/boot.test.ts src/lib/adffs/synthetic.ts
git commit -m "Read the boot block, and build synthetic volumes for testing"
```

---

### Task 3: Root block and volume header

**Files:**
- Create: `src/lib/adffs/root.ts`, `src/lib/adffs/root.test.ts`

**Interfaces:**
- Consumes: `blockAt`, `be32`, `i32`, `checksumOk`, `bcplString`, `amigaDate` (Task 1); `readBoot`, `BootInfo` (Task 2); `syntheticVolume` (Task 2).
- Produces:

```ts
export interface VolumeInfo {
  filesystem: Filesystem; intl: boolean; dirc: boolean;
  name: string; createdAt: Date | null; modifiedAt: Date | null;
}
export function readRoot(adf: Uint8Array, boot: BootInfo): VolumeInfo | null;
```

**This task owns D-3-1**, the single most important rule in the module.

- [ ] **Step 1: Write the failing test**

`src/lib/adffs/root.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readBoot } from './boot';
import { readRoot } from './root';
import { syntheticVolume } from './synthetic';
import { BLOCK_BYTES, ROOT_BLOCK, CHECKSUM_WORD } from './constants';

const volumeOf = (adf: Uint8Array) => readRoot(adf, readBoot(adf)!);

describe('readRoot', () => {
  it('reads the volume name', () => {
    expect(volumeOf(syntheticVolume({ volumeName: 'Workbench3.1' }))!.name)
      .toBe('Workbench3.1');
  });

  it('carries the boot flags through onto the volume', () => {
    const v = volumeOf(syntheticVolume({ filesystem: 'FFS', intl: true }))!;
    expect(v.filesystem).toBe('FFS');
    expect(v.intl).toBe(true);
  });

  it('decodes the volume dates', () => {
    expect(volumeOf(syntheticVolume())!.modifiedAt).toBeInstanceOf(Date);
  });

  it('REJECTS a block whose checksum is wrong, however plausible it looks', () => {
    // D-3-1, and the reason this rule exists. All four Project-X disks have
    // type 2 and secondary type 1 at block 880 -- they pass every structural
    // check -- but store ASCII "1111" where the checksum belongs, because the
    // block is game data. Without this the reader reports a filesystem with a
    // blank volume name on a cracked game.
    expect(volumeOf(syntheticVolume({ breakRootChecksum: true }))).toBeNull();
  });

  it('accepts a volume whose BOOT checksum is broken', () => {
    // D-3-2. 30 of the 49 readable archive disks are exactly this shape.
    expect(volumeOf(syntheticVolume({ breakBootChecksum: true }))).not.toBeNull();
  });

  it('rejects a block with the wrong primary type', () => {
    const adf = syntheticVolume();
    adf.set([0, 0, 0, 9], ROOT_BLOCK * BLOCK_BYTES);
    expect(volumeOf(adf)).toBeNull();
  });

  it('rejects a block with the wrong secondary type', () => {
    const adf = syntheticVolume();
    adf.set([0, 0, 0, 7], ROOT_BLOCK * BLOCK_BYTES + 508);
    expect(volumeOf(adf)).toBeNull();
  });

  it('rejects an all-zero image without throwing', () => {
    const adf = new Uint8Array(BLOCK_BYTES * 1760);
    expect(readBoot(adf)).toBeNull();
    void CHECKSUM_WORD;
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/adffs/root.test.ts`
Expected: FAIL — cannot resolve `./root`.

- [ ] **Step 3: Implement**

```ts
// The root block: where "does this disk have a filesystem?" is answered.

import { ROOT_BLOCK, CHECKSUM_WORD, T_HEADER, ST_ROOT } from './constants';
import { blockAt, be32, i32, checksumOk, bcplString, amigaDate } from './blocks';
import type { BootInfo, Filesystem } from './boot';

export interface VolumeInfo {
  filesystem: Filesystem;
  intl: boolean;
  dirc: boolean;
  name: string;
  createdAt: Date | null;
  modifiedAt: Date | null;
}

/**
 * Null when block 880 is not a valid root block.
 *
 * THE CHECKSUM IS NOT OPTIONAL (design decision D-3-1). Type and secondary
 * type alone are two 32-bit comparisons that ordinary game data passes by
 * chance: all four Project-X disks in the operator's archive have T_HEADER at
 * offset 0 and ST_ROOT at 508 on a disk with no filesystem at all, because
 * block 880 is the middle of the game's data. They store 0x31313131 -- ASCII
 * "1111" -- where the checksum belongs. The checksum is the only thing that
 * distinguishes a filesystem from a coincidence.
 */
export function readRoot(adf: Uint8Array, boot: BootInfo): VolumeInfo | null {
  const root = blockAt(adf, ROOT_BLOCK);
  if (!root) return null;
  if (be32(root, 0) !== T_HEADER) return null;
  if (i32(root, 508) !== ST_ROOT) return null;
  if (!checksumOk(root, CHECKSUM_WORD)) return null;

  return {
    filesystem: boot.filesystem,
    intl: boot.intl,
    dirc: boot.dirc,
    name: bcplString(root, 432, 30),
    // Offsets per the format reference: volume modification at 420, creation
    // at 484. Both are three-word dates.
    modifiedAt: amigaDate(root, 420),
    createdAt: amigaDate(root, 484),
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/adffs/root.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/adffs/root.ts src/lib/adffs/root.test.ts
git commit -m "Validate the root block, where the checksum separates a filesystem from a coincidence"
```

---

### Task 4: Directory traversal, with every guard

**Files:**
- Create: `src/lib/adffs/dir.ts`, `src/lib/adffs/dir.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:

```ts
export interface AdfEntry {
  name: string;
  kind: 'file' | 'dir';
  block: number;
  sizeBytes: number;
  modifiedAt: Date | null;
  protection: string;
  comment: string | null;
  children: AdfEntry[];
}
export interface WalkResult { root: AdfEntry[]; truncated: boolean; warnings: string[] }
export function walkDirectory(adf: Uint8Array, block: number): WalkResult;
export function protectionString(bits: number): string;
```

**This task implements spec §5 guards 2, 3 and 5.** Every guard gets a test; the archive has no cycles today, which is exactly why they are synthetic.

- [ ] **Step 1: Write the failing test**

`src/lib/adffs/dir.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { walkDirectory, protectionString } from './dir';
import { syntheticVolume } from './synthetic';
import { ROOT_BLOCK, BLOCK_BYTES, MAX_ENTRIES } from './constants';

const bytes = (n: number) => new Uint8Array(n);
const walk = (adf: Uint8Array) => walkDirectory(adf, ROOT_BLOCK);
const names = (es: { name: string }[]) => es.map((e) => e.name).sort();

function putBe32(a: Uint8Array, off: number, v: number) {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

describe('walkDirectory', () => {
  it('finds files in the root directory', () => {
    const adf = syntheticVolume({ entries: [
      { name: 'Disk.info', bytes: bytes(100) },
      { name: 'Startup', bytes: bytes(50) },
    ] });
    expect(names(walk(adf).root)).toEqual(['Disk.info', 'Startup']);
  });

  it('reports a file size from its header', () => {
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: bytes(1234) }] });
    expect(walk(adf).root[0].sizeBytes).toBe(1234);
  });

  it('recurses into subdirectories', () => {
    const adf = syntheticVolume({ entries: [
      { name: 'C', entries: [{ name: 'SetPatch', bytes: bytes(10) }] },
    ] });
    const c = walk(adf).root.find((e) => e.name === 'C')!;
    expect(c.kind).toBe('dir');
    expect(names(c.children)).toEqual(['SetPatch']);
  });

  it('follows a hash chain when two names collide in one slot', () => {
    // Several entries land in the same 72-slot bucket on any real disk; if
    // the chain is not followed, files silently disappear from the listing.
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `File${i}`, bytes: bytes(4),
    }));
    expect(walk(syntheticVolume({ entries: many })).root).toHaveLength(40);
  });

  it('handles an INTL volume, whose hash function differs', () => {
    const adf = syntheticVolume({ intl: true, entries: [{ name: 'Fönts', bytes: bytes(4) }] });
    expect(walk(adf).root).toHaveLength(1);
  });

  it('TERMINATES on a hash chain that points back at itself', () => {
    // Spec section 5 guard 2. The archive has zero cycles, which is exactly
    // why this must be synthetic: without the visited set this hangs forever
    // and takes the request thread with it.
    const adf = syntheticVolume({ entries: [{ name: 'Loop', bytes: bytes(4) }] });
    const entry = walk(adf).root[0].block;
    putBe32(adf, entry * BLOCK_BYTES + 496, entry);   // chain -> itself
    const result = walk(adf);
    expect(result.root.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/cycle/i);
  });

  it('ignores a hash slot pointing outside the image', () => {
    // Spec section 5 guard 1.
    const adf = syntheticVolume({ entries: [{ name: 'Fine', bytes: bytes(4) }] });
    putBe32(adf, ROOT_BLOCK * BLOCK_BYTES + 24, 99_999);
    const result = walk(adf);
    expect(result.warnings.join(' ')).toMatch(/out of range/i);
    expect(() => walk(adf)).not.toThrow();
  });

  it('caps the entry count and reports truncation', () => {
    // Spec section 5 guard 3. A crafted image must not build an unbounded
    // tree on the server.
    expect(MAX_ENTRIES).toBeGreaterThan(0);
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: bytes(4) }] });
    const result = walkDirectory(adf, ROOT_BLOCK);
    expect(result.truncated).toBe(false);
  });

  it('never throws on an image full of random bytes', () => {
    const adf = new Uint8Array(BLOCK_BYTES * 1760);
    for (let i = 0; i < adf.length; i++) adf[i] = (i * 37) & 0xff;
    expect(() => walkDirectory(adf, ROOT_BLOCK)).not.toThrow();
  });
});

describe('protectionString', () => {
  it('renders the AmigaDOS flag order', () => {
    // The low four bits are INVERTED on Amiga: 0 means the action IS allowed.
    expect(protectionString(0)).toBe('----rwed');
  });

  it('shows a delete-protected file', () => {
    expect(protectionString(0x01)).toBe('----rwe-');
  });

  it('shows the high flags, which are NOT inverted', () => {
    expect(protectionString(0x80 | 0x40 | 0x20 | 0x10)).toBe('hsparwed');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/adffs/dir.test.ts`
Expected: FAIL — cannot resolve `./dir`.

- [ ] **Step 3: Implement**

```ts
// Directory traversal: hash tables, chains, and every guard from spec
// section 5. This file is where a hostile image is contained.

import {
  HASH_TABLE_SIZE, CHECKSUM_WORD, MAX_ENTRIES, MAX_DEPTH,
  T_HEADER, ST_USERDIR, ST_FILE,
} from './constants';
import { blockAt, be32, i32, checksumOk, bcplString, amigaDate } from './blocks';

export interface AdfEntry {
  name: string;
  kind: 'file' | 'dir';
  /** Block number: the entry's identity within this image (design D-3-5). */
  block: number;
  sizeBytes: number;
  modifiedAt: Date | null;
  protection: string;
  comment: string | null;
  children: AdfEntry[];
}

export interface WalkResult {
  root: AdfEntry[];
  truncated: boolean;
  warnings: string[];
}

/**
 * "hsparwed", as AmigaDOS `list` prints it.
 *
 * The low four bits (rwed) are INVERTED: a SET bit means the action is
 * FORBIDDEN. Reading them the obvious way reports every ordinary file as
 * having no permissions at all.
 */
export function protectionString(bits: number): string {
  const high = [
    [0x80, 'h'], [0x40, 's'], [0x20, 'p'], [0x10, 'a'],
  ] as const;
  const low = [
    [0x08, 'r'], [0x04, 'w'], [0x02, 'e'], [0x01, 'd'],
  ] as const;
  return high.map(([m, c]) => (bits & m ? c : '-')).join('')
    + low.map(([m, c]) => (bits & m ? '-' : c)).join('');
}

export function walkDirectory(adf: Uint8Array, start: number): WalkResult {
  const warnings: string[] = [];
  const visited = new Set<number>([start]);
  let count = 0;
  let truncated = false;

  const warn = (m: string) => { if (warnings.length < 50) warnings.push(m); };

  function readEntry(block: number, depth: number): AdfEntry | null {
    const b = blockAt(adf, block);
    if (!b) { warn(`block ${block} is out of range`); return null; }
    if (be32(b, 0) !== T_HEADER) { warn(`block ${block} is not a header`); return null; }
    // A corrupt entry block is skipped rather than trusted: its name and size
    // fields would otherwise be read out of arbitrary bytes.
    if (!checksumOk(b, CHECKSUM_WORD)) { warn(`block ${block} has a bad checksum`); return null; }

    const secondary = i32(b, 508);
    const isDir = secondary === ST_USERDIR;
    const isFile = secondary === ST_FILE;
    if (!isDir && !isFile) return null;

    const entry: AdfEntry = {
      name: bcplString(b, 432, 30),
      kind: isDir ? 'dir' : 'file',
      block,
      sizeBytes: isFile ? be32(b, 324) : 0,
      modifiedAt: amigaDate(b, 420),
      protection: protectionString(be32(b, 320)),
      comment: bcplString(b, 328, 79) || null,
      children: [],
    };

    if (isDir) {
      if (depth >= MAX_DEPTH) {
        warn(`directory nesting deeper than ${MAX_DEPTH} at block ${block}`);
      } else {
        entry.children = readTable(block, depth + 1);
      }
    }
    return entry;
  }

  function readTable(dirBlock: number, depth: number): AdfEntry[] {
    const dir = blockAt(adf, dirBlock);
    if (!dir) return [];
    const out: AdfEntry[] = [];

    for (let slot = 0; slot < HASH_TABLE_SIZE; slot++) {
      let ptr = be32(dir, 24 + slot * 4);
      while (ptr !== 0) {
        if (count >= MAX_ENTRIES) { truncated = true; return out; }
        // Guard 2: a chain that revisits a block would otherwise spin
        // forever and take the request thread with it.
        if (visited.has(ptr)) { warn(`hash chain cycle at block ${ptr}`); break; }
        visited.add(ptr);

        const next = blockAt(adf, ptr);
        if (!next) { warn(`hash chain points to block ${ptr}, out of range`); break; }

        count++;
        const entry = readEntry(ptr, depth);
        if (entry) out.push(entry);
        ptr = be32(next, 496);
      }
    }
    return out;
  }

  const root = readTable(start, 0);
  return { root, truncated, warnings };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/adffs/dir.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/adffs/dir.ts src/lib/adffs/dir.test.ts
git commit -m "Walk AmigaDOS directories, with cycle, range and depth guards"
```

---

### Task 5: File contents, OFS and FFS

**Files:**
- Create: `src/lib/adffs/file.ts`, `src/lib/adffs/file.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:

```ts
export interface FileBytes { bytes: Uint8Array; complete: boolean; warnings: string[] }
export function readFileBytes(
  adf: Uint8Array, headerBlock: number, filesystem: Filesystem,
): FileBytes | null;
```

**Read spec §3.5 first.** OFS and FFS genuinely diverge here, and 112 real files need extension blocks.

- [ ] **Step 1: Write the failing test**

`src/lib/adffs/file.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileBytes } from './file';
import { walkDirectory } from './dir';
import { syntheticVolume } from './synthetic';
import { ROOT_BLOCK, BLOCK_BYTES, OFS_DATA_BYTES } from './constants';

function putBe32(a: Uint8Array, off: number, v: number) {
  a[off] = (v >>> 24) & 0xff; a[off + 1] = (v >>> 16) & 0xff;
  a[off + 2] = (v >>> 8) & 0xff; a[off + 3] = v & 0xff;
}

/** Deterministic content, so a wrong offset shows up as wrong bytes. */
const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);

function firstFile(adf: Uint8Array) {
  return walkDirectory(adf, ROOT_BLOCK).root.find((e) => e.kind === 'file')!;
}

describe('readFileBytes', () => {
  it('reads a small OFS file, skipping the 24-byte data-block header', () => {
    const want = payload(100);
    const adf = syntheticVolume({ filesystem: 'OFS', entries: [{ name: 'A', bytes: want }] });
    const got = readFileBytes(adf, firstFile(adf).block, 'OFS')!;
    expect(got.bytes).toEqual(want);
    expect(got.complete).toBe(true);
  });

  it('reads a small FFS file, whose blocks are raw', () => {
    const want = payload(100);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'A', bytes: want }] });
    expect(readFileBytes(adf, firstFile(adf).block, 'FFS')!.bytes).toEqual(want);
  });

  it('reads a file spanning several blocks in the right ORDER', () => {
    // Data pointers are stored in REVERSE order in the header. Reading them
    // forwards yields a file whose blocks are shuffled -- which still has the
    // right length, so only content comparison catches it.
    const want = payload(OFS_DATA_BYTES * 3 + 17);
    const adf = syntheticVolume({ filesystem: 'OFS', entries: [{ name: 'A', bytes: want }] });
    expect(readFileBytes(adf, firstFile(adf).block, 'OFS')!.bytes).toEqual(want);
  });

  it('follows extension blocks past the 72 pointers a header holds', () => {
    // 112 real files need this. An FFS file of 80 blocks is ~41 KB.
    const want = payload(BLOCK_BYTES * 80);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'Big', bytes: want }] });
    const got = readFileBytes(adf, firstFile(adf).block, 'FFS')!;
    expect(got.bytes.length).toBe(want.length);
    expect(got.bytes).toEqual(want);
  });

  it('reads an empty file as zero bytes', () => {
    const adf = syntheticVolume({ entries: [{ name: 'Empty', bytes: new Uint8Array(0) }] });
    expect(readFileBytes(adf, firstFile(adf).block, 'OFS')!.bytes.length).toBe(0);
  });

  it('does NOT trust a size larger than the blocks it can reach', () => {
    // Spec section 5 guard 4. The size field is attacker-controlled; a
    // buffer must never be allocated from it.
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'Liar', bytes: payload(100) }] });
    const block = firstFile(adf).block;
    putBe32(adf, block * BLOCK_BYTES + 324, 800_000);
    const got = readFileBytes(adf, block, 'FFS')!;
    expect(got.bytes.length).toBeLessThan(1000);
    expect(got.complete).toBe(false);
  });

  it('TERMINATES on an extension chain that points back at itself', () => {
    // Spec section 5 guard 2, the extension-chain half.
    const want = payload(BLOCK_BYTES * 80);
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'Big', bytes: want }] });
    const block = firstFile(adf).block;
    const ext = ((adf[block * BLOCK_BYTES + 504] << 24)
      | (adf[block * BLOCK_BYTES + 505] << 16)
      | (adf[block * BLOCK_BYTES + 506] << 8)
      | adf[block * BLOCK_BYTES + 507]) >>> 0;
    putBe32(adf, ext * BLOCK_BYTES + 504, ext);   // extension -> itself
    const got = readFileBytes(adf, block, 'FFS')!;
    expect(got.warnings.join(' ')).toMatch(/cycle/i);
  });

  it('ignores a data pointer outside the image', () => {
    const adf = syntheticVolume({ filesystem: 'FFS', entries: [{ name: 'A', bytes: payload(2000) }] });
    const block = firstFile(adf).block;
    putBe32(adf, block * BLOCK_BYTES + 24 + 71 * 4, 99_999);
    const got = readFileBytes(adf, block, 'FFS')!;
    expect(got.complete).toBe(false);
    expect(got.warnings.length).toBeGreaterThan(0);
  });

  it('returns null when the block is not a file header', () => {
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: payload(10) }] });
    expect(readFileBytes(adf, ROOT_BLOCK, 'OFS')).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/adffs/file.test.ts`
Expected: FAIL — cannot resolve `./file`.

- [ ] **Step 3: Implement**

```ts
// File contents. This is the one place OFS and FFS genuinely diverge, and
// the one place an attacker-controlled length reaches an allocation.

import {
  BLOCK_BYTES, HASH_TABLE_SIZE, CHECKSUM_WORD, OFS_DATA_BYTES,
  T_HEADER, ST_FILE,
} from './constants';
import { blockAt, be32, i32, checksumOk } from './blocks';
import type { Filesystem } from './boot';

export interface FileBytes {
  bytes: Uint8Array;
  /** False when the header claimed more than the reachable blocks held. */
  complete: boolean;
  warnings: string[];
}

/** Every data block of a file, in order, following extension blocks. */
function dataBlocks(adf: Uint8Array, headerBlock: number, warnings: string[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>([headerBlock]);
  let current: number | null = headerBlock;

  while (current !== null) {
    const b = blockAt(adf, current);
    if (!b) { warnings.push(`block ${current} is out of range`); break; }

    // Pointers live at 24..307 in REVERSE order: the LAST slot is the FIRST
    // data block. Reading them forwards produces a file of the right length
    // with its contents shuffled, which no length check would catch.
    for (let i = HASH_TABLE_SIZE - 1; i >= 0; i--) {
      const ptr = be32(b, 24 + i * 4);
      if (ptr !== 0) out.push(ptr);
    }

    const next = be32(b, 504);
    if (next === 0) break;
    if (seen.has(next)) { warnings.push(`extension chain cycle at block ${next}`); break; }
    seen.add(next);
    current = next;
  }
  return out;
}

/**
 * Null when `headerBlock` is not a file header in this image.
 *
 * THE DECLARED SIZE IS NEVER USED TO ALLOCATE (spec section 5 guard 4). The
 * bytes actually reachable are collected first and the declared size only
 * ever TRIMS the result. A header claiming 800 KB with three data blocks
 * yields three blocks and `complete: false`.
 */
export function readFileBytes(
  adf: Uint8Array, headerBlock: number, filesystem: Filesystem,
): FileBytes | null {
  const header = blockAt(adf, headerBlock);
  if (!header) return null;
  if (be32(header, 0) !== T_HEADER) return null;
  if (i32(header, 508) !== ST_FILE) return null;
  if (!checksumOk(header, CHECKSUM_WORD)) return null;

  const warnings: string[] = [];
  const declared = be32(header, 324);
  const blocks = dataBlocks(adf, headerBlock, warnings);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const blk of blocks) {
    const b = blockAt(adf, blk);
    if (!b) { warnings.push(`data block ${blk} is out of range`); continue; }
    if (filesystem === 'OFS') {
      // The header's data_size field says how much of the 488 is real. It is
      // clamped: a crafted value must not read past the block.
      const size = Math.min(be32(b, 12), OFS_DATA_BYTES);
      chunks.push(b.subarray(24, 24 + size));
      total += size;
    } else {
      chunks.push(b.subarray(0, BLOCK_BYTES));
      total += BLOCK_BYTES;
    }
  }

  const length = Math.min(declared, total);
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    if (at >= length) break;
    const take = Math.min(c.length, length - at);
    bytes.set(c.subarray(0, take), at);
    at += take;
  }

  const complete = total >= declared && warnings.length === 0;
  if (!complete && total < declared) {
    warnings.push(`header claims ${declared} bytes but only ${total} are reachable`);
  }
  return { bytes, complete, warnings };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/adffs/file.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/adffs/file.ts src/lib/adffs/file.test.ts
git commit -m "Read file contents from OFS and FFS, following extension blocks"
```

---

### Task 6: The public API, and the archive assertion

**Files:**
- Create: `src/lib/adffs/index.ts`, `src/lib/adffs/index.test.ts`, `src/lib/adffs/archive.test.ts`

**Interfaces:**
- Produces:

```ts
export type VolumeResult =
  | { ok: true; volume: VolumeInfo; root: AdfEntry[]; truncated: boolean; warnings: string[] }
  | { ok: false; reason: 'not-adf' | 'no-dos-signature' | 'no-filesystem' };
export function readVolume(adf: Uint8Array): VolumeResult;
export function readFile(adf: Uint8Array, block: number): FileBytes | null;
```

- [ ] **Step 1: Write the failing tests**

`src/lib/adffs/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readVolume, readFile } from './index';
import { syntheticVolume } from './synthetic';
import { ADF_BYTES } from '@/lib/adfmfm';

describe('readVolume', () => {
  it('reports a whole volume with its tree', () => {
    const adf = syntheticVolume({
      volumeName: 'Workbench3.1', filesystem: 'FFS',
      entries: [{ name: 'C', entries: [{ name: 'SetPatch', bytes: new Uint8Array(64) }] }],
    });
    const r = readVolume(adf);
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.volume.name).toBe('Workbench3.1');
    expect(r.volume.filesystem).toBe('FFS');
    expect(r.root[0].name).toBe('C');
    expect(r.root[0].children[0].name).toBe('SetPatch');
  });

  it('rejects anything that is not an 880 KB image', () => {
    expect(readVolume(new Uint8Array(1024))).toEqual({ ok: false, reason: 'not-adf' });
  });

  it('reports a missing DOS signature distinctly from a missing filesystem', () => {
    // The page shows these differently, and one archive disk is each shape.
    expect(readVolume(syntheticVolume({ noSignature: true })))
      .toEqual({ ok: false, reason: 'no-dos-signature' });
    expect(readVolume(syntheticVolume({ breakRootChecksum: true })))
      .toEqual({ ok: false, reason: 'no-filesystem' });
  });

  it('never throws on random bytes', () => {
    const adf = new Uint8Array(ADF_BYTES);
    for (let i = 0; i < adf.length; i++) adf[i] = (i * 31 + 7) & 0xff;
    expect(() => readVolume(adf)).not.toThrow();
  });
});

describe('readFile', () => {
  it('returns a file\'s bytes by block number', () => {
    const want = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: want }] });
    const r = readVolume(adf);
    if (!r.ok) throw new Error('expected ok');
    expect(readFile(adf, r.root[0].block)!.bytes).toEqual(want);
  });

  it('returns null for a block that is not a file', () => {
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: new Uint8Array(4) }] });
    expect(readFile(adf, 0)).toBeNull();
  });
});
```

`src/lib/adffs/archive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVolume } from './index';

/**
 * The counterpart to adfmfm's Greaseweazle comparison: run the reader over
 * the operator's real archive and assert the figures the design was measured
 * from. If a refactor changes any of these, either the reader regressed or
 * the spec's section 3 is now wrong -- and both are worth stopping for.
 *
 * Skipped when the archive is absent, so a fresh checkout still passes.
 */
const DIR = 'adf-archive';
const present = existsSync(DIR);

describe.skipIf(!present)('the operator archive', () => {
  const files = present
    ? readdirSync(DIR).filter((f) => /\.adf$/i.test(f))
    : [];

  it('reads exactly the disks the design measured', () => {
    let readable = 0, ofs = 0, ffs = 0, intl = 0, dirc = 0;
    let files_ = 0, dirs = 0, maxDepth = 0, cycles = 0;

    function walk(list: { kind: string; children: unknown[] }[], depth: number) {
      if (depth > maxDepth) maxDepth = depth;
      for (const e of list) {
        if (e.kind === 'dir') { dirs++; walk(e.children as never[], depth + 1); }
        else files_++;
      }
    }

    for (const f of files) {
      const r = readVolume(new Uint8Array(readFileSync(join(DIR, f))));
      if (!r.ok) continue;
      readable++;
      r.volume.filesystem === 'FFS' ? ffs++ : ofs++;
      if (r.volume.intl) intl++;
      if (r.volume.dirc) dirc++;
      if (r.warnings.some((w) => /cycle/i.test(w))) cycles++;
      walk(r.root as never[], 1);
    }

    // Measured 2026-09-01; see the design doc's section 3.
    expect(files.length).toBe(61);
    expect(readable).toBe(49);
    expect({ ofs, ffs, intl, dirc }).toEqual({ ofs: 25, ffs: 24, intl: 6, dirc: 0 });
    expect(files_).toBe(2430);
    expect(dirs).toBe(427);
    expect(maxDepth).toBe(4);
    expect(cycles).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement**

```ts
// The AmigaDOS filesystem reader's public surface.
//
// Shaped like src/lib/adfmfm/: pure functions over a Uint8Array, no I/O and
// no database, so the entire format is testable in vitest. Read-only by
// design -- writing needs bitmap and hash-chain maintenance this module
// deliberately does not do.

import { ADF_BYTES } from '@/lib/adfmfm';
import { ROOT_BLOCK } from './constants';
import { readBoot } from './boot';
import { readRoot, type VolumeInfo } from './root';
import { walkDirectory, type AdfEntry } from './dir';
import { readFileBytes, type FileBytes } from './file';

export type { VolumeInfo } from './root';
export type { AdfEntry } from './dir';
export type { FileBytes } from './file';
export type { Filesystem, BootInfo } from './boot';

export type VolumeResult =
  | { ok: true; volume: VolumeInfo; root: AdfEntry[]; truncated: boolean; warnings: string[] }
  | { ok: false; reason: 'not-adf' | 'no-dos-signature' | 'no-filesystem' };

/**
 * A DISCRIMINATED UNION, not a throw, because "this disk has no filesystem"
 * is an ordinary answer for 20% of a real archive (design decision D-3-3).
 * Every game and demo disk answers this way; a game disk is not a failure.
 *
 * The three failure reasons are distinguished because the page renders them
 * differently: a non-880K image is a catalog problem, a missing signature and
 * a missing filesystem are both ordinary properties of a disk.
 */
export function readVolume(adf: Uint8Array): VolumeResult {
  if (adf.length !== ADF_BYTES) return { ok: false, reason: 'not-adf' };

  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-dos-signature' };

  const volume = readRoot(adf, boot);
  if (!volume) return { ok: false, reason: 'no-filesystem' };

  const { root, truncated, warnings } = walkDirectory(adf, ROOT_BLOCK);
  return { ok: true, volume, root, truncated, warnings };
}

/** One file's bytes, addressed by its header block (design decision D-3-5). */
export function readFile(adf: Uint8Array, block: number): FileBytes | null {
  const boot = readBoot(adf);
  if (!boot) return null;
  return readFileBytes(adf, block, boot.filesystem);
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/lib/adffs/`
Expected: PASS. **If `archive.test.ts` disagrees with any figure, STOP and report** — either the reader is wrong or the design's §3 is, and guessing which is not this task's call.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/adffs/index.ts src/lib/adffs/index.test.ts src/lib/adffs/archive.test.ts
git commit -m "Expose readVolume and readFile, and assert them against the real archive"
```

---

### Task 7: The browser page

**Files:**
- Create: `src/app/(app)/disks/[id]/files/page.tsx`, `src/components/disks/volume-header.tsx`, `src/components/disks/file-tree.tsx`
- Modify: `src/components/games/disk-row.tsx`

**Interfaces:**
- Consumes: `readVolume` (Task 6), `requireOrg`, `diskStore.read`, the `entitlements` boundary.

**Read `src/app/api/disks/[id]/adf/route.ts` first** — it already establishes the exact entitlement query this page repeats.

- [ ] **Step 1: The page**

`src/app/(app)/disks/[id]/files/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readVolume } from '@/lib/adffs';
import { PageHeader } from '@/components/shell/page-header';
import { VolumeHeader } from '@/components/disks/volume-header';
import { FileTree } from '@/components/disks/file-tree';

export const dynamic = 'force-dynamic';

export default async function DiskFilesPage(props: PageProps<'/disks/[id]/files'>) {
  const { orgId } = await requireOrg();
  const { id } = await props.params;

  // THE ENTITLEMENT is the boundary, not the disk row -- disks.orgId is an
  // independent column that can drift from its game's org. Identical to the
  // pair /api/disks/[id]/adf uses.
  const rows = await getDb()
    .select({
      sha256: disks.sha256, diskNo: disks.diskNo, gameId: disks.gameId,
      tosecName: disks.tosecName, sourceFilename: entitlements.sourceFilename,
    })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);

  // notFound(), never a 403: the page must not confirm that another
  // organization's disk exists.
  const disk = rows[0];
  if (!disk) notFound();

  const filename = disk.tosecName ?? disk.sourceFilename ?? `${disk.sha256.slice(0, 12)}.adf`;

  let bytes: Uint8Array | null = null;
  try {
    bytes = await diskStore.read(disk.sha256);
  } catch {
    bytes = null;
  }

  const volume = bytes ? readVolume(bytes) : null;
  const title = volume?.ok ? volume.volume.name || filename : filename;

  return (
    <>
      <PageHeader
        eyebrow={`Library / Disk ${disk.diskNo}`}
        title={title}
        subtitle={filename}
        actions={
          <Link href={`/games/${disk.gameId}`} className="text-[12.5px] font-semibold"
                style={{ color: 'var(--on-dark-muted)' }}>← Game</Link>
        }
      />
      <div className="flex flex-col gap-3 px-7 pb-10">
        {volume === null ? (
          <div className="glass-card p-5 text-[13px]" style={{ color: 'var(--amber-text)' }}
               data-testid="blob-unavailable">
            The stored bytes for this disk could not be read.
          </div>
        ) : (
          <>
            <VolumeHeader result={volume} filename={filename} />
            {volume.ok && <FileTree entries={volume.root} diskId={id} />}
          </>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: `volume-header.tsx`**

A server component taking `VolumeResult` plus the disk's filename. When `ok`, render a facts block: filesystem (`OFS`/`FFS`), `INTL` and `DIRC` badges when set, volume name, created/modified dates, and the file and directory counts. When not `ok`, render one of three plain statements with `data-testid="no-filesystem"`:

- `not-adf` — "This image is not a standard 880 KB ADF."
- `no-dos-signature` — "No AmigaDOS filesystem — this disk has no DOS signature, which is normal for a game or demo with a custom bootblock."
- `no-filesystem` — "No AmigaDOS filesystem — the disk has a DOS signature but no valid root block, which is normal for a cracked or copy-protected game."

Render `warnings` (when any) in a `--amber-text` note, and `truncated` as "listing truncated at 10,000 entries".

- [ ] **Step 3: `file-tree.tsx`**

`'use client'`. Takes `AdfEntry[]` and the disk id. Renders a tree where a directory toggles open with `useState`, and each file row shows name, size, protection string, date, and a download link to `/api/disks/<id>/files/<block>`.

Give the root container `data-testid="file-tree"`, each row `data-testid="fs-entry"` with `data-name={entry.name}`, and each download link `data-testid={`fs-download-${entry.block}`}`.

Directories sort before files, then by name, case-insensitively — AmigaDOS hash order is not alphabetical and a raw listing looks shuffled.

- [ ] **Step 4: The Browse link**

In `disk-row.tsx`, beside the existing Download anchor:

```tsx
<Link
  href={`/disks/${disk.id}/files`}
  data-testid={`browse-${disk.id}`}
  className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
  style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
>
  Browse
</Link>
```

`Link`, not `<a>`: this is an internal navigation and should be client-side, unlike the download which must be a real request.

- [ ] **Step 5: Verify and commit**

```bash
pnpm vitest run && pnpm build && pnpm lint
git add "src/app/(app)/disks" src/components/disks src/components/games/disk-row.tsx
git commit -m "Add the disk file browser page"
```

---

### Task 8: The per-file download route

**Files:**
- Create: `src/app/api/disks/[id]/files/[block]/route.ts`

**Interfaces:**
- Consumes: `readVolume`, `readFile` (Task 6); `downloadFilename`, `contentDisposition` (`src/lib/download-name.ts`).

- [ ] **Step 1: Let `downloadFilename` serve a non-ADF name**

`downloadFilename` currently appends `.adf` when a name lacks it, which is right for a whole disk
and wrong for a file INSIDE one — `startup-sequence` must not be saved as `startup-sequence.adf`.

Add a case to `src/lib/download-name.test.ts`:

```ts
it('appends no extension when the caller asks for none', () => {
  // A file inside a disk is not an ADF: "startup-sequence" must stay itself.
  expect(downloadFilename('startup-sequence', null, SHA, '')).toBe('startup-sequence');
});

it('still defaults to .adf for a whole disk', () => {
  expect(downloadFilename(null, 'Workbench31', SHA)).toBe('Workbench31.adf');
});
```

Run `pnpm vitest run src/lib/download-name.test.ts` and watch the first fail, then give
`downloadFilename` a fourth parameter `ext: string = EXT` and use it in place of the literal:

```ts
export function downloadFilename(
  tosecName: string | null | undefined,
  sourceFilename: string | null | undefined,
  sha256: string,
  ext: string = EXT,
): string {
  const chosen = base(tosecName) ?? base(sourceFilename) ?? sha256;
  if (ext === '') return chosen;
  return chosen.toLowerCase().endsWith(ext.toLowerCase()) ? chosen : `${chosen}${ext}`;
}
```

Run it again and watch both pass.

- [ ] **Step 2: Implement the route**

```ts
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readVolume, readFile, type AdfEntry } from '@/lib/adffs';
import { downloadFilename, contentDisposition } from '@/lib/download-name';

export const maxDuration = 60;

/** Depth-first search for the entry at `block`, so its NAME can be used. */
function findEntry(entries: AdfEntry[], block: number): AdfEntry | null {
  for (const e of entries) {
    if (e.block === block) return e;
    const found = findEntry(e.children, block);
    if (found) return found;
  }
  return null;
}

/**
 * One file out of a disk's AmigaDOS filesystem.
 *
 * Addressed by BLOCK NUMBER, not path (design decision D-3-5): the block is
 * the entry's identity inside the image, it needs no escaping, and a path
 * would have to be re-resolved by re-walking the tree anyway.
 *
 * The block is validated by locating it in the parsed tree rather than by
 * trusting the caller -- readFile alone would happily return bytes for any
 * block that merely LOOKS like a file header, including one an attacker
 * pointed at. Walking first also yields the name for Content-Disposition.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string; block: string }> },
) {
  const { orgId } = await requireOrg();
  const { id, block } = await ctx.params;

  const blockNo = Number(block);
  if (!Number.isInteger(blockNo) || blockNo < 0) {
    return Response.json({ error: 'bad_block' }, { status: 400 });
  }

  // The same entitlement boundary as /api/disks/[id]/adf. 404, never 403.
  const rows = await getDb()
    .select({ sha256: disks.sha256 })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);

  const disk = rows[0];
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });

  let adf: Uint8Array;
  try {
    adf = await diskStore.read(disk.sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  const volume = readVolume(adf);
  if (!volume.ok) return Response.json({ error: 'no_filesystem' }, { status: 404 });

  const entry = findEntry(volume.root, blockNo);
  if (!entry || entry.kind !== 'file') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const content = readFile(adf, blockNo);
  if (!content) return Response.json({ error: 'unreadable' }, { status: 422 });

  // An AmigaDOS filename is as untrusted as an uploaded one: it reaches a
  // response header, so it goes through the same sanitiser, which strips
  // CR/LF and emits the RFC 5987 form.
  // ext '' -- a file inside a disk is not an ADF.
  const name = downloadFilename(entry.name, entry.name, disk.sha256, '');

  return new Response(content.bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(content.bytes.byteLength),
      'content-disposition': contentDisposition(name),
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}
```

- [ ] **Step 3: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add "src/app/api/disks/[id]/files" src/lib/download-name.ts src/lib/download-name.test.ts
git commit -m "Serve one file out of a disk's AmigaDOS filesystem"
```

---

### Task 9: End-to-end tests

**Files:**
- Create: `e2e/adf-browser.spec.ts`

**Read `e2e/adf-download.spec.ts` first** — it already has the real-ingest upload helper this needs, and the same cross-tenant shape.

- [ ] **Step 1: Write the specs**

`e2e/adf-browser.spec.ts`. Build ADF bytes **in the test** with `syntheticVolume` from `@/lib/adffs/synthetic`, upload them through the real ingest flow (presign → PUT → complete) exactly as `adf-download.spec.ts` does, then:

1. **The page renders a real tree.** A volume with `C/SetPatch` and a root file; assert `volume-header` shows the volume name and `FFS`, and that `fs-entry` rows include both names.
2. **A disk with no filesystem explains itself.** Upload `syntheticVolume({ breakRootChecksum: true })`; assert `no-filesystem` is visible and no `file-tree` is rendered.
3. **A single file downloads with the right bytes.** Assert status 200, `content-disposition` containing the AmigaDOS filename, and the body equal to the bytes the synthetic volume was built with.
4. **Another tenant gets 404.** Two contexts, as in `adf-download.spec.ts`: prove the owner can load the page and fetch the file first, then assert org B gets 404 from the route and a 404 page from `/disks/<id>/files`.
5. **A block that is not a file is refused.** Request the root block (880) through the file route; expect 404, not bytes.

Clean up with `cleanupSeeded` in `afterAll`.

- [ ] **Step 2: Run everything**

```bash
pnpm vitest run && pnpm build && pnpm e2e
```

Report the counts. The suite runs `workers: 1` and takes ~18 minutes; `e2e/global-teardown.ts` sweeps afterwards.

- [ ] **Step 3: Commit**

```bash
git add e2e/adf-browser.spec.ts
git commit -m "Cover the disk file browser end to end"
```

---

### Task 10: Documentation

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/specs/2026-09-01-adf-filesystem-reader-design.md`

- [ ] **Step 1: Record what shipped**

Add a `### 3f. Read-only ADF filesystem reader` section to `HANDOFF.md` with:

- The measured result: how many of the 61 archive disks the reader reads, against TOSEC's 45.9% and OpenRetro's 6.6%.
- The two traps, stated so nobody re-litigates them: **the root checksum is what rejects Project-X**, and **the boot checksum must never gate validity** (only 19 of 49 readable disks have a valid one).
- That `disks.tosecName` is the uploaded filename until a scan runs — already recorded, but the browser page shows it, so it is worth the cross-reference.
- That the reader is read-only by decision, and the write increment's constraints are already in the backlog.

Update the status table with a row for this increment.

- [ ] **Step 2: Mark the spec delivered**

Add a "What this increment delivered" section to the design doc, including any figure that turned out different from §3 when the archive assertion first ran.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md docs/superpowers/specs/2026-09-01-adf-filesystem-reader-design.md
git commit -m "Record the ADF filesystem reader as delivered"
```

---

## Done when

- `pnpm vitest run` green, `pnpm e2e` green, `pnpm build` clean, lint no worse than baseline.
- `archive.test.ts` reproduces the design's measured figures over the real archive.
- A hostile image — cyclic chains, out-of-range pointers, a lying size field — is shown to terminate and return partial results rather than throwing or hanging.
- A cross-tenant request for both the page and the file route was observed to answer 404.
- The measured read rate is recorded in `HANDOFF.md` beside TOSEC's 45.9% and OpenRetro's 6.6%.
