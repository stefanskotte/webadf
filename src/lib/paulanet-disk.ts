/**
 * The PaulaNET driver disk (spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md §2):
 * Rob Smith's disk plus our Install, ReadMe and Receive, built by tools/paulanet-disk/build.sh. A fixed image the server
 * knows by digest -- not a library disk, owned by no organization. Uploaded once to the disk store
 * (scripts/paulanet-disk-upload.ts). Its PaulaNET.device and PaulaNET Config are Rob's, used by permission
 * under his terms (third-party/paulanet/); they are not MIT.
 */
export const PAULANET_DISK_SHA256 = 'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287';
export const PAULANET_DISK_BYTES = 901_120;
/**
 * The driver disk before Receive (Phase 3, until plan 2026-10-17). Still valid: a board whose Amiga is online keeps it
 * until the Amiga is off (driverDiskFor, R16), so it is served (isDriverDisk: the board's net route and the person's
 * /api/paulanet-disk?sha256=), kept by the blob GC (ALWAYS_REFERENCED_BLOBS) and named on the card (driverDiskLine).
 */
export const PAULANET_DISK_PREVIOUS = '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e';

/** What the poll carries as DF1's `next` in Network mode to a board without netPick (plan 2026-10-12 ruling 12); a
 * netPick board (fw 1.12.1) gets the same digest as its DF1 pick (`df1`) instead. The poll replaces `sha256` with
 * driverDiskFor's choice (R16), so this digest is the default, not always the one sent. */
export const PAULANET_NEXT = { diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 } as const;

/** Two heartbeats (60 s each, DC_STATUS_PERIOD_MS): within this the card calls the Amiga's driver "talking"
 *  (network-checklist.ts re-exports it). The rollout does NOT use it: driverDiskFor waits ROLLOUT_QUIET_MS. */
export const DRIVER_TALKING_MS = 120_000;

/** Digests the blob GC keeps although no row names them (blob-gc-run.ts): both driver disks (R16). */
export const ALWAYS_REFERENCED_BLOBS: readonly string[] = [PAULANET_DISK_SHA256, PAULANET_DISK_PREVIOUS];

export const isDriverDisk = (sha: string | null): boolean => sha === PAULANET_DISK_SHA256 || sha === PAULANET_DISK_PREVIOUS;

/**
 * Which driver disk the poll names for DF1 in Network mode (R16). A board holding the older disk keeps it while
 * the Amiga's driver was heard within ROLLOUT_QUIET_MS, so DF1 is never swapped (shown empty for 1 s, then changed)
 * under a running network; otherwise the new one. The 5-minute re-arm (netNextRearm) keeps waking such a board, so
 * the new disk goes in within minutes of the Amiga's quiet passing ROLLOUT_QUIET_MS. netDriverSeenAt null means never
 * heard in Network mode: recordStatus keeps the last reading across a board restart (fix round 1 ruling).
 */
export function driverDiskFor(t: { df1Sha256: string | null; netDriverSeenAt: Date | null }, now: number): string {
  const recent = t.netDriverSeenAt !== null && now - t.netDriverSeenAt.getTime() <= ROLLOUT_QUIET_MS;
  return t.df1Sha256 === PAULANET_DISK_PREVIOUS && recent ? PAULANET_DISK_PREVIOUS : PAULANET_DISK_SHA256;
}

/**
 * The driver disks (current and previous, R16): the only images a board may fetch without its organization owning
 * them -- and only from its own route, /api/device/image/net/<sha256> (pre-flight I3), never from the library route
 * /api/device/image/<sha256>.
 */
export function servedWithoutEntitlement(sha256: string): boolean {
  return isDriverDisk(sha256);
}

/**
 * The board runs Network mode for the setting the user chose now (pre-flight I2): the user chose 'net', and
 * the board's last report says it runs 'net' having handled exactly that setting version. Before that, a `next`
 * naming the driver disk would be preloaded under the OLD mode into DF0's idle slot, fail there, and block the
 * digest -- so the poll's `next` behaves as in Next disk / Off until this holds.
 */
export function netApplied(t: {
  secondDrive: string; secondDriveVersion: number;
  secondDriveReported: string | null; secondDriveAppliedVersion: number | null;
}): boolean {
  return t.secondDrive === 'net' && t.secondDriveReported === 'net'
    && t.secondDriveAppliedVersion === t.secondDriveVersion;
}

/**
 * The board runs Network now, whatever setting version it last reported (final review m1): the user chose 'net'
 * and the board reports 'net'. A second save of 'net' bumps the version; until the board reports the new one,
 * netApplied is false, yet the board is in Network either way -- so the poll keeps sending the driver disk (as
 * `next`, or as `df1` to a netPick board; a different one would eject it). The one-shot wake stays keyed on
 * netApplied.
 */
export function netKeepsDriverDisk(t: { secondDrive: string; secondDriveReported: string | null }): boolean {
  return t.secondDrive === 'net' && t.secondDriveReported === 'net';
}

/**
 * From this firmware on (&netPick=1 on the poll), the board takes Network mode's driver disk as DF1's pick, into
 * DF1's own slot, and DF0's next disk of the set preloads into the idle slot as in the other modes.
 */
export const NET_PICK_FW = '1.12.1';

/** At most one re-arm of the driver-disk wake per device in this long (Task 8 review I1). */
export const NET_REARM_MIN_MS = 5 * 60_000;

/**
 * How long the Amiga's driver must be quiet before a board holding the older driver disk gets the new one (R16, fix
 * round 1 ruling): two re-arm periods. Wider than DRIVER_TALKING_MS (the card's "talking", two heartbeats) on purpose:
 * the spec's "DF1 never changes under a running driver" outranks a missed heartbeat or two.
 */
export const ROLLOUT_QUIET_MS = 2 * NET_REARM_MIN_MS;

/**
 * Whether a status report should re-arm the poll's one-shot driver-disk wake (Task 8 review I1). The poll writes
 * net_next_sent_version when it BUILDS the body; a body lost in transit leaves the board without `next` and the
 * cursor saying it was sent. So: the board reports Network applied for the current setting (`row` is the devices
 * row before this report), the cursor is set, and DF1 does not hold the driver disk -> clear the cursor, so the
 * next poll wakes and sends it again. Rate-limited, so a board that cannot load it (no SLOT_NET, a held-off
 * digest) is not woken in a loop. A report silent on df1Sha256 says nothing about DF1 and never re-arms.
 * For a netPick board (fw 1.12.1) the df1Ack cursor already re-wakes a lost body; a re-arm there sends the same
 * driver disk once more, which the board ignores (final review 2026-10-15, minor 4).
 */
export function netNextRearm(
  row: { secondDrive: string; secondDriveVersion: number; netNextSentVersion: number | null; netNextRearmedAt: Date | null },
  report: { secondDrive?: string; driveVersion?: number; df1Sha256?: string | null },
  now: Date,
): boolean {
  if (!netNextRearmCandidate(report)) return false;
  return row.secondDrive === 'net' && report.driveVersion === row.secondDriveVersion
    && row.netNextSentVersion !== null
    && (row.netNextRearmedAt === null || now.getTime() - row.netNextRearmedAt.getTime() >= NET_REARM_MIN_MS);
}

/** The report-only half of netNextRearm: lets recordStatus skip the row read for every other report.
 * A board holding PAULANET_DISK_PREVIOUS is a candidate on purpose: the re-arm is what delivers the new disk once the
 * driver goes quiet (R16). */
export function netNextRearmCandidate(
  report: { secondDrive?: string; driveVersion?: number; df1Sha256?: string | null },
): boolean {
  return report.secondDrive === 'net' && report.driveVersion !== undefined
    && report.df1Sha256 !== undefined && report.df1Sha256 !== PAULANET_DISK_SHA256;
}
