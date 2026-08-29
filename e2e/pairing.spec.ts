import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

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
  const { token, deviceId } = await reg.json();
  expect(token).toMatch(/^wadf_/);
  expect(deviceId).toBeTruthy();

  // Same code again must fail.
  const again = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:FF' },
  });
  expect(again.status()).toBe(400);
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
