# Read-only ADF filesystem reader — design

**Written 2026-09-01.** Increment 3 of the operator's four-item batch. Supersedes nothing;
implements the "Read-only ADF browser" backlog entry and disk-change spec §5 item 1.

---

## 1. Why this is worth building, measured

The catalog can name **45.9%** of the operator's 61-disk archive from TOSEC and **6.6%** from
OpenRetro. Neither can name the rest, and the reason is structural: the misses are Workbench,
install and utility disks, which preservation sets under-cover and which the operator partly
built themselves.

**Those are exactly the disks that carry a filesystem.** Measured over `adf-archive/`:

| | disks | share |
|---|---|---|
| Valid, checksum-verified OFS/FFS filesystem | **49** | **80.3%** |
| DOS signature but no valid root block | 11 | 18.0% |
| No DOS signature at all | 1 | 1.6% |

So a reader reaches **80%** of this archive where TOSEC reaches 46%. And the overlap is
complementary rather than redundant: `Install3_1_4.adf`, `Workbench31 - wbench31.adf`,
`Real_Amiga_Install.ADF`, `WHDLoad185.adf` and `BestWB1..6` are all TOSEC misses with a
perfectly readable filesystem and a self-describing volume name.

The 12 that fail are games and demos with custom bootblocks — `9Fingers`, `Project-X`,
`Giana_SE_Intro`. That is the expected shape, not a defect.

**A volume name alone is not enough.** Seven disks share the volume name
`"ADF Opus Created Me!"` — a tool's default. The file list is what actually identifies a disk.

---

## 2. Scope

**In:**

- Detect and classify the filesystem: OFS/FFS, INTL, DIRC, from the boot block.
- Read the root block: volume name, creation/modification dates.
- Walk the full directory tree: names, sizes, dates, protection bits, comments.
- Read one file's contents, so a human can extract a single file.

**Out, deliberately:**

- **Any writing whatsoever.** Creating, editing and deleting is a separate, larger increment
  already in the backlog, and it needs the bitmap and hash-chain maintenance this reader
  explicitly skips.
- **Hard-disk / HDF images, and non-880K ADFs.** `assertAdf` already rejects them.
- **Cross-disk search** ("which disk holds `SetPatch`?"). That needs the listing persisted; see §9.
- **Rendering file contents in the page** (text preview, icon decoding). Download only.

---

## 3. The on-disk facts this rests on

Reference: <http://lclevy.free.fr/adflib/adf_info.html>, already cited by `mfm.c`. Every number
below was **measured against the operator's archive**, not taken on trust.

### 3.1 Geometry

512-byte blocks, 1,760 of them in an 880 KB image. The root block is at **880**, the midpoint —
not a value to derive at runtime, because a non-standard image is out of scope anyway.

### 3.2 Boot block, and the trap in it

Bytes 0–2 are `"DOS"`; byte 3 is a flag nibble: bit 0 FFS, bit 1 INTL, bit 2 DIRC.

Measured across the 49 disks with a *checksum-verified* filesystem: **25 OFS, 24 FFS, 6 INTL,
0 DIRC.** (A structural check that skipped the checksum would say 29 OFS — the extra four are the
Project-X false positives of §3.3, and they are OFS-flagged only by coincidence.)

**The boot block's own checksum MUST NOT be used as a validity test.** Measured directly against
the 49 disks that DO have a checksum-verified filesystem: **only 19 of them have a valid boot
checksum — 30 do not.** Non-bootable data disks and disks with custom boot code routinely fail it
while their filesystem is perfectly sound (`BestWB1..6`, `BPPC-FLASH.ADF` among them). Gating on
it would reject **61% of the readable archive**.

DIRC appears on no disk here. It is a *cache* layered on top of the hash chains, never a
replacement, so the reader detects it, reports it, and reads the chains regardless.

### 3.3 Root block, and the check that actually matters

Type (offset 0) = 2, secondary type (offset 508) = 1, and a checksum at offset 20 computed as the
negated 32-bit sum of the block's 128 big-endian words with the checksum word itself excluded.

**The checksum is what separates a filesystem from a coincidence, and this archive proves it.**
All four Project-X disks have type 2 and secondary type 1 at block 880 — they would pass a
structural check — but their stored "checksum" is `0x31313131`, ASCII `"1111"`. It is game data
that happens to sit at the midpoint of the disk. Without checksum validation the reader would
report a filesystem with a blank volume name on a cracked game.

So validity is: **DOS signature AND root type 2 AND secondary type 1 AND root checksum correct.**

### 3.4 Directories

A directory block carries a 72-entry hash table at offset 24. Each slot points at a chain of
entries linked through the `hash_chain` pointer at offset 496. Entry secondary type at offset 508
distinguishes a file header (**-3**) from a subdirectory (**2**).

The hash function folds the name's characters; **under INTL the case-folding covers the extended
Latin range** that plain AmigaDOS does not. Six disks here are INTL, so both variants are needed.
The reader only needs the hash function to *validate* placement, not to find entries — it walks
every slot and every chain — so a hash mismatch is reported, never fatal.

Measured over the 49 valid disks: **2,430 files in 427 directories**, maximum depth **4**, and
**zero cycles**.

### 3.5 File contents

A file header at offset 324 holds the byte size, and offsets 24–307 hold up to 72 data-block
pointers **in reverse order**. Beyond that, offset 504 points at an extension block carrying 72
more.

**Extension blocks are required, not optional: 112 of the 2,430 files need one.** The largest
file measured is **825,107 bytes** — nearly a whole disk, and far beyond the ~35 KB a single
header addresses.

Data blocks differ by filesystem, and this is the one place OFS and FFS genuinely diverge:

- **OFS** — each data block carries a 24-byte header (type, header key, sequence number, data
  length, next pointer, checksum), leaving **488 usable bytes**.
- **FFS** — the block is **512 raw bytes**, no header at all.

So the reader must know which filesystem it is in before it can read a single byte of a file.

---

## 4. Module design

**`src/lib/adffs/`, a new pure module beside `adfmfm`,** and deliberately shaped like it: pure
functions over a `Uint8Array`, no I/O, no database. That is what lets the whole format be tested
in vitest, which is the same reasoning that made the MFM encoder verifiable against Greaseweazle.

| File | Responsibility |
|---|---|
| `blocks.ts` | Block slicing, big-endian reads, the AmigaDOS checksum. The only file that does arithmetic on raw offsets. |
| `boot.ts` | Signature and flags → `{ filesystem: 'OFS' \| 'FFS', intl, dirc }`. |
| `root.ts` | Root block validation and the volume header. Owns the checksum rule from §3.3. |
| `dir.ts` | Hash-table and chain traversal; entry decoding (name, size, dates, protection, comment). |
| `file.ts` | Data-block lists, extension blocks, and the OFS/FFS split from §3.5. |
| `index.ts` | `readVolume(adf)` and `readFile(adf, entry)`. The only exports callers use. |

```ts
export type Filesystem = 'OFS' | 'FFS';

export interface VolumeInfo {
  filesystem: Filesystem; intl: boolean; dirc: boolean;
  name: string; createdAt: Date | null; modifiedAt: Date | null;
}

export interface AdfEntry {
  name: string;
  kind: 'file' | 'dir';
  /** Block number. Stable within one image and used as the download handle. */
  block: number;
  sizeBytes: number;          // 0 for a directory
  modifiedAt: Date | null;
  protection: string;         // "hsparwed" style, as AmigaDOS `list` prints it
  comment: string | null;
  children: AdfEntry[];       // empty for a file
}

export type VolumeResult =
  | { ok: true; volume: VolumeInfo; root: AdfEntry[]; truncated: boolean; warnings: string[] }
  | { ok: false; reason: 'not-adf' | 'no-dos-signature' | 'no-filesystem' };

export function readVolume(adf: Uint8Array): VolumeResult;
export function readFile(adf: Uint8Array, block: number): Uint8Array;
```

`VolumeResult` is a discriminated union rather than a thrown error because **"this disk has no
filesystem" is an ordinary, expected answer for 20% of the archive**, not an exceptional one. A
game disk is not a failure to report.

---

## 5. Robustness is a requirement, not a polish pass

The input is a 901,120-byte blob that a tenant uploaded. It may be truncated, corrupt, or
adversarial. **The reader must always terminate and never throw for malformed input** — a bad
disk produces `ok: false` or a partial tree with warnings.

Concretely, and each of these gets its own test:

1. **Every block index is bounds-checked** before slicing. A pointer to block 99,999 is ignored
   and warned about, not read.
2. **A visited-block set bounds every traversal.** A hash chain or extension chain that points
   back at itself must terminate. The archive has zero cycles today — which is exactly why this
   needs a synthetic test rather than trust.
3. **A hard cap on entries returned** (10,000), reported through `truncated`. A crafted image
   must not make the server build an unbounded tree.
4. **A file's byte size is cross-checked against the blocks actually reachable.** A header
   claiming 800 KB with three data blocks yields the bytes that exist plus a warning, never a
   buffer sized from an attacker-controlled number.
5. **Depth is capped** (32). The archive's deepest is 4.
6. **Names are decoded as latin-1 and sanitised for display.** A control character in a filename
   must not reach the DOM or a header; §7 reuses the existing sanitiser for the header case.

---

## 6. Reading the bytes: no new storage path

`diskStore.read(sha256)` already exists and is already used by the sweeper. The reader gets its
bytes through it. **No caching layer, no new table, no sweeper phase.**

That is safe specifically because `blobs` is content-addressed: the parse of a given sha-256 can
never change, so the HTTP response is `immutable` and a repeat view costs nothing. This is the
same property the cover-image route relies on.

---

## 7. Surfaces

### 7.1 `/disks/[id]/files` — the browser page

A server component. `requireOrg()`, then the **entitlement** boundary — not the disk row — for
the reason §7.3 gives. It parses once and passes the whole tree to a client component, so
expanding a directory is instant rather than another 880 KB read.

The tree is at most 10,000 entries; the whole 49-disk archive holds 2,430 files. Sending it whole
is cheaper than a round trip per folder.

The page states the volume header plainly — filesystem type, INTL/DIRC, volume name, dates — and
renders `ok: false` as **"No AmigaDOS filesystem — likely a custom bootblock game or demo"**,
which is information about the disk, not an error message.

A **Browse** link is added to the disk row on the game page, beside the existing Download.

### 7.2 `GET /api/disks/[id]/files/[block]` — one file

`block` rather than a path: the block number is the entry's identity within the image, it needs
no escaping, and a path would have to be re-resolved by re-walking the tree. The route validates
that the block really is a file header inside that image before reading it.

Filename and `Content-Disposition` go through the **existing `download-name.ts`**, which already
strips CR/LF and emits the RFC 5987 form. An AmigaDOS filename is as untrusted as an upload name.

### 7.3 The boundary, restated

Both surfaces check `entitlements(orgId, sha256)`, exactly as `/api/disks/[id]/adf` and
`/api/device/image` do. `disks.orgId` is an independent column that can drift from its game's
org — this repo documents that drift as real — so an org-scoped disk lookup is necessary but not
sufficient. A caller from another organization gets **404, never 403**.

---

## 8. Testing

**Vitest, for everything that is logic** — which is nearly all of it:

- Synthetic images built in-test, as `adfmfm`'s `synthetic.ts` already does: an OFS volume, an
  FFS volume, an INTL volume, a file spanning an extension block, a nested tree.
- Every §5 hazard: out-of-range pointer, cyclic hash chain, cyclic extension chain, oversized
  claimed file size, depth bomb, entry-count cap.
- **The Project-X case specifically**: a block-880 that passes type and secondary-type checks but
  fails the checksum must be reported as no filesystem. This is a real disk in the archive and
  the reason the checksum rule exists.
- Boot-checksum independence: a disk whose boot checksum is wrong but whose root block is sound
  must read normally. **30 of the 49 readable archive disks are exactly that**, so this is the
  common case rather than an edge case.

**An archive assertion**, in the spirit of `adfmfm`'s Greaseweazle comparison: run the reader
over `adf-archive/` and assert the measured verdicts — **49 readable of 61, 25 OFS / 24 FFS,
6 INTL, 0 DIRC, 2,430 files in 427 directories, 112 needing an extension block, max depth 4,
zero cycles**. Skipped when the archive is absent, so a checkout without it still passes.

**Playwright**, for what needs a browser and a database: the page renders a real tree, a
no-filesystem disk shows the explanatory state, a single file downloads with the right bytes, and
a cross-tenant request gets 404.

---

## 9. What this deliberately leaves for later

- **Persisting the listing** (a `disk_files` table, populated as a sweeper phase). That is what
  unlocks cross-disk search and could auto-identify unmatched disks from their contents. Worth
  doing once there is a reason to search; building it now would be guessing at the schema.
- **Showing the volume name in the library and on `/admin/scan`'s unmatched queue.** Cheap once
  persistence exists, and near-useless before it, since it would mean parsing every disk on
  every list render.
- **Writing** — creating blank ADFs and add/edit/delete. Already in the backlog with its
  constraints recorded, including that it must maintain the bitmap and hash chains this reader
  ignores, and that an edited disk deliberately has no TOSEC identity.

---

## 10. Decisions

- **D-3-1. Validity requires the root checksum.** Structural checks alone admit Project-X, a
  cracked game whose block 880 is data. Measured, not theorised.
- **D-3-2. The boot-block checksum is never a validity test.** 30 of the 49 disks with a sound
  filesystem fail it; enforcing it would discard 61% of what this increment exists to read.
- **D-3-3. "No filesystem" is a result, not an error.** 20% of the archive, and every game disk,
  answers this way; `readVolume` returns a union rather than throwing.
- **D-3-4. Parse per request; persist nothing.** Content-addressed bytes make the parse a pure
  function of the sha-256, so HTTP `immutable` caching is correct and a table is not needed yet.
- **D-3-5. Files are addressed by block number, not path.** It is the entry's identity in the
  image, needs no escaping, and avoids re-walking the tree to resolve a path.
- **D-3-6. DIRC is detected and ignored.** It is a cache over the hash chains, which are read
  regardless; no disk in the archive uses it.
