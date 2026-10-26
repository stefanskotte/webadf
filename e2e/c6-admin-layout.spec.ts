import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { signUpFresh, mintInviteCode } from './helpers';
import { signInAsSuperAdmin, SUPERADMIN_EMAIL, gotoAdminUserRow, seedUsers, cleanupSeededUsers, ADMIN_PER_PAGE } from './admin-helpers';
import { cleanupSeeded, cleanupTestReleases, hydrated, seedDevices, publishTestRelease, publishTestReleaseWithBlob } from './device-helpers';
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
    // :visible -- the phone bar's More (hidden from lg) also marks itself current on an Admin page.
    await expect(main.locator('[aria-current="page"]:visible')).toHaveText(['Admin']);
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
const OVERVIEW_LOADING = './src/app/(admin)/admin/(overview)/loading';

async function loadingVsLanded(page: Page, path = '/admin/users', module = './src/app/(admin)/loading') {
  // Users: its one-line subtitle is the same height at 390 px as at 1280. Overview's wraps at 390, so it has its own
  // loading frame (the route group admin/(overview)).
  await page.goto(path);
  await page.getByTestId('admin-sections').waitFor();
  const landed = (await page.getByTestId('admin-sections').boundingBox())!.y;
  // Playwright's own JSX transform cannot compile the component, so a child process renders it (tsx handles the
  // alias through tsconfig paths).
  const html = execFileSync('npx', ['tsx', '-e',
    "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; " +
    "import L from '" + module + "'; process.stdout.write(renderToStaticMarkup(createElement(L)));",
  ], { encoding: 'utf8' });
  await page.evaluate((markup) => {
    const header = document.querySelector('[data-testid=admin-header]')!;
    while (header.nextSibling) header.nextSibling.remove();
    header.insertAdjacentHTML('afterend', markup);
  }, html);
  const loading = (await page.getByTestId('page-skeleton').locator('.w-\\[420px\\]').boundingBox())!.y;
  return { loading, landed };
}

for (const [w, h] of [[1280, 800], [390, 844]] as const) {
  test(`the loading frame puts the tabs where the landed page does, at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signInAsSuperAdmin(page);
    const { loading, landed } = await loadingVsLanded(page);
    expect(Math.abs(loading - landed), `loading ${loading} vs landed ${landed}`).toBeLessThanOrEqual(2);
  });
  // Carried from the Task 1 review: Overview's subtitle wraps to 2-3 lines at 390, so it has its own frame.
  test(`the Overview loading frame puts the tabs where the landed Overview does, at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signInAsSuperAdmin(page);
    const { loading, landed } = await loadingVsLanded(page, '/admin', OVERVIEW_LOADING);
    expect(Math.abs(loading - landed), `loading ${loading} vs landed ${landed}`).toBeLessThanOrEqual(2);
  });
}

test('at 390px the admin header is one row: no overflow, no gear or Sign out there; they are in the More menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  const header = page.getByTestId('admin-header');
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(61);
  await expect(header.getByTestId('settings-link')).toBeHidden();
  await expect(header.getByTestId('sign-out')).toBeHidden();
  await expect(header.getByTestId('admin-email')).toBeHidden();
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  expect(o.sw).toBeLessThanOrEqual(o.cw);
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').click();
  await expect(page.getByTestId('nav-more-menu')).toBeVisible();
  await expect(page.getByTestId('more-settings')).toBeVisible();
  await expect(page.getByTestId('more-sign-out')).toBeVisible();
  await expect(page.getByTestId('more-admin')).toHaveAttribute('aria-current', 'page');
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
    .toHaveText(['Email', 'Organization', 'Joined', 'Titles', 'Disks', 'Boards', 'Actions']);
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

test('Invites: a revoke answered 404 moves focus to the heading as the row loses its button', async ({ page }) => {
  const code = await mintInviteCode();
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const revoke = page.getByTestId(`revoke-${code}`);
  await hydrated(page, `revoke-${code}`);
  // The row's code is revoked for real (so the refresh drops its button), and this click is answered 404 as if the
  // code had gone entirely -- the route says 404 only for a code that does not exist.
  expect((await page.request.delete(`/api/admin/invites/${code}`)).ok()).toBe(true);
  await page.route(`**/api/admin/invites/${code}`, (r) => r.fulfill({ status: 404, json: { error: 'unknown' } }));
  await revoke.click();
  await expect(page.getByText('Could not revoke the code')).toBeVisible();
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

// ---- Firmware (spec §6, Rulings 27–31) --------------------------------------------------------------------

const fwRow = (page: import('@playwright/test').Page, version: string) =>
  page.locator(`[data-testid="firmware-release-row"][data-version="${version}"]`);

test('Firmware: All / Releases / Test builds filter on the server, the pager keeps it, a garbage URL clamps', async ({ page }) => {
  // Enough releases of our own that Releases has a second page whatever the registry holds; the two the test
  // looks for go last, so they are the newest and sit on page 1 of every filter.
  for (let i = 0; i < 26; i++) await publishTestRelease(`0.0.0+e2e7${String(i).padStart(2, '0')}`);
  await publishTestRelease('0.0.0+e2e60', { notes: 'TEST build c6 filter' });
  await publishTestRelease('0.0.0+e2e61');
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware');
  await expect(page.getByTestId('fw-filter')).toHaveAttribute('aria-label', 'Show releases');
  await expect(page.getByTestId('fw-filter').getByRole('link')).toHaveText(['All', 'Releases', 'Test builds']);
  await expect(page.getByTestId('fw-filter-all')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Test builds reach only the bench organizations. Promote to release… offers one to every organization.')).toBeVisible();
  await expect(page.getByText(/^\d+ published · (current \S+|no current release yet)$/)).toBeVisible();
  await expect(fwRow(page, '0.0.0+e2e60').getByTestId('fw-tag-test')).toHaveText('Test build · bench orgs only');
  await expect(fwRow(page, '0.0.0+e2e61').getByTestId('fw-tag-release')).toHaveText('Release');

  await page.getByTestId('fw-filter-test').click();
  await expect(page).toHaveURL(/\/admin\/firmware\?show=test$/);
  await expect(page.getByTestId('fw-filter-test')).toHaveAttribute('aria-current', 'page');
  await expect(fwRow(page, '0.0.0+e2e60')).toHaveCount(1);
  await expect(fwRow(page, '0.0.0+e2e61')).toHaveCount(0);
  const allTest = await page.getByTestId('firmware-release-row')
    .evaluateAll((rows) => rows.every((r) => !!r.querySelector('[data-testid="fw-tag-test"]')));
  expect(allTest).toBe(true);

  await page.getByTestId('fw-filter-releases').click();
  await expect(page).toHaveURL(/\/admin\/firmware\?show=releases$/);
  await expect(fwRow(page, '0.0.0+e2e61')).toHaveCount(1);
  await expect(fwRow(page, '0.0.0+e2e60')).toHaveCount(0);
  await expect(page.getByTestId('fw-page-older')).toHaveAttribute('href', '/admin/firmware?show=releases&page=2');

  const res = await page.goto('/admin/firmware?show=nope&page=999');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('fw-filter-all')).toHaveAttribute('aria-current', 'page');
  const text = await page.getByText(/^Page \d+ of \d+$/).textContent();
  const [, n, m] = /^Page (\d+) of (\d+)$/.exec(text ?? '') ?? [];
  expect(n).toBe(m);
  await expect(page.getByTestId('fw-page-older')).toHaveCount(0);
  await page.getByTestId('fw-filter-all').click();
  await expect(page).toHaveURL(/\/admin\/firmware$/);
});

test('Promote to release… under Test builds: notes take focus, Escape returns, the done text stays until Close, then the heading', async ({ page }) => {
  const version = await publishTestReleaseWithBlob('0.0.0+e2e62', { notes: 'TEST build c6 focus' });
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware?show=test');
  const trigger = fwRow(page, version).getByRole('button', { name: 'Promote to release' });
  await expect(trigger).toHaveText('Promote to release…');
  const dialog = page.getByTestId('fw-promote-dialog');
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(dialog.getByRole('heading', { name: 'Promote to release' })).toBeVisible();
  await expect(dialog).toContainText(version);
  await expect(dialog.getByTestId('fw-promote-notes')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByTestId('fw-promote-notes').fill('c6 focus release');
  await dialog.getByTestId('fw-promote-confirm').click();
  await expect(dialog.getByTestId('fw-promote-done')).toBeVisible();
  // Under show=test the refresh waits for Close, so the done text is still there to read.
  await page.waitForTimeout(1_500);
  await expect(dialog.getByTestId('fw-promote-done')).toBeVisible();
  await expect(page.getByTestId('fw-promote-done-close')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(fwRow(page, version)).toHaveCount(0);   // a release now: not in Test builds
  await expect(page.locator('h1')).toBeFocused();
});

async function openPromote(page: import('@playwright/test').Page, version: string) {
  const trigger = fwRow(page, version).getByRole('button', { name: 'Promote to release' });
  const dialog = page.getByTestId('fw-promote-dialog');
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return dialog;
}
const PROMOTE_URL = '**/api/admin/firmware/*/promote';

test('Promote in flight: Escape and Cancel keep the dialog, a second click sends no second request, the notes cannot change', async ({ page }) => {
  const version = await publishTestReleaseWithBlob('0.0.0+e2e63', { notes: 'TEST build c6 inflight' });
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware');
  let sent = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(PROMOTE_URL, async (route) => { sent++; await gate; await route.continue(); });
  const dialog = await openPromote(page, version);
  const notes = dialog.getByTestId('fw-promote-notes');
  const confirm = dialog.getByTestId('fw-promote-confirm');
  await notes.fill('c6 inflight release');
  await confirm.click();
  await expect(confirm).toHaveText('Promoting…');
  await expect.poll(() => sent).toBe(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  // force: Playwright waits out aria-disabled, and these clicks are meant to land on an inert control.
  await dialog.getByRole('button', { name: 'Cancel' }).click({ force: true });
  await expect(dialog).toBeVisible();
  await confirm.click({ force: true });
  await confirm.press('Enter');
  await page.waitForTimeout(300);
  expect(sent).toBe(1);
  await expect(notes).not.toBeEditable();
  await notes.press('End');
  await page.keyboard.type('zzz');
  await expect(notes).toHaveValue('c6 inflight release');

  release();
  await expect(dialog.getByTestId('fw-promote-done')).toBeVisible();
  expect(sent).toBe(1);
});

test('Promote with the connection dropped: the failure is said, Promote is armed again, Cancel closes', async ({ page }) => {
  const version = await publishTestReleaseWithBlob('0.0.0+e2e64', { notes: 'TEST build c6 abort' });
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware');
  await page.route(PROMOTE_URL, (route) => route.abort());
  const dialog = await openPromote(page, version);
  const confirm = dialog.getByTestId('fw-promote-confirm');
  await dialog.getByTestId('fw-promote-notes').fill('c6 abort release');
  await confirm.click();
  await expect(dialog.getByTestId('fw-promote-error')).toHaveText('Could not reach the server. Check your connection and try again.');
  await expect(confirm).toHaveText('Promote');
  await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
  await expect(dialog.getByTestId('fw-promote-notes')).toBeEditable();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await page.unroute(PROMOTE_URL);
  const again = await openPromote(page, version);
  await again.getByTestId('fw-promote-notes').fill('c6 abort release');
  await again.getByTestId('fw-promote-confirm').click();
  await expect(again.getByTestId('fw-promote-done')).toBeVisible();
});

test('Promote on the default filter: the row turns into a Release at once, and Close hands focus to the heading', async ({ page }) => {
  const version = await publishTestReleaseWithBlob('0.0.0+e2e65', { notes: 'TEST build c6 all' });
  await signInAsSuperAdmin(page);
  await page.goto('/admin/firmware');
  const dialog = await openPromote(page, version);
  await dialog.getByTestId('fw-promote-notes').fill('c6 all release');
  await dialog.getByTestId('fw-promote-confirm').click();
  await expect(dialog.getByTestId('fw-promote-done')).toBeVisible();
  await expect(fwRow(page, version).getByTestId('fw-tag-release')).toBeVisible();
  await expect(page.getByTestId('fw-promote-done-close')).toBeFocused();
  await page.getByTestId('fw-promote-done-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('h1')).toBeFocused();
});

// ---- Phone (spec §9: only what the boards and today's specs pin; the full pass is C7) -------------------------

test('at 390 px: the bottom tab bar, admin-sections wrapped with every tab on screen, Invites stacked, nothing scrolls the page sideways', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsSuperAdmin(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const noSideways = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const [path] of PAGES) {
    await page.goto(path);
    await expect(page.getByTestId('admin-sections')).toBeVisible();
    const main = page.getByTestId('admin-header').getByRole('navigation', { name: 'Main' });
    expect((await main.boundingBox())!.y).toBeGreaterThan(844 - 120);   // the fixed bottom bar
    // C7 (spec §11.1, Ruling 10): the five tabs wrap onto two rows of 44 px instead of scrolling in the clamp.
    for (const s of await page.getByTestId('admin-sections').getByRole('link').all()) {
      const b = (await s.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(390 - 16 + 1);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    await noSideways();
  }

  await page.goto('/admin');
  const box = (id: string) => page.locator(`a:has(> [data-testid="${id}"])`).boundingBox();
  const [a, b, c] = [(await box('count-users'))!, (await box('count-orgs'))!, (await box('count-games'))!];
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);                     // two tiles per row
  expect(c.y).toBeGreaterThan(a.y + a.height - 1);
  const fw = (await page.getByRole('heading', { name: 'Boards by firmware' }).boundingBox())!;
  const att = (await page.getByRole('heading', { name: 'Needs attention' }).boundingBox())!;
  expect(att.y).toBeGreaterThan(fw.y);                              // the cards stack

  // Users and (C7 Ruling 9) Invites stack their rows below sm: nothing scrolls inside the card.
  await page.goto('/admin/invites');
  expect(await page.locator('section[aria-label="Invite codes"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);

  await page.goto('/admin/firmware');
  const first = page.getByTestId('firmware-release-row').first();
  await expect(first.locator('[data-fw-part="right"]')).toBeVisible();
  const left = (await first.locator('[data-fw-part="left"]').boundingBox())!;
  const right = (await first.locator('[data-fw-part="right"]').boundingBox())!;
  expect(right.y).toBeGreaterThan(left.y + left.height - 1);       // a column below md
  await noSideways();
});

// ---- Phone, carried from the Task 1-3 reviews ---------------------------------------------------------------

test('at 390 px: an Overview firmware row keeps a usable bar (the label and count stack above it)', async ({ page }) => {
  test.setTimeout(90_000);
  const u = await signUpFresh(page);
  await seedDevices(u.orgId, 1, '0.0.0+e2e-c6-bar');
  await page.context().clearCookies();
  await signInAsSuperAdmin(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  const row = page.locator('[data-testid="fw-dist-row"][data-version="0.0.0+e2e-c6-bar"]');
  await expect(row).toBeVisible();
  const bar = (await row.locator('[data-fw-bar]').boundingBox())!;
  const label = (await row.locator('> span').first().boundingBox())!;
  expect(bar.width, 'the bar is at least 120 px').toBeGreaterThanOrEqual(120);
  expect(bar.y, 'the bar sits below the label').toBeGreaterThan(label.y + label.height - 1);
  const o = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(o).toBe(true);
});

test('at 390 px: Users rows stack, so Delete… is inside the viewport without scrolling the card sideways', async ({ page }) => {
  test.setTimeout(90_000);
  const u = await signUpFresh(page);
  await page.context().clearCookies();
  await signInAsSuperAdmin(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAdminUserRow(page, u.email);
  const row = page.locator(`[data-testid="admin-user-row"][data-email="${u.email}"]`);
  await expect(row.locator('[data-testid^="delete-user-"]')).toBeVisible();
  const del = (await row.locator('[data-testid^="delete-user-"]').boundingBox())!;
  expect(del.x).toBeGreaterThanOrEqual(0);
  expect(del.x + del.width, 'Delete… ends inside the 390 px viewport').toBeLessThanOrEqual(390);
  expect(await page.locator('section[aria-label="Users"] > div').first().evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
  // It is still a table to a screen reader, and the desktop columns come back at 1280.
  await expect(page.locator('section[aria-label="Users"]').getByRole('row').first()).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('section[aria-label="Users"] th')).toHaveCount(7);
  await expect(page.locator('section[aria-label="Users"] th').first()).toBeVisible();
});
