import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { diskStore } from '@/lib/storage';
import { signUpFresh } from './helpers';
import { synthDrop } from './drag-drop-helpers';

/**
 * Files increment 2, Task 8: files from the computer into STASH: -- the top drop zone ("Drop files into STASH:":
 * a drop, Browse files, Paste URL) and a drop on a STASH: pane's folder. Every landing is checked on the stored rows
 * and bytes as well as on the pane.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function openStash(page: Page, left = 'STASH:') {
  await page.goto(`/files?${new URLSearchParams({ left, right: 'LIBRARY:', active: 'left' })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

const row = (page: Page, name: string) => page.getByTestId('pane-left').locator(`[data-testid="pane-row"][data-name="${name}"]`);
const toast = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

/** The org's live STASH: rows, path → kind, size and blob. */
async function stashRows(orgId: string) {
  const rows = await getDb().select().from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')));
  return Object.fromEntries(rows.map((r) => [r.path, { kind: r.kind, size: r.sizeBytes, sha: r.blobSha256, source: r.source }]));
}

test('a drop on the zone stores files, a folder and an empty file in STASH:; a clash asks', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openStash(page);
  const zone = page.getByTestId('files-drop-stash');
  await expect(zone).toContainText('Drop files into STASH:');

  await synthDrop(page, [
    { name: 'notes.txt', kind: 'file', content: 'hello from the computer' },
    { name: 'README', kind: 'file', content: '' },
    { name: 'Mods', kind: 'dir', children: [
      { name: 'enigma.mod', kind: 'file', content: 'not really a module' },
      { name: 'Empty', kind: 'dir' },
    ] },
  ], '[data-testid="files-drop-stash"]');
  await expect(toast(page, 'Added 3 items to STASH:')).toBeVisible();
  await expect(row(page, 'notes.txt')).toBeVisible();
  await expect(row(page, 'README')).toBeVisible();
  await expect(row(page, 'Mods')).toBeVisible();

  const rows = await stashRows(orgId);
  expect(rows['notes.txt']).toMatchObject({ kind: 'file', size: 23, sha: sha('hello from the computer'), source: 'browser' });
  expect(rows['README']).toMatchObject({ kind: 'file', size: 0, sha: sha('') });
  expect(rows['Mods/enigma.mod']).toMatchObject({ kind: 'file', sha: sha('not really a module') });
  expect(rows['Mods/Empty']).toMatchObject({ kind: 'dir' });
  expect(new TextDecoder().decode(await diskStore.read(sha('hello from the computer')))).toBe('hello from the computer');

  // ReadMe is README to an Amiga: the Clash dialog asks before anything goes up; Keep both stores it as ReadMe_1.
  await synthDrop(page, [{ name: 'ReadMe', kind: 'file', content: 'second' }], '[data-testid="files-drop-stash"]');
  const clash = page.getByTestId('files-clash-dialog');
  await expect(clash.getByTestId('files-clash-text')).toContainText('ReadMe');
  await clash.getByTestId('files-clash-keep-both').click();
  await expect(toast(page, 'Added 1 item to STASH:')).toBeVisible();
  await expect(page.getByTestId('files-stash-report')).toContainText('ReadMe stored as ReadMe_1');
  await expect(row(page, 'ReadMe_1')).toBeVisible();
  expect((await stashRows(orgId))['ReadMe_1']).toMatchObject({ size: 6, sha: sha('second') });

  // Browse files: the same path, into the STASH: root.
  await page.getByTestId('files-stash-input').setInputFiles([{ name: 'picked.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('picked') }]);
  await expect(row(page, 'picked.bin')).toBeVisible();
  expect((await stashRows(orgId))['picked.bin']).toMatchObject({ size: 6, sha: sha('picked') });
});

test('a drop on a STASH: pane lands in the folder it was dropped on', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openStash(page);
  await synthDrop(page, [{ name: 'Mods', kind: 'dir', children: [{ name: 'a.mod', kind: 'file', content: 'a' }] }],
    '[data-testid="files-drop-stash"]');
  await expect(row(page, 'Mods')).toBeVisible();

  // Onto the Mods row: into Mods.
  await synthDrop(page, [{ name: 'b.mod', kind: 'file', content: 'bb' }], '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Mods"]');
  await expect(toast(page, 'Added 1 item to STASH:/Mods')).toBeVisible();
  // Onto the pane itself: into the folder it shows.
  await synthDrop(page, [{ name: 'Docs', kind: 'dir', children: [{ name: 'c.txt', kind: 'file', content: 'ccc' }] }], '[data-testid="pane-left"]');
  await expect(row(page, 'Docs')).toBeVisible();

  await expect.poll(async () => Object.keys(await stashRows(orgId)).sort())
    .toEqual(['Docs', 'Docs/c.txt', 'Mods', 'Mods/a.mod', 'Mods/b.mod']);
  await row(page, 'Mods').dblclick();
  await expect(row(page, 'b.mod')).toBeVisible();
});

test('the zone refuses a folder of more than 200 items, and a URL on a private address, in words', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  await openStash(page);

  await synthDrop(page, [
    { name: 'Huge', kind: 'dir', children: Array.from({ length: 200 }, (_, i) => ({ name: `f${i}`, kind: 'file' as const, content: '' })) },
  ], '[data-testid="files-drop-stash"]');
  await expect(toast(page, 'Nothing was added.')).toBeVisible();
  await expect(page.getByTestId('files-stash-report')).toContainText('Huge: Drop folders of up to 200 items at a time');
  expect(await stashRows(orgId)).toEqual({});

  await page.getByTestId('files-stash-url-input').fill('http://127.0.0.1/secret.lha');
  await page.getByTestId('files-stash-url-fetch').click();
  await expect(page.getByTestId('files-stash-url-status'))
    .toHaveText('That address points to a private or local network, which is not fetched.');
  expect(await stashRows(orgId)).toEqual({});
});
