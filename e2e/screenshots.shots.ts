import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, games } from '@/db/schema/catalog';
import { invites } from '@/db/schema/devices';
import { deleteUserCascade } from '@/lib/admin-delete';
import { mintInviteCode, signedUpOrgIds, libRows, stagingReady } from './helpers';
import { pairDevice, cleanupSeeded } from './device-helpers';

/**
 * The README screenshots, from a demo org made for the purpose.
 *
 *   PORT=3100 pnpm screenshots
 *
 * Not part of `pnpm e2e` (see playwright.screenshots.config.ts). Never point it
 * at a real tenant: it signs up its own @example.test account, uploads freely
 * redistributable disks from adf-archive/ through the real ingest page, lets
 * the app's own identification sweep title them (TOSEC, Demozoo), accepts the
 * Demozoo suggestions through the review page, and deletes the account and
 * everything it owned afterwards.
 *
 * The disks: Amiga Test Kit (Keir Fraser, public domain), WhichAmiga and
 * SysInfo (freeware), and four scene demos (9 Fingers, State of the Art,
 * Global Trash, Ray of Hope 2). No commercial games, no Workbench.
 *
 * Writes docs/screenshots/*.png and squeezes each through ImageMagick when it
 * is installed (a 256-colour palette keeps a page under ~400 KB).
 */

const DEMO_EMAIL = 'demo@example.test';
const DEMO_PASSWORD = 'correct-horse-battery-staple';
const ARCHIVE = 'adf-archive';
const OUT = 'docs/screenshots';
const UPLOADS = [
  'AmigaTestKit.adf',
  'whichamiga.adf',
  'SysInfo.adf',
  '9Fingers_D1.adf',
  '9Fingers_D2.adf',
  'Stateart.adf',
  'Globaltr.adf',
  'RayOfHopeII.adf',
];
/** A real firmware version, so the card does not offer an update or read as ahead. */
const FIRMWARE = '1.11.0+g2671ef7';

let demoUserId: string | null = null;
let inviteCode: string | null = null;

async function userIdByEmail(email: string): Promise<string | null> {
  const r = await getDb().execute<{ id: string }>(sql`select id from auth."user" where email = ${email}`);
  return r.rows[0]?.id ?? null;
}

/** Remove the demo account and everything its org owns. Safe to call twice. */
async function removeDemo() {
  await cleanupSeeded();   // devices, pairing codes, and the org's whole catalog (purgeSignedUpOrgs)
  const id = demoUserId ?? (await userIdByEmail(DEMO_EMAIL));
  if (id) await deleteUserCascade(id);
  if (inviteCode) await getDb().delete(invites).where(eq(invites.code, inviteCode));
}

test.beforeAll(async () => {
  for (const f of UPLOADS) {
    if (!existsSync(path.join(ARCHIVE, f))) throw new Error(`${ARCHIVE}/${f} is missing -- symlink adf-archive from the main checkout`);
  }
  // A previous capture that died before its afterAll. The address is
  // @example.test, so this is inside the suite's own safety boundary.
  const leftover = await userIdByEmail(DEMO_EMAIL);
  if (leftover) {
    if (!DEMO_EMAIL.endsWith('@example.test')) throw new Error('refusing to delete a non-test account');
    await deleteUserCascade(leftover);
  }
  mkdirSync(OUT, { recursive: true });
});

test.afterAll(async () => {
  await removeDemo();
  const still = await userIdByEmail(DEMO_EMAIL);
  console.log(`screenshots: demo user ${demoUserId ?? '(none)'} ${still ? 'STILL PRESENT' : 'removed'}`);
});

function squeeze(file: string) {
  try {
    execFileSync('magick', [file, '-strip', '-dither', 'None', '-colors', '256', `PNG8:${file}`]);
  } catch {
    // No ImageMagick: keep the plain PNG.
  }
  console.log(`screenshots: ${file} ${Math.round(statSync(file).size / 1024)} KB`);
}

/**
 * `tall` grows the window to the page's height instead of using fullPage: the
 * app's background is fixed to the viewport, so a fullPage shot ends in a band
 * of bare white.
 */
async function shoot(page: Page, name: string, opts: { tall?: boolean } = {}) {
  // Let covers decode and toasts fade before the picture is taken.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null)))));
  // The dev server's floating Next.js badge is not part of the app.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  const before = page.viewportSize();
  if (opts.tall && before) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: before.width, height: Math.max(before.height, height) });
  }
  await page.waitForTimeout(800);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  if (opts.tall && before) await page.setViewportSize(before);
  squeeze(file);
}

async function gameIdByTitle(orgId: string, like: string): Promise<string> {
  const r = await getDb().select({ id: games.id }).from(games)
    .where(and(eq(games.orgId, orgId), sql`${games.title} ilike ${like}`));
  if (!r[0]) throw new Error(`no title like ${like}`);
  return r[0].id;
}

test('capture the README screenshots', async ({ page, request, browser }) => {
  // --- the demo account ----------------------------------------------------
  inviteCode = await mintInviteCode();
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByLabel('Invite code').fill(inviteCode);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/library/, { timeout: 30_000 });
  const orgId = (await page.getByTestId('active-org').textContent()) ?? '';
  expect(orgId).not.toBe('');
  signedUpOrgIds.push(orgId);   // so cleanupSeeded purges this org's catalog
  demoUserId = await userIdByEmail(DEMO_EMAIL);
  console.log(`screenshots: demo user ${demoUserId}, org ${orgId}`);

  // --- upload through the real ingest page ----------------------------------
  await page.goto('/ingest');
  await stagingReady(page);
  await page.getByTestId('file-input').setInputFiles(UPLOADS.map((f) => path.join(ARCHIVE, f)));
  await expect(libRows(page)).toHaveCount(UPLOADS.length, { timeout: 30_000 });
  await expect(page.locator('[data-testid="staging-row"][data-kind="lib"][data-state="done"], [data-testid="staging-row"][data-kind="lib"][data-state="deduped"]'))
    .toHaveCount(UPLOADS.length, { timeout: 120_000 });
  // A two-disk demo is offered as a set; take it, the way a person would.
  const setAccept = page.getByTestId('set-suggestion-accept');
  if (await setAccept.isVisible().catch(() => false)) {
    await setAccept.click();
    await expect(page.getByTestId('set-suggestion')).toHaveCount(0, { timeout: 15_000 });
  }
  // The Upload page itself, at the width the C3 design was drawn for.
  const beforeUpload = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await shoot(page, 'upload');
  if (beforeUpload) await page.setViewportSize(beforeUpload);

  // --- the app's own identification -----------------------------------------
  // Upload ends with an after() sweep (src/lib/ingest-complete.ts) that
  // matches TOSEC and Demozoo. Wait for it to retitle the disks.
  await expect.poll(async () => {
    const r = await getDb().select({ n: sql<number>`count(*)::int` }).from(games)
      .where(and(eq(games.orgId, orgId), sql`${games.metadataSource} <> 'filename'`));
    return r[0].n;
  }, { timeout: 150_000, intervals: [3_000] }).toBeGreaterThanOrEqual(2);

  // Demozoo suggestions are accepted on the review page, as a person would.
  await page.goto('/library');
  const badge = page.getByTestId('demozoo-badge');
  if (await badge.isVisible().catch(() => false)) {
    await badge.click();
    const accept = page.getByTestId('review-accept');
    await expect(accept).toBeVisible();
    if (await accept.isEnabled()) {
      await accept.click();
      await expect(page.getByText(/^Linked \d+ title/)).toBeVisible({ timeout: 30_000 });
    }
  }

  // --- a little history on one disk ----------------------------------------
  const sysInfoGame = await gameIdByTitle(orgId, 'sysinfo%');
  const [sysInfo] = await getDb().select({ id: disks.id }).from(disks).where(eq(disks.gameId, sysInfoGame));
  const folder = await page.request.post(`/api/disks/${sysInfo.id}/files`, { multipart: { parentBlock: '880', name: 'Notes' } });
  expect(folder.status()).toBe(200);
  const note = await page.request.post(`/api/disks/${sysInfo.id}/files`, {
    multipart: {
      parentBlock: '880', name: 'ReadMe',
      file: { name: 'ReadMe', mimeType: 'text/plain', buffer: Buffer.from('Run SysInfo from the Shell.\n') },
    },
  });
  expect(note.status()).toBe(200);

  // --- a board, mounted and reporting ---------------------------------------
  const { deviceId, token } = await pairDevice(page, request);
  // Registration names a board after its MAC; a person renames it.
  const rename = await page.request.patch(`/api/devices/${deviceId}`, { data: { alias: 'A500' } });
  expect(rename.ok()).toBe(true);
  const fingers = await gameIdByTitle(orgId, '9 fingers%');
  const fingerDisks = await getDb().select({ id: disks.id, sha256: disks.sha256, diskNo: disks.diskNo })
    .from(disks).where(inArray(disks.gameId, [fingers])).orderBy(disks.diskNo);
  const mounted = fingerDisks[0];
  const mount = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: mounted.id } });
  expect(mount.status()).toBe(200);
  const { version } = await mount.json();
  // What a running board reports with each poll. Sent again before the
  // Devices pictures, so the card reads Online (seen in the last minute).
  const report = async () => {
    const status = await request.post('/api/device/status', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        mountedSha256: mounted.sha256, mountedDiskId: mounted.id, version,
        firmwareVersion: FIRMWARE, rssi: -58, psramFree: 6_200_000,
        playsHd: true, nfcReader: 'present', displayLayouts: true, displayVersion: 0,
        secondDrive: 'off', driveVersion: 0,
      },
    });
    expect(status.status()).toBe(204);
  };
  await report();

  // --- the pictures ---------------------------------------------------------
  await page.goto('/library');
  await expect(page.getByTestId('game-card').first()).toBeVisible();
  await shoot(page, 'library');

  const phone = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const phonePage = await phone.newPage();
  await phonePage.goto('/library');
  await expect(phonePage.getByTestId('game-card').first()).toBeVisible();
  await shoot(phonePage, 'library-phone');
  await phone.close();

  await page.goto(`/games/${fingers}`);
  await shoot(page, 'game');

  await page.goto(`/disks/${sysInfo.id}/files`);
  await expect(page.getByTestId('history-panel')).toBeVisible();
  await expect(page.getByTestId('disk-card')).toBeVisible();
  await shoot(page, 'disk-files', { tall: true });

  await report();
  await page.goto('/devices');
  await expect(page.getByTestId(`device-oled-${deviceId}`)).toBeVisible();
  await shoot(page, 'devices');

  await page.getByTestId(`display-toggle-${deviceId}`).click();
  await expect(page.getByTestId(`display-drawer-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`display-canvas-${deviceId}`)).toBeVisible();
  await shoot(page, 'display-editor');   // a modal is viewport-fixed: no full-page shot

  await page.goto('/help');
  await shoot(page, 'help');
});
