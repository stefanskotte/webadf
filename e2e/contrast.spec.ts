import { test, expect, type Page } from '@playwright/test';

/**
 * Contrast, measured off the rendered page rather than reviewed by eye.
 *
 * Both defects this file guards shipped through review, a green build and a
 * green suite, because neither is visible in the source of the file that
 * causes it:
 *
 *  - /sign-in and /sign-up were the only pages with no shell and no
 *    surface, so shadcn's `--foreground` (#252525, which assumes a white
 *    page) landed on the old dark gradient's top (#1b2534). Measured 1.01:1
 *    -- the heading was the same colour as the thing behind it. Since Phase B
 *    the page is the flat cream ground (#F3EFE6) under ink, and cards are the
 *    surface (#FFFDF8); the same probe guards that nothing light lands on it.
 *  - sonner resolved `theme="system"` from prefers-color-scheme (no
 *    ThemeProvider is mounted, so useTheme fell back), which applies a
 *    HARD-CODED #e8e8e8 description colour, while the toast background
 *    stayed white because that half IS tokenised. 1.23:1, title unaffected.
 *
 * The lesson worth keeping: a colour can arrive from a stylesheet no file in
 * this repo names. Assert the composited pixels.
 */
import { randomUUID } from 'node:crypto';
import { signUpFresh, runTag, openVersion, mintInviteCode } from './helpers';
import { cleanupSeeded, seedDisk, pairDevice, authHeader, openBoardSettings, hydrated, seedDevices, publishTestRelease, cleanupTestReleases } from './device-helpers';
import { readCurrentRelease } from '@/lib/firmware-releases';
import { revokeInvite } from '@/lib/invites';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';
import { getDb } from '@/db';
import { blobs, disks } from '@/db/schema/catalog';
import { formatVolume } from '@/lib/adffs/format';
import { diskStore } from '@/lib/storage';
import { devices } from '@/db/schema/devices';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { signInAsSuperAdmin, SUPERADMIN_EMAIL, gotoAdminUserRow } from './admin-helpers';
import { boardSays, boardOpens, boardSendsChunks, boardTakesNext, boardUploads } from './amiga-board';
import { zipSync } from 'fflate';

// Transfers and Amiga uploads made here belong to a fresh org: cleanupSeeded() removes its boards and the org.
test.afterAll(async () => {
  await cleanupTestReleases();
  await cleanupTosec(); await cleanupSeeded();
});

/**
 * The element's own rendered colour, over what is actually composited
 * behind it. Measured from the live page rather than from the stylesheet,
 * because the whole bug class here is a colour arriving from somewhere the
 * source does not obviously name.
 */
async function probe(page: Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    // Rasterise, do not string-match. This app declares colours in oklch(),
    // and a browser may hand any of them back from getComputedStyle in
    // oklch() OR lab() -- sonner's white toast computes to `lab(100 0 0)`.
    // No rgb() regex reads those, and canvas fillStyle echoes them back
    // verbatim rather than converting. Painting one pixel and reading it is
    // the only conversion that works for every colour space, and it is also
    // what the screen actually shows.
    const ctx = document.createElement('canvas').getContext('2d')!;
    const SENTINEL = '#010203';
    const parse = (v: string) => {
      if (!v || v === 'transparent') return null;
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = v;
      // An unparseable value leaves fillStyle untouched; without this check
      // it would silently read as a real, opaque #010203.
      if (ctx.fillStyle === SENTINEL && v.toLowerCase() !== SENTINEL) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    // Walk from the element outward (toward the root), collecting every
    // background along the way -- opaque or translucent -- stopping once
    // one is opaque enough (alpha > 0.5) to serve as a backstop with
    // nothing usable behind it.
    //
    // A translucent layer (e.g. the search panel's highlighted-row overlay,
    // rgb(30 45 60 / 0.08)) is real paint, not noise: skipping it entirely,
    // as an earlier version of this function did, silently measures the
    // PLAIN panel's colour instead of the highlighted one -- landing on a
    // higher, wrong ratio for exactly the row a bug is most likely to ship
    // on, since highlight defaults to index 0.
    const layers: number[][] = [];
    let node: Element | null = el;
    while (node) {
      const p = parse(getComputedStyle(node).backgroundColor);
      if (p) {
        layers.push(p);
        if (p[3] > 0.5) break;
      }
      node = node.parentElement;
    }
    if (layers.length === 0) return null;
    // layers[0] is nearest to the element (painted last, i.e. on top);
    // layers[last] is the opaque backstop (painted first, i.e. on the
    // bottom). Composite back-to-front with the standard "over" operator,
    // treating the backstop itself as fully opaque.
    const backstop = layers[layers.length - 1];
    let bg: number[] = [backstop[0], backstop[1], backstop[2], 1];
    for (let i = layers.length - 2; i >= 0; i--) {
      const top = layers[i];
      const a = top[3] + bg[3] * (1 - top[3]);
      bg = [
        (top[0] * top[3] + bg[0] * bg[3] * (1 - top[3])) / a,
        (top[1] * top[3] + bg[1] * bg[3] * (1 - top[3])) / a,
        (top[2] * top[3] + bg[2] * bg[3] * (1 - top[3])) / a,
        a,
      ];
    }
    const fg = parse(getComputedStyle(el).color);
    if (!fg || !bg) return null;
    return { fg, bg, text: el.textContent ?? '' };
  }, sel);
}

function ratio(fg: number[], bg: number[]) {
  const lum = (c: number[]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** C5: probe each [name, selector] and require AA. The selector must find a painted element; never loosen 4.5. */
async function legible(page: Page, area: string, pairs: ReadonlyArray<readonly [string, string]>) {
  for (const [name, sel] of pairs) {
    const p = await probe(page, sel);
    expect(p, `${area}: ${name} (${sel}) not found or transparent`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`${area.padEnd(9)} ${name.padEnd(36)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 32)}"`);
    expect(r, `${area}: ${name}`).toBeGreaterThan(4.5);
  }
}

for (const path of ['/sign-in', '/sign-up']) {
  test(`${path} text is legible on the ground`, async ({ page }) => {
    await page.goto(path);
    for (const sel of ['h1', 'label[for="email"]', 'label[for="password"]', 'button[type="submit"]']) {
      const p = await probe(page, sel);
      expect(p, `${sel} not found or transparent`).toBeTruthy();
      const r = ratio(p!.fg, p!.bg);
      console.log(`${path.padEnd(9)} ${sel.padEnd(24)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 24)}"`);
      expect(r, `${sel} contrast`).toBeGreaterThan(4.5);
    }
    await page.screenshot({ path: `test-results/zz${path.replace('/', '-')}.png` });
  });
}

test('the shell and an empty library are legible on the new ground', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  await expect(page.getByTestId('game-grid')).toBeVisible();
  for (const sel of ['[data-testid=wordmark-home]', 'header nav a:not([aria-current])', 'h1',
                     '[data-testid=game-grid] p:nth-of-type(2)', '[data-testid=sign-out]']) {
    const p = await probe(page, sel);
    expect(p, `${sel} not found or transparent`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`library   ${sel.padEnd(40)} ${r.toFixed(2)}:1`);
    expect(r, `${sel} contrast`).toBeGreaterThan(4.5);
  }
  await page.screenshot({ path: 'test-results/zz-library-ground.png', fullPage: true });
});

// Phase C1 (spec §9): the library's new text pairs, measured off a seeded library with a typed, a held and an untyped
// title. Grid first, then the table (the held row's --mounted-bg).
test('the library card and row pairs are legible: type pill, DF0 pill, count line, held row', async ({ page, request }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const sha = (k: string) => createHash('sha256').update(`contrast-${k}-${run}`).digest('hex');
  const typed = await seedDisk(u.orgId, { title: `Alpha ${run}`, diskNo: 1, sha256: sha('typed') });
  const entryId = await seedTosecEntry({
    setName: 'Commodore Amiga - Games - [ADF]', gameName: `Alpha ${run} (1992)(Test)`, romName: `alpha-${run}.adf`,
    title: `Alpha ${run}`, sortTitle: `typed ${run}`.toLowerCase(), year: 1992,
  });
  await getDb().update(blobs).set({ tosecEntryId: entryId, matchState: 'matched', matchCheckedAt: new Date() })
    .where(eq(blobs.sha256, sha('typed')));
  await seedDisk(u.orgId, { title: `Plain ${run}`, diskNo: 1, sha256: sha('untyped') });
  const held = await seedDisk(u.orgId, { title: `Held ${run}`, diskNo: 1, sha256: sha('held') });
  const { deviceId, token } = await pairDevice(page, request, `Bench ${run.slice(0, 6)}`);
  await getDb().update(devices).set({ desiredDiskId: held.diskId, desiredSha256: sha('held'), desiredVersion: 1 })
    .where(eq(devices.id, deviceId));
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: sha('held'), mountedDiskId: held.diskId, version: 1 },
  })).status()).toBe(204);

  await page.goto('/library?view=grid');
  const cards = page.getByTestId('game-card');
  await expect(cards.filter({ hasText: `Alpha ${run}` })).toBeVisible();
  await expect(cards.filter({ hasText: `Held ${run}` }).getByTestId('drive-badge')).toBeVisible();
  const tag = (id: string, sel: string) => `[data-testid=game-card][aria-label="${id}"] ${sel}`;
  for (const [what, sel] of [
    ['type pill', tag(`Alpha ${run}`, '[data-testid=grid-kind]')],
    ['DF0 pill', tag(`Held ${run}`, '[data-testid=drive-badge]')],
    ['count line (typed)', tag(`Alpha ${run}`, '[data-testid=grid-disks]')],
    ['count line (untyped)', tag(`Plain ${run}`, '[data-testid=grid-disks]')],
  ] as const) {
    const p = await probe(page, sel);
    expect(p, `${what}: ${sel} not found`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`card      ${what.padEnd(22)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 24)}"`);
    expect(r, what).toBeGreaterThan(4.5);
  }
  await page.screenshot({ path: 'test-results/zz-library-cards.png', fullPage: true });

  await page.goto('/library?view=table');
  await expect(page.getByTestId('game-row').filter({ hasText: `Held ${run}` })).toHaveAttribute('data-drive', 'mounted');
  for (const [what, sel] of [
    ['held row muted-2', '[data-testid=game-row][data-drive=mounted] span[style*="--muted-2"]'],
    ['DF0 pill (row)', '[data-testid=game-row][data-drive=mounted] [data-testid=drive-badge]'],
  ] as const) {
    const p = await probe(page, sel);
    expect(p, `${what}: ${sel} not found`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`row       ${what.padEnd(22)} ${r.toFixed(2)}:1`);
    expect(r, what).toBeGreaterThan(4.5);
  }
});

test('the admin sans subtitle (--muted on the ground) is legible', async ({ page }) => {
  // No admin page sets subtitleFont="sans" until C6 Tasks 2 and 5. So take the live subtitle element of
  // /admin/invites (real ground behind it) and give it exactly what the sans variant gives it: --muted.
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  const sub = 'div:has(> h1) + span';
  await page.locator(sub).evaluate((el) => { (el as HTMLElement).style.color = 'var(--muted)'; });
  await legible(page, 'admin', [['sans subtitle, --muted', sub]]);
});

test('a toast description is legible', async ({ page }) => {
  await signUpFresh(page);
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  // Force the fetch to fail: that is the branch raising a toast WITH a
  // description. The success path renders the code inline instead.
  await page.route('**/api/admin/invites', (r) => r.abort());
  await page.getByRole('button', { name: /issue an invite/i }).click();

  await expect(page.locator('[data-description]').first()).toBeVisible({ timeout: 10_000 });
  // Let the entrance animation finish: a toast measured mid-fade reports the
  // colour it is heading towards, but photographs as something else.
  await page.waitForTimeout(600);
  const p = await probe(page, '[data-description]');
  expect(p, 'toast description not found').toBeTruthy();
  const r = ratio(p!.fg, p!.bg);
  console.log(`toast     [data-description]     ${r.toFixed(2)}:1  "${p!.text.slice(0, 40)}"`);
  await page.screenshot({ path: 'test-results/zz-toast.png' });
  expect(r).toBeGreaterThan(4.5);
});

test('the search panel metadata line is legible while its row is highlighted', async ({ page }) => {
  // The panel's own comment (search-box.tsx) works out the math for this
  // exact case: the panel is the opaque surface (#FFFDF8), so the page
  // never shows through, and the highlighted row is surface-2 (#F6F2E9).
  // --muted (#5B5446, not --muted-2) is what the metadata line uses there,
  // landing at 6.71:1. probe() composites any translucent layer between
  // the text and the first opaque one rather than skipping it, so this
  // measures the real highlighted-row pixels, not the plain panel under them.
  // Highlight defaults to index 0, so the TOP row -- the one this test
  // reads -- is highlighted by default, not an edge case reached only by
  // hovering.
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, {
    title: `Contrast Row ${run}`, diskNo: 1,
    sha256: randomUUID().replace(/-/g, '').padEnd(64, 'c'),
  });

  await page.getByTestId('search-input').fill('Contrast Row');
  await expect(page.getByTestId('search-result').first()).toBeVisible();

  // The sub line of the top, highlighted-by-default row (the DiskIcon now comes first in the row, so span:last-child
  // would land on its label).
  const p = await probe(page, '[data-testid="search-result-sub"]');
  expect(p, 'search result metadata line not found').toBeTruthy();
  const r = ratio(p!.fg, p!.bg);
  console.log(`search    metadata line                  ${r.toFixed(2)}:1  "${p!.text.slice(0, 40)}"`);
  expect(r).toBeGreaterThan(4.5);
});

/**
 * A focused control's indicator, composited over what is behind the control,
 * against that same background (WCAG 1.4.11 wants 3:1). The indicator is the
 * outline when it has one, else the widest box-shadow ring (Tailwind's
 * `ring-*`). Half-strength `--ring` (`outline-ring/50`, `ring-ring/50`)
 * blended to ~2:1 on the cream bar (Task 4's review, 2026-10-24).
 */
async function focusIndicator(page: Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el || document.activeElement !== el) return { error: `${s} is not focused` };
    // Button has transition-all: read the ring where it lands, not mid-fade.
    for (const a of el.getAnimations()) a.finish();
    const ctx = document.createElement('canvas').getContext('2d')!;
    const SENTINEL = '#010203';
    const parse = (v: string) => {
      if (!v || v === 'transparent') return null;
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = v;
      if (ctx.fillStyle === SENTINEL && v.toLowerCase() !== SENTINEL) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const cs = getComputedStyle(el);
    let indicator: number[] | null = null;
    let kind = `none (focus-visible ${el.matches(':focus-visible')}, box-shadow ${cs.boxShadow})`;
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) {
      indicator = parse(cs.outlineColor);
      kind = `outline ${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
    }
    if (!indicator || indicator[3] === 0) {
      // Split the shadow list on top-level commas; Chromium writes each
      // shadow's colour first.
      const shadows: string[] = [];
      let depth = 0, cur = '';
      for (const ch of cs.boxShadow) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { shadows.push(cur.trim()); cur = ''; } else cur += ch;
      }
      if (cur.trim()) shadows.push(cur.trim());
      let best = 0;
      for (const sh of shadows) {
        const m = sh.match(/^([a-z-]+\([^)]*\)|#[0-9a-f]+)\s+(.*)$/i);
        if (!m) continue;
        const lengths = m[2].split(/\s+/).map(parseFloat);
        const spread = lengths[3] ?? 0;
        const c = parse(m[1]);
        if (c && c[3] > 0 && spread > best) { best = spread; indicator = c; kind = `ring ${sh}`; }
      }
    }
    // What the indicator is drawn over: the control's surroundings, not
    // the control itself.
    const layers: number[][] = [];
    let node: Element | null = el.parentElement;
    while (node) {
      const p = parse(getComputedStyle(node).backgroundColor);
      if (p) { layers.push(p); if (p[3] > 0.5) break; }
      node = node.parentElement;
    }
    const over = (top: number[], bg: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + bg[i] * (1 - top[3]));
    let bg = [...layers[layers.length - 1].slice(0, 3)];
    for (let i = layers.length - 2; i >= 0; i--) bg = over(layers[i], bg);
    return { kind, indicator: indicator ? over(indicator, bg) : null, bg };
  }, sel);
}

test('header focus indicators clear 3:1 against the bar', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/library');
  // A key press first, so programmatic focus counts as keyboard focus and
  // :focus-visible applies the way it does for a Tab.
  await page.keyboard.press('Tab');
  for (const sel of [
    'header nav a:not([aria-current])', // .seg-item
    '[data-testid=settings-link]',
    '[data-testid=sign-out]',
    '[data-testid=search-input]',
  ]) {
    await page.locator(sel).first().focus();
    const f = await focusIndicator(page, sel);
    expect('error' in f ? f.error : null, sel).toBeNull();
    const { kind, indicator, bg } = f as { kind: string; indicator: number[] | null; bg: number[] };
    // Soft, so one run reports every control rather than the first.
    expect.soft(indicator, `${sel}: no visible focus indicator (${kind})`).toBeTruthy();
    if (!indicator) continue;
    const r = ratio(indicator, bg);
    console.log(`focus     ${sel.padEnd(38)} ${r.toFixed(2)}:1  ${kind}`);
    expect.soft(r, `${sel} focus indicator (${kind})`).toBeGreaterThanOrEqual(3);
  }
});

// Phase C2 (spec §12): the Devices pairs, measured on the real elements of a seeded org -- one online board holding a
// disk, one offline board, and a Network board with a not-OK checklist mark -- then a modal footer.
test('the Devices pairs are legible: drive box, tile caption, offline strip, pills, checklist mark, DF1 tile, modal footer', async ({ page, request }) => {
  const run = runTag();
  const u = await signUpFresh(page);
  const sha = createHash('sha256').update(`contrast-dev-${run}`).digest('hex');
  const disk = await seedDisk(u.orgId, { title: `Devices ${run}`, diskNo: 1, sha256: sha });
  const online = await pairDevice(page, request, `On ${run.slice(0, 6)}`);
  await getDb().update(devices).set({ desiredDiskId: disk.diskId, desiredSha256: sha, desiredVersion: 1 })
    .where(eq(devices.id, online.deviceId));
  expect((await request.post('/api/device/status', {
    headers: authHeader(online.token), data: { mountedSha256: sha, mountedDiskId: disk.diskId, version: 1, displayLayouts: true, displayVersion: 0 },
  })).status()).toBe(204);
  await getDb().update(devices).set({ lastError: 'Disk read failed on the board', lastErrorAt: new Date() })
    .where(eq(devices.id, online.deviceId));
  const off = await pairDevice(page, request, `Off ${run.slice(0, 6)}`);
  await getDb().update(devices).set({ lastSeenAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(devices.id, off.deviceId));
  const net = await pairDevice(page, request, `Net ${run.slice(0, 6)}`);
  const fw = '1.11.0+gabc1234';
  const st = (data: Record<string, unknown>) => request.post('/api/device/status', { headers: authHeader(net.token), data });
  expect((await st({ mountedSha256: null, firmwareVersion: fw, secondDrive: 'off', driveVersion: 0, sel1Wired: true, df1Seen: false })).status()).toBe(204);
  expect((await page.request.patch(`/api/devices/${net.deviceId}/second-drive`, { data: { mode: 'net' } })).status()).toBe(200);
  expect((await st({ mountedSha256: null, firmwareVersion: fw, secondDrive: 'net', driveVersion: 1, net: { framesIn: 0, framesOut: 0 } })).status()).toBe(204);

  await page.goto('/devices');
  await expect(page.getByTestId(`net-checklist-${net.deviceId}`)).toBeVisible();
  await expect(page.getByTestId(`device-offline-${off.deviceId}`)).toBeVisible();
  const pairs: [string, string][] = [
    ['drive-box label', `[data-testid="device-disk-${online.deviceId}"] div.flex-1 > span:first-child`],
    ['tile caption', `[data-testid="device-bezel-${online.deviceId}"] > div:last-child > span:first-child`],
    ['offline strip heading', `[data-testid="device-offline-${off.deviceId}"] p:nth-of-type(1)`],
    ['offline strip body', `[data-testid="device-offline-${off.deviceId}"] p:nth-of-type(2)`],
    ['Online pill', `[data-testid="device-status-${online.deviceId}"]`],
    ['Offline pill', `[data-testid="device-status-${off.deviceId}"]`],
    ['not-OK checklist mark', `[data-testid="net-checklist-${net.deviceId}"] li[data-ok="false"] > span:first-child`],
    ['not-OK checklist line', `[data-testid="net-checklist-${net.deviceId}"] li[data-ok="false"] > span:nth-child(2) > span:last-child`],
    ['last error (danger-fg on danger-bg)', `[data-testid="device-error-${online.deviceId}"]`],
    ['DF1 tile', `[data-testid="device-df1-${online.deviceId}"] span[style*="--track"]`],
  ];
  for (const [what, sel] of pairs) {
    const p = await probe(page, sel);
    expect(p, `${what}: ${sel} not found`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`devices   ${what.padEnd(24)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 24)}"`);
    expect(r, what).toBeGreaterThan(4.5);
  }
  await page.screenshot({ path: 'test-results/zz-devices.png', fullPage: true });

  await openBoardSettings(page, online.deviceId);
  const cancel = await probe(page, '[data-testid="board-settings-cancel"]');
  expect(cancel, 'modal footer Cancel not found').toBeTruthy();
  const rc = ratio(cancel!.fg, cancel!.bg);
  console.log(`devices   modal footer Cancel      ${rc.toFixed(2)}:1`);
  expect(rc, 'modal footer Cancel').toBeGreaterThan(4.5);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-settings-dialog')).toHaveCount(0);

  // The Board display modal: hide the first element (its row sits on --modal-foot, its hint is --muted-2) and the
  // Unsaved pill (--warning-fg on --warning-bg) appears.
  await hydrated(page, `display-toggle-${online.deviceId}`);
  await page.getByTestId(`display-toggle-${online.deviceId}`).click();
  const editor = page.getByTestId(`display-editor-${online.deviceId}`);
  await expect(editor).toBeVisible();
  await editor.locator('input[data-testid^="display-visible-"]').first().uncheck();
  await expect(page.getByTestId(`display-unsaved-${online.deviceId}`)).toBeVisible();
  const row = `[data-testid="display-editor-${online.deviceId}"] ul > li:first-child`;
  for (const [what, sel] of [
    ['hidden element hint (muted-2 on modal-foot)', `${row} label > span:last-child > span:last-child`],
    ['Unsaved pill (warning-fg on warning-bg)', `[data-testid="display-unsaved-${online.deviceId}"]`],
  ] as const) {
    const p = await probe(page, sel);
    expect(p, `${what}: ${sel} not found`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`devices   ${what.padEnd(24)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 24)}"`);
    expect(r, what).toBeGreaterThan(4.5);
  }
});

// Files increment 3 (Task 7): the Upload page retired into Files (NET:, the Send drop zone) and the Library (Add disks
// ▾, the drop overlay, the tray), so its pairs are measured there now. NET: at 1280 x 900: the Send zone (title, hint,
// board line, receiver line), a board row's marks and a queue row's state marks (Waiting, Delivered · saved as …,
// Failed · …), one style each, each measured. Every row belongs to this test's own org.

/** Marks a pane row's mark span reading `text` for probe(): the marks share one class list, so they are told by text. */
async function tagMark(page: Page, side: 'left' | 'right', name: string, text: string, tag: string) {
  await page.evaluate(({ side, name, text, tag }) => {
    const row = document.querySelector(`[data-testid="pane-${side}"] [data-testid="pane-row"][data-name="${name}"]`);
    const m = [...(row?.querySelectorAll('span.rounded-full.border') ?? [])].find((s) => s.textContent === text);
    m?.setAttribute('data-probe', tag);
  }, { side, name, text, tag });
  return `[data-probe="${tag}"]`;
}

test('the Files NET: pairs are legible: Send zone title, hint, board and receiver lines; board marks; queue state marks', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  for (const name of ['Wait.txt', 'Done.txt', 'Full.txt']) {
    expect((await page.request.post(`/api/transfers?deviceId=${deviceId}&name=${name}`, { data: Buffer.from(name),
      headers: { 'content-type': 'application/octet-stream' } })).status()).toBe(201);
  }
  // The oldest two taken: Wait.txt was queued first, so it is delivered; Done.txt fails; Full.txt waits.
  await boardTakesNext(request, token, { ok: true, savedAs: 'Wait_2.txt' });
  await boardTakesNext(request, token, { ok: false, code: 'space', text: 'disk full' });
  await page.goto(`/files?${new URLSearchParams({ left: 'NET:', right: `NET:/${deviceId}`, active: 'right' })}`);
  await hydrated(page, 'files-manager', 'onKeyDown');
  await expect(page.getByTestId('files-send-receiver')).toBeVisible();
  await expect(page.locator('[data-testid="pane-right"] [data-testid="pane-row"][data-name="Wait.txt"]')).toContainText('Delivered', { timeout: 15_000 });
  await page.mouse.move(0, 0);
  await legible(page, 'net', [
    ['Send zone title', '#files-drop-send-heading'],
    ['Send zone hint', '[data-testid="files-drop-send-hint"]'],
    ['board line', '[data-testid="files-send-board"]'],
    ['receiver line', '[data-testid="files-send-receiver"]'],
    ['board "key AB12" mark', await tagMark(page, 'left', 'Bench', 'key AB12', 'key')],
    ['board "1 waiting" mark', await tagMark(page, 'left', 'Bench', '1 waiting', 'waiting')],
    ['"Waiting" mark', await tagMark(page, 'right', 'Full.txt', 'Waiting', 'w')],
    ['"Delivered · saved as" mark', await tagMark(page, 'right', 'Wait.txt', 'Delivered · saved as Wait_2.txt', 'd')],
    ['"Failed · …" mark', await tagMark(page, 'right', 'Done.txt', 'Failed · not enough space on the Amiga', 'f')],
  ]);
  await page.screenshot({ path: 'test-results/zz-files-net.png', fullPage: true });
});

// Task 7 review carry: the old Upload test also measured the From the Amiga side -- a failed status, the size column,
// the Delete button and a hovered row's line. Those are STASH: rows in Files now, measured here at 1280 x 900 on this
// test's own org. (The "from" and "arriving" marks and the STASH: zone are the STASH: block's, below.)
test('the Files STASH: row pairs are legible: the failed mark, size, Delete, a hovered row', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await boardUploads(request, token, 'Keep.txt', Buffer.from('kept bytes!'));
  const moving = await boardOpens(request, token, 'Moving.bin', 20_000);
  await boardSendsChunks(request, token, moving.id, Buffer.alloc(20_000, 1), 0, 1);
  const bad = Buffer.from('broken');
  const failed = await boardOpens(request, token, 'Bad.txt', bad.length);
  await boardSendsChunks(request, token, failed.id, bad);
  expect((await request.post(`/api/device/upload/${failed.id}/close`, { headers: authHeader(token), data: { crc32: 1 } })).status()).toBe(409);
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: 'LIBRARY:', active: 'left' })}`);
  await hydrated(page, 'files-manager', 'onKeyDown');
  const row = (name: string) => `[data-testid="pane-left"] [data-testid="pane-row"][data-name="${name}"]`;
  await expect(page.locator(row('Moving.bin'))).toContainText('arriving 81%', { timeout: 15_000 });
  await page.locator(row('Keep.txt')).click();
  await expect(page.getByTestId('files-delete')).toBeEnabled();
  await page.mouse.move(0, 0);
  await legible(page, 'stash', [
    ['"failed — …" mark', await tagMark(page, 'left', 'Bad.txt', 'failed — damaged on the way: send it again', 'fail')],
    ['size', `${row('Moving.bin')} td:nth-child(3)`],
    ['size on the selected row', `${row('Keep.txt')} td:nth-child(3)`],
    ['Delete', '[data-testid="files-delete"]'],
  ]);
  // A hovered row sits on --surface-2: its size, date and marks still read.
  await page.locator(row('Moving.bin')).hover();
  await legible(page, 'stash', [
    ['size on a hovered row', `${row('Moving.bin')} td:nth-child(3)`],
    ['date on a hovered row', `${row('Moving.bin')} td:nth-child(5)`],
    ['mark on a hovered row', await tagMark(page, 'left', 'Moving.bin', 'arriving 81%', 'arr')],
  ]);
  await page.screenshot({ path: 'test-results/zz-files-stash.png', fullPage: true });
});

// The Library's own way in (Files increment 3, R8/R9): Add disks ▾ and its menu, the drop overlay's words over the
// scrim, and the tray (summary, Added, Already in the library, Refused — why, Open title) at 1280 x 900.
test('the Library add pairs are legible: Add disks, its menu, the drop overlay, the tray summary and row states', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  await page.goto('/library');
  await hydrated(page, 'library-add-disks', 'onClick');
  await legible(page, 'library', [['Add disks', '[data-testid="library-add-disks"]']]);
  await page.getByTestId('library-add-disks').click();
  await expect(page.getByTestId('library-add-disks-panel')).toBeVisible();
  await legible(page, 'library', [
    ['menu Browse files…', '[data-testid="library-add-browse"]'],
    ['menu Paste a URL…', '[data-testid="library-add-url"]'],
  ]);
  await page.keyboard.press('Escape');

  // The overlay, raised by a drag over the page.
  await page.waitForFunction(() => document.querySelector('[data-testid="library-drop-target"]')?.getAttribute('data-native-drop') === 'ready');
  await page.evaluate(() => {
    const e = new Event('dragenter', { bubbles: true, cancelable: true });
    (e as unknown as { dataTransfer: unknown }).dataTransfer = { types: ['Files'], items: [{ kind: 'file' }], dropEffect: 'none' };
    document.body.dispatchEvent(e);
  });
  await expect(page.getByTestId('library-drop-overlay')).toBeVisible();
  await legible(page, 'library', [
    ['overlay title', '[data-testid="library-drop-overlay"] h3'],
    ['overlay kinds line', '[data-testid="library-drop-overlay"] p'],
  ]);
  await page.evaluate(() => {
    const e = new Event('dragleave', { bubbles: true, cancelable: true });
    (e as unknown as { dataTransfer: unknown }).dataTransfer = { types: ['Files'], items: [{ kind: 'file' }], dropEffect: 'none' };
    document.body.dispatchEvent(e);
  });
  await expect(page.getByTestId('library-drop-overlay')).toHaveCount(0);

  // The tray: one added, then the same again (already in the library) beside a refused text file.
  const adf = Buffer.alloc(901_120);
  adf.write(`DOS\0contrast-${runTag()}`, 0);
  const sha = createHash('sha256').update(adf).digest('hex');
  const pick = (files: { name: string; buffer: Buffer }[]) => page.getByTestId('file-input')
    .setInputFiles(files.map((f) => ({ ...f, mimeType: 'application/octet-stream' })));
  await pick([{ name: 'Contrast (1990)(X).adf', buffer: adf }]);
  await expect(page.getByTestId('library-tray-summary')).toHaveText('1 added', { timeout: 30_000 });
  await legible(page, 'library', [
    ['tray "Added"', `[data-key="lib:${sha}"] [data-testid="library-tray-state"]`],
    ['tray Open title', `[data-testid="library-tray-open-${sha}"]`],
  ]);
  await pick([{ name: 'Contrast (1990)(X).adf', buffer: adf }, { name: 'notes.txt', buffer: Buffer.from('not a disk') }]);
  await expect(page.getByTestId('library-tray-summary')).toHaveText(/already in the library/, { timeout: 30_000 });
  await page.mouse.move(0, 0);
  await legible(page, 'library', [
    ['tray summary', '[data-testid="library-tray-summary"]'],
    ['tray "Already in the library"', '[data-testid="library-tray-row"][data-state="deduped"] [data-testid="library-tray-state"]'],
    ['tray "Refused — why"', '[data-testid="library-tray-row"][data-state="failed"] [data-testid="library-tray-state"]'],
  ]);
  await page.screenshot({ path: 'test-results/zz-library-add.png', fullPage: true });
});

// Files increment 1 (Task 11): the Files pairs at 1280 x 900, on a fresh org's own disks -- the active and inactive
// pane headers, a selected row, the button column, the current sort head, the strip's drive chip, the read-only line,
// the "new in vN" mark, and the strip's History. Replaces the Browse page's Disk files block (C4): its head page now
// redirects here. The per-version page (?version=N) is still the Browse page, so its banner is measured as before.
test('the Files pairs are legible: pane headers, selected row, buttons, sort head, drive chip, read-only line, History', async ({ page, request }) => {
  test.setTimeout(90_000);   // a sign-up, two stored disks, four edits and a few dozen probes
  await page.setViewportSize({ width: 1280, height: 900 });
  const u = await signUpFresh(page);
  const run = runTag();
  const stored = async (title: string) => {
    const adf = formatVolume({ filesystem: 'FFS', volumeName: title.slice(0, 20) });
    const sha256 = createHash('sha256').update(adf).digest('hex');
    await diskStore.put(sha256, adf);
    return { sha256, ...(await seedDisk(u.orgId, { title, diskNo: 1, sha256, writeProtected: false })) };
  };
  // Distinct bytes per title: the volume name is in them.
  const own = await stored(`Contrast W ${run.slice(-6)}`);
  const held = await stored(`Contrast H ${run.slice(-6)}`);
  for (const name of ['Prog', 'Prog.info', 'Notes.txt']) {
    expect((await page.request.post(`/api/disks/${own.diskId}/files`, { multipart: { parentBlock: '880', name,
      file: { name, mimeType: 'application/octet-stream', buffer: Buffer.from(name) } } })).status()).toBe(200);
  }
  expect((await page.request.post(`/api/disks/${own.diskId}/files`, { multipart: { parentBlock: '880', name: 'Docs' } })).status()).toBe(200);
  const [h] = await getDb().select({ sha256: disks.sha256 }).from(disks).where(eq(disks.id, held.diskId));
  const { deviceId } = await pairDevice(page, request, `Contrast ${run.slice(-6)}`);
  await getDb().update(devices).set({
    lastSeenAt: new Date(), desiredGameId: held.gameId, desiredDiskId: held.diskId, desiredSha256: h.sha256, desiredDiskNo: 1,
    mountedGameId: held.gameId, mountedDiskId: held.diskId, mountedSha256: h.sha256, mountedDiskNo: 1,
  }).where(eq(devices.id, deviceId));

  // Left: the writable disk, active, Notes.txt selected. Right: the held disk, read-only.
  const left = `LIBRARY:/${own.gameId}/${own.diskId}`;
  const right = `LIBRARY:/${held.gameId}/${held.diskId}`;
  await page.goto(`/files?${new URLSearchParams({ left, right, active: 'left' })}`);
  await hydrated(page, 'files-manager', 'onKeyDown');
  await page.getByTestId('pane-left').locator('[data-testid="pane-row"][data-name="Notes.txt"]').click();
  await expect(page.getByTestId('files-delete')).toBeEnabled();
  await expect(page.getByTestId('files-copy')).toBeDisabled();   // the other side is read-only
  await page.mouse.move(0, 0);
  const sel = '[data-testid="pane-left"] [data-testid="pane-row"][aria-selected="true"]';
  await legible(page, 'files', [
    ['active header crumb', '[data-testid="pane-left"][data-active="true"] [data-testid="pane-left-crumb-2"]'],
    ['active header meta', '[data-testid="pane-left-meta"]'],
    ['inactive header crumb', '[data-testid="pane-right"][data-active="false"] [data-testid="pane-right-crumb-2"]'],
    ['inactive header meta', '[data-testid="pane-right-meta"]'],
    ['device button (current)', '[data-testid="pane-left-dev-LIBRARY"]'],
    ['selected row name', `${sel} td:nth-child(2) span.truncate`],
    ['selected row size', `${sel} td:nth-child(3)`],
    ['selected row date', `${sel} td:nth-child(5)`],
    ['row size', '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Prog"] td:nth-child(3)'],
    ['set protection bit', '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Prog"] td:nth-child(4) span > span:nth-child(5)'],
    ['clear protection bit', '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Prog"] td:nth-child(4) span > span:nth-child(1)'],
    ['DIR glyph', '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Docs"] td:nth-child(2) span[aria-hidden]'],
    ['EXE glyph', '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Prog"] td:nth-child(2) span[aria-hidden]'],
    ['new in vN', '[data-testid="pane-new-Prog"]'],
    ['sort head (current)', '[data-testid="pane-left-sort-name"] button'],
    ['sort head', '[data-testid="pane-left-sort-size"] button'],
    ['foot (selection)', '[data-testid="pane-left-foot"]'],
    ['button (enabled)', '[data-testid="files-delete"]'],
    ['button (Swap)', '[data-testid="files-swap"]'],
    ['drive chip', '[data-testid="disk-strip-left"] [data-testid="disk-strip-drive"]'],
    ['drive chip (held)', '[data-testid="disk-strip-right"] [data-testid="disk-strip-drive"]'],
    ['strip usage', '[data-testid="disk-strip-left"] [data-testid="disk-strip-usage"]'],
    ['read-only line (inactive pane)', '[data-testid="pane-right-readonly"]'],
  ]);
  // A disabled button is exempt (WCAG 1.4.3, inactive controls) and drawn at half opacity: measured with that
  // opacity, logged, and required to say why it is off.
  const off = await page.evaluate(() => {
    let a = 1;
    for (let n: Element | null = document.querySelector('[data-testid="files-copy"]'); n; n = n.parentElement) a *= Number(getComputedStyle(n).opacity);
    return a;
  });
  const copy = await probe(page, '[data-testid="files-copy"]');
  const blend = copy!.fg.slice(0, 3).map((v, i) => v * off + copy!.bg[i] * (1 - off));
  console.log(`files     ${'button (disabled, exempt)'.padEnd(36)} ${ratio(blend, copy!.bg).toFixed(2)}:1  at opacity ${off}`);
  await expect(page.getByTestId('files-copy')).toHaveAttribute('title', /in a drive/);
  // A hovered row (surface-2).
  await page.getByTestId('pane-left').locator('[data-testid="pane-row"][data-name="Prog"]').hover();
  await legible(page, 'files', [['size on a hovered row', '[data-testid="pane-left"] [data-testid="pane-row"][data-name="Prog"] td:nth-child(3)']]);

  // The right pane active: its read-only line and header on --viewing-bg.
  await page.getByTestId('pane-right-foot').click();
  await expect(page.getByTestId('pane-right')).toHaveAttribute('data-active', 'true');
  await page.mouse.move(0, 0);
  await legible(page, 'files', [
    ['read-only line (active pane)', '[data-testid="pane-right-readonly"]'],
    ['active header crumb (held)', '[data-testid="pane-right-crumb-2"]'],
  ]);

  // The strip's History over the left pane: Current, a version's time, the +N chip, Restore… on a hovered version.
  await page.getByTestId('disk-strip-left').getByTestId('disk-strip-history-toggle').click();
  const hist = page.getByTestId('disk-strip-history');
  await expect(hist).toBeVisible();
  await legible(page, 'history', [
    ['Current', '[data-testid="disk-strip-history"] [data-testid^="current-"]'],
    ['version time', '[data-testid="disk-strip-history"] [data-testid^="version-toggle-"] .font-mono'],
    ['+N chip', '[data-testid="disk-strip-history"] [data-testid^="version-counts-"] > span:first-child'],
  ]);
  await openVersion(page, 1);
  await hist.getByTestId('version-1').hover();
  await legible(page, 'history', [['Restore… on a hovered version', '[data-testid="restore-1"]']]);
  await page.screenshot({ path: 'test-results/zz-files.png', fullPage: true });

  // The per-version page (R3): the banner and the version on screen (--viewing-bg).
  await page.goto(`/disks/${own.diskId}/files?version=1`);
  await legible(page, 'version', [
    ['banner text', '[data-testid="version-banner"] > span'],
    ['viewed version time', '[data-testid="version-toggle-1"] .font-mono'],
  ]);
});

// Files increment 2 (Task 9): the STASH: pairs at 1280 x 900 -- the drop zone (title, hint, Browse files, the URL
// field), the row marks ("from <board>", "arriving N%", "can't open — …": one style, each measured), the row buttons
// Open and Add to library (--accent-blue at 11.5 px), the column's Add to library enabled and disabled, and an
// archive's read-only line. Every row belongs to this test's own org (its teardown removes them).
test('the Files STASH: pairs are legible: drop zone, marks, row buttons, Add to library, archive read-only line', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await boardUploads(request, token, 'Hi.txt', Buffer.from('hi'));
  const { id: moving } = await boardOpens(request, token, 'Moving.bin', 20_000);
  await boardSendsChunks(request, token, moving, Buffer.alloc(20_000, 1), 0, 1);   // 16 KB of 20: arriving 81%
  await page.goto(`/files?${new URLSearchParams({ left: 'STASH:', right: 'LIBRARY:', active: 'left' })}`);
  await hydrated(page, 'files-manager', 'onKeyDown');
  // A disk image (Add to library on its row) and a zip with one member whose name cannot be a STASH: name.
  const zip = zipSync({ 'ok.txt': new TextEncoder().encode('ok'), 'bad\u0001name.txt': new TextEncoder().encode('x') });
  await page.getByTestId('files-stash-input').setInputFiles([
    { name: 'Game.adf', mimeType: 'application/octet-stream', buffer: Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: `C${runTag().slice(-8)}` })) },
    { name: 'w.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) },
  ]);
  const r = (name: string) => `[data-testid="pane-left"] [data-testid="pane-row"][data-name="${name}"]`;
  await expect(page.locator(r('w.zip'))).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(r('Moving.bin'))).toContainText('arriving 81%');
  await page.getByTestId('files-stash-url-input').fill('https://example.org/demo.lha');   // typed, never fetched
  await page.locator(r('Game.adf')).click();
  await expect(page.getByTestId('files-addlib')).toBeEnabled();
  await page.mouse.move(0, 0);
  // The marks are the row's last spans: Moving.bin's "from Bench" then "arriving 81%".
  const mark = (name: string, n: number) => `${r(name)} td:nth-child(2) > span > span.rounded-full.border:nth-of-type(${n})`;
  await expect(page.locator(mark('Hi.txt', 3))).toHaveText('from Bench');
  await expect(page.locator(mark('Moving.bin', 4))).toHaveText('arriving 81%');
  await legible(page, 'stash', [
    ['zone title', '#files-drop-stash-heading'],
    ['zone hint', '[data-testid="files-drop-stash-hint"]'],
    ['Browse files', '[data-testid="files-stash-browse"] > span'],
    ['URL field (typed)', '[data-testid="files-stash-url-input"]'],
    ['Fetch', '[data-testid="files-stash-url-fetch"]'],
    ['"from <board>" mark', mark('Hi.txt', 3)],
    ['"arriving N%" mark', mark('Moving.bin', 4)],
    ['row Open (archive)', '[data-testid="pane-open-w.zip"]'],
    ['row Add to library', '[data-testid="pane-addlib-Game.adf"]'],
    ['Add to library (enabled)', '[data-testid="files-addlib"]'],
  ]);
  // The row buttons on a hovered row (surface-2).
  await page.locator(r('w.zip')).hover();
  await legible(page, 'stash', [['row Open on a hovered row', '[data-testid="pane-open-w.zip"]']]);

  // Add to library off (a text file picked): exempt, as every disabled button here, and says why.
  await page.locator(r('Hi.txt')).click();
  await expect(page.getByTestId('files-addlib')).toBeDisabled();
  await page.mouse.move(0, 0);
  // Polled: the button fades to its disabled opacity (transition-all), and mid-fade it reads lighter than it lands.
  const opacity = () => page.evaluate(() => {
    let a = 1;
    for (let n: Element | null = document.querySelector('[data-testid="files-addlib"]'); n; n = n.parentElement) a *= Number(getComputedStyle(n).opacity);
    return a;
  });
  await expect.poll(opacity).toBeLessThanOrEqual(0.5);
  const off = await opacity();
  const lib = await probe(page, '[data-testid="files-addlib"]');
  const blend = lib!.fg.slice(0, 3).map((v, i) => v * off + lib!.bg[i] * (1 - off));
  console.log(`stash     ${'Add to library (disabled, exempt)'.padEnd(36)} ${ratio(blend, lib!.bg).toFixed(2)}:1  at opacity ${off}`);
  await expect(page.getByTestId('files-addlib')).toHaveAttribute('title', /disk image/);

  // Inside the archive: the read-only line in the active pane, and a member it cannot open.
  await page.locator(r('w.zip')).dblclick();
  await expect(page.getByTestId('pane-left-readonly')).toHaveText('Archives are read-only — copy files out of them.');
  await expect(page.locator(r('bad_name.txt'))).toContainText("can't open — bad name");
  await page.mouse.move(0, 0);
  await legible(page, 'stash', [
    ['archive read-only line (active)', '[data-testid="pane-left-readonly"]'],
    ['"can\'t open — …" mark', `${r('bad_name.txt')} td:nth-child(2) span.rounded-full.border`],
  ]);
  await page.screenshot({ path: 'test-results/zz-files-stash.png', fullPage: true });
});

// Phase C5 spec §11: the "?" and its open popover (the ink card).
test('the "?" and its open popover are legible: glyph on the track, title, text and link on ink', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/settings');
  await hydrated(page, 'help-tip-preferences');
  await page.mouse.move(0, 0);
  await legible(page, 'help tip', [['"?" glyph (idle, on the track)', '[data-testid="help-tip-preferences"] > span']]);
  await page.getByTestId('help-tip-preferences').click();
  await expect(page.getByTestId('help-pop-preferences')).toBeVisible();
  await legible(page, 'popover', [
    ['"?" glyph (open, surface on ink)', '[data-testid="help-tip-preferences"] > span'],
    ['title', '[data-testid="help-pop-preferences"] h2'],
    ['text', '[data-testid="help-pop-preferences"] p'],
    ['Read the full topic', '[data-testid="help-more-preferences"]'],
  ]);
});

// Phase C5 spec §11, measured on real elements.
test('the Settings pairs are legible: hint, intro, radios, save line, state words, nav, Delete account', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  await page.goto('/settings');
  await hydrated(page, 'pref-start-page', 'onKeyDown');
  await page.mouse.move(0, 0);
  const hint = await page.getByTestId('pref-start-page').getAttribute('aria-describedby');
  await legible(page, 'settings', [
    ['row hint', `[id="${hint}"]`],
    ['intro', '[data-testid="preferences"] > p'],
    ['checked radio', '[data-testid="pref-start-page-library"]'],
    ['unchecked radio', '[data-testid="pref-start-page-devices"]'],
    ['save line', '[data-testid="prefs-state"]'],
    ['firmware state words', '[data-testid="fw-password-state"]'],
    ['nav item (current)', '[data-testid="settings-nav"] a[aria-current="true"]'],
    ['nav item', '[data-testid="settings-nav"] a:not([aria-current])'],
    ['tab (current)', '[data-testid="settings-sections"] a[aria-current="page"]'],
    ['tab', '[data-testid="settings-sections"] a:not([aria-current])'],
    ['Delete account h2', '#danger-heading'],
    ['Delete account… button', '[data-testid="account-delete-open"]'],
    ['email', '[data-testid="account-email"]'],
  ]);
});

test('the Help pairs are legible: eyebrow, body, body link, nav item and the current one, filter count', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUpFresh(page);
  await page.goto('/help#network');
  await page.mouse.move(0, 0);
  await legible(page, 'help', [
    ['eyebrow', '[data-testid="help-section-network"] > span:first-child'],
    ['body paragraph', '[data-testid="help-section-network"] > div p'],
    ['body link', '[data-testid="help-section-network"] > div a'],
    ['nav item (current)', '[data-testid="help-nav"] a[aria-current="true"]'],
    ['nav item', '[data-testid="help-nav"] a:not([aria-current])'],
    ['group label', '[data-testid="help-group-drives"] > span'],
  ]);
  await hydrated(page, 'help-filter', 'onChange');
  await page.getByTestId('help-filter').fill('drive');
  await legible(page, 'help', [['filter count', '[data-testid="help-filter-count"]']]);
});

test('the Search panel pairs are legible: title, sub line on the highlighted row, group label, footer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, { title: `Panel Pairs ${run}`, diskNo: 1, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'e') });
  await page.getByTestId('search-input').fill(`Panel Pairs ${run}`);
  await expect(page.getByTestId('search-result').first()).toBeVisible();
  await legible(page, 'search', [
    ['title name', '[data-testid="search-result"] span:has(> [data-testid="search-result-sub"]) > span:first-child'],
    ['sub line (highlighted row)', '[data-testid="search-result-sub"]'],
    ['group label', '[data-testid="search-group-title"]'],
    ['key footer', '[data-testid="search-keys"] > span'],
  ]);
});

test('the Sign-in and Create account pairs are legible: switch, error, hint, and the hero at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sign-in');
  await legible(page, 'sign-in', [
    ['switch (current)', '[data-testid="auth-switch"] a[aria-current="page"]'],
    ['switch (other)', '[data-testid="auth-switch"] a:not([aria-current])'],
    ['hero tagline', '[data-hero="tagline"]'],
    ['hero sub line', '[data-hero="sub"]'],
    ['hero footer', '[data-hero="foot"]'],
  ]);
  await hydrated(page, 'sign-in-form', 'onSubmit');
  await page.getByLabel('Email').fill(`nobody-${runTag()}@example.test`);
  await page.getByLabel('Password').fill('not-a-real-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('auth-error')).toBeVisible();
  await legible(page, 'sign-in', [['error', '[data-testid="auth-error"]']]);
  await page.goto('/sign-up');
  await legible(page, 'sign-up', [['invite hint', '#invite-code-hint'], ['password hint', '#password-hint']]);
});

// Phase C6 spec §11, measured on real elements. Seeded: a board with an error on the current release (an attention
// row and, with a current release, ` · current`), a TEST build, a live code, a revoked code and the fresh sign-up's
// used code. Live-data-only elements (warning tiles, the no-live note, attention-invites) are measured when present.
test('the Admin pairs are legible: tiles, firmware rows, attention, Users, Invites, Scan, Firmware, tabs', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const u = await signUpFresh(page);
  const current = await readCurrentRelease();
  const [errored] = await seedDevices(u.orgId, 1, current?.version ?? '0.0.0+e2e-c6-contrast');
  await getDb().update(devices).set({ lastError: 'e2e contrast', lastErrorAt: new Date() }).where(eq(devices.id, errored));
  await publishTestRelease('0.0.0+e2e63', { notes: 'TEST build c6 contrast' });
  await mintInviteCode();
  const revoked = await mintInviteCode();
  await revokeInvite(revoked);

  await page.context().clearCookies();
  await signInAsSuperAdmin(page);
  const when = async (area: string, pairs: ReadonlyArray<readonly [string, string]>) => {
    for (const pair of pairs) {
      if (await page.locator(pair[1]).count()) await legible(page, area, [pair]);
      else console.log(`${area.padEnd(9)} ${pair[0].padEnd(36)} not on the page in this database state`);
    }
  };

  await page.goto('/admin');
  await page.mouse.move(0, 0);
  const row = `[data-testid="attention-row"][data-device-id="${errored}"]`;
  await legible(page, 'overview', [
    ['tile label', 'a:has(> [data-testid="count-users"]) > span:first-child'],
    ['tile value', '[data-testid="count-users"]'],
    ['tile note', 'a:has(> [data-testid="count-users"]) > span:last-child'],
    ['firmware row count', '[data-testid="fw-dist-row"] > span:last-child'],
    ['attention title (surface-2)', `${row} [data-attn="title"]`],
    ['attention reason (surface-2)', `${row} [data-kind="error"]`],
    ['tab (current)', '[data-testid="admin-sections"] a[aria-current="page"]'],
    ['tab', '[data-testid="admin-sections"] a:not([aria-current])'],
  ]);
  await when('overview', [
    [' · current', '[data-dist="current"]'],
    ['warning tile value', 'a[data-warn="true"] > span:nth-child(2)'],
    ['warning tile note', 'a[data-warn="true"] > span:last-child'],
    ['attention title (warning-bg)', '[data-testid="attention-invites"] [data-attn="title"]'],
    ['attention text (warning-bg)', '[data-testid="attention-invites"] [data-attn="text"]'],
  ]);

  await gotoAdminUserRow(page, SUPERADMIN_EMAIL);
  await page.mouse.move(0, 0);
  await legible(page, 'users', [
    ['column head', 'section[aria-label="Users"] th'],
    ['joined date', '[data-testid="admin-user-row"] td:nth-child(3)'],
    ['Admin pill', '[data-admin-pill]'],
    ['Delete… trigger', '[data-testid^="delete-user-"]:not([aria-disabled])'],
    ['footer', '[data-users-foot]'],
  ]);

  await page.goto('/admin/invites');
  await page.mouse.move(0, 0);
  await legible(page, 'invites', [
    ['Live pill', '[data-state="live"]'],
    ['Used pill', `[data-testid="invite-${u.inviteCode}"] [data-state="consumed"]`],
    ['Revoked pill', `[data-testid="invite-${revoked}"] [data-state="revoked"]`],
  ]);
  await when('invites', [['no-live note', '[data-testid="invites-none-live"] > span:last-child']]);

  await page.goto('/admin/scan');
  await page.mouse.move(0, 0);
  await legible(page, 'scan', [
    ['source line', '[data-testid="scan-identity"] [data-source]'],
    ['count label', '[data-testid="scan-identity"] [data-count-label]'],
    ['count value', '[data-testid="scan-blobs"]'],
    ['status line', '[data-testid="scan-note"] > span:last-child'],
  ]);

  await page.goto('/admin/firmware');
  await page.mouse.move(0, 0);
  await legible(page, 'firmware', [
    ['meta line', '[data-testid="firmware-release-row"] [data-fw-meta]'],
    ['Test build tag', '[data-testid="firmware-release-row"][data-version="0.0.0+e2e63"] [data-testid="fw-tag-test"]'],
    ['filter (current)', '[data-testid="fw-filter"] a[aria-current="page"]'],
    ['filter (other)', '[data-testid="fw-filter"] a:not([aria-current])'],
  ]);
  await page.goto('/admin/firmware?show=releases');
  await page.mouse.move(0, 0);
  await when('firmware', [
    ['Current release tag', '[data-testid="fw-tag-current"]'],
    ['GitHub release', '[data-testid="fw-github"]'],
  ]);
});

// Phase C7 (spec §2.3, Ruling 5): the phone shell's text on real elements at 390 -- the current tab (ink 700) and
// another (--muted-2) on the bar's --nav-scrim, and a More menu item on the popup's surface.
test('the phone shell pairs are legible at 390: the current tab, another tab, a More menu item', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUpFresh(page);
  await page.goto('/library');
  await page.mouse.move(0, 0);
  await legible(page, 'phone', [
    ['tab (current)', 'nav[aria-label="Main"] a[aria-current="page"]'],
    ['tab', 'nav[aria-label="Main"] a:not([aria-current]):not(.max-lg\\:hidden)'],
  ]);
  await hydrated(page, 'nav-more');
  await page.getByTestId('nav-more').click();
  await expect(page.getByTestId('nav-more-menu')).toBeVisible();
  await legible(page, 'phone', [['More menu item', '[data-testid="more-help"]']]);
});

// Phase C8 (spec §9.5 C8-15, Ruling 23): the drive panel's text on its real elements -- Manage devices
// (--accent-amber) on the popup's --surface, the disk line (--muted) on the card's --surface-2, the offline line
// (--amber-text) on --surface-2, and both pills' words on their pills.
test('C8-15 the drive panel pairs are legible: Manage devices, the disk line, the offline line, both pills', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const on = await pairDevice(page, request, 'Aa contrast on');
  const off = await pairDevice(page, request, 'Ab contrast off');
  await getDb().update(devices).set({ name: 'Aa contrast on', lastSeenAt: new Date() }).where(eq(devices.id, on.deviceId));
  await getDb().update(devices).set({ name: 'Ab contrast off', lastSeenAt: new Date(Date.now() - 60 * 60_000) })
    .where(eq(devices.id, off.deviceId));
  const tag = runTag();
  const s = createHash('sha256').update(`c8-contrast-${tag}`).digest('hex');
  const { diskId } = await seedDisk(orgId, { title: `Contrast ${tag.slice(-5)}`, diskNo: 1, sha256: s });
  const res = await page.request.post(`/api/devices/${on.deviceId}/mount`, { data: { diskId } });
  const { version } = await res.json();
  expect((await request.post('/api/device/status', {
    headers: authHeader(on.token), data: { mountedSha256: s, mountedDiskId: diskId, version },
  })).status()).toBe(204);

  await page.goto('/library');
  await hydrated(page, `drive-chip-${on.deviceId}`);
  await page.getByTestId(`drive-chip-${on.deviceId}`).click();
  await expect(page.getByTestId(`drive-chip-menu-${on.deviceId}`)).toBeVisible();
  await page.mouse.move(0, 0);
  await legible(page, 'drive', [
    ['Manage devices', '[data-testid="drive-panel-manage"]'],
    ['disk line', `[data-testid="drive-entry-disk-${on.deviceId}"]`],
    ['Online pill', `[data-testid="drive-entry-status-${on.deviceId}"]`],
  ]);
  await page.keyboard.press('Escape');
  // At 1280 the second board is behind "+1".
  await hydrated(page, 'drive-chip-more');
  await page.getByTestId('drive-chip-more').click();
  await expect(page.getByTestId('drive-chip-more-menu')).toBeVisible();
  await page.mouse.move(0, 0);
  await legible(page, 'drive', [
    ['offline line', `[data-testid="drive-entry-offline-${off.deviceId}"]`],
    ['Offline pill', `[data-testid="drive-entry-status-${off.deviceId}"]`],
  ]);
});

// Library multi-select (spec §5): the bar's text on ink, the box ring (3:1 non-text) on its surface disc, and the
// ticked card's outline (3:1) against the page ground. The ring is --muted-2, not --line-strong (Plan ruling, Task 3).
test('MS-C1 the selection pairs: the bar on ink, the box ring on its disc, the selected outline on the ground', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const tag = runTag();
  const s1 = createHash('sha256').update(`ms-contrast-1-${tag}`).digest('hex');
  const s2 = createHash('sha256').update(`ms-contrast-2-${tag}`).digest('hex');
  const { gameId } = await seedDisk(orgId, { title: `Contrast sel ${tag.slice(-5)}`, diskNo: 1, sha256: s1 });
  await seedDisk(orgId, { title: `Contrast two ${tag.slice(-5)}`, diskNo: 1, sha256: s2 });
  // A collection to move to, so Move… is enabled (a disabled control is exempt and drawn at half opacity).
  expect((await page.request.post('/api/collections', { data: { name: `Contrast ${tag.slice(-5)}` } })).status()).toBe(200);
  await page.goto('/library');
  await hydrated(page, 'library-select-toggle');
  await page.getByTestId('library-select-toggle').click();
  await hydrated(page, 'select-title', 'onChange');
  await page.locator(`[data-testid="game-card"][data-game-id="${gameId}"] [data-testid="select-title"]`).click();
  await page.mouse.move(0, 0);
  await legible(page, 'select', [
    ['count on ink', '[data-testid="library-selection-count"]'],
    ['All on this page on ink', '[data-testid="library-selection-bar"] label'],
    ['Move… on its fill', '[data-testid="library-bulk-move"]'],
    ['Delete… on danger', '[data-testid="library-bulk-delete"]'],
    ['Cancel on its fill', '[data-testid="library-selection-cancel"]'],
  ]);
  const c = await page.evaluate((id) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const hex = (s: string) => { const h = s.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-testid="game-card"] [data-testid="select-title"]')];
    const unticked = boxes.find((b) => !b.checked)!;
    const disc = unticked.parentElement!.parentElement!;
    const card = document.querySelector<HTMLElement>(`[data-testid="game-card"][data-game-id="${id}"]`)!;
    return {
      ring: rgb(getComputedStyle(unticked).borderTopColor),
      disc: rgb(getComputedStyle(disc).backgroundColor),
      outline: rgb(getComputedStyle(card).outlineColor),
      ground: hex(getComputedStyle(document.documentElement).getPropertyValue('--ground')),
    };
  }, gameId);
  const ring = ratio(c.ring, c.disc);
  const outline = ratio(c.outline, c.ground);
  console.log(`select    box ring on its disc                  ${ring.toFixed(2)}:1`);
  console.log(`select    selected outline on the ground        ${outline.toFixed(2)}:1`);
  expect(ring).toBeGreaterThanOrEqual(3);
  expect(outline).toBeGreaterThanOrEqual(3);
});
