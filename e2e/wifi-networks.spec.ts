import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded, openBoardSettings } from './device-helpers';

/**
 * Board settings > Wi-Fi networks (2026-11-15, src/lib/wifi-networks.ts). A fake board speaks the firmware's wire
 * (wifi_ctl.h): the `wifi` status tail, ?wifiAck= on the poll, GET /api/device/wifi for the instruction.
 */
test.afterAll(cleanupSeeded);

const HOME = '486f6d65';         // Home
const PHONE = '50686f6e65';      // Phone
const FW = '1.26.0+ge2e';
const row = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];

test('lists the networks, removes one through the board, and opens the setup page with its steps', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Wifi');
  const report = (wifi: object | undefined) => request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: FW, ...(wifi ? { wifi } : {}) },
  });
  expect((await report({ nets: [HOME, PHONE], cur: 0, ack: 0, res: null, setup: 0 })).status()).toBe(204);

  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  const sec = page.getByTestId(`wifi-${deviceId}`);
  await expect(sec).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId(`wifi-net-state-${deviceId}-${HOME}`)).toHaveText('Connected now');
  await expect(page.getByTestId(`wifi-net-state-${deviceId}-${PHONE}`)).toHaveText('Saved');
  await expect(page.getByTestId(`wifi-remove-${deviceId}-${HOME}`)).toHaveCount(0);   // the network in use stays
  await expect(page.getByTestId(`wifi-setup-${deviceId}`)).toHaveText('Setup page: closed');

  // A report without the tail from the same build changes nothing (it rides only when it changed).
  expect((await report(undefined)).status()).toBe(204);
  expect((await row(deviceId)).wifiNets).toEqual([HOME, PHONE]);

  // Remove Phone: a request; the board picks it up through the poll and the instruction fetch, and acks it.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/wifi`) && r.status() === 200),
    page.getByTestId(`wifi-remove-${deviceId}-${PHONE}`).click(),
  ]);
  await expect(page.getByTestId(`wifi-pending-${deviceId}`)).toBeVisible();
  const poll = await request.get('/api/device/poll?since=0&wifiAck=0', { headers: authHeader(token) });
  const seq = (await poll.json()).wifi.v as number;
  expect(seq).toBe(1);
  const cmd = await (await request.get('/api/device/wifi', { headers: authHeader(token) })).json();
  expect(cmd).toEqual({ seq: 1, op: 'remove', ssid: PHONE });
  expect((await report({ nets: [HOME], cur: 0, ack: 1, res: 'ok', setup: 0 })).status()).toBe(204);
  // The instruction is not repeated once heard (a board that restarted acks it as none).
  expect(await (await request.get('/api/device/wifi', { headers: authHeader(token) })).json()).toEqual({ seq: 1, op: 'none' });
  await page.reload();
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`wifi-outcome-${deviceId}`)).toHaveText('Removed “Phone”.');
  await expect(page.getByTestId(`wifi-net-${deviceId}-${PHONE}`)).toHaveCount(0);

  // Add a network: the board opens its setup page; the section shows until when, the steps, and Close.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/wifi`) && r.status() === 200),
    page.getByTestId(`wifi-add-${deviceId}`).click(),
  ]);
  expect(await (await request.get('/api/device/wifi', { headers: authHeader(token) })).json()).toEqual({ seq: 2, op: 'open' });
  expect((await report({ nets: [HOME], cur: 0, ack: 2, res: 'ok', setup: 600 })).status()).toBe(204);
  await page.reload();
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`wifi-setup-${deviceId}`)).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId(`wifi-setup-${deviceId}`)).toContainText('Setup page: open until');
  const steps = page.getByTestId(`wifi-steps-${deviceId}`);
  await expect(steps).toContainText('(password wififloppy)');
  await expect(steps).toContainText('http://192.168.4.1');
  await expect(steps).toContainText('goes back to “Home”');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/devices/${deviceId}/wifi`) && r.status() === 200),
    page.getByTestId(`wifi-close-${deviceId}`).click(),
  ]);
  expect((await row(deviceId)).wifiOp).toBe('close');

  // Server-side guards: the network in use and the last one cannot go; a password is never taken.
  const refused = await page.request.post(`/api/devices/${deviceId}/wifi`, { data: { action: 'remove', ssid: HOME } });
  expect(refused.status()).toBe(409);
  expect((await page.request.post(`/api/devices/${deviceId}/wifi`, { data: { action: 'open', pass: 'x' } })).status()).toBe(200);
});

test('a board whose firmware does not report its networks: one line, no controls', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Old');
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: '1.24.2+gold' },
  })).status()).toBe(204);
  await page.goto('/devices');
  await openBoardSettings(page, deviceId);
  await expect(page.getByTestId(`wifi-${deviceId}`)).toHaveAttribute('data-state', 'old_firmware');
  await expect(page.getByTestId(`wifi-unsupported-${deviceId}`)).toContainText('Update the firmware');
  await expect(page.getByTestId(`wifi-add-${deviceId}`)).toHaveCount(0);
  const r = await page.request.post(`/api/devices/${deviceId}/wifi`, { data: { action: 'open' } });
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toBe('firmware_too_old');
  // A board reverted to an older build after reporting: the list goes.
  await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: FW, wifi: { nets: [HOME], cur: 0, ack: 0, res: null, setup: 0 } },
  });
  expect((await row(deviceId)).wifiNets).toEqual([HOME]);
  await request.post('/api/device/status', { headers: authHeader(token), data: { mountedSha256: null, firmwareVersion: '1.24.2+gold' } });
  expect((await row(deviceId)).wifiNets).toBeNull();
});
