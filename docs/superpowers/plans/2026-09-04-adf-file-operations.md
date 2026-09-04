# ADF File Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add, delete, rename and replace files and directories inside an ADF image from the browser, with every operation checked against amitools' `xdftool` rather than against our own reader.

**Architecture:** `src/lib/adffs` stops being read-only. Its public surface stays pure functions over a `Uint8Array` that return new bytes or a typed error, with no I/O and no database, so every operation is testable in vitest. A new bitmap allocator is the only genuinely new filesystem code; the name hash, block writers and extension-block logic move out of the test-fixture builder so one implementation serves fixtures and production. Routes load a blob, apply a pure operation, and write a NEW blob, exactly as the volume-rename path already does.

**Tech Stack:** TypeScript, Next.js App Router, Drizzle, Vercel Blob, vitest, Playwright, amitools `xdftool` (hand-run, not CI).

**Spec:** `docs/superpowers/specs/2026-09-04-adf-file-operations-design.md`

## Global Constraints

- **A SET BIT IN THE BITMAP MEANS FREE.** Inverting this reads perfectly through our own reader and corrupts only when a real Amiga writes. Spec §3.3.
- **The bitmap block's checksum sits at offset 0**, not word 5, and makes the sum of all 128 longs zero. Spec §3.2.
- **The bitmap covers blocks 2..1759.** Never allocate block 0, 1, 880 (root) or 881 (bitmap). Spec §3.4.
- **File names are capped at 30 characters** by the format. Spec §4.
- **A file header holds 72 data pointers, stored in REVERSE order** at offset 24, and needs a `T_LIST` extension block beyond that. Spec §3.7.
- **Operations never mutate their input.** Return new bytes. Spec D-W-7.
- **Never throw; return a discriminated union.** Errors: `disk-full`, `name-too-long`, `name-exists`, `not-found`, `not-a-directory`, `bitmap-untrusted`, `no-filesystem`. Spec §4.
- **A disk whose bitmap `readUsage()` rejects is not writable.** Spec D-W-5.
- **Editing a mounted disk is refused with 409.** Spec D-W-4.
- **`disks.id` never changes; `disks.sha256` does.** The old blob is never deleted. Spec §7.
- **Another org gets 404, never 403.** Spec §7.
- **Every xdftool check must be mutation-proven** — break it deliberately, confirm it fails.
- **Lint baseline is 3 pre-existing errors.** Do not add a fourth.

---

### Task 1: Give synthetic volumes a real bitmap

The measured defect that reshaped the spec. `xdftool` rejects all four synthetic shapes with `Bitmap Block Count Mismatch` because `syntheticVolume()` writes no bitmap at all. Every fixture-based test in this module currently runs against a disk no Amiga tool would mount. Fix this before anything is built on it.

**Files:**
- Modify: `src/lib/adffs/synthetic.ts`
- Modify: `src/lib/adffs/synthetic.test.ts`
- Modify: `scripts/adffs-verify.ts`

**Interfaces:**
- Consumes: `readUsage` from `src/lib/adffs/usage.ts`, `usedBlocks` from `src/lib/adffs/format.ts`.
- Produces: `syntheticVolume()` output now carries a valid bitmap. Every later task's fixtures depend on this.

- [ ] **Step 1: Write the failing test**

In `src/lib/adffs/synthetic.test.ts`:

```ts
import { readUsage } from './usage';
import { usedBlocks } from './format';

it('builds a volume whose bitmap an Amiga would believe', () => {
  const adf = syntheticVolume({
    filesystem: 'FFS',
    volumeName: 'BitmapVol',
    entries: [{ name: 'a.txt', bytes: new TextEncoder().encode('hello') }],
  });

  // readUsage returns null for any bitmap it cannot trust, so a non-null
  // answer IS the trust test -- the same one the writer will use.
  const usage = readUsage(adf);
  expect(usage).not.toBeNull();

  // Root, bitmap, the file's header and its one data block are used. The
  // two boot blocks are outside the bitmap but count as used space.
  const used = usedBlocks(adf);
  expect(used).toContain(880);
  expect(used).toContain(881);
  // Nothing may be marked used that the builder never handed out.
  expect(used.length).toBe(4);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/adffs/synthetic.test.ts -t 'bitmap an Amiga'`
Expected: FAIL — `readUsage` returns `null`, because no bitmap exists.

- [ ] **Step 3: Make the builder track and write its allocations**

In `synthetic.ts`, record every block the two counters hand out, then write the bitmap before returning. Copy the bit arithmetic from `format.ts` rather than inventing a second version:

```ts
const allocated: number[] = [ROOT_BLOCK];
const allocData = () => { const b = nextData++; allocated.push(b); return b; };
const allocMeta = () => { const b = nextMeta--; allocated.push(b); return b; };

/** Bitmap block. Written LAST, once every allocation is known. */
function writeBitmap(adf: Uint8Array, used: number[], page: number) {
  const bm = page * BLOCK_BYTES;
  adf.fill(0xff, bm + 4, bm + BLOCK_BYTES);   // every bit FREE to begin with
  for (const block of [...used, page]) {
    const bit = block - 2;                     // bitmap covers 2..1759
    const o = bm + 4 + (bit >>> 5) * 4;
    const word = ((adf[o] << 24) | (adf[o + 1] << 16) | (adf[o + 2] << 8) | adf[o + 3]) >>> 0;
    putBe32(adf, o, (word & ~(1 << (bit & 31))) >>> 0);   // CLEAR means used
  }
  putBe32(adf, bm, 0);
  let sum = 0;
  for (let o = bm; o < bm + BLOCK_BYTES; o += 4) {
    sum = (sum + (((adf[o] << 24) | (adf[o+1] << 16) | (adf[o+2] << 8) | adf[o+3]) >>> 0)) >>> 0;
  }
  putBe32(adf, bm, (-sum >>> 0));
}
```

Then in the root block, set the two fields `readUsage` checks, matching `format.ts`:

```ts
putBe32(adf, root + 312, 0xffffffff);   // bm_flag: valid
putBe32(adf, root + 316, 881);          // bm_pages[0]
```

Call `writeBitmap(adf, allocated, 881)` after all entries are written and before `recheck(adf, ROOT_BLOCK)`.

**The counters must not collide with block 881.** `nextData` starts at 882, so it does not; assert it rather than trusting it:

```ts
if (allocated.includes(881)) throw new Error('synthetic allocator collided with the bitmap block');
```

- [ ] **Step 4: Run the whole module's tests**

Run: `pnpm vitest run src/lib/adffs`
Expected: PASS, all files. `breakRootChecksum` and `noSignature` fixtures still behave as before — they break the root block or the signature, not the bitmap.

- [ ] **Step 5: Teach the verify script to open a synthetic volume**

In `scripts/adffs-verify.ts`, after the existing OFS/FFS format checks:

```ts
console.log('\nsynthetic fixtures');
for (const [label, opts] of [
  ['OFS file',   { filesystem: 'OFS' as const, volumeName: 'SynOFS',  entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hello amiga') }] }],
  ['FFS file',   { filesystem: 'FFS' as const, volumeName: 'SynFFS',  entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hello amiga') }] }],
  ['FFS INTL',   { filesystem: 'FFS' as const, intl: true, volumeName: 'SynINTL', entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hi') }] }],
  ['FFS nested', { filesystem: 'FFS' as const, volumeName: 'SynDir',  entries: [{ name: 'sub', entries: [{ name: 'in.txt', bytes: new TextEncoder().encode('nested') }] }] }],
] as const) {
  const image = join(dir, `syn-${label.replace(/\W/g, '')}.adf`);
  writeFileSync(image, syntheticVolume(opts));
  let listed = '';
  try { listed = xdftool(image, 'list'); } catch (e) { listed = String(e); }
  check(`xdftool opens the ${label} fixture`, !/FSError/.test(listed), listed.split('\n')[0]);
  // The decisive one, same as for formatVolume: can they ALLOCATE into it?
  let wrote = true;
  try { xdftool(image, 'write', join(dir, 'payload.bin'), 'added.txt'); } catch { wrote = false; }
  check(`xdftool writes into the ${label} fixture`, wrote);
}
```

Write a small `payload.bin` into `dir` first so the check does not depend on a file outside the repo.

- [ ] **Step 6: Run it, and prove the check can fail**

Run: `pnpm adffs:verify`
Expected: all checks pass, including the eight new ones.

Then mutate: comment out the `writeBitmap(...)` call and re-run. Expected: the four "opens" checks FAIL with `Bitmap Block Count Mismatch`. Restore the call. **A check that has never failed has not been shown to work.**

- [ ] **Step 7: Commit**

```bash
git add src/lib/adffs/synthetic.ts src/lib/adffs/synthetic.test.ts scripts/adffs-verify.ts
git commit -m "Give synthetic volumes the bitmap they never had"
```

---

### Task 2: Extract the shared write primitives

One implementation of the format, used by fixtures and production. Spec D-W-2.

**Files:**
- Create: `src/lib/adffs/hash.ts`
- Create: `src/lib/adffs/write-blocks.ts`
- Create: `src/lib/adffs/hash.test.ts`
- Modify: `src/lib/adffs/synthetic.ts`
- Modify: `src/lib/adffs/index.ts`

**Interfaces:**
- Produces:
  - `nameHash(name: string, intl: boolean): number` — from `hash.ts`.
  - `putBe32(a: Uint8Array, off: number, v: number): void`
  - `putName(a: Uint8Array, blockStart: number, name: string): void`
  - `recheck(adf: Uint8Array, block: number): void`
  — all from `write-blocks.ts`. Tasks 3 to 8 use these names exactly.

- [ ] **Step 1: Write the failing test**

`src/lib/adffs/hash.test.ts`:

```ts
import { nameHash } from './hash';

it('hashes into the 72-slot table', () => {
  expect(nameHash('hello.txt', false)).toBeGreaterThanOrEqual(0);
  expect(nameHash('hello.txt', false)).toBeLessThan(72);
});

it('is case-insensitive, which is why a rename can change buckets', () => {
  expect(nameHash('README', false)).toBe(nameHash('readme', false));
});

it('INTL folds the extended Latin range and plain mode does not', () => {
  // 0xE9 is é. Under INTL it upper-cases to 0xC9 and hashes differently.
  expect(nameHash('café', true)).not.toBe(nameHash('café', false));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/adffs/hash.test.ts`
Expected: FAIL — `Cannot find module './hash'`.

- [ ] **Step 3: Move, do not copy**

Cut `nameHash` out of `synthetic.ts` into `hash.ts`, and cut `putBe32`, `putName` and `recheck` into `write-blocks.ts`. `synthetic.ts` imports them back. `recheck` keeps its existing exported-for-tests comment.

Re-export from `index.ts` only what the rest of the app needs; the block writers stay module-internal.

- [ ] **Step 4: Run the whole module and the typecheck**

Run: `pnpm vitest run src/lib/adffs && pnpm exec tsc --noEmit`
Expected: PASS. This task changes no behaviour, so any failure is a bad move rather than a bad design.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/
git commit -m "Move the name hash and block writers out of the fixture builder"
```

---

### Task 3: The bitmap allocator

The only genuinely new filesystem code. Spec §4.

**Files:**
- Create: `src/lib/adffs/alloc.ts`
- Create: `src/lib/adffs/alloc.test.ts`

**Interfaces:**
- Consumes: `readUsage` (`usage.ts`), `putBe32` (`write-blocks.ts`), `BLOCK_BYTES`, `BLOCK_COUNT`, `ROOT_BLOCK` (`constants.ts`).
- Produces:
  - `bitmapPage(adf: Uint8Array): number | null` — the trusted bitmap block, or null.
  - `allocate(adf: Uint8Array, n: number): number[] | null` — mutates `adf`, returns the blocks, or null when the disk is full.
  - `free(adf: Uint8Array, blocks: number[]): void` — mutates `adf`.
  - `isFree(adf: Uint8Array, block: number): boolean`

  Tasks 4 to 8 call these exact names. They mutate deliberately: the operations in `write.ts` copy the array once at the top and hand the copy down.

- [ ] **Step 1: Write the failing tests**

```ts
import { syntheticVolume } from './synthetic';
import { readUsage } from './usage';
import { allocate, free, isFree, bitmapPage } from './alloc';

const vol = () => syntheticVolume({ filesystem: 'FFS', volumeName: 'Alloc' });

it('hands out free blocks and marks them used', () => {
  const adf = vol();
  const before = readUsage(adf)!.freeBlocks;
  const got = allocate(adf, 3)!;
  expect(got).toHaveLength(3);
  expect(new Set(got).size).toBe(3);              // no duplicates
  expect(readUsage(adf)!.freeBlocks).toBe(before - 3);
  for (const b of got) expect(isFree(adf, b)).toBe(false);
});

it('never hands out the boot, root or bitmap blocks', () => {
  const adf = vol();
  const got = allocate(adf, 1700)!;
  for (const forbidden of [0, 1, 880, 881]) expect(got).not.toContain(forbidden);
});

it('returns null rather than a short list when the disk is full', () => {
  const adf = vol();
  expect(allocate(adf, 5000)).toBeNull();
  // AND it must not have taken anything on the way to failing.
  expect(readUsage(adf)!.freeBlocks).toBe(readUsage(vol())!.freeBlocks);
});

it('free puts blocks back', () => {
  const adf = vol();
  const got = allocate(adf, 4)!;
  free(adf, got);
  for (const b of got) expect(isFree(adf, b)).toBe(true);
  expect(readUsage(adf)!.freeBlocks).toBe(readUsage(vol())!.freeBlocks);
});

it('keeps the bitmap checksum correct, or readUsage would reject it', () => {
  const adf = vol();
  allocate(adf, 10);
  expect(readUsage(adf)).not.toBeNull();
  free(adf, [900]);
  expect(readUsage(adf)).not.toBeNull();
});

it('refuses a disk whose bitmap cannot be trusted', () => {
  const adf = vol();
  adf[880 * 512 + 312] = 0x00;      // bm_flag no longer -1
  expect(bitmapPage(adf)).toBeNull();
  expect(allocate(adf, 1)).toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/alloc.test.ts`
Expected: FAIL — `Cannot find module './alloc'`.

- [ ] **Step 3: Implement**

```ts
const BITMAP_FIRST_BLOCK = 2;

export function bitmapPage(adf: Uint8Array): number | null {
  // readUsage IS the trust test (spec D-W-5): it already refuses a stale
  // bm_flag, an out-of-range pointer, and a bitmap that does not mark its
  // own block used. Duplicating those checks here would let the two drift.
  if (readUsage(adf) === null) return null;
  return be32(adf, ROOT_BLOCK * BLOCK_BYTES + 316);
}

export function isFree(adf: Uint8Array, block: number): boolean {
  const page = be32(adf, ROOT_BLOCK * BLOCK_BYTES + 316);
  const bit = block - BITMAP_FIRST_BLOCK;
  const o = page * BLOCK_BYTES + 4 + (bit >>> 5) * 4;
  return (be32(adf, o) & (1 << (bit & 31))) !== 0;   // SET means free
}

function setBit(adf: Uint8Array, page: number, block: number, freeNow: boolean) {
  const bit = block - BITMAP_FIRST_BLOCK;
  const o = page * BLOCK_BYTES + 4 + (bit >>> 5) * 4;
  const word = be32(adf, o);
  putBe32(adf, o, (freeNow ? (word | (1 << (bit & 31))) : (word & ~(1 << (bit & 31)))) >>> 0);
}

function rechecksum(adf: Uint8Array, page: number) {
  const bm = page * BLOCK_BYTES;
  putBe32(adf, bm, 0);
  let sum = 0;
  for (let o = bm; o < bm + BLOCK_BYTES; o += 4) sum = (sum + be32(adf, o)) >>> 0;
  putBe32(adf, bm, (-sum >>> 0));
}

export function allocate(adf: Uint8Array, n: number): number[] | null {
  const page = bitmapPage(adf);
  if (page === null) return null;
  const out: number[] = [];
  for (let b = BITMAP_FIRST_BLOCK; b < BLOCK_COUNT && out.length < n; b++) {
    if (b === ROOT_BLOCK || b === page) continue;
    if (isFree(adf, b)) out.push(b);
  }
  // ALL OR NOTHING. A partial allocation would leave a half-written file
  // holding blocks nothing will ever free.
  if (out.length < n) return null;
  for (const b of out) setBit(adf, page, b, false);
  rechecksum(adf, page);
  return out;
}

export function free(adf: Uint8Array, blocks: number[]): void {
  const page = be32(adf, ROOT_BLOCK * BLOCK_BYTES + 316);
  for (const b of blocks) {
    if (b === ROOT_BLOCK || b === page || b < BITMAP_FIRST_BLOCK || b >= BLOCK_COUNT) continue;
    setBit(adf, page, b, true);
  }
  rechecksum(adf, page);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/adffs/alloc.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Prove the inversion would be caught**

Temporarily swap `freeNow` in `setBit` so a set bit means used. Re-run. Expected: the free-count assertions FAIL. Restore.

This matters more than an ordinary mutation check: the inverted bitmap is the exact bug our own reader cannot see.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adffs/alloc.ts src/lib/adffs/alloc.test.ts
git commit -m "Add the bitmap allocator, the one piece with no prior implementation"
```

---

### Task 4: Add a file

**Files:**
- Create: `src/lib/adffs/write.ts`
- Create: `src/lib/adffs/write.test.ts`
- Modify: `src/lib/adffs/index.ts`

**Interfaces:**
- Consumes: `allocate`/`free` (`alloc.ts`), `nameHash` (`hash.ts`), `putBe32`/`putName`/`recheck` (`write-blocks.ts`), `readBoot` (`boot.ts`), `walkDirectory` (`dir.ts`).
- Produces:
  ```ts
  export type WriteError =
    | 'disk-full' | 'name-too-long' | 'name-exists' | 'not-found'
    | 'not-a-directory' | 'bitmap-untrusted' | 'no-filesystem';
  export type WriteResult =
    | { ok: true; adf: Uint8Array }
    | { ok: false; reason: WriteError };
  export function addFile(
    adf: Uint8Array, parentBlock: number, name: string, bytes: Uint8Array,
  ): WriteResult;
  ```
  Tasks 5 to 8 add operations to this same file and reuse `WriteResult`.

- [ ] **Step 1: Write the failing tests**

```ts
import { addFile } from './write';
import { readVolume, readFile } from './index';
import { readUsage } from './usage';

const empty = (fs: 'OFS' | 'FFS' = 'FFS') =>
  syntheticVolume({ filesystem: fs, volumeName: 'AddVol' });

it('adds a file the reader can find and read back', () => {
  const bytes = new TextEncoder().encode('hello amiga');
  const r = addFile(empty(), 880, 'hello.txt', bytes);
  expect(r.ok).toBe(true);
  if (!r.ok) return;

  const v = readVolume(r.adf);
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  expect(v.root.map(e => e.name)).toEqual(['hello.txt']);
  expect(v.root[0].sizeBytes).toBe(bytes.length);

  const back = readFile(r.adf, v.root[0].block);
  expect(back && Array.from(back.bytes)).toEqual(Array.from(bytes));
});

it('works on OFS, whose data blocks carry a 24-byte header', () => {
  const bytes = new Uint8Array(1200).fill(7);
  const r = addFile(empty('OFS'), 880, 'big.bin', bytes);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const v = readVolume(r.adf);
  if (!v.ok) return;
  expect(Array.from(readFile(r.adf, v.root[0].block)!.bytes)).toEqual(Array.from(bytes));
});

it('writes extension blocks past 72 data blocks', () => {
  // 73 FFS data blocks: one more than a header can point at.
  const bytes = new Uint8Array(73 * 512).fill(3);
  const r = addFile(empty(), 880, 'huge.bin', bytes);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const v = readVolume(r.adf);
  if (!v.ok) return;
  expect(readFile(r.adf, v.root[0].block)!.bytes.length).toBe(bytes.length);
});

it('does not mutate the input', () => {
  const adf = empty();
  const copy = adf.slice();
  addFile(adf, 880, 'x.txt', new Uint8Array([1]));
  expect(Array.from(adf)).toEqual(Array.from(copy));
});

it('refuses a duplicate name, a long name, and an untrusted bitmap', () => {
  const one = addFile(empty(), 880, 'a.txt', new Uint8Array([1]));
  if (!one.ok) throw new Error('setup failed');
  expect(addFile(one.adf, 880, 'a.txt', new Uint8Array([2]))).toEqual({ ok: false, reason: 'name-exists' });
  expect(addFile(empty(), 880, 'x'.repeat(31), new Uint8Array([1]))).toEqual({ ok: false, reason: 'name-too-long' });

  const bad = empty();
  bad[880 * 512 + 312] = 0;                       // bm_flag invalid
  expect(addFile(bad, 880, 'a.txt', new Uint8Array([1]))).toEqual({ ok: false, reason: 'bitmap-untrusted' });
});

it('leaves the bitmap untouched when it refuses', () => {
  const adf = empty();
  const before = readUsage(adf)!.freeBlocks;
  addFile(adf, 880, 'x'.repeat(31), new Uint8Array([1]));
  expect(readUsage(adf)!.freeBlocks).toBe(before);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/write.test.ts`
Expected: FAIL — `Cannot find module './write'`.

- [ ] **Step 3: Implement `addFile`**

Order matters: validate everything before allocating anything, so a refusal cannot leak blocks.

```ts
export function addFile(
  adf: Uint8Array, parentBlock: number, name: string, bytes: Uint8Array,
): WriteResult {
  if (name.length === 0 || name.length > 30) return { ok: false, reason: 'name-too-long' };
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };
  if (entryNamed(adf, parentBlock, name, boot.intl)) return { ok: false, reason: 'name-exists' };

  const out = adf.slice();                       // never mutate the input
  const perBlock = boot.filesystem === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
  const dataCount = Math.max(1, Math.ceil(bytes.length / perBlock));
  const extCount = Math.max(0, Math.ceil((dataCount - 72) / 72));

  const blocks = allocate(out, 1 + dataCount + extCount);
  if (!blocks) return { ok: false, reason: 'disk-full' };
  const [header, ...rest] = blocks;
  const data = rest.slice(0, dataCount);
  const exts = rest.slice(dataCount);

  writeDataBlocks(out, data, bytes, header, boot.filesystem, perBlock);
  writeFileHeader(out, header, parentBlock, name, bytes.length, data.slice(0, 72), exts[0] ?? 0);
  writeExtensionBlocks(out, exts, data, header);
  linkIntoDirectory(out, parentBlock, header, name, boot.intl);
  return { ok: true, adf: out };
}
```

`writeDataBlocks`, `writeFileHeader` and `writeExtensionBlocks` are the logic already proven in `synthetic.ts`'s `writeFile`; move it into `write.ts` and have `synthetic.ts` call it, so there is one implementation (D-W-2). **Data pointers go into the header in REVERSE order at offset 24**, matching how `file.ts` reads them.

`linkIntoDirectory` inserts at the head of the bucket's chain:

```ts
function linkIntoDirectory(adf: Uint8Array, dir: number, entry: number, name: string, intl: boolean) {
  const slot = dir * BLOCK_BYTES + 24 + nameHash(name, intl) * 4;
  putBe32(adf, entry * BLOCK_BYTES + 496, be32(adf, slot));   // old head becomes our next
  putBe32(adf, slot, entry);
  recheck(adf, entry);
  recheck(adf, dir);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/adffs/write.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/write.test.ts src/lib/adffs/synthetic.ts src/lib/adffs/index.ts
git commit -m "Add a file into an ADF, allocating from the bitmap"
```

---

### Task 5: Delete a file

Relink is where a mistake does lasting damage, and our own reader hides it: `walkDirectory` reports the shorter list without complaint. Spec §3.5.

**Files:**
- Modify: `src/lib/adffs/write.ts`
- Modify: `src/lib/adffs/write.test.ts`

**Interfaces:**
- Produces: `export function deleteEntry(adf: Uint8Array, parentBlock: number, entryBlock: number): WriteResult` — used by Task 8 for directories and by Task 10's DELETE route.

- [ ] **Step 1: Write the failing tests**

```ts
it('deletes a file and frees every block it held', () => {
  const bytes = new Uint8Array(3000).fill(9);
  const added = addFile(empty(), 880, 'gone.bin', bytes);
  if (!added.ok) throw new Error('setup');
  const v0 = readVolume(added.adf);
  if (!v0.ok) return;
  const baseline = readUsage(empty())!.freeBlocks;

  const r = deleteEntry(added.adf, 880, v0.root[0].block);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const v = readVolume(r.adf);
  if (!v.ok) return;
  expect(v.root).toEqual([]);
  // EVERY block back, not most of them.
  expect(readUsage(r.adf)!.freeBlocks).toBe(baseline);
});

it('keeps the rest of a hash chain reachable', () => {
  // Three names that collide in one bucket would be ideal but are fragile to
  // pick; instead add many and delete from the middle of whatever chain forms.
  let adf = empty();
  const names = Array.from({ length: 12 }, (_, i) => `file${i}.txt`);
  for (const n of names) {
    const r = addFile(adf, 880, n, new Uint8Array([1]));
    if (!r.ok) throw new Error('setup');
    adf = r.adf;
  }
  const v0 = readVolume(adf);
  if (!v0.ok) return;
  const victim = v0.root.find(e => e.name === 'file5.txt')!;

  const r = deleteEntry(adf, 880, victim.block);
  if (!r.ok) throw new Error('delete failed');
  const v = readVolume(r.adf);
  if (!v.ok) return;
  // THE POINT: exactly one is gone, not "everything after it in its chain".
  expect(v.root.map(e => e.name).sort()).toEqual(names.filter(n => n !== 'file5.txt').sort());
});

it('reports not-found for a block that is not in this directory', () => {
  expect(deleteEntry(empty(), 880, 500)).toEqual({ ok: false, reason: 'not-found' });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/write.test.ts -t delete`
Expected: FAIL — `deleteEntry is not a function`.

- [ ] **Step 3: Implement**

```ts
/** The slot or entry that points AT `entry`, so it can be relinked around. */
function predecessorOf(adf: Uint8Array, dir: number, entry: number, intl: boolean):
  { kind: 'slot' | 'entry'; offset: number } | null {
  const name = bcplString(blockAt(adf, entry)!, 432, 30);
  const slotOffset = dir * BLOCK_BYTES + 24 + nameHash(name, intl) * 4;
  let ptr = be32(adf, slotOffset);
  if (ptr === entry) return { kind: 'slot', offset: slotOffset };
  const seen = new Set<number>();
  while (ptr !== 0 && !seen.has(ptr)) {
    seen.add(ptr);
    const nextOffset = ptr * BLOCK_BYTES + 496;
    if (be32(adf, nextOffset) === entry) return { kind: 'entry', offset: nextOffset };
    ptr = be32(adf, nextOffset);
  }
  return null;
}
```

`deleteEntry` finds the predecessor, writes the victim's `next_hash` into it, rechecksums the block it patched (the directory for a slot, the predecessor entry otherwise), then frees the header plus every data and extension block, collected with the same walk `file.ts` uses.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/adffs/write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/write.test.ts
git commit -m "Delete a file, relinking its hash chain and freeing its blocks"
```

---

### Task 6: Rename

**Files:**
- Modify: `src/lib/adffs/write.ts`, `src/lib/adffs/write.test.ts`

**Interfaces:**
- Produces: `export function renameEntry(adf: Uint8Array, parentBlock: number, entryBlock: number, newName: string): WriteResult`

- [ ] **Step 1: Write the failing tests**

```ts
it('renames into a different bucket', () => {
  const added = addFile(empty(), 880, 'before.txt', new Uint8Array([1]));
  if (!added.ok) throw new Error('setup');
  const v0 = readVolume(added.adf);
  if (!v0.ok) return;
  const r = renameEntry(added.adf, 880, v0.root[0].block, 'after.txt');
  if (!r.ok) throw new Error('rename failed');
  const v = readVolume(r.adf);
  if (!v.ok) return;
  expect(v.root.map(e => e.name)).toEqual(['after.txt']);
});

it('survives a rename that lands in the SAME bucket', () => {
  // Case-only change: nameHash is case-insensitive, so old and new collide.
  const added = addFile(empty(), 880, 'readme', new Uint8Array([1]));
  if (!added.ok) throw new Error('setup');
  const v0 = readVolume(added.adf);
  if (!v0.ok) return;
  const r = renameEntry(added.adf, 880, v0.root[0].block, 'README');
  if (!r.ok) throw new Error('rename failed');
  const v = readVolume(r.adf);
  if (!v.ok) return;
  // A self-referential pointer here would be CONTAINED by walkDirectory's
  // cycle guard, so assert the name AND that no warning was raised.
  expect(v.root.map(e => e.name)).toEqual(['README']);
  expect(v.warnings).toEqual([]);
});

it('refuses a name already in the directory', () => {
  let adf = empty();
  for (const n of ['a.txt', 'b.txt']) {
    const r = addFile(adf, 880, n, new Uint8Array([1]));
    if (!r.ok) throw new Error('setup');
    adf = r.adf;
  }
  const v0 = readVolume(adf);
  if (!v0.ok) return;
  const a = v0.root.find(e => e.name === 'a.txt')!;
  expect(renameEntry(adf, 880, a.block, 'b.txt')).toEqual({ ok: false, reason: 'name-exists' });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/write.test.ts -t rename`
Expected: FAIL — `renameEntry is not a function`.

- [ ] **Step 3: Implement**

Unlink using `predecessorOf` from Task 5, then write the new name with `putName`, then link into the bucket the new name hashes to. **Unlink fully before inserting**, so the same-bucket case is an ordinary insert into a chain the entry is no longer part of.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/adffs/write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/write.test.ts
git commit -m "Rename an entry, including into the bucket it just left"
```

---

### Task 7: Replace a file's contents

**Files:**
- Modify: `src/lib/adffs/write.ts`, `src/lib/adffs/write.test.ts`

**Interfaces:**
- Produces: `export function replaceFile(adf: Uint8Array, entryBlock: number, bytes: Uint8Array): WriteResult`

- [ ] **Step 1: Write the failing tests**

```ts
it('replaces contents and KEEPS the header block', () => {
  const added = addFile(empty(), 880, 'cfg.txt', new TextEncoder().encode('old'));
  if (!added.ok) throw new Error('setup');
  const v0 = readVolume(added.adf);
  if (!v0.ok) return;
  const block = v0.root[0].block;

  const next = new TextEncoder().encode('a much longer replacement value');
  const r = replaceFile(added.adf, block, next);
  if (!r.ok) throw new Error('replace failed');
  const v = readVolume(r.adf);
  if (!v.ok) return;

  // D-W-6: the block number is the file's identity and the download route
  // addresses by it, so it must survive an edit.
  expect(v.root[0].block).toBe(block);
  expect(v.root[0].name).toBe('cfg.txt');
  expect(v.root[0].sizeBytes).toBe(next.length);
  expect(Array.from(readFile(r.adf, block)!.bytes)).toEqual(Array.from(next));
});

it('returns the old data blocks when the new contents are smaller', () => {
  const added = addFile(empty(), 880, 'shrink.bin', new Uint8Array(20 * 512).fill(1));
  if (!added.ok) throw new Error('setup');
  const v0 = readVolume(added.adf);
  if (!v0.ok) return;
  const before = readUsage(added.adf)!.freeBlocks;

  const r = replaceFile(added.adf, v0.root[0].block, new Uint8Array(512).fill(2));
  if (!r.ok) throw new Error('replace failed');
  expect(readUsage(r.adf)!.freeBlocks).toBeGreaterThan(before);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/write.test.ts -t replace`
Expected: FAIL — `replaceFile is not a function`.

- [ ] **Step 3: Implement**

Collect and free the old data and extension blocks, allocate the new ones, rewrite the header's pointer list, size and date. **Allocate before freeing is wrong here** — free first, so a replacement that fits only because the old blocks came back still succeeds. On a `disk-full` failure, return the untouched original: work on the copy and discard it.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/adffs/write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/write.test.ts
git commit -m "Replace a file's contents, keeping its header block"
```

---

### Task 8: Directories

**Files:**
- Modify: `src/lib/adffs/write.ts`, `src/lib/adffs/write.test.ts`

**Interfaces:**
- Produces:
  - `export function makeDirectory(adf: Uint8Array, parentBlock: number, name: string): WriteResult`
  - `deleteEntry` (Task 5) gains recursive behaviour for `ST_USERDIR`.

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a directory you can add a file into', () => {
  const d = makeDirectory(empty(), 880, 'tools');
  if (!d.ok) throw new Error('mkdir failed');
  const v0 = readVolume(d.adf);
  if (!v0.ok) return;
  expect(v0.root[0].kind).toBe('dir');

  const f = addFile(d.adf, v0.root[0].block, 'inside.txt', new Uint8Array([1]));
  if (!f.ok) throw new Error('add failed');
  const v = readVolume(f.adf);
  if (!v.ok) return;
  expect(v.root[0].children.map(c => c.name)).toEqual(['inside.txt']);
});

it('deletes a non-empty directory and frees everything under it', () => {
  const baseline = readUsage(empty())!.freeBlocks;
  const d = makeDirectory(empty(), 880, 'tools');
  if (!d.ok) throw new Error('mkdir');
  const v0 = readVolume(d.adf);
  if (!v0.ok) return;
  const dir = v0.root[0].block;
  let adf = d.adf;
  for (const n of ['a.txt', 'b.txt']) {
    const r = addFile(adf, dir, n, new Uint8Array(1000).fill(4));
    if (!r.ok) throw new Error('add');
    adf = r.adf;
  }

  const r = deleteEntry(adf, 880, dir);
  if (!r.ok) throw new Error('rmdir failed');
  const v = readVolume(r.adf);
  if (!v.ok) return;
  expect(v.root).toEqual([]);
  expect(readUsage(r.adf)!.freeBlocks).toBe(baseline);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/write.test.ts -t director`
Expected: FAIL — `makeDirectory is not a function`.

- [ ] **Step 3: Implement**

`makeDirectory` allocates one block, writes `T_HEADER` / `ST_USERDIR` with 72 zero hash slots, the name, a date and the parent pointer, then links it in exactly as `addFile` does.

`deleteEntry` on a `ST_USERDIR` walks its children with the module's existing traversal and deletes each one depth-first before unlinking and freeing the directory itself. Bound the recursion with `MAX_DEPTH` from `constants.ts`, which already exists for this reason.

- [ ] **Step 4: Run the whole module**

Run: `pnpm vitest run src/lib/adffs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/write.test.ts
git commit -m "Create and recursively delete directories"
```

---

### Task 9: Prove every operation against xdftool

The spine of the increment. Spec §8. Unit tests cannot judge a bitmap, because the code that would judge it is the code under test.

**Files:**
- Modify: `scripts/adffs-verify.ts`

- [ ] **Step 1: Add the round-trip checks**

For each of OFS and FFS, and for each operation, write the result to a temp image and require three things:

```ts
function proves(label: string, adf: Uint8Array, expectNames: string[]) {
  const image = join(dir, `${label.replace(/\W/g, '')}.adf`);
  writeFileSync(image, adf);

  let listing = '';
  try { listing = xdftool(image, 'list'); } catch (e) { listing = String(e); }
  check(`${label}: xdftool lists it`, !/FSError/.test(listing));
  for (const n of expectNames) {
    check(`${label}: xdftool sees ${n}`, listing.toUpperCase().includes(n.toUpperCase()));
  }

  // THE ONE THAT MATTERS: they allocate out of OUR bitmap and believe it.
  let wrote = true;
  try { xdftool(image, 'write', payload, 'theirs.txt'); } catch { wrote = false; }
  check(`${label}: xdftool writes into it`, wrote);

  // ...and we can still read the disk after their write.
  const back = readVolume(readFileSync(image));
  check(`${label}: our reader still reads it`, back.ok);
}
```

Cover: add, add-large (past 72 data blocks), rename, replace, mkdir, add-into-dir, delete-file, delete-dir.

- [ ] **Step 2: Add the sharpest case — delete then refill**

```ts
// Add a file large enough to matter, delete it, then make xdftool write a
// file that only FITS if those blocks really came back. A wrong free either
// fails here or silently double-allocates over live data.
let adf = formatVolume({ filesystem: 'FFS', volumeName: 'Reuse' });
const big = new Uint8Array(700 * 512).fill(1);
const added = addFile(adf, 880, 'big.bin', big);
if (!added.ok) throw new Error('setup');
const v = readVolume(added.adf);
if (!v.ok) throw new Error('setup');
const deleted = deleteEntry(added.adf, 880, v.root[0].block);
if (!deleted.ok) throw new Error('setup');

const image = join(dir, 'reuse.adf');
writeFileSync(image, deleted.adf);
writeFileSync(bigPayload, big);            // same size as what we freed
let refilled = true;
try { xdftool(image, 'write', bigPayload, 'refill.bin'); } catch { refilled = false; }
check('freed blocks are genuinely reusable by xdftool', refilled);
```

- [ ] **Step 3: Run it**

Run: `pnpm adffs:verify`
Expected: every check passes.

- [ ] **Step 4: Mutation-prove the two that carry the weight**

- In `alloc.ts`'s `free`, make it a no-op. Re-run. Expected: the delete-then-refill check FAILS. Restore.
- In `alloc.ts`'s `allocate`, drop the `rechecksum` call. Re-run. Expected: the "xdftool lists it" checks FAIL. Restore.

Record both outcomes in the commit message. **A check that has never failed has not been shown to work.**

- [ ] **Step 5: Commit**

```bash
git add scripts/adffs-verify.ts
git commit -m "Check every file operation against xdftool, not against ourselves"
```

---

### Task 10: The API routes

**Files:**
- Create: `src/app/api/disks/[id]/files/route.ts` (POST)
- Modify: `src/app/api/disks/[id]/files/[block]/route.ts` (add PATCH and DELETE)
- Create: `src/lib/disk-write.ts`
- Create: `src/lib/disk-write.test.ts`

**Interfaces:**
- Produces: `export async function applyDiskEdit(orgId: string, diskId: string, edit: (adf: Uint8Array) => WriteResult): Promise<{ ok: true; sha256: string } | { ok: false; status: number; reason: string }>`

- [ ] **Step 1: Write the failing test for the shared path**

```ts
it('refuses when a device has the disk mounted', async () => { /* ... */ });
it('keeps disks.id and changes disks.sha256', async () => { /* ... */ });
it('never deletes the old blob', async () => { /* ... */ });
```

Write these against the same helpers `volume-name`'s tests use.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/disk-write.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `applyDiskEdit`**

One place for the whole sequence, so three routes cannot drift:

1. Load the disk scoped by `orgId`. Not found for this org gives **404, never 403** — the response must not confirm the disk exists.
2. **Refuse with 409 if any device has this disk as `mountedSha256` or `desiredSha256`** (D-W-4), naming the device.
3. Fetch the blob, apply `edit`, map a `WriteResult` error to a 400 with its reason.
4. Hash the new bytes, `diskStore.put`, insert `blobs` and `entitlements` rows, repoint `disks.sha256`, leave `disks.id` alone.
5. Never delete the old blob (§7).

- [ ] **Step 4: Wire the three routes to it**

POST adds a file or directory, PATCH renames or replaces, DELETE removes. Each is a thin call into `applyDiskEdit` with a closure.

- [ ] **Step 5: Run tests, build and lint**

Run: `pnpm vitest run && pnpm build && pnpm lint`
Expected: vitest green, build clean, lint at exactly 3 errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/disks src/lib/disk-write.ts src/lib/disk-write.test.ts
git commit -m "Add the file-operation routes, refusing a mounted disk"
```

---

### Task 11: The files page

**Files:**
- Modify: `src/app/(app)/disks/[id]/files/page.tsx`
- Create: `src/components/disks/file-actions.tsx`

- [ ] **Step 1: Add the controls**

An upload control, a new-folder control, and per-row rename and delete on the existing tree. Follow the Base UI menu pattern in `src/components/ui/dropdown-menu.tsx` for the per-row actions, and note the trap recorded in `e2e/game-detail.spec.ts`: an overlay popup anchored to one row can cover the row below it. In a list, prefer inline expansion over an overlay.

- [ ] **Step 2: Add the identity-loss confirmation**

When the disk currently matches a TOSEC entry, the first edit shows a confirmation stating that the edit will drop its identity (D-W-3). Say what it does, not just "are you sure".

- [ ] **Step 3: State the refusals rather than hiding the controls**

A disk with an untrusted bitmap shows the controls disabled with the reason, so "this disk is unusual" is distinguishable from "this feature is missing" (§6). Same for a mounted disk, naming the device to eject it from.

- [ ] **Step 4: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: build clean, lint at 3 errors.

- [ ] **Step 5: Commit**

```bash
git add src/app src/components/disks
git commit -m "Add file controls to the disk browse page"
```

---

### Task 12: End-to-end, and the handoff

**Files:**
- Create: `e2e/disk-files-edit.spec.ts`
- Modify: `e2e/mobile.spec.ts`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Write the e2e specs**

Cover, each asserting on the BYTES through `GET /api/disks/[id]/adf` rather than on the page alone:

- upload a file, then read it back out of the disk;
- delete it, and confirm the disk's digest changed while its id did not;
- rename, and new folder;
- the 409 when a device has the disk mounted;
- the identity-loss confirmation on a TOSEC-matched disk;
- a cross-tenant request getting 404.

Use `createAdf(page)` from `e2e/helpers.ts` to make the disk.

- [ ] **Step 2: Add one mobile spec**

The upload and per-row actions at 390×844, asserting the controls are inside the viewport. The Base UI menu does **not** clamp an over-wide popup back on screen — proven 2026-09-04 — so this is a real check, not a formality.

- [ ] **Step 3: Run everything**

Run: `pnpm vitest run && pnpm build && pnpm lint && pnpm e2e && pnpm adffs:verify`
Expected: vitest green, build clean, lint at 3 errors, Playwright green, verify green.

If a spec fails, **re-run it alone before concluding a regression** — a cold-compile timeout and a teardown collision both look like failures and are not.

- [ ] **Step 4: Write the handoff section**

Add `### 3u` to `HANDOFF.md` covering: what shipped, the fixture-bitmap finding from Task 1 and why it mattered, the two mutation proofs from Task 9, and the two rulings (D-W-3, D-W-4). Update the status table.

- [ ] **Step 5: Commit**

```bash
git add e2e HANDOFF.md
git commit -m "Cover file operations end to end, and record the increment"
```

---

## Self-review

**Spec coverage.** §1 → Task 1. §2 in-scope items → Tasks 4 to 8 and 11. §3 facts → constraints, plus Tasks 3, 5, 6 and 7 specifically. §4 module design → Tasks 2, 3, 4. §5 operations → Tasks 4 to 8. §6 untrusted bitmap → Tasks 3, 4 and 11 step 3. §7 surfaces → Tasks 10 and 11. §8 testing → every task, with Task 9 the spine. §9 out-of-scope → nothing implements them, by design. §10 decisions: D-W-1 Task 1, D-W-2 Tasks 2 and 4, D-W-3 Task 11, D-W-4 Task 10, D-W-5 Tasks 3 and 4, D-W-6 Task 7, D-W-7 Task 4.

**Type consistency.** `WriteResult` and `WriteError` are defined once in Task 4 and used unchanged in 5 to 8 and 10. `allocate`/`free`/`isFree`/`bitmapPage` are defined in Task 3 and called by those names thereafter. `nameHash` is defined in Task 2 and used in 4, 5 and 6. `deleteEntry` is defined in Task 5 and extended, not renamed, in Task 8.

**Known thin spots**, flagged rather than hidden. Task 10's step 1 lists test names without bodies, because the shapes depend on helpers in `volume-name`'s existing tests that the implementer should copy rather than have restated wrongly here. Task 11 has no code because it is layout against an existing page whose structure the implementer will be reading anyway.
