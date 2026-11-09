import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { deleteUserCascade } from '@/lib/admin-delete';
import { devices } from '@/db/schema/devices';
import { listReleases } from '@/lib/firmware-releases';
import { buildRegistry } from '@/lib/firmware-state';
import { signUpFresh } from './helpers';
import { cleanupSeeded, hydrated } from './device-helpers';

/**
 * The README Quick start's pairing pictures (2026-11-09), from a fresh @example.test account.
 *
 *   PORT=3100 pnpm screenshots e2e/pairing.shots.ts
 *
 * 1. pair-1-devices-empty  the Devices page with no board: the five steps.
 * 2. pair-2-code           after Get a code: the code written into the steps.
 * 3. pair-3-board-setup    the board's own setup page on a phone, rendered from the firmware's PAGE_FMT in
 *                          wifi-floppy/firmware/src/portal_http.c, so the picture is the page the board serves.
 * 4. pair-4-paired         the board has registered (a request with the code, as the board sends it): Paired.
 *
 * Every shot masks text that reads as an email address. The account and its org are removed afterwards.
 */

const OUT = 'docs/screenshots';
const EMAIL_TEXT = /[^\s@]+@[^\s@]+/;
const BOARD_NAME = 'A500';
/** A made-up MAC, so the setup page's "Board …" line names no real board. */
const DEMO_MAC = '28:CD:C1:0A:1B:2C';

let email: string | null = null;

function squeeze(file: string) {
  try {
    execFileSync('magick', [file, '-strip', '-dither', 'None', '-colors', '256', `PNG8:${file}`]);
  } catch {
    // No ImageMagick: keep the plain PNG.
  }
  console.log(`screenshots: ${file} ${Math.round(statSync(file).size / 1024)} KB`);
}

async function shoot(page: Page, name: string, opts: { tall?: boolean } = {}) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  const before = page.viewportSize();
  if (opts.tall && before) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: before.width, height: Math.max(before.height, height) });
  }
  await page.waitForTimeout(800);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, mask: [page.getByText(EMAIL_TEXT)], maskColor: '#F6F2E9' });
  if (opts.tall && before) await page.setViewportSize(before);
  squeeze(file);
}

/** The board's setup page exactly as the firmware renders it: PAGE_FMT's C string literals, joined and formatted. */
function boardSetupHtml(): string {
  const src = readFileSync('wifi-floppy/firmware/src/portal_http.c', 'utf8');
  const block = src.match(/static const char \*PAGE_FMT =([\s\S]*?);\n/);
  if (!block) throw new Error('PAGE_FMT not found in portal_http.c');
  const joined = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('')
    .replace(/\\r\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const html = joined.slice(joined.indexOf('<!DOCTYPE'));
  // printf: the first %s is the MAC, the second the error block (empty on a first visit); %% is a literal %.
  let n = 0;
  return html.replace(/%s/g, () => (n++ === 0 ? DEMO_MAC : '')).replace(/%%/g, '%');
}

test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

test.afterAll(async () => {
  await cleanupSeeded();
  if (email?.endsWith('@example.test')) {
    const r = await getDb().execute<{ id: string }>(sql`select id from auth."user" where email = ${email}`);
    if (r.rows[0]) await deleteUserCascade(r.rows[0].id);
  }
});

test('pairing pictures for the README Quick start', async ({ page, request, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const signedUp = await signUpFresh(page);
  email = signedUp.email;
  // A real board on the newest release, so its card reads as one does after pairing rather than "unrecognised build".
  const newest = buildRegistry(await listReleases(signedUp.orgId)).latest?.version ?? '1.24.1';

  // 1. No board yet: the steps on the empty page.
  await page.goto('/devices');
  await hydrated(page, 'pair-device');
  await expect(page.getByTestId('pairing-steps')).toBeVisible();
  await shoot(page, 'pair-1-devices-empty', { tall: true });

  // 2. Name the board, get a code: the steps now carry it.
  await page.getByTestId('pair-device').click();
  await page.getByTestId('pair-name').fill(BOARD_NAME);
  const minted = page.waitForResponse((r) => r.url().endsWith('/api/devices/pair') && r.request().method() === 'POST');
  await page.getByTestId('pair-submit').click();
  const { code } = await (await minted).json();
  await expect(page.getByTestId('pairing-panel')).toContainText(code);
  await shoot(page, 'pair-2-code', { tall: true });

  // 3. The board's setup page, on a phone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2, isMobile: true });
  const p = await phone.newPage();
  await p.setContent(boardSetupHtml());
  await p.getByLabel('WiFi network name').fill('HomeNetwork');
  await p.getByLabel('WiFi password').fill('not-a-real-password');
  await p.getByLabel('Pairing code').fill(code);
  const file = path.join(OUT, 'pair-3-board-setup.png');
  await p.screenshot({ path: file, clip: { x: 0, y: 0, width: 390, height: 450 } });
  squeeze(file);
  await phone.close();

  // 4. The board registers with the code (as the firmware does after joining the home Wi-Fi): the page notices.
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: newest, macAddress: DEMO_MAC },
  });
  expect(reg.status()).toBe(200);
  // A real board checks in straight after registering; this one only registers, so mark it heard from now.
  await getDb().update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, (await reg.json()).deviceId));
  await expect(page.getByTestId('pairing-done')).toBeVisible({ timeout: 15_000 });
  // The page refreshes itself to draw the new card: no reload here, or the picture would prove nothing.
  await expect(page.getByText('1 paired', { exact: false })).toBeVisible({ timeout: 15_000 });
  await shoot(page, 'pair-4-paired', { tall: true });
});
