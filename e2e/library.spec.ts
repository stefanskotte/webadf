import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh } from './helpers';

test('a brand-new library shows the empty state, not an error', async ({ page }) => {
  await signUpFresh(page);
  await expect(page.getByText('No disks yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add disks' })).toBeVisible();
});

// Same presign -> PUT -> complete round trip as e2e/ingest-api.spec.ts,
// reused rather than reinvented, so the game actually lands in the catalog
// with real disk rows instead of being asserted against an empty library.
async function uploadDisk(page: Page, content: Buffer) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presignRes = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: content.length }] },
  });
  const { uploads } = await presignRes.json();
  const putRes = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  if (!putRes.ok) throw new Error(`test setup: blob PUT failed with ${putRes.status}`);
  return { sha256, sizeBytes: content.length };
}

async function pushGame(page: Page, title: string, diskCount: number) {
  const disksMeta = [];
  for (let i = 0; i < diskCount; i++) {
    disksMeta.push(await uploadDisk(page, Buffer.from(`${title}-disk${i}-${Date.now()}-${Math.random()}`)));
  }
  const files = disksMeta.map((d, i) => ({
    ...d,
    filename: diskCount > 1 ? `${title} (Disk ${i + 1} of ${diskCount}).adf` : `${title}.adf`,
  }));
  const res = await page.request.post('/api/ingest/complete', { data: { files } });
  if (res.status() !== 200) throw new Error(`test setup: /complete failed with ${res.status()}`);
}

test('one org cannot see another org\'s games', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  await signUpFresh(pageA);
  await signUpFresh(pageB);

  // Unique per-run titles so this never collides with the 56 games already
  // sitting in the shared dev database from the Task 9 CLI smoke test.
  const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const titleA = `Isolation Test A ${run}`;
  const titleB = `Isolation Test B ${run}`;

  // Org A gets a real game with two disks; org B gets a real game with one.
  // If the disks<->game join in listGames were ever not org-scoped, org B's
  // single-disk game could pick up org A's extra disk and read "2" instead
  // of "1" -- that's the assertion that actually exercises Finding 1.
  await pushGame(pageA, titleA, 2);
  await pushGame(pageB, titleB, 1);

  await pageA.goto('/library');
  const cardA = pageA.getByTestId('game-card').filter({ hasText: titleA });
  await expect(cardA).toBeVisible();
  await expect(cardA.getByText('2', { exact: true })).toBeVisible();
  await expect(pageA.getByText(titleB)).toHaveCount(0);

  await pageB.goto('/library');
  const cardB = pageB.getByTestId('game-card').filter({ hasText: titleB });
  await expect(cardB).toBeVisible();
  // The count badge only renders when diskCount > 1 (see Cover), so a
  // single-disk game showing no "2"/"3"/etc. badge is itself part of the
  // proof -- a leaking join would surface an extra disk here.
  await expect(cardB.getByText(/^[2-9]$/)).toHaveCount(0);
  await expect(pageB.getByText(titleA)).toHaveCount(0);

  await a.close(); await b.close();
});
