/**
 * The PaulaNET driver disk (spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md §2):
 * Rob Smith's disk plus our Install and ReadMe, built by tools/paulanet-disk/build.sh. A fixed image the server
 * knows by digest -- not a library disk, owned by no organization. Uploaded once to the disk store
 * (scripts/paulanet-disk-upload.ts). Its PaulaNET.device and PaulaNET Config are Rob's, used by permission
 * under his terms (third-party/paulanet/); they are not MIT.
 */
export const PAULANET_DISK_SHA256 = '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e';
export const PAULANET_DISK_BYTES = 901_120;

/** What the poll carries as DF1's `next` in Network mode (plan 2026-10-12 ruling 12). */
export const PAULANET_NEXT = { diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 } as const;

/** Digests the blob GC keeps although no row names them (blob-gc-run.ts). */
export const ALWAYS_REFERENCED_BLOBS: readonly string[] = [PAULANET_DISK_SHA256];

/**
 * The one image a board may fetch without its organization owning it -- and only from its own route,
 * /api/device/image/net/<sha256> (pre-flight I3), never from the library route /api/device/image/<sha256>.
 */
export function servedWithoutEntitlement(sha256: string): boolean {
  return sha256 === PAULANET_DISK_SHA256;
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
