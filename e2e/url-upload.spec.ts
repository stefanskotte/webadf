import { test, expect } from '@playwright/test';
import { signUpFresh, trayRows, libraryAddReady } from './helpers';
import { cleanupSeeded } from './device-helpers';

// Upload from a URL (POST /api/ingest/url; the URL field is in the Library's Add disks ▾ → Paste a URL… dialog since
// Files increment 3).
//
// NO PUBLIC INTERNET. The route's whole point is that it refuses to fetch
// from anything but a public address, so the app's own test server
// (localhost:$PORT, 3000 or 3100) is exactly what it must refuse -- and every refusal below
// is decided before any socket is opened (URL text, IP literal, or the
// `localhost` name), so none of them needs DNS or a network.
//
// The happy path needs a real public file and is therefore opt-in: set
// E2E_URL_UPLOAD_FIXTURE to the https URL of a small ADF (or a .zip of
// ADFs) that you control. Without it the test is skipped with that reason,
// so CI never reaches out to the internet. The fetch/sniff/ingest pipeline
// is covered offline by src/lib/url-fetch.test.ts and url-ingest.test.ts.
//
// Rate limit: 6 fetches a minute per user. Every test signs up its own user,
// and none makes more than 7 calls (the 7th proving the 429).

test.afterAll(cleanupSeeded);

const PATH = '/api/ingest/url';

test('an anonymous caller is redirected to sign-in and nothing is fetched', async ({ request }) => {
  const res = await request.post(PATH, { data: { url: 'https://example.com/a.adf' }, maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toContain('/sign-in');
});

test('refuses non-public and malformed targets with a code only, then rate-limits', async ({ page }) => {
  await signUpFresh(page);

  const cases: [string, number, string][] = [
    ['ftp://example.com/a.adf', 400, 'unsupported_scheme'],
    ['https://user:pw@example.com/a.adf', 400, 'credentials_not_allowed'],
    ['http://localhost/a.adf', 400, 'address_not_allowed'],
    ['http://127.0.0.1/a.adf', 400, 'address_not_allowed'],
    ['http://169.254.169.254/latest/meta-data/', 400, 'address_not_allowed'],
    ['http://[::ffff:127.0.0.1]/a.adf', 400, 'address_not_allowed'],
  ];
  for (const [url, status, code] of cases) {
    const res = await page.request.post(PATH, { data: { url } });
    expect(res.status(), url).toBe(status);
    // The code and nothing else: no upstream text, no resolved address.
    expect(await res.json(), url).toEqual({ error: code });
  }

  // Six attempts this minute -- refused ones count too.
  const limited = await page.request.post(PATH, { data: { url: 'http://10.0.0.1/a.adf' } });
  expect(limited.status()).toBe(429);
  expect((await limited.json()).error).toBe('rate_limited');
  expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
});

/** The Library's Add disks ▾ → Paste a URL… dialog, open. */
async function openUrlDialog(page: import('@playwright/test').Page) {
  await page.goto('/library');
  await libraryAddReady(page);
  await page.getByTestId('library-add-disks').click();
  await page.getByTestId('library-add-url').click();
  const dialog = page.getByTestId('library-add-url-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test("refuses the app's own server (port and loopback) from the Library's Paste a URL…", async ({ page, baseURL }) => {
  await signUpFresh(page);
  const dialog = await openUrlDialog(page);

  const field = dialog.getByLabel('Or fetch from a URL');
  await expect(field).toBeVisible();
  await expect(dialog.getByTestId('url-fetch')).toBeDisabled();

  // baseURL is http://localhost:$PORT -- a non-standard port on loopback.
  await field.fill(`${baseURL}/api/health`);
  await dialog.getByTestId('url-fetch').click();
  await expect(dialog.getByTestId('url-status')).toHaveText(/standard web ports/);

  await field.fill('http://localhost/disk.adf');
  await dialog.getByTestId('url-fetch').click();
  await expect(dialog.getByTestId('url-status')).toHaveText(/private or local network/);

  // A refused fetch adds no rows: there is no tray at all.
  await expect(trayRows(page)).toHaveCount(0);
  await expect(page.getByTestId('library-tray')).toHaveCount(0);
});

test('the URL field and Fetch button fit a 390 px screen', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openUrlDialog(page);

  const button = dialog.getByTestId('url-fetch');
  await expect(button).toBeInViewport();
  const box = await button.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.height).toBeGreaterThanOrEqual(44); // a thumb-sized tap target below sm
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('fetches a public disk image and lists it like a dropped file', async ({ page }) => {
  const fixture = process.env.E2E_URL_UPLOAD_FIXTURE;
  test.skip(!fixture, 'needs E2E_URL_UPLOAD_FIXTURE (a public https URL of an ADF you control); the suite never fetches the public internet by default');

  await signUpFresh(page);
  const dialog = await openUrlDialog(page);
  await dialog.getByLabel('Or fetch from a URL').fill(fixture!);
  await dialog.getByTestId('url-fetch').click();

  await expect(dialog.getByTestId('url-status')).toHaveText(/Fetched: [1-9]/, { timeout: 60_000 });
  // A fixture somebody else already uploaded comes back deduped: both are success.
  await expect(trayRows(page).first()).toHaveAttribute('data-state', /^(done|deduped)$/);
});
