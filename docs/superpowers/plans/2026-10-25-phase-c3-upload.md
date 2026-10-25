# Phase C3 Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Upload page (`/ingest`) takes the approved InfUploadTransfer layout — two dashed drop cards with the
board's disk, an inline URL field, the Send card's board line, and one Staging section with a segmented filter, a
refresh state, Clear finished and the board's row grid — with every A6 behaviour, route and request body kept.

**Architecture:** Presentation and wiring on Phase B's tokens and C1/C2's pieces. Pure look rules in a new
`src/lib/upload-look.ts` (direction pill, tone, row disk colour, filter keys); `ViewRow` gains `pct`. One shared
`DropCard` shell (`src/components/ingest/drop-card.tsx`) replaces `UploadCard` + `DropArea`; the row moves out of
`staging-list.tsx` into `staging-row.tsx` so it can be render-tested. No schema, no migration, no new route, no new
package; `StagingProvider` is untouched.

**Tech Stack:** Next.js 16.3.2 App Router (read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`
before Task 6's `loading.tsx`), React 19, Tailwind v4, vitest (`renderToStaticMarkup` render tests), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-phase-c3-upload-design.md`

## Global Constraints

- Texts, test ids and orders exactly as the spec writes them; every id in spec §9.1 must still resolve (once per page,
  or once per row for `<key>` ids); ids move only as spec §9.4 says.
- Same routes and request bodies: `/api/staging`, `/api/staging/clear` `{keys}`, `/api/ingest/{check,presign,complete,url}`,
  `POST /api/transfers?deviceId=&name=`, `DELETE /api/transfers/:id`, `POST /api/transfers/:id/retry`,
  `DELETE /api/uploads/:id[?only=receiving]`, `POST /api/uploads/:id/library`, `POST /api/uploads/:id/send {deviceId}`,
  `GET /api/uploads/:id/file`. `StagingProvider`, `Dropzone`'s pipeline and `SendPanel.handleFiles` keep their logic.
- **No DB migration.** If a task believes one is needed, STOP and report: the controller migrates production; a
  subagent never runs `drizzle-kit` or writes under `drizzle/`.
- Colours only through tokens (Phase B §4, C1/C2's, this spec's four in §7) or `upload-look.ts`; no `#7A7262` /
  `#A39B8B` text (Phase B ruling 4: `--muted-2`). `DiskIcon` is the only literal-colour drawing.
- "Show both values of a state": every state renders a word in each value (refresh state, Clear finished (0),
  Browse files / Working…, receiver ✓ / •); no `sr-only` element carries a width or layout utility (`file-input` and
  `send-file-input` get `sr-only` and nothing else).
- WCAG AA 4.5:1 for every text pair in spec §8, pinned in `design-tokens.test.ts` and measured on the page in
  `contrast.spec.ts`. Keyboard: every control is reachable by Tab; the filter is a roving radiogroup.
- In-app dialogs only (`StagingConfirm`); never `window.confirm` / `alert`.
- Self-host parity: no new package, no external URL, no font, no our-deployment-only path.
- Firmware, `wifi-floppy/`, the board and the Amiga are not touched.
- Worktree setup before any e2e (memory `worktree-e2e-setup`): real `pnpm install --offline`, `.env.local` (never
  print it), `npx next typegen`, the `adf-archive` symlink.
- House rules, every task: stage files by name (never `git add -A`, never anything under `wifi-floppy/`), no `git
  stash` in any form; stop only your own PIDs, never pattern-kill; e2e with `PORT=3100`, desktop project unless a
  step says mobile, ONE run at a time, each command under 9 minutes (split with `-g`), in the foreground; the e2e DB
  is the live production DB shared with other runs, so assert relative to rows you seeded (run tags, seeded boards,
  row keys), never absolute counts; no commit after a red run; commit trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc`.
- **Known pre-existing e2e failures** (leave them, record their result, do not chase): `time-machine.spec.ts:212`
  and `:268`, `display-layout.spec.ts:287` (not this area; not run here); `help.spec` "Enter opens the ?" is
  order-dependent (a flake: rerun that test alone once before reporting it).

## Review Focus

1. Every spec §9.1 id resolves; `dropzone`/`send-dropzone` are the card sections; the filter items are `role="radio"` with `aria-checked` and a roving tab stop; `staging-clear-finished` is always present (disabled at `(0)`).
2. Behaviour unchanged: the same requests (routes and bodies), the same row words and actions per kind × state, `?board=`/`?from=` filters, the change clock, and `stagingReady`'s hydration wait (no `staging-empty` before the first answer).
3. Every state shown in words in both values (refresh state, unreadable first read, Working…, receiver mark, Clear finished (0)); no `sr-only` element with a width/layout utility.
4. Layout: the one-line grid only from `xl`, the three-line card below; names and where lines wrap (no ellipsis); nothing overflows at 390 px; the drop cards stack below `lg`.
5. e2e assertions stay relative to seeded rows on the shared production DB; runs serialised, on PORT=3100, each under 9 minutes.

## Common commands

- Unit: `pnpm test <path>`; db: `pnpm test:db <path>`; types: `npx tsc --noEmit`; lint: `pnpm lint`.
- e2e desktop: `PORT=3100 npx playwright test e2e/<name>.spec.ts --project=desktop [-g "<title part>"]`.
- e2e mobile: `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "<title part>"`.
- Screenshots: `PORT=3100 pnpm screenshots` (own config, own demo account; Task 6 only).
- The `-g` patterns below are taken from the current titles but are starting points: before running, check with
  `npx playwright test e2e/<name>.spec.ts --list -g "<pattern>"` that the pattern selects what the task needs, and
  that a file split into several runs is covered whole.

## File map

| File | Task | What |
|---|---|---|
| `src/lib/upload-look.ts` + `.test.ts` | 1 | new: `directionPill`, `toneLook`, `rowDiskColor`, `filterAfterKey`, `FILTERS`, `EMPTY_UNDER` |
| `src/lib/upload-staging.ts` + `.test.ts` | 1 | `ViewRow.pct` |
| `src/app/globals.css`, `src/lib/design-tokens.test.ts` | 1 | four tokens; spec §8 pairs |
| `src/components/ingest/drop-card.tsx` + `drop-card.test.ts` | 2 | new shell; replaces `upload-card.tsx`, `drop-area.tsx` (deleted) |
| `src/components/ingest/dropzone.tsx`, `url-fetch.tsx`, `set-suggestion.tsx` | 2 | library card |
| `src/components/send/send-panel.tsx` | 2 | Send card |
| `src/app/(app)/ingest/page.tsx` | 2 | header, grid |
| `src/components/ingest/staging-list.tsx` | 3, 4, 5 | section, header, footer, list, actions, focus |
| `src/components/ingest/staging-row.tsx` + `staging-row.test.ts` | 4 | new: the row |
| `src/components/ingest/staging-confirm.tsx` | 5 | restyle |
| `src/app/(app)/ingest/loading.tsx` + `loading.test.ts` | 6 | new skeleton |
| `src/lib/help/topics.tsx` | 2, 3 | `send`, `from-amiga` |
| `e2e/upload-staging.spec.ts`, `from-amiga.spec.ts`, `send-to-amiga.spec.ts` | 2–5 | spec §9.4 |
| `e2e/contrast.spec.ts`, `e2e/screenshots.shots.ts` | 6 | Upload pairs; `upload` shot |

---

### Task 1: Look rules, tokens and `ViewRow.pct` (no visible change)

**Files:**
- Create: `src/lib/upload-look.ts`, `src/lib/upload-look.test.ts`
- Modify: `src/lib/upload-staging.ts` (`ViewRow.pct`, `toView`), `src/lib/upload-staging.test.ts`
- Modify: `src/app/globals.css` (webadf `:root`), `src/lib/design-tokens.test.ts`
- Modify: `src/components/ingest/staging-list.tsx` (import `FILTERS`/`EMPTY_UNDER` from `upload-look.ts`; delete its
  local copies — no rendered change)

**Interfaces:**
- Consumes: `ViewRow`, `Tone`, `StagingFilter` (`upload-staging.ts`); `driveDiskColor` (`library-look.ts`);
  `DiskColor` (`disk-icon.ts`).
- Produces: `directionPill(kind) → { label; arrow; bg; fg }`, `toneLook(tone) → { fg; dot }`,
  `rowDiskColor(v: ViewRow) → DiskColor`, `filterAfterKey(f, key) → StagingFilter | null`,
  `FILTERS: { id: StagingFilter; label: string }[]`, `EMPTY_UNDER: Record<Exclude<StagingFilter,'all'>, string>`;
  `ViewRow.pct: number | null`; tokens `--dash`, `--to-amiga-bg`, `--from-amiga-bg`, `--from-amiga-fg`.

- [ ] **Step 1: Write the failing tests**

`src/lib/upload-look.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { directionPill, toneLook, rowDiskColor, filterAfterKey, FILTERS, EMPTY_UNDER } from '@/lib/upload-look';
import { stagingView, type LibRow, type ServerRow } from '@/lib/upload-staging';
import { driveDiskColor } from '@/lib/library-look';

const server = (o: Partial<ServerRow>): ServerRow => ({ source: 'server', key: 'send:t1', kind: 'out', id: 't1',
  name: 'f.bin', sizeBytes: 11, board: { id: 'd1', name: 'Bench' }, status: 'queued', doneBytes: 0, pct: null,
  savedAs: null, error: null, isDiskImage: false, title: null, at: 1, ...o });
const lib = (o: Partial<LibRow>): LibRow => ({ source: 'lib', key: 'lib:1', kind: 'lib', name: 'a.adf',
  sizeBytes: 901_120, state: 'done', title: null, at: 1, ...o });
const view = (r: ServerRow | LibRow) => stagingView([r], 'all', new Set()).shown[0];

describe('directionPill (spec §3)', () => {
  it.each([
    ['lib', 'To library', '↓', 'var(--track)', 'var(--muted)'],
    ['out', 'To Amiga', '→', 'var(--to-amiga-bg)', 'var(--accent-blue)'],
    ['in', 'From Amiga', '←', 'var(--from-amiga-bg)', 'var(--from-amiga-fg)'],
  ] as const)('%s', (kind, label, arrow, bg, fg) => {
    expect(directionPill(kind)).toEqual({ label, arrow, bg, fg });
  });
});

describe('toneLook (spec §3, Ruling 28)', () => {
  it.each([
    ['done', 'var(--success-fg)', 'var(--online-dot)'],
    ['busy', 'var(--warning-fg)', 'var(--fetch-dot)'],
    ['wait', 'var(--muted)', 'var(--dash)'],
    ['fail', 'var(--danger-fg)', 'var(--danger-fg)'],
  ] as const)('%s', (tone, fg, dot) => {
    expect(toneLook(tone)).toEqual({ fg, dot });
  });
});

describe('rowDiskColor (Ruling 17)', () => {
  it('a failed row is cream', () => {
    expect(rowDiskColor(view(lib({ state: 'failed', note: 'No disk images inside' })))).toBe('cream');
    expect(rowDiskColor(view(server({ status: 'failed' })))).toBe('cream');
  });
  it('a row with a title takes the title colour', () => {
    const t = { gameId: 'g-42', title: 'Turrican II' };
    expect(rowDiskColor(view(lib({ title: t })))).toBe(driveDiskColor('g-42'));
    expect(rowDiskColor(view(server({ key: 'amiga:u1', kind: 'in', status: 'stored', isDiskImage: true, title: t }))))
      .toBe(driveDiskColor('g-42'));
  });
  it('otherwise by direction', () => {
    expect(rowDiskColor(view(server({ status: 'queued' })))).toBe('blue');
    expect(rowDiskColor(view(server({ key: 'amiga:u1', kind: 'in', status: 'stored', isDiskImage: true })))).toBe('black');
    expect(rowDiskColor(view(server({ key: 'amiga:u1', kind: 'in', status: 'stored', isDiskImage: false })))).toBe('grey');
    expect(rowDiskColor(view(lib({ state: 'hashing' })))).toBe('black');
  });
});

describe('filterAfterKey', () => {
  it('moves in FILTERS order and wraps', () => {
    expect(FILTERS.map((f) => f.id)).toEqual(['all', 'in', 'out', 'lib']);
    expect(filterAfterKey('all', 'ArrowRight')).toBe('in');
    expect(filterAfterKey('in', 'ArrowDown')).toBe('out');
    expect(filterAfterKey('lib', 'ArrowRight')).toBe('all');
    expect(filterAfterKey('all', 'ArrowLeft')).toBe('lib');
    expect(filterAfterKey('out', 'ArrowUp')).toBe('in');
    expect(filterAfterKey('out', 'Home')).toBe('all');
    expect(filterAfterKey('in', 'End')).toBe('lib');
    expect(filterAfterKey('in', 'a')).toBeNull();
  });
  it('keeps the A6 words', () => {
    expect(FILTERS.map((f) => f.label)).toEqual(['All', 'From the Amiga', 'To the Amiga', 'To the library']);
    expect(EMPTY_UNDER).toEqual({ lib: 'Nothing to the library right now.', out: 'Nothing to the Amiga right now.',
      in: 'Nothing from the Amiga right now.' });
  });
});
```

Append to `src/lib/upload-staging.test.ts`:

```ts
describe('pct (C3 spec §3)', () => {
  it('is the server percent while sending or receiving, else null', () => {
    expect(one(send({ status: 'sending', pct: 40 })).pct).toBe(40);
    expect(one(amiga({ status: 'receiving', pct: 81 })).pct).toBe(81);
    expect(one(send({ status: 'delivered', pct: null })).pct).toBeNull();
    expect(one(amiga({ status: 'stored', pct: 99 })).pct).toBeNull();
    expect(one(lib({ state: 'uploading' })).pct).toBeNull();
    expect(one(up({ state: 'uploading' })).pct).toBeNull();
  });
});
```

In `src/lib/design-tokens.test.ts`, add to the value table `['--dash', '#C4B9A2'], ['--to-amiga-bg', '#DCE8F5'],
['--from-amiga-bg', '#E5F0DF'], ['--from-amiga-fg', '#2C5E24'], ['--accent-blue', '#1D4F86']`, and to `pairs`:

```ts
    // Upload spec §8
    ['--accent-blue', '--to-amiga-bg'], ['--from-amiga-fg', '--from-amiga-bg'],
    ['--success-fg', '--surface'], ['--success-fg', '--modal-foot'], ['--warning-fg', '--surface'],
    ['--warning-fg', '--modal-foot'], ['--muted', '--modal-foot'], ['--danger-fg', '--modal-foot'],
    ['--ink', '--surface-2'], ['#FFFFFF', '--danger-fg'],
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/lib/upload-look.test.ts src/lib/upload-staging.test.ts src/lib/design-tokens.test.ts`
Expected: FAIL — `Cannot find module '@/lib/upload-look'`; `pct` is `undefined`; `--dash is not set as a #rrggbb hex`.

- [ ] **Step 3: Implement**

`src/lib/upload-look.ts`:

```ts
// The Upload page's look rules (Phase C3 spec §3): pure and client-safe.
import type { DiskColor } from '@/lib/disk-icon';
import { driveDiskColor } from '@/lib/library-look';
import type { StagingFilter, Tone, ViewRow } from '@/lib/upload-staging';

export const FILTERS: { id: StagingFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'in', label: 'From the Amiga' },
  { id: 'out', label: 'To the Amiga' },
  { id: 'lib', label: 'To the library' },
];
export const EMPTY_UNDER: Record<Exclude<StagingFilter, 'all'>, string> = {
  lib: 'Nothing to the library right now.',
  out: 'Nothing to the Amiga right now.',
  in: 'Nothing from the Amiga right now.',
};

const PILLS = {
  lib: { label: 'To library', arrow: '↓', bg: 'var(--track)', fg: 'var(--muted)' },
  out: { label: 'To Amiga', arrow: '→', bg: 'var(--to-amiga-bg)', fg: 'var(--accent-blue)' },
  in: { label: 'From Amiga', arrow: '←', bg: 'var(--from-amiga-bg)', fg: 'var(--from-amiga-fg)' },
} as const;
export const directionPill = (kind: ViewRow['kind']) => ({ ...PILLS[kind] });

const TONES: Record<Tone, { fg: string; dot: string }> = {
  done: { fg: 'var(--success-fg)', dot: 'var(--online-dot)' },
  busy: { fg: 'var(--warning-fg)', dot: 'var(--fetch-dot)' },
  wait: { fg: 'var(--muted)', dot: 'var(--dash)' },
  fail: { fg: 'var(--danger-fg)', dot: 'var(--danger-fg)' },
};
export const toneLook = (tone: Tone) => ({ ...TONES[tone] });

/** Ruling 17: failed cream; a known title its library colour; else by direction. */
export function rowDiskColor(v: ViewRow): DiskColor {
  if (v.tone === 'fail') return 'cream';
  if (v.gameId) return driveDiskColor(v.gameId);
  if (v.kind === 'out') return 'blue';
  if (v.kind === 'in') return v.row.source === 'server' && v.row.isDiskImage ? 'black' : 'grey';
  return 'black';
}

/** The filter a key moves to (a roving radiogroup), or null for any other key. */
export function filterAfterKey(current: StagingFilter, key: string): StagingFilter | null {
  const ids = FILTERS.map((f) => f.id);
  const at = ids.indexOf(current);
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  const dir = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  return dir ? ids[(at + dir + ids.length) % ids.length] : null;
}
```

In `src/lib/upload-staging.ts`: add `pct: number | null;` to `ViewRow` (after `actions`), and in `toView`:

```ts
  const pct = r.source === 'server' && (r.status === 'sending' || r.status === 'receiving') ? r.pct : null;
  return { key: r.key, kind: r.kind, name: r.name, size: formatSize(r.sizeBytes), row: r, pct, ...body };
```

In `src/app/globals.css`, after `--fetch-dot`:

```css
  --dash:          #C4B9A2;   /* the Upload drop cards' dashed border, the waiting dot (Upload spec §7) */
  --to-amiga-bg:   #DCE8F5;   /* the "To Amiga" pill; text --accent-blue 6.72:1 */
  --from-amiga-bg: #E5F0DF;   /* the "From Amiga" pill ... */
  --from-amiga-fg: #2C5E24;   /* ... and its text, 6.53:1 */
```

In `staging-list.tsx`: `import { FILTERS, EMPTY_UNDER } from '@/lib/upload-look';` and delete the local constants.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/lib/upload-look.test.ts src/lib/upload-staging.test.ts src/lib/design-tokens.test.ts`
Expected: PASS (all).
Run: `npx tsc --noEmit` → no output. `pnpm lint` → no new findings (the two pre-existing admin purity findings stay).

- [ ] **Step 5: Regression e2e** (one at a time)

Run: `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop`
Expected: `7 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/upload-look.ts src/lib/upload-look.test.ts src/lib/upload-staging.ts src/lib/upload-staging.test.ts \
  src/app/globals.css src/lib/design-tokens.test.ts src/components/ingest/staging-list.tsx
git commit -m "Upload C3: look rules, tokens and ViewRow.pct (no visible change)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc"
```

---

### Task 2: Page header and the two drop cards

**Files:**
- Create: `src/components/ingest/drop-card.tsx`, `src/components/ingest/drop-card.test.ts`
- Modify: `src/app/(app)/ingest/page.tsx` (spec §1), `src/components/ingest/dropzone.tsx` (spec §2.1),
  `src/components/ingest/url-fetch.tsx` (inline field), `src/components/ingest/set-suggestion.tsx` (tokens only),
  `src/components/send/send-panel.tsx` (spec §2.2), `src/lib/help/topics.tsx` (`send`, spec §11)
- Delete: `src/components/ingest/drop-area.tsx` (once unused). `upload-card.tsx` is still used by `staging-list.tsx`
  until Task 3; delete it there.
- Test: `e2e/upload-staging.spec.ts` (new tests below)

**Interfaces:**
- Consumes: `DiskIcon`, `HelpTip`, `useStaging`, `receiverLine`, `targetState`, `orderTargets`, `longOffline`.
- Produces: `DropCard({ testId, headingId, title, help?, hint, disk, disabled?, onFiles?, children })`, its hint
  at `${testId}-hint`; `INK_LABEL` / `INK_STYLE` for Browse files and Choose files.

- [ ] **Step 1: Write the failing tests**

`src/components/ingest/drop-card.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DropCard } from './drop-card';

const render = (p: Partial<Parameters<typeof DropCard>[0]> = {}) => renderToStaticMarkup(createElement(DropCard, {
  testId: 'dropzone', headingId: 'add-heading', title: 'Add disks to the library', hint: 'A hint.',
  disk: { color: 'black', set: 'ADF · ADZ · DMS · HFE', title: 'Add to library' }, onFiles: () => undefined,
  ...p }, createElement('span', null, 'controls')));

describe('DropCard (spec §2)', () => {
  it('is a labelled section carrying the drop id and data-over', () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*aria-labelledby="add-heading"/);
    expect(html).toMatch(/<section[^>]*data-testid="dropzone"/);
    expect(html).toMatch(/<section[^>]*data-over="false"/);
    expect(html).toContain('id="add-heading"');
    expect(html).toContain('var(--dash)');
  });
  it('orders disk, heading, hint, controls', () => {
    const html = render();
    const at = (s: string) => html.indexOf(s);
    expect(at('<svg')).toBeLessThan(at('Add disks to the library'));
    expect(at('Add disks to the library')).toBeLessThan(at('A hint.'));
    expect(at('A hint.')).toBeLessThan(at('controls'));
  });
  it('without onFiles it is not a drop target', () => {
    expect(render({ onFiles: undefined })).toMatch(/<section[^>]*data-drop="off"/);
  });
});
```

Add to `e2e/upload-staging.spec.ts` (uses the file's `dropAdf`, `boardSays`, `pairDevice`):

```ts
test('the drop cards: whole-card drop targets with Browse files, the inline URL field, and Working… while busy', async ({ page }) => {
  await signUpFresh(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/ingest');
  await expect(page.locator('[data-testid="staging-empty"], [data-testid="staging-row"]').first()).toBeVisible({ timeout: LIVE });
  const add = page.getByTestId('dropzone');
  const send = page.getByTestId('send-dropzone');
  await expect(add).toHaveJSProperty('tagName', 'SECTION');
  await expect(send).toHaveJSProperty('tagName', 'SECTION');
  const a = (await add.boundingBox())!, s = (await send.boundingBox())!;
  expect(Math.abs(a.y - s.y)).toBeLessThan(2);                         // side by side from lg (Ruling 3)
  await expect(page.getByTestId('add-browse')).toHaveText('Browse files');
  await expect(page.getByLabel('Or fetch from a URL')).toHaveAttribute('placeholder', 'or paste a URL…');
  // Hold /check so the drop stays busy: Browse files says so (Ruling 7).
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/ingest/check', async (route) => { await held; await route.continue(); });
  await page.getByTestId('file-input').setInputFiles({ name: 'busy.adf', mimeType: 'application/octet-stream', buffer: fakeAdf() });
  await expect(page.getByTestId('add-browse')).toHaveText('Working…');
  await expect(page.getByTestId('add-browse')).toHaveAttribute('aria-disabled', 'true');
  release();
  await expect(page.getByTestId('add-browse')).toHaveText('Browse files', { timeout: 30_000 });
});

test('the Send card names its one board and whether Transfer runs, beside Choose files', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await page.goto('/ingest');
  await expect(page.getByTestId('send-browse')).toHaveText('Choose files');
  await expect(page.getByTestId('send-board')).toHaveText(/^To Bench · /);
  await expect(page.getByTestId('send-receiver')).toHaveText(/^[✓•] /);
  await expect(page.getByTestId('help-tip-send')).toBeVisible();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/components/ingest/drop-card.test.ts` → FAIL (`Cannot find module './drop-card'`).
Run: `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop -g "drop cards|Send card names"`
Expected: FAIL (`dropzone` is a `LABEL`; `add-browse` not found).

- [ ] **Step 3: Implement**

`src/components/ingest/drop-card.tsx` (client):

```tsx
'use client';
import { useState } from 'react';
import { DiskIcon } from '@/components/ui/disk-icon';
import type { DiskColor } from '@/lib/disk-icon';

/** The Upload page's drop card (C3 spec §2): the whole dashed card takes a drop; its controls open the picker. */
export function DropCard({ testId, headingId, title, help, hint, disk, disabled, onFiles, children }: {
  testId: string; headingId: string; title: string; help?: React.ReactNode; hint: React.ReactNode;
  disk: { color: DiskColor; set: string; title: string }; disabled?: boolean;
  onFiles?: (files: FileList) => void; children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const drop = !!onFiles && !disabled;
  return (
    <section aria-labelledby={headingId} data-testid={testId} data-over={String(over)} data-drop={onFiles ? 'on' : 'off'}
      onDragOver={(e) => { if (!onFiles) return; e.preventDefault(); if (!over) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { if (!onFiles) return; e.preventDefault(); setOver(false); if (drop) onFiles(e.dataTransfer.files); }}
      className="relative flex min-w-0 items-center gap-4 rounded-[20px] border-[1.5px] border-dashed border-[var(--dash)] bg-[var(--surface)] p-5 hover:border-[var(--ink)] data-[over=true]:border-[var(--ink)] data-[over=true]:bg-[var(--surface-2)] sm:gap-5 sm:p-6">
      <span className="shrink-0 sm:hidden"><DiskIcon color={disk.color} size={56} /></span>
      <span className="hidden shrink-0 sm:block"><DiskIcon color={disk.color} size={84} set={disk.set} title={disk.title} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-1">
          <h2 id={headingId} className="text-[20px] font-bold sm:text-[22px]"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>{title}</h2>
          {help}
        </div>
        <div data-testid={`${testId}-hint`} className="text-[13px]" style={{ color: 'var(--muted)' }}>{hint}</div>
        {children}
      </div>
    </section>
  );
}
```

(Colours as classes, not an inline `border` style, so `hover:` and `data-[over=true]:` can win; check the hover and a
real drag by hand in the browser once.)

A shared button class, exported from `drop-card.tsx` for both cards:

```ts
export const INK_LABEL = 'inline-flex h-[38px] shrink-0 cursor-pointer items-center rounded-[10px] px-3.5 text-[13px] font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2 aria-disabled:cursor-default aria-disabled:opacity-50';
// style: { background: 'var(--ink)', color: 'var(--surface)', '--tw-ring-color': 'var(--ring)' }
```

`dropzone.tsx` returns (logic above the return unchanged):

```tsx
<DropCard testId="dropzone" headingId="add-heading" title="Add disks to the library"
  hint="ADF, ADZ, DMS, DMZ or HFE. Hashed in your browser first — only missing disks upload."
  disk={{ color: 'black', set: 'ADF · ADZ · DMS · HFE', title: 'Add to library' }}
  disabled={busy} onFiles={(f) => void handleFiles(f)}>
  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
    <label htmlFor="add-file-input" data-testid="add-browse" aria-disabled={busy || undefined}
           className={INK_LABEL} style={INK_STYLE}>
      {busy ? 'Working…' : 'Browse files'}
      <input id="add-file-input" type="file" multiple accept=".adf,.dsk,.adz,.dms,.dmz,.hfe" className="sr-only"
             data-testid="file-input" disabled={busy}
             onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); }} />
    </label>
    <UrlFetch busy={busy} setBusy={setBusy} onRows={addFetchedRows} />
  </div>
  {suggestion && <SetSuggestion suggestion={suggestion} onDone={() => setSuggestion(null)} />}
</DropCard>
```

(`aria-disabled={busy || undefined}` renders `aria-disabled="true"` only while busy; the e2e reads `"true"`.)

`url-fetch.tsx`: the form becomes the inline field (spec §2.1) — keep `submit`, the status logic, `url-fetch-form`,
`url-input`, `url-fetch`, `url-status`, `ingest-url-hint`, `ingest-url-status`; drop the visible `label` and put
`aria-label="Or fetch from a URL"` on the input; field `h-11 sm:h-[38px]`, Fetch `h-9 sm:h-7`; the hint text
`A URL can also be a .zip or .lha of them, up to 20 MB, from a public http(s) address.`; status colours
`var(--danger-fg)` / `var(--success-fg)` / `var(--muted-2)`.

`send-panel.tsx`: replace `UploadCard` + `DropArea` with `DropCard` (`testId="send-dropzone"`,
`headingId="send-heading"`, `help={<HelpTip topic="send" />}`, disk `blue`/`Any file · 4 MB`/`To the Amiga`; no
board: disk `grey`, `hint={<p data-testid="send-no-board">…unchanged…</p>}`, no `onFiles`, no children). Controls:
the `send-browse` label (same `INK_LABEL`, the `send-file-input` inside it, `resetAfterPick` behaviour kept), then the
board line per spec §2.2:

```tsx
{single && (
  <span className="text-[13px]" data-testid="send-board" style={{ color: 'var(--muted)' }}>
    To <strong className="font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{single.name}</strong> · {targetState(single, now)}
  </span>
)}
{line && (
  <span role="status" data-testid="send-receiver" data-ok={String(line.ok)} className="text-[13px] font-medium"
        style={{ color: line.ok ? 'var(--success-fg)' : 'var(--warning-fg)' }}>
    {line.ok ? '✓ ' : '• '}{line.text}
  </span>
)}
```

(`send-to-amiga.spec:55` reads `toHaveText('• Transfer is not running on the Amiga')` — the mark, one space, the
sentence.) The picker per spec §2.2 under the controls (native radios, `accent-color: var(--ink)`).

`page.tsx`: `<PageHeader size="lg" eyebrow="Move files" title="Upload" subtitle="…unchanged…" />`; body
`<div className="flex flex-col gap-6 px-4 pb-10 sm:px-7"><div className="grid gap-5 lg:grid-cols-2 lg:items-stretch">
<Dropzone /><SendPanel … /></div><StagingList … /></div>`. `StagingList`'s own `mx-4 sm:mx-7 pb-10` goes.

`topics.tsx` `send` "Three ways to send": `On the Upload page, drop files on <em>Send files to the Amiga</em>, or
press <em>Choose files</em>; with more than one board, pick the board under it.` Source comment adds
`spec 2026-10-25-phase-c3-upload-design.md §2.2`.

Delete `src/components/ingest/drop-area.tsx` (`grep -rn "drop-area" src` → nothing).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test src/components/ingest/drop-card.test.ts` → PASS.
Run: `npx tsc --noEmit`; `pnpm lint`.
Run (one at a time):
- `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop` → `9 passed`.
- `PORT=3100 npx playwright test e2e/url-upload.spec.ts --project=desktop` → `5 passed`.
- `PORT=3100 npx playwright test e2e/ingest-ui.spec.ts --project=desktop` → `5 passed`.
- `PORT=3100 npx playwright test e2e/send-to-amiga.spec.ts --project=desktop -g "dropped under Send|over 4 MB|card says"` → `3 passed`.
- `PORT=3100 npx playwright test e2e/disk-sets.spec.ts --project=desktop -g "upload:"` → `2 passed`.
- `PORT=3100 npx playwright test e2e/hfe-disks.spec.ts --project=desktop -g "v1 Amiga HFE|refused on the row|server-side refusal|oversize file|splits a drop"` → `5 passed`.
- `PORT=3100 npx playwright test e2e/hd-disks.spec.ts --project=desktop -g "uploaded HD ADF"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "Upload page stacks"` → `1 passed`.
- `PORT=3100 npx playwright test e2e/help.spec.ts --project=desktop` → `6 passed` (see the flake note).

- [ ] **Step 5: Commit** (files by name: the created, modified and deleted files above, plus `e2e/upload-staging.spec.ts`;
`git rm src/components/ingest/drop-area.tsx`), message `Upload C3: page header and the two drop cards`, trailer as in
Global Constraints.

---

### Task 3: Staging section shell — header, filter radiogroup, refresh state, Clear finished, footer

**Files:**
- Modify: `src/components/ingest/staging-list.tsx` (spec §4.1, §4.3, §6.2; the section replaces `UploadCard`)
- Delete: `src/components/ingest/upload-card.tsx`
- Modify: `src/lib/help/topics.tsx` (`from-amiga`, spec §11)
- Modify: `e2e/from-amiga.spec.ts:125`, `:162`, `:168`; `e2e/send-to-amiga.spec.ts:151`, `:181`, `:217`;
  `e2e/upload-staging.spec.ts:117` (spec §9.4); new tests in `e2e/upload-staging.spec.ts`

**Interfaces:**
- Consumes: `FILTERS`, `EMPTY_UNDER`, `filterAfterKey` (Task 1); `useStaging()`'s `loaded`, `refreshFailed`, `boards`.
- Produces: `staging-filters` (+ `data-value`), `staging-refresh` (+ `data-state`), `staging-reading`
  (+ `data-state`), `#staging-heading` with `tabIndex={-1}`.

- [ ] **Step 1: Write the failing tests** (in `e2e/upload-staging.spec.ts`)

```ts
test('the filter is a radiogroup: arrows move and select, the tab stop follows the checked one', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  await seedUpload(orgId, deviceId, 'Bench', { path: 'In.txt', status: 'stored' });
  await page.goto('/ingest');
  const group = page.getByTestId('staging-filters');
  await expect(group).toHaveAttribute('role', 'radiogroup');
  await expect(page.getByTestId('staging-filter-all')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('staging-filter-all')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('staging-filter-in')).toHaveAttribute('tabindex', '-1');
  await page.getByTestId('staging-filter-all').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('staging-filter-in')).toBeFocused();
  await expect(page.getByTestId('staging-filter-in')).toHaveAttribute('aria-checked', 'true');
  await expect(group).toHaveAttribute('data-value', 'in');
  await page.keyboard.press('End');
  await expect(page.getByTestId('staging-filter-lib')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('staging-empty')).toHaveText('Nothing to the library right now.');
});

test('Clear finished is shown at (0), disabled, and the refresh state reads Up to date', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');
  await expect(page.getByTestId('staging-empty')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (0)');
  await expect(page.getByTestId('staging-clear-finished')).toBeDisabled();
  await expect(page.getByTestId('staging-refresh')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('staging-refresh')).toHaveText('Up to date');
});

test('a first read that fails says so instead of reading forever, then the list arrives', async ({ page }) => {
  await signUpFresh(page);
  let failed = 0;
  await page.route('**/api/staging', async (route) => {
    if (failed++ === 0) return route.fulfill({ status: 503, body: 'down' });
    return route.continue();
  });
  await page.goto('/ingest');
  await expect(page.getByTestId('staging-reading')).toHaveAttribute('data-state', 'failed', { timeout: LIVE });
  await expect(page.getByTestId('staging-reading')).toHaveText("Couldn't read the list. It tries again every few seconds.");
  await expect(page.getByTestId('staging-empty')).toBeVisible({ timeout: 20_000 });   // the 10 s idle poll
  await expect(page.getByTestId('staging-reading')).toHaveCount(0);
});

test('the board keys sit in the footer beside the 30-day note', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token, 'ab12');
  await page.goto('/ingest');
  const key = page.getByTestId('from-amiga-key');
  await expect(key).toHaveText('Bench: board key AB12', { timeout: LIVE });
  const note = page.getByText('Files from the Amiga are kept 30 days.', { exact: false });
  const k = (await key.boundingBox())!, n = (await note.boundingBox())!;
  expect(k.y).toBeGreaterThan((await page.getByTestId('staging-list').boundingBox())!.y);
  expect(Math.abs(k.y - n.y)).toBeLessThan(40);
});
```

(Check `boardSays`'s third argument name in this file before using it: its signature is `(request, token, upKey)`.)

- [ ] **Step 2: Run them to see them fail**

Run: `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop -g "radiogroup|shown at \(0\)|first read that fails|board keys sit"`
Expected: FAIL (`staging-filters` not found; Clear finished absent; `staging-reading` not found).

- [ ] **Step 3: Implement**

In `staging-list.tsx`, the section (spec §4) replaces `<section id="from-amiga" className="mx-4 pb-10 sm:mx-7"><UploadCard …>`:

```tsx
<section id="from-amiga" aria-labelledby="staging-heading" className="flex scroll-mt-24 flex-col gap-3 rounded-[20px] p-4 sm:p-5"
         style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
  <div className="flex flex-wrap items-center gap-3">
    <div className="flex items-center gap-1">
      <h2 id="staging-heading" tabIndex={-1} className="text-[16px] font-semibold focus:outline-none" style={{ color: 'var(--ink)' }}>Staging</h2>
      <HelpTip topic="from-amiga" />
    </div>
    <div role="radiogroup" aria-label="Show" data-testid="staging-filters" data-value={filter}
         className="seg seg--sm flex-wrap" onKeyDown={onFilterKey}>
      {FILTERS.map((f) => {
        const on = filter === f.id;
        return (
          <button key={f.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
                  data-testid={`staging-filter-${f.id}`} className="seg-item gap-1.5" onClick={() => setFilter(f.id)}>
            {f.label}<span className="font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>{view.counts[f.id]}</span>
          </button>
        );
      })}
    </div>
    <span className="flex-1" />
    <RefreshState loaded={s.loaded} failed={s.refreshFailed} />
    <button type="button" data-testid="staging-clear-finished" disabled={clearN === 0 || busy.has('clear-finished')}
            className="h-[34px] rounded-[9px] px-3 text-[13px] font-medium hover:bg-[var(--track)] disabled:cursor-default disabled:hover:bg-transparent"
            style={{ border: '1px solid var(--line)', color: clearN === 0 ? 'var(--muted-2)' : 'var(--ink)' }}
            onClick={() => void clear({ local: view.clearLocal, server: view.clearServer }, 'clear-finished')}>
      Clear finished ({clearN})
    </button>
  </div>
  {/* list: Task 4 restyles the rows */}
  <footer className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" style={{ color: 'var(--muted-2)' }}>
    <span>Files from the Amiga are kept 30 days. Anything here can go on to another place: a file from the Amiga into
      the library, a library disk to the Amiga.</span>
    {s.boards.filter((b) => b.key).map((b) => (
      <span key={b.id} data-testid="from-amiga-key" style={{ overflowWrap: 'anywhere' }}>
        {b.name}: board key <strong className="font-semibold" style={{ color: 'var(--ink)' }}>{b.key}</strong>
      </span>
    ))}
  </footer>
</section>
```

with

```tsx
function onFilterKey(e: React.KeyboardEvent<HTMLDivElement>) {
  const next = filterAfterKey(filter, e.key);
  if (!next) return;
  e.preventDefault();
  setFilter(next);
  e.currentTarget.querySelector<HTMLElement>(`[data-testid="staging-filter-${next}"]`)?.focus();
}

function RefreshState({ loaded, failed }: { loaded: boolean; failed: boolean }) {
  const state = failed ? 'failed' : loaded ? 'ok' : 'reading';
  return (
    <span data-testid="staging-refresh" data-state={state} className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
      {state === 'failed'
        ? <span role="status" data-testid="staging-refresh-failed" className="font-semibold" style={{ color: 'var(--danger-fg)' }}>Couldn&apos;t refresh</span>
        : state === 'reading' ? 'Reading…' : 'Up to date'}
    </span>
  );
}
```

(`refreshFailed` is set by any failed read and cleared by the next good one; `loaded` turns true on the first good
answer — read `staging-provider.tsx` to confirm both before relying on them.)

The reading line inside the `ul` (replaces today's `Reading the list…` `li`):

```tsx
{view.shown.length === 0 && rows.length === 0 && !s.loaded && (
  <li data-testid="staging-reading" data-state={s.refreshFailed ? 'failed' : 'reading'}
      className="px-2 py-3 text-[13px]" style={{ color: 'var(--muted)' }}>
    {s.refreshFailed ? "Couldn't read the list. It tries again every few seconds." : 'Reading the list…'}
  </li>
)}
```

`topics.tsx` `from-amiga`: "The same four digits appear under the Staging list on the Upload page, so check they
match your board." and, in "In the list", append `<em>Show</em> picks which rows the list holds: All, From the
Amiga, To the Amiga or To the library.` Source comment names this spec §4.

e2e edits (spec §9.4):

```ts
// from-amiga.spec.ts:162 (filter-all), :168 (filter-in); send-to-amiga.spec.ts:151, :181 (filter-out):
// each site keeps its own filter id, only the attribute changes.
await expect(page.getByTestId('staging-filter-out')).toHaveAttribute('aria-checked', 'true');
// from-amiga.spec.ts:125, send-to-amiga.spec.ts:217 (the `clear` locator), upload-staging.spec.ts:117
await expect(page.getByTestId('staging-clear-finished')).toHaveText('Clear finished (0)');
await expect(page.getByTestId('staging-clear-finished')).toBeDisabled();
```

Delete `upload-card.tsx` (`grep -rn "upload-card" src` → nothing).

- [ ] **Step 4: Run the tests to see them pass** (one at a time)

- `npx tsc --noEmit`; `pnpm lint`.
- `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop` → `13 passed`.
- `PORT=3100 npx playwright test e2e/from-amiga.spec.ts --project=desktop -g "appears with its board|one click|Clear finished clears|Send to an Amiga|every board's files|spares a finished send|Delete confirm"` → `7 passed`.
- `PORT=3100 npx playwright test e2e/from-amiga.spec.ts --project=desktop -g "sign-in page|finished while the confirm|404|CRC|resumes|0 B"` → `6 passed`.
- `PORT=3100 npx playwright test e2e/send-to-amiga.spec.ts --project=desktop` → `8 passed`.
- `PORT=3100 npx playwright test e2e/help.spec.ts --project=desktop` → `6 passed`.

- [ ] **Step 5: Commit** — files by name (the list above), message `Upload C3: Staging header, filter radiogroup, refresh state, footer`.

---

### Task 4: The row — pill, disk, parts, the xl grid and the stacked card

**Files:**
- Create: `src/components/ingest/staging-row.tsx`, `src/components/ingest/staging-row.test.ts`
- Modify: `src/components/ingest/staging-list.tsx` (uses `StagingRow`; the `ul` per spec §4.2; its local `Row`,
  `PILL`, `DOT` go)
- Test: `e2e/upload-staging.spec.ts` (new tests)

**Interfaces:**
- Consumes: `ViewRow` (with `pct`), `directionPill`, `toneLook`, `rowDiskColor`, `DiskIcon`, `HdTag`,
  `adfDensity`, `isHfeFilename`.
- Produces: `StagingRow({ v, children })` (children = the actions, rendered into `staging-actions-<key>`).

- [ ] **Step 1: Write the failing tests**

`src/components/ingest/staging-row.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StagingRow } from './staging-row';
import { stagingView, type LibRow, type ServerRow } from '@/lib/upload-staging';

const amiga = (o: Partial<ServerRow>): ServerRow => ({ source: 'server', key: 'amiga:u1', kind: 'in', id: 'u1',
  name: 'DH0:Docs/Very/Long/Path/amiga-wb31_storage.adf', sizeBytes: 901_120, board: { id: 'd1', name: 'Bench' },
  status: 'receiving', doneBytes: 0, pct: 47, savedAs: null, error: null, isDiskImage: true, title: null, at: 1, ...o });
const lib = (o: Partial<LibRow>): LibRow => ({ source: 'lib', key: 'lib:abc', kind: 'lib', name: 'Bad.zip',
  sizeBytes: 1_000_000, state: 'failed', note: 'No disk images inside', title: null, at: 1, ...o });
const html = (r: ServerRow | LibRow) =>
  renderToStaticMarkup(createElement(StagingRow, { v: stagingView([r], 'all', new Set()).shown[0] }, 'ACTIONS'));

describe('StagingRow (spec §5)', () => {
  it('keeps the row attributes and every part id', () => {
    const h = html(amiga({}));
    expect(h).toMatch(/<li[^>]*data-testid="staging-row"[^>]*data-kind="in"[^>]*data-state="receiving"[^>]*data-key="amiga:u1"/);
    for (const id of ['staging-dir-amiga:u1', 'staging-where-amiga:u1', 'staging-size-amiga:u1',
      'staging-status-amiga:u1', 'staging-progress-amiga:u1', 'staging-actions-amiga:u1']) {
      expect(h).toContain(`data-testid="${id}"`);
    }
    expect(h).toContain('ACTIONS');
  });
  it('the pill says the direction with an aria-hidden arrow', () => {
    expect(html(amiga({}))).toMatch(/data-testid="staging-dir-amiga:u1"[^>]*><span aria-hidden="true">←<\/span>From Amiga</);
  });
  it('the progress bar is aria-hidden at the row percent, and absent without one', () => {
    expect(html(amiga({}))).toMatch(/data-testid="staging-progress-amiga:u1"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-testid="staging-progress-amiga:u1"/);
    expect(html(amiga({}))).toContain('width:47%');
    expect(html(amiga({ status: 'stored', pct: null }))).not.toContain('staging-progress-');
  });
  it('the status holds only its words (a dot without text), and a refused library file keeps ingest-note', () => {
    const h = html(lib({}));
    expect(h).toMatch(/data-testid="staging-status-lib:abc"[^>]*>(<span aria-hidden="true"[^>]*><\/span>)?<span>Failed · <span data-testid="ingest-note">No disk images inside<\/span>/);
  });
  it('one line from xl, a three-line card below it; names wrap, never ellipsis', () => {
    const h = html(amiga({}));
    expect(h).toContain('xl:grid-cols-[40px_140px_minmax(0,1fr)_90px_190px_400px]');
    expect(h).toContain('grid-cols-[40px_minmax(0,1fr)_auto]');
    expect(h).not.toContain('text-ellipsis');
    expect(h).not.toContain('truncate');
    expect(h).toContain('overflow-wrap:anywhere');
  });
});
```

New e2e in `e2e/upload-staging.spec.ts`:

```ts
test('a row at 1440 px is one line: disk, pill, name and where, size, status with its bar, actions', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const id = await seedUpload(orgId, deviceId, 'Bench', { path: 'Moving.bin', status: 'receiving', size: 20_000, received: 16_384 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/ingest');
  const key = `amiga:${id}`;
  await expect(page.getByTestId(`staging-status-${key}`)).toContainText('Arriving · 81 %', { timeout: LIVE });
  await expect(page.getByTestId(`staging-dir-${key}`)).toHaveText('←From Amiga');
  await expect(page.getByTestId(`staging-where-${key}`)).toHaveText('from Bench');
  await expect(page.getByTestId(`staging-size-${key}`)).toContainText('KB');
  const bar = page.getByTestId(`staging-progress-${key}`).locator('span');
  expect(await bar.evaluate((el) => el.style.width)).toBe('81%');
  const mid = async (sel: string) => { const b = (await page.getByTestId(sel).boundingBox())!; return b.y + b.height / 2; };
  const y = await mid(`staging-dir-${key}`);
  for (const sel of [`staging-size-${key}`, `staging-actions-${key}`]) expect(Math.abs((await mid(sel)) - y)).toBeLessThan(12);
});

test('below xl the row stacks: the actions sit under the name', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const id = await seedUpload(orgId, deviceId, 'Bench', { path: 'Keep.txt', status: 'stored' });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/ingest');
  const key = `amiga:${id}`;
  await expect(page.getByTestId(`staging-actions-${key}`)).toBeVisible({ timeout: LIVE });
  const where = (await page.getByTestId(`staging-where-${key}`).boundingBox())!;
  const acts = (await page.getByTestId(`staging-actions-${key}`).boundingBox())!;
  expect(acts.y).toBeGreaterThan(where.y + where.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test src/components/ingest/staging-row.test.ts` → FAIL (no module).
Run: `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop -g "one line|row stacks"` → FAIL.

- [ ] **Step 3: Implement**

`src/components/ingest/staging-row.tsx` (client, because of `DiskIcon`):

```tsx
'use client';
import { DiskIcon } from '@/components/ui/disk-icon';
import { HdTag } from '@/components/disks/hd-tag';
import { adfDensity, isHfeFilename } from '@/lib/disk-format';
import { directionPill, rowDiskColor, toneLook } from '@/lib/upload-look';
import type { ViewRow } from '@/lib/upload-staging';

const XL = 'xl:col-auto xl:row-auto xl:col-start-auto xl:row-start-auto xl:row-span-1 xl:col-span-1';

/** One Staging row (C3 spec §5): the board's one-line grid from xl, a three-line card below. */
export function StagingRow({ v, children }: { v: ViewRow; children: React.ReactNode }) {
  const pill = directionPill(v.kind);
  const tone = toneLook(v.tone);
  const hd = v.kind === 'lib' && !isHfeFilename(v.name) && adfDensity(v.row.sizeBytes) === 'hd';
  const failNote = v.row.source === 'lib' && v.row.state === 'failed' && v.row.note ? v.row.note : null;
  return (
    <li data-testid="staging-row" data-kind={v.kind} data-state={v.state} data-key={v.key}
        className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 rounded-[10px] px-2 py-2 hover:bg-[var(--modal-foot)] xl:min-h-[58px] xl:grid-cols-[40px_140px_minmax(0,1fr)_90px_190px_400px] xl:items-center xl:gap-3.5"
        style={{ borderBottom: '1px solid var(--hairline)' }}>
      <span className={`row-span-3 self-start xl:self-center ${XL}`}><DiskIcon color={rowDiskColor(v)} size={32} /></span>
      <span data-testid={`staging-dir-${v.key}`} className={`col-start-3 row-start-1 flex items-center gap-1.5 justify-self-end whitespace-nowrap rounded-full px-[9px] py-0.5 text-[12px] font-semibold xl:justify-self-start ${XL}`}
            style={{ background: pill.bg, color: pill.fg }}>
        <span aria-hidden="true">{pill.arrow}</span>{pill.label}
      </span>
      <span className={`col-start-2 row-start-1 flex min-w-0 flex-col gap-0.5 ${XL}`}>
        <span style={{ overflowWrap: 'anywhere' }}>
          <span className="font-mono text-[13px] font-medium" style={{ color: 'var(--ink)' }}>{v.name}</span>
          {v.note && <span className="ml-2 text-[12px]" data-testid="ingest-note" style={{ color: 'var(--muted)' }}>{v.note}</span>}
        </span>
        <span data-testid={`staging-where-${v.key}`} className="text-[12px]" style={{ color: 'var(--muted-2)', overflowWrap: 'anywhere' }}>{v.where}</span>
      </span>
      <span data-testid={`staging-size-${v.key}`} className={`col-start-3 row-start-2 flex items-center justify-end gap-1 font-mono text-[12px] ${XL}`}
            style={{ color: 'var(--muted-2)' }}>
        {v.size}{hd && <HdTag testId="ingest-hd-tag" />}
      </span>
      <span className={`col-start-2 row-start-2 flex min-w-0 flex-col gap-[5px] ${XL}`}>
        <span data-testid={`staging-status-${v.key}`} className="flex items-center gap-1.5 text-[12px] font-semibold"
              style={{ color: tone.fg, overflowWrap: 'anywhere' }}>
          <span aria-hidden="true" className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: tone.dot }} />
          {failNote ? <span>Failed · <span data-testid="ingest-note">{failNote}</span></span> : v.status}
        </span>
        {v.pct !== null && (
          <span data-testid={`staging-progress-${v.key}`} aria-hidden="true" className="block h-[5px] overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
            <span className="block h-[5px]" style={{ width: `${v.pct}%`, background: 'var(--fetch-dot)' }} />
          </span>
        )}
      </span>
      <span data-testid={`staging-actions-${v.key}`} className={`col-span-2 col-start-2 row-start-3 flex flex-wrap items-center gap-1.5 xl:justify-end ${XL}`}>
        {children}
      </span>
    </li>
  );
}
```

(The status's `toHaveText('Stored')` in `from-amiga.spec` keeps passing: the dot has no text. The unit test's
`width:47%` matches React's static style output `width:47%`.)

`staging-list.tsx`: `<ul aria-label="Staging" data-testid="staging-list" className="flex flex-col md:max-h-[36rem] md:overflow-y-auto">`
(no border, no fill); `view.shown.map((v) => <StagingRow key={v.key} v={v}>{v.actions.map((a) => action(v, a))}</StagingRow>)`;
delete `Row`, `PILL`, `DOT`.

- [ ] **Step 4: Run the tests to see them pass** (one at a time)

- `pnpm test src/components/ingest/staging-row.test.ts` → PASS. `npx tsc --noEmit`; `pnpm lint`.
- `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop` → `15 passed`.
- `PORT=3100 npx playwright test e2e/from-amiga.spec.ts --project=desktop -g "appears with its board|one click|Clear finished clears|Send to an Amiga|every board's files|spares a finished send|Delete confirm"` → `7 passed`.
- `PORT=3100 npx playwright test e2e/from-amiga.spec.ts --project=desktop -g "sign-in page|finished while the confirm|404|CRC|resumes|0 B"` → `6 passed`.
- `PORT=3100 npx playwright test e2e/send-to-amiga.spec.ts --project=desktop` → `8 passed` (incl. the 36rem box).
- `PORT=3100 npx playwright test e2e/hd-disks.spec.ts --project=desktop -g "uploaded HD ADF"` → `1 passed` (`ingest-hd-tag`).
- `PORT=3100 npx playwright test e2e/hfe-disks.spec.ts --project=desktop -g "v1 Amiga HFE|refused on the row|server-side refusal|oversize file|splits a drop"` → `5 passed` (`ingest-note`).
- `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "Upload page stacks"` → `1 passed` (the 200-byte path wraps).

- [ ] **Step 5: Commit** — files by name, message `Upload C3: the Staging row, one line from xl, a card below`.

---

### Task 5: Row actions, the Send select, the confirm, and focus after a removal

**Files:**
- Modify: `src/components/ingest/staging-list.tsx` (`action()` look per spec §5.3; focus per §6.3)
- Modify: `src/components/ingest/staging-confirm.tsx` (spec §5.4)
- Test: `e2e/upload-staging.spec.ts` (new tests)

**Interfaces:**
- Consumes: today's handlers in `staging-list.tsx` (`cancel`, `retry`, `addToLibrary`, `sendTo`, `removeUpload`,
  `download`, `clear`) — unchanged.
- Produces: the `ACT` class constant and `ACT_DANGER` style; `focusHeadingIfLost()`.

- [ ] **Step 1: Write the failing tests** (in `e2e/upload-staging.spec.ts`)

```ts
test('row actions: outline buttons, destructive ones red, Retry ink; Send to Amiga… is a select named by board and MAC', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const stored = await seedUpload(orgId, deviceId, 'Bench', { path: 'Keep.txt', status: 'stored' });
  const failedSend = await seedSend(orgId, deviceId, { path: 'Bad.bin', status: 'failed' });
  await page.goto('/ingest');
  const del = page.getByTestId(`staging-delete-amiga:${stored}`);
  await expect(del).toBeVisible({ timeout: LIVE });
  const color = (l: typeof del) => l.evaluate((el) => getComputedStyle(el).color);
  expect(await color(del)).toBe('rgb(179, 52, 31)');                                     // --danger-fg
  expect(await color(page.getByTestId(`staging-download-amiga:${stored}`))).toBe('rgb(36, 33, 27)');   // ink
  const retry = page.getByTestId(`staging-retry-send:${failedSend}`);
  expect(await retry.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(36, 33, 27)');
  const send = page.getByTestId(`staging-send-amiga:${stored}`);
  await expect(send).toHaveJSProperty('tagName', 'SELECT');
  await expect(send.locator('option').first()).toHaveText('Send to Amiga…');
  await expect(send.locator('option').nth(1)).toHaveText(/^Bench( \(.+\))?$/);
  expect((await del.boundingBox())!.height).toBeGreaterThanOrEqual(31);                 // the board's 32 px
});

test('after Delete removes the row, focus goes to the Staging heading', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'Bench');
  const id = await seedUpload(orgId, deviceId, 'Bench', { path: 'Gone.txt', status: 'stored' });
  await page.goto('/ingest');
  await page.getByTestId(`staging-delete-amiga:${id}`).click();
  await expect(page.getByTestId('staging-confirm-cancel')).toBeFocused();
  await page.getByTestId('staging-confirm-yes').click();
  await expect(row(page, `amiga:${id}`)).toHaveCount(0, { timeout: LIVE });
  await expect(page.locator('#staging-heading')).toBeFocused();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop -g "row actions|focus goes to the Staging heading"`
Expected: FAIL (Delete is ink; focus is on `body`).

- [ ] **Step 3: Implement**

In `staging-list.tsx`, replace `btn` / `quiet` with:

```ts
const ACT = 'inline-flex h-8 shrink-0 items-center rounded-[8px] px-2.5 text-[12px] font-medium hover:bg-[var(--track)] disabled:opacity-50';
const ACT_STYLE = { background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' } as const;
const ACT_DANGER = { ...ACT_STYLE, color: 'var(--danger-fg)' } as const;
```

Per spec §5.3: `open` → `<Link … className={ACT} style={ACT_STYLE}>Open title</Link>`; `add`, `download`, `clear` →
`ACT`/`ACT_STYLE`; `delete`, `stop`, `cancel` → `ACT`/`ACT_DANGER`; `retry` → `ACT` with
`{ background: 'var(--ink)', color: 'var(--surface)', border: '1px solid var(--ink)' }`; `send` →

```tsx
<span key={a} className="relative inline-flex">
  <select aria-label={`Send ${v.name} to an Amiga`} data-testid={id} value="" disabled={disabled}
          className={`${ACT} appearance-none pr-7`} style={ACT_STYLE}
          onChange={(e) => { const t = targets.find((x) => x.id === e.target.value); if (t) void sendTo(v, t); }}>
    <option value="">Send to Amiga…</option>
    {targets.map((t) => <option key={t.id} value={t.id}>{targetLabel(t)}</option>)}
  </select>
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
    <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="var(--muted)" strokeWidth="1.5" />
  </svg>
</span>
```

Focus after a removal (spec §6.3): a ref-free helper called after `setConfirm(null)` in `removeUpload`'s `.finally`
and after a row `clear`:

```ts
const focusHeadingIfLost = () => requestAnimationFrame(() => {
  if (!document.activeElement || document.activeElement === document.body) {
    document.getElementById('staging-heading')?.focus();
  }
});
```

`staging-confirm.tsx`: keep the focus code; the panel `glass-card wf-modal w-full max-w-[440px] p-6`; the question
`h2` `text-[20px] font-bold` with `fontFamily: 'var(--font-display)'`; footer `mt-5 flex justify-end gap-2.5`;
Cancel `h-[38px] rounded-[10px] px-4 text-[13px] font-semibold` on `var(--surface)` with `1px solid var(--line)`,
ink; yes the same shape on `var(--danger-fg)`, white.

- [ ] **Step 4: Run the tests to see them pass** (one at a time)

- `npx tsc --noEmit`; `pnpm lint`.
- `PORT=3100 npx playwright test e2e/upload-staging.spec.ts --project=desktop` → `17 passed`.
- `PORT=3100 npx playwright test e2e/from-amiga.spec.ts --project=desktop -g "appears with its board|one click|Clear finished clears|Send to an Amiga|every board's files|spares a finished send|Delete confirm"` → `7 passed`.
- `PORT=3100 npx playwright test e2e/from-amiga.spec.ts --project=desktop -g "sign-in page|finished while the confirm|404|CRC|resumes|0 B"` → `6 passed`.
- `PORT=3100 npx playwright test e2e/send-to-amiga.spec.ts --project=desktop` → `8 passed`.

- [ ] **Step 5: Commit** — files by name, message `Upload C3: row actions, the Send select, the confirm, focus after a removal`.

---

### Task 6: States, contrast, phone, the regression and the screenshot

**Files:**
- Create: `src/app/(app)/ingest/loading.tsx`, `src/app/(app)/ingest/loading.test.ts`
- Modify: `src/components/ingest/staging-list.tsx` (the empty `li` per spec §6.1)
- Modify: `e2e/contrast.spec.ts` (an Upload test, spec §8), `e2e/screenshots.shots.ts` (the `upload` shot)
- Test: `e2e/mobile.spec.ts` only if an Upload test needs a selector update from Tasks 2–5 (none expected)

**Interfaces:**
- Consumes: `PageSkeleton`, `Bone` (`src/components/shell/skeleton.tsx`), `DiskIcon`, the `probe`/`ratio` helpers in
  `contrast.spec.ts`, `shoot` in `screenshots.shots.ts`.
- Produces: `upload-skeleton`; `docs/screenshots/upload.png`.

- [ ] **Step 1: Write the failing tests**

`src/app/(app)/ingest/loading.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import UploadLoading from './loading';

describe('UploadLoading (spec 6.4)', () => {
  const html = renderToStaticMarkup(createElement(UploadLoading));
  it('is the upload-skeleton page skeleton', () => {
    expect(html).toContain('data-testid="upload-skeleton"');
    expect(html).toContain('role="status"');
  });
  it('holds two dashed card bones side by side from lg, then a list bone with four row bones', () => {
    expect(html).toContain('lg:grid-cols-2');
    expect(html.match(/data-skeleton-card/g)?.length).toBe(2);
    expect(html).toContain('dashed');
    expect(html.match(/data-skeleton-row/g)?.length).toBe(4);
    expect(html.indexOf('data-skeleton-card')).toBeLessThan(html.indexOf('data-skeleton-row'));
  });
  it('uses a 44 px heading bone first', () => {
    expect(html).toMatch(/class="[^"]*\bh-11\b/);
    expect(html.search(/\bh-11\b/)).toBeLessThan(html.indexOf('data-skeleton-card'));
  });
});
```

`e2e/contrast.spec.ts` (new test; reuse the file's `probe`, `ratio`, and import `seedUpload`-like inserts inline —
this file seeds with `getDb()` already):

```ts
test('the Upload pairs are legible: pills, statuses, where on a hovered row, counts, footnote, receiver, Delete, Browse, hint', async ({ page, request }) => {
  const u = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, `Up ${runTag().slice(0, 6)}`);
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.19.0+gabc1234', secondDrive: 'net', driveVersion: 0, upKey: 'ab12' } })).status()).toBe(204);
  const now = Date.now();
  const ids = { stored: randomUUID(), moving: randomUUID(), failed: randomUUID(), queued: randomUUID(), sent: randomUUID() };
  await getDb().insert(amigaUploads).values([
    { id: ids.stored, orgId: u.orgId, deviceId, deviceName: 'Up', path: 'Keep.txt', sizeBytes: 11, amigaDate: '17000.600.0',
      status: 'stored', receivedBytes: 11, blobSha256: '0'.repeat(64), createdAt: new Date(now), storedAt: new Date(now), expiresAt: new Date(now + 30 * 86_400_000) },
    { id: ids.moving, orgId: u.orgId, deviceId, deviceName: 'Up', path: 'Moving.bin', sizeBytes: 20_000, amigaDate: '17000.600.0',
      status: 'receiving', receivedBytes: 16_384, createdAt: new Date(now - 1000), expiresAt: new Date(now + 86_400_000) },
    { id: ids.failed, orgId: u.orgId, deviceId, deviceName: 'Up', path: 'Bad.txt', sizeBytes: 11, amigaDate: '17000.600.0',
      status: 'failed', receivedBytes: 11, errorCode: 'crc', createdAt: new Date(now - 2000), expiresAt: new Date(now + 86_400_000) },
  ]);
  uploadIdsToDelete.push(ids.stored, ids.moving, ids.failed);   // a file-level array, deleted in afterAll
  await getDb().insert(transfers).values([
    { id: ids.queued, orgId: u.orgId, deviceId, createdByUserId: 'e2e-contrast', path: 'Wait.bin', sizeBytes: 11, crc32: 0,
      blobSha256: '0'.repeat(64), status: 'queued', createdAt: new Date(now - 3000), expiresAt: new Date(now + 7 * 86_400_000) },
  ]);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/ingest');
  const k = (p: string, id: string) => `[data-testid="${p}-${id}"]`;
  await expect(page.locator(k('staging-status', `amiga:${ids.moving}`))).toContainText('Arriving', { timeout: 15_000 });
  const pairs: [string, string][] = [
    ['From Amiga pill', k('staging-dir', `amiga:${ids.stored}`)],
    ['To Amiga pill', k('staging-dir', `send:${ids.queued}`)],
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
  expect(ratio(where!.fg, where!.bg), 'where on a hovered row').toBeGreaterThan(4.5);
  // A library row's pill: drop one disk.
  // (Use the file's existing ADF builder if it has one; else Buffer.alloc(901_120) with 'DOS\0' + runTag at 0.)
  await page.screenshot({ path: 'test-results/zz-upload.png', fullPage: true });
});
```

(Add the `amigaUploads` / `transfers` imports and an `afterAll` delete for `uploadIdsToDelete`; the board's devices
and their transfers go with `cleanupSeeded()`, which the file already calls. Add a `To library` pill probe by
dropping one ADF through `file-input` and probing `staging-dir-lib:<sha>` — the pill is `--muted` on `--track`.
)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test "src/app/(app)/ingest/loading.test.ts"` → FAIL (no module).
Run: `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop -g "Upload pairs"` → PASS or FAIL; it
must be green after Step 3. (If it already passes, the tokens from Tasks 1–5 are right — record the logged ratios.)

- [ ] **Step 3: Implement**

`src/app/(app)/ingest/loading.tsx`:

```tsx
import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The Upload page while it loads (C3 spec 6.4): heading and subtitle bones, the two drop cards, then the Staging
// section with four row bones. Nested under (app)/loading.tsx like the library's and the devices', so status codes
// do not change.
export default function UploadLoading() {
  return (
    <PageSkeleton testId="upload-skeleton">
      <div className="flex flex-col gap-2 px-4 pb-4 sm:px-7">
        <Bone className="h-11 w-40" />
        <Bone className="h-3 w-72" />
      </div>
      <div className="flex flex-col gap-6 px-4 pb-10 sm:px-7">
        <div className="grid gap-5 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton-card className="flex h-[134px] items-center gap-5 rounded-[20px] p-6"
                 style={{ border: '1.5px dashed var(--line-strong)' }}>
              <Bone className="h-[84px] w-[84px] shrink-0" />
              <div className="flex flex-1 flex-col gap-2"><Bone className="h-5 w-2/3" /><Bone className="h-3 w-full" /><Bone className="h-[38px] w-28" /></div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-[20px] p-5" style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          <Bone className="h-[34px] w-full" />
          {[0, 1, 2, 3].map((i) => <div key={i} data-skeleton-row><Bone className="h-[58px] w-full" /></div>)}
        </div>
      </div>
    </PageSkeleton>
  );
}
```

The empty `li` (spec §6.1) in `staging-list.tsx`:

```tsx
<li data-testid="staging-empty" className="flex flex-col items-center gap-2.5 py-10 text-center">
  <DiskIcon color="cream" size={48} />
  <span className="text-[14px]" style={{ color: 'var(--muted)' }}>
    {filter === 'all' || rows.length === 0 ? 'Nothing here yet. Drop disks for the library, or files for the Amiga.' : EMPTY_UNDER[filter]}
  </span>
</li>
```

(The text sits in a child `span`; `toHaveText` on `staging-empty` still reads exactly the sentence because the disk
has no text. Check that `upload-staging`'s Task 3 test `toHaveText('Nothing to the library right now.')` holds.)

`e2e/screenshots.shots.ts`: after the set-suggestion block of "upload through the real ingest page", add
`await page.setViewportSize({ width: 1440, height: 1100 }); await shoot(page, 'upload');` and restore the previous
viewport if the file uses another one for the following shots.

- [ ] **Step 4: Run the tests to see them pass** (unit, then e2e one at a time)

- `pnpm test "src/app/(app)/ingest/loading.test.ts" src/components/ingest src/lib/upload-look.test.ts src/lib/upload-staging.test.ts src/lib/design-tokens.test.ts` → PASS.
- `npx tsc --noEmit`; `pnpm lint`.
- `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop` → all pass, one test more than before
  (count with `--list`; the sign-in/sign-up loop makes two tests from one `test(` call).
- `PORT=3100 npx playwright test e2e/states.spec.ts --project=desktop` → `5 passed`.
- `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → `2 passed`.
- Phone: `PORT=3100 npx playwright test e2e/mobile.spec.ts --project=mobile -g "Upload page stacks|bottom bar|nav"`
  (check the nav test's title with `--list`; it taps Upload) → all selected pass.
- Phone by hand (390×844, the dev server on 3100): `/ingest` with a seeded stored file and a failed send — cards
  stacked, Browse above the URL field, the filter wraps, rows are three-line cards with wrapped actions, the confirm
  fits, `document.documentElement.scrollWidth === clientWidth`. Record what you saw in the report.

**Final regression** — every spec this area touches, one run at a time, each under 9 minutes, split with `-g` and
checked with `--list` so each file is covered whole:

1. `e2e/upload-staging.spec.ts` (whole) → `17 passed`.
2. `e2e/from-amiga.spec.ts` in the two `-g` runs of Task 3 → `7 passed`, `6 passed`.
3. `e2e/send-to-amiga.spec.ts` (whole) → `8 passed`.
4. `e2e/ingest-ui.spec.ts` → `5 passed`; `e2e/url-upload.spec.ts` → `5 passed`.
5. `e2e/hd-disks.spec.ts -g "uploaded HD ADF"` → `1 passed`; `e2e/hfe-disks.spec.ts -g "v1 Amiga HFE|refused on the row|server-side refusal|oversize file|splits a drop|shows the tag"` → `6 passed`.
6. `e2e/disk-sets.spec.ts -g "upload:"` → `2 passed`.
7. `e2e/devices-page.spec.ts -g "Transfer|from the Amiga|send"` (check with `--list`; the Devices links into this page) → all selected pass.
8. `e2e/help.spec.ts` → `6 passed`; `e2e/help.mobile.spec.ts --project=mobile` → all pass.
9. `e2e/mobile.spec.ts --project=mobile -g "Upload"` → all selected pass.
10. `e2e/contrast.spec.ts`, `e2e/states.spec.ts`, `e2e/shell.spec.ts` (from above).

Then `PORT=3100 pnpm screenshots` and compare `docs/screenshots/upload.png` with InfUploadTransfer by eye (two cards,
the Staging header, the one-line rows at 1440). Commit ONLY `docs/screenshots/upload.png` by name; the run regenerates
the other PNGs too — restore each with `git checkout -- docs/screenshots/<name>.png` (never with stash) and confirm
`git status --short docs/screenshots` lists only `upload.png`.

- [ ] **Step 5: Commit** — `src/app/(app)/ingest/loading.tsx`, `src/app/(app)/ingest/loading.test.ts`,
`src/components/ingest/staging-list.tsx`, `e2e/contrast.spec.ts`, `e2e/screenshots.shots.ts`,
`docs/screenshots/upload.png`, message `Upload C3: loading and empty states, contrast, screenshot`.

---

## Self-review (against the spec)

- §1 page → Task 2. §2 drop cards → Task 2. §3 look rules + `pct` → Task 1. §4.1 header, §4.3 footer, §6.2 reading
  → Task 3. §4.2 list, §5.1–5.2 row → Task 4. §5.3 actions, §5.4 confirm, §6.3 focus → Task 5. §6.1 empty, §6.4
  loading, §8 contrast (page), §10 phone, screenshot → Task 6. §7 tokens, §8 contrast (tokens) → Task 1. §9.4 spec
  edits → Tasks 3 (aria-checked, Clear finished (0)), 2–5 (new tests), 6 (contrast, screenshots). §11 help → Tasks 2
  (`send`) and 3 (`from-amiga`).
- Expected pass counts assume the spec files as of `5291ce2` plus this plan's additions (upload-staging: 7 → 9 after
  Task 2 → 13 after Task 3 → 15 after Task 4 → 17 after Task 5). If a count differs, recount with `--list` before
  calling it a failure.
