import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { signUpFresh, mintInviteCode } from './helpers';
import { signInAsSuperAdmin, SUPERADMIN_EMAIL, gotoAdminUserRow, seedUsers, cleanupSeededUsers, ADMIN_PER_PAGE } from './admin-helpers';
import { cleanupSeeded, cleanupTestReleases, hydrated } from './device-helpers';
import { ALPHABET } from '@/lib/invites';

// Phase C6 (spec 2026-10-25-phase-c6-admin-design.md §10.4): the admin layout. The DB is the live one: every
// assertion is about rows a test made, or follows a value the page itself shows (both values of a state).
test.afterAll(async () => { await cleanupSeededUsers(); await cleanupTestReleases(); await cleanupSeeded(); });

const PAGES = [
  ['/admin', 'Overview'], ['/admin/users', 'Users'], ['/admin/invites', 'Invites'],
  ['/admin/scan', 'Scan'], ['/admin/firmware', 'Firmware'],
] as const;

// ---- Shell (spec §1, Rulings 1, 2, 6, 36) -----------------------------------------------------------------

test('the admin header carries the Main nav with Admin current, the gear and Sign out, and no drive chips', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path] of PAGES) {
    await page.goto(path);
    const header = page.getByTestId('admin-header');
    const main = header.getByRole('navigation', { name: 'Main' });
    await expect(main.getByRole('link')).toHaveText(['Library', 'Devices', 'Upload', 'Help', 'Admin']);
    await expect(main.locator('[aria-current="page"]')).toHaveText(['Admin']);
    await expect(header.getByTestId('settings-link')).toBeVisible();
    await expect(header.getByTestId('sign-out')).toBeVisible();
    await expect(header.getByTestId('search-input')).toBeVisible();
    await expect(header.getByText('Back to library')).toHaveCount(0);
    await expect(header).toContainText('webfloppy admin');
    await expect(page.locator('[data-testid^=drive-chip]')).toHaveCount(0);
    await expect(page.getByTestId('drives-compact')).toHaveCount(0);
  }
});

test('every admin page opens with the Admin sections tabs, the current one marked, and its own title', async ({ page }) => {
  await signInAsSuperAdmin(page);
  for (const [path, name] of PAGES) {
    await page.goto(path);
    const tabs = page.getByTestId('admin-sections');
    await expect(tabs).toHaveAttribute('aria-label', 'Admin sections');
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Users', 'Invites', 'Scan', 'Firmware']);
    await expect(tabs.locator('[aria-current="page"]')).toHaveText([name]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText('Admin · this server', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(`Admin · ${name} · WebFloppy`);
  }
});

// ---- Loading frame and 390 px header (fix round 1: I1, M1) -------------------------------------------------

/**
 * The tabs' top offset under the loading frame and on the landed page. The dev server will not hold a loading.tsx
 * frame on screen (a delayed RSC response shows nothing until it lands), so the frame is rendered in isolation: the
 * real AdminLoading markup is put in place of the landed page's body, under the real header with the real CSS.
 */
async function loadingVsLanded(page: Page) {
  // Users: its one-line subtitle is the same height at 390 px as at 1280 (Overview's wraps).
  await page.goto('/admin/users');
  await page.getByTestId('admin-sections').waitFor();
  const landed = (await page.getByTestId('admin-sections').boundingBox())!.y;
  // Playwright's own JSX transform cannot compile the component, so a child process renders it (tsx handles the
  // alias through tsconfig paths).
  const html = execFileSync('npx', ['tsx', '-e',
    "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; " +
    "import L from './src/app/(admin)/loading'; process.stdout.write(renderToStaticMarkup(createElement(L)));",
  ], { encoding: 'utf8' });
  await page.evaluate((markup) => {
    const header = document.querySelector('[data-testid=admin-header]')!;
    while (header.nextSibling) header.nextSibling.remove();
    header.insertAdjacentHTML('afterend', markup);
  }, html);
  const loading = (await page.getByTestId('page-skeleton').locator('.h-\\[42px\\]').boundingBox())!.y;
  return { loading, landed };
}

for (const [w, h] of [[1280, 800], [390, 844]] as const) {
  test(`the loading frame puts the tabs where the landed page does, at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signInAsSuperAdmin(page);
    const { loading, landed } = await loadingVsLanded(page);
    expect(Math.abs(loading - landed), `loading ${loading} vs landed ${landed}`).toBeLessThanOrEqual(2);
  });
}

test('at 390px the admin header fits: no horizontal overflow, gear and Sign out visible, two lines at most', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const header = page.getByTestId('admin-header');
  await expect(header.getByTestId('settings-link')).toBeVisible();
  await expect(header.getByTestId('sign-out')).toBeVisible();
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  expect(o.sw).toBeLessThanOrEqual(o.cw);
  for (const id of ['settings-link', 'sign-out']) {
    const b = (await header.getByTestId(id).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  // wordmark on line one; search, gear and Sign out together on line two (not a third line)
  const search = (await header.getByTestId('search-input').boundingBox())!;
  const out = (await header.getByTestId('sign-out').boundingBox())!;
  expect(Math.abs((search.y + search.height / 2) - (out.y + out.height / 2)), 'search and Sign out share a line').toBeLessThan(8);
  await expect(header.getByTestId('admin-email')).toBeHidden();
});

// ---- Overview (spec §2, Rulings 13–16) --------------------------------------------------------------------

test('Overview: six tiles that are links, the nested figures digits only, the firmware card and its footnote', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const TILES = [
    ['count-users', 'Users', '/admin/users'], ['count-orgs', 'Organizations', '/admin/users'],
    ['count-games', 'Titles', '/admin/scan'], ['count-blobs', 'Blobs', '/admin/scan'],
    ['count-boardsOnline', 'Boards online', '/admin/firmware'], ['count-liveInvites', 'Live invites', '/admin/invites'],
  ] as const;
  for (const [id, label, href] of TILES) {
    const tile = page.locator(`a:has(> [data-testid="${id}"])`);
    await expect(tile).toHaveAttribute('href', href);
    await expect(tile.locator(':scope > span').first()).toHaveText(label);
    await expect(page.getByTestId(id)).toHaveText(/^\d+$/);
    await expect(tile).toHaveAttribute('data-warn', /^(true|false)$/);
  }
  for (const id of ['count-disks', 'count-boardsPaired', 'count-boardsSeen7d']) {
    await expect(page.getByTestId(id)).toHaveText(/^\d+$/);
  }
  await expect(page.locator('a:has(> [data-testid="count-users"]) > span:last-child'))
    .toHaveText(/^(newest \d{4}-\d{2}-\d{2}|none yet)$/);
  await expect(page.locator('a:has(> [data-testid="count-games"])')).toContainText(/\d+ disks?$/);
  await expect(page.locator('a:has(> [data-testid="count-boardsOnline"])')).toContainText(/of \d+ paired$/);
  // Both values of the warning: it follows the number.
  const live = Number(await page.getByTestId('count-liveInvites').textContent());
  await expect(page.locator('a:has(> [data-testid="count-liveInvites"])'))
    .toHaveAttribute('data-warn', live === 0 ? 'true' : 'false');

  await expect(page.getByRole('heading', { name: 'Boards by firmware' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Firmware registry' })).toHaveAttribute('href', '/admin/firmware');
  await expect(page.getByText(/^Boards that reported in the last 7 days: \d+\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /overview/i })).toHaveCount(1);

  await page.locator('a:has(> [data-testid="count-users"])').click();
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test('Needs attention: the server items follow the tile numbers and come first, then the boards', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const live = Number(await page.getByTestId('count-liveInvites').textContent());
  const invites = page.getByTestId('attention-invites');
  if (live === 0) {
    await expect(invites).toHaveAttribute('href', '/admin/invites');
    await expect(invites).toContainText('No live invite codes');
  } else {
    await expect(invites).toHaveCount(0);
  }
  const note = (await page.locator('a:has(> [data-testid="count-blobs"]) > span:last-child').textContent()) ?? '';
  const scan = page.getByTestId('attention-scan');
  const unchecked = /^(\d+) not yet scanned$/.exec(note)?.[1];
  if (unchecked) {
    await expect(scan).toHaveAttribute('href', '/admin/scan');
    await expect(scan.locator('[data-attn="title"]')).toHaveText(new RegExp(`^${unchecked} blobs? not yet scanned$`));
  } else {
    expect(note).toBe('all scanned');
    await expect(scan).toHaveCount(0);
  }
  // Order: server items, then board rows; "Nothing needs attention." only when there is nothing else.
  const order = await page.getByTestId('attention').locator(':scope > li').evaluateAll((lis) =>
    lis.map((li) => li.getAttribute('data-testid') ?? li.firstElementChild?.getAttribute('data-testid') ?? ''));
  const firstRow = order.indexOf('attention-row');
  const lastServer = Math.max(order.lastIndexOf('attention-invites'), order.lastIndexOf('attention-scan'));
  if (firstRow !== -1) expect(lastServer).toBeLessThan(firstRow);
  expect(order.includes('attention-empty')).toBe(order.every((id) => id === 'attention-empty'));
  expect(order.length).toBeGreaterThan(0);
});

// ---- Users (spec §3, Rulings 7–12) ------------------------------------------------------------------------

test("Users: the board's columns, the Admin pill with a Delete… that does nothing, the footer and the pager", async ({ page }) => {
  await seedUsers(ADMIN_PER_PAGE + 5);   // the live DB holds few users since teardown; a test brings its own second page
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  await expect(page.getByText(/^\d+ users · newest first · page 1 of \d+$/)).toBeVisible();
  await expect(page.locator('section[aria-label="Users"] th'))
    .toHaveText(['Email', 'Organization', 'Joined', 'Titles', 'Disks', 'Boards', 'Action']);
  await expect(page.locator('[data-users-foot]')).toHaveText(
    'Deleting a user removes their organization, titles, disks and boards. Disk images are kept: other libraries may share them.');
  // Page 1: Previous is a disabled span (both values: a word in each), Next a link.
  await expect(page.getByRole('link', { name: 'Previous' })).toHaveCount(0);
  await expect(page.getByText('Previous', { exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/admin/users?page=2');

  // An ordinary row has no pill and an armed Delete….
  const other = page.getByTestId('admin-user-row').filter({ hasNot: page.locator('[data-admin-pill]') }).first();
  await expect(other.locator('[data-testid^="delete-user-"]')).toHaveText('Delete…');
  await expect(other.locator('[data-testid^="delete-user-"]')).not.toHaveAttribute('aria-disabled', 'true');

  // The allowlisted account: the pill says why, and Delete… neither clicks nor Enters into the dialog.
  await gotoAdminUserRow(page, SUPERADMIN_EMAIL);
  await expect(page.getByTestId(`user-row-${SUPERADMIN_EMAIL}`).locator('[data-admin-pill]')).toHaveText('Admin');
  const del = page.getByTestId(`delete-user-${SUPERADMIN_EMAIL}`);
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await expect(del).toHaveAttribute('title', 'An admin account cannot be deleted');
  await hydrated(page, `delete-user-${SUPERADMIN_EMAIL}`);
  await del.click({ force: true });   // force: Playwright waits forever for an aria-disabled control to enable
  await del.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('delete-user-dialog')).toHaveCount(0);
});

test('Delete…: the dialog opens on the field, Escape returns to the trigger, a failure keeps it open, a delete leaves focus on the heading', async ({ page }) => {
  const victim = await signUpFresh(page);
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  const id = `delete-user-${victim.email}`;
  const trigger = page.getByTestId(id);
  await hydrated(page, id);
  await trigger.click();
  const dialog = page.getByTestId('delete-user-dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete this account?' })).toBeVisible();
  await expect(dialog).toContainText(victim.email);
  await expect(page.getByLabel('Type the email to confirm')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // A server failure: the toast, the dialog stays, the button reads Delete permanently again.
  await page.route(`**/api/admin/users/**`, (r) => r.fulfill({ status: 500, body: '' }));
  await trigger.click();
  await page.getByLabel('Type the email to confirm').fill(victim.email);
  const confirm = dialog.getByRole('button', { name: /delete permanently/i });
  await confirm.click();
  await expect(page.getByText('Could not delete the user')).toBeVisible();
  await expect(confirm).toHaveText('Delete permanently');
  await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
  await page.unroute(`**/api/admin/users/**`);

  await confirm.click();
  await expect(page.getByTestId(`user-row-${victim.email}`)).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});

// ---- Invites (spec §4, Rulings 17–20) ---------------------------------------------------------------------

test('Invites: Issue an invite shows the new-code panel under the tabs; the none-live note follows the live count', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const sub = (await page.getByText(/^\d+ live · \d+ total · invite-only$/).textContent()) ?? '';
  const live = Number(/^(\d+) live/.exec(sub)?.[1]);
  await expect(page.getByTestId('invites-none-live')).toHaveCount(live === 0 ? 1 : 0);
  await expect(page.locator('section[aria-label="Invite codes"] th'))
    .toHaveText(['Code', 'State', 'Issued', 'Expires', 'Used by', 'Action']);
  await expect(page.getByTestId('new-invite-panel')).toHaveCount(0);

  const button = page.getByRole('button', { name: 'Issue an invite' });
  const panel = page.getByTestId('new-invite-panel');
  // No test id on the button (spec §10): retry the click until hydration has wired it.
  await expect(async () => {
    await button.click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(panel).toContainText('New code · single use · expires in 7 days');
  const code = (await page.getByTestId('new-invite-code').textContent())?.trim() ?? '';
  expect(code).toMatch(new RegExp(`^[${ALPHABET}]{8}$`));
  await expect(page.getByTestId('new-invite-copy-code')).toHaveText('Copy code');
  await expect(page.getByTestId('new-invite-copy-link')).toHaveText('Copy sign-up link');
  await expect(page.getByRole('status').filter({ hasText: `New invite code ${code}` })).toHaveCount(1);
  // Under the tabs, not beside the button.
  const tabs = (await page.getByTestId('admin-sections').boundingBox())!;
  expect((await panel.boundingBox())!.y).toBeGreaterThan(tabs.y + tabs.height - 1);
  await expect(button).toBeFocused();
  await expect(page.getByTestId('invites-none-live')).toHaveCount(0);
  await expect(page.getByTestId(`invite-${code}`).locator('[data-state]')).toHaveText('Live');
});

test('Invites: a dropped revoke keeps the button; a revoke leaves the row Revoked with no action and focus on the heading', async ({ page }) => {
  const code = await mintInviteCode();
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const revoke = page.getByTestId(`revoke-${code}`);
  await hydrated(page, `revoke-${code}`);

  await page.route(`**/api/admin/invites/${code}`, (r) => r.abort());
  await revoke.click();
  await expect(page.getByText('Could not reach the server')).toBeVisible();
  await expect(revoke).toHaveText('Revoke');
  await expect(revoke).not.toHaveAttribute('aria-disabled', 'true');
  await expect(revoke).toBeFocused();
  await page.unroute(`**/api/admin/invites/${code}`);

  await revoke.click();
  await expect(page.getByTestId(`invite-${code}`).locator('[data-state]')).toHaveText('Revoked');
  await expect(revoke).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});

test('Invites: revoking the just-issued code clears the new-code panel and its status line', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const button = page.getByRole('button', { name: 'Issue an invite' });
  const panel = page.getByTestId('new-invite-panel');
  await expect(async () => {
    await button.click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const code = (await page.getByTestId('new-invite-code').textContent())?.trim() ?? '';
  await page.getByTestId(`revoke-${code}`).click();
  await expect(page.getByTestId(`invite-${code}`).locator('[data-state]')).toHaveText('Revoked');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: `New invite code ${code}` })).toHaveCount(0);
  // The none-live note follows the live count the subtitle shows.
  const sub = (await page.getByText(/^\d+ live · \d+ total · invite-only$/).textContent()) ?? '';
  const live = Number(/^(\d+) live/.exec(sub)?.[1]);
  await expect(page.getByTestId('invites-none-live')).toHaveCount(live === 0 ? 1 : 0);
});

test('Invites: a quick second click on Revoke sends one request, even while the refresh is on its way', async ({ page }) => {
  const code = await mintInviteCode();
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const revoke = page.getByTestId(`revoke-${code}`);
  await hydrated(page, `revoke-${code}`);
  let deletes = 0;
  await page.route(`**/api/admin/invites/${code}`, (r) => { deletes++; return r.continue(); });
  // Hold the refresh's RSC payload so the row is still on screen after the 204.
  await page.route(/\/admin\/invites\?_rsc=/, async (r) => { await new Promise((res) => setTimeout(res, 2_000)); await r.continue(); });
  await revoke.click();
  await expect(page.getByText(`Revoked ${code}`)).toBeVisible();
  await expect(revoke).toHaveAttribute('aria-disabled', 'true');
  await revoke.click({ force: true });
  await expect(page.getByTestId(`invite-${code}`).locator('[data-state]')).toHaveText('Revoked', { timeout: 10_000 });
  expect(deletes).toBe(1);
});

// ---- Scan (spec §5, Rulings 21–26) ------------------------------------------------------------------------

test('Scan: three source cards with every count, the status lines, Choose buttons over hidden inputs, the sets card', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/scan');
  await expect(page.getByTestId('run-scan')).toHaveText('Run now');
  const identity = page.getByTestId('scan-identity');
  await expect(identity.getByRole('heading', { name: 'Identity' })).toBeVisible();
  await expect(identity.locator('[data-source]')).toHaveText(/^TOSEC · \d+ entries$/);
  await expect(identity).toContainText(/(\d+% recognised|— nothing decided yet)/);
  for (const id of ['scan-blobs', 'scan-hashed', 'scan-matched', 'scan-none', 'scan-ambiguous', 'scan-unreadable', 'scan-unchecked']) {
    await expect(identity.getByTestId(id)).toHaveText(/^\d+$/);
  }
  const details = page.getByTestId('scan-details');
  await expect(details.getByTestId('scan-openretroEntries')).toHaveText(/^\d+$/);
  for (const id of ['scan-enriched', 'scan-enrichNone', 'scan-enrichAmbiguous', 'scan-enrichUnchecked', 'scan-imagesStored']) {
    await expect(details.getByTestId(id)).toHaveText(/^\d+$/);
  }
  await expect(details.getByTestId('scan-imageMb')).toHaveText(/^\d+\.\d MB$/);
  await expect(page.getByTestId('scan-demos').getByTestId('demozoo-status')).toHaveText(/^Demozoo:/);

  // The status lines follow the counts on the page (both values of "anything left to do").
  const notes = page.getByTestId('scan-notes');
  await expect(notes).toHaveAttribute('role', 'status');
  const kinds = await notes.getByTestId('scan-note').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  const unchecked = Number(await page.getByTestId('scan-unchecked').textContent());
  const unreadable = Number(await page.getByTestId('scan-unreadable').textContent());
  expect(kinds.includes('unchecked')).toBe(unchecked > 0);
  expect(kinds.includes('unreadable')).toBe(unreadable > 0);
  expect(kinds.includes('done')).toBe(kinds.length === 1 && kinds[0] === 'done');

  // The Choose buttons are the tab stops; the inputs are not.
  await expect(page.getByTestId('dat-upload')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByTestId('openretro-upload')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByTestId('dat-choose')).toHaveText('Choose .dat files');
  await expect(page.getByTestId('openretro-choose')).toHaveText('Choose Amiga.sqlite');
  await hydrated(page, 'dat-choose');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('dat-choose').click();
  expect((await chooser).isMultiple()).toBe(true);
  await expect(page.getByTestId('tosec-fetch-status')).toContainText('TOSEC:');
  await expect(page.getByTestId('openretro-hint')).toContainText('Run FS-UAE Launcher once');

  await expect(page.getByRole('heading', { name: 'TOSEC sets' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="sets-heading"] th')).toHaveText(['Set', 'Version', 'Entries']);
  await expect(page.getByRole('heading', { name: /scan/i })).toHaveCount(1);
});

test('Scan: each upload exposes one control to assistive tech, and the status lines keep the outcome in words', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/scan');
  // The real file inputs are out of the accessibility tree: the Choose button is the one control per card.
  for (const [section, choose, input] of [['dat-heading', 'dat-choose', 'dat-upload'], ['openretro-heading', 'openretro-choose', 'openretro-upload']]) {
    const card = page.locator(`section[aria-labelledby="${section}"]`);
    await expect(card.getByRole('button')).toHaveCount(1);
    await expect(card.getByTestId(choose)).toBeVisible();
    await expect(card.getByTestId(input)).toHaveAttribute('aria-hidden', 'true');
    await expect(card.getByTestId(input)).toHaveAttribute('tabindex', '-1');
  }
  // Live regions are present from first paint and empty when idle.
  const runStatus = page.getByTestId('run-scan-status');
  await expect(runStatus).toHaveAttribute('role', 'status');
  await expect(runStatus).toHaveText('');
  await expect(page.getByTestId('dat-status')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('dat-status')).toHaveText('');
  await expect(page.getByTestId('openretro-status')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('openretro-status')).toHaveText('');

  // A rejected file leaves the failure in words on the page (the toast is gone in seconds). Nothing is written.
  await hydrated(page, 'openretro-upload', 'onChange');
  await page.getByTestId('openretro-upload').setInputFiles({ name: 'not-a-db.sqlite', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not sqlite') });
  await expect(page.getByTestId('openretro-status')).toHaveText('Import failed. That is not a SQLite database — expected Amiga.sqlite.');
  await hydrated(page, 'dat-upload', 'onChange');
  await page.getByTestId('dat-upload').setInputFiles({ name: 'junk.dat', mimeType: 'text/plain', buffer: Buffer.from('not a dat') });
  await expect(page.getByTestId('dat-status')).toHaveText('Nothing imported. 1 file(s) rejected — are these really TOSEC DATs?');
});
