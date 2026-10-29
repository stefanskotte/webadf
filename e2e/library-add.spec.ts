import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';

/**
 * The Library page adds disks itself (Files increment 3, Task 5; R8/R9): a drop anywhere on the page (folders and
 * .zip/.lha too), Add disks ▾ (Browse files…, Paste a URL…), and the tray at the bottom that says what each did.
 * Uploads go through the real ingest flow; cleanupSeeded purges every org signUpFresh made in this file.
 */
test.afterAll(cleanupSeeded);

const ADF_BYTES = 901_120;
const TARGET = '[data-testid="library-drop-target"]';

/** A unique 880 KB image: blobs are content-addressed and global, so a fixed content would dedupe against an old run. */
function fakeAdf(seed: string): Buffer {
  const b = Buffer.alloc(ADF_BYTES);
  b.write(`DOS\0webadf-library-add-${seed}`, 0);
  return b;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = (b: Buffer) => [...b];

/** A deflated zip of `members` (the shape src/lib/archive/index.test.ts builds). */
function zipOf(members: { name: string; bytes: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const cens: Buffer[] = [];
  let off = 0;
  for (const m of members) {
    const data = deflateRawSync(m.bytes);
    const nm = Buffer.from(m.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(m.bytes.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(m.bytes.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data);
    cens.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const tray = (page: Page) => page.getByTestId('library-tray');
const summary = (page: Page) => page.getByTestId('library-tray-summary');
const rowOf = (page: Page, key: string) => page.locator(`[data-testid="library-tray-row"][data-key="${key}"]`);
const card = (page: Page, title: string) => page.getByTestId('game-card').filter({ hasText: title });

test('two dropped ADFs are added, the tray says so, and the grid shows them', async ({ page }) => {
  const tag = runTag();
  await signUpFresh(page);
  await page.goto('/library');
  const a = fakeAdf(`a-${tag}`);
  const b = fakeAdf(`b-${tag}`);
  await synthDrop(page, [
    { name: `LibAdd Alpha ${tag} (1990)(X).adf`, kind: 'file', bytes: bytes(a) },
    { name: `LibAdd Beta ${tag} (1991)(X).adf`, kind: 'file', bytes: bytes(b) },
  ], TARGET);

  await expect(summary(page)).toHaveText('2 added', { timeout: 30_000 });
  await expect(rowOf(page, `lib:${sha(a)}`)).toHaveAttribute('data-state', 'done');
  await expect(rowOf(page, `lib:${sha(b)}`)).toContainText('Added');
  // A DD disk carries no HD tag (hd-disks.spec.ts checks an HD one has it).
  await expect(page.getByTestId('library-tray-hd')).toHaveCount(0);
  await expect(card(page, `LibAdd Alpha ${tag}`)).toHaveCount(1);
  await expect(card(page, `LibAdd Beta ${tag}`)).toHaveCount(1);
  // The overlay was a drag's, and is gone with the drop.
  await expect(page.getByTestId('library-drop-overlay')).toHaveCount(0);

  // Open title leads to the new title; Close empties the tray.
  await page.getByTestId(`library-tray-open-${sha(a)}`).click();
  await expect(page).toHaveURL(/\/games\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`LibAdd Alpha ${tag}`);
  await page.goBack();
  await expect(page.getByTestId('library-add-disks')).toBeVisible();
});

test('a file dragged over the page lights it up, counting the disks; a drag that leaves puts it out', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-native-drop') === 'ready', TARGET);
  const fire = (type: string, n: number) => page.evaluate(({ type, n }) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const items = Array.from({ length: n }, () => ({ kind: 'file' }));
    (e as unknown as { dataTransfer: unknown }).dataTransfer = { types: ['Files'], items, dropEffect: 'none' };
    document.querySelector('main, body')!.dispatchEvent(e);
  }, { type, n });

  await fire('dragenter', 3);
  await expect(page.getByTestId('library-drop-overlay')).toContainText('Drop to add 3 disks to the library');
  await expect(page.getByTestId('library-drop-overlay')).toContainText('ADF · DSK · ADZ · DMS · DMZ · HFE, folders, .zip / .lha of disks');
  await fire('dragleave', 3);
  await expect(page.getByTestId('library-drop-overlay')).toHaveCount(0);
});

test('a dropped folder adds its ADF and names each .txt it refused', async ({ page }) => {
  const tag = runTag();
  await signUpFresh(page);
  await page.goto('/library');
  const a = fakeAdf(`folder-${tag}`);
  await synthDrop(page, [{
    name: 'Set', kind: 'dir', children: [
      { name: `LibAdd Folder ${tag} (1990)(X).adf`, kind: 'file', bytes: bytes(a) },
      { name: 'readme.txt', kind: 'file', content: 'hello' },
      { name: 'Docs', kind: 'dir', children: [{ name: 'readme.txt', kind: 'file', content: 'other' }] },
    ],
  }], TARGET);

  await expect(summary(page)).toHaveText('1 added · 2 refused', { timeout: 30_000 });
  await expect(rowOf(page, `lib:${sha(a)}`)).toHaveAttribute('data-state', 'done');
  // Two readme.txt from two folders are two refusals, not one row.
  const refused = page.locator('[data-testid="library-tray-row"][data-state="failed"]');
  await expect(refused).toHaveCount(2);
  await expect(refused.first()).toContainText('readme.txt');
  await expect(refused.first()).toContainText('Refused — not a disk image');
  await expect(card(page, `LibAdd Folder ${tag}`)).toHaveCount(1);

  await page.getByTestId('library-tray-close').click();
  await expect(tray(page)).toHaveCount(0);
});

test('a dropped .zip holding an ADF adds the ADF and notes what else it held', async ({ page }) => {
  const tag = runTag();
  await signUpFresh(page);
  await page.goto('/library');
  const a = fakeAdf(`zip-${tag}`);
  const zip = zipOf([
    { name: `Game/LibAdd Zipped ${tag} (1990)(X).adf`, bytes: a },
    { name: 'Game/info.txt', bytes: Buffer.from('info') },
  ]);
  await synthDrop(page, [{ name: 'game.zip', kind: 'file', bytes: bytes(zip) }], TARGET);

  await expect(summary(page)).toHaveText('1 added', { timeout: 30_000 });
  await expect(rowOf(page, `lib:${sha(a)}`)).toContainText(`LibAdd Zipped ${tag} (1990)(X).adf`);
  await expect(page.getByTestId('library-tray-note')).toHaveText('game.zip: 1 other file inside, not disk images, left out');
  await expect(card(page, `LibAdd Zipped ${tag}`)).toHaveCount(1);
});

test('an .lha dropped anywhere on the page adds the disks inside it, the overlay up while it is dragged', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-native-drop') === 'ready', TARGET);
  // The drag over the page first: the overlay comes up, and goes with the drop.
  await page.evaluate(() => {
    const e = new Event('dragenter', { bubbles: true, cancelable: true });
    (e as unknown as { dataTransfer: unknown }).dataTransfer = { types: ['Files'], items: [{ kind: 'file' }], dropEffect: 'none' };
    document.body.dispatchEvent(e);
  });
  await expect(page.getByTestId('library-drop-overlay')).toBeVisible();
  // Two fixed disks (the archive module's fixture): new to this org, though their blobs may be held from another run.
  const lha = readFileSync('src/lib/archive/fixtures/disks.lha');
  await synthDrop(page, [{ name: 'disks.lha', kind: 'file', bytes: bytes(lha) }], 'body');
  await expect(summary(page)).toHaveText('2 added', { timeout: 30_000 });
  await expect(page.getByTestId('library-tray-row')).toHaveText([/Disk1\.adf\s*Added/, /Disk2\.adf\s*Added/]);
  await expect(page.getByTestId('library-drop-overlay')).toHaveCount(0);
});

test('an ADF the library already had reads Added, newest drop first', async ({ page }) => {
  const tag = runTag();
  await signUpFresh(page);
  await page.goto('/library');
  const a = fakeAdf(`dup-${tag}`);
  const b = fakeAdf(`new-${tag}`);
  await synthDrop(page, [{ name: `LibAdd Dup ${tag} (1990)(X).adf`, kind: 'file', bytes: bytes(a) }], TARGET);
  await expect(summary(page)).toHaveText('1 added', { timeout: 30_000 });

  await synthDrop(page, [
    { name: `LibAdd New ${tag} (1990)(X).adf`, kind: 'file', bytes: bytes(b) },
    { name: `LibAdd Dup ${tag} (1990)(X).adf`, kind: 'file', bytes: bytes(a) },
  ], TARGET);
  await expect(summary(page)).toHaveText('2 added', { timeout: 30_000 });
  await expect(rowOf(page, `lib:${sha(a)}`)).toContainText('Added');
  await expect(rowOf(page, `lib:${sha(a)}`)).toHaveAttribute('data-state', 'deduped');
  // The second drop's rows lead, in the order they were dropped.
  await expect(page.getByTestId('library-tray-row')).toHaveCount(2);
  await expect(page.getByTestId('library-tray-row').first()).toHaveAttribute('data-key', `lib:${sha(b)}`);
});

test('one drop at a time: until a drop has its set suggestion, Add disks waits and a second drop is refused in words', async ({ page }) => {
  const tag = runTag();
  await signUpFresh(page);
  // Hold the first drop at its set suggestion: its disks are up, but the drop is not finished until that is answered,
  // and a drop let in meanwhile would share the one suggestion (increment 3 final ruling).
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/disk-sets/suggest', async (route) => {
    await held;
    await route.fulfill({ json: { suggestion: null } });
  });
  await page.goto('/library');
  const a = fakeAdf(`one-${tag}`);
  const b = fakeAdf(`two-${tag}`);
  const c = fakeAdf(`three-${tag}`);
  await synthDrop(page, [
    { name: `LibAdd One ${tag} (1990)(X).adf`, kind: 'file', bytes: bytes(a) },
    { name: `LibAdd Two ${tag} (1990)(X).adf`, kind: 'file', bytes: bytes(b) },
  ], TARGET);
  await expect(summary(page)).toHaveText('2 added', { timeout: 30_000 });

  // Still adding: the menu says so and takes nothing; Close waits too.
  await expect(page.getByTestId('library-add-disks')).toContainText('Adding…');
  await expect(page.getByTestId('library-tray-close')).toBeDisabled();
  await page.getByTestId('library-add-disks').click();
  await expect(page.getByTestId('library-add-hint')).toHaveText('Adding disks — wait for them, then add more');
  await expect(page.getByTestId('library-add-browse')).toHaveAttribute('data-disabled', '');
  await expect(page.getByTestId('library-add-url')).toHaveAttribute('data-disabled', '');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('library-add-disks-panel')).toHaveCount(0);

  // A second drop now is refused in words and adds nothing.
  const third = { name: `LibAdd Three ${tag} (1990)(X).adf`, kind: 'file' as const, bytes: bytes(c) };
  await synthDrop(page, [third], TARGET);
  await expect(page.getByText('Wait for the disks being added, then drop again.')).toBeVisible();
  await expect(page.getByTestId('library-tray-row')).toHaveCount(2);

  // Once the first drop is answered, the next one is taken.
  release();
  await expect(page.getByTestId('library-add-disks')).not.toContainText('Adding…');
  await synthDrop(page, [third], TARGET);
  await expect(rowOf(page, `lib:${sha(c)}`)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(page.getByTestId('library-tray-row')).toHaveCount(3);
});

test('Add disks ▾ → Browse files… adds the picked disk; the menu says the page takes a drop', async ({ page }) => {
  const tag = runTag();
  await signUpFresh(page);
  await page.goto('/library');
  const a = fakeAdf(`browse-${tag}`);

  await page.getByTestId('library-add-disks').click();
  await expect(page.getByTestId('library-add-hint')).toHaveText('or drop disks anywhere on this page');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('library-add-browse').click();
  await (await chooser).setFiles({ name: `LibAdd Browsed ${tag} (1990)(X).adf`, mimeType: 'application/octet-stream', buffer: a });

  await expect(summary(page)).toHaveText('1 added', { timeout: 30_000 });
  await expect(card(page, `LibAdd Browsed ${tag}`)).toHaveCount(1);
});

test('Paste a URL… refuses a private address in words; /library#add-disks opens the menu', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library#add-disks');
  await expect(page.getByTestId('library-add-disks-panel')).toBeVisible();
  await page.getByTestId('library-add-url').click();

  const dialog = page.getByTestId('library-add-url-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('url-input').fill('http://127.0.0.1/disk.adf');
  await dialog.getByTestId('url-fetch').click();
  await expect(dialog.getByTestId('url-status')).toHaveText('That address points to a private or local network, which is not fetched.');
  // Nothing was added, so there is no tray.
  await expect(tray(page)).toHaveCount(0);
  await dialog.getByTestId('library-add-url-done').click();
  await expect(dialog).toHaveCount(0);
});

/** dnd-kit's MouseSensor needs real, stepped pointer movement past its 8 px threshold (as e2e/collections.spec.ts). */
async function dragOnto(page: Page, source: Locator, target: Locator, whileOver: () => Promise<void>) {
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const sx = from.x + from.width / 2, sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2, ty = to.y + to.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 14, sy + 14, { steps: 6 });
  await page.mouse.move(tx, ty, { steps: 15 });
  await page.mouse.move(tx, ty, { steps: 2 });
  await whileOver();
  await page.mouse.up();
}

test('dragging a title onto a collection still works, with no drop overlay', async ({ page }) => {
  const tag = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `LibAdd Drag ${tag}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'd') });
  const res = await page.request.post('/api/collections', { data: { name: `Target ${tag}` } });
  expect(res.status()).toBe(200);
  const { id } = await res.json() as { id: string };

  await page.goto('/library');
  const row = page.locator(`[data-testid="collection-row"][data-collection-id="${id}"]`);
  await dragOnto(page, card(page, `LibAdd Drag ${tag}`), row, async () => {
    await expect(row).toHaveAttribute('data-drop-target', 'true');
    await expect(page.getByTestId('library-drop-overlay')).toHaveCount(0);
  });
  // Filed: it leaves the Uncategorized landing.
  await expect(card(page, `LibAdd Drag ${tag}`)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('library-drop-overlay')).toHaveCount(0);
});
