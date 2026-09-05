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
  /** What will actually be written, after Latin-1 masking, forbidden-byte substitution and shortening. */
  name: string;
  /**
   * True when `name` differs from the dropped name for ANY of the three
   * reasons this module corrects visibly: over-length shortening, a code
   * point above 0xFF masked down to a byte (`maskToLatin1`), or a masked
   * byte that landed on `/`, `:` or a control character and was substituted
   * (`forbidUnwritable`). All three are the same kind of fact to a person
   * staging a drop -- "this isn't what you dropped, look at what will
   * actually be written" -- so all three share this one flag and the same
   * editable-row treatment in the UI, rather than a name change silently
   * happening without a bar to notice it.
   */
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
 * Mask every character above the Latin-1 byte range down to one byte, the
 * IDENTICAL rule `putName` (write-blocks.ts) applies when it actually writes
 * a name to disk: `charCodeAt(i) & 0xff`.
 *
 * WHY THIS HAS TO LIVE HERE, NOT JUST IN `putName`: `nameHash` and
 * `sameName` (write.ts) hash and compare the FULL, unmasked code point, so
 * without this a staged name lies. A dropped "Ω.txt" (U+03A9, 0x3A9) used to
 * stage and display as "Ω.txt" while the byte `putName` actually wrote was
 * `0x3A9 & 0xff` = 0xA9 = "©" -- stored as "©.txt", hashed and compared as
 * "©.txt" by `nameHash`/`sameName`, but DISPLAYED and staged as if it were
 * still "Ω.txt". A real Amiga probing for the name it can actually see on
 * disk ("©.txt") would never think to hash "Ω.txt" first, so the file was
 * unfindable there -- only our own reader (which walks every hash bucket
 * rather than probing one) showed it fine. Masking here, before shortening
 * and before the collision check, makes the staged `name` the TRUTH: what a
 * person sees is byte-for-byte what gets written, hashed and compared.
 */
function maskToLatin1(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    out += String.fromCharCode(name.charCodeAt(i) & 0xff);
  }
  return out;
}

/**
 * The stand-in for a byte AmigaDOS cannot hold in a name. Plain, printable
 * ASCII, one byte, and -- the property that actually matters here -- not
 * itself `/`, `:`, or a control character, so substituting it can never
 * reintroduce the exact problem this function exists to remove.
 */
const FORBIDDEN_SUBSTITUTE = '_';

/**
 * Replace any byte AmigaDOS cannot hold in a name -- `/` (0x2F, the path
 * separator), `:` (0x3A, the device separator) and anything below 0x20 (an
 * ASCII control character) -- with `FORBIDDEN_SUBSTITUTE`.
 *
 * THE GAP THIS CLOSES IN `maskToLatin1`: masking a code point above 0xFF
 * down to one byte can LAND on one of these forbidden bytes purely by
 * coincidence of arithmetic -- 'į' (U+012F) masks to `0x2F`, which is `/`;
 * 'ĺ' (U+013A) masks to `0x3A`, which is `:`. Before this, a dropped
 * "į.txt" staged (and would have been written) as "/.txt". Nothing wrong
 * with that specific ROW was ever shown: `diskPathFor` built the manifest
 * path "/.txt" from it, and the batch route's `isPathSafe` sees a leading
 * '/' as an empty first PATH SEGMENT, not a bad NAME, and refuses the
 * WHOLE manifest with a 400 that names no row at all. Substituting here --
 * after masking, before the collision check, in the one place a person can
 * see and further edit the name -- is what keeps that refusal from ever
 * reaching the batch route.
 */
function forbidUnwritable(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    out += (c === 0x2f || c === 0x3a || c < 0x20) ? FORBIDDEN_SUBSTITUTE : name[i];
  }
  return out;
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
 * Join a within-drop relative directory (possibly `''`, meaning "wherever
 * this row sits directly") onto a chosen destination path (possibly `''`
 * for the disk root itself) -- the one join every lookup against
 * `existingNamesByDir`, and every written manifest path, has to agree on.
 *
 * EXPORTED so `DropStaging`'s destination selector (drop-staging.tsx) uses
 * this SAME function for both "what directory is this row's collision
 * checked against" and "what directory does this row actually get written
 * to" -- a second, independently-written join for either side could
 * quietly disagree with the other about which directory that is, which is
 * exactly the defect a destination selector exists to prevent (staging
 * would say "no collision" for a name the write then refuses, or the
 * reverse).
 */
export function joinDestination(destinationPath: string, dir: string): string {
  if (!destinationPath) return dir;
  return dir ? `${destinationPath}/${dir}` : destinationPath;
}

/**
 * Whether `name` collides with an entry ALREADY ON THE DISK inside `dir`,
 * once `dir` is joined onto `destinationPath` via `joinDestination` --
 * i.e. the check evaluated against the CHOSEN destination's own existing
 * entries, never unconditionally against the disk root's. `null` when
 * `dir` (at that destination) holds nothing on the disk, or nothing there
 * matches `name` under `sameName`'s case fold.
 */
export function existingCollisionAt(
  name: string, dir: string, destinationPath: string,
  existingNamesByDir: ReadonlyMap<string, readonly ExistingEntry[]>, intl: boolean,
): ExistingEntry | null {
  const existing = existingNamesByDir.get(joinDestination(destinationPath, dir)) ?? [];
  return existing.find((o) => sameName(o.name, name, intl)) ?? null;
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
    // Masked, then made WRITABLE, then shortened -- in that order.
    // `maskToLatin1` and `forbidUnwritable` each preserve length (one
    // UTF-16 code unit in, one out), so doing them before `shortenName`
    // never changes where it ends up cutting; but the collision check
    // below has to see the exact bytes `putName` will actually write, not
    // the pre-mask, pre-substitution original.
    const name = shortenName(forbidUnwritable(maskToLatin1(rawName)));

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
