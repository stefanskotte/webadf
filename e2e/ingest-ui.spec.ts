import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded } from './device-helpers';

// These specs create their rows through the REAL ingest flow, so no helper
// ever learns their ids -- cleanupSeeded reaches them by purging the whole
// catalog of every org signUpFresh made in this file (see purgeSignedUpOrgs).

test.afterAll(cleanupSeeded);

const ADF_BYTES = 901_120;

function fakeAdf(seed: number): Buffer {
  const b = Buffer.alloc(ADF_BYTES);
  b.write(`DOS\0webadf-test-${seed}`, 0);
  return b;
}

test('uploading a disk shows it in the library', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');

  await page.getByTestId('file-input').setInputFiles({
    name: 'Test Game (1992)(Acme)(Disk 1 of 2).adf',
    mimeType: 'application/octet-stream',
    buffer: fakeAdf(Date.now()),
  });

  await expect(page.getByTestId('ingest-row')).toHaveCount(1);
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="done"]'))
    .toBeVisible({ timeout: 30_000 });

  await page.goto('/library');
  // Every game card renders its title twice (once as the cover's text
  // overlay, once as the caption underneath -- see Cover in
  // src/components/library/cover.tsx), so a plain getByText hits Playwright's
  // strict-mode ambiguity. .first() is enough to prove the title landed.
  await expect(page.getByText('Test Game').first()).toBeVisible();
});

test('re-uploading the same bytes dedupes instead of uploading again', async ({ page }) => {
  await signUpFresh(page);
  // Seeded with the current time rather than a fixed constant: blobs are
  // content-addressed and global (never scoped to an org, never reset
  // between local test runs against a real database), so a fixed seed's
  // bytes would already exist from a previous run and the FIRST upload
  // below would come back deduped instead of genuinely new -- defeating
  // the point of this test. A time-based seed keeps every run's content
  // novel while still uploading the identical bytes twice within the run.
  const buffer = fakeAdf(Date.now());

  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles({
    name: 'Dedupe Me (1990)(X).adf', mimeType: 'application/octet-stream', buffer,
  });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="done"]'))
    .toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.getByTestId('file-input').setInputFiles({
    name: 'Dedupe Me (1990)(X).adf', mimeType: 'application/octet-stream', buffer,
  });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="deduped"]'))
    .toBeVisible({ timeout: 30_000 });
});

test('a failed check call marks the row failed, never deduped', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');

  // Reproduces the server's real 400 shape (the check endpoint's Zod schema
  // rejects an oversized/malformed batch with `{ error: ... }`, no
  // `missing` field) without needing 501 real disk images to trigger it.
  // This is the exact failure mode Finding 1 was about: the old
  // `post()` did `return fetch(...).then((r) => r.json())` unconditionally,
  // so `const { missing } = await post(...)` destructured a 400 body to
  // `missing: undefined`, `new Set(undefined)` was empty, and
  // `!missingSet.has(sha256)` was true for every file -- the whole batch
  // silently reported "deduped" even though nothing was ever checked,
  // uploaded, or catalogued. post() now throws on a non-OK response, so
  // the row must land on 'failed', never 'deduped'.
  await page.route('**/api/ingest/check', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated batch rejection' }),
    }),
  );

  await page.getByTestId('file-input').setInputFiles({
    name: 'Should Fail (1993)(Nobody).adf',
    mimeType: 'application/octet-stream',
    buffer: fakeAdf(Date.now()),
  });

  await expect(page.getByTestId('ingest-row').first().locator('[data-state="failed"]'))
    .toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="deduped"]'))
    .toHaveCount(0);
});

test('re-selecting the same file in one session updates the row instead of duplicating it', async ({ page }) => {
  await signUpFresh(page);
  const buffer = fakeAdf(Date.now());

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles({
    name: 'Reselect Me (1990)(X).adf', mimeType: 'application/octet-stream', buffer,
  });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="done"]'))
    .toBeVisible({ timeout: 30_000 });

  // Re-select the SAME bytes again without reloading -- this is exactly the
  // path that used to produce two rows sharing key={sha256} (a React
  // duplicate-key console error, and either a dropped or duplicated DOM
  // row), since setRows used to append a new row unconditionally.
  await page.getByTestId('file-input').setInputFiles({
    name: 'Reselect Me (1990)(X).adf', mimeType: 'application/octet-stream', buffer,
  });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="deduped"]'))
    .toBeVisible({ timeout: 30_000 });

  await expect(page.getByTestId('ingest-row')).toHaveCount(1);
  expect(consoleErrors.some((m) => /same key/i.test(m))).toBe(false);
});

// --- The self-wedge (whole-branch review C1b) ------------------------------
//
// A batch where one PUT fails used to throw out of the caller before
// /api/ingest/complete ran, so the OTHER files in that batch sat in the store
// with no blobs row. /api/ingest/check is DB-backed, so the next run reported
// them missing, presigned them, PUT them again -- and got 400 "This blob
// already exists" (allowOverwrite: false) forever. Same file, same failure,
// every run, with no attacker involved. It is the failure that would bite the
// real ~18,000-file import.
//
// Reproduced here exactly, using the real store's real 400: the bytes are
// genuinely uploaded first, then /check is forced to report them missing, so
// the client really does presign and really does re-PUT an existing key.
test('a re-PUT of bytes already in the store reconciles instead of wedging', async ({ page }) => {
  await signUpFresh(page);
  const buffer = fakeAdf(Date.now());

  // First pass: real upload, real blobs row.
  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles({
    name: 'Wedge Me (1991)(Y).adf', mimeType: 'application/octet-stream', buffer,
  });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="done"]'))
    .toBeVisible({ timeout: 30_000 });

  await page.reload();

  // Force the exact state a mid-batch abort leaves behind: bytes present in
  // the store, but /check says missing. Rewrites the real response rather
  // than inventing one, so the shape can never drift from the server's.
  await page.route('**/api/ingest/check', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      contentType: 'application/json',
      body: JSON.stringify({ known: [], missing: [...body.known, ...body.missing] }),
    });
  });

  await page.getByTestId('file-input').setInputFiles({
    name: 'Wedge Me (1991)(Y).adf', mimeType: 'application/octet-stream', buffer,
  });

  // With the fix, the 400 "already exists" is a soft success: the file still
  // goes to /complete and the row finishes. Without it, uploadOk=false
  // excluded the file from /complete and the row landed on 'failed' -- the
  // dead end, on every subsequent run.
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="done"]'))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="failed"]'))
    .toHaveCount(0);
});
