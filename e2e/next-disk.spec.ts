import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, addDisk, authHeader, cleanupSeeded, hydrated } from './device-helpers';

/**
 * Multi-disk "Next disk" (2026-09-28 plan, task 13): the drive menu's Next
 * item and preload line, the Devices card's Next button and preload line,
 * the poll's `next`, a Next-disk-card tap (device API), and the Devices
 * page's "Write a Next-disk card" button/dialog.
 *
 * Driven the same way drive-chips.spec.ts and nfc-fob-button.spec.ts drive a
 * board: real HTTP against the real device endpoints with a device token,
 * never a mock -- and every disk/device this file seeds is cleaned up by
 * cleanupSeeded, exactly like those specs.
 */
test.afterAll(cleanupSeeded);

const sha = (s: string) => createHash('sha256').update(`next-disk-${s}`).digest('hex');

// LiveRefresh's 3 s tick plus a request and a re-render -- same value
// drive-chips.spec.ts uses for exactly the same reason.
const LIVE = { timeout: 8_000 };

async function mountAndConverge(
  page: Page, request: APIRequestContext,
  board: { deviceId: string; token: string }, disk: { diskId: string; sha256: string },
) {
  const res = await page.request.post(`/api/devices/${board.deviceId}/mount`, { data: { diskId: disk.diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(board.token),
    data: { mountedSha256: disk.sha256, mountedDiskId: disk.diskId, version },
  })).status()).toBe(204);
}

async function desiredDiskIdOf(deviceId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: devices.desiredDiskId }).from(devices).where(eq(devices.id, deviceId));
  return row?.id ?? null;
}

const chip = (page: Page, id: string) => page.getByTestId(`drive-chip-${id}`);
const menu = (page: Page, id: string) => page.getByTestId(`drive-chip-menu-${id}`);

test('the drive menu offers Next disk and it advances, then wraps', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const tag = runTag();
  const title = `Next Menu ${tag}`;
  const { gameId, diskId: disk1 } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(`${tag}-1`) });
  const disk2 = await addDisk(orgId, gameId, { diskNo: 2, sha256: sha(`${tag}-2`) });

  await mountAndConverge(page, request, { deviceId, token }, { diskId: disk1, sha256: sha(`${tag}-1`) });

  await page.goto('/library');
  await hydrated(page, `drive-chip-${deviceId}`);
  await chip(page, deviceId).click();
  await expect(menu(page, deviceId)).toBeVisible();
  const nextItem = page.getByTestId(`drive-next-${deviceId}`);
  // C8: the card's words, the count and the wrap in the name (Plan ruling: the name starts with the visible words).
  await expect(nextItem).toHaveText('Next: disk 2');
  await expect(nextItem).toHaveAccessibleName('Next: disk 2 of 2');

  await nextItem.click();
  await expect.poll(() => desiredDiskIdOf(deviceId)).toBe(disk2.diskId);

  // Board reports disk 2: converged, and the still-open panel now offers the WRAP back to disk 1.
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: sha(`${tag}-2`), mountedDiskId: disk2.diskId },
  })).status()).toBe(204);

  await expect(menu(page, deviceId)).toBeVisible();
  await expect(page.getByTestId(`drive-next-${deviceId}`)).toHaveText('Next: disk 1', LIVE);
  await expect(page.getByTestId(`drive-next-${deviceId}`)).toHaveAccessibleName('Next: disk 1 of 2 (wraps)');
});

test('the preload line shows every state', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const tag = runTag();
  const title = `Next Preload ${tag}`;
  const s1 = sha(`${tag}-1`);
  const s2 = sha(`${tag}-2`);
  const { gameId, diskId: disk1 } = await seedDisk(orgId, { title, diskNo: 1, sha256: s1 });
  await addDisk(orgId, gameId, { diskNo: 2, sha256: s2 });

  await mountAndConverge(page, request, { deviceId, token }, { diskId: disk1, sha256: s1 });

  await page.goto('/library');
  await chip(page, deviceId).click();
  await expect(menu(page, deviceId)).toBeVisible();
  const preload = page.getByTestId(`drive-preload-${deviceId}`);
  // No preload reported yet: the line is absent, not empty.
  await expect(preload).toHaveCount(0);

  // The board keeps reporting the same mounted disk throughout -- only
  // `preload` changes -- so the chip stays converged and the Next item stays
  // on screen while the preload line changes under it.
  // A 1.6.0+ board with nothing preloaded: "not preloaded yet", never a
  // "loading" that might stay false forever (final review m7).
  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: s1, mountedDiskId: disk1, preload: null },
  })).status()).toBe(204);
  await expect(preload).toHaveAttribute('data-preload', 'waiting', LIVE);
  await expect(preload).toHaveText('Disk 2 not preloaded yet');

  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: s1, mountedDiskId: disk1, preload: { sha256: s2, state: 'loading' } },
  })).status()).toBe(204);
  await expect(preload).toHaveAttribute('data-preload', 'loading', LIVE);
  await expect(preload).toHaveText('Disk 2 loading…');

  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: s1, mountedDiskId: disk1, preload: { sha256: s2, state: 'ready' } },
  })).status()).toBe(204);
  await expect(preload).toHaveAttribute('data-preload', 'ready', LIVE);
  await expect(preload).toHaveText('Disk 2 ready (instant swap)');
});

test('no Next disk on a single-disk title', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const tag = runTag();
  const s1 = sha(`${tag}-1`);
  const { diskId } = await seedDisk(orgId, { title: `Next Single ${tag}`, diskNo: 1, sha256: s1 });

  await mountAndConverge(page, request, { deviceId, token }, { diskId, sha256: s1 });

  await page.goto('/library');
  await chip(page, deviceId).click();
  await expect(menu(page, deviceId)).toBeVisible();
  await expect(page.getByTestId(`drive-next-${deviceId}`)).toHaveCount(0);
  await expect(page.getByTestId(`drive-preload-${deviceId}`)).toHaveCount(0);
});

test('the device card offers Next and the preload line', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const tag = runTag();
  const s1 = sha(`${tag}-1`);
  const s2 = sha(`${tag}-2`);
  const { gameId, diskId: disk1 } = await seedDisk(orgId, { title: `Next Card ${tag}`, diskNo: 1, sha256: s1 });
  await addDisk(orgId, gameId, { diskNo: 2, sha256: s2 });

  await mountAndConverge(page, request, { deviceId, token }, { diskId: disk1, sha256: s1 });

  await page.goto('/devices');
  const nextBtn = page.getByTestId(`next-disk-${deviceId}`);
  await expect(nextBtn).toHaveText('Next: disk 2');
  await expect(page.getByTestId(`device-preload-${deviceId}`)).toHaveCount(0);

  expect((await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: s1, mountedDiskId: disk1, preload: { sha256: s2, state: 'ready' } },
  })).status()).toBe(204);

  const preload = page.getByTestId(`device-preload-${deviceId}`);
  await expect(preload).toHaveAttribute('data-preload', 'ready', LIVE);
  await expect(preload).toHaveText('Disk 2 ready (instant swap)');
});

test('the poll carries next', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const tag = runTag();
  const s1 = sha(`${tag}-1`);
  const s2 = sha(`${tag}-2`);
  const { gameId, diskId: disk1 } = await seedDisk(orgId, { title: `Next Poll ${tag}`, diskNo: 1, sha256: s1 });
  const disk2 = await addDisk(orgId, gameId, { diskNo: 2, sha256: s2 });

  await mountAndConverge(page, request, { deviceId, token }, { diskId: disk1, sha256: s1 });

  const poll = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll.next).toBeDefined();
  expect(poll.next.sha256).toBe(s2);
  expect(poll.next.diskNo).toBe(2);
  expect(poll.next.diskId).toBe(disk2.diskId);
});

test('a Next-card tap advances (device API)', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const tag = runTag();
  const s1 = sha(`${tag}-1`);
  const s2 = sha(`${tag}-2`);
  const { gameId, diskId: disk1 } = await seedDisk(orgId, { title: `Next Tap ${tag}`, diskNo: 1, sha256: s1 });
  const disk2 = await addDisk(orgId, gameId, { diskNo: 2, sha256: s2 });

  await mountAndConverge(page, request, { deviceId, token }, { diskId: disk1, sha256: s1 });

  const res = await request.post('/api/device/tap', {
    headers: authHeader(token), data: { action: 'next' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.outcome).toBe('mounting');
  expect(body.diskNo).toBe(2);
  expect(body.diskCount).toBe(2);

  await expect.poll(() => desiredDiskIdOf(deviceId)).toBe(disk2.diskId);
});

test('a Next-card write button appears, arms the board, Cancel disarms, and an ordinary write after carries no "next" kind',
  async ({ page, request }) => {
    const { orgId } = await signUpFresh(page);
    const { deviceId, token } = await pairDevice(page, request);
    const tag = runTag();
    const s1 = sha(`${tag}-1`);
    const { diskId } = await seedDisk(orgId, { title: `Next Write Card ${tag}`, diskNo: 1, sha256: s1 });

    // `preload: null` is what a 1.6.0+ board reports with nothing preloaded;
    // only such a board can write a Next-disk card (an older one never
    // reports the field, and gets no button -- final review I2).
    expect((await request.post('/api/device/status', {
      headers: authHeader(token), data: { mountedSha256: null, nfcReader: 'present', preload: null },
    })).status()).toBe(204);

    await page.goto('/devices');
    const trigger = page.getByTestId('write-next-card');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByTestId('fob-dialog');
    await expect(dialog.getByTestId('fob-countdown')).toHaveText(/^[12]:\d\d$/);

    const armed = await (await request.get('/api/device/poll?since=0&nfcAck=0', { headers: authHeader(token) })).json();
    expect(armed.nfcWrite.kind).toBe('next');
    expect(armed.nfcWrite.diskId).toBeNull();

    const cancelled = page.waitForResponse((r) => r.url().includes('/api/nfc/write') && r.request().method() === 'DELETE');
    await dialog.getByTestId('fob-cancel').click();
    expect((await cancelled).status()).toBe(204);
    await expect(dialog).toHaveCount(0);

    // The disarm from Cancel: the board's cursor is behind the disarm's own
    // (bumped) seq, so the poll wakes at once and carries no `kind` -- the
    // controller ruling this test exists to prove (Review Focus 3).
    const afterCancel = await (await request.get(
      `/api/device/poll?since=0&nfcAck=${armed.nfcWrite.seq}`, { headers: authHeader(token) },
    )).json();
    expect(afterCancel.nfcWrite).toBeDefined();
    expect(afterCancel.nfcWrite.diskId).toBeNull();
    expect(afterCancel.nfcWrite.kind).toBeUndefined();

    // Now arm an ORDINARY disk write through the API, from the logged-in
    // page's own request context -- not the Next-disk card. The following
    // poll must carry that disk's id and, again, no `kind`.
    const write = await page.request.post('/api/nfc/write', { data: { diskId, deviceId } });
    expect(write.status()).toBe(200);
    const { seq: writeSeq } = await write.json();

    const afterWrite = await (await request.get(
      `/api/device/poll?since=0&nfcAck=${afterCancel.nfcWrite.seq}`, { headers: authHeader(token) },
    )).json();
    expect(afterWrite.nfcWrite).toBeDefined();
    expect(afterWrite.nfcWrite.seq).toBe(writeSeq);
    expect(afterWrite.nfcWrite.diskId).toBe(diskId);
    expect(afterWrite.nfcWrite.kind).toBeUndefined();

    // Tidy up: withdraw the ordinary write so it does not sit armed for the
    // rest of the run.
    await page.request.delete('/api/nfc/write', { data: { deviceId, seq: writeSeq } });
  });
