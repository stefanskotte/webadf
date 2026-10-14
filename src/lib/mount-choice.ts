import { deviceState, type DeviceState, type DeviceStateRow } from '@/lib/device-state';
import { df1Option, type Df1Board, type Df1Option } from '@/lib/df1-pick';

/**
 * What one device offers for one disk: what it is holding now, and whether the
 * button beside it should mount or eject.
 *
 * Pure and separate from the component because the interesting part is not the
 * markup. Every rule below is a judgement about desired-versus-reported state,
 * which is exactly the distinction device-state.ts exists to preserve, and the
 * mount picker is the one place where getting it wrong sends a disk to the
 * wrong drive.
 */
export interface MountTargetRow extends DeviceStateRow, Df1Board {
  id: string;
  name: string;
  // Both ids, because which one is authoritative depends on the state: the
  // device REPORTS what it mounted, a human SETS what is desired.
  desiredDiskId: string | null;
  mountedDiskId: string | null;
  desiredGame: string | null;
  desiredDiskNo: number | null;
  mountedGame: string | null;
  mountedDiskNo: number | null;
  /**
   * DF1 any disk: what the board reports DF1 holds, and the digest of the disk mounted into DF1. Until the two
   * agree the pick is requested, not fact, and the holder line says "Mounting to" (the rule on holderText).
   */
  df1Sha256: string | null;
  df1PickSha256: string | null;
}

/** The disk being acted on: what rule 3 of spec 2026-10-14 §3.1 (a standard DD ADF) needs besides its ids. */
export interface MountDisk { id: string; sha256: string; imageFormat: string; sizeBytes: number }

export interface MountChoice {
  id: string;
  name: string;
  state: DeviceState;
  /** What this device holds or is fetching, ready to render. Null when idle. */
  holding: string | null;
  /** True when what it holds -- or is fetching -- is the disk being acted on. */
  isThisDisk: boolean;
  /** Which endpoint the button hits. */
  action: 'mount' | 'eject';
  /** What the button should say. */
  actionLabel: string;
  /**
   * For a Cancel on a board that still holds a CONFIRMED disk: that disk, which
   * the Cancel asks for again (a mount) instead of emptying the drive. Calling
   * off a swap must not eject the disk the Amiga may be running from. Null
   * otherwise: an Eject, or a Cancel with nothing confirmed in the drive.
   */
  revertDiskId: string | null;
  /**
   * DF1 (spec 2026-10-14 §3.3): what the DF1 button offers, or null when the board's DF1 setting is not On --
   * then there is no DF1 button and Mount is DF0's, as before (D1).
   */
  df1: Df1Option | null;
  /**
   * True when this disk is the one mounted into DF1 AND the board reports holding exactly its digest. False
   * while it is still loading (or not in DF1 at all): the holder line must not say "In" before the board does.
   */
  df1Held: boolean;
}

/** "Lemmings — disk 2", degrading rather than rendering "null — disk null". */
function describe(game: string | null, diskNo: number | null): string {
  if (game && diskNo !== null) return `${game} — disk ${diskNo}`;
  if (game) return game;
  // Reachable: the join is org-scoped, so a device naming another org's game
  // yields a null title rather than that title. Saying "a disk" is correct and
  // leaks nothing; saying nothing at all would read as an empty drive.
  return 'a disk';
}

export function mountChoice(row: MountTargetRow, disk: MountDisk, now: number): MountChoice {
  const diskId = disk.id;
  const diskSha256 = disk.sha256;
  const state = deviceState(row, now);

  // Which half of the row is the live one. Converged means the device has
  // confirmed what it holds; anything else means a request is outstanding and
  // the DESIRED side is what the person is waiting on.
  const converged = state === 'converged';
  const activeDiskId = converged ? row.mountedDiskId : row.desiredDiskId;
  const activeSha = converged ? row.mountedSha256 : row.desiredSha256;

  // Prefer the disk id: two disk rows can share a digest (a re-upload of the
  // same content under a second title), and only the id distinguishes them.
  // Fall back to the digest because mountedDiskId is resolved by recordStatus
  // and is null when that resolution found nothing -- in which case the digest
  // is the only evidence there is, and matching on it beats reporting an empty
  // drive that visibly holds something.
  const isThisDisk =
    state === 'empty' ? false
    : activeDiskId !== null ? activeDiskId === diskId
    : activeSha === diskSha256;

  const holding =
    state === 'empty' ? null
    : converged ? describe(row.mountedGame, row.mountedDiskNo)
    : state === 'pending' ? `fetching ${describe(row.desiredGame, row.desiredDiskNo)}`
    : `${describe(row.desiredGame, row.desiredDiskNo)} requested — not confirmed`;

  // Both actions POST to /eject, which sets "hold nothing". The WORDS differ
  // because the situations do: ejecting a disk the drive confirmed it has is
  // not the same act as calling off a fetch that has not landed, and a person
  // who asked for the wrong disk is looking for "Cancel", not "Eject".
  const action = isThisDisk ? 'eject' : 'mount';
  const actionLabel =
    !isThisDisk ? 'Mount here'
    : converged ? 'Eject'
    : 'Cancel';

  const revertDiskId = isThisDisk && !converged && row.mountedDiskId !== null && row.mountedDiskId !== activeDiskId
    ? row.mountedDiskId : null;

  const df1 = df1Option(row, disk);
  const df1Held = df1?.isThisDisk === true && row.df1PickSha256 !== null && row.df1Sha256 === row.df1PickSha256;

  return { id: row.id, name: row.name, state, holding, isThisDisk, action, actionLabel, revertDiskId, df1, df1Held };
}

export function mountChoices(rows: MountTargetRow[], disk: MountDisk, now: number): MountChoice[] {
  return rows.map((r) => mountChoice(r, disk, now));
}

export interface HolderLine {
  text: string;
  /** Only when the line is the unconfirmed one, which is the one that reads amber. */
  stale: boolean;
}

/** "A", "A and B", "A, B and C". */
function names(list: MountChoice[]): string {
  const n = list.map((c) => c.name);
  if (n.length === 1) return n[0];
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/**
 * The one-line "where is this disk" summary shown under a disk's name.
 *
 * Derived from the same choices the picker uses, deliberately. It used to come
 * from a separate sha256-keyed map that kept only the FIRST device found, so
 * two disk rows sharing one digest (identical bytes re-uploaded under a second
 * title) could make the line name one device while the mount button named
 * another. One source of truth, matched on the disk id, cannot disagree with
 * itself -- and having every device to hand, this names them all rather than
 * silently dropping the second.
 *
 * Confirmed state outranks unconfirmed: a disk genuinely sitting in one drive
 * while a second drive was merely asked for it is "In A", because that is the
 * fact. The unconfirmed wording never begins with "In", which is the §7 rule
 * (desired state must not be presented as fact) made checkable.
 */
export function holderText(choices: MountChoice[]): HolderLine | null {
  const held = choices.filter((c) => c.isThisDisk);
  if (held.length === 0) {
    // A disk in DF1 only (spec 2026-10-14 §3.3): said, with the drive named. DF0 outranks it when both hold.
    // Same rule as DF0: "In" only once the board reports the pick's digest; until then it is still loading.
    const inDf1 = choices.filter((c) => c.df1?.isThisDisk === true);
    const df1Held = inDf1.filter((c) => c.df1Held);
    if (df1Held.length > 0) return { text: `In ${names(df1Held)} (DF1)`, stale: false };
    return inDf1.length > 0 ? { text: `Mounting to ${names(inDf1)} (DF1)…`, stale: false } : null;
  }

  const converged = held.filter((c) => c.state === 'converged');
  if (converged.length > 0) return { text: `In ${names(converged)}`, stale: false };

  const pending = held.filter((c) => c.state === 'pending');
  if (pending.length > 0) return { text: `Mounting to ${names(pending)}…`, stale: false };

  return { text: `Requested on ${names(held)} — not confirmed`, stale: true };
}
