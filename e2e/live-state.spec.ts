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
    try {
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
    } finally {
      await closeB();
    }
  });

test('write-protect changed in one browser shows in another without a reload',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    try {
      const { deviceId } = await pairDevice(page, request);
      const { gameId, diskId } = await diskFor(orgId);
      // B loads the game page BEFORE the mount below, while the paired device is
      // still 'empty' (nothing desired yet). That matters: games/[id]/page.tsx
      // also mounts the OLDER, unrelated src/components/devices/live-refresh.tsx
      // with active={anyPending}, which -- unlike the new global poller this spec
      // is proving -- is a blind interval timer with no fingerprint check at all.
      // If B's FIRST render already saw a pending/stale device, that old timer
      // would start ticking on its own and could make this assertion pass for a
      // reason that has nothing to do with the new poller. Loading before the
      // mount keeps that prop false at mount time, so its effect never starts a
      // timer, and nothing but the new global fingerprint poller can be the thing
      // that later refreshes this page. (A follow-up task removes the old
      // component entirely; this ordering is sound whether or not it exists.)
      await pageB.goto(`/games/${gameId}`);
      const toggle = pageB.getByTestId(`wp-${diskId}`);
      await expect(toggle).toHaveAttribute('data-protected', 'true');

      // Watched only for a disk a device has asked for (spec §6).
      expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).status()).toBe(200);

      expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);
      await expect(toggle).toHaveAttribute('data-protected', 'false', LIVE);
    } finally {
      await closeB();
    }
  });

test('the fingerprint poller re-renders on a real change and does nothing while idle', async ({ page, request }) => {
  await signUpFresh(page);
  // This device stays untouched for the whole test -- what makes the idle
  // half of this test idle. It also renders the devices page's first card,
  // which is 'empty' at this, the only browser's, first render, so the
  // older devices/live-refresh.tsx (see the write-protect test above) never
  // starts its own timer and cannot be mistaken for the new poller.
  await pairDevice(page, request);
  await page.goto('/devices');
  let polls = 0, rsc = 0;
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/live-state')) polls++;
    if (url.includes('_rsc=') || r.headers()['rsc'] === '1') rsc++;
  });

  // Prove the rsc detector actually fires before trusting its silence below:
  // an untouched counter proves nothing if it can never go non-zero. Pairing a
  // SECOND device changes this org's fingerprint by exactly one row -- and,
  // deliberately, leaves both devices 'empty' (nothing mounted or desired), so
  // proving the detector cannot itself start the older devices/live-refresh.tsx's
  // blind timer and confound the idle measurement that follows. Within one
  // poll window (LIVE_POLL_MS) the new poller's router.refresh() must show up
  // as a real RSC request.
  await pairDevice(page, request, 'Second Device');
  await expect.poll(() => rsc, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  // Let any requests the refresh itself triggered settle before the clean
  // measurement below, so they cannot be counted as idle-window noise.
  await page.waitForTimeout(1_000);

  // Now measure the idle baseline with a clean slate: nothing changes for
  // 10 s, so the poller must keep polling (>= 2 ticks at a 3 s interval) but
  // never re-render (0 RSC requests) -- the detector just proved it would
  // catch a real change, so this silence is evidence, not an unproven assumption.
  polls = 0; rsc = 0;
  await page.waitForTimeout(10_000);
  expect(polls).toBeGreaterThanOrEqual(2);
  expect(rsc).toBe(0);
});
