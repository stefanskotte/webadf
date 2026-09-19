import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

// The 3 s interval plus a request and a re-render. Anything slower is a bug.
const LIVE = { timeout: 5_000 };

/** Browser A signs up; browser B signs in as the same user and never reloads. */
async function twoBrowsers(browser: Browser, pageA: Page) {
  const { email, password, orgId } = await signUpFresh(pageA);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/sign-in');
  await pageB.getByLabel('Email').fill(email);
  await pageB.getByLabel('Password').fill(password);
  await pageB.getByRole('button', { name: 'Sign in' }).click();
  await expect(pageB).toHaveURL(/\/library/, { timeout: 15_000 });
  return { orgId, pageB, closeB: () => ctxB.close() };
}

async function diskFor(orgId: string) {
  const sha = createHash('sha256').update(`live-${runTag()}-${Math.random()}`).digest('hex');
  const { gameId, diskId } = await seedDisk(orgId, { title: `Live ${runTag()}`, diskNo: 1, sha256: sha });
  return { gameId, diskId, sha };
}

test('a mount made in one browser, and the board converging, show in another without a reload',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    const { deviceId, token } = await pairDevice(page, request);
    const { diskId, sha } = await diskFor(orgId);
    await pageB.goto('/devices');
    const card = pageB.getByTestId(`device-${deviceId}`);
    await expect(card).toHaveAttribute('data-state', 'empty');

    const mounted = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
    expect(mounted.status()).toBe(200);
    const { version } = await mounted.json();
    // A never-polled device has lastSeenAt = null, which reads as 'stale' (never
    // seen), not 'pending'. A real board polls roughly every 25 s; here a single
    // poll -- since=0 is already behind the version the mount just produced, so
    // it returns immediately rather than holding -- establishes it as seen,
    // exactly as e.g. device-protocol.spec.ts's "establish it saw the mount" does.
    await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
    await expect(card).toHaveAttribute('data-state', 'pending', LIVE);

    expect((await request.post('/api/device/status', {
      headers: authHeader(token), data: { mountedSha256: sha, mountedDiskId: diskId, version },
    })).status()).toBe(204);
    await expect(card).toHaveAttribute('data-state', 'converged', LIVE);
    await closeB();
  });

test('write-protect changed in one browser shows in another without a reload',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    const { deviceId } = await pairDevice(page, request);
    const { gameId, diskId } = await diskFor(orgId);
    // Watched only for a disk a device has asked for (spec §6).
    expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).status()).toBe(200);
    await pageB.goto(`/games/${gameId}`);
    const toggle = pageB.getByTestId(`wp-${diskId}`);
    await expect(toggle).toHaveAttribute('data-protected', 'true');

    expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);
    await expect(toggle).toHaveAttribute('data-protected', 'false', LIVE);
    await closeB();
  });

test('an idle page polls the fingerprint and never re-renders', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request);
  await page.goto('/devices');
  let polls = 0, rsc = 0;
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/live-state')) polls++;
    if (url.includes('_rsc=') || r.headers()['rsc'] === '1') rsc++;
  });
  await page.waitForTimeout(10_000);
  expect(polls).toBeGreaterThanOrEqual(2);
  expect(rsc).toBe(0);
});
