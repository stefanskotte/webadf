import { type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { formatVolume } from '@/lib/adffs/format';
import { applyBatch, type BatchOp } from '@/lib/adffs/write';
import { listTransfers } from '@/lib/transfers';
import { diskStore } from '@/lib/storage';
import { signUpFresh } from './helpers';
import { addDisk, pairDevice, seedDisk, setBrowse } from './device-helpers';
import { boardSays, boardServes, type BoardRequest, type FakeEntry, type VolumeNext } from './amiga-board';

/** What files-disks-as-folders.spec.ts and its phone twin share: a title of real disks, and the fake board they land on. */

export const LIVE = 15_000;
const FW = '1.23.0+gabc1234';
const enc = (s: string) => new TextEncoder().encode(s);

export const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);
export const cards = (page: Page) => page.getByTestId('transfers-card');

/** A real FFS image: an icon, a ReadMe that says which disk it is, a file in a drawer and an empty drawer. */
async function storedDisk(tag: string) {
  const ops: BatchOp[] = [
    { op: 'add', parentPath: '', name: 'ReadMe', bytes: enc(`read me, ${tag}, ${randomUUID()}`) },
    { op: 'add', parentPath: '', name: 'Disk.info', bytes: enc('icon') },
    { op: 'mkdir', parentPath: '', name: 'C' },
    { op: 'add', parentPath: 'C', name: 'Assign', bytes: enc('assign stub') },
    { op: 'mkdir', parentPath: '', name: 'Empty' },
  ];
  const r = applyBatch(ops)(formatVolume({ filesystem: 'FFS', volumeName: tag.replace(/[:/]/g, '').slice(0, 24) }));
  if (!r.ok) throw new Error(r.reason);
  const sha256 = createHash('sha256').update(r.adf).digest('hex');
  await diskStore.put(sha256, r.adf);
  return sha256;
}

/** One title holding one disk per label, in order. */
export async function seedTitle(orgId: string, title: string, labels: string[]) {
  const sha = await storedDisk(labels[0]);
  const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha, sizeBytes: 901120, writeProtected: false });
  await getDb().update(disks).set({ label: labels[0] }).where(eq(disks.id, diskId));
  const ids = [diskId];
  for (const [i, label] of labels.slice(1).entries()) {
    const added = await addDisk(orgId, gameId, { diskNo: i + 2, sha256: await storedDisk(label), label, writeProtected: false });
    ids.push(added.diskId);
  }
  return { gameId, diskIds: ids };
}

/** A fresh org with one board that can write: firmware 1.23.0, Transfer on protocol 5 with browsing and writing on. */
export async function writable(page: Page, request: APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500');
  await boardSays(request, token, FW);
  await setBrowse(deviceId, { firmware: FW, rx: 'c', rxProto: 5, browseOn: true, writeOn: true });
  return { orgId, deviceId, token };
}

/** The fake board serving `fs` (requests and its queue) until stop(). */
export function serving(request: APIRequestContext, token: string, fs: Record<string, FakeEntry[]>, maxMs = 120_000) {
  let done = false;
  const served: BoardRequest[] = [];
  const queue: VolumeNext[] = [];
  const run = boardServes(request, token, fs, () => done, served, maxMs, { queue });
  return { served, queue, stop: async () => { done = true; return run; } };
}

/** How many transfers rows name each place on the Amiga: GET /api/transfers leaves amigaDest out, so its own query. */
export async function queuedPerDest(orgId: string, deviceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of await listTransfers(getDb(), orgId, deviceId)) if (r.amigaDest) out[r.amigaDest] = (out[r.amigaDest] ?? 0) + 1;
  return out;
}
