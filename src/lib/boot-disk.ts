// Disk at startup (2026-10-19): what DF0 holds after the board boots -- the last disk (default) or none.
// No database import here: the device card's control (a client component) uses these; the writes are in
// boot-disk-store.ts.
//
// Where it is decided, and why the server: the board keeps no disk across a boot at all (PSRAM is volatile, and no
// flash record holds a mount -- drive_store.c holds only the DF1 mode). After every boot it polls with since=0 and
// the server re-sends the desired disk; that re-send IS "last disk". So "No disk" is the server not re-sending it:
// the desired disk is cleared at the board's first request of a new boot. The board only says which boot it is in
// (?boot=<8 hex>, the same id on every request of that boot) and whether the reboot before it was its own, for an
// update (&ota=1). It cannot be done with no firmware at all: since=0 is not a boot signal (a board also polls
// since=0 mid-game, after a write-back close mismatch -- uploader.c's dc_force_refetch), and nothing the server
// sees tells an update's reboot from a power-up.

export type BootDisk = 'last' | 'empty';

/**
 * The firmware that names its boot on the poll and the tap.
 * RELEASE RULE (operator ruling, fix round 1, 2026-10-19): 1.18.1 ships as ONE build with feat/boot-empty AND
 * feat/nfc-ntag. Never publish a 1.18.1 without the boot id (device_client.c dc_set_boot) -- the card would offer
 * "No disk" to boards that cannot do it. Built from a tree without it? Bump the version, and this with it.
 */
export const BOOT_DISK_FW = '1.18.1';

/** A stored value, or 'last' for anything else (never guess "empty": that ejects a game). */
export function asBootDisk(v: string | null): BootDisk {
  return v === 'empty' ? 'empty' : 'last';
}

export interface BootReport {
  /** The board's id for this boot: 8 lowercase hex digits, never 0. */
  id: string;
  /** The reboot before this boot was the firmware's own, for an update (installing one, a trial reverting). */
  ota: boolean;
}

/** ?boot=<8 hex>[&ota=1] from a poll or tap URL. Null = a board that sends none (before 1.18.1), or a malformed one. */
export function parseBoot(params: URLSearchParams): BootReport | null {
  const id = params.get('boot');
  if (id === null || !/^[0-9a-f]{8}$/.test(id) || id === '00000000') return null;
  return { id, ota: params.get('ota') === '1' };
}

/** The card's note beside the control: the firmware a board needs, or null once it has it. */
export function bootDiskNote(capable: boolean): string | null {
  return capable ? null : `Needs firmware ${BOOT_DISK_FW} or newer`;
}
