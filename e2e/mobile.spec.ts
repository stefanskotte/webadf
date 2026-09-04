import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { readVolume } from '@/lib/adffs';
import { signUpFresh, runTag, createAdf } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

/**
 * The only specs in this repo that run at a phone's width.
 *
 * Everything else runs at Playwright's default 1280x720 -- no viewport was
 * ever configured -- so until this file existed the responsive rules had no
 * test that could fail. playwright.config.ts pins this project to 390x844
 * with hasTouch, and matches ONLY this file.
 *
 * These tests assert the things that were actually broken, not that classes
 * are present: a class list proves nothing about whether a control ended up
 * on screen.
 */

test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(`mobile-${s}`).digest('hex');

/**
 * A real finger, via CDP.
 *
 * Playwright's touchscreen API only taps, and dnd-kit's TouchSensor listens
 * for touchstart/touchmove -- which page.mouse never emits, and which a
 * dispatched synthetic event would not carry properly either. CDP is what
 * produces genuine touch input, and genuine input is the whole point: with
 * mouse events these two tests would exercise the MouseSensor and prove
 * nothing about a phone.
 */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  dy: number,
  opts: { holdMs: number },
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  });
  if (opts.holdMs > 0) await page.waitForTimeout(opts.holdMs);
  // Several moves, not one: an activation constraint has to SEE movement
  // accumulate, the same reason collections.spec.ts steps its mouse drag.
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x, y: from.y + dy * step }],
    });
    await page.waitForTimeout(30);
  }
  return {
    end: async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    },
  };
}

async function seedLibrary(page: Page, count: number) {
  const u = await signUpFresh(page);
  const run = runTag();
  for (let i = 0; i < count; i++) {
    await seedDisk(u.orgId, { title: `Mobile ${run} ${String(i).padStart(2, '0')}`, diskNo: 1, sha256: sha(`${run}-${i}`) });
  }
  return { u, run };
}

test('the bottom bar reaches every route, and there is only one nav', async ({ page }) => {
  await seedLibrary(page, 2);
  await page.goto('/library');

  // One nav element, not a desktop copy plus a mobile copy -- a duplicate
  // would make getByRole('link') ambiguous here AND in the 1280 specs.
  await expect(page.locator('nav')).toHaveCount(1);

  const bar = page.locator('nav');
  const box = (await bar.boundingBox())!;
  // Actually at the bottom of the 844px viewport, not merely styled for it.
  expect(box.y + box.height).toBeGreaterThan(760);

  await page.getByRole('link', { name: 'Devices' }).tap();
  await expect(page).toHaveURL(/\/devices$/);
  await page.getByRole('link', { name: 'Upload' }).tap();
  await expect(page).toHaveURL(/\/ingest$/);
  await page.getByRole('link', { name: 'Library' }).tap();
  await expect(page).toHaveURL(/\/library/);
});

test('the library grid is two columns, and nothing overflows the viewport', async ({ page }) => {
  await seedLibrary(page, 4);
  await page.goto('/library');

  const cards = page.getByTestId('game-card');
  await expect(cards).toHaveCount(4);
  const a = (await cards.nth(0).boundingBox())!;
  const b = (await cards.nth(1).boundingBox())!;
  const c = (await cards.nth(2).boundingBox())!;
  // Two across: 1 and 2 share a row, 3 starts the next one.
  expect(Math.abs(a.y - b.y)).toBeLessThan(4);
  expect(c.y).toBeGreaterThan(a.y + a.height / 2);

  // The whole document, not just the grid: a single overflowing element
  // makes the entire page pan sideways, which is the symptom people notice.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a file tree row shows its name AND its download control', async ({ page }) => {
  const u = await signUpFresh(page);
  const tag = randomUUID().slice(0, 8);
  const adf = syntheticVolume({
    filesystem: 'FFS',
    volumeName: `Mob-${tag}`,
    entries: [{ name: 'C', entries: [{ name: 'SetPatch', bytes: new TextEncoder().encode('x') }] },
              { name: 'README', bytes: new TextEncoder().encode('yy') }],
  });
  const content = Buffer.from(adf);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', { data: { files: [{ sha256, sizeBytes: content.length }] } });
  const { uploads } = await presign.json();
  await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  await page.request.post('/api/ingest/complete', { data: { files: [{ sha256, sizeBytes: content.length, filename: `m-${tag}.adf` }] } });
  const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];
  void u;

  await page.goto(`/disks/${row.id}/files`);
  const readme = page.locator('[data-testid="fs-entry"][data-name="README"]');
  await expect(readme).toBeVisible();

  // This is the regression that mattered: the fixed columns totalled more
  // than the card was wide, so the name computed to a negative width and the
  // Download control was clipped away entirely.
  await expect(readme.getByText('README')).toBeVisible();
  const download = readme.locator('a[data-testid^="fs-download-"]');
  await expect(download).toBeVisible();
  const box = (await download.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  // D-6-4 (updated by task 11): the row now legitimately holds more than
  // one <button> -- Rename and Delete joined the directory toggle -- so
  // "only one button in the row" is no longer the invariant to protect.
  // What still has to hold, and what this asserts, is that the toggle
  // itself is uniquely locatable by its own testid rather than ambiguous
  // among however many buttons the row happens to have.
  await expect(
    page.locator('[data-testid="fs-entry"][data-name="C"]').locator('[data-testid^="fs-toggle-"]'),
  ).toHaveCount(1);
});

test('the table view keeps every column reachable by scrolling', async ({ page }) => {
  await seedLibrary(page, 3);
  await page.goto('/library');
  // getByLabel, not a testid: the toggle is two <Link>s identified by
  // aria-label (view-toggle.tsx), which is also how view-toggle.spec.ts
  // finds them.
  await page.getByLabel('Table view').tap();

  const table = page.getByTestId('game-table');
  await expect(table).toBeVisible();
  // The rows are deliberately wider than the phone; what matters is that the
  // container SCROLLS to them rather than clipping them, which is what
  // overflow-hidden alone did before.
  const scrollable = await table.evaluate((el) => {
    const box = el.querySelector('[class*="overflow-x-auto"]') as HTMLElement | null;
    if (!box) return null;
    return { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth };
  });
  expect(scrollable).not.toBeNull();
  expect(scrollable!.scrollWidth).toBeGreaterThan(scrollable!.clientWidth);
});

test('a touch drag scrolls the library, and a press-and-hold drags a card', async ({ page }) => {
  await seedLibrary(page, 12);
  await page.goto('/library');
  const card = page.getByTestId('game-card').first();
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // 1. A finger dragged immediately must SCROLL. This is the regression the
  //    backlog predicted: with a distance-only constraint the grid picked a
  //    card up instead, and the page could not be scrolled past the fold.
  const scroll = await touchDrag(page, from, -260, { holdMs: 0 });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await scroll.end();

  // 2. The same finger, held first, must DRAG. dnd-kit drops a dragging card
  //    to opacity 0.4 (game-grid.tsx dragStyle), which is the only
  //    observable difference between the two gestures.
  await page.evaluate(() => window.scrollTo(0, 0));
  const box2 = (await card.boundingBox())!;
  const held = await touchDrag(
    page,
    { x: box2.x + box2.width / 2, y: box2.y + box2.height / 2 },
    -120,
    { holdMs: 400 },
  );
  await expect.poll(() => card.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.4');
  await held.end();
});

test('the Create ADF menu opens and makes a disk at a phone width', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');

  // Worth a mobile test specifically because of what was given up: the old
  // control was a native <select>, and a phone renders one as an OS picker
  // for free -- correctly sized, always on screen, impossible to get wrong.
  // A Base UI menu inherits none of that, so it has to be asserted.
  await page.getByTestId('create-adf').tap();
  const ffs = page.getByTestId('create-adf-ffs');
  await expect(ffs).toBeVisible();

  // On screen horizontally. A popup anchored to a button near the right edge
  // of a 390px viewport is the obvious way for this to go wrong.
  const box = (await ffs.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // And big enough to hit with a finger rather than a mouse.
  expect(box.height).toBeGreaterThanOrEqual(32);

  await ffs.tap();
  await expect(page.getByTestId('game-card')).toHaveCount(1);

  // The menu is portalled to the body, so it can widen the document without
  // widening any container the grid test would have caught.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/**
 * The file toolbar (upload, new folder) and a row's Rename/Delete controls,
 * at 390x844. Worth a real check for the same reason the Create ADF menu
 * was: task-11's controls are ordinary buttons and inline forms, not the
 * dropdown that the Create ADF finding was about, but nothing here was ever
 * proven to fit a phone either, and the same card that clips the Download
 * link (the "a file tree row shows its name AND its download control" test
 * above) is exactly where these controls live too.
 */
test('the file toolbar and a row\'s controls fit a phone', async ({ page }) => {
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  // WAIT FOR THE CARD BEFORE QUERYING. createAdf() returns the moment it
  // clicks the menu item, but the disk is made by a request still in
  // flight, so a query fired immediately finds nothing and `game.id` throws
  // on undefined. disk-files-edit.spec.ts hit exactly this and now hides the
  // wait inside its own helper; this file has no such helper, so the wait is
  // explicit. create-adf.spec.ts has always done it this way.
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  if (!game) throw new Error(`no authored game for org ${u.orgId} after createAdf`);
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));

  await page.goto(`/disks/${disk.id}/files`);
  const toolbar = page.getByTestId('file-toolbar');
  await expect(toolbar).toBeVisible();
  let box = (await toolbar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  // Selecting a file swaps the trigger for the name+submit+cancel form --
  // that form is what has to fit, not just the trigger button.
  await page.getByTestId('upload-input').setInputFiles({
    name: 'PHONE.TXT', mimeType: 'application/octet-stream', buffer: Buffer.from('phone upload'),
  });
  for (const id of ['upload-name', 'upload-submit', 'upload-cancel']) {
    box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId('upload-submit').tap();

  const row = page.locator('[data-testid="fs-entry"][data-name="PHONE.TXT"]');
  await expect(row).toBeVisible();

  const adf = new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body());
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  const block = volume.root.find((e) => e.name === 'PHONE.TXT')!.block;

  await page.getByTestId(`fs-rename-${block}`).tap();
  for (const id of [`fs-rename-name-${block}`, `fs-rename-submit-${block}`, `fs-rename-cancel-${block}`]) {
    box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId(`fs-rename-cancel-${block}`).tap();

  await page.getByTestId(`fs-delete-${block}`).tap();
  for (const id of [`fs-delete-confirm-${block}`, `fs-delete-cancel-${block}`]) {
    box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId(`fs-delete-cancel-${block}`).tap();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
