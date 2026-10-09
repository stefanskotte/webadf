import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded } from './device-helpers';

// Upload from a URL (POST /api/ingest/url, the URL field on /ingest).
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

test("refuses the app's own server (port and loopback) from the upload page", async ({ page, baseURL }) => {
  await signUpFresh(page);
  await page.goto('/ingest');

  const field = page.getByLabel('Or fetch from a URL');
  await expect(field).toBeVisible();
  await expect(page.getByTestId('url-fetch')).toBeDisabled();

  // baseURL is http://localhost:$PORT -- a non-standard port on loopback.
  await field.fill(`${baseURL}/api/health`);
  await page.getByTestId('url-fetch').click();
  await expect(page.getByTestId('url-status')).toHaveText(/standard web ports/);

  await field.fill('http://localhost/disk.adf');
  await page.getByTestId('url-fetch').click();
  await expect(page.getByTestId('url-status')).toHaveText(/private or local network/);

  // A refused fetch adds no rows.
  await expect(page.getByTestId('ingest-row')).toHaveCount(0);
});

test('the URL field and Fetch button fit a 390 px screen', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ingest');

  const button = page.getByTestId('url-fetch');
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
  await page.goto('/ingest');
  await page.getByLabel('Or fetch from a URL').fill(fixture!);
  await page.getByTestId('url-fetch').click();

  await expect(page.getByTestId('url-status')).toHaveText(/Fetched: [1-9]/, { timeout: 60_000 });
  const row = page.getByTestId('ingest-row').first();
  // A fixture somebody else already uploaded comes back deduped: both are success.
  await expect(row.locator('[data-state="done"], [data-state="deduped"]')).toBeVisible();
});
