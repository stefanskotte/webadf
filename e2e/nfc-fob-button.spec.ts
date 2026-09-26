import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(`fob-${s}`).digest('hex');

// The fob button (write a disk to an NFC tag from the web). The board is
// simulated through the REAL device endpoints, the way nfc-tap.spec.ts
// drives them: /api/device/status to report the reader, /api/device/poll to
// receive the request, /api/device/tap-write to answer it.
test.afterAll(cleanupSeeded);

async function reportReader(request: APIRequestContext, token: string, state: 'present' | 'absent') {
  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, nfcReader: state },
  });
  expect(res.status()).toBe(204);
}

/** One board poll behind on nfcAck: the request (or its disarm) comes back at once. */
async function boardPoll(request: APIRequestContext, token: string) {
  const res = await request.get('/api/device/poll?nfcAck=0', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  return (await res.json()).nfcWrite as { seq: number; diskId: string | null; title?: string } | undefined;
}

async function readerOrg(page: Page, request: APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await reportReader(request, token, 'present');
  // Registration names the board after its MAC, not the pairing name.
  const [{ name }] = await getDb().select({ name: devices.name }).from(devices).where(eq(devices.id, deviceId));
  return { orgId, deviceId, token, deviceName: name };
}

test('a single-disk card writes its disk, and the dialog shows the tag', async ({ page, request }) => {
  const { orgId, token, deviceName } = await readerOrg(page, request);
  const title = `Fob Single ${runTag()}`;
  const { gameId, diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(runTag()) });

  await page.goto('/library');
  await page.getByTestId(`fob-${gameId}`).click();
  const dialog = page.getByTestId('fob-dialog');
  await expect(dialog.getByTestId('fob-waiting')).toHaveText(
    `Tap a tag on ${deviceName} (lift any tag already on the reader first)`);
  await expect(dialog.getByTestId('fob-countdown')).toHaveText(/^[12]:\d\d$/);
  // Still on the library: the click did not fall through to the card's link.
  await expect(page).toHaveURL(/\/library/);

  const req = await boardPoll(request, token);
  expect(req?.diskId).toBe(diskId);
  expect(req?.title).toBe(title);

  const write = await request.post('/api/device/tap-write', {
    headers: authHeader(token), data: { seq: req!.seq, ok: true, uid: '2419B601' },
  });
  expect(await write.json()).toEqual({ stored: true });

  await expect(dialog.getByTestId('fob-result')).toHaveText('Tag written ✓ (24 19 B6 01)');
  await dialog.getByTestId('fob-close').click();
  await expect(dialog).toHaveCount(0);
});

test('Cancel withdraws the request, and the board is told to disarm', async ({ page, request }) => {
  const { orgId, token } = await readerOrg(page, request);
  const { gameId } = await seedDisk(orgId, { title: `Fob Cancel ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  await page.goto('/library');
  await page.getByTestId(`fob-${gameId}`).click();
  await expect(page.getByTestId('fob-waiting')).toBeVisible();

  const cancelled = page.waitForResponse((r) => r.url().includes('/api/nfc/write') && r.request().method() === 'DELETE');
  await page.getByTestId('fob-cancel').click();
  expect((await cancelled).status()).toBe(204);
  await expect(page.getByTestId('fob-dialog')).toHaveCount(0);

  const req = await boardPoll(request, token);
  expect(req).toBeDefined();
  expect(req!.diskId).toBeNull();
});

test('leaving the page mid-wait withdraws the request', async ({ page, request }) => {
  const { orgId, token } = await readerOrg(page, request);
  const { gameId } = await seedDisk(orgId, { title: `Fob Leave ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  await page.goto('/library');
  await page.getByTestId(`fob-${gameId}`).click();
  await expect(page.getByTestId('fob-waiting')).toBeVisible();

  // A full navigation runs no React cleanup; pagehide + keepalive carry the cancel.
  await page.goto('/devices');
  await expect.poll(async () => (await boardPoll(request, token))?.diskId, { timeout: 10_000 }).toBeNull();
});

test('a multi-disk set asks which disk, and writes the one chosen', async ({ page, request }) => {
  const { orgId, token } = await readerOrg(page, request);
  const { gameId, diskId: disk1 } = await seedDisk(orgId, { title: `Fob Set ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  const { diskId: disk2 } = await addDisk(orgId, gameId, { diskNo: 2, sha256: sha(runTag()) });

  await page.goto('/library');
  await page.getByTestId(`fob-${gameId}`).click();
  const dialog = page.getByTestId('fob-dialog');
  await expect(dialog.getByTestId(`fob-disk-${disk1}`)).toHaveText('Disk 1');
  await expect(dialog.getByTestId(`fob-disk-${disk2}`)).toHaveText('Disk 2');
  // Nothing is armed until a disk is chosen.
  await expect(dialog.getByTestId('fob-start')).toBeDisabled();
  await dialog.getByTestId(`fob-disk-${disk2}`).click();
  await dialog.getByTestId('fob-start').click();
  await expect(dialog.getByTestId('fob-waiting')).toBeVisible();

  const req = await boardPoll(request, token);
  expect(req?.diskId).toBe(disk2);

  // Escape closes and withdraws, like Cancel.
  const cancelled = page.waitForResponse((r) => r.url().includes('/api/nfc/write') && r.request().method() === 'DELETE');
  await page.keyboard.press('Escape');
  expect((await cancelled).status()).toBe(204);
  expect((await boardPoll(request, token))?.diskId).toBeNull();

  // The title page offers the same button on each disk row.
  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId(`fob-${disk1}`)).toBeVisible();
  await expect(page.getByTestId(`fob-${disk2}`)).toBeVisible();
});

test('a newer request replaces the dialog\'s own', async ({ page, request }) => {
  const { orgId, deviceId, token } = await readerOrg(page, request);
  const { gameId, diskId } = await seedDisk(orgId, { title: `Fob Replaced ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  await page.goto('/library');
  await page.getByTestId(`fob-${gameId}`).click();
  await expect(page.getByTestId('fob-waiting')).toBeVisible();

  // Another tab (or the CLI) arms the same board.
  const again = await page.request.post('/api/nfc/write', { data: { diskId, deviceId } });
  expect(again.status()).toBe(200);
  await expect(page.getByTestId('fob-result')).toHaveText('Replaced by another write request.');

  // Closing the replaced dialog must not disarm the NEWER request.
  await page.getByTestId('fob-close').click();
  expect((await boardPoll(request, token))?.diskId).toBe(diskId);
  await page.request.delete('/api/nfc/write', { data: { deviceId, seq: (await again.json()).seq } });
});

test('without a reader present there is no button', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  await reportReader(request, token, 'absent');
  const { gameId, diskId } = await seedDisk(orgId, { title: `Fob None ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  await page.goto('/library');
  await expect(page.getByTestId('game-card')).toHaveCount(1);
  await expect(page.getByTestId(`history-${gameId}`)).toBeVisible();
  await expect(page.getByTestId(`fob-${gameId}`)).toHaveCount(0);

  await page.goto(`/games/${gameId}`);
  await expect(page.getByTestId(`download-${diskId}`)).toBeVisible();
  await expect(page.getByTestId(`fob-${diskId}`)).toHaveCount(0);
});

test('at 390px the dialog fits the screen', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { orgId } = await readerOrg(page, request);
  // A long title and board name are what would push it wider.
  const title = `Fob Phone ${runTag()} ${'Extraordinarily-long-title-'.repeat(3)}`;
  const { gameId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(runTag()) });

  await page.goto('/library');
  await page.getByTestId(`fob-${gameId}`).click();
  const dialog = page.getByTestId('fob-dialog');
  await expect(dialog.getByTestId('fob-waiting')).toBeVisible();

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByTestId('fob-cancel').click();
  await expect(dialog).toHaveCount(0);
});
