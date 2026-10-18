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

test('Cancel throws away unsaved edits and closes the drawer without asking the server', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0 });

  await openEditor(page, deviceId);
  const width = page.getByTestId('display-width-title');
  const before = await width.inputValue();
  await width.fill('100');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  const writes: string[] = [];
  page.on('request', (r) => { if (r.url().includes(`/api/devices/${deviceId}/display`)) writes.push(r.method()); });
  await page.getByTestId(`display-cancel-${deviceId}`).click();

  await expect(page.getByTestId(`display-drawer-${deviceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`display-toggle-${deviceId}`)).toHaveText('▸ Change Display');
  expect(writes).toEqual([]);
  expect((await deviceRow(deviceId)).displayVersion).toBe(0);

  // Reopened, the editor starts from the board's layout again.
  await page.getByTestId(`display-toggle-${deviceId}`).click();
  await expect(page.getByTestId('display-width-title')).toHaveValue(before);
});

// The NFC icon element (firmware 1.10.0). Older firmware refuses any layout
// that lists it, so the editor offers it only to a board reporting 1.10.0+.
test('a 1.10.0 board gets the NFC icon as a hidden element; ticked and saved, the board receives it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, {
    displayLayouts: true, displayVersion: 0, firmwareVersion: '1.10.0+ge2etest', nfcReader: 'absent',
  });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-nfc-needs-fw-${deviceId}`)).toHaveCount(0);
  const nfc = page.getByTestId('display-visible-nfc');
  await expect(nfc).not.toBeChecked();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);   // listing it hidden is not an edit
  await nfc.check();
  await page.getByTestId('display-scale-nfc').selectOption('2');
  await expect(page.getByTestId(`display-save-${deviceId}`)).toBeEnabled();
  await page.getByTestId(`display-save-${deviceId}`).click();
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Waiting for the board');

  const get = await request.get('/api/device/display', { headers: authHeader(token) });
  expect(get.status()).toBe(200);
  const body = Buffer.from(await get.body());
  expect(body[5]).toBe(1);
  const el = decodeLayout(new Uint8Array(body.subarray(6))).elements.find((e) => e.id === 'nfc');
  // 2x at x 100 would run into the write glyph's column but fits the panel: kept at 100, y 0.
  expect(el).toEqual({ id: 'nfc', visible: true, scale: 2, x: 100, y: 0, w: 0, opt: 0 });
});

test('a board before 1.10.0 is not offered the NFC icon, and the server refuses it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0, firmwareVersion: '1.9.3+ge2etest' });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-nfc-needs-fw-${deviceId}`)).toHaveText('nfc — needs firmware 1.10.0 or newer');
  await expect(page.getByTestId('display-visible-nfc')).toHaveCount(0);
  // Saving the rest still works for it: the layout it is sent lists no nfc element.
  await page.getByTestId('display-width-title').fill('100');
  await page.getByTestId(`display-save-${deviceId}`).click();
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Waiting for the board');
  const stored = (await deviceRow(deviceId)).displayLayout!;
  expect(decodeLayout(new Uint8Array(stored)).elements.some((e) => e.id === 'nfc')).toBe(false);

  const withNfc = JSON.parse(readFileSync(
    path.join(process.cwd(), 'wifi-floppy/firmware/test/fixtures/layouts/custom32_nfc.json'), 'utf8'));
  const res = await page.request.patch(`/api/devices/${deviceId}/display`, { data: withNfc });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'The NFC icon needs firmware 1.10.0 or newer' });
  expect((await deviceRow(deviceId)).displayVersion).toBe(1);
});

// The status icon (firmware 1.15.0): the status element drawn as an 8x8 icon
// instead of the word. Older firmware refuses a status opt other than 0, so
// the editor offers the choice only to a board reporting 1.15.0+.
test('a 1.15.0 board can show the status as an icon; saved, the board receives opt 1', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0, firmwareVersion: '1.15.0+ge2etest' });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-status-icon-needs-fw-${deviceId}`)).toHaveCount(0);
  const style = page.getByTestId('display-style-status');
  await expect(style).toHaveValue('0');   // the word, as every default
  await style.selectOption('1');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByTestId(`display-save-${deviceId}`).click();
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Waiting for the board');

  const get = await request.get('/api/device/display', { headers: authHeader(token) });
  expect(get.status()).toBe(200);
  const body = Buffer.from(await get.body());
  const el = decodeLayout(new Uint8Array(body.subarray(6))).elements.find((e) => e.id === 'status');
  expect(el).toEqual({ id: 'status', visible: true, scale: 1, x: 14, y: 0, w: 0, opt: 1 });
});

test('a board before 1.15.0 is not offered the status icon, and the server refuses it', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0, firmwareVersion: '1.14.0+ge2etest' });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-status-icon-needs-fw-${deviceId}`))
    .toHaveText('icon needs firmware 1.15.0 or newer');
  await expect(page.getByTestId('display-style-status')).toHaveCount(0);

  const withIcon = JSON.parse(readFileSync(
    path.join(process.cwd(), 'wifi-floppy/firmware/test/fixtures/layouts/custom32_status_icon.json'), 'utf8'));
  const res = await page.request.patch(`/api/devices/${deviceId}/display`, { data: withIcon });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'The status icon needs firmware 1.15.0 or newer' });
  expect((await deviceRow(deviceId)).displayVersion).toBe(0);
});

// Firmware 1.17.0: the panel turned 180 degrees (a board mounted upside down)
// and the head element, cylinder.side. Both ride in the layout blob, so they
// are stored with the board's display settings and fetched with them.
/** The preview canvas as lit (true) / dark pixels, one per panel pixel. */
async function canvasPixels(page: Page, deviceId: string): Promise<{ w: number; h: number; on: boolean[] }> {
  return page.getByTestId(`display-canvas-${deviceId}`).evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    const zoom = c.width / 128, w = 128, h = c.height / zoom;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const on: boolean[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y * zoom + 1) * c.width + (x * zoom + 1)) * 4;   // inside the zoomed pixel
      on.push(d[i + 3] > 0 && d[i] > 128);
    }
    return { w, h, on };
  });
}

test('a 1.17.0 board can be turned 180 degrees and shown the head; the preview turns, the board receives both, and the turn persists', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0, firmwareVersion: '1.17.0+ge2etest' });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-rotation-needs-fw-${deviceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`display-head-needs-fw-${deviceId}`)).toHaveCount(0);
  const rotation = page.getByTestId(`display-rotation-${deviceId}`);
  await expect(rotation).toHaveValue('0');
  const head = page.getByTestId('display-visible-head');
  await expect(head).not.toBeChecked();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);   // listing it hidden is not an edit

  // The preview turns with the setting: every lit pixel moves to the opposite corner.
  const up = await canvasPixels(page, deviceId);
  expect(up.on.some(Boolean)).toBe(true);
  await rotation.selectOption('180');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await expect.poll(async () => {
    const t = await canvasPixels(page, deviceId);
    return t.on.every((v, i) => v === up.on[up.on.length - 1 - i]);
  }).toBe(true);

  // Dragging on the turned preview moves the element the way it LOOKS: the
  // default title (layout y 8, drawn at screen y 8..24) dragged 4 px down on
  // screen is 4 px UP in the layout.
  const canvas = page.getByTestId(`display-canvas-${deviceId}`);
  const box = (await canvas.boundingBox())!;
  const px = (v: number) => (v * box.width) / 128;
  const py = (v: number) => (v * box.height) / 32;
  await page.mouse.move(box.x + px(60), box.y + py(14));
  await page.mouse.down();
  await page.mouse.move(box.x + px(60), box.y + py(16), { steps: 4 });
  await page.mouse.move(box.x + px(60), box.y + py(18), { steps: 4 });
  await page.mouse.up();

  await head.check();
  await page.getByTestId(`display-save-${deviceId}`).click();
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Waiting for the board');

  const get = await request.get('/api/device/display', { headers: authHeader(token) });
  expect(get.status()).toBe(200);
  const body = Buffer.from(await get.body());
  expect(body[5]).toBe(1);
  const blob = new Uint8Array(body.subarray(6));
  const sent = decodeLayout(blob);
  expect(sent.rotation).toBe(180);
  expect(Array.from(blob.subarray(blob.length - 8))).toEqual([0x80, 0, 0, 0, 0, 2, 0, 0]);   // the rotation record, last
  expect(sent.elements.find((e) => e.id === 'head')).toEqual({ id: 'head', visible: true, scale: 1, x: 104, y: 24, w: 0, opt: 0 });
  expect(sent.elements.find((e) => e.id === 'title')!.y).toBe(4);

  // Persists: a fresh page opens on 180 degrees with the head shown.
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 1, firmwareVersion: '1.17.0+ge2etest' });
  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Applied on the board');
  await expect(page.getByTestId(`display-rotation-${deviceId}`)).toHaveValue('180');
  await expect(page.getByTestId('display-visible-head')).toBeChecked();

  // Reset to default restores the elements and keeps the turn.
  await page.getByTestId(`display-reset-${deviceId}`).click();
  await expect(page.getByTestId(`display-status-${deviceId}`)).toHaveText('Waiting for the board');
  await expect(page.getByTestId(`display-rotation-${deviceId}`)).toHaveValue('180');
  const after = decodeLayout(new Uint8Array((await deviceRow(deviceId)).displayLayout!));
  expect(after.rotation).toBe(180);
  expect(after.elements.find((e) => e.id === 'title')!.y).toBe(8);
  expect(after.elements.some((e) => e.id === 'head')).toBe(false);
});

test('a board before 1.17.0 is offered neither the turn nor the head, and the server refuses both', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportStatus(request, token, { displayLayouts: true, displayVersion: 0, firmwareVersion: '1.16.1+ge2etest' });

  await openEditor(page, deviceId);
  await expect(page.getByTestId(`display-rotation-needs-fw-${deviceId}`)).toHaveText('Rotation needs firmware 1.17.0 or newer');
  await expect(page.getByTestId(`display-rotation-${deviceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`display-head-needs-fw-${deviceId}`)).toHaveText('head — needs firmware 1.17.0 or newer');
  await expect(page.getByTestId('display-visible-head')).toHaveCount(0);

  const turned = JSON.parse(readFileSync(
    path.join(process.cwd(), 'wifi-floppy/firmware/test/fixtures/layouts/custom32_head_rot180.json'), 'utf8'));
  let res = await page.request.patch(`/api/devices/${deviceId}/display`, { data: turned });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Turning the display needs firmware 1.17.0 or newer' });
  res = await page.request.patch(`/api/devices/${deviceId}/display`, { data: { ...turned, rotation: 0 } });
  expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'The head position needs firmware 1.17.0 or newer' });
  expect((await deviceRow(deviceId)).displayVersion).toBe(0);
});
