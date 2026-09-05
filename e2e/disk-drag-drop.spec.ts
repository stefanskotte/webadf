import { test, expect, type Page, type Locator } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import {
  readVolume, readFile, readUsage, blocksForPlan, type AdfEntry, type CostItem,
} from '@/lib/adffs';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { signUpFresh, createAdf } from './helpers';
import { cleanupSeeded } from './device-helpers';
import { synthDrop, manyEmptyFilesTree, type DropNode } from './drag-drop-helpers';

/**
 * Task 11: prove dropping and dragging end to end, ON THE BYTES.
 *
 * The collections increment shipped drag-and-drop that was reviewed clean
 * and passed build and unit tests, and still carried three defects only a
 * real browser could reveal: a native anchor hijacking the drag, a
 * post-drag click whose default was never suppressed, and a missing
 * `DndContext` id producing a hydration mismatch on every page load (see
 * collection-provider.tsx's own comments, and file-tree.tsx's, for both).
 * This file exists because none of that is provable any other way.
 *
 * Every disk here is made through `createAdf(page)` (FFS, root at block
 * 880), never seeded -- seedDisk's rows are byte-less and 503 on /adf.
 */

test.afterAll(cleanupSeeded);

/**
 * The one disk `createAdf(page)` just made for this org.
 *
 * THE WAIT LIVES HERE. `createAdf()` returns the moment it clicks the menu
 * item, but the disk is made by a request still in flight -- a database
 * query fired immediately after finds nothing and throws on
 * `game.id`. `e2e/disk-files-edit.spec.ts` hides this same wait inside its
 * own `authoredDisk` helper for exactly this reason; this is that helper,
 * copied rather than imported, matching this repo's own convention of one
 * copy per spec file (see that file's own comment on why).
 */
async function authoredDisk(page: Page, orgId: string) {
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, orgId), eq(games.authored, true)));
  if (!game) throw new Error(`no authored game for org ${orgId} after createAdf`);
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));
  if (!disk) throw new Error(`authored game ${game.id} has no disk row`);
  return disk;
}

async function diskRow(id: string) {
  return (await getDb().select().from(disks).where(eq(disks.id, id)))[0];
}

async function fetchAdf(page: Page, diskId: string): Promise<Uint8Array> {
  const res = await page.request.get(`/api/disks/${diskId}/adf`);
  expect(res.status()).toBe(200);
  return new Uint8Array(await res.body());
}

/** First entry named `name` at the TOP LEVEL of `entries` only. */
function findByName(entries: AdfEntry[], name: string): AdfEntry | null {
  for (const e of entries) if (e.name === name) return e;
  return null;
}

/** Walk a `/`-joined path of names down through nested directories. */
function findByPath(entries: AdfEntry[], path: string[]): AdfEntry | null {
  let level = entries;
  let found: AdfEntry | null = null;
  for (const name of path) {
    found = findByName(level, name);
    if (!found) return null;
    level = found.kind === 'dir' ? found.children : [];
  }
  return found;
}

/** `POST /api/disks/[id]/files`, straight through the API -- faster and more deterministic than clicking through the toolbar for fixtures a test merely needs to already exist. */
async function apiMakeDirectory(page: Page, diskId: string, parentBlock: number, name: string) {
  const res = await page.request.post(`/api/disks/${diskId}/files`, {
    multipart: { parentBlock: String(parentBlock), name },
  });
  if (!res.ok()) throw new Error(`test setup: mkdir "${name}" failed with ${res.status()}`);
}

async function apiUploadFile(
  page: Page, diskId: string, parentBlock: number, name: string, content: Buffer,
) {
  const res = await page.request.post(`/api/disks/${diskId}/files`, {
    multipart: {
      parentBlock: String(parentBlock), name,
      file: { name, mimeType: 'application/octet-stream', buffer: content },
    },
  });
  if (!res.ok()) throw new Error(`test setup: upload "${name}" failed with ${res.status()}`);
}

/**
 * Drag with the real pointer, not `locator.dragTo()` -- copied from
 * collections.spec.ts's own `dragOnto`, whose comment explains why in
 * full: dnd-kit's `MouseSensor` has an 8px activation constraint
 * (file-tree.tsx copies collection-provider.tsx's sensor setup verbatim),
 * which means it has to actually SEE movement accumulate. A single jump
 * from source to target is one mousemove and never activates a drag at
 * all.
 */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag: source or target is not visible');

  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(tx, ty, { steps: 15 });
  await page.mouse.move(tx, ty, { steps: 2 });
  await page.mouse.up();
}

// ---------------------------------------------------------------------------

test('dropping a nested folder writes it, and the files read back out of the disk', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await page.goto(`/disks/${disk.id}/files`);
  await expect(page.getByTestId('drop-strip')).toBeVisible();

  const assignContent = 'C:Assign stub, from an e2e drop';
  const startupContent = 'run C/Assign';
  const tree: DropNode[] = [{
    name: 'Workbench',
    kind: 'dir',
    children: [
      { name: 'C', kind: 'dir', children: [{ name: 'Assign', kind: 'file', content: assignContent }] },
      { name: 'S', kind: 'dir', children: [{ name: 'Startup-Sequence', kind: 'file', content: startupContent }] },
      // Empty directories are part of the structure, not just the files
      // inside it (design §2) -- this is what proves that, not merely that
      // files under it survived.
      { name: 'Empty', kind: 'dir', children: [] },
    ],
  }];

  await synthDrop(page, tree);

  // Workbench, C, Assign, S, Startup-Sequence, Empty -- six staged rows.
  await expect(page.getByTestId('drop-staging-list')).toBeVisible();
  await expect(page.locator('[data-testid^="stage-row-"]')).toHaveCount(6);

  const before = await diskRow(disk.id);
  await page.getByTestId('drop-commit').click();
  await expect(page.locator('[data-testid="fs-entry"][data-name="Workbench"]')).toBeVisible({ timeout: 15_000 });

  const after = await diskRow(disk.id);
  expect(after.id).toBe(disk.id);
  expect(after.sha256).not.toBe(before.sha256);

  // THE POINT: read the tree and the bytes back OUT of the disk, not off
  // the page.
  const adf = await fetchAdf(page, disk.id);
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;

  const workbench = findByName(volume.root, 'Workbench');
  expect(workbench?.kind).toBe('dir');

  const assign = findByPath(volume.root, ['Workbench', 'C', 'Assign']);
  expect(assign).not.toBeNull();
  expect(assign!.kind).toBe('file');
  const assignBytes = readFile(adf, assign!.block);
  expect(assignBytes).not.toBeNull();
  expect(Buffer.from(assignBytes!.bytes).toString()).toBe(assignContent);

  const startup = findByPath(volume.root, ['Workbench', 'S', 'Startup-Sequence']);
  expect(startup).not.toBeNull();
  const startupBytes = readFile(adf, startup!.block);
  expect(Buffer.from(startupBytes!.bytes).toString()).toBe(startupContent);

  const empty = findByPath(volume.root, ['Workbench', 'Empty']);
  expect(empty).not.toBeNull();
  expect(empty!.kind).toBe('dir');
  expect(empty!.children).toEqual([]);
});

test('a folder that does not fit is refused with numbers, before anything is written', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await page.goto(`/disks/${disk.id}/files`);

  // The disk's REAL free-block count, read off its own bitmap -- never
  // hardcoded, because this test's whole point is that the number has to
  // come from the bytes, not from an assumption about how many blocks a
  // blank FFS disk happens to have today.
  const initialAdf = await fetchAdf(page, disk.id);
  const usage = readUsage(initialAdf);
  expect(usage).not.toBeNull();
  const freeBlocks = usage!.freeBlocks;

  // 900 zero-byte files: a header block plus one data block each (§3.1 --
  // a byte total of 0 needs 1,800 blocks) -- comfortably over any
  // plausible free-block count for an 880KB disk, and, at 900 > 100, only
  // reachable at all if the paging trap (§3.4, drag-drop-helpers.ts) is
  // actually being honoured.
  const FILE_COUNT = 900;
  const tree = manyEmptyFilesTree('Big', FILE_COUNT);
  const items: CostItem[] = [
    { kind: 'dir', sizeBytes: 0 },
    ...Array.from({ length: FILE_COUNT }, (): CostItem => ({ kind: 'file', sizeBytes: 0 })),
  ];
  const expectedBlocks = blocksForPlan(items, 'FFS');
  expect(expectedBlocks).toBeGreaterThan(freeBlocks);

  await synthDrop(page, tree);
  await expect(page.getByTestId('drop-staging-list')).toBeVisible();
  await expect(page.locator('[data-testid^="stage-row-"]')).toHaveCount(FILE_COUNT + 1);

  await expect(page.getByTestId('drop-total-blocks')).toHaveText(expectedBlocks.toLocaleString());
  await expect(page.getByTestId('drop-free-blocks')).toHaveText(freeBlocks.toLocaleString());

  const warning = page.getByTestId('drop-capacity-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(expectedBlocks.toLocaleString());
  await expect(warning).toContainText(freeBlocks.toLocaleString());

  // The commit control itself is unusable -- this IS "refused before
  // anything is written": there is no path to a write from here.
  await expect(page.getByTestId('drop-commit')).toBeDisabled();

  // Belt and braces: the server enforces the identical rule independently
  // (design §5 requires the client and the route to never disagree), with
  // its own numbers in the JSON body, and it is checked BEFORE
  // `applyDiskEdit` is even reached -- so a batch this large is refused
  // without ever touching the stored blob.
  const manifest = [
    { op: 'mkdir', path: 'Big2' },
    { op: 'add', path: 'Big2/A.BIN' },
    { op: 'add', path: 'Big2/B.BIN' },
  ];
  // Two ~450KB files needing 913 blocks apiece (900 data blocks plus a
  // header plus extension blocks) -- the same overflow with far fewer
  // multipart parts than the UI's 900-tiny-file shape.
  const bigFileSize = 900 * 512;
  const apiItems: CostItem[] = [
    { kind: 'dir', sizeBytes: 0 },
    { kind: 'file', sizeBytes: bigFileSize },
    { kind: 'file', sizeBytes: bigFileSize },
  ];
  const apiExpectedBlocks = blocksForPlan(apiItems, 'FFS');
  expect(apiExpectedBlocks).toBeGreaterThan(freeBlocks);

  const batchRes = await page.request.post(`/api/disks/${disk.id}/files/batch`, {
    multipart: {
      manifest: JSON.stringify(manifest),
      'Big2/A.BIN': { name: 'A.BIN', mimeType: 'application/octet-stream', buffer: Buffer.alloc(bigFileSize) },
      'Big2/B.BIN': { name: 'B.BIN', mimeType: 'application/octet-stream', buffer: Buffer.alloc(bigFileSize) },
    },
  });
  expect(batchRes.status()).toBe(400);
  const body = await batchRes.json();
  expect(body.error).toBe('edit_failed');
  expect(body.reason).toBe('disk-full');
  expect(body.blocksNeeded).toBe(apiExpectedBlocks);
  expect(body.freeBlocks).toBe(freeBlocks);

  // NOTHING was written, by either attempt.
  const after = await diskRow(disk.id);
  expect(after.sha256).toBe(disk.sha256);
  expect(after.id).toBe(disk.id);
});

test('a collision blocks the commit until resolved, and replace actually replaces', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  const originalContent = Buffer.from('the original contents');
  await apiUploadFile(page, disk.id, ROOT_BLOCK, 'DUPLICATE.TXT', originalContent);

  const uploadedAdf = await fetchAdf(page, disk.id);
  const uploadedVolume = readVolume(uploadedAdf);
  expect(uploadedVolume.ok).toBe(true);
  if (!uploadedVolume.ok) return;
  const originalEntry = findByName(uploadedVolume.root, 'DUPLICATE.TXT')!;
  const originalBlock = originalEntry.block;
  const afterUpload = await diskRow(disk.id);

  await page.goto(`/disks/${disk.id}/files`);
  const newContent = 'replaced by an e2e drop';
  await synthDrop(page, [{ name: 'DUPLICATE.TXT', kind: 'file', content: newContent }]);

  const row = page.locator('[data-testid^="stage-row-"]').filter({ hasText: 'DUPLICATE.TXT' });
  await expect(row).toBeVisible();
  await expect(row.locator('[data-testid^="stage-conflict-"]')).toContainText('DUPLICATE.TXT');

  // D-DD-4: never auto-resolved -- the commit is unusable until a decision
  // is made for this row.
  await expect(page.getByTestId('drop-commit')).toBeDisabled();

  await row.locator('[data-testid^="stage-replace-"]').click();
  await expect(row.locator('[data-testid^="stage-resolution-"]')).toContainText('replace');
  await expect(page.getByTestId('drop-commit')).toBeEnabled();

  await page.getByTestId('drop-commit').click();

  // D-W-6: replace keeps the SAME header block -- it is the file's
  // identity -- and only its data changes. Polled, because the toast/
  // refresh cycle is async and the staging list itself clears immediately
  // on commit regardless of outcome (drop-staging.tsx's own comment on
  // `commit()`), so it cannot be used as the signal here.
  await expect.poll(async () => {
    const adf = await fetchAdf(page, disk.id);
    const volume = readVolume(adf);
    if (!volume.ok) return null;
    const entry = findByName(volume.root, 'DUPLICATE.TXT');
    if (!entry) return null;
    const bytes = readFile(adf, entry.block);
    return bytes ? Buffer.from(bytes.bytes).toString() : null;
  }, { timeout: 15_000 }).toBe(newContent);

  const finalAdf = await fetchAdf(page, disk.id);
  const finalVolume = readVolume(finalAdf);
  expect(finalVolume.ok).toBe(true);
  if (!finalVolume.ok) return;
  const replaced = findByName(finalVolume.root, 'DUPLICATE.TXT')!;
  expect(replaced.block).toBe(originalBlock);

  const after = await diskRow(disk.id);
  expect(after.sha256).not.toBe(afterUpload.sha256);
  expect(after.id).toBe(disk.id);
});

test('a move by drag leaves the entry\'s block number unchanged', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await apiMakeDirectory(page, disk.id, ROOT_BLOCK, 'TARGET');
  await apiUploadFile(page, disk.id, ROOT_BLOCK, 'MOVEME.TXT', Buffer.from('dragged'));

  const beforeAdf = await fetchAdf(page, disk.id);
  const beforeVolume = readVolume(beforeAdf);
  expect(beforeVolume.ok).toBe(true);
  if (!beforeVolume.ok) return;
  const target = findByName(beforeVolume.root, 'TARGET')!;
  const moved = findByName(beforeVolume.root, 'MOVEME.TXT')!;
  const movedBlock = moved.block;

  await page.goto(`/disks/${disk.id}/files`);
  const grip = page.getByTestId(`fs-drag-${movedBlock}`);
  const dropTarget = page.getByTestId(`fs-drop-${target.block}`);
  await expect(grip).toBeVisible();
  await expect(dropTarget).toBeVisible();

  await dragOnto(page, grip, dropTarget);

  await expect.poll(async () => {
    const adf = await fetchAdf(page, disk.id);
    const volume = readVolume(adf);
    if (!volume.ok) return null;
    return findByPath(volume.root, ['TARGET', 'MOVEME.TXT'])?.block ?? null;
  }, { timeout: 15_000 }).toBe(movedBlock);

  // It really did leave the root, not merely get copied into TARGET too.
  const afterAdf = await fetchAdf(page, disk.id);
  const afterVolume = readVolume(afterAdf);
  expect(afterVolume.ok).toBe(true);
  if (!afterVolume.ok) return;
  expect(findByName(afterVolume.root, 'MOVEME.TXT')).toBeNull();

  const after = await diskRow(disk.id);
  expect(after.sha256).not.toBe(disk.sha256);
});

test('a move by keyboard through "Move to…" leaves the entry\'s block number unchanged', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await apiMakeDirectory(page, disk.id, ROOT_BLOCK, 'DEST');
  await apiUploadFile(page, disk.id, ROOT_BLOCK, 'KBMOVE.TXT', Buffer.from('by keyboard'));

  const beforeAdf = await fetchAdf(page, disk.id);
  const beforeVolume = readVolume(beforeAdf);
  expect(beforeVolume.ok).toBe(true);
  if (!beforeVolume.ok) return;
  const dest = findByName(beforeVolume.root, 'DEST')!;
  const moved = findByName(beforeVolume.root, 'KBMOVE.TXT')!;
  const movedBlock = moved.block;

  await page.goto(`/disks/${disk.id}/files`);
  await page.getByTestId(`fs-move-${movedBlock}`).click();
  const select = page.getByTestId(`fs-move-target-${movedBlock}`);
  await expect(select).toBeVisible();
  await select.selectOption(String(dest.block));
  await page.getByTestId(`fs-move-submit-${movedBlock}`).click();

  await expect.poll(async () => {
    const adf = await fetchAdf(page, disk.id);
    const volume = readVolume(adf);
    if (!volume.ok) return null;
    return findByPath(volume.root, ['DEST', 'KBMOVE.TXT'])?.block ?? null;
  }, { timeout: 15_000 }).toBe(movedBlock);

  const after = await diskRow(disk.id);
  expect(after.sha256).not.toBe(disk.sha256);
});

test('moving a folder into its own child is refused, on the bytes and in the menu', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  const disk = await authoredDisk(page, u.orgId);

  await apiMakeDirectory(page, disk.id, ROOT_BLOCK, 'PARENT');
  const afterParent = await fetchAdf(page, disk.id);
  const parentVolume = readVolume(afterParent);
  expect(parentVolume.ok).toBe(true);
  if (!parentVolume.ok) return;
  const parent = findByName(parentVolume.root, 'PARENT')!;

  await apiMakeDirectory(page, disk.id, parent.block, 'CHILD');
  const beforeAttempt = await diskRow(disk.id);
  const afterChild = await fetchAdf(page, disk.id);
  const childVolume = readVolume(afterChild);
  expect(childVolume.ok).toBe(true);
  if (!childVolume.ok) return;
  const child = findByPath(childVolume.root, ['PARENT', 'CHILD'])!;

  // D-DD-6, on the bytes: our own reader's cycle guard would happily
  // display a folder moved inside its own child (dir.ts CONTAINS the loop
  // rather than reporting it), so this is checked against the real route,
  // not against what the page renders.
  const res = await page.request.patch(`/api/disks/${disk.id}/files/${parent.block}`, {
    data: { toParent: child.block },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('edit_failed');
  expect(body.reason).toBe('a folder cannot be moved inside itself');

  const afterAttempt = await diskRow(disk.id);
  expect(afterAttempt.sha256).toBe(beforeAttempt.sha256);
  expect(afterAttempt.id).toBe(disk.id);

  // And the interface never offers the destination in the first place
  // (file-tree.tsx's `subtreeBlocks`) -- a drop the UI visibly accepted
  // and then rejected would be worse than one it never offered.
  await page.goto(`/disks/${disk.id}/files`);
  await page.getByTestId(`fs-move-${parent.block}`).click();
  const select = page.getByTestId(`fs-move-target-${parent.block}`);
  await expect(select).toBeVisible();
  await expect(select.locator(`option[value="${child.block}"]`)).toHaveCount(0);
  await expect(select.locator(`option[value="${parent.block}"]`)).toHaveCount(0);
});
