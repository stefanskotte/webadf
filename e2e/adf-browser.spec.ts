import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { BLOCK_BYTES, ROOT_BLOCK } from '@/lib/adffs/constants';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { formatVolume } from '@/lib/adffs/format';
import { recheck } from '@/lib/adffs/write-blocks';
import { readVolume } from '@/lib/adffs';
import { signUpFresh } from './helpers';
import { cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

/**
 * Upload real bytes through the real ingest flow, same as adf-download.spec.ts.
 *
 * The file browser page and route both read the disk's stored blob (via
 * diskStore.read), so -- unlike the protocol specs, which are free to use
 * seedDisk's byte-less blob row -- every test here needs bytes that actually
 * exist in storage.
 */
async function uploadDisk(page: import('@playwright/test').Page, content: Buffer) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const presign = await page.request.post('/api/ingest/presign', {
    data: { files: [{ sha256, sizeBytes: content.length }] },
  });
  expect(presign.ok()).toBe(true);
  const { uploads } = await presign.json();
  const put = await fetch(uploads[0].url, { method: 'PUT', body: new Uint8Array(content) });
  if (!put.ok) throw new Error(`test setup: PUT failed ${put.status}`);
  return sha256;
}

/** Upload a synthetic ADF and complete ingest, returning the resulting disks row. */
async function ingestDisk(page: import('@playwright/test').Page, adf: Uint8Array, filename: string) {
  const content = Buffer.from(adf);
  const sha256 = await uploadDisk(page, content);
  const complete = await page.request.post('/api/ingest/complete', {
    data: { files: [{ sha256, sizeBytes: content.length, filename }] },
  });
  expect(complete.status()).toBe(200);
  const row = (await getDb().select().from(disks).where(eq(disks.sha256, sha256)))[0];
  if (!row) throw new Error('test setup: disk row not found after ingest');
  return row;
}

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Files increment 1 (Task 11): the head of a disk is the Files manager, so these read the disk through it -- the right
 * pane lists the tree, its header and the disk strip say what the Browse page's Disk card said, and Files' own routes
 * (`/api/files/list`, `/api/files/download`) are what another tenant must get 404 from.
 */
const diskPath = (row: { gameId: string; id: string }) => `LIBRARY:/${row.gameId}/${row.id}`;

async function openInFiles(page: Page, row: { gameId: string; id: string }) {
  const res = await page.goto(`/files?${new URLSearchParams({ left: 'LIBRARY:', right: diskPath(row), active: 'right' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  return res;
}

const paneRow = (page: Page, name: string) =>
  page.getByTestId('pane-right').locator(`[data-testid="pane-row"][data-name="${name}"]`);

test('the page renders a real tree, from a real FFS volume', async ({ page }) => {
  await signUpFresh(page);
  const tag = randomUUID();
  const volumeName = `Workbench-${tag.slice(0, 8)}`;
  const adf = syntheticVolume({
    filesystem: 'FFS',
    volumeName,
    entries: [
      { name: 'C', entries: [{ name: 'SetPatch', bytes: enc(`setpatch-${tag}`) }] },
      { name: 'README', bytes: enc(`readme-${tag}`) },
    ],
  });
  const row = await ingestDisk(page, adf, `disk-${tag}.adf`);

  const res = await openInFiles(page, row);
  expect(res?.status()).toBe(200);

  await expect(page.getByTestId('pane-right-meta')).toContainText('FFS');
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-strip-volume')).toHaveText(volumeName);

  await expect(paneRow(page, 'C')).toHaveAttribute('data-kind', 'dir');
  await expect(paneRow(page, 'README')).toHaveAttribute('data-kind', 'file');

  // Open the directory to prove this is a real nested traversal of the
  // image, not just a listing of the root block.
  await paneRow(page, 'C').dblclick();
  await expect(paneRow(page, 'SetPatch')).toBeVisible();
  await expect(page.getByTestId('pane-right-crumb-3')).toHaveText('C');

  // The way back up the path names each place for what it IS -- the title is
  // named for itself, never typed as "Game" (the `games` table's vocabulary,
  // and simply wrong on a Workbench or utility disk, which is most of what
  // this browser is for) -- and takes the pane there: the title's disks.
  const title = page.getByTestId('pane-right-crumb-1');
  await expect(title).not.toHaveText(/^Game$/);
  await expect(title).toHaveText(`disk-${tag}`);
  await title.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('right')).toBe(`LIBRARY:/${row.gameId}`);
  await expect(page.getByTestId('pane-right').getByTestId('pane-row')).toHaveCount(1);
  await expect(page.getByTestId('pane-right').getByTestId('pane-row')).toHaveAttribute('data-kind', 'disk');
});

test('Files shows how much of the disk is used', async ({ page }) => {
  await signUpFresh(page);
  const tag = randomUUID();
  // formatVolume, NOT syntheticVolume. The fixture generator writes correct
  // checksums and hash chains but NO BITMAP -- which is exactly why
  // formatVolume had to be written -- and the space figure is read from the
  // bitmap. A synthetic disk therefore reports "unknown", correctly, and
  // cannot exercise this at all. The test below asserts that case.
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `Space-${tag.slice(0, 8)}` });
  const row = await ingestDisk(page, adf, `space-${tag}.adf`);

  await openInFiles(page, row);
  const usage = page.getByTestId('disk-strip-right').getByTestId('disk-strip-usage');
  await expect(usage).toBeVisible();

  // Four blocks on a freshly formatted disk -- two boot blocks, the root and
  // the bitmap -- which is 2 KB, and the same figure xdftool reports for its
  // own format. 880 KB is the number printed on the physical disk.
  await expect(usage).toHaveText('2 of 880 KB · 878 KB free');
  await expect(page.getByTestId('pane-right-meta')).toHaveText('878 KB free · FFS DD');

  const text = (await usage.textContent()) ?? '';
  const [used, total, free] = [...text.matchAll(/(\d+)(?: of| KB)/g)].map((m) => Number(m[1]));
  expect(used + free).toBe(total);
});

test('a disk whose bitmap cannot be trusted says so instead of guessing', async ({ page }) => {
  await signUpFresh(page);
  const tag = randomUUID();
  // syntheticVolume() used to write no bitmap at all, which was enough on
  // its own to make bm_flag invalid. Commit d6af734 ("Give synthetic
  // volumes the bitmap they never had", task 1 of the file-operations plan)
  // gave it a real, trustworthy bitmap instead -- the write layer needs one
  // to allocate from -- so that fixture no longer exercises this path. The
  // untrustworthy case has to be built deliberately now, the same way
  // alloc.test.ts and write.test.ts already do it: build a normal volume,
  // then poke bm_flag (root block, offset 312) back to 0. readUsage() checks
  // only bm_flag, the bitmap pointer's range, and the bitmap block's own
  // self-bit, so this one byte is sufficient to make it refuse.
  //
  // That refusal is the point, and it now protects more than this label:
  // D-W-5 makes bitmap trust decide whether a disk is writable at all, and
  // alloc.ts reuses this exact same readUsage() check as its trust gate. A
  // confidently wrong "878 KB free" on a full disk was already worse than no
  // answer; allocating real blocks from an untrusted bitmap would be worse
  // still.
  const adf = syntheticVolume({
    filesystem: 'FFS',
    volumeName: `Untrusted-${tag.slice(0, 8)}`,
    entries: [{ name: 'README', bytes: enc('x') }],
  });
  adf[ROOT_BLOCK * BLOCK_BYTES + 312] = 0x00;
  // Unlike the unit tests' direct calls into readUsage()/allocate(), this
  // test goes through the real page, which parses the root block with
  // readVolume() first -- and readVolume() DOES verify the root block's own
  // checksum (root.ts), unlike readUsage(). Poking a byte without fixing the
  // checksum up would make the checksum itself the thing that's wrong, and
  // the page would report "no filesystem" instead of exercising the bitmap
  // path this test is actually about. recheck() (write-blocks.ts) exists for
  // precisely this: recompute the checksum over the block as it now stands,
  // corrupted bm_flag included, so the root block still reads as a valid
  // filesystem and only the bitmap itself is untrustworthy.
  recheck(adf, ROOT_BLOCK);
  const row = await ingestDisk(page, adf, `untrusted-${tag}.adf`);

  await openInFiles(page, row);
  // The disk still READS -- the reader ignores bitmaps by design.
  await expect(paneRow(page, 'README')).toBeVisible();
  await expect(page.getByTestId('disk-strip-right').getByTestId('disk-strip-usage')).toHaveText('Free space unknown');
  await expect(page.getByTestId('pane-right-meta')).toHaveText('FFS DD');   // no free space claimed
});

test('a disk with no filesystem explains itself', async ({ page }) => {
  await signUpFresh(page);
  const tag = randomUUID();
  // Project-X shape: a DOS signature but a bogus root checksum. volumeName
  // still varies the bytes even though it is never surfaced, keeping this
  // image's sha256 distinct from every other test's.
  const adf = syntheticVolume({ volumeName: `Cracked-${tag.slice(0, 8)}`, breakRootChecksum: true });
  const row = await ingestDisk(page, adf, `cracked-${tag}.adf`);

  const res = await openInFiles(page, row);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('pane-right-readonly')).toHaveText('This disk has no AmigaDOS filesystem.');
  await expect(page.getByTestId('pane-right-meta')).toHaveText('No filesystem DD');
  await expect(page.getByTestId('pane-right').getByTestId('pane-row')).toHaveCount(0);
  await expect(page.getByTestId('pane-right')).toContainText('Nothing here.');
});

test('a single file downloads with the right bytes', async ({ page }) => {
  await signUpFresh(page);
  const tag = randomUUID();
  const fileBytes = enc(`payload-${tag}-the quick brown fox`);
  const adf = syntheticVolume({
    filesystem: 'FFS',
    volumeName: `Data-${tag.slice(0, 8)}`,
    entries: [{ name: 'DATA.BIN', bytes: fileBytes }],
  });
  const row = await ingestDisk(page, adf, `data-${tag}.adf`);

  await openInFiles(page, row);
  await paneRow(page, 'DATA.BIN').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('files-download').click()]);
  const href = download.url();
  expect(href).toContain(`/api/files/download?path=${encodeURIComponent(`${diskPath(row)}/DATA.BIN`)}`);
  expect(download.suggestedFilename()).toBe('DATA.BIN');

  const dl = await page.request.get(href);
  expect(dl.status()).toBe(200);
  expect(dl.headers()['content-disposition']).toContain("filename*=UTF-8''DATA.BIN");   // RFC 6266, any name

  const body = await dl.body();
  expect(Buffer.compare(body, Buffer.from(fileBytes))).toBe(0);
});

test('another tenant gets 404 from the file routes and the Files page, not the owner', async ({ browser }) => {
  // The boundary. A 403, or bytes, would confirm the disk exists; only 404
  // reveals nothing about another organization's library.
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pageA = await a.newPage();
    await signUpFresh(pageA);
    const tag = randomUUID();
    const fileBytes = enc(`secret-${tag}`);
    const adf = syntheticVolume({
      filesystem: 'FFS',
      volumeName: `Private-${tag.slice(0, 8)}`,
      entries: [{ name: 'SECRET.TXT', bytes: fileBytes }],
    });
    const row = await ingestDisk(pageA, adf, `private-${tag}.adf`);

    // Proven reachable by its owner FIRST -- both the page and the file
    // route -- so the 404s below cannot pass for the trivial reason that the
    // id is wrong or the fixture never mounted.
    const ownRes = await openInFiles(pageA, row);
    expect(ownRes?.status()).toBe(200);
    await expect(paneRow(pageA, 'SECRET.TXT')).toBeVisible();
    const list = `/api/files/list?path=${encodeURIComponent(diskPath(row))}`;
    const href = `/api/files/download?path=${encodeURIComponent(`${diskPath(row)}/SECRET.TXT`)}`;
    expect((await pageA.request.get(list)).status()).toBe(200);
    expect((await pageA.request.get(href)).status()).toBe(200);
    // The per-disk file route the per-version page still downloads through, too.
    const vol = readVolume(adf);
    if (!vol.ok) throw new Error('fixture');
    const blockRoute = `/api/disks/${row.id}/files/${vol.root.find((e) => e.name === 'SECRET.TXT')!.block}`;
    expect((await pageA.request.get(blockRoute)).status()).toBe(200);

    const pageB = await b.newPage();
    await signUpFresh(pageB);

    for (const url of [list, href, blockRoute]) {
      const denied = await pageB.request.get(url, { maxRedirects: 0 });
      expect(denied.status(), url).toBe(404);
      expect((await denied.body()).byteLength).toBeLessThan(1000);
      expect(await denied.json()).toEqual({ error: 'not_found' });
    }

    // The Files page names nothing of it: the pane says the place does not exist, as for any unknown path.
    await openInFiles(pageB, row);
    await expect(pageB.getByTestId('pane-right-error')).toHaveText('This place no longer exists.');
    await expect(pageB.getByTestId('pane-right')).not.toContainText('SECRET');
    await expect(pageB.getByTestId('disk-strip-right')).toHaveCount(0);
    // And the old address of the disk: the not-found card (the app streams behind its loading.tsx, A1 States).
    await pageB.goto(`/disks/${row.id}/files`);
    await expect(pageB.getByTestId('not-found-page')).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});

test('a block that is not a file is refused, even the root block itself', async ({ page }) => {
  await signUpFresh(page);
  const tag = randomUUID();
  const adf = syntheticVolume({
    filesystem: 'FFS',
    volumeName: `RootOnly-${tag.slice(0, 8)}`,
    entries: [{ name: 'FILE.TXT', bytes: enc(`x-${tag}`) }],
  });
  const row = await ingestDisk(page, adf, `rootonly-${tag}.adf`);

  // ROOT_BLOCK (880) is a real, valid block in this image -- it is the root
  // directory header, not a file -- so a naive "does this block exist"
  // check would happily serve it. The route must walk the tree and reject
  // anything whose kind isn't 'file'.
  const res = await page.request.get(`/api/disks/${row.id}/files/${ROOT_BLOCK}`);
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBeTruthy();
});
