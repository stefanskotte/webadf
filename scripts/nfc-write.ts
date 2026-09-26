/**
 * Operator CLI: arms a board's NFC reader to write a disk onto the next tag
 * tapped, and waits for the read-back (spec §5.5).
 *
 * Talks to the LIVE database directly (like firmware-release.ts) -- there is
 * no admin HTTP route for this, and routing through one would add a hop
 * without adding a control, since this process already needs DATABASE_URL.
 *
 * Usage:  pnpm nfc:write "<query>" [--device <name-or-id>]
 */
import { parseArgs } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, games, entitlements } from '@/db/schema/catalog';
import { resolveDiskQuery, type DiskCandidate } from '@/lib/nfc/resolve';
import { selectableDevicesQuery } from '@/lib/nfc/devices';
import { requestNfcWrite, cancelNfcWrite, readWriteResult } from '@/lib/nfc/store';
import { waitForWrite } from '@/lib/nfc/wait-for-write';

const POLL_MS = 1000;
const WAIT_MS = 120_000;

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function label(d: { title: string; diskNo: number; id: string }): string {
  return `${d.title} — disk ${d.diskNo} — ${d.id}`;
}

let args: { device?: string };
let positionals: string[];
try {
  ({ values: args, positionals } = parseArgs({
    options: { device: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  }));
} catch (e) {
  die(`${(e as Error).message}\n\nUsage: pnpm nfc:write "<query>" [--device <name-or-id>]`);
}
const [diskQuery] = positionals;
if (!diskQuery) die('Usage: pnpm nfc:write "<query>" [--device <name-or-id>]');
const deviceArg = args.device;

async function main() {
  const db = getDb();

  // 2. Pick the device. Only one real org exists on this deployment, but the
  // selection is still by device, not by org: with --device, match name or
  // id; with none and exactly one device anywhere, use it; otherwise print
  // the devices and exit. Devices in e2e test orgs (every member
  // @example.test -- live e2e runs pair boards on this same database) are
  // never candidates; see src/lib/nfc/devices.ts.
  const allDevices = await selectableDevicesQuery(db);

  let device: typeof allDevices[number] | undefined;
  if (deviceArg) {
    const matches = allDevices.filter((d) => d.id === deviceArg || d.name === deviceArg);
    if (matches.length !== 1) {
      console.error(`No single device matches --device ${JSON.stringify(deviceArg)}.`);
      for (const d of allDevices) console.error(`  ${d.name} — ${d.id}`);
      process.exit(2);
    }
    [device] = matches;
  } else if (allDevices.length === 1) {
    [device] = allDevices;
  } else {
    console.error(allDevices.length === 0
      ? 'No devices are paired.'
      : 'More than one device is paired; pass --device <name-or-id>.');
    for (const d of allDevices) console.error(`  ${d.name} — ${d.id}`);
    process.exit(2);
  }

  // 3. Refuse a board without a reader.
  if (device.nfcReader !== 'present') {
    die(`"${device.name}" reports its NFC reader as ${device.nfcReader ?? "unknown (older firmware)"} -- nothing to write with.`);
  }

  // 4. Resolve the disk against this org's catalog.
  const rows: DiskCandidate[] = await db.select({
    id: disks.id, title: games.title, diskNo: disks.diskNo, tosecName: disks.tosecName,
    sourceFilename: entitlements.sourceFilename,
  }).from(disks)
    .innerJoin(games, eq(games.id, disks.gameId))
    .leftJoin(entitlements, and(eq(entitlements.orgId, disks.orgId), eq(entitlements.sha256, disks.sha256)))
    .where(eq(disks.orgId, device.orgId));

  const resolved = resolveDiskQuery(rows, diskQuery);
  if (resolved.kind === 'none') die(`No disk matches ${JSON.stringify(diskQuery)}.`);
  if (resolved.kind === 'many') {
    console.error(`${resolved.disks.length} disks match ${JSON.stringify(diskQuery)}:`);
    resolved.disks.forEach((d, i) => console.error(`  ${i + 1}. ${label(d)}`));
    process.exit(2);
  }
  const disk = resolved.disk;

  // 5. Request and wait.
  const seq = await requestNfcWrite(device.orgId, device.id, disk.id, new Date());
  if (seq === null) die(`"${disk.title}" is no longer in this org's catalog.`);

  console.log(`Tap a tag on ${device.name} to write "${disk.title} disk ${disk.diskNo}" (2 min)… Ctrl-C cancels.`);

  let sigint = false;
  const onSigint = () => { sigint = true; };
  process.once('SIGINT', onSigint);

  let outcome;
  try {
    outcome = await waitForWrite({
      deviceId: device.id,
      seq,
      deadline: Date.now() + WAIT_MS,
      pollMs: POLL_MS,
      isCancelled: () => sigint,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      readWriteResult,
      cancelNfcWrite,
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  switch (outcome.kind) {
    case 'ok':
      console.log(`Written to tag ${outcome.uid}, read back OK.`);
      process.exit(0);
      break;
    case 'failed':
      console.error(`Write failed: ${outcome.reason} (tag ${outcome.uid})`);
      process.exit(1);
      break;
    case 'timeout':
      console.error(`Timed out waiting for a tap.${cancelFailureNote(outcome.cancelError)}`);
      process.exit(1);
      break;
    case 'cancelled':
      console.error(`Cancelled.${cancelFailureNote(outcome.cancelError)}`);
      process.exit(1);
      break;
    case 'error':
      console.error(`Error while waiting for the tap: ${errorMessage(outcome.error)}${cancelFailureNote(outcome.cancelError)}`);
      process.exit(1);
      break;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unreachable outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Reported alongside a timeout, a cancellation or a read error whenever the
 *  cancel itself ALSO failed -- the original reason above is never replaced
 *  by this, only appended to, so the operator still learns what ended the
 *  wait even when cancelling could not be confirmed. */
function cancelFailureNote(cancelError: unknown): string {
  if (cancelError === undefined) return '';
  return ` Also failed to cancel the write request: ${errorMessage(cancelError)} -- `
    + 'the board may stay armed until the 2-minute expiry.';
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
