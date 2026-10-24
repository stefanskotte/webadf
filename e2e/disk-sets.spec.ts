import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { collectionGames } from '@/db/schema/collections';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { ARM_DELAY_MS, EDGE_REST_MS, zoneOf } from '@/lib/set-folder';
import { signUpFresh, runTag, libRows, stagingReady } from './helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded } from './device-helpers';

/**
 * Disk sets (spec 2026-09-28-disk-sets, Task 10): the first time the title
 * page's Disk set section, the Add disks… dialog and the upload suggestion
 * run in a real browser against the real database.
 *
 * Every test signs up its own org. Disks that need a real image (the upload
 * suggestion reads volume names) or a real uploaded file name (move-out names
 * the new title after it) go through the REAL ingest flow and are purged with
 * the org; the rest are
 * seeded rows, tracked by device-helpers. cleanupSeeded removes both.
 */
test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(`disk-sets-${s}`).digest('hex');

/**
 * A real FFS volume named `volumeName`, with one file of random bytes so its
 * sha256 is new on every run (blobs are global and content-addressed; a fixed
 * image would dedupe against an earlier run and prove nothing about ingest).
 */
function adfBytes(volumeName: string): Buffer {
  return Buffer.from(syntheticVolume({
    filesystem: 'FFS',
    volumeName,
    entries: [{ name: 'id', bytes: new TextEncoder().encode(randomUUID()) }],
  }));
}

/** Upload one image through the real presign → PUT → complete flow. */
async function ingestAdf(page: Page, filename: string, content: Buffer): Promise<string> {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: content.length }] },
  });
  expect(presign.status()).toBe(200);
  const { uploads } = await presign.json();
  if (uploads.length > 0) {
    const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
    if (!put.ok) throw new Error(`test setup: blob PUT failed with ${put.status}`);
  }
  const done = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: content.length, filename }] },
  });
  expect(done.status()).toBe(200);
  return sha256;
}

async function diskOf(orgId: string, sha256: string) {
  const [row] = await getDb().select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo })
    .from(disks).where(and(eq(disks.orgId, orgId), eq(disks.sha256, sha256)));
  if (!row) throw new Error(`no disk for ${sha256.slice(0, 12)}`);
  return row;
}

async function diskNos(ids: string[]): Promise<Record<string, { gameId: string; diskNo: number }>> {
  const rows = await getDb().select({ id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo })
    .from(disks).where(inArray(disks.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, { gameId: r.gameId, diskNo: r.diskNo }]));
}

async function orgGames(orgId: string) {
  return getDb().select({ id: games.id, title: games.title }).from(games).where(eq(games.orgId, orgId));
}

async function gameExists(id: string): Promise<boolean> {
  return (await getDb().select({ id: games.id }).from(games).where(eq(games.id, id))).length > 0;
}

/** The set's disk rows, top to bottom, as ids. */
async function rowOrder(page: Page): Promise<string[]> {
  return page.getByTestId('disk-set-section').locator(':scope > [data-disk-row]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('disk-'.length)));
}

/** Reorder mode's rows, top to bottom, as ids. */
async function reorderOrder(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="disk-reorder-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('disk-reorder-row-'.length)));
}

/** Seed a title with `n` disks (no images). */
async function seedSet(orgId: string, title: string, n: number) {
  const tag = runTag();
  const first = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`${tag}-1`) });
  const ids = [first.diskId];
  const shas = [sha(`${tag}-1`)];
  for (let i = 2; i <= n; i++) {
    const s = sha(`${tag}-${i}`);
    ids.push((await addDisk(orgId, first.gameId, { diskNo: i, sha256: s })).diskId);
    shas.push(s);
  }
  return { gameId: first.gameId, ids, shas };
}

/**
 * A locator's bounding box once it is visible. Library cards and rows stream in: they sit in the DOM hidden until
 * React reveals them, and a hidden element's boundingBox() is null -- which is the "Cannot read properties of null
 * (reading 'x')" these drags used to die with. Always wait for the element before measuring it.
 */
async function box(l: Locator) {
  await expect(l).toBeVisible();
  const b = await l.boundingBox();
  if (!b) throw new Error('box: no bounding box for a visible element');
  return b;
}

/**
 * Drag with the real pointer -- copied from disk-drag-drop.spec.ts's
 * `dragOnto` (itself from collections.spec.ts): dnd-kit's MouseSensor needs
 * 8px of travel it can SEE accumulate, so a single jump never starts a drag.
 */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const from = await box(source);
  const to = await box(target);
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


/**
 * Drop the five 3.1.4-style files on /ingest and wait for the panel. Each
 * image's volume name is its filename without the extension, so labels and
 * the suggested name come out the same whether suggestSet reads the volume or
 * falls back to the filename. Dropped in a deliberately wrong order
 * (Install third) so "Install first" is the suggestion's doing.
 */
async function dropRelease(page: Page, orgId: string) {
  const order = ['Workbench3_1_4', 'Extras3_1_4', 'Install3_1_4', 'Fonts', 'Locale'];
  const files = order.map((v) => ({ name: `${v}.adf`, mimeType: 'application/octet-stream', buffer: adfBytes(v) }));
  await page.goto('/ingest');
  await stagingReady(page);
  await page.getByTestId('file-input').setInputFiles(files);
  await expect(libRows(page)).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await expect(libRows(page).nth(i)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  }
  await expect(page.getByTestId('set-suggestion')).toBeVisible({ timeout: 30_000 });

  const id: Record<string, string> = {};
  const shas: Record<string, string> = {};
  for (let i = 0; i < order.length; i++) {
    shas[order[i]] = createHash('sha256').update(files[i].buffer).digest('hex');
    id[order[i]] = (await diskOf(orgId, shas[order[i]])).id;
  }
  return { id, shas, files };
}

async function panelOrder(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="set-suggestion-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('set-suggestion-row-'.length)));
}

// ---------------------------------------------------------------------------

test('upload: the 3.1.4 disks are suggested as "AmigaOS 3.1.4", Install first; accepting all five makes the set', async ({ page }) => {
  test.setTimeout(120_000);
  const { orgId } = await signUpFresh(page);
  const { id } = await dropRelease(page, orgId);

  await expect(page.getByTestId('set-suggestion')).toContainText('These 5 disks look like one set.');
  await expect(page.getByTestId('set-suggestion-name')).toHaveValue('AmigaOS 3.1.4');

  const panel = await panelOrder(page);
  expect(panel[0]).toBe(id.Install3_1_4);
  expect(panel.slice(0, 3)).toEqual([id.Install3_1_4, id.Workbench3_1_4, id.Extras3_1_4]);
  for (const v of ['Install3_1_4', 'Workbench3_1_4', 'Extras3_1_4']) {
    await expect(page.getByTestId(`set-suggestion-tick-${id[v]}`)).toBeChecked();
  }
  for (const v of ['Fonts', 'Locale']) {
    await expect(page.getByTestId(`set-suggestion-tick-${id[v]}`)).not.toBeChecked();
    await page.getByTestId(`set-suggestion-tick-${id[v]}`).check();
  }

  await page.getByTestId('set-suggestion-accept').click();
  await expect(page.getByTestId('set-suggestion')).toHaveCount(0);

  // The set is Install's title, renamed; every other title is gone.
  const setId = (await diskNos([id.Install3_1_4]))[id.Install3_1_4].gameId;
  const left = await orgGames(orgId);
  expect(left).toEqual([{ id: setId, title: 'AmigaOS 3.1.4' }]);

  await page.goto(`/games/${setId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'AmigaOS 3.1.4' }).first()).toBeVisible();
  await expect(page.getByTestId('disk-set-section')).toContainText('5 disks');
  expect(await rowOrder(page)).toEqual(panel);
  await expect(page.getByTestId(`disk-${id.Install3_1_4}`)).toContainText('Disk 1');
  const nos = await diskNos(panel);
  panel.forEach((d, i) => expect(nos[d]).toEqual({ gameId: setId, diskNo: i + 1 }));
});

test('upload: a reordered, partly ticked suggestion makes exactly that set; re-uploading a moved disk brings back no title', async ({ page }) => {
  test.setTimeout(150_000);
  const { orgId } = await signUpFresh(page);
  const { id, files } = await dropRelease(page, orgId);

  // Extras above Workbench, Fonts ticked, Locale left out, and a new name.
  await page.getByTestId(`set-suggestion-up-${id.Extras3_1_4}`).click();
  const panel = await panelOrder(page);
  expect(panel.slice(0, 3)).toEqual([id.Install3_1_4, id.Extras3_1_4, id.Workbench3_1_4]);
  await page.getByTestId(`set-suggestion-tick-${id.Fonts}`).check();
  await page.getByTestId('set-suggestion-name').fill('My 3.1.4');
  await page.getByTestId('set-suggestion-accept').click();
  await expect(page.getByTestId('set-suggestion')).toHaveCount(0);

  const expected = panel.filter((d) => d !== id.Locale);
  const nos = await diskNos([...expected, id.Locale]);
  const setId = nos[id.Install3_1_4].gameId;
  expected.forEach((d, i) => expect(nos[d]).toEqual({ gameId: setId, diskNo: i + 1 }));
  // Locale stays a lone title of its own.
  expect(nos[id.Locale].gameId).not.toBe(setId);
  expect(nos[id.Locale].diskNo).toBe(1);

  const before = (await orgGames(orgId)).map((g) => g.id).sort();
  expect(before).toEqual([setId, nos[id.Locale].gameId].sort());

  await page.goto(`/games/${setId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'My 3.1.4' }).first()).toBeVisible();
  expect(await rowOrder(page)).toEqual(expected);

  // Review Focus 2 / plan P4: Workbench now lives in the set but keeps its
  // id, which was minted from its ORIGINAL title. Re-uploading the same file
  // must not bring that title back, empty or with a duplicate disk.
  const wb = files.find((f) => f.name === 'Workbench3_1_4.adf')!;
  await page.goto('/ingest');
  await stagingReady(page);
  // Waited on /complete itself, not the row: a deduped row turns blue as soon
  // as /check answers, BEFORE /complete has run (and re-created, then
  // removed, the original title).
  const completed = page.waitForResponse((r) => r.url().includes('/api/ingest/complete'), { timeout: 30_000 });
  await page.getByTestId('file-input').setInputFiles(wb);
  expect((await completed).status()).toBe(200);
  await expect(libRows(page).first()).toHaveAttribute('data-state', 'deduped');

  const after = (await orgGames(orgId)).map((g) => g.id).sort();
  expect(after).toEqual(before);
  const wbRows = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks)
    .where(and(eq(disks.orgId, orgId), eq(disks.sha256, createHash('sha256').update(wb.buffer).digest('hex'))));
  expect(wbRows).toEqual([{ id: id.Workbench3_1_4, gameId: setId }]);

  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
});

test('Add disks… folds a lone title in as the last disk, and the old title is really gone', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const set = await seedSet(orgId, `Set ${tag}`, 2);
  const lone = await seedDisk(orgId, { title: `Lone ${tag}`, diskNo: 1, sha256: sha(`${tag}-lone`) });

  await page.goto(`/games/${set.gameId}`);
  await page.getByTestId('disk-set-add').click();
  const dialog = page.getByTestId('add-disks-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('add-disks-search').fill(`Lone ${tag}`);
  await dialog.getByTestId(`add-disks-pick-${lone.gameId}`).check();
  await dialog.getByTestId('add-disks-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Moved to Set ${tag}`)).toBeVisible();

  await expect(page.getByTestId(`disk-${lone.diskId}`)).toContainText('Disk 3');
  expect(await rowOrder(page)).toEqual([...set.ids, lone.diskId]);
  expect((await diskNos([lone.diskId]))[lone.diskId]).toEqual({ gameId: set.gameId, diskNo: 3 });

  // Task 4's NOT EXISTS guard, on the real database: the emptied title is gone.
  expect(await gameExists(lone.gameId)).toBe(false);
  // The not-found card, not a 404 status: the app streams behind its loading.tsx (A1 States), so the status is sent before notFound() runs.
  await page.goto(`/games/${lone.gameId}`);
  await expect(page.getByTestId('not-found-page')).toBeVisible();
  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(page.getByTestId('game-card').filter({ hasText: `Lone ${tag}` })).toHaveCount(0);
});

// 2026-10-10: a 35-disk upload; Add disks… listed 20 titles with no sign of
// more, all 20 were ticked, and the other 13 stayed in Uncategorized.
test('Add disks… says when the list is cut, and Show more brings the rest so all of them can be added', async ({ page }) => {
  test.setTimeout(120_000); // 23 seeded rows against the live database
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const set = await seedSet(orgId, `Set ${tag}`, 2);
  const lone: { gameId: string; diskId: string }[] = [];
  for (let i = 0; i < 21; i++) {
    lone.push(await seedDisk(orgId, { title: `Many ${tag} ${String(i).padStart(2, '0')}`, diskNo: 1, sha256: sha(`${tag}-m${i}`) }));
  }

  await page.goto(`/games/${set.gameId}`);
  await page.getByTestId('disk-set-add').click();
  const dialog = page.getByTestId('add-disks-dialog');
  const picks = dialog.locator('[data-testid^="add-disks-pick-"]');
  await expect(picks).toHaveCount(20);
  await expect(dialog.getByTestId('add-disks-more-note')).toBeVisible();
  await dialog.getByTestId('add-disks-more').click();
  await expect(picks).toHaveCount(21);
  await expect(dialog.getByTestId('add-disks-more')).toHaveCount(0);

  for (const l of lone) await dialog.getByTestId(`add-disks-pick-${l.gameId}`).check();
  await dialog.getByTestId('add-disks-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Moved to Set ${tag}`)).toBeVisible();

  const nos = await diskNos(lone.map((l) => l.diskId));
  for (const l of lone) expect(nos[l.diskId].gameId).toBe(set.gameId);
  expect(await orgGames(orgId)).toHaveLength(1);
});

test('reorder: Move up renumbers, and in reorder mode a drag and the ▲▼ buttons move disks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const set = await seedSet(orgId, `Reorder ${runTag()}`, 3);
  const [a, b, c] = set.ids;

  await page.goto(`/games/${set.gameId}`);
  await page.getByTestId(`disk-menu-${b}`).click();
  await page.getByTestId(`disk-up-${b}`).click();
  await expect(page.getByTestId(`disk-${b}`)).toContainText('Disk 1');
  await expect(page.getByTestId(`disk-${a}`)).toContainText('Disk 2');
  expect(await rowOrder(page)).toEqual([b, a, c]);
  await expect.poll(async () => (await diskNos([b]))[b].diskNo).toBe(1);

  // The first row's Move up is disabled, the last row's Move down too.
  await page.getByTestId(`disk-menu-${b}`).click();
  await expect(page.getByTestId(`disk-up-${b}`)).toHaveAttribute('data-disabled', /.*/);
  await page.keyboard.press('Escape');

  await page.getByTestId('disk-set-reorder').click();
  expect(await reorderOrder(page)).toEqual([b, a, c]);

  // Drag c to the top.
  await dragOnto(page, page.getByTestId(`disk-grip-${c}`), page.getByTestId(`disk-reorder-row-${b}`));
  await expect(page.getByTestId(`disk-reorder-no-${c}`)).toHaveText('1');
  await expect.poll(async () => {
    const n = await diskNos([a, b, c]);
    return [n[c].diskNo, n[b].diskNo, n[a].diskNo];
  }).toEqual([1, 2, 3]);

  // ▼ on the top row.
  await page.getByTestId(`disk-reorder-down-${c}`).click();
  await expect(page.getByTestId(`disk-reorder-no-${c}`)).toHaveText('2');
  await expect.poll(async () => {
    const n = await diskNos([a, b, c]);
    return [n[b].diskNo, n[c].diskNo, n[a].diskNo];
  }).toEqual([1, 2, 3]);

  await page.getByTestId('disk-set-done').click();
  await expect(page.getByTestId('disk-set-reorder')).toBeVisible();
  await page.reload();
  expect(await rowOrder(page)).toEqual([b, c, a]);
  await expect(page.getByTestId(`disk-${a}`)).toContainText('Disk 3');
});

test('move out stays on the set and its toast opens a lone title named after the file; Add to a disk set… and Undo from its toast put it back', async ({ page }) => {
  test.setTimeout(90_000);
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const title = `MoveOut ${tag}`;
  const vols = ['MoA', 'MoB', 'MoC'].map((v) => `${v}${tag.slice(-6)}`);
  const shas: string[] = [];
  for (let i = 0; i < 3; i++) {
    shas.push(await ingestAdf(page, `${title} (Disk ${i + 1} of 3).adf`, adfBytes(vols[i])));
  }
  const d = await Promise.all(shas.map((s) => diskOf(orgId, s)));
  const setId = d[0].gameId;
  expect(d.map((x) => x.gameId)).toEqual([setId, setId, setId]);

  await page.goto(`/games/${setId}`);
  await page.getByTestId(`disk-menu-${d[1].id}`).click();
  await page.getByTestId(`disk-move-out-${d[1].id}`).click();

  // The page stays on the set (operator, 2026-09-29): disk 2 leaves the list
  // and the rest renumber from 1.
  const moved = page.locator('[data-sonner-toast]').filter({ hasText: 'Moved out to its own title' });
  await expect(moved).toBeVisible();
  await expect(page.getByTestId(`disk-${d[1].id}`)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/games/${setId}$`));
  expect(await rowOrder(page)).toEqual([d[0].id, d[2].id]);
  await expect(page.getByTestId(`disk-${d[0].id}`)).toContainText('Disk 1');
  await expect(page.getByTestId(`disk-${d[2].id}`)).toContainText('Disk 2');
  // The set renumbered: old disk 3 is now disk 2.
  expect((await diskNos([d[2].id]))[d[2].id]).toEqual({ gameId: setId, diskNo: 2 });

  // The toast's Open goes to the new title, named after disk 2's file name
  // without its extension -- not its volume name (operator, 2026-09-29).
  const outName = `${title} (Disk 2 of 3)`;
  await moved.getByRole('button', { name: 'Open' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/games/${setId}$`));
  await expect(page.getByRole('heading', { level: 1, name: outName }).first()).toBeVisible();
  const outId = page.url().split('/games/')[1].split(/[?#]/)[0];
  expect((await diskNos([d[1].id]))[d[1].id]).toEqual({ gameId: outId, diskNo: 1 });

  // A lone disk has no Disk set section and no "Move out of set": only
  // "Add to a disk set…".
  await expect(page.getByTestId('disk-set-section')).toHaveCount(0);
  await page.getByTestId(`disk-menu-${d[1].id}`).click();
  await expect(page.getByTestId(`disk-add-to-set-${d[1].id}`)).toBeVisible();
  await expect(page.getByTestId(`disk-move-out-${d[1].id}`)).toHaveCount(0);
  await expect(page.getByTestId(`disk-up-${d[1].id}`)).toHaveCount(0);
  await page.getByTestId(`disk-add-to-set-${d[1].id}`).click();

  const dialog = page.getByTestId('add-disks-dialog');
  await dialog.getByTestId('add-disks-search').fill(title);
  await dialog.getByTestId(`add-disks-pick-${setId}`).check();
  await dialog.getByTestId('add-disks-confirm').click();

  await expect(page).toHaveURL(new RegExp(`/games/${setId}$`));
  await expect(page.getByTestId(`disk-${d[1].id}`)).toContainText('Disk 3');
  expect(await gameExists(outId)).toBe(false);

  const toastEl = page.locator('[data-sonner-toast]').filter({ hasText: `Moved to ${title}` });
  await expect(toastEl).toBeVisible();
  await toastEl.getByRole('button', { name: 'Undo' }).click();

  // Undo recreates the lone title (a new id) and goes there.
  await expect(page).not.toHaveURL(new RegExp(`/games/${setId}$`));
  await expect(page.getByRole('heading', { level: 1, name: outName }).first()).toBeVisible();
  const restoredId = page.url().split('/games/')[1].split(/[?#]/)[0];
  await expect(page.getByTestId(`disk-${d[1].id}`)).toBeVisible();
  const n = await diskNos(d.map((x) => x.id));
  expect(n[d[1].id]).toEqual({ gameId: restoredId, diskNo: 1 });
  expect(n[d[0].id]).toEqual({ gameId: setId, diskNo: 1 });
  expect(n[d[2].id]).toEqual({ gameId: setId, diskNo: 2 });
  expect((await orgGames(orgId)).map((g) => g.id).sort()).toEqual([setId, restoredId].sort());
});

test('Next follows the new order, and a board keeps the disk it holds (Review Focus 1)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const set = await seedSet(orgId, `NextOrder ${runTag()}`, 3);
  const [a, b, c] = set.ids;

  const mount = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: b } });
  expect(mount.status()).toBe(200);
  const { version } = await mount.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: set.shas[1], mountedDiskId: b, version },
  })).status()).toBe(204);

  // Disk 2 becomes disk 1, through the title page.
  await page.goto(`/games/${set.gameId}`);
  await page.getByTestId(`disk-menu-${b}`).click();
  await page.getByTestId(`disk-up-${b}`).click();
  await expect(page.getByTestId(`disk-${b}`)).toContainText('Disk 1');
  await expect.poll(async () => (await diskNos([b]))[b].diskNo).toBe(1);

  const poll = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll.desired.diskId).toBe(b);
  expect(poll.desired.diskNo).toBe(1);
  expect(poll.next.diskId).toBe(a);
  const [dev] = await getDb().select({
    desiredDiskId: devices.desiredDiskId, desiredDiskNo: devices.desiredDiskNo,
    mountedDiskId: devices.mountedDiskId, mountedDiskNo: devices.mountedDiskNo,
  }).from(devices).where(eq(devices.id, deviceId));
  expect(dev).toEqual({ desiredDiskId: b, desiredDiskNo: 1, mountedDiskId: b, mountedDiskNo: 1 });

  const next = await page.request.post(`/api/devices/${deviceId}/next`);
  expect(next.status()).toBe(200);
  expect(await next.json()).toEqual({ outcome: 'mounting', diskNo: 2, diskCount: 3 });
  const [after] = await getDb().select({ id: devices.desiredDiskId }).from(devices).where(eq(devices.id, deviceId));
  expect(after.id).toBe(a);
  void c;
});

test('org scoping: another org\'s title and disks answer 404', async ({ page, browser }) => {
  const { orgId } = await signUpFresh(page);
  const set = await seedSet(orgId, `Scoped ${runTag()}`, 2);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  try {
    const { orgId: orgB } = await signUpFresh(pageB);
    const mine = await seedDisk(orgB, { title: `Mine ${runTag()}`, diskNo: 1, sha256: sha(`${runTag()}-b`) });

    expect((await pageB.request.post(`/api/games/${set.gameId}/disks`, { data: { diskIds: [mine.diskId] } })).status()).toBe(404);
    expect((await pageB.request.post(`/api/games/${mine.gameId}/disks`, { data: { diskIds: [set.ids[0]] } })).status()).toBe(404);
    // A title of another org is not a source either (drag a card onto a card).
    expect((await pageB.request.post(`/api/games/${mine.gameId}/disks`, { data: { sourceGameIds: [set.gameId] } })).status()).toBe(404);
    expect((await pageB.request.put(`/api/games/${set.gameId}/disk-order`, { data: { diskIds: [...set.ids].reverse() } })).status()).toBe(404);
    expect((await pageB.request.post(`/api/disks/${set.ids[0]}/move-out`)).status()).toBe(404);
  } finally {
    await ctxB.close();
  }
  const n = await diskNos(set.ids);
  expect(n[set.ids[0]]).toEqual({ gameId: set.gameId, diskNo: 1 });
  expect(n[set.ids[1]]).toEqual({ gameId: set.gameId, diskNo: 2 });
});

// ---------------------------------------------------------------------------
// Drag a library card onto a card (approved 2026-09-29).

/** The library card showing `title`. */
const card = (page: Page, title: string) => page.getByTestId('game-card').filter({ hasText: title });

/**
 * dragOnto, but it stops over the target to prove the hint is drawn there
 * (and only there) before letting go.
 */
async function dragCardOnto(page: Page, source: Locator, target: Locator) {
  const from = (await box(source));
  const to = (await box(target));
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(tx, ty, { steps: 15 });
  await page.mouse.move(tx, ty, { steps: 2 });
  await expect(target.getByTestId('set-drop-target')).toBeVisible();
  await expect(target.getByTestId('set-drop-target')).toHaveText('Add to disk set');
  await expect(page.getByTestId('set-drop-target')).toHaveCount(1);
  await page.mouse.up();
  // dnd-kit's pointer sensor keeps a document-level capture listener that
  // stops every click for 50ms after a drop (AbstractPointerSensor.detach:
  // setTimeout(removeAll, 50)). The dialog is up well within that, and a
  // Playwright click on it that soon is swallowed -- no person clicks that
  // fast, so wait the window out rather than race it.
  await page.waitForTimeout(100);
}

test('All titles: a card dropped on a card asks, then makes one set named as typed, target\'s disks first', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedSet(orgId, `DropA ${tag}`, 2);
  const b = await seedDisk(orgId, { title: `DropB ${tag}`, diskNo: 1, sha256: sha(`${tag}-b`) });

  await page.goto('/library?collection=all');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  await dragCardOnto(page, card(page, `DropB ${tag}`), card(page, `DropA ${tag}`));

  const dialog = page.getByTestId('set-drop-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Add to a disk set' })).toBeVisible();
  await expect(dialog.getByTestId('set-drop-order-1')).toContainText(`DropA ${tag}`);
  await expect(dialog.getByTestId('set-drop-order-1')).toContainText('2 disks');
  await expect(dialog.getByTestId('set-drop-order-2')).toContainText(`DropB ${tag}`);
  await expect(dialog.getByTestId('set-drop-order-2')).toContainText('1 disk');
  // Still on the library: the click that ends a drag did not follow the card's link.
  await expect(page).toHaveURL(/\/library\?collection=all$/);

  const name = dialog.getByTestId('set-drop-name');
  await expect(name).toHaveValue(`DropA ${tag}`);
  await name.fill('');
  await expect(dialog.getByTestId('set-drop-confirm')).toBeDisabled();
  await name.fill(`Dropped ${tag}`);
  await dialog.getByTestId('set-drop-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Moved to Dropped ${tag}` })).toBeVisible();

  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(card(page, `Dropped ${tag}`)).toBeVisible();
  await expect(card(page, `Dropped ${tag}`)).toContainText('3');

  const nos = await diskNos([...a.ids, b.diskId]);
  expect([nos[a.ids[0]], nos[a.ids[1]], nos[b.diskId]]).toEqual([
    { gameId: a.gameId, diskNo: 1 }, { gameId: a.gameId, diskNo: 2 }, { gameId: a.gameId, diskNo: 3 },
  ]);
  expect(await orgGames(orgId)).toEqual([{ id: a.gameId, title: `Dropped ${tag}` }]);

  await page.goto(`/games/${a.gameId}`);
  await expect(page.getByRole('heading', { level: 1, name: `Dropped ${tag}` }).first()).toBeVisible();
  await expect(page.getByTestId('set-name')).toHaveText(`Dropped ${tag}`);
  expect(await rowOrder(page)).toEqual([...a.ids, b.diskId]);
  await page.goto(`/games/${b.gameId}`);   // not-found card, not a 404: see the emptied-title test above
  await expect(page.getByTestId('not-found-page')).toBeVisible();
});

test('Swap: the dragged title becomes the set, and its disks come first', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedDisk(orgId, { title: `SwapA ${tag}`, diskNo: 1, sha256: sha(`${tag}-a`) });
  const b = await seedSet(orgId, `SwapB ${tag}`, 2);

  await page.goto('/library?collection=all');
  await dragCardOnto(page, card(page, `SwapB ${tag}`), card(page, `SwapA ${tag}`));
  const dialog = page.getByTestId('set-drop-dialog');
  await expect(dialog.getByTestId('set-drop-name')).toHaveValue(`SwapA ${tag}`);
  await dialog.getByTestId('set-drop-swap').click();
  await expect(dialog.getByTestId('set-drop-order-1')).toContainText(`SwapB ${tag}`);
  await expect(dialog.getByTestId('set-drop-order-2')).toContainText(`SwapA ${tag}`);
  // The untouched name follows the new target.
  await expect(dialog.getByTestId('set-drop-name')).toHaveValue(`SwapB ${tag}`);
  await dialog.getByTestId('set-drop-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  const nos = await diskNos([...b.ids, a.diskId]);
  expect([nos[b.ids[0]], nos[b.ids[1]], nos[a.diskId]]).toEqual([
    { gameId: b.gameId, diskNo: 1 }, { gameId: b.gameId, diskNo: 2 }, { gameId: b.gameId, diskNo: 3 },
  ]);
  expect(await gameExists(a.gameId)).toBe(false);
  await page.goto(`/games/${b.gameId}`);
  expect(await rowOrder(page)).toEqual([...b.ids, a.diskId]);
});

test('Uncategorized: Cancel (and Escape) leave both titles untouched', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedDisk(orgId, { title: `KeepA ${tag}`, diskNo: 1, sha256: sha(`${tag}-a`) });
  const b = await seedDisk(orgId, { title: `KeepB ${tag}`, diskNo: 1, sha256: sha(`${tag}-b`) });

  await page.goto('/library');   // the landing view is Uncategorized
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  await dragCardOnto(page, card(page, `KeepB ${tag}`), card(page, `KeepA ${tag}`));
  await expect(page.getByTestId('set-drop-dialog')).toBeVisible();
  await page.getByTestId('set-drop-cancel').click();
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);

  await dragCardOnto(page, card(page, `KeepA ${tag}`), card(page, `KeepB ${tag}`));
  await expect(page.getByTestId('set-drop-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);

  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  const nos = await diskNos([a.diskId, b.diskId]);
  expect(nos[a.diskId]).toEqual({ gameId: a.gameId, diskNo: 1 });
  expect(nos[b.diskId]).toEqual({ gameId: b.gameId, diskNo: 1 });
  expect((await orgGames(orgId)).map((g) => g.id).sort()).toEqual([a.gameId, b.gameId].sort());
  // After a drag, a plain click on a card still opens it.
  await card(page, `KeepA ${tag}`).click();
  await expect(page).toHaveURL(new RegExp(`/games/${a.gameId}$`));
});

// ---------------------------------------------------------------------------
// Hide the dragged card while the dialog is open (operator approved
// 2026-09-29): dnd-kit's own drop animation would otherwise fly the card back
// to its slot underneath the dialog as it opens.

/** Polls `cardA`'s visibility until `stop()` is called, reporting whether it
 *  was ever visible in between -- started before an action that might close
 *  a dialog, so no window between the action and a later check can hide a
 *  flash that happened in it. */
function watchForFlash(page: Page, cardA: Locator) {
  let sawVisible = false;
  let running = true;
  const done = (async () => {
    while (running) {
      if (await cardA.isVisible().catch(() => false)) sawVisible = true;
      await page.waitForTimeout(20);
    }
  })();
  return { stop: async () => { running = false; await done; return sawVisible; } };
}

test('All titles: the dragged card hides while the dialog is open, fades back on Cancel, and never flashes visible before a successful Add\'s refresh', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedDisk(orgId, { title: `HideA ${tag}`, diskNo: 1, sha256: sha(`${tag}-a`) });
  const b = await seedDisk(orgId, { title: `HideB ${tag}`, diskNo: 1, sha256: sha(`${tag}-b`) });

  await page.goto('/library?collection=all');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  const cardA = card(page, `HideA ${tag}`);
  const cardB = card(page, `HideB ${tag}`);
  const aBoxBefore = (await box(cardA));
  const boxBefore = (await box(cardB));
  const dialog = page.getByTestId('set-drop-dialog');

  await dragCardOnto(page, cardA, cardB);
  await expect(dialog).toBeVisible();
  // A is gone -- not merely faded -- and its slot is still there: B, the
  // card the drop landed ON, has not moved a pixel.
  await expect(cardA).toBeHidden();
  const boxDuring = (await box(cardB));
  expect(boxDuring).toEqual(boxBefore);

  // Cancel fades A back into its own slot; the grid never reflowed, so this
  // is the same slot it started in.
  await page.getByTestId('set-drop-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(cardA).toBeVisible();
  expect(await cardA.boundingBox()).toEqual(aBoxBefore);
  // The fade itself is still running (pointer-events stay off it until it
  // finishes, so a person cannot grab a half-transparent card): outrun it
  // before picking the card up again.
  await page.waitForTimeout(300);

  // Drop again, this time Add: A must stay hidden right up to the refresh
  // that removes it from the grid for good, never flashing visible first.
  await dragCardOnto(page, cardA, cardB);
  await expect(dialog).toBeVisible();
  await expect(cardA).toBeHidden();
  const watcher = watchForFlash(page, cardA);
  await dialog.getByTestId('set-drop-confirm').click();
  await expect(dialog).toHaveCount(0);
  expect(await watcher.stop()).toBe(false);
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  // Really did make the set -- B was the drop's TARGET, so it survives and
  // A's disk lands second in it: this was a real drop, not a mechanism that
  // only looks right from the hidden card's own style.
  expect((await diskNos([a.diskId, b.diskId]))[a.diskId]).toEqual({ gameId: b.gameId, diskNo: 2 });
  expect(await gameExists(a.gameId)).toBe(false);
});

test('a failed Add keeps the dialog open and the dragged card hidden through it; Cancel still fades it back', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const a = await seedDisk(orgId, { title: `FailA ${tag}`, diskNo: 1, sha256: sha(`${tag}-a`) });
  const b = await seedDisk(orgId, { title: `FailB ${tag}`, diskNo: 1, sha256: sha(`${tag}-b`) });

  await page.route('**/api/games/*/disks', (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }),
  }));

  await page.goto('/library?collection=all');
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  const cardA = card(page, `FailA ${tag}`);
  const cardB = card(page, `FailB ${tag}`);
  const aBoxBefore = (await box(cardA));
  const dialog = page.getByTestId('set-drop-dialog');

  await dragCardOnto(page, cardA, cardB);
  await expect(dialog).toBeVisible();
  await expect(cardA).toBeHidden();

  // The POST fails: confirm() (set-drop-dialog.tsx) shows a toast and calls
  // router.refresh(), but -- unlike Cancel -- never calls onClose. The
  // dialog stays open, and A must stay hidden right through that refresh.
  // This is the bug the review found: library/page.tsx hands the provider a
  // brand-new `gameIds` array on every refresh, even one that changed
  // nothing, and the reconciliation in collection-provider.tsx used to read
  // any new array as "the drop is done" and pop A back to full view
  // underneath the still-open dialog.
  await dialog.getByTestId('set-drop-confirm').click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Could not make the disk set' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(cardA).toBeHidden();
  // Give the refresh -- and any leftover reconciliation bug -- every chance
  // to have shown A before saying it did not.
  await page.waitForTimeout(3_000);
  await expect(dialog).toBeVisible();
  await expect(cardA).toBeHidden();

  // Cancel still works, and still fades A back to where it started.
  await page.unroute('**/api/games/*/disks');
  await page.getByTestId('set-drop-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(cardA).toBeVisible();
  expect(await cardA.boundingBox()).toEqual(aBoxBefore);

  // Nothing was actually moved.
  const nos = await diskNos([a.diskId, b.diskId]);
  expect(nos[a.diskId]).toEqual({ gameId: a.gameId, diskNo: 1 });
  expect(nos[b.diskId]).toEqual({ gameId: b.gameId, diskNo: 1 });
  expect((await orgGames(orgId)).map((g) => g.id).sort()).toEqual([a.gameId, b.gameId].sort());
});

test('the rename pencil renames the set; Escape cancels; the library card shows the new name', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const set = await seedSet(orgId, `Rename ${tag}`, 2);

  await page.goto(`/games/${set.gameId}`);
  await expect(page.getByTestId('set-name')).toHaveText(`Rename ${tag}`);

  await page.getByTestId('set-rename').click();
  const input = page.getByTestId('set-rename-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('maxlength', '80');
  await input.fill('Not this');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId('set-name')).toHaveText(`Rename ${tag}`);

  await page.getByTestId('set-rename').click();
  await page.getByTestId('set-rename-input').fill(`Renamed ${tag}`);
  await page.getByTestId('set-rename-input').press('Enter');
  await expect(page.getByTestId('set-name')).toHaveText(`Renamed ${tag}`);
  // The DB first, then the page: the header shows the new name at once, but
  // the h1 waits for router.refresh(), which is slow on a loaded machine.
  await expect.poll(async () => (await orgGames(orgId))[0]?.title).toBe(`Renamed ${tag}`);
  await expect(page.getByRole('heading', { level: 1, name: `Renamed ${tag}` }).first()).toBeVisible({ timeout: 15_000 });
  const [row] = await getDb().select({ metadataSource: games.metadataSource }).from(games).where(eq(games.id, set.gameId));
  expect(row.metadataSource).toBe('human');

  await page.goto('/library?collection=all');
  await expect(card(page, `Renamed ${tag}`)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Folder-style drops inside a collection view (operator, 2026-09-29): like
// making a folder on a phone, the CENTRE of a card adds to a disk set once
// the pointer has rested there for ARM_DELAY_MS (src/lib/set-folder.ts);
// every other drop on a card -- an edge, or a centre let go of before it
// arms -- reorders, and so does a drop in the gap between cards (to the
// nearest card). The operator drags by hand, so every drag here walks in
// small steps with a real frame between each and holds for real.

/** Three single-disk titles in one new collection, in that membership order.
 *  The collection goes with the org in cleanupSeeded. */
async function seedCollectionOfThree(page: Page, orgId: string, prefix: string) {
  const tag = runTag();
  const t = (x: string) => `${prefix}${x} ${tag}`;
  const a = await seedDisk(orgId, { title: t('A'), diskNo: 1, sha256: sha(`${tag}-a`) });
  const b = await seedDisk(orgId, { title: t('B'), diskNo: 1, sha256: sha(`${tag}-b`) });
  const c = await seedDisk(orgId, { title: t('C'), diskNo: 1, sha256: sha(`${tag}-c`) });
  const res = await page.request.post('/api/collections', { data: { name: `Folder ${tag}` } });
  expect(res.status()).toBe(200);
  const collectionId = (await res.json()).id as string;
  for (const g of [a, b, c]) {
    expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId: g.gameId } })).status()).toBe(200);
  }
  return { collectionId, a, b, c, title: t };
}

/** The collection's membership, in stored order. */
async function membershipOf(collectionId: string): Promise<string[]> {
  const rows = await getDb().select({ gameId: collectionGames.gameId, sortKey: collectionGames.sortKey })
    .from(collectionGames).where(eq(collectionGames.collectionId, collectionId))
    .orderBy(collectionGames.sortKey, collectionGames.gameId);
  return rows.map((r) => r.gameId);
}

/** The grid's game ids in rendered order (each card is the <a> to its game). */
async function gridIds(page: Page): Promise<string[]> {
  return page.getByTestId('game-card').evaluateAll((els) =>
    els.map((el) => new URL(el.getAttribute('href') ?? '', 'http://x').pathname.split('/').pop() ?? ''));
}

type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

/** A point `fx`/`fy` of the way across `box` (0.5, 0.5 is its middle). */
const at = (box: Box, fx: number, fy: number): Point => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

/** Whether `p` is in the CENTRE of the slot `box`, by the app's own rule. */
const inCentre = (p: Point, box: Box) =>
  zoneOf(p, { left: box.x, top: box.y, width: box.width, height: box.height }) === 'centre';

/** How far `box` is from `ref`, the larger of the two axes. */
const offBy = (box: Box, ref: Box) => Math.max(Math.abs(box.x - ref.x), Math.abs(box.y - ref.y));

/** A hand's pace: 4px a step, one frame between steps (~250px/s). */
const STEP_PX = 4;
const STEP_MS = 16;

/**
 * Walk the (already pressed) mouse from `from` to `to` in small steps, like a
 * hand, never a jump. `onStep` runs after every step with where it is now.
 */
async function walk(page: Page, from: Point, to: Point, onStep?: (p: Point) => Promise<void>,
  pace: { px: number; ms: number } = { px: STEP_PX, ms: STEP_MS }): Promise<Point> {
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / pace.px));
  for (let i = 1; i <= n; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(pace.ms);
    if (onStep) await onStep(p);
  }
  return to;
}

/**
 * Press the middle of `source` and pick it up: a short walk past the
 * MouseSensor's 8px threshold, staying inside the card's own slot (its own
 * drop area, which is no target, so nothing arms or moves yet).
 */
async function pickUp(page: Page, source: Locator): Promise<Point> {
  const p = at((await box(source)), 0.5, 0.5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  return walk(page, p, { x: p.x + 12, y: p.y + 12 });
}

/**
 * Let go, then wait out dnd-kit's 50 ms click swallow (see dragCardOnto) so a
 * click on the dialog that follows is a person's, not one it eats.
 */
async function letGo(page: Page) {
  await page.mouse.up();
  await page.waitForTimeout(100);
}

/**
 * Walk `source` slowly into the middle of `target`'s centre and hold there
 * for 600 ms, measuring the target all the way. Returns the measurements;
 * the caller asserts. `slot` is the target's box before anything was picked
 * up -- the place it must still be while the pointer is in its centre.
 *
 * `pauseInEdgeAt`: first walk to that point of the target (an edge) and rest
 * there long enough for the reorder preview, then walk on into the middle.
 * `pausedOff` is how far the target had been moved aside by then.
 *
 * `creep`: walk at a hand's pace only to just outside the target's left side,
 * then cross its whole edge ring into the middle at 1 px every 30 ms.
 */
async function walkIntoCentreAndHold(page: Page, source: Locator, target: Locator,
  opts: { pauseInEdgeAt?: [number, number]; creep?: boolean } = {}) {
  const slot = (await box(target));
  let from = await pickUp(page, source);
  let pausedOff: number | null = null;
  if (opts.pauseInEdgeAt) {
    from = await walk(page, from, at(slot, ...opts.pauseInEdgeAt));
    await page.waitForTimeout(EDGE_REST_MS + 400);   // the rest, then the preview's 200 ms glide
    pausedOff = offBy((await target.boundingBox())!, slot);
  }
  if (opts.creep) from = await walk(page, from, { x: slot.x - 6, y: slot.y + slot.height / 2 });
  // Every step, and where the target card was drawn after it.
  const approach: Array<{ p: Point; centre: boolean; off: number }> = [];
  await walk(page, from, at(slot, 0.5, 0.5), async (p) => {
    approach.push({ p, centre: inCentre(p, slot), off: offBy((await target.boundingBox())!, slot) });
  }, opts.creep ? { px: 1, ms: 30 } : undefined);
  // The hold: sampled every 50 ms for 600 ms, the pointer perfectly still.
  const hold: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 600) {
    hold.push(offBy((await target.boundingBox())!, slot));
    await page.waitForTimeout(50);
  }
  return { slot, approach, hold, pausedOff };
}

/** One line of the measurements, for the run log: e/C = edge/centre step, then px off the slot. */
function logWalk(label: string, m: Awaited<ReturnType<typeof walkIntoCentreAndHold>>) {
  console.log(`[folder ${label}] ${m.pausedOff === null ? '' : `after the edge rest: ${Math.round(m.pausedOff)}px aside; `}` +
    `walk: ${m.approach.map((x) => `${x.centre ? 'C' : 'e'}${Math.round(x.off)}`).join(' ')}; ` +
    `hold: ${m.hold.map((o) => o.toFixed(1)).join(' ')}`);
}

/** The proof: from the first step inside the centre to the end of the hold, the target is in its own slot, within 2px, at every measurement. */
function expectStillInCentre(m: Awaited<ReturnType<typeof walkIntoCentreAndHold>>) {
  const inside = m.approach.filter((x) => x.centre);
  expect(inside.length, 'the walk reached the centre').toBeGreaterThan(5);
  expect(Math.max(...inside.map((x) => x.off)), 'the target moved while the pointer was in its centre (walk)').toBeLessThanOrEqual(2);
  expect(Math.max(...m.hold), 'the target moved while the pointer was in its centre (hold)').toBeLessThanOrEqual(2);
}

test('in a collection: a slow walk into a card\'s centre leaves it where it is; after the hold it offers the set, and Add makes it', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Folder');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  expect(await gridIds(page)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  const target = card(page, s.title('B'));
  const m = await walkIntoCentreAndHold(page, card(page, s.title('A')), target);
  logWalk('A into B', m);
  expectStillInCentre(m);
  // Walked straight through B's edge without resting: B never moved at all.
  expect(Math.max(...m.approach.map((x) => x.off)), 'B moved while the pointer crossed its edge').toBeLessThanOrEqual(2);
  await expect(target.getByTestId('set-drop-target')).toBeVisible();
  await expect(target.getByTestId('set-drop-target')).toHaveText('Add to disk set');
  await expect(page.getByTestId('set-drop-target')).toHaveCount(1);
  await letGo(page);

  const dialog = page.getByTestId('set-drop-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('set-drop-order-1')).toContainText(s.title('B'));
  await expect(dialog.getByTestId('set-drop-order-2')).toContainText(s.title('A'));
  await expect(page).toHaveURL(new RegExp(`/library\\?collection=${s.collectionId}$`));
  // Nothing moved on the drop itself.
  expect(await membershipOf(s.collectionId)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);

  await dialog.getByTestId('set-drop-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('game-card')).toHaveCount(2);
  await expect(card(page, s.title('B'))).toBeVisible();

  const nos = await diskNos([s.b.diskId, s.a.diskId]);
  expect(nos[s.b.diskId]).toEqual({ gameId: s.b.gameId, diskNo: 1 });
  expect(nos[s.a.diskId]).toEqual({ gameId: s.b.gameId, diskNo: 2 });
  expect(await gameExists(s.a.gameId)).toBe(false);
  expect(await membershipOf(s.collectionId)).toEqual([s.b.gameId, s.c.gameId]);
});

test('in a collection: the dragged card hides while the dialog is open, fades back on Cancel, and never flashes visible before a successful Add\'s refresh', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Hide');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  const cardA = card(page, s.title('A'));
  const cardB = card(page, s.title('B'));
  const aBoxBefore = (await box(cardA));
  const boxBefore = (await box(cardB));
  const dialog = page.getByTestId('set-drop-dialog');

  const m = await walkIntoCentreAndHold(page, cardA, cardB);
  expectStillInCentre(m);
  await expect(cardB.getByTestId('set-drop-target')).toBeVisible();
  await letGo(page);

  await expect(dialog).toBeVisible();
  // A is gone -- not merely faded -- and its slot is still there: B, the
  // card the drop landed ON, has not moved a pixel (no reflow of the grid).
  await expect(cardA).toBeHidden();
  const boxDuring = (await box(cardB));
  expect(offBy(boxDuring, boxBefore)).toBeLessThanOrEqual(1);

  // Cancel fades A back into its own slot -- the membership order is
  // untouched, so this really is the slot it started in.
  await page.getByTestId('set-drop-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(cardA).toBeVisible();
  expect(await gridIds(page)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  expect(offBy((await box(cardA)), aBoxBefore)).toBeLessThanOrEqual(1);
  // The fade itself is still running (pointer-events stay off it until it
  // finishes, so a person cannot grab a half-transparent card): outrun it
  // before picking the card up again.
  await page.waitForTimeout(300);

  // Drop again, this time Add: A must stay hidden right up to the refresh
  // that removes it from the grid for good, never flashing visible first.
  const m2 = await walkIntoCentreAndHold(page, cardA, cardB);
  expectStillInCentre(m2);
  await letGo(page);
  await expect(dialog).toBeVisible();
  await expect(cardA).toBeHidden();
  const watcher = watchForFlash(page, cardA);
  await dialog.getByTestId('set-drop-confirm').click();
  await expect(dialog).toHaveCount(0);
  expect(await watcher.stop()).toBe(false);
  await expect(page.getByTestId('game-card')).toHaveCount(2);
});

test('in a collection: a card dropped on another card\'s left or right edge reorders, with no hint and no dialog', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Edge');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);

  // A onto B's LEFT edge, held longer than ARM_DELAY_MS: an edge never arms.
  let slot = (await box(card(page, s.title('B'))));
  let p = await pickUp(page, card(page, s.title('A')));
  await walk(page, p, at(slot, 0.1, 0.5));
  await page.waitForTimeout(ARM_DELAY_MS + 300);
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  // Rested in the edge, so the reorder preview shows: B has moved aside.
  expect(offBy((await box(card(page, s.title('B')))), slot)).toBeGreaterThan(50);
  await letGo(page);
  await expect.poll(() => membershipOf(s.collectionId)).toEqual([s.b.gameId, s.a.gameId, s.c.gameId]);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  await expect.poll(() => gridIds(page)).toEqual([s.b.gameId, s.a.gameId, s.c.gameId]);

  // A (now second) back onto B's RIGHT edge (B is now first).
  await page.waitForTimeout(400);   // the drop's settle animation
  slot = (await box(card(page, s.title('B'))));
  p = await pickUp(page, card(page, s.title('A')));
  await walk(page, p, at(slot, 0.9, 0.5));
  await page.waitForTimeout(ARM_DELAY_MS + 300);
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  expect(offBy((await box(card(page, s.title('B')))), slot)).toBeGreaterThan(50);
  await letGo(page);
  await expect.poll(() => membershipOf(s.collectionId)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  await expect.poll(() => gridIds(page)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  expect((await orgGames(orgId)).length).toBe(3);
});

test('in a collection: Cancel after a centre drop leaves both titles and the order untouched', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Undo');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  const m = await walkIntoCentreAndHold(page, card(page, s.title('B')), card(page, s.title('A')));
  logWalk('B into A', m);
  expectStillInCentre(m);
  await expect(card(page, s.title('A')).getByTestId('set-drop-target')).toBeVisible();
  await letGo(page);
  await expect(page.getByTestId('set-drop-dialog')).toBeVisible();
  await page.getByTestId('set-drop-cancel').click();
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);

  await expect(page.getByTestId('game-card')).toHaveCount(3);
  expect(await gridIds(page)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  expect(await membershipOf(s.collectionId)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  const nos = await diskNos([s.a.diskId, s.b.diskId, s.c.diskId]);
  expect(nos[s.a.diskId]).toEqual({ gameId: s.a.gameId, diskNo: 1 });
  expect(nos[s.b.diskId]).toEqual({ gameId: s.b.gameId, diskNo: 1 });
  expect((await orgGames(orgId)).length).toBe(3);
  // After a drag, a plain click on a card still opens it.
  await card(page, s.title('C')).click();
  await expect(page).toHaveURL(new RegExp(`/games/${s.c.gameId}\\?`));
});

test('in a collection: a crawl through the edge ring (1 px every 30 ms) into the centre never moves the card', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Crawl');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  const target = card(page, s.title('B'));
  const m = await walkIntoCentreAndHold(page, card(page, s.title('A')), target, { creep: true });
  logWalk('A crawls into B', m);
  expect(m.approach.filter((x) => !x.centre).length, 'the crawl crossed the edge ring').toBeGreaterThan(40);
  expect(Math.max(...m.approach.map((x) => x.off)), 'B moved during the crawl').toBeLessThanOrEqual(2);
  expectStillInCentre(m);
  await expect(target.getByTestId('set-drop-target')).toBeVisible();
  await letGo(page);
  await expect(page.getByTestId('set-drop-dialog')).toBeVisible();
  await page.getByTestId('set-drop-cancel').click();
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  expect(await membershipOf(s.collectionId)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
});

test('in a collection: after a rest in an edge shows the gap, a drop in the gap\'s middle reorders -- no hint, no dialog', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Gap');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  // A rests in B's left edge: B slides aside and its slot is the gap. Then
  // the pointer walks to the gap's middle -- B's centre zone -- and holds.
  const m = await walkIntoCentreAndHold(page, card(page, s.title('A')), card(page, s.title('B')), { pauseInEdgeAt: [0.1, 0.5] });
  logWalk('A into the gap B left', m);
  expect(m.pausedOff, 'the edge rest showed the reorder preview').toBeGreaterThan(50);
  // B stays aside the whole time: the gap does not close under the pointer.
  expect(Math.min(...m.approach.map((x) => x.off), ...m.hold), 'B came back into its slot').toBeGreaterThan(50);
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  await letGo(page);
  await expect.poll(() => membershipOf(s.collectionId)).toEqual([s.b.gameId, s.a.gameId, s.c.gameId]);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  await expect.poll(() => gridIds(page)).toEqual([s.b.gameId, s.a.gameId, s.c.gameId]);
  expect((await orgGames(orgId)).length).toBe(3);
});

/** Records every collection-order write the page makes, to prove one did (or did not) happen. */
function watchOrderWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/order$/.test(r.url())) writes.push(r.url()); });
  return writes;
}

test('in a collection: a quick drop on a card\'s centre -- let go before it arms -- reorders: no hint, no dialog', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Quick');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  expect(await gridIds(page)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  const writes = watchOrderWrites(page);

  // A walks at a hand's pace, straight across B, to just inside C's centre
  // (C is two slots away), and lets go at once -- the operator's "drag it
  // onto the card and let go".
  const slot = (await box(card(page, s.title('C'))));
  const start = await pickUp(page, card(page, s.title('A')));
  let entered = 0;
  await walk(page, start, at(slot, 0.3, 0.5), async (p) => {
    if (!entered && inCentre(p, slot)) entered = Date.now();
  });
  // Nothing offers a set at the moment of release.
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  await page.mouse.up();
  const inCentreMs = Date.now() - entered;
  expect(entered, 'the walk ended inside C\'s centre').toBeGreaterThan(0);
  expect(inCentreMs, `the pointer spent ${inCentreMs}ms in C's centre; it must be under ARM_DELAY_MS`)
    .toBeLessThan(ARM_DELAY_MS);

  // A takes C's position.
  const expected = [s.b.gameId, s.c.gameId, s.a.gameId];
  await expect.poll(() => membershipOf(s.collectionId)).toEqual(expected);
  await expect.poll(() => gridIds(page)).toEqual(expected);
  expect(writes).toHaveLength(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  expect((await orgGames(orgId)).length).toBe(3);
  await expect(page).toHaveURL(new RegExp(`/library\\?collection=${s.collectionId}$`));
});

test('in a collection: a hand-paced drag to a card\'s MIDDLE, a short settle and a drop reorders -- nothing arms on the way or there', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Middle');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  const writes = watchOrderWrites(page);

  // A walks straight across B's centre to the very middle of C, checking at
  // every step that no card offers a set: moving through a centre is not a
  // rest, so it never arms -- neither B on the way nor C on arrival.
  const slot = (await box(card(page, s.title('C'))));
  const start = await pickUp(page, card(page, s.title('A')));
  let hintSteps = 0;
  await walk(page, start, at(slot, 0.5, 0.5), async () => {
    if (await page.getByTestId('set-drop-target').count() > 0) hintSteps++;
  });
  expect(hintSteps, 'steps on which a card offered "Add to disk set"').toBe(0);
  // The settle a hand makes before letting go: shorter than ARM_DELAY_MS.
  await page.waitForTimeout(150);
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  await page.mouse.up();

  const expected = [s.b.gameId, s.c.gameId, s.a.gameId];
  await expect.poll(() => membershipOf(s.collectionId)).toEqual(expected);
  await expect.poll(() => gridIds(page)).toEqual(expected);
  expect(writes).toHaveLength(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  expect((await orgGames(orgId)).length).toBe(3);
});

test('in a collection: a drop in an empty cell after the last card moves the card to the END', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const title = (x: string) => `Tail${x} ${tag}`;
  const ids: string[] = [];
  for (const x of letters) ids.push((await seedDisk(orgId, { title: title(x), diskNo: 1, sha256: sha(`${tag}-${x}`) })).gameId);
  const res = await page.request.post('/api/collections', { data: { name: `Tail ${tag}` } });
  expect(res.status()).toBe(200);
  const collectionId = (await res.json()).id as string;
  for (const id of ids) {
    expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId: id } })).status()).toBe(200);
  }

  await page.goto(`/library?collection=${collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(7);
  expect(await gridIds(page)).toEqual(ids);
  const writes = watchOrderWrites(page);

  // Bring the grid up the page first. With 4:5 cards the second row starts below the fold at 1280x720, and a
  // pointer parked in its lower half sits inside dnd-kit's auto-scroll zone (the bottom 20% of the viewport): the
  // page scrolls under the held card, the row slides up, and the pointer ends BELOW the grid -- where a drop rightly
  // does nothing. 60 px of top margin keeps the whole walk (card A's centre to the empty cell) clear of both zones.
  await card(page, title('A')).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 60));

  // Five across at 1280: F and G make a partial second row. The empty cell
  // after G is in G's row, two columns right of it, under D.
  const d = (await box(card(page, title('D'))));
  const g = (await box(card(page, title('G'))));
  expect(g.y - d.y, 'G is on a second row').toBeGreaterThan(d.height / 2);
  const cell = { x: d.x + d.width / 2, y: g.y + g.height / 2 };
  expect(cell.y, 'the empty cell is on screen').toBeLessThan(page.viewportSize()!.height);
  expect(await page.getByTestId('game-card').evaluateAll((els, p) => els.some((el) => {
    const r = el.getBoundingClientRect();
    return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  }), cell), 'the cell is empty').toBe(false);

  const start = await pickUp(page, card(page, title('A')));
  await walk(page, start, cell);
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  await page.mouse.up();

  const expected = [...ids.slice(1), ids[0]];
  await expect.poll(() => membershipOf(collectionId)).toEqual(expected);
  await expect.poll(() => gridIds(page)).toEqual(expected);
  expect(writes).toHaveLength(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  expect((await orgGames(orgId)).length).toBe(7);
});

test('in a collection: a drop in the gap between two cards reorders to the nearest card -- no dialog', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Gutter');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  const writes = watchOrderWrites(page);

  // The gutter between B and C, 3 px left of C: in neither card, and nearer
  // C's middle than B's.
  const b = (await box(card(page, s.title('B'))));
  const c = (await box(card(page, s.title('C'))));
  expect(c.x - (b.x + b.width), 'there is a gutter between B and C').toBeGreaterThan(8);
  const gap = { x: c.x - 3, y: c.y + c.height / 2 };
  const within = (p: Point, box: Box) => p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
  expect(within(gap, b) || within(gap, c), 'the drop point is in the gutter, not on a card').toBe(false);

  const start = await pickUp(page, card(page, s.title('A')));
  await walk(page, start, gap);
  await expect(page.getByTestId('set-drop-target')).toHaveCount(0);
  await page.mouse.up();

  const expected = [s.b.gameId, s.c.gameId, s.a.gameId];
  await expect.poll(() => membershipOf(s.collectionId)).toEqual(expected);
  await expect.poll(() => gridIds(page)).toEqual(expected);
  expect(writes).toHaveLength(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  expect((await orgGames(orgId)).length).toBe(3);
});

test('in a collection: a drop outside the grid changes nothing', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const s = await seedCollectionOfThree(page, orgId, 'Outside');

  await page.goto(`/library?collection=${s.collectionId}`);
  await expect(page.getByTestId('game-card')).toHaveCount(3);
  const writes = watchOrderWrites(page);

  // Below the row of cards, under B: no card, no gutter between cards, no rail row.
  const b = (await box(card(page, s.title('B'))));
  const below = { x: b.x + b.width / 2, y: b.y + b.height + 60 };
  expect(below.y, 'the drop point is on screen').toBeLessThan(page.viewportSize()!.height);
  const start = await pickUp(page, card(page, s.title('A')));
  await walk(page, start, below);
  await page.mouse.up();

  // Give a reorder or a dialog every chance to happen before saying it did not.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('set-drop-dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await gridIds(page)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  expect(await membershipOf(s.collectionId)).toEqual([s.a.gameId, s.b.gameId, s.c.gameId]);
  expect((await orgGames(orgId)).length).toBe(3);
  await expect(page).toHaveURL(new RegExp(`/library\\?collection=${s.collectionId}$`));
});
