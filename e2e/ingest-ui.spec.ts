import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

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
