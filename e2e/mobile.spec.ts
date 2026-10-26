import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { readVolume } from '@/lib/adffs';
import { signUpFresh, runTag, createAdf, stagingReady, openTitleMenu, openRowMenu } from './helpers';
import { cleanupSeeded, seedDisk, addDisk, pairDevice, authHeader, hydrated } from './device-helpers';
import { synthDrop } from './drag-drop-helpers';
import { zoneOf } from '@/lib/set-folder';
import { seedProduction, seedSuggestion, cleanupDemozoo } from './demozoo-helpers';

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

test.afterAll(async () => { await cleanupDemozoo(); await cleanupSeeded(); });

const sha = (s: string) => createHash('sha256').update(`mobile-${s}`).digest('hex');

/** Same pattern as devices-page.spec.ts's setDevice: write directly to a
 * devices row -- how these tests drive a device into a specific state. */
async function setDevice(deviceId: string, patch: Partial<typeof devices.$inferInsert>) {
  await getDb().update(devices).set(patch).where(eq(devices.id, deviceId));
}

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

test('the bottom bar reaches every route through four tabs and More, and there is only one nav', async ({ page }) => {
  await seedLibrary(page, 2);
  await page.goto('/library');

  // One site nav, not a desktop copy plus a mobile copy -- a duplicate
  // would make getByRole('link') ambiguous here AND in the 1280 specs. The
  // library's pager is a <nav> of its own (aria-label "Pages"), so it is left
  // out by name rather than counted.
  const navs = page.locator('nav:not([aria-label="Pages"])');
  await expect(navs).toHaveCount(1);

  const bar = navs;
  const box = (await bar.boundingBox())!;
  // Actually at the bottom of the 844px viewport, not merely styled for it.
  expect(box.y + box.height).toBeGreaterThan(760);

  // C7 (spec §2.3): Library, Devices, Upload and More, each a finger's height.
  const tabs = bar.locator(':scope > a, :scope > button').filter({ visible: true });
  await expect(tabs).toHaveText(['Library', 'Devices', 'Upload', 'More']);
  for (const t of await tabs.all()) expect((await t.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await page.getByRole('link', { name: 'Devices' }).tap();
  await expect(page).toHaveURL(/\/devices$/);
  await page.getByRole('link', { name: 'Upload' }).tap();
  await expect(page).toHaveURL(/\/ingest$/);
  await page.getByRole('link', { name: 'Library' }).tap();
  await expect(page).toHaveURL(/\/library/);
  // Help lives in More now.
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').tap();
  await page.getByTestId('more-help').tap();
  await expect(page).toHaveURL(/\/help$/);
});

test('the library grid is two columns, and nothing overflows the viewport', async ({ page }) => {
  await seedLibrary(page, 4);
  await page.goto('/library');

  const cards = page.getByTestId('game-card');
  await expect(cards).toHaveCount(4);
  // Streamed cards are in the DOM before React reveals them: measure only once visible.
  await expect(cards.nth(3)).toBeVisible();
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

test('Devices cards are one per row at 390px, and nothing overflows the viewport', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId: idA } = await pairDevice(page, request, 'Mobile A');
  const { deviceId: idB } = await pairDevice(page, request, 'Mobile B');
  const { deviceId: idC } = await pairDevice(page, request, 'Mobile C');

  // A URL-shaped lastError (re-review finding): no spaces, so nothing breaks
  // it unless the card's amber error block itself wraps -- this one
  // overflowed its card by 238px and gave the whole page horizontal scroll
  // at 390px before the overflowWrap fix.
  await setDevice(idA, {
    lastError: 'SPI timeout: see https://errors.example.test/incidents/9f8e7d6c5b4a3928170615243342526a1b2c3d4e5f60718293a4b5c6d7e8f90 for details',
    lastErrorAt: new Date(),
  });
  // A long, real-shaped firmware version (fix round 1, critical 2): no
  // spaces, so nothing breaks it unless the card itself provides a wrap point.
  await setDevice(idC, { firmwareVersion: '1.1.4+g137a4db-dirty' });
  // A failure reason containing a URL, on a FOURTH device -- the other shape
  // critical 2 named, and a card this narrow has never had to wrap one.
  const { deviceId: idD } = await pairDevice(page, request, 'Mobile D');
  await setDevice(idD, {
    desiredFirmwareVersion: '1.1.5+ge5f6a7b',
    firmwareUpdateState: 'failed',
    firmwareUpdateError: 'reverted: could not reach https://updates.example.test/firmware/1.1.5+ge5f6a7b.bin within 5 minutes',
  });

  await page.goto('/devices');
  const ids = [idA, idB, idC, idD];
  for (const id of ids) await expect(page.getByTestId(`device-${id}`)).toBeVisible();   // streamed (A1)
  // listDevices orders by `devices.name` -- and register/route.ts names every
  // device "Device <mac>" from a RANDOM mac, ignoring the label pairDevice()
  // was given (same landmine devices-page.spec.ts's own "org B's device"
  // test comments on). So which of these four lands in row 1 vs row 2 is not
  // predictable from pairing order -- group by actual Y position instead of
  // assuming idA/idB share the first row.
  const boxes = await Promise.all(ids.map((id) => page.getByTestId(`device-${id}`).boundingBox()));
  const nonNull = boxes.filter((b): b is NonNullable<typeof b> => b !== null);
  expect(nonNull).toHaveLength(4);
  const byRow = [...nonNull].sort((x, y) => x.y - y.y);

  // One per row (spec Ruling 2): every card is nearly the full 390 px less the gutters, and they stack.
  for (const box of byRow) expect(box.width).toBeGreaterThan(330);
  for (let k = 1; k < byRow.length; k++) expect(byRow[k].y).toBeGreaterThan(byRow[k - 1].y + byRow[k - 1].height - 1);

  // CRITICAL 1 guard: the device name must not be squeezed to nothing next
  // to the online badge and the Name/Rename control on a 173px-wide card.
  for (const id of ids) {
    const nameBox = (await page.getByTestId(`device-name-${id}`).boundingBox())!;
    expect(nameBox.width).toBeGreaterThan(40);
  }

  // CRITICAL 2 guard: no card's right edge may exceed the viewport, and
  // neither may the document as a whole -- a long unbroken firmware version,
  // a URL-bearing failure reason, or a URL-shaped lastError forced this
  // before the fixes (238px for lastError alone, per the re-review finding).
  for (const box of nonNull) {
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const errorBox = (await page.getByTestId(`device-error-${idA}`).boundingBox())!;
  expect(errorBox.x + errorBox.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('an HFE that cannot be extracted says why on screen, not only in a tooltip, without overflowing', async ({ page }) => {
  // A phone has no hover, so a `title` alone left "play only" with no why.
  const u = await signUpFresh(page);
  const { gameId, diskId } = await seedDisk(u.orgId, {
    title: `Mobile HFE ${runTag()}`, diskNo: 1, sha256: sha(`hfe-${randomUUID()}`),
    sizeBytes: 2_049_024, imageFormat: 'hfe',
  });
  const reason = 'Track 12 (cylinder 6, side 0): 3 of 11 sectors readable';
  await getDb().update(disks).set({ extractable: false, extractReason: reason }).where(eq(disks.id, diskId));

  await page.goto(`/games/${gameId}`);
  const why = page.getByTestId(`extract-why-${diskId}`);
  await expect(why).toBeVisible();
  await expect(why).toHaveText(reason);
  const box = (await why.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
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
  // row's controls were clipped away entirely. The row's actions are in its
  // ⋯ menu now (C4): the trigger must be in view, and so must Download inside it.
  await expect(readme.getByText('README')).toBeVisible();
  const more = readme.locator('[data-testid^="fs-more-"]');
  await expect(more).toBeVisible();
  let box = (await more.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await openRowMenu(page, 'README');
  const download = page.locator('a[data-testid^="fs-download-"]');
  await expect(download).toBeVisible();
  box = (await download.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  // D-6-4 (updated by task 11, and C4): the row now legitimately holds more than
  // one <button> -- the grip, the protection chips and the ⋯ menu (where the row's actions are) joined the directory toggle -- so
  // "only one button in the row" is no longer the invariant to protect.
  // What still has to hold, and what this asserts, is that the toggle
  // itself is uniquely locatable by its own testid rather than ambiguous
  // among however many buttons the row happens to have.
  await expect(
    page.locator('[data-testid="fs-entry"][data-name="C"]').locator('[data-testid^="fs-toggle-"]'),
  ).toHaveCount(1);
});

test('the table view at 390: each name wraps whole with its facts under it, the ⋯ is in view, nothing scrolls sideways', async ({ page }) => {
  const { u, run } = await seedLibrary(page, 3);
  const long = `Mobile ${run} A very long title that has to wrap onto a second line`.slice(0, 70);
  await seedDisk(u.orgId, { title: long, diskNo: 1, sha256: sha(`${run}-long`) });
  await page.goto('/library');
  // getByLabel, not a testid: the toggle is two <Link>s identified by
  // aria-label (view-toggle.tsx), which is also how view-toggle.spec.ts
  // finds them.
  await page.getByLabel('Table view').tap();
  const table = page.getByTestId('game-table');
  await expect(table).toBeVisible();
  const row = page.getByTestId('game-row').filter({ hasText: long });
  await expect(row).toBeVisible();
  // C7 (spec §4.3, Ruling 17): the whole name, no ellipsis; the hidden columns' facts on a line under it.
  const name = row.getByText(long, { exact: true });
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true);
  await expect(row.locator('[data-meta]')).toContainText('1 disk');
  const menu = (await row.locator('[data-testid^="title-menu-"]').boundingBox())!;
  expect(menu.width).toBeGreaterThanOrEqual(44);
  expect(menu.x + menu.width).toBeLessThanOrEqual(390);
  expect(await table.evaluate((el) => {
    const box = el.querySelector('[class*="overflow-x-auto"]') as HTMLElement;
    return box.scrollWidth <= box.clientWidth;
  })).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
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

test('the Create ADF panel opens as a bottom sheet and makes a disk at a phone width', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');

  // Worth a mobile test specifically because of what was given up: the old
  // control was a native <select>, and a phone renders one as an OS picker
  // for free -- correctly sized, always on screen, impossible to get wrong.
  // The bottom sheet inherits none of that, so it has to be asserted.
  await page.getByTestId('create-adf').tap();
  const panel = page.getByTestId('create-adf-panel');
  await expect(panel).toBeVisible();

  // A bottom sheet: full width, flush with the bottom of the viewport.
  // Polled, because the sheet slides in.
  await expect.poll(async () => {
    const b = (await panel.boundingBox())!;
    return Math.round(b.y + b.height);
  }).toBe(844);
  const sheet = (await panel.boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(390);
  expect(sheet.width).toBeGreaterThanOrEqual(380);

  // Every control is big enough to hit with a thumb rather than a mouse.
  for (const id of ['create-adf-size-dd', 'create-adf-size-hd', 'create-adf-fs-ffs', 'create-adf-fs-ofs', 'create-adf-submit']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(44);
  }

  await page.getByTestId('create-adf-submit').tap();
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(panel).toBeHidden();

  // The sheet is portalled to the body, so it can widen the document without
  // widening any container the grid test would have caught.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/**
 * The file toolbar (upload, new folder) and a row's Rename/Delete controls,
 * at 390x844. Worth a real check for the same reason the create-disk menu
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
  // Explicit timeout: this is a file write into an ADF plus a server
  // re-render, not a local DOM update, and the default 5 s is tight enough
  // that it fails under the load of a FULL suite run while passing every time
  // this file is run on its own. Measured 2026-09-13 -- 1 failure in a
  // 241-test run, 16/16 passes in isolation both before and after the change
  // that was briefly suspected of causing it. Same 10 s the collection drag
  // assertions in this suite already use, for the same reason.
  await expect(row).toBeVisible({ timeout: 15_000 });

  const adf = new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body());
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  const block = volume.root.find((e) => e.name === 'PHONE.TXT')!.block;

  await openRowMenu(page, block);
  await page.getByTestId(`fs-rename-${block}`).tap();
  for (const id of [`fs-rename-name-${block}`, `fs-rename-submit-${block}`, `fs-rename-cancel-${block}`]) {
    box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.getByTestId(`fs-rename-cancel-${block}`).tap();

  await openRowMenu(page, block);
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

/**
 * Task 11: the drop strip, the staging list it grows into, and a
 * press-and-hold drag onto a folder -- at 390x844.
 *
 * `synthDrop` (drag-drop-helpers.ts) is used here exactly as it is in
 * disk-drag-drop.spec.ts's desktop specs -- Playwright cannot drive a real
 * OS file drop on a phone any more than it can on a desktop browser, and
 * that helper's own comment states plainly what it does and does not
 * prove. What THIS test adds is the thing neither the desktop suite nor a
 * synthesized drop can check: whether the staging list it grows into
 * actually fits a 390px screen, and whether a real finger (via CDP, not a
 * mouse event wearing a touch costume -- same reasoning as `touchDrag`,
 * above) can still drag an entry inside the tree once the row also carries
 * a grip handle, a toggle, Rename, Delete and Move to....
 */
test('the drop strip fits a phone, and a press-and-hold drags an entry onto a folder', async ({ page }) => {
  // This one test signs up, makes a disk, writes two files, stages a drop, then touch-drags: ~25 s warm and over
  // the 30 s default on a cold dev-server compile of the files page. The drag itself lands (the PATCH returns
  // 200); the old failure was the budget running out while polling for the moved entry.
  test.setTimeout(90_000);
  const u = await signUpFresh(page);
  await page.goto('/library');
  await createAdf(page);
  // WAIT FOR THE CARD BEFORE QUERYING -- see the identical comment on the
  // file-toolbar test above; createAdf() returns before the disk exists.
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  const [game] = await getDb().select().from(games)
    .where(and(eq(games.orgId, u.orgId), eq(games.authored, true)));
  if (!game) throw new Error(`no authored game for org ${u.orgId} after createAdf`);
  const [disk] = await getDb().select().from(disks).where(eq(disks.gameId, game.id));

  // A folder and a file to drag into it, made through the API rather than
  // the UI -- this test is about touch input and layout, not about
  // upload, and disk-drag-drop.spec.ts already covers making them by hand.
  await page.request.post(`/api/disks/${disk.id}/files`, {
    multipart: { parentBlock: '880', name: 'DEST' },
  });
  await page.request.post(`/api/disks/${disk.id}/files`, {
    multipart: {
      parentBlock: '880', name: 'DRAGME.TXT',
      file: { name: 'DRAGME.TXT', mimeType: 'application/octet-stream', buffer: Buffer.from('mobile drag') },
    },
  });

  await page.goto(`/disks/${disk.id}/files`);
  const strip = page.getByTestId('drop-strip');
  await expect(strip).toBeVisible();
  let box = (await strip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  // Stage something so the LIST actually renders -- the always-visible
  // strip above it was never the thing at risk of clipping; a list of rows
  // with a name field, a conflict message and two buttons is.
  await synthDrop(page, [{
    name: 'Utilities',
    kind: 'dir',
    children: [{ name: 'A name long enough that it has to be shortened for AmigaDOS', kind: 'file', content: 'hi' }],
  }]);
  const list = page.getByTestId('drop-staging-list');
  await expect(list).toBeVisible();
  box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  const stagingOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(stagingOverflow).toBeLessThanOrEqual(0);

  await page.getByTestId('drop-clear').tap();
  await expect(list).toHaveCount(0);

  // Now the press-and-hold drag: DRAGME.TXT onto DEST.
  const adf = new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body());
  const volume = readVolume(adf);
  expect(volume.ok).toBe(true);
  if (!volume.ok) return;
  const dest = volume.root.find((e) => e.name === 'DEST')!;
  const dragged = volume.root.find((e) => e.name === 'DRAGME.TXT')!;

  const grip = page.getByTestId(`fs-drag-${dragged.block}`);
  const dropZone = page.getByTestId(`fs-drop-${dest.block}`);
  const entryRow = page.locator('[data-testid="fs-entry"][data-name="DRAGME.TXT"]');
  await expect(grip).toBeVisible();
  // PUT BOTH ROWS MID-VIEWPORT FIRST. The History panel (the time machine)
  // made this page taller than a phone viewport, so it now scrolls -- and
  // dnd-kit auto-scrolls a scrollable container whenever a drag's pointer
  // sits in its top or bottom quarter. This drag is scripted from
  // coordinates measured BEFORE it starts, so an auto-scroll slides the
  // target out from under a finger that cannot chase it the way a person's
  // would: measured at 156px of drift (the drop zone went from y=31 to
  // y=205 mid-drag), which is more than two rows, and the drop then lands on
  // nothing. A person gets the auto-scroll ON PURPOSE -- it is how you reach
  // a folder that is off-screen -- so the behaviour is right and the
  // assumption "this page does not scroll" is what stopped being true.
  await grip.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const gripBox = (await grip.boundingBox())!;
  const dropBox = (await dropZone.boundingBox())!;
  const from = { x: gripBox.x + gripBox.width / 2, y: gripBox.y + gripBox.height / 2 };
  const targetY = dropBox.y + dropBox.height / 2;

  // 250ms hold, matching the TouchSensor's own activation delay
  // (file-tree.tsx copies collection-provider.tsx's sensor setup
  // verbatim) -- anything shorter is a scroll gesture, not a drag.
  const drag = await touchDrag(page, from, targetY - from.y, { holdMs: 400 });
  await expect.poll(() => entryRow.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.5');
  await drag.end();

  await expect.poll(async () => {
    const after = new Uint8Array(await (await page.request.get(`/api/disks/${disk.id}/adf`)).body());
    const afterVolume = readVolume(after);
    if (!afterVolume.ok) return null;
    const destAfter = afterVolume.root.find((e) => e.name === 'DEST');
    return destAfter?.children.find((c) => c.name === 'DRAGME.TXT')?.block ?? null;
  }, { timeout: 15_000 }).toBe(dragged.block);
});

test('the Demozoo review queue does not overflow at 390px', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = createHash('sha256').update(randomUUID()).digest('hex');
  await seedDisk(user.orgId, { title: `mobile-dz-${Date.now()}`, diskNo: 1, sha256 });
  const pid = await seedProduction({ title: `A Rather Long Demozoo Production Title ${Date.now()}`, groups: ['Some Group With A Long Name'] });
  await seedSuggestion(sha256, pid);

  await page.goto('/library/demozoo');
  await expect(page.getByTestId('review-item').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/** Task 13 step 2: the Devices header's "Write a Next-disk card" button at 390px. */
test('write-next-card is visible and fits the viewport on Devices', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  await seedDisk(orgId, { title: `Mobile Next ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  // `preload: null`: a 1.6.0+ board, the only kind offered the Next-disk card.
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, nfcReader: 'present', preload: null },
  })).status()).toBe(204);

  await page.goto('/devices');
  const trigger = page.getByTestId('write-next-card');
  await expect(trigger).toBeVisible();
  const box = (await trigger.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a press-and-hold inside a card\'s dialog does not drag the card behind it', async ({ page, request }) => {
  // Both dialogs are portalled out of the card, but React bubbles their
  // events through the card anyway -- and dnd-kit's TouchSensor activates on
  // touchstart, which the overlays used to let through.
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const status = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, nfcReader: 'present' },
  });
  expect(status.status()).toBe(204);
  const { gameId } = await seedDisk(orgId, { title: `Mobile Hold ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.goto('/library');
  const card = page.getByTestId('game-card').first();

  async function holdInside(target: ReturnType<Page['getByTestId']>) {
    const b = (await target.boundingBox())!;
    const held = await touchDrag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, -120, { holdMs: 400 });
    // Past the TouchSensor's 250 ms delay and then some: a drag would have
    // dropped the card to opacity 0.4 by now (see the press-and-hold test).
    await page.waitForTimeout(400);
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await held.end();
  }

  // The ⋯ popup is portalled out of the card too, and bubbles through it the same way.
  await openTitleMenu(page, gameId);
  await holdInside(page.getByTestId('title-menu-panel'));
  await expect(page.getByTestId('title-menu-panel')).toBeVisible();
  await page.getByTestId(`fob-${gameId}`).tap();
  await expect(page.getByTestId('fob-waiting')).toBeVisible();
  await holdInside(page.getByTestId('fob-waiting'));
  await page.getByTestId('fob-cancel').tap();
  await expect(page.getByTestId('fob-dialog')).toHaveCount(0);

  await openTitleMenu(page, gameId);
  await page.getByTestId(`delete-game-${gameId}`).tap();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await holdInside(page.getByTestId('delete-dialog'));
  await page.getByTestId('delete-cancel').tap();
  await expect(page.getByTestId('delete-dialog')).toHaveCount(0);
});

test('a disk set at 390px: the ⋯ menus, their items and the ▲▼ buttons are 44px and on screen, and nothing scrolls sideways', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const { gameId, diskId: d1 } = await seedDisk(orgId, { title: `Mobile Set ${tag}`, diskNo: 1, sha256: sha(`${tag}-set-1`) });
  const { diskId: d2 } = await addDisk(orgId, gameId, { diskNo: 2, sha256: sha(`${tag}-set-2`) });
  const { diskId: d3 } = await addDisk(orgId, gameId, { diskNo: 3, sha256: sha(`${tag}-set-3`) });
  const ids = [d1, d2, d3];
  const vw = page.viewportSize()!.width;

  const fits = async (loc: ReturnType<Page['getByTestId']>) => {
    const b = (await loc.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vw);
  };
  const noSideways = async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  };

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId('disk-set-section')).toBeVisible();
  for (const id of ids) await fits(page.getByTestId(`disk-menu-${id}`));
  await fits(page.getByTestId('disk-set-add'));
  await fits(page.getByTestId('disk-set-reorder'));
  await noSideways();

  // The open menu: its items are 44px rows and stay inside the viewport.
  await page.getByTestId(`disk-menu-${d2}`).tap();
  // The menu opens with a zoom-in (scale 0.95 → 1): measured mid-animation a
  // 44px row reads ~42.7px. Wait for it to settle, then measure.
  await expect(page.getByTestId(`disk-up-${d2}`)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length))
    .toBe(0);
  for (const item of [`disk-up-${d2}`, `disk-down-${d2}`, `disk-move-out-${d2}`]) {
    const b = (await page.getByTestId(item).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vw);
  }
  await page.getByTestId(`disk-up-${d2}`).tap();
  await expect(page.getByTestId(`disk-${d2}`)).toContainText('Disk 1');
  await noSideways();

  // The Add disks… dialog is a full-width sheet with 44px controls.
  await page.getByTestId('disk-set-add').tap();
  const dialog = page.getByTestId('add-disks-dialog');
  await expect(dialog).toBeVisible();
  const db = (await dialog.boundingBox())!;
  expect(db.x).toBeGreaterThanOrEqual(0);
  expect(db.x + db.width).toBeLessThanOrEqual(vw);
  // The search field's tap target is its <label> (the bare input inside is
  // one text line tall; a tap anywhere on the label focuses it).
  const searchLabel = page.getByTestId('add-disks-search').locator('xpath=ancestor::label[1]');
  for (const loc of [searchLabel, page.getByTestId('add-disks-cancel'), page.getByTestId('add-disks-confirm')]) {
    expect((await loc.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await noSideways();
  await page.getByTestId('add-disks-cancel').tap();
  await expect(dialog).toHaveCount(0);

  await page.getByTestId('disk-set-reorder').tap();
  for (const id of ids) {
    await fits(page.getByTestId(`disk-grip-${id}`));
    await fits(page.getByTestId(`disk-reorder-up-${id}`));
    await fits(page.getByTestId(`disk-reorder-down-${id}`));
  }
  await fits(page.getByTestId('disk-set-done'));
  await noSideways();

  // ▼ by a finger works: d2 (now first) goes back to second.
  await page.getByTestId(`disk-reorder-down-${d2}`).tap();
  await expect(page.getByTestId(`disk-reorder-no-${d2}`)).toHaveText('2');
  await page.getByTestId('disk-set-done').tap();
  await expect(page.getByTestId(`disk-${d2}`)).toContainText('Disk 2');
});

test('a card held and dropped on a card at 390px opens the set dialog: it fits, its controls are 44px, nothing scrolls sideways', async ({ page }) => {
  // Six, not three: enough page below the two cards to scroll them into
  // the middle of the viewport (see below).
  const { u, run } = await seedLibrary(page, 6);
  await page.goto('/library');
  const cards = page.getByTestId('game-card');
  await expect(cards).toHaveCount(6);
  const vw = page.viewportSize()!.width;

  // Card 3 sits under card 1 (two columns), so a straight upward finger
  // drag goes from one onto the other. Both go mid-viewport first: dnd-kit
  // auto-scrolls the page while a drag's pointer is in the top or bottom
  // fifth, and a scripted finger cannot chase a target that scrolls away
  // (the same reason as the file-tree drag above).
  const top0 = (await cards.nth(0).boundingBox())!;
  await page.evaluate((dy) => window.scrollBy(0, dy), top0.y + top0.height / 2 - 280);
  const from = (await cards.nth(2).boundingBox())!;
  const to = (await cards.nth(0).boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const drag = await touchDrag(page, start, (to.y + to.height / 2) - start.y, { holdMs: 400 });
  await expect(cards.nth(0).getByTestId('set-drop-target')).toBeVisible();
  await drag.end();

  const dialog = page.getByTestId('set-drop-dialog');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  expect(box.width).toBeGreaterThanOrEqual(vw - 1);   // a full-width sheet
  for (const id of ['set-drop-name', 'set-drop-swap', 'set-drop-cancel', 'set-drop-confirm']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vw);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByTestId('set-drop-cancel').tap();
  await expect(dialog).toHaveCount(0);
  await expect(cards).toHaveCount(6);
  const titles = await getDb().select({ id: games.id }).from(games).where(eq(games.orgId, u.orgId));
  expect(titles).toHaveLength(6);
  void run;
});

test('in a collection at 390px: a finger walked slowly into a card\'s centre leaves it where it is; after the hold it offers the set, and Add makes it', async ({ page }) => {
  const u = await signUpFresh(page);
  const run = runTag();
  const t = (x: string) => `Finger${x} ${run}`;
  const seeded = [];
  for (const x of ['A', 'B', 'C']) seeded.push(await seedDisk(u.orgId, { title: t(x), diskNo: 1, sha256: sha(`${run}-folder-${x}`) }));
  const [a, b] = seeded;
  const res = await page.request.post('/api/collections', { data: { name: `Finger ${run}` } });
  expect(res.status()).toBe(200);
  const collectionId = (await res.json()).id as string;
  for (const g of seeded) {
    expect((await page.request.post(`/api/collections/${collectionId}/games`, { data: { gameId: g.gameId } })).status()).toBe(200);
  }

  await page.goto(`/library?collection=${collectionId}`);
  const cards = page.getByTestId('game-card');
  await expect(cards).toHaveCount(3);
  const cardOf = (title: string) => cards.filter({ hasText: title });
  // Two columns: A and B side by side, so a finger walks across from one to the other.
  // Counted is not shown: streamed cards sit in a hidden boundary until React swaps them in (box null).
  await expect(cardOf(t('A'))).toBeVisible();
  await expect(cardOf(t('B'))).toBeVisible();
  const from = (await cardOf(t('A')).boundingBox())!;
  const slot = (await cardOf(t('B')).boundingBox())!;
  expect(Math.abs(from.y - slot.y)).toBeLessThan(2);
  const inCentre = (p: { x: number; y: number }) =>
    zoneOf(p, { left: slot.x, top: slot.y, width: slot.width, height: slot.height }) === 'centre';
  const offBy = (bx: { x: number; y: number }) => Math.max(Math.abs(bx.x - slot.x), Math.abs(bx.y - slot.y));

  // Press and hold past the TouchSensor's 250 ms, then walk 4 px a frame.
  const cdp = await page.context().newCDPSession(page);
  const y = from.y + from.height / 2;
  let x = from.x + from.width / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(400);
  const walk: Array<{ centre: boolean; off: number }> = [];
  const tx = slot.x + slot.width / 2;
  while (x < tx) {
    x = Math.min(tx, x + 4);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
    walk.push({ centre: inCentre({ x, y }), off: offBy((await cardOf(t('B')).boundingBox())!) });
  }
  const hold: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 600) {
    hold.push(offBy((await cardOf(t('B')).boundingBox())!));
    await page.waitForTimeout(50);
  }
  console.log(`[folder finger A into B] walk: ${walk.map((w) => `${w.centre ? 'C' : 'e'}${Math.round(w.off)}`).join(' ')}; ` +
    `hold: ${hold.map((o) => o.toFixed(1)).join(' ')}`);
  const inside = walk.filter((w) => w.centre);
  expect(inside.length, 'the finger reached B\'s centre').toBeGreaterThan(5);
  expect(Math.max(...walk.map((w) => w.off)), 'B moved while the finger crossed its edge or sat in its centre').toBeLessThanOrEqual(2);
  expect(Math.max(...hold), 'B moved during the hold').toBeLessThanOrEqual(2);
  await expect(cardOf(t('B')).getByTestId('set-drop-target')).toBeVisible();
  await expect(page.getByTestId('set-drop-target')).toHaveCount(1);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();

  const dialog = page.getByTestId('set-drop-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('set-drop-order-1')).toContainText(t('B'));
  await expect(dialog.getByTestId('set-drop-order-2')).toContainText(t('A'));
  await page.waitForTimeout(100);   // dnd-kit swallows clicks for 50 ms after a drop
  await page.getByTestId('set-drop-confirm').tap();
  await expect(dialog).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  const rows = await getDb().select({ gameId: disks.gameId }).from(disks).where(eq(disks.id, a.diskId));
  expect(rows[0].gameId).toBe(b.gameId);
  const left = await getDb().select({ id: games.id }).from(games).where(eq(games.orgId, u.orgId));
  expect(left).toHaveLength(2);
});

test('the Upload page puts its two drop tiles side by side at 390px, and a 200-byte saved path wraps', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'A board with a rather long name for a phone screen');
  await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.15.0+gabc1234', secondDrive: 'net', driveVersion: 0 } });
  await request.get('/api/device/poll?since=999999&xferAck=0&rx=c', { headers: authHeader(token) });
  await page.goto('/ingest');
  await stagingReady(page);
  await page.getByTestId('send-file-input').setInputFiles({ name: 'p.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(page.locator('[data-testid="staging-row"][data-key^="send:"]')).toHaveCount(1, { timeout: 15_000 });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  const id = /^NEXT (\S+) /.exec(q)![1];
  await request.get(`/api/device/send/${id}?offset=0&length=1`, { headers: authHeader(token) });
  const long = Array.from({ length: 7 }, (_, i) => `Folder${i}${'x'.repeat(21)}`).join('/') + '/p.txt';
  expect(long.length).toBeGreaterThanOrEqual(200);
  await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: { ok: true, savedAs: long } });
  await expect(page.getByTestId(`staging-status-send:${id}`)).toContainText('Delivered', { timeout: 15_000 });
  await expect(page.locator(`[data-testid="staging-row"][data-key="send:${id}"]`)).toContainText(`saved as ${long}`);
  // C7 (spec §7, Ruling 19): the two file labels are the board's tiles, side by side, at least 96 px tall, the URL
  // row under them.
  const add = (await page.getByTestId('add-browse').boundingBox())!;
  const send = (await page.getByTestId('send-browse').boundingBox())!;
  expect(Math.abs(add.y - send.y)).toBeLessThan(1);
  expect(send.x).toBeGreaterThan(add.x + add.width - 1);
  for (const t of [add, send]) expect(t.height).toBeGreaterThanOrEqual(96);
  expect((await page.getByTestId('url-fetch-form').boundingBox())!.y).toBeGreaterThan(add.y + add.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
