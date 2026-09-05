# ADF Drag and Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop files and folders from the operating system onto a disk image, reviewing what will be written before it is written, and drag entries between directories inside the disk.

**Architecture:** Dropping never writes. It fills a staging list that computes the real block cost, shortens over-long names visibly and blocks on collisions. Committing applies every create to ONE in-memory image through the existing `applyDiskEdit`, so one gesture makes one new blob. Moving inside the disk is a new pure `moveEntry` operation reached by the same drag context.

**Tech Stack:** TypeScript, Next.js App Router, dnd-kit, Drizzle, Vercel Blob, vitest, Playwright, amitools `xdftool` (hand-run, not CI).

**Spec:** `docs/superpowers/specs/2026-09-05-adf-drag-and-drop-design.md`

## Global Constraints

- **Fit is computed in BLOCKS, never bytes** (D-DD-5). A file costs 1 header + `ceil(size/perBlock)` data (minimum 1) + 1 `T_LIST` per 72 data blocks beyond the first 72. A directory costs 1 block. `perBlock` is 512 on FFS and 488 on OFS.
- **A move must refuse a destination inside its own subtree** (D-DD-6). Our reader's cycle guard would hide the corruption.
- **Names are capped at 30 characters and compare case-insensitively.** `nameHash` upper-cases before hashing, so `Readme` and `README` are one slot in one directory.
- **Dropping stages; it never writes** (D-DD-2).
- **Collisions are never resolved automatically** (D-DD-4). Skip, replace or rename, chosen per row; commit disabled until none remain.
- **One commit writes one blob** (D-DD-3).
- **Every drag gesture has a keyboard equivalent** (D-DD-7).
- **Operations never mutate their input; never throw; return the `WriteResult` union.**
- **A SET BIT in the bitmap means FREE.** Spec D-W-5: an untrusted bitmap makes a disk unwritable.
- **`disks.id` never changes; `disks.sha256` does.** The old blob is never deleted. Another org gets 404, never 403. Editing a MOUNTED disk is refused with 409 (D-W-4).
- **Lint baseline is exactly 3 pre-existing errors.** Do not add a fourth.

---

### Task 1: `moveEntry`

The only new filesystem operation. Everything else in this plan is UI, arithmetic or plumbing.

**Files:**
- Modify: `src/lib/adffs/write.ts`
- Modify: `src/lib/adffs/write.test.ts`
- Modify: `src/lib/adffs/index.ts`

**Interfaces:**
- Consumes: `predecessorOf(adf, dir, entry, name, intl)` returning `{kind:'slot',offset} | {kind:'entry',offset,block} | null`, `linkIntoDirectory(adf, dir, entry, name, intl)`, `entryNamed(adf, dir, name, intl, exclude?)` — all already private in `write.ts`. `bitmapPage` from `./alloc`, `readBoot` from `./boot`, `recheck` from `./write-blocks`.
- Produces: `export function moveEntry(adf: Uint8Array, fromParent: number, entryBlock: number, toParent: number): WriteResult`. Task 6 calls it from the PATCH route.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/adffs/write.test.ts`:

```ts
it('moves a file into a subdirectory and out again', () => {
  const d = makeDirectory(empty(), 880, 'tools');
  if (!d.ok) throw new Error('mkdir');
  const v0 = readVolume(d.adf);
  if (!v0.ok) return;
  const dir = v0.root[0].block;

  const withFile = addFile(d.adf, 880, 'move.txt', new TextEncoder().encode('hi'));
  if (!withFile.ok) throw new Error('add');
  const v1 = readVolume(withFile.adf);
  if (!v1.ok) return;
  const file = v1.root.find((e) => e.name === 'move.txt')!;

  const moved = moveEntry(withFile.adf, 880, file.block, dir);
  expect(moved.ok).toBe(true);
  if (!moved.ok) return;
  const v2 = readVolume(moved.adf);
  if (!v2.ok) return;
  // Gone from the root, present in the directory, SAME block number.
  expect(v2.root.map((e) => e.name)).toEqual(['tools']);
  expect(v2.root[0].children.map((e) => e.name)).toEqual(['move.txt']);
  expect(v2.root[0].children[0].block).toBe(file.block);
  expect(v2.warnings).toEqual([]);

  // ...and back to the root.
  const back = moveEntry(moved.adf, dir, file.block, 880);
  if (!back.ok) throw new Error('move back');
  const v3 = readVolume(back.adf);
  if (!v3.ok) return;
  expect(v3.root.map((e) => e.name).sort()).toEqual(['move.txt', 'tools']);
});

it('REFUSES moving a directory into its own descendant', () => {
  // THE CORRUPTION THIS EXISTS TO PREVENT. A cycle here is invisible to our
  // own reader: walkDirectory's cycle guard would contain it and report a
  // plausible listing while the disk is unwalkable on a real Amiga.
  let adf = empty();
  const outer = makeDirectory(adf, 880, 'outer');
  if (!outer.ok) throw new Error('mkdir');
  adf = outer.adf;
  const vo = readVolume(adf);
  if (!vo.ok) return;
  const outerBlock = vo.root[0].block;

  const inner = makeDirectory(adf, outerBlock, 'inner');
  if (!inner.ok) throw new Error('mkdir inner');
  adf = inner.adf;
  const vi = readVolume(adf);
  if (!vi.ok) return;
  const innerBlock = vi.root[0].children[0].block;

  expect(moveEntry(adf, 880, outerBlock, innerBlock)).toEqual({ ok: false, reason: 'cycle' });
  // ...and into ITSELF.
  expect(moveEntry(adf, 880, outerBlock, outerBlock)).toEqual({ ok: false, reason: 'cycle' });
});

it('refuses a name already taken in the destination', () => {
  const d = makeDirectory(empty(), 880, 'tools');
  if (!d.ok) throw new Error('mkdir');
  const v0 = readVolume(d.adf);
  if (!v0.ok) return;
  const dir = v0.root[0].block;

  let adf = d.adf;
  for (const parent of [880, dir]) {
    const r = addFile(adf, parent, 'same.txt', new Uint8Array([1]));
    if (!r.ok) throw new Error('add');
    adf = r.adf;
  }
  const v1 = readVolume(adf);
  if (!v1.ok) return;
  const atRoot = v1.root.find((e) => e.name === 'same.txt')!;
  expect(moveEntry(adf, 880, atRoot.block, dir)).toEqual({ ok: false, reason: 'name-exists' });
});

it('touches neither the bitmap nor the input', () => {
  const d = makeDirectory(empty(), 880, 'tools');
  if (!d.ok) throw new Error('mkdir');
  const v0 = readVolume(d.adf);
  if (!v0.ok) return;
  const withFile = addFile(d.adf, 880, 'x.txt', new Uint8Array([1]));
  if (!withFile.ok) throw new Error('add');
  const v1 = readVolume(withFile.adf);
  if (!v1.ok) return;
  const file = v1.root.find((e) => e.name === 'x.txt')!;

  const before = readUsage(withFile.adf)!.freeBlocks;
  const copy = withFile.adf.slice();
  const moved = moveEntry(withFile.adf, 880, file.block, v0.root[0].block);
  if (!moved.ok) throw new Error('move');
  // A move relinks pointers; it allocates and frees nothing.
  expect(readUsage(moved.adf)!.freeBlocks).toBe(before);
  expect(Array.from(withFile.adf)).toEqual(Array.from(copy));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/lib/adffs/write.test.ts -t move`
Expected: FAIL — `moveEntry is not a function`.

- [ ] **Step 3: Add `'cycle'` to the error union and implement**

In `write.ts`, extend `WriteError` with `| 'cycle'`, then:

```ts
/** Every block from `entry` up to the root, following each header's parent. */
function ancestryOf(adf: Uint8Array, entry: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur = entry;
  // MAX_DEPTH bounds a crafted image; `seen` bounds one that already has a
  // cycle, so this cannot spin on a disk that is already broken.
  for (let i = 0; i < MAX_DEPTH && cur !== 0 && !seen.has(cur); i++) {
    chain.push(cur);
    seen.add(cur);
    if (cur === ROOT_BLOCK) break;
    cur = be32(adf, cur * BLOCK_BYTES + 500);
  }
  return chain;
}

export function moveEntry(
  adf: Uint8Array, fromParent: number, entryBlock: number, toParent: number,
): WriteResult {
  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-filesystem' };
  if (bitmapPage(adf) === null) return { ok: false, reason: 'bitmap-untrusted' };

  const header = blockAt(adf, entryBlock);
  if (!header || be32(header, 0) !== T_HEADER) return { ok: false, reason: 'not-found' };
  if (be32(header, 500) !== fromParent) return { ok: false, reason: 'not-found' };

  const dest = blockAt(adf, toParent);
  if (!dest) return { ok: false, reason: 'not-found' };
  const destKind = i32(dest, 508);
  if (toParent !== ROOT_BLOCK && destKind !== ST_USERDIR) {
    return { ok: false, reason: 'not-a-directory' };
  }

  // D-DD-6, and the order matters: check the cycle BEFORE the name, so
  // dragging a folder into itself reports why rather than "name-exists".
  if (ancestryOf(adf, toParent).includes(entryBlock)) return { ok: false, reason: 'cycle' };

  const name = bcplString(header, 432, 30);
  if (entryNamed(adf, toParent, name, boot.intl)) return { ok: false, reason: 'name-exists' };

  const out = adf.slice();
  const pred = predecessorOf(out, fromParent, entryBlock, name, boot.intl);
  if (!pred) return { ok: false, reason: 'not-found' };

  const nextHash = be32(out, entryBlock * BLOCK_BYTES + 496);
  putBe32(out, pred.offset, nextHash);
  if (pred.kind === 'slot') recheck(out, fromParent); else recheck(out, pred.block);

  putBe32(out, entryBlock * BLOCK_BYTES + 500, toParent);   // reparent
  putBe32(out, entryBlock * BLOCK_BYTES + 496, 0);          // clear stale next
  linkIntoDirectory(out, toParent, entryBlock, name, boot.intl);
  return { ok: true, adf: out };
}
```

Re-export `moveEntry` from `index.ts` alongside the others.

- [ ] **Step 4: Run the module**

Run: `pnpm vitest run src/lib/adffs`
Expected: PASS, all files.

- [ ] **Step 5: Prove the cycle refusal is load-bearing**

Comment out the `ancestryOf(...)` check, re-run the cycle test. Expected: it FAILS, and `readVolume` on the result reports a hash-chain cycle warning rather than an error. Restore. Report both outputs — this is the check that stands between a drag and a disk no Amiga can walk.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/write.test.ts src/lib/adffs/index.ts
git commit -m "Move an entry between directories, refusing a cycle"
```

---

### Task 2: The block-cost calculator

Free space is blocks. A byte comparison reports that a folder fits and then fails on commit.

**Files:**
- Create: `src/lib/adffs/capacity.ts`
- Create: `src/lib/adffs/capacity.test.ts`
- Modify: `src/lib/adffs/index.ts`

**Interfaces:**
- Consumes: `BLOCK_BYTES`, `HASH_TABLE_SIZE`, `OFS_DATA_BYTES` from `./constants`; `Filesystem` from `./boot`.
- Produces:
  ```ts
  export interface CostItem { kind: 'file' | 'dir'; sizeBytes: number }
  export function blocksForFile(sizeBytes: number, fs: Filesystem): number
  export function blocksForPlan(items: readonly CostItem[], fs: Filesystem): number
  ```
  Task 8's staging UI and Task 6's batch route both call `blocksForPlan`.

- [ ] **Step 1: Write the failing tests**

```ts
import { blocksForFile, blocksForPlan } from './capacity';

it('costs a small file as one header plus one data block', () => {
  expect(blocksForFile(10, 'FFS')).toBe(2);
  expect(blocksForFile(10, 'OFS')).toBe(2);
});

it('costs an EMPTY file as one header plus one data block', () => {
  // AmigaDOS still gives a zero-length file a data block; addFile allocates
  // Math.max(1, ...) and this must agree with it or the estimate drifts.
  expect(blocksForFile(0, 'FFS')).toBe(2);
});

it('uses 488 payload bytes on OFS and 512 on FFS', () => {
  expect(blocksForFile(512, 'FFS')).toBe(2);      // 1 data block exactly
  expect(blocksForFile(512, 'OFS')).toBe(3);      // 512 > 488, so two
});

it('adds an extension block past 72 data blocks', () => {
  expect(blocksForFile(72 * 512, 'FFS')).toBe(73);        // header + 72, no ext
  expect(blocksForFile(73 * 512, 'FFS')).toBe(75);        // header + 73 + 1 ext
  expect(blocksForFile(144 * 512, 'FFS')).toBe(146);      // header + 144 + 1
  expect(blocksForFile(145 * 512, 'FFS')).toBe(148);      // header + 145 + 2
});

it('costs a directory as one block, and sums a plan', () => {
  expect(blocksForPlan([{ kind: 'dir', sizeBytes: 0 }], 'FFS')).toBe(1);
  // THE POINT OF THIS MODULE: a hundred 1KB files is ~100KB of content and
  // ~300 blocks (150KB) of disk, so bytes would say it fits when it does not.
  const many = Array.from({ length: 100 }, () => ({ kind: 'file' as const, sizeBytes: 1024 }));
  expect(blocksForPlan(many, 'FFS')).toBe(300);   // each: 1 header + 2 data
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/capacity.test.ts`
Expected: FAIL — `Cannot find module './capacity'`.

- [ ] **Step 3: Implement**

```ts
export function blocksForFile(sizeBytes: number, fs: Filesystem): number {
  const perBlock = fs === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
  const data = Math.max(1, Math.ceil(sizeBytes / perBlock));
  const ext = Math.max(0, Math.ceil((data - HASH_TABLE_SIZE) / HASH_TABLE_SIZE));
  return 1 + data + ext;
}

export function blocksForPlan(items: readonly CostItem[], fs: Filesystem): number {
  return items.reduce(
    (n, i) => n + (i.kind === 'dir' ? 1 : blocksForFile(i.sizeBytes, fs)),
    0,
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/adffs/capacity.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Check the estimate against the real writer**

Add one test that builds a plan, applies the same creates with `addFile`/`makeDirectory`, and asserts the measured drop in `readUsage().freeBlocks` equals `blocksForPlan` exactly:

```ts
it('agrees with what addFile actually allocates', () => {
  const start = syntheticVolume({ filesystem: 'FFS', volumeName: 'Cost' });
  const before = readUsage(start)!.freeBlocks;
  const bytes = new Uint8Array(73 * 512).fill(1);   // forces an extension block
  const r = addFile(start, 880, 'big.bin', bytes);
  if (!r.ok) throw new Error('add');
  const spent = before - readUsage(r.adf)!.freeBlocks;
  expect(spent).toBe(blocksForFile(bytes.length, 'FFS'));
});
```

An estimate that disagrees with the allocator is worse than none: it is what makes the staging area promise a fit and then fail.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adffs/capacity.ts src/lib/adffs/capacity.test.ts src/lib/adffs/index.ts
git commit -m "Cost a plan in blocks, because bytes lie about whether it fits"
```

---

### Task 3: The name policy

**Files:**
- Create: `src/lib/staging.ts`
- Create: `src/lib/staging.test.ts`

**Interfaces:**
- Consumes: `nameHash` is NOT used here; case-folding must match it though — reuse `sameName`'s rule by exporting it from `write.ts` if it is not already exported.
- Produces:
  ```ts
  export interface StagedEntry {
    path: string;            // as dropped, e.g. "Workbench/C/Assign"
    kind: 'file' | 'dir';
    sizeBytes: number;
    name: string;            // what will be written, after shortening
    shortened: boolean;
    collidesWith: 'existing' | 'staged' | null;
  }
  export function shortenName(name: string): string
  export function stageDrop(
    dropped: readonly { path: string; kind: 'file' | 'dir'; sizeBytes: number }[],
    existingNamesByDir: ReadonlyMap<string, readonly string[]>,
  ): StagedEntry[]
  ```
  Task 8 renders these rows.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps a short name and marks a long one shortened', () => {
  expect(shortenName('README')).toBe('README');
  const long = 'MyVeryLongDocumentFileName.txt';   // 30 exactly
  expect(shortenName(long)).toBe(long);
  const longer = `x${long}`;                        // 31
  expect(shortenName(longer)).toHaveLength(30);
});

it('keeps the extension when it shortens', () => {
  // A name AmigaDOS can hold is worth more than a prefix: "Startup-Seq.txt"
  // is usable, "MyVeryLongDocumentFileNameXX.t" is not.
  const out = shortenName('AnAbsurdlyLongFileNameIndeedYes.info');
  expect(out).toHaveLength(30);
  expect(out.endsWith('.info')).toBe(true);
});

it('flags a collision with an existing entry', () => {
  const staged = stageDrop(
    [{ path: 'README', kind: 'file', sizeBytes: 10 }],
    new Map([['', ['readme']]]),   // case-insensitive: readme === README
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/staging.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shortenName` keeps the extension: split on the last `.`, trim the stem so stem plus extension is 30, and fall back to a plain 30-character truncation when the extension alone is 30 or longer. `stageDrop` groups by parent path, folds case the same way `sameName` does, checks each staged name against the destination's existing names first and then against names already staged in the same directory.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/staging.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add src/lib/staging.ts src/lib/staging.test.ts
git commit -m "Shorten over-long names visibly and detect both kinds of collision"
```

---

### Task 4: The batch edit

**Files:**
- Modify: `src/lib/adffs/write.ts`
- Modify: `src/lib/adffs/write.test.ts`

**Interfaces:**
- Consumes: `addFile`, `makeDirectory`, `replaceFile`, `WriteResult`.
- Produces:
  ```ts
  export type BatchOp =
    | { op: 'mkdir'; parentPath: string; name: string }
    | { op: 'add'; parentPath: string; name: string; bytes: Uint8Array }
    | { op: 'replace'; parentPath: string; name: string; bytes: Uint8Array };
  export function applyBatch(ops: readonly BatchOp[]): (adf: Uint8Array) => WriteResult
  ```
  Task 6's route passes the returned function straight to `applyDiskEdit`.

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a nested tree in ONE pass, parents before children', () => {
  const run = applyBatch([
    { op: 'mkdir', parentPath: '', name: 'C' },
    { op: 'add', parentPath: 'C', name: 'Assign', bytes: new TextEncoder().encode('a') },
    { op: 'mkdir', parentPath: '', name: 'S' },
    { op: 'add', parentPath: 'S', name: 'Startup', bytes: new TextEncoder().encode('s') },
  ]);
  const r = run(empty());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const v = readVolume(r.adf);
  if (!v.ok) return;
  expect(v.root.map((e) => e.name).sort()).toEqual(['C', 'S']);
  const c = v.root.find((e) => e.name === 'C')!;
  expect(c.children.map((e) => e.name)).toEqual(['Assign']);
});

it('resolves a parent path created EARLIER IN THE SAME BATCH', () => {
  // The reason paths are used rather than block numbers: a directory made in
  // this batch has no block number the caller could have known.
  const r = applyBatch([
    { op: 'mkdir', parentPath: '', name: 'A' },
    { op: 'mkdir', parentPath: 'A', name: 'B' },
    { op: 'add', parentPath: 'A/B', name: 'deep.txt', bytes: new Uint8Array([1]) },
  ])(empty());
  if (!r.ok) throw new Error('batch failed');
  const v = readVolume(r.adf);
  if (!v.ok) return;
  expect(v.root[0].children[0].children.map((e) => e.name)).toEqual(['deep.txt']);
});

it('fails the WHOLE batch when one operation cannot be applied', () => {
  const huge = new Uint8Array(1000 * 512).fill(1);   // will not fit
  const r = applyBatch([
    { op: 'mkdir', parentPath: '', name: 'ok' },
    { op: 'add', parentPath: '', name: 'huge.bin', bytes: huge },
  ])(empty());
  expect(r).toEqual({ ok: false, reason: 'disk-full' });
});

it('leaves the caller\'s disk untouched when it fails', () => {
  const adf = empty();
  const copy = adf.slice();
  applyBatch([{ op: 'add', parentPath: '', name: 'x'.repeat(31), bytes: new Uint8Array([1]) }])(adf);
  expect(Array.from(adf)).toEqual(Array.from(copy));
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/lib/adffs/write.test.ts -t batch`
Expected: FAIL — `applyBatch is not a function`.

- [ ] **Step 3: Implement**

```ts
export function applyBatch(ops: readonly BatchOp[]): (adf: Uint8Array) => WriteResult {
  return (adf) => {
    // ONE copy for the whole batch. Each operation returns fresh bytes, so
    // `cur` walks forward and a failure simply drops the lot -- which is what
    // makes the commit atomic without any transaction concept (D-DD-3).
    let cur = adf;
    // Paths to block numbers, seeded with the root, so a directory created
    // in this batch is addressable by the operations that follow it.
    const dirs = new Map<string, number>([['', ROOT_BLOCK]]);

    for (const op of ops) {
      const parent = dirs.get(op.parentPath);
      if (parent === undefined) return { ok: false, reason: 'not-found' };

      const r = op.op === 'mkdir' ? makeDirectory(cur, parent, op.name)
        : op.op === 'add' ? addFile(cur, parent, op.name, op.bytes)
        : replaceExisting(cur, parent, op.name, op.bytes);
      if (!r.ok) return r;
      cur = r.adf;

      if (op.op === 'mkdir') {
        const made = findChildBlock(cur, parent, op.name);
        if (made === null) return { ok: false, reason: 'not-found' };
        dirs.set(op.parentPath ? `${op.parentPath}/${op.name}` : op.name, made);
      }
    }
    return { ok: true, adf: cur };
  };
}
```

`replaceExisting` resolves the named entry in `parent` and calls `replaceFile` on its block, returning `not-found` when it is absent. `findChildBlock` walks `parent` and returns the block of the entry with that name.

**Ordering is the caller's job**, and Task 6 sorts by path depth so a parent is always created before its children. Do not sort here: a batch is applied exactly as given, which is what makes it testable.

- [ ] **Step 4: Run the module**

Run: `pnpm vitest run src/lib/adffs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adffs/write.ts src/lib/adffs/write.test.ts
git commit -m "Apply many creates to one image, so one commit is one blob"
```

---

### Task 5: Prove the batch and the move against xdftool

**Files:**
- Modify: `scripts/adffs-verify.ts`

- [ ] **Step 1: Add both cases**

Follow the script's existing `proves(label, adf, expectNames)` helper, which already asserts the three things that matter: xdftool lists what we expect, **xdftool writes its own file into the result**, and our reader still reads it afterwards.

Add, for both OFS and FFS: a batch that creates `C/` with two files and `S/` with one, and a move of a file from the root into `C`.

- [ ] **Step 2: Run it**

Run: `pnpm adffs:verify`
Expected: every check passes, including the new ones.

- [ ] **Step 3: Mutation-prove the move**

In `moveEntry`, skip the `putBe32(out, entryBlock * BLOCK_BYTES + 500, toParent)` reparent line so the entry is linked into the new directory while still claiming the old parent. Re-run. Expected: xdftool reports an inconsistency on the moved entry. Restore.

This is the check that matters here: our own reader never validates a header's parent pointer when walking down from the root, so a wrong reparent is invisible to `readVolume` and visible to a real filesystem.

- [ ] **Step 4: Commit**

```bash
git add scripts/adffs-verify.ts
git commit -m "Check the batch and the move against xdftool"
```

---

### Task 6: The batch and move routes

**Files:**
- Create: `src/app/api/disks/[id]/files/batch/route.ts`
- Modify: `src/app/api/disks/[id]/files/[block]/route.ts`
- Create: `src/app/api/disks/[id]/files/batch/route.test.ts`

**Interfaces:**
- Consumes: `applyDiskEdit(orgId, diskId, edit)` from `@/lib/disk-write`, `applyBatch` and `moveEntry` from `@/lib/adffs`, `blocksForPlan` from `@/lib/adffs`.
- Produces: `POST /api/disks/[id]/files/batch` and a third PATCH body shape `{ toParent: number }`.

- [ ] **Step 1: Write the failing tests**

Mirror `src/lib/disk-write.test.ts`'s hand-written `@/db` and `@/lib/storage` fakes, and its technique of rendering captured `.where()` conditions with drizzle's `PgDialect.sqlToQuery()` so an assertion proves the query rather than the outcome. Cover: a batch that does not fit refused before any write; a mounted disk refused with 409; another org getting 404; and a successful batch changing `sha256` while `disks.id` stays.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/app/api/disks`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement**

The route parses a multipart request carrying a JSON `manifest` part plus one file part per entry. It then:

1. **Sorts by path depth** so every parent is created before its children.
2. **Pre-flight check**: read the disk, `readVolume` for the filesystem, `readUsage` for `freeBlocks`, and refuse with `disk-full` and both numbers if `blocksForPlan` exceeds it — before `applyDiskEdit` is called at all. This is what turns a failed commit into a refusal that never started.
3. Calls `applyDiskEdit(orgId, id, applyBatch(ops))`, inheriting the 409-when-mounted refusal, the 404-never-403 boundary and the one-blob-per-commit rule.

The PATCH handler gains a `toParent` branch calling `moveEntry`, alongside the existing rename and replace. Map `'cycle'` to a 400 whose reason says a folder cannot be moved inside itself.

- [ ] **Step 4: Run tests, build and lint**

Run: `pnpm vitest run && pnpm build && pnpm lint`
Expected: vitest green, build clean, lint at exactly 3 errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/disks src/lib
git commit -m "Add the batch and move routes, refusing a batch that cannot fit"
```

---

### Task 7: Reading a dropped folder

**Files:**
- Create: `src/lib/drop-reader.ts`
- Create: `src/lib/drop-reader.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DroppedItem { path: string; kind: 'file' | 'dir'; file?: File; sizeBytes: number }
  export async function readDroppedItems(items: DataTransferItemList): Promise<DroppedItem[]>
  ```
  Task 8 feeds these to `stageDrop`.

- [ ] **Step 1: Write the failing test**

The browser API is not available in vitest, so the test drives a hand-written fake shaped like `FileSystemDirectoryEntry`:

```ts
it('reads a directory in PAGES until it returns none', async () => {
  // THE TRAP: readEntries returns at most 100 per call and must be called
  // again until it returns an empty array. A single call silently truncates
  // a large folder at exactly 100 items -- green, plausible, and wrong.
  const many = Array.from({ length: 250 }, (_, i) => fakeFileEntry(`f${i}.txt`, 10));
  const dir = fakeDirEntry('Big', many);
  const out = await readDroppedItems(fakeItemList([dir]));
  expect(out.filter((e) => e.kind === 'file')).toHaveLength(250);
});

it('preserves nesting and includes empty directories', async () => {
  const tree = fakeDirEntry('Workbench', [
    fakeDirEntry('C', [fakeFileEntry('Assign', 5)]),
    fakeDirEntry('Empty', []),
  ]);
  const out = await readDroppedItems(fakeItemList([tree]));
  expect(out.map((e) => e.path).sort()).toEqual([
    'Workbench', 'Workbench/C', 'Workbench/C/Assign', 'Workbench/Empty',
  ]);
});
```

`fakeDirEntry` returns `{ isDirectory: true, name, createReader: () => ({ readEntries(cb) { /* hands back at most 100 per call, then [] */ } }) }`.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/drop-reader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Call `webkitGetAsEntry()` on every item **synchronously**, before any `await`, because the data transfer is neutered once the drop handler yields. Then walk recursively, calling `readEntries` in a loop until it returns an empty array.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/drop-reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the paging test can fail**

Change the reader to call `readEntries` once instead of looping. Re-run. Expected: the 250-file test fails with 100. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/lib/drop-reader.ts src/lib/drop-reader.test.ts
git commit -m "Read a dropped folder in pages, not just its first hundred entries"
```

---

### Task 8: The staging area

**Files:**
- Create: `src/components/disks/drop-staging.tsx`
- Modify: `src/app/(app)/disks/[id]/files/page.tsx`

- [ ] **Step 1: Build it**

A slim drop strip is **always visible** below the tree so the page advertises that it accepts a drop. Dropping expands it into the staging list.

Each row shows the source path, the name it will be written under, and its state:
- **ok** — writes as shown.
- **shortened** — the name is in an **editable field** so the result is visible and correctable.
- **collision** — shows the existing entry and offers **skip**, **replace** or **rename**. The commit button is **disabled while any collision is outstanding** (D-DD-4).

Above the list: the destination (root by default, pre-set when the drop landed on a folder row), the total block cost from `blocksForPlan`, and the free-block count. When the total exceeds free space the commit is disabled and says so **with both numbers**.

Every control gets a stable `data-testid`; list them in the report for Task 11.

- [ ] **Step 2: State refusals rather than hiding the strip**

A mounted disk, an untrusted bitmap or a disk with no filesystem disables the drop strip **with the reason**, matching how the existing toolbar already reports them.

- [ ] **Step 3: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: build clean, lint at 3 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/disks src/app
git commit -m "Stage a drop, showing what will be written and whether it fits"
```

---

### Task 9: Drag inside the disk

**Files:**
- Modify: `src/components/disks/file-tree.tsx`
- Modify: `src/components/disks/file-actions.tsx`

- [ ] **Step 1: Copy the working drag setup, do not invent one**

`src/components/collections/collection-provider.tsx` already solves every trap this will hit, and its comments explain why each line is there. Mirror it:

- **`pointerWithin` with a `rectIntersection` fallback.** dnd-kit's default resolves a drop from the DRAGGED element's rectangle, which made collection drops land in the wrong row. A file row is small and nested; the same bug applies.
- **`MouseSensor` at `distance: 8` and `TouchSensor` at `delay: 250, tolerance: 8`, deliberately two sensors rather than one `PointerSensor`.** The delay is what stops a drag eating page scrolling on a phone.
- **An explicit `id` on `DndContext`**, or the server and client markup disagree and every page load logs a hydration mismatch.

Every folder row becomes a droppable, plus the root. Every entry row becomes a draggable. Dropping calls PATCH with `{ toParent }`.

- [ ] **Step 2: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: build clean, lint at 3 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/disks
git commit -m "Drag an entry onto a folder to move it"
```

---

### Task 10: The keyboard path

A drag-only feature is unusable by keyboard, and this page has already shipped one accessibility shortcut that had to be undone.

**Files:**
- Modify: `src/components/disks/file-tree.tsx`

- [ ] **Step 1: Add "Move to…"**

Each row's inline controls gain **Move to…**, listing the disk's directories plus the root, excluding the entry itself and its own descendants — the same refusal `moveEntry` enforces, surfaced before the request rather than after it. Choosing one issues the same PATCH the drag does.

Use a real `<button>` with the native `disabled` attribute, matching the toolbar. The row already holds several buttons, so give it its own `data-testid`.

- [ ] **Step 2: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: build clean, lint at 3 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/disks
git commit -m "Move an entry from the keyboard, not only by dragging"
```

---

### Task 11: End to end, and the handoff

**Files:**
- Create: `e2e/disk-drag-drop.spec.ts`
- Modify: `e2e/mobile.spec.ts`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Write the specs**

The collections increment shipped drag-and-drop that was reviewed clean and passed build and unit tests, and still carried three defects only a real browser could reveal. These are part of the task, not a later pass.

Cover, asserting on the disk BYTES via `GET /api/disks/[id]/adf` and `readVolume` rather than on the page:

- dropping a nested folder, then reading the files back out of the disk;
- a folder that does not fit refused **with numbers, before anything is written** — assert `disks.sha256` is unchanged;
- a collision blocking the commit until it is resolved, and **replace** actually replacing;
- a move by drag, asserting the entry's block number is unchanged;
- a move by keyboard through "Move to…";
- attempting to move a folder into its own child, refused.

**Use `createAdf(page)` and wait for the card before querying the database** — `createAdf` returns while the create request is still in flight, and `e2e/disk-files-edit.spec.ts` hides that wait inside its own `authoredDisk` helper for exactly this reason.

- [ ] **Step 2: Add one mobile spec**

The drop strip and a press-and-hold drag at 390×844, asserting the staging list stays inside the viewport.

- [ ] **Step 3: Run everything**

Run: `pnpm vitest run && pnpm build && pnpm lint && pnpm adffs:verify && pnpm e2e`

**Before the e2e run**: confirm `lsof -tiTCP:3000` is empty and no `next dev` or `next-server` is alive. An orphaned dev server produces cascading `ERR_CONNECTION_REFUSED` that reads exactly like a code regression, and running suites back to back exhausts connections and hangs `/api/ingest/presign` for 30s. Both were misdiagnosed as real regressions during the last increment. If a spec fails, **re-run it alone** before concluding anything.

- [ ] **Step 4: Write the handoff**

Add `### 3v` to `HANDOFF.md` and a status-table row, covering: what shipped; that fit is computed in blocks because bytes lie; the cycle refusal and why our own reader cannot see the corruption it prevents; the `readEntries` paging trap; and the four operator rulings D-DD-1, D-DD-2, D-DD-4 and the together-in-one-increment scope call.

- [ ] **Step 5: Commit**

```bash
git add e2e HANDOFF.md
git commit -m "Cover drag and drop end to end, and record the increment"
```

---

## Self-review

**Spec coverage.** §1 workflow → Tasks 8 and 9. §2 in-scope → Tasks 1, 4, 6, 7, 8, 9, 10. §3.1 block cost → Task 2. §3.2 cycle → Task 1. §3.3 names → Task 3. §3.4 readEntries paging → Task 7. §4 staging → Tasks 3 and 8. §5 batch commit → Tasks 4 and 6. §6 move → Tasks 1, 6, 9, 10. §7 surfaces → Tasks 8, 9, 10. §8 testing → every task, with Tasks 5 and 11 the spine. §9 decisions: D-DD-1 Task 8, D-DD-2 Task 8, D-DD-3 Task 4, D-DD-4 Tasks 3 and 8, D-DD-5 Task 2, D-DD-6 Task 1, D-DD-7 Task 10.

**Type consistency.** `WriteResult` and `WriteError` come from the existing `write.ts` and gain exactly one member, `'cycle'`, in Task 1. `moveEntry`'s four-argument signature is fixed in Task 1 and used unchanged in Tasks 5, 6, 9 and 10. `blocksForPlan` is defined in Task 2 and called in Tasks 6 and 8. `StagedEntry` is defined in Task 3 and rendered in Task 8. `DroppedItem` is defined in Task 7 and fed to `stageDrop` in Task 8.

**Known thin spots, flagged rather than hidden.** Task 6's tests are described by technique and coverage rather than written out, because they depend on the `PgDialect.sqlToQuery()` fake in `disk-write.test.ts` that the implementer should copy rather than have restated wrongly here. Tasks 8, 9 and 10 carry requirements and traps rather than component code, because they are layout against files the implementer will be reading anyway; the drag setup in Task 9 is the exception and names the exact sensor values to copy.
