import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { hydrated } from './device-helpers';

test('a device can pair once with a code, and not twice', async ({ page, request }) => {
  await signUpFresh(page);

  const pair = await page.request.post('/api/devices/pair', { data: { name: 'Living Room' } });
  expect(pair.status()).toBe(200);
  const { code } = await pair.json();
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);

  // The device has no session — a bare request context, not the page's.
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:FF' },
  });
  expect(reg.status()).toBe(200);
  const regBody = await reg.json();
  const { token, deviceId } = regBody;
  expect(token).toMatch(/^wadf_/);
  expect(deviceId).toBeTruthy();
  // The name typed at pairing is the board's name (plan 2026-10-17 R8).
  expect(regBody.name).toBe('Living Room');

  // Same code again must fail.
  const again = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:FF' },
  });
  expect(again.status()).toBe(400);
});

test('a code minted without a name gives the board its MAC label, and an over-long name is refused', async ({ page, request }) => {
  await signUpFresh(page);
  const { code } = await (await page.request.post('/api/devices/pair', { data: {} })).json();
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:01' },
  });
  expect((await reg.json()).name).toBe('Device AA:BB:CC:DD:EE:01');
  expect((await page.request.post('/api/devices/pair', { data: { name: 'x'.repeat(81) } })).status()).toBe(400);
});

test('registering with an unknown code fails', async ({ request }) => {
  const res = await request.post('/api/device/register', {
    data: { pairingCode: 'ZZZZZZ', firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:FF' },
  });
  expect(res.status()).toBe(400);
});

test('minting a pairing code requires a session', async ({ request }) => {
  const res = await request.post('/api/devices/pair', { data: { name: 'x' }, maxRedirects: 0 });
  expect(res.status()).toBe(307);
});

test('the Devices page notices a board that used the live code, and says so without a reload', async ({ page, request }) => {
  await signUpFresh(page);
  await page.goto('/devices');
  await hydrated(page, 'pair-device');
  await page.getByTestId('pair-device').click();
  await page.getByTestId('pair-name').fill('Study A500');
  const minted = page.waitForResponse((r) => r.url().endsWith('/api/devices/pair') && r.request().method() === 'POST');
  await page.getByTestId('pair-submit').click();
  const { code } = await (await minted).json();
  // The steps carry the code, so nobody holds a code without knowing where it goes.
  await expect(page.getByTestId('pairing-panel')).toContainText(code);
  await expect(page.getByTestId('pairing-panel')).toContainText('http://192.168.4.1');

  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:02' },
  });
  expect(reg.status()).toBe(200);
  await expect(page.getByTestId('pairing-done')).toHaveText(/Paired: Study A500/, { timeout: 15_000 });
  await expect(page.getByTestId('pairing-code')).toHaveCount(0);
  await expect(page.getByText('1 paired', { exact: false })).toBeVisible({ timeout: 15_000 });
});

test('How pairing works opens the steps even when a board is already paired', async ({ page, request }) => {
  await signUpFresh(page);
  const { code } = await (await page.request.post('/api/devices/pair', { data: {} })).json();
  await request.post('/api/device/register', { data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:03' } });
  await page.goto('/devices');
  await hydrated(page, 'pairing-guide-open');
  await page.getByTestId('pairing-guide-open').click();
  const guide = page.getByTestId('pairing-guide');
  await expect(guide.getByTestId('pairing-steps')).toContainText('Get a pairing code here');
  await expect(guide.getByTestId('pairing-trouble')).toContainText('2.4 GHz');
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
});

test('the pairing status answers only for the caller\'s own codes', async ({ page }) => {
  await signUpFresh(page);
  const { code } = await (await page.request.post('/api/devices/pair', { data: {} })).json();
  expect(await (await page.request.get(`/api/devices/pair?code=${code}`)).json()).toEqual({ state: 'waiting' });
  expect(await (await page.request.get('/api/devices/pair?code=ZZZZZZ')).json()).toEqual({ state: 'unknown' });
});
