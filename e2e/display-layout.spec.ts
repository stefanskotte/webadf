import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { decodeLayout } from '@/lib/display-layout';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

/** A board that speaks the display protocol (firmware 1.7.0+) reports it in its status. */
async function reportStatus(
  request: APIRequestContext, token: string, extra: Record<string, unknown>,
) {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, ...extra },
  });
  expect(res.status()).toBe(204);
}

async function openEditor(page: Page, deviceId: string) {
  await page.goto('/devices');
  await page.getByTestId(`display-toggle-${deviceId}`).click();
}

test('a board without display support is told it needs firmware 1.7.0', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, {});   // an old board: no displayLayouts

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-needs-fw-${deviceId}`)).toHaveText('Needs firmware 1.7.1 or newer');
  await expect(page.getByTestId(`display-canvas-${deviceId}`)).toHaveCount(0);
});

test('a layout saved from the editor reaches the board, which reports it applied', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0 });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Applied on the board');
  await page.getByTestId(`display-panel-${deviceId}`).selectOption('128x64');

  // Grab the default 128x64 title (x 0..128, y 12..28 at 2x) and drag it 8 panel pixels down.
  const canvas = page.getByTestId(`display-canvas-${deviceId}`);
  const box = (await canvas.boundingBox())!;
  const px = (v: number) => (v * box.width) / 128;
  const py = (v: number) => (v * box.height) / 64;
  await page.mouse.move(box.x + px(60), box.y + py(20));
  await page.mouse.down();
  await page.mouse.move(box.x + px(60), box.y + py(24), { steps: 4 });
  await page.mouse.move(box.x + px(60), box.y + py(28), { steps: 4 });
  await page.mouse.up();

  await expect(page.getByTestId(`display-save-${deviceId}`)).toBeEnabled();
  await page.getByTestId(`display-save-${deviceId}`).click();
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Waiting for the board');

  const row = await deviceRow(deviceId);
  expect(row.displayVersion).toBe(1);
  expect(row.displayPanel).toBe('128x64');

  // The board fetches it: [u32 BE version][u8 panel][u8 has_layout][blob].
  const get = await request.get('/api/device/display', { headers: authHeader(token) });
  expect(get.status()).toBe(200);
  const body = Buffer.from(await get.body());
  expect(body.readUInt32BE(0)).toBe(1);
  expect(body[4]).toBe(1);      // 128x64
  expect(body[5]).toBe(1);      // a layout follows
  // The drag landed: the title moved from y 12 to y 20.
  const title = decodeLayout(new Uint8Array(body.subarray(6))).elements.find((e) => e.id === 'title')!;
  expect(title.y).toBe(20);

  // The board applies it and acks the version.
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 1 });
  await page.reload();
  await page.getByTestId(`display-toggle-${deviceId}`).click();
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Applied on the board');
});

test('a layout the board rejects shows the board\'s reason', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0 });
  const res = await page.request.patch(`/api/devices/${deviceId}/display`, { data: { reset: true, panel: '128x64' } });
  expect(res.status()).toBe(200);

  await reportStatus(request, token, { displayLayouts: true, displayVersion: 1, displayError: 'outside the panel' });
  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('The board rejected it: outside the panel');
});

test('an invalid layout is named in the editor, cannot be saved, and the server refuses it too', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0 });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-save-${deviceId}`)).toBeEnabled();
  await page.getByTestId('display-width-title').fill('8');

  await expect(page.getByTestId(`display-reason-${deviceId}`)).toContainText('title: width must be at least 12');
  await expect(page.getByTestId(`display-save-${deviceId}`)).toBeDisabled();

  const bad = JSON.parse(readFileSync(
    path.join(process.cwd(), 'wifi-floppy/firmware/test/fixtures/layouts/bad_bounds.json'), 'utf8'));
  const res = await page.request.patch(`/api/devices/${deviceId}/display`, { data: bad });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe('invalid_layout');
  expect((await deviceRow(deviceId)).displayVersion).toBe(0);
});

test('the poll wakes for a display version above the board\'s ack, and only then', async ({ page, request }) => {
  test.setTimeout(75_000);
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0 });
  for (let i = 0; i < 2; i++) {
    const r = await page.request.patch(`/api/devices/${deviceId}/display`, { data: { reset: true, panel: '128x32' } });
    expect(r.status()).toBe(200);
  }

  const t0 = Date.now();
  const woken = await request.get('/api/device/poll?since=0&nfcAck=0&displayAck=0', {
    headers: authHeader(token), timeout: 45_000,
  });
  expect(woken.status()).toBe(200);
  expect(Date.now() - t0).toBeLessThan(10_000);
  const j = await woken.json();
  expect(j.displayVersion).toBe(2);

  // Caught up: nothing wakes it, so the poll holds and ends in a 204. The hold
  // has no test hook (device-poll.spec.ts waits it out the same way).
  const since = typeof j.version === 'number' ? j.version : 0;
  const held = await request.get(`/api/device/poll?since=${since}&nfcAck=0&displayAck=2`, {
    headers: authHeader(token), timeout: 45_000,
  });
  expect(held.status()).toBe(204);
});
