# Dropping files onto a disk, and dragging them around inside it — design

**Written 2026-09-05.** Requested by the operator after using the file operations that shipped
2026-09-04 (HANDOFF §3u): "the create adf function works well — but I think we need a few more
UX changes to make it intuitive." Builds on `src/lib/adffs`'s write layer and the
`/disks/[id]/files` page. Supersedes nothing.

---

## 1. The workflow this serves

Make a blank disk with **Create ADF**, open it, and fill it. Today filling it means pressing
Upload once per file and typing each name. For a Workbench-shaped disk with a `C` drawer and a
dozen commands that is a dozen round trips, and nothing in the page suggests you could drop a
folder on it.

**Two gestures, one increment** (operator's ruling, 2026-09-05): dropping from the machine INTO
the disk, and dragging INSIDE the disk to rearrange. They are the same gesture pointed in two
directions, they share one drag context and one set of drop targets, and a page that accepted
drags from outside but not within would read as broken.

---

## 2. Scope

**In:**

- **Drop files and folders** from the operating system onto the page, with nested directory
  structure preserved, including empty directories.
- **A staging area** that shows what was dropped, what it will be named, whether it fits, and
  any collisions — before anything is written.
- **One batch commit**: every create applied to a single in-memory image, producing ONE new blob.
- **Drag an entry onto a folder** inside the disk to move it, plus a keyboard-reachable
  equivalent.
- **A vertical layout**: the disk on top, the drop zone below it (operator's ruling, 2026-09-05
  — a side-by-side pane would have needed its own 390px design; stacked, the phone layout is
  the same layout).

**Out:**

- **Two disks side by side.** Copying between disk images is a bigger feature that needs
  cross-disk copy, touches two disks and writes two blobs per action. Considered and deferred.
- **Reordering within a directory.** AmigaDOS directory order is a hash-chain artifact, not a
  user-visible sequence. There is nothing to reorder.
- **Dragging OUT of the disk** to the desktop. The per-file download already exists.
- **Editing file contents.** Unchanged from §9 of the file-operations spec.

---

## 3. The four things that are not obvious

**3.1 A byte total lies about whether a folder fits.** Free space is blocks, not bytes. Every
file costs one header block plus `ceil(size / perBlock)` data blocks (512 on FFS, 488 on OFS)
plus one `T_LIST` extension block per 72 data blocks beyond the first 72. Every directory costs
one block. **A hundred 1KB files need ~200 blocks (100KB) to hold 100KB of content.** The
staging area MUST compute block cost against `readUsage().freeBlocks`, never compare byte sizes,
or it will report that something fits and then fail on commit.

**3.2 Moving a folder into its own descendant would corrupt the disk into a cycle.** Our reader
has a cycle guard (`dir.ts`) and would CONTAIN it, reporting a plausible listing while the disk
is broken for a real Amiga — the same class of invisibility as an inverted bitmap. `moveEntry`
must walk the destination's ancestry via each header's parent pointer and refuse. This needs its
own test; it cannot be caught by reading the result back.

**3.3 AmigaDOS names are 30 characters and compare case-insensitively.** `nameHash` upper-cases
before hashing, so `Readme` and `README` occupy one slot in one directory even though the
dropping machine holds both. Over-long names are ordinary, not exceptional: dropped files
routinely exceed 30 characters.

**3.4 A dropped directory reads 100 entries at a time.** `FileSystemDirectoryReader.readEntries`
returns at most 100 per call and must be called repeatedly until it returns an empty array. A
naive single call silently truncates a large folder at exactly 100 items — green, plausible, and
wrong. `webkitGetAsEntry()` must also be called synchronously in the drop handler, before the
event's data transfer is neutered.

---

## 4. The staging area

Dropping never writes (D-DD-2). It fills a staging list, which is the whole safety mechanism.

Each staged row shows the source path, the name it will be written under, its block cost, and
its state. Three states matter:

- **ok** — writes as shown.
- **shortened** — the name exceeded 30 characters and was truncated deterministically. The
  shortened name is shown in an **editable field**, so the result is visible and correctable
  rather than silently applied.
- **collision** — an entry of that name already exists in the destination, or two staged rows
  collide with each other after shortening. **Never resolved automatically** (D-DD-4). The row
  offers **skip**, **replace** (`replaceFile`, which keeps the existing header block per D-W-6)
  or **rename**, and the commit button stays disabled while any collision is outstanding.

Above the list: the destination (defaulting to the root, pre-set when the drop landed on a
folder row), the total block cost, and the free-block count. When the total exceeds free space
the commit is disabled and says so with both numbers.

---

## 5. The batch commit

`applyDiskEdit` takes a single `edit: (adf: Uint8Array) => WriteResult` and writes one blob. A
batch is therefore **just an edit function that applies many operations in sequence to the same
array** — no change to `applyDiskEdit`, no new transaction concept, and atomicity for free: a
failure anywhere returns the error and the caller's disk is untouched, because every operation
works on the copy.

Directories are created before the files inside them, deepest path last, so every parent exists
when its children are written. A `disk-full` partway through fails the whole batch, which is why
§3.1's pre-flight check matters: it turns a failed commit into a refusal that never started.

**Route:** `POST /api/disks/[id]/files/batch`, multipart, carrying a JSON manifest plus the file
parts. It reuses `applyDiskEdit`, so it inherits the 409-when-mounted refusal (D-W-4), the
404-never-403 tenancy boundary, and the rule that `disks.id` never changes while `disks.sha256`
does.

---

## 6. Moving inside the disk

**New operation:** `moveEntry(adf, fromParent, entryBlock, toParent): WriteResult`.

Unlink from the source directory's hash chain using the existing `predecessorOf`, rewrite the
entry's parent pointer at offset 500, then link into the destination's chain at the bucket the
name hashes to THERE. Rechecksum the entry and both directories.

Refusals, all before any mutation: `not-found`, `not-a-directory` when the destination is a file,
`name-exists` when the destination already holds that name, and a **cycle refusal** when the
destination is the entry itself or any of its descendants (§3.2).

A move changes no data blocks, so it allocates and frees nothing. It must not touch the bitmap
at all, and there is a test for that.

**Route:** `PATCH /api/disks/[id]/files/[block]` gains a third body shape, `{ toParent }`,
alongside the existing rename and replace. Same handler, same refusals.

---

## 7. Surfaces

The disk's tree keeps the top of the page. Below it, a slim drop strip is **always visible**, so
the page advertises that it accepts a drop; dropping expands it into the staging list.

**Drop targets:** every folder row, plus the root. Collision detection is **pointer-based**, not
dnd-kit's default rectangle intersection — the collections work measured that the default
resolves from the DRAGGED element and routinely landed titles in the wrong row.

**Keyboard and touch, both non-negotiable:**

- The existing **Upload file** and **New folder** buttons stay. They are the non-drag path, and
  this page has already shipped one accessibility defect by optimising a control for a test
  selector.
- Moving gains a **"Move to…"** action in the row's inline controls, listing the disk's
  directories. A drag-only move is unusable by keyboard.
- The touch sensor keeps the **press-and-hold activation delay** the mobile work established, or
  dragging eats page scrolling on a phone.

**Refusals are stated, not hidden**, exactly as §6 of the file-operations spec requires: a
mounted disk, an untrusted bitmap or a disk with no filesystem disables the drop zone with the
reason.

---

## 8. Testing

**vitest** covers `moveEntry` (both predecessor kinds, the cycle refusal, the name collision, the
bitmap untouched), the block-cost calculator against known layouts, the name shortener, and the
batch edit function including deepest-path ordering and a disk-full partway through.

**`pnpm adffs:verify`** gains: a batch that creates a nested tree, and a move. Both then handed
to `xdftool` for the same three checks every other operation gets — it lists what we expect, it
**writes its own file into the result**, and our reader still reads it. Both mutation-proven.

**e2e is part of the task, not after it.** The collections increment shipped drag-and-drop that
was reviewed clean and passed build and unit tests, and still carried three defects only a real
browser could reveal. Cover: dropping a nested folder and reading the files back OUT of the disk
bytes; a folder that does not fit being refused with numbers before anything is written; a
collision blocking the commit until resolved; a move by drag; a move by keyboard; and the mobile
layout at 390×844.

---

## 9. Decisions

- **D-DD-1. The drop zone is the source and the disk is the destination, stacked vertically.**
  Operator's ruling 2026-09-05. A side-by-side pane needs its own phone design; stacked, one
  layout serves both. Two-disk panes were considered and deferred (§2).
- **D-DD-2. Dropping stages; it never writes.** Operator's ruling 2026-09-05. An 880KB disk means
  a dropped folder often will not fit, and staging turns a failure after the fact into a refusal
  with real numbers before it. It also allows several drops to be committed together.
- **D-DD-3. One commit writes one blob.** Blobs are content-addressed and immutable, so per-file
  requests would produce one 880KB object per file — fifty files, fifty versions of the disk.
  Batching is what makes the upload atomic, not an added transaction.
- **D-DD-4. Over-long names are shortened visibly; collisions are never resolved automatically.**
  Operator's ruling 2026-09-05. Shortening is deterministic and shown in an editable field.
  A collision offers skip, replace or rename per row, and blocks the commit until resolved — the
  operator's own disks must never be silently overwritten.
- **D-DD-5. Fit is computed in BLOCKS, never bytes.** §3.1. A byte comparison reports that
  something fits and then fails.
- **D-DD-6. A move refuses a destination inside its own subtree.** §3.2. Our reader's cycle guard
  would hide the corruption, so the refusal is the only thing standing between a drag and a disk
  no Amiga can walk.
- **D-DD-7. Every drag gesture has a keyboard equivalent.** The buttons stay and "Move to…" is
  added. A drag-only feature excludes keyboard users, and this page has already paid for one
  accessibility shortcut.
