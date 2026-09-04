# Adding, editing and deleting files inside an ADF — design

**Written 2026-09-04.** Implements the "Add / edit / delete files through the browser" backlog
entry, requested by the operator 2026-09-01. Builds directly on the read-only reader
(`2026-09-01-adf-filesystem-reader-design.md`) and on the blank-disk writer that shipped as
HANDOFF §3n. Supersedes nothing.

---

## 1. What already exists, and the measurement that reshaped this spec

The backlog entry listed the hard parts still ahead as "allocation FROM the bitmap, hash-chain
insert and — the fiddly one — relink on delete, whose hash function differs under INTL, OFS's
24-byte data-block header, and file extension blocks."

**Four of those five are already written**, in `src/lib/adffs/synthetic.ts`, the test-fixture
builder. It implements the AmigaDOS name hash including the INTL variant (`nameHash`), OFS
data-block headers with their own checksum word, file header blocks, directory entries linked
into hash chains, and `T_LIST` extension blocks. Only the bitmap allocator is genuinely absent.

**And the code that exists produces volumes no Amiga tool will mount.** Measured 2026-09-04 by
handing four synthetic shapes to amitools' `xdftool`:

| shape | `xdftool info` | `list` | `write` |
|---|---|---|---|
| OFS, one file | FAIL | FAIL | FAIL |
| FFS, one file | FAIL | FAIL | FAIL |
| FFS INTL, one file | FAIL | FAIL | FAIL |
| FFS, nested directory | FAIL | FAIL | FAIL |

Every one fails identically and at the first command:
`FSError: Bitmap Block Count Mismatch(15): got=1 want=0`. The cause is not subtle —
`syntheticVolume()` allocates from two monotonic counters walking away from the root block and
**never writes a bitmap at all**.

**The boundary matters and is clean.** The production write path is sound: `pnpm adffs:verify`
passes all ten checks, including the decisive one where xdftool writes its own file into a disk
`formatVolume()` produced. It is only the fixtures that are invalid, and only because our reader
ignores bitmaps, so it accepts them happily.

**The consequence for this increment:** every fixture-based test in `src/lib/adffs` has been
validated against a disk shape that is not actually valid. That is the foundation a writer would
otherwise be built on, so repairing it is task one and not a cleanup at the end. The reader's
measured archive results are unaffected — `archive.test.ts` runs against 61 real disks.

---

## 2. Scope

**In:**

- **Add a file** — upload from the operator's machine into any directory of a disk.
- **Delete a file.**
- **Rename a file or directory.**
- **Replace a file's contents**, keeping its name and its header block.
- **Create a directory**, and **delete a directory** including a non-empty one.
- The surfaces for all of the above on the existing `/disks/[id]/files` page.

**Out:**

- **Write-back from the Amiga.** Unchanged from the disk-change spec §5: the device plane is
  read-only to the board, and nothing here changes that.
- **Propagating an edit to a device that has the disk mounted.** Closed by ruling D-W-4 below:
  the edit is refused while mounted, so no protocol answer is needed.
- **Editing file contents in the browser** (a text editor). Replacing contents means uploading
  different bytes.
- **Disks with no valid filesystem.** 20% of the archive and every game disk. There is nothing
  to add a file to.

---

## 3. The on-disk facts this rests on

Everything in the reader spec §3 still holds. These are the additional ones the writer needs,
and each is a place a mistake is invisible to our own reader.

**3.1 The bitmap is the only structure our reader ignores.** `usage.ts` is the sole consumer,
and it was written to return `null` rather than guess when the bitmap looks wrong. A disk with an
exactly inverted bitmap reads perfectly through `readVolume` and corrupts the moment anything
allocates from it. **This is why xdftool writing into our disk is the decisive check and a unit
test is not.**

**3.2 The bitmap block carries its own checksum**, at word 0, computed over the whole block —
not at word 5 like header blocks. `format.ts` already does this correctly; the allocator must
keep doing it after every allocation and every free.

**3.3 A set bit means FREE.** The inverse of the intuitive reading, and the same trap as the
protection bits in `dir.ts`, where a set bit means forbidden.

**3.4 The bitmap covers blocks 2..1759**, not 0..1759. The two boot blocks are outside it.
`usage.ts`'s `BITMAP_FIRST_BLOCK = 2` records this; the allocator must never hand out block 0, 1,
880 (root) or 881 (bitmap).

**3.5 An entry's predecessor may be the hash slot itself or another entry.** Unlinking on delete
has to distinguish them: the slot lives at `dirBlock + 24 + bucket * 4`, an entry's forward
pointer at `entryBlock + 496`. Getting this wrong loses every entry after the deleted one, and
the reader will report the shorter list without complaint.

**3.6 A rename can land in the same bucket it left.** Unlinking then inserting into the same
chain must not produce a self-referential pointer. `walkDirectory`'s cycle guard would contain it
at read time, which means our own reader would hide the bug.

**3.7 A file header holds 72 data-block pointers; beyond that it needs `T_LIST` extension
blocks.** At 488 payload bytes per OFS data block, a file over ~35 KB needs one. Real Workbench
disks are full of such files, so this path is exercised by ordinary use, not by an edge case.

---

## 4. Module design

`src/lib/adffs/index.ts` currently states "Read-only by design — writing needs bitmap and
hash-chain maintenance this module deliberately does not do." That sentence is retired. The
module becomes read/write and **keeps its existing shape**: pure functions over a `Uint8Array`,
no I/O, no database, entirely testable in vitest.

Every operation has the same signature shape:

```
(adf: Uint8Array, ...args) => WriteResult
type WriteResult =
  | { ok: true; adf: Uint8Array }
  | { ok: false; reason: WriteError }
```

A new array is returned; the input is never mutated. That matches how the rest of the module
behaves and makes an operation trivially retryable.

**New files:**

- **`alloc.ts`** — the bitmap allocator. `allocate(adf, n): number[] | null` and
  `free(adf, blocks)`, both maintaining the bitmap checksum. The only piece with no existing
  implementation anywhere in the repo.
- **`hash.ts`** — `nameHash`, moved out of `synthetic.ts` so one implementation serves fixtures
  and production. Moved, not copied.
- **`write.ts`** — the six operations, composed from the allocator, the hash and the block
  writers.

**Moved into shared use** rather than left in the fixture builder: `putBe32`, `putName`,
`recheck`, and the OFS data-block and extension-block writers. `synthetic.ts` keeps its
fixture-shaping options and calls the shared code, so a fixture and a production write cannot
disagree about the format.

**Errors, as a discriminated union rather than a throw**, matching `VolumeResult`:

`disk-full`, `name-too-long` (over 30 characters, the format's limit), `name-exists`,
`not-found`, `not-a-directory` (the target block is a file), `bitmap-untrusted`, and
`no-filesystem` (the disk has none to write into).

---

## 5. The operations

**Add a file.** Allocate ⌈size / payload⌉ data blocks plus one header, plus one extension block
per 72 data blocks beyond the first 72. Write the data blocks (OFS gets the 24-byte header and
its checksum; FFS is raw). Write the header with name, size, protection, date and the first 72
pointers **stored in reverse order**, which is how the format works and how `file.ts` already
reads them. Insert into the parent's chain at `nameHash(name, intl)`. Mark every allocated block
used. Update the parent's and root's modification date.

**Delete a file.** Walk the parent's chain to find the entry's predecessor (§3.5), relink around
it, then free the header, all data blocks and all extension blocks. Freeing is where a mistake
does lasting damage, because the blocks stay readable and only a later allocation collides.

**Rename.** Unlink from the old bucket, rewrite the name, insert into the bucket the new name
hashes to. §3.6 is the case worth a dedicated test.

**Replace contents.** Free the old data and extension blocks, allocate new ones, rewrite the
header's pointers and size — **keeping the header block itself**. Its block number is the file's
identity in this image (D-3-5) and `GET /api/disks/[id]/files/[block]` addresses by it, so an
edit that moved the header would break every link to the file.

**Create a directory.** A header block with `ST_USERDIR` and 72 empty hash slots, inserted into
its parent like any other entry.

**Delete a directory.** Recursive: free every descendant's blocks before the directory's own.
Bounded by `MAX_DEPTH` and by the visited-set discipline `walkDirectory` already uses, so a
crafted image cannot spin.

---

## 6. A disk whose bitmap cannot be trusted is not writable

`readUsage()` already refuses to guess, returning `null` when `bm_flag` is invalid, the bitmap
pointer is not where it should be, or the bitmap does not mark its own block used. The writer
reuses that exact test and refuses with `bitmap-untrusted`.

**This is a correctness requirement, not caution.** Allocating from an untrusted bitmap means
handing out blocks that may already hold a file's data, and the corruption would not appear until
something read that file back. "This disk cannot be edited" is an honest answer; a silently
damaged disk is not.

The UI states the reason rather than hiding the controls, because the operator should be able to
tell "this disk is unusual" from "this feature is missing".

---

## 7. Surfaces

**Server**, all under the existing route family:

- `POST /api/disks/[id]/files` — add a file or create a directory.
- `PATCH /api/disks/[id]/files/[block]` — rename, or replace contents.
- `DELETE /api/disks/[id]/files/[block]` — delete a file or directory.

Each one: load the blob, apply the pure operation, hash the result, upload a **new** blob,
repoint `disks.sha256`, leave `disks.id` alone. Identical in shape to the rename path that
shipped in 3n, and it inherits that path's rulings — the old blob is never deleted, and the
device is repointed on `desired` only.

**Every route refuses with 409 when any device has the disk mounted** (D-W-4), naming the device
so the operator knows where to eject it.

**Tenancy** matches the existing routes: another org gets 404, never 403, so the response does
not confirm the disk exists.

**UI**, on the existing `/disks/[id]/files` page: an upload control, a new-folder control, and
per-row rename and delete. A disk that currently matches a TOSEC entry shows a confirmation
before the first edit, saying the edit will drop its identity (D-W-3).

---

## 8. Testing

**Task one repairs the fixtures.** `syntheticVolume()` gains a real bitmap, and the verify
script gains a case that opens a synthetic volume with xdftool. Until that passes, nothing else
in this increment can be trusted, because everything else is tested on those fixtures.

**vitest** covers each operation, the error union, the reverse-order pointer layout, the
same-bucket rename, extension-block creation past 72 data blocks, and recursive directory
delete.

**`pnpm adffs:verify` is the spine**, extended so that after every operation we perform:

1. xdftool lists the disk and agrees with our reader about names, sizes and structure.
2. **xdftool writes its own file into the result.** This is the check that means anything: it
   proves xdftool allocated a block out of our bitmap and believed it.
3. Our reader still reads the disk after their write.

**The sharpest single case: delete, then make xdftool use the freed space.** Add a large file,
delete it, then have xdftool write a file that only fits if those blocks were really returned. A
wrong free either fails outright there or silently double-allocates. No unit test of ours can
produce that verdict, because the thing being checked is the bitmap our own reader ignores.

**Every check must be mutation-proven** before it is trusted, per the standard in
`webadf-verification-tools-on-this-machine`: break the thing deliberately and confirm the check
fails. A check that has never failed has not been shown to work.

**e2e** covers upload, delete, rename and new folder through the page, the mounted-disk refusal,
the identity-loss confirmation, and cross-tenant 404s.

---

## 9. What this deliberately leaves for later

- **Write-back from the Amiga.** Still the disk-change spec's §5 item, still undesigned.
- **Propagating an edit to a mounted device.** Closed here by refusing the edit; if that proves
  annoying in use, the protocol question is the same one the write-protect-flip backlog entry
  asks, and it should be answered once for both.
- **Editing text in the browser.** Upload replaces bytes.
- **Undo.** The old blob still exists and is never deleted, so a "revert to previous bytes"
  feature is possible later without any new storage. It is not built here.

---

## 10. Decisions

- **D-W-1. The fixture builder is repaired before anything is built on it.** Measured
  2026-09-04: xdftool rejects all four synthetic shapes because they carry no bitmap. Building a
  writer on that foundation would inherit the same invalidity everywhere.
- **D-W-2. One implementation of the format, shared by fixtures and production.** The name hash,
  block writers and extension-block logic move out of `synthetic.ts` rather than being
  reimplemented. Two implementations of one format drift, and the fixture copy is the one no
  independent tool has ever checked.
- **D-W-3. Any disk is editable; an identified one warns first.** Operator's ruling 2026-09-04.
  An edit rewrites the disk under a new digest, so a TOSEC match is lost — which the earlier
  ruling (2026-09-01) already records as the intended outcome, not a failure. The warning exists
  so it is never a surprise. The original blob is never deleted either way.
- **D-W-4. Editing a mounted disk is refused, not propagated.** Operator's ruling 2026-09-04.
  It needs no protocol answer, and nothing can change under a running Amiga. It is also the only
  option that cannot misbehave on hardware that does not exist yet — no board has ever run plan
  4a or 4b.
- **D-W-5. An untrusted bitmap makes a disk unwritable.** Reuses `readUsage()`'s existing refusal
  to guess. Allocation from a bad bitmap corrupts data that reads back fine until it does not.
- **D-W-6. Replace keeps the file's header block.** The block number is the file's identity
  (D-3-5) and the download route addresses by it.
- **D-W-7. Operations are pure and return new bytes.** Keeps the module's stated shape, keeps
  every operation testable without a database, and makes a failed write leave nothing behind.
