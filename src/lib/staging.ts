// The name policy behind the drag-and-drop staging area: what a dropped
// name becomes once AmigaDOS gets it, and what collides once it does.
//
// Two facts drive this, both surprising if you only know the machine you
// dropped from:
//
//   1. AmigaDOS names are capped at 30 characters, so shortening a dropped
//      name is the ordinary case, not an edge case.
//   2. AmigaDOS compares names case-insensitively -- the directory hash
//      folds case before hashing (`nameHash`), so "Readme" and "README"
//      occupy exactly one slot in one directory even though the source
//      filesystem happily holds both. `sameName` (from `write.ts`) folds
//      case the identical way, so this module reuses it rather than
//      inventing a second rule that could quietly disagree with the one
//      the filesystem actually enforces.
//
// Two kinds of collision follow from that: a dropped name colliding with
// something already on the disk, and two dropped names colliding with EACH
// OTHER only after both get shortened -- the case no per-row check against
// the disk would ever catch, because neither name exists there yet.
//
// This module only DETECTS collisions; it never resolves them (spec
// D-DD-4). A later task builds the UI where a person picks skip, replace or
// rename.

import { sameName } from './adffs/write';

const MAX_NAME_LENGTH = 30;

/** One entry already on the disk, in the shape `existingNamesByDir` carries -- `kind` alongside `name` so a caller can tell a same-named FILE from a same-named DIRECTORY apart, which matters because "replace" (`replaceFile`) only ever makes sense against an existing file (fix round 1, Finding 2). */
export interface ExistingEntry {
  name: string;
  kind: 'file' | 'dir';
}

export interface StagedEntry {
  /** As dropped, e.g. "Workbench/C/Assign". */
  path: string;
  kind: 'file' | 'dir';
  sizeBytes: number;
  /** What will actually be written, after shortening. */
  name: string;
  shortened: boolean;
  collidesWith: 'existing' | 'staged' | null;
  /**
   * The kind of the entry this collides with, ONLY when `collidesWith` is
   * `'existing'` -- null otherwise (no collision, or a 'staged' collision,
   * which has no existing entry to name a kind for). This is what a caller
   * checks before offering "replace": `replaceFile` requires `ST_FILE`, so a
   * dropped file colliding with an existing DIRECTORY of the same name must
   * never be offered replace, only skip or rename (fix round 1, Finding 2 --
   * the batch route refuses this correctly, but only after the whole batch
   * has already been attempted, and the error it surfaces then is
   * misleading).
   */
  existingKind: 'file' | 'dir' | null;
}

/**
 * Shorten `name` to AmigaDOS's 30-character cap, keeping the extension
 * where there is one: "Startup-Seq.txt" is a name AmigaDOS can hold,
 * "MyVeryLongDocumentFileNameXX.t" is not worth having kept the "t" for.
 *
 * Splits on the LAST dot and trims the stem so stem + extension is exactly
 * 30 characters, then falls back to a plain 30-character truncation when
 * the extension alone is 30 characters or longer (or there is no dot to
 * split on at all).
 */
export function shortenName(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) return name;

  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const extension = name.slice(dot);
    if (extension.length < MAX_NAME_LENGTH) {
      const stem = name.slice(0, dot).slice(0, MAX_NAME_LENGTH - extension.length);
      return `${stem}${extension}`;
    }
  }

  return name.slice(0, MAX_NAME_LENGTH);
}

/** Split a dropped path into its parent directory key and its own name. */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * Stage a dropped tree for writing, without writing anything.
 *
 * Entries are grouped by parent directory (from `path`, not from the
 * post-shortening name of any staged ancestor -- naming that a later task
 * owns). Each staged name is checked against `existingNamesByDir` for its
 * directory first, then against names already staged into that same
 * directory earlier in `dropped` -- so the second of two names that only
 * collide after shortening is the one reported, matching the order they
 * would be written in.
 *
 * Case folding uses `sameName`, so it agrees with `nameHash` on which two
 * names occupy the same directory slot. `intl` selects which of the two
 * folds applies -- it is the TARGET disk's own `boot.intl` (the page
 * already reads this when it opens the disk), because the write path,
 * `linkIntoDirectory`, hashes with `nameHash(name, boot.intl)`. Six disks
 * in the operator's archive are INTL-formatted, where extended Latin
 * (0xe0-0xfe, excluding 0xf7) also folds; passing the wrong flag here would
 * let this module say "no collision" for a pair that the real write would
 * refuse.
 */
export function stageDrop(
  dropped: readonly { path: string; kind: 'file' | 'dir'; sizeBytes: number }[],
  existingNamesByDir: ReadonlyMap<string, readonly ExistingEntry[]>,
  intl: boolean,
): StagedEntry[] {
  const stagedNamesByDir = new Map<string, string[]>();

  return dropped.map((entry) => {
    const { dir, name: rawName } = splitPath(entry.path);
    const name = shortenName(rawName);

    const existing = existingNamesByDir.get(dir) ?? [];
    const stagedSoFar = stagedNamesByDir.get(dir) ?? [];

    let collidesWith: StagedEntry['collidesWith'] = null;
    let existingKind: StagedEntry['existingKind'] = null;
    // Found once, by name, and its KIND carried alongside -- a second
    // `.some()` re-scan for the kind could in principle land on a different
    // entry than the one `.find()` matched if two existing entries in the
    // same directory ever compared equal under `sameName` (they can't, real
    // AmigaDOS directories are unique per hash slot, but a single `.find()`
    // is also simply less code).
    const existingHit = existing.find((other) => sameName(other.name, name, intl));
    if (existingHit) {
      collidesWith = 'existing';
      existingKind = existingHit.kind;
    } else if (stagedSoFar.some((other) => sameName(other, name, intl))) {
      collidesWith = 'staged';
    }

    stagedSoFar.push(name);
    stagedNamesByDir.set(dir, stagedSoFar);

    return {
      path: entry.path,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      name,
      shortened: name !== rawName,
      collidesWith,
      existingKind,
    };
  });
}
