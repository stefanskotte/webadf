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
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk, pairDevice, authHeader, openBoardSettings, hydrated } from './device-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { transfers } from '@/db/schema/transfers';
import { eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { signInAsSuperAdmin } from './admin-helpers';

// Upload test rows: all belong to that test's own fresh org; amiga_uploads are removed by id here (the org's other
// rows go with its teardown), transfers cascade with the paired device in cleanupSeeded().
const uploadIdsToDelete: string[] = [];
test.afterAll(async () => {
  if (uploadIdsToDelete.length) await getDb().delete(amigaUploads).where(inArray(amigaUploads.id, uploadIdsToDelete)).catch(() => undefined);
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

test('a toast description is legible', async ({ page }) => {
  await signUpFresh(page);
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  // Force the fetch to fail: that is the branch raising a toast WITH a
  // description. The success path renders the code inline instead.
  await page.route('**/api/admin/invites', (r) => r.abort());
  await page.getByRole('button', { name: /issue invite/i }).click();

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

  // The metadata line is the second (last) span in the top result's button
  // -- querySelector returns the first DOM match, which is that top,
  // highlighted-by-default row.
  const p = await probe(page, '[data-testid="search-result"] span:last-child');
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
    '[data-testid=about-link]',
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

// Phase C3 (spec §8): the Upload pairs, measured on the real elements of a seeded org -- a stored, a receiving and a
// failed Amiga file, a queued send, and one library row from a real drop. Every row belongs to this test's own org.
test('the Upload pairs are legible: pills, statuses, where on a hovered row, counts, footnote, receiver, Delete, Browse, hint', async ({ page, request }) => {
  const u = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, `Up ${runTag().slice(0, 6)}`);
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.19.0+gabc1234', secondDrive: 'net', driveVersion: 0, upKey: 'ab12' } })).status()).toBe(204);
  const now = Date.now();
  const ids = { stored: randomUUID(), moving: randomUUID(), failed: randomUUID(), queued: randomUUID() };
  await getDb().insert(amigaUploads).values([
    { id: ids.stored, orgId: u.orgId, deviceId, deviceName: 'Up', path: 'Keep.txt', sizeBytes: 11, amigaDate: '17000.600.0',
      status: 'stored', receivedBytes: 11, blobSha256: '0'.repeat(64), createdAt: new Date(now), storedAt: new Date(now), expiresAt: new Date(now + 30 * 86_400_000) },
    { id: ids.moving, orgId: u.orgId, deviceId, deviceName: 'Up', path: 'Moving.bin', sizeBytes: 20_000, amigaDate: '17000.600.0',
      status: 'receiving', receivedBytes: 16_384, createdAt: new Date(now - 1000), expiresAt: new Date(now + 86_400_000) },
    { id: ids.failed, orgId: u.orgId, deviceId, deviceName: 'Up', path: 'Bad.txt', sizeBytes: 11, amigaDate: '17000.600.0',
      status: 'failed', receivedBytes: 11, errorCode: 'crc', createdAt: new Date(now - 2000), expiresAt: new Date(now + 86_400_000) },
  ]);
  uploadIdsToDelete.push(ids.stored, ids.moving, ids.failed);
  await getDb().insert(transfers).values([
    { id: ids.queued, orgId: u.orgId, deviceId, createdByUserId: 'e2e-contrast', path: 'Wait.bin', sizeBytes: 11, crc32: 0,
      blobSha256: '0'.repeat(64), status: 'queued', createdAt: new Date(now - 3000), expiresAt: new Date(now + 7 * 86_400_000) },
  ]);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/ingest');
  const k = (p: string, id: string) => `[data-testid="${p}-${id}"]`;
  await expect(page.locator(k('staging-status', `amiga:${ids.moving}`))).toContainText('Arriving', { timeout: 15_000 });

  // A library row from a real drop into this org (a fake ADF whose first bytes are unique to this run).
  const adf = Buffer.alloc(901_120);
  adf.write(`DOS\0contrast-${runTag()}`, 0);
  const libSha = createHash('sha256').update(adf).digest('hex');
  await page.getByTestId('file-input').setInputFiles({ name: 'contrast.adf', mimeType: 'application/octet-stream', buffer: adf });
  await expect(page.locator(`[data-testid="staging-row"][data-key="lib:${libSha}"]`)).toHaveAttribute('data-state', 'done', { timeout: 30_000 });

  const pairs: [string, string][] = [
    ['From Amiga pill', k('staging-dir', `amiga:${ids.stored}`)],
    ['To Amiga pill', k('staging-dir', `send:${ids.queued}`)],
    ['To library pill', k('staging-dir', `lib:${libSha}`)],
    ['done status', k('staging-status', `amiga:${ids.stored}`)],
    ['moving status', k('staging-status', `amiga:${ids.moving}`)],
    ['waiting status', k('staging-status', `send:${ids.queued}`)],
    ['failed status', k('staging-status', `amiga:${ids.failed}`)],
    ['size', k('staging-size', `amiga:${ids.stored}`)],
    ['unchecked filter count', '[data-testid="staging-filter-in"] > span'],
    ['footnote', '#from-amiga footer > span:first-child'],
    ['receiver line', '[data-testid="send-receiver"]'],
    ['Delete', k('staging-delete', `amiga:${ids.stored}`)],
    ['Browse files', '[data-testid="add-browse"]'],
    ['drop-card hint', '[data-testid="dropzone-hint"]'],
  ];
  for (const [what, sel] of pairs) {
    const p = await probe(page, sel);
    expect(p, `${what}: ${sel} not found`).toBeTruthy();
    const r = ratio(p!.fg, p!.bg);
    console.log(`upload    ${what.padEnd(24)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 24)}"`);
    expect(r, what).toBeGreaterThan(4.5);
  }
  // A hovered row sits on --modal-foot; its where line is --muted-2.
  await page.locator(`[data-testid="staging-row"][data-key="amiga:${ids.stored}"]`).hover();
  const where = await probe(page, k('staging-where', `amiga:${ids.stored}`));
  expect(where, 'where line not found').toBeTruthy();
  const rw = ratio(where!.fg, where!.bg);
  console.log(`upload    where on a hovered row   ${rw.toFixed(2)}:1`);
  expect(rw, 'where on a hovered row').toBeGreaterThan(4.5);
  await page.screenshot({ path: 'test-results/zz-upload.png', fullPage: true });
});
