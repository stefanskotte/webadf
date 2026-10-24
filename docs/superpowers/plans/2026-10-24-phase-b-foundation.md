# Phase B design foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The whole app takes the WebFloppy look (cream ground, flat hairline surfaces, ink buttons, rust accent,
Bricolage Grotesque / Geist / Geist Mono) and the WebFloppy name, with today's page layouts and every `data-testid`
unchanged.

**Architecture:** The new palette is mapped onto the EXISTING token names in `src/app/globals.css` (888 `var(--…)`
reads stay as they are); a handful of tokens are added (`--ground`, `--surface`, `--surface-2`, `--track`, `--line`,
`--line-strong`, `--scrim`, `--shadow-modal`, `--font-display`). `.glass-card` becomes a flat surface with a 1px line
border. The ~30 sites that only worked on the old dark gradient are fixed by hand from a list. The header keeps its
geometry (viewport-centred nav, measured chip budget, mobile bottom bar) and is restyled piece by piece. New shared
pieces: `.seg`/`.seg-item` (segmented control), `.wf-modal`, `DiskIcon`.

**Tech Stack:** Next.js 16.3.2 App Router (read `node_modules/next/dist/docs/` before touching layouts or fonts —
this Next has breaking changes; fonts: `01-app/01-getting-started/13-fonts.md`, `01-app/03-api-reference/02-components/font.md`),
React 19 client components, Tailwind v4 (`@theme inline` in `globals.css`), vitest (node env, `src/**/*.test.ts`),
Playwright (`desktop` and `mobile` projects).

**Spec:** `docs/superpowers/specs/2026-10-24-phase-b-foundation-design.md` (read it first; §4 is the token map, §6 the
header, §8 the hand-fix list, §9 the rename list — all values in this plan come from it).

## Global Constraints

- Values come from the spec's §4 tables verbatim. Do NOT add a token named `--accent` (it is shadcn's menu
  highlight); the design's accent is `--accent-amber` (fill) / `--amber-text` (text).
- No page layout changes: no grid, column, padding, card-proportion or order changes outside the header pieces the
  spec §6 lists. Inline buttons keep their shapes (spec §3.12).
- Every existing `data-testid` and the `data-nav-pill` attribute stay. New ids only: `app-header`, `admin-header`,
  `about-link`, `sign-out`, attribute `data-pill-estimate`.
- `chipSlots` thresholds (`src/lib/drive-chips.ts`) and `MAX_CHIPS` do not change. Header side padding stays
  `px-4 sm:px-7`.
- `.glass-card` keeps a 1px border (geometry), never a ring shadow.
- Not renamed: the `webadf push` CLI hint, the repository URL, `Hosted (webadf.vercel.app)`, the `about-webadf`
  id, the board/firmware names (spec §9).
- House rules: unit `npx vitest run`; typecheck `npx tsc --noEmit`; e2e
  `PORT=3100 npx playwright test e2e/<spec> --project=desktop` (or `--project=mobile` for `*mobile.spec.ts`), ONE
  run at a time, each foreground call under 9 minutes (split by `-g "<test name>"` if a spec is long); the e2e
  suite writes to the live production DB, so never run two at once. Never `git add -A` (stage the named files);
  never `git stash`; stop only your own PIDs; never print `.env.local`; no commit after a red run.
- Work on branch `feat/phase-b-foundation` from master in a worktree (memory "Worktree setup for e2e": real
  `pnpm install --offline`, copy `.env.local`, `npx next typegen`, the `adf-archive` symlink).
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014S2nFFB6otda3iPEfAnuwc
  ```

## Review Focus

1. No ink-on-ink or light-on-light left: the spec §8 greps return only the "left as they are" lines (Task 2, Task 6).
2. Every text pair in spec §4.5 marked "pass" is ≥ 4.5:1 as written in `globals.css` (`design-tokens.test.ts`, Task 1) and on screen (`contrast.spec.ts`, Task 6).
3. The header's measured geometry still holds: `drive-chips.spec.ts` passes unchanged at 1280/1536/1920/390 and `data-pill-estimate` is within 2px of the real pill (Task 4).
4. No box moved: `collections.spec.ts`, `disk-sets.spec.ts`' bounding-box tests and `mobile.spec.ts` pass with no edits (Tasks 1, 3, 6).
5. The rename touched exactly spec §9's six strings + icons, and nothing in the "not renamed" list (Task 5).

---

### Task 1: Tokens, fonts and base utilities

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/app/layout.tsx` (fonts and the body class only; the title is Task 5)
- Modify: `src/app/global-error.tsx:11`, `:21`
- Create: `src/lib/design-tokens.test.ts`
- Modify: `e2e/shell.spec.ts`

**Interfaces:**
- Produces: CSS custom properties per spec §4.1–4.3; utilities `.bg-page`, `.glass-card` (flat), `.wf-modal`;
  Tailwind colours `ground`, `surface`, `surface-2`, `track`, `line`; `font-heading` = Bricolage.

- [ ] **Step 1: Write the failing unit test** `src/lib/design-tokens.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { describe, expect, it } from 'vitest';

  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
  /** The LAST hex value per custom property (the webadf :root block overrides shadcn's). */
  function tokens(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toUpperCase();
    return out;
  }
  function lum(hex: string) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  ```
  Cases:
  - the values: `--ground #F3EFE6`, `--surface #FFFDF8`, `--surface-2 #F6F2E9`, `--track #EFE9DD`, `--line #E4DCCB`,
    `--line-strong #D3C8B2`, `--ink #24211B`, `--foreground #24211B`, `--muted #5B5446`, `--muted-2 #6E6657`,
    `--faint #6E6657`, `--on-dark #24211B`, `--on-dark-muted #5B5446`, `--primary-action #24211B`,
    `--accent-amber #B5541A`, `--amber-text #A84C16`, `--danger-fg #B3341F`, `--success-fg #1F6A2A`,
    `--warning-fg #7A4A08`, `--online-dot #3FBF55` (one `it.each`);
  - AA ≥ 4.5 for: ink on ground/surface/track; muted on surface/ground/surface-2/track; muted-2 and faint on
    surface/ground/surface-2/track; amber-text on surface/ground/surface-2/track; accent-amber on surface; `#FFFFFF`
    on accent-amber, on primary-action, on danger-fg; danger-fg on surface and on danger-bg; success-fg on
    success-bg; warning-fg on warning-bg (read every colour through `tokens()`, never a literal except `#FFFFFF`);
  - no `--grad-` token remains (`expect(css).not.toMatch(/--grad-/)`);
  - `tokens()['--accent']` is `#F6F2E9` (shadcn's menu highlight; the rust accent must never land on `--accent`).
- [ ] **Step 2: Run it, expect FAIL:** `npx vitest run src/lib/design-tokens.test.ts`.
- [ ] **Step 3: Edit `globals.css`.**
  - In the first (shadcn) `:root` block set the §4.2 values as hex (`--background: #F3EFE6;` … `--ring: #7A7262;`).
    Leave `--muted`, `--chart-*`, `--sidebar-*`, `--radius` and the `.dark` block untouched.
  - In the webadf `:root` block: delete `--grad-top` … `--grad-bot`; set every §4.1 value; add the §4.3 tokens
    (`--ground`, `--surface`, `--surface-2`, `--track`, `--line`, `--line-strong`, `--scrim`, `--shadow-modal`) and
    `color-scheme: light;`. Replace the long comments that describe the old values (the gradient ramp, the
    `--muted` ramp's old ratios, `--nav-scrim`'s dark reasoning) with short ones that state the new ratios from
    spec §4.5 and the rule "text uses `--amber-text`; `--accent-amber` is a fill (4.31:1 on the ground)". Add one
    block comment above the tokens: names predate the redesign; `--on-dark` now means "text on the page ground",
    `--glass*` are opaque surfaces (spec §3.1).
  - `@theme inline` (second block): `--radius-card: 16px;` and add `--color-ground: var(--ground);`
    `--color-surface: var(--surface);` `--color-surface-2: var(--surface-2);` `--color-track: var(--track);`
    `--color-line: var(--line);`. First `@theme inline`: `--font-heading: var(--font-display);`.
  - Replace `.bg-page-gradient {…}` with `.bg-page { background: var(--ground); min-height: 100vh; }`.
  - `.glass-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); }`
    (no `backdrop-filter`, no `box-shadow`).
  - Add `.wf-modal { border-radius: 20px; box-shadow: var(--shadow-modal), 0 0 0 1px var(--line); }`.
  - Add the segmented control (spec §7):
    ```css
    .seg { display: flex; gap: 2px; padding: 4px; background: var(--track); border-radius: 12px; }
    .seg-item { height: 34px; padding: 0 16px; display: flex; align-items: center; border-radius: 9px;
      font-size: 14px; font-weight: 500; color: var(--muted); }
    .seg-item:hover { background: rgb(255 253 248 / 0.6); color: var(--ink); }
    .seg-item[aria-current="page"], .seg-item[aria-pressed="true"] { background: var(--surface); color: var(--ink);
      font-weight: 600; box-shadow: 0 1px 2px rgb(36 33 27 / 0.12), 0 0 0 1px rgb(36 33 27 / 0.04); }
    .seg-item--icon { padding: 0; justify-content: center; }
    ```
  - In `@layer base`: add `h1 { font-family: var(--font-display); }`. In the pressability rules replace every
    `rgb(22 39 58 / X)` and `rgb(30 45 60 / X)` with `rgb(36 33 27 / X)` (same alphas); update the comment's
    "`--primary-action` (#16273a)" to the new value. Keep the selectors and the `.text-white` branch exactly.
- [ ] **Step 4: Fonts in `src/app/layout.tsx`.** Replace the imports with
  `import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";` and:
  ```ts
  const sans = Geist({ variable: "--font-sans", subsets: ["latin"] });
  const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });
  const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"], axes: ["opsz"] });
  ```
  `<html … className={`${sans.variable} ${mono.variable} ${display.variable} h-full`}>`; body class
  `bg-page antialiased min-h-full flex flex-col`. Update the `(auth)/layout.tsx` comment's mention of
  `bg-page-gradient` to say the page is now the cream ground (comment only).
- [ ] **Step 5: `src/app/global-error.tsx`:** line 11 `background: '#F3EFE6', color: '#24211B'`, line 21 button
  `background: '#24211B'` (it renders without `globals.css`; literals are right here).
- [ ] **Step 6: Run** `npx vitest run src/lib/design-tokens.test.ts` → PASS; `npx vitest run` → all PASS;
  `npx tsc --noEmit` → clean.
- [ ] **Step 7: Update `e2e/shell.spec.ts`:** test name → `'the shell renders on the ground with the right fonts'`;
  line 9 `expect(bodyFont).toContain('Geist');`; replace lines 11-13 with
  `const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor); expect(bg).toBe('rgb(243, 239, 230)');`;
  add `const h1Font = await page.locator('h1').first().evaluate((el) => getComputedStyle(el).fontFamily); expect(h1Font).toContain('Bricolage Grotesque');`.
- [ ] **Step 8: e2e, one at a time:** `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop`;
  `… e2e/button-affordance.spec.ts --project=desktop`; `… e2e/contrast.spec.ts --project=desktop` (all PASS; the
  header looks wrong until Task 4 — expected).
- [ ] **Step 9: Commit** `git add src/app/globals.css src/app/layout.tsx src/app/global-error.tsx "src/app/(auth)/layout.tsx" src/lib/design-tokens.test.ts e2e/shell.spec.ts`;
  message `Phase B: new palette on the existing tokens, Geist/Bricolage fonts, flat glass-card`.

### Task 2: Sites that relied on the dark ground, and modal backdrops

**Files (spec §8 lists A–E, with lines as of master df042b6 — re-find by the quoted text if they moved):**
- A: `src/components/library/create-adf.tsx:92`, `src/components/admin/issue-invite-button.tsx:50,61`,
  `src/components/admin/run-scan-button.tsx:48`, `src/components/nfc/fob-button.tsx:239`,
  `src/components/devices/display-editor.tsx:589` (and its `:293` fallback literal → `'#B5541A'`)
- B: `src/components/devices/device-list.tsx:208,316`, `src/components/library/cover.tsx:105,111`
- C: `src/components/library/demozoo-badge.tsx:9`, `src/components/games/cover-control.tsx:69`,
  `src/components/games/edit-details.tsx:140`, `src/app/(admin)/layout.tsx:86`
- D: `src/components/collections/collection-rail.tsx:169`, `src/components/library/game-table.tsx:35`,
  `src/components/library/cover.tsx` (shadow literals), `src/components/shell/skeleton.tsx:14`
- E (backdrops → `var(--scrim)`, panel gains `wf-modal`): `ingest/staging-confirm.tsx:43`,
  `library/card-mount-button.tsx:227`, `library/move-to-collection.tsx:79`, `library/delete-disk-dialog.tsx:135`,
  `library/set-drop-dialog.tsx:121`, `nfc/fob-button.tsx:287`, `disks/file-actions.tsx:233`,
  `disks/history-panel.tsx:325`, `devices/delete-device-dialog.tsx:60`, `games/add-disks-dialog.tsx:177`,
  `admin/delete-user-dialog.tsx:117`, `devices/device-list.tsx:258` (all under `src/components/`)

**Interfaces:** none new; consumes `--primary-action`, `--scrim`, `--hairline-strong`, `.wf-modal` from Task 1.

- [ ] **Step 1: List A.** Each `style={{ background: 'var(--on-dark)', color: '#16273a' }}` becomes
  `style={{ background: 'var(--primary-action)' }}` and the element's `className` gains `text-white` (the hover
  rule keys on it). `create-adf.tsx:92` is a style OBJECT (`style: { … }`) passed elsewhere: set
  `background: 'var(--primary-action)', color: '#fff'` there and add `text-white` where that object's element gets
  its className (read the file). `display-editor.tsx:589`: `color: 'var(--on-dark)'` → remove `color`, add
  `text-white`.
- [ ] **Step 2: List B.** `device-list.tsx:208,316` (`update-start` and its twin): `color: '#16273a'` → remove, add
  `text-white` (white on `#A84C16` = 5.66:1). `cover.tsx:105,111`: `color: '#16273a'` → `color: 'var(--ink)'`.
- [ ] **Step 3: List C.** `borderColor: 'rgb(255 255 255 / 0.22)'` → `borderColor: 'var(--hairline-strong)'` in the
  three files; `(admin)/layout.tsx:86` `color: 'rgb(233 240 244 / 0.78)'` → `color: 'var(--muted)'`.
- [ ] **Step 4: List D.** `rgb(30 45 60 / X)` → `rgb(36 33 27 / X)` (same X) in the four files; in `skeleton.tsx`
  both branches of `Bone`'s background become `'rgb(36 33 27 / 0.07)'` (keep the `onDark` prop and its callers;
  update its doc comment: "kept for callers; both shades are equal on the light ground").
- [ ] **Step 5: List E.** Each backdrop `background: 'rgb(… )'` → `background: 'var(--scrim)'`. On the same
  dialog's panel element (the one with `role="dialog"` or the `glass-card` inside the backdrop — read each file)
  add `wf-modal` to its className. Do not change any other class, size or padding.
- [ ] **Step 6: Verify by grep** (spec §8): both commands return only `drive-bezel.tsx`, `category-overview.tsx`,
  `display-editor.tsx:293`'s fallback and comment lines:
  ```bash
  grep -rnE "#16273a|#16232f|#f1f4f5|rgb\(11 18 28|rgb\(233 240 244|rgb\(30 45 60|bg-white/" src --include=*.tsx
  grep -rnE "background: ?'var\(--on-dark\)'|rgb\(255 255 255 / 0\.(1|2)[0-9]?\)" src --include=*.tsx
  ```
  `search-box.tsx`, `top-nav.tsx`, `admin-nav.tsx`, `drive-chips.tsx`, `about-link.tsx`, `settings-link.tsx`,
  `sign-out-button.tsx` and `logo.tsx` are allowed to still match — Task 4 rewrites them. Nothing else may.
- [ ] **Step 7: Run** `npx tsc --noEmit`; `npx vitest run`.
- [ ] **Step 8: e2e regression, one at a time (desktop):** `create-adf.spec.ts`, `admin-invites.spec.ts`,
  `nfc-fob-button.spec.ts`, `delete-disk.spec.ts`, `device-delete.spec.ts`, `devices-firmware.spec.ts`,
  `display-layout.spec.ts`, `admin-delete.spec.ts`. All PASS.
- [ ] **Step 9: Commit** the files of Steps 1-5 by name; message
  `Phase B: fix controls that relied on the dark gradient; modal backdrops use --scrim`.

### Task 3: Building blocks — pills, buttons, cards, segmented view toggle, disk icon

**Files:**
- Modify: `src/components/ui/status-chip.tsx`, `src/components/ui/button.tsx`, `src/components/ui/card.tsx`,
  `src/components/library/view-toggle.tsx`, `src/components/library/title-controls.tsx` (`EmptyLibrary`)
- Create: `src/lib/disk-icon.ts`, `src/lib/disk-icon.test.ts`, `src/components/ui/disk-icon.tsx`

**Interfaces:**
- Produces:
  ```ts
  // src/lib/disk-icon.ts
  export type DiskColor = 'black' | 'blue' | 'grey' | 'red' | 'green' | 'cream';
  export const DISK_BODIES: Record<DiskColor, { body: string; back: string }>;
  // black #232326/#3A3A3F, blue #2F5D9A/#1F416E, grey #8A8D93/#6B6E74, red #B23A2E/#7E2920,
  // green #2F6B4F/#204B37, cream #E2D9C6/#C4B9A2
  export function diskIconMetrics(size: number): {
    w: number; h: number; showText: boolean; pad: number; gap: number; stripe: number;
    setSize: number; titleSize: number; badgeSize: number; shadowY: number; shadowBlur: number;
  };
  // src/components/ui/disk-icon.tsx
  export function DiskIcon(props: { color?: DiskColor; size?: number; hd?: boolean; wp?: boolean; stack?: number;
    mounted?: boolean; set?: string; title?: string; className?: string }): JSX.Element;
  ```

- [ ] **Step 1: Failing unit test** `src/lib/disk-icon.test.ts`. The formulas are the board's
  (`ModernDisk.dc.html`): `h = round(w*108/106)`, `showText = w >= 72`, `pad = max(3, round(w*0.05))`,
  `gap = max(2, round(w*0.025))`, `stripe = max(2, round(w*0.018))`, `setSize = max(7, round(w*0.56)/10)`,
  `titleSize = max(9, round(w*1.05)/10)`, `badgeSize = max(9, round(w*0.07))`, `shadowY = max(1, round(w*0.05))`,
  `shadowBlur = max(2, round(w*0.08))`. Assert exactly:
  - 160 → `{ w:160, h:163, showText:true, pad:8, gap:4, stripe:3, setSize:9, titleSize:16.8, badgeSize:11, shadowY:8, shadowBlur:13 }`
  - 96 → `{ w:96, h:98, showText:true, pad:5, gap:2, stripe:2, setSize:7, titleSize:10.1, badgeSize:9, shadowY:5, shadowBlur:8 }`
  - 24 → `{ w:24, h:24, showText:false, pad:3, gap:2, stripe:2, setSize:7, titleSize:9, badgeSize:9, shadowY:1, shadowBlur:2 }`
  - 72 → `showText` true; 71 → false
  - `DISK_BODIES.cream` = `{ body: '#E2D9C6', back: '#C4B9A2' }` and all six keys present.
- [ ] **Step 2: Run, expect FAIL:** `npx vitest run src/lib/disk-icon.test.ts`.
- [ ] **Step 3: Implement `src/lib/disk-icon.ts`**, run the test → PASS.
- [ ] **Step 4: `src/components/ui/disk-icon.tsx`.** Port the markup of
  `/private/tmp/claude-501/-Users-sfs-Devel-webadf/675c185f-947c-4752-b904-7630c037fa06/scratchpad/design-approved/ModernDisk.dc.html`
  (the `<div class="wf-disk">` subtree) to JSX: copy every `<path d="…">` VERBATIM; `{{x}}` placeholders come from
  `diskIconMetrics(size)` and `DISK_BODIES[color]`; `backOpacity = stack > 1 ? 1 : 0`; `hdOpacity = hd ? 1 : 0`,
  `hdText = hd ? 0.85 : 0`; `wpFill = wp ? '#0E0E10' : back`. Gradient ids `wfSheen`/`wfMetal` get a per-instance
  suffix from `useId()` (strip `:` from it) — so it is a client component (`'use client'`). Fonts:
  `var(--font-mono)` for the set line, `var(--font-display)` for the title, `var(--font-sans)` for the HD text.
  The root `div` is `aria-hidden` (decorative; the caller labels). The `mounted` badge text is `DF0` as drawn.
- [ ] **Step 5: Use it once.** In `EmptyLibrary` (`title-controls.tsx:29`) add
  `<DiskIcon color="cream" set="Empty" title="New box" size={96} />` as the first child of the card (keep the
  `glass-card` div, its `data-testid={testId}`, both `<p>`s, their texts and the Link exactly).
- [ ] **Step 6: Pill.** `status-chip.tsx`: class → `inline-flex w-fit max-w-full items-center rounded-full px-[9px] py-0.5 text-[12px] font-semibold leading-tight`;
  `neutral: { background: 'var(--track)', color: 'var(--muted)' }`;
  `blue: { background: 'color-mix(in srgb, var(--accent-blue) 12%, var(--surface))', color: 'var(--accent-blue)' }`.
  Update the comments' token names. Kinds/props unchanged.
- [ ] **Step 7: shadcn Button** (`ui/button.tsx`) variants: `default: "bg-primary text-primary-foreground hover:bg-primary/90"`
  (tokens now ink/#FFFDF8), base class `rounded-lg` → `rounded-[10px]`; `outline: "border-line bg-surface text-foreground hover:bg-surface-2 aria-expanded:bg-surface-2"`;
  `ghost: "text-(--muted) hover:bg-track hover:text-foreground aria-expanded:bg-track"`;
  `destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"`.
  Leave sizes and `secondary`/`link`. **shadcn Card** (`ui/card.tsx`): `rounded-xl … ring-1 ring-foreground/10` →
  `rounded-2xl … ring-1 ring-line` (only those classes).
- [ ] **Step 8: View toggle** (`view-toggle.tsx`): wrapper `<div className="seg" role="group" aria-label="View">`
  (drop `overflow-hidden rounded-lg border` and its inline style); each Link gets
  `className={`seg-item seg-item--icon ${base}`}` where `base` keeps `h-10 w-11 text-[11px] sm:h-8 sm:w-9` (drop
  `grid place-items-center font-semibold`, the class supplies centring); delete the `on`/`off` style objects —
  `aria-pressed` drives the look.
- [ ] **Step 9: Run** `npx vitest run`; `npx tsc --noEmit`.
- [ ] **Step 10: e2e, one at a time (desktop):** `view-toggle.spec.ts`, `library.spec.ts`, `upload-staging.spec.ts`,
  `send-to-amiga.spec.ts`, `states.spec.ts`, `account.spec.ts`. PASS.
- [ ] **Step 11: Commit** the Task 3 files by name; message
  `Phase B: building blocks — pill, button, card, segmented view toggle, DiskIcon`.

### Task 4: The header (both shells)

**Files:**
- Modify: `src/components/shell/logo.tsx`, `src/app/icon.svg`, `src/app/apple-icon.png` (regenerated);
  delete `src/app/favicon.ico`
- Modify: `src/app/(app)/layout.tsx`, `src/app/(admin)/layout.tsx`
- Modify: `src/components/shell/top-nav.tsx`, `src/components/admin/admin-nav.tsx`,
  `src/components/shell/drive-chips.tsx`, `src/components/shell/search-box.tsx`,
  `src/components/shell/about-link.tsx`, `src/components/shell/settings-link.tsx`,
  `src/components/sign-out-button.tsx`, `src/components/shell/header-start.tsx`, `src/lib/drive-chips.ts` (comment only)
- Modify: `e2e/drive-chips.spec.ts` (one new test), `e2e/shell.spec.ts`

**Interfaces:**
- `SettingsLink` becomes `'use client'` (uses `usePathname`); same export, no props.
- `HeaderStart({ pillEstimate, children })` unchanged; renders `data-pill-estimate={pillEstimate}` on its div.

- [ ] **Step 1: Failing e2e for the estimate.** In `e2e/drive-chips.spec.ts` add:
  ```ts
  test('the first-paint pill estimate matches the real pill at 1280', async ({ page }) => {
    await signUpFresh(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/library');
    const est = Number(await page.getByTestId('header-start').getAttribute('data-pill-estimate'));
    const real = await page.locator('header nav').evaluate((n) => n.getBoundingClientRect().width);
    expect(Math.abs(real - est), `estimate ${est}, measured ${real}`).toBeLessThanOrEqual(2);
  });
  ```
  (Use the file's existing imports, adding `signUpFresh` from `./helpers` if absent; `signUpFresh` is a non-admin user, so the 312-side estimate is checked.)
- [ ] **Step 2: Logo.** Rewrite `logo.tsx` to the board's mark (from `ModernHeader.dc.html`), viewBox `0 0 106 108`:
  ```tsx
  <g transform="translate(0 6)">
    <path d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" fill="#24211B" />
    <rect x="25" y="0" width="52" height="35" rx="2" fill="#D6D9DD" />
    {detailed && <rect x="58" y="5" width="10" height="25" rx="1.5" fill="#24211B" />}
    <path d="M12 48 H88 V102 H12 Z" fill="#FBF8F1" />
    <rect x="20" y="58" width="15" height="6" rx="1" fill="#D9453A" />
    <rect x="37" y="58" width="15" height="6" rx="1" fill="#EE8A2A" />
    <rect x="54" y="58" width="15" height="6" rx="1" fill="#4F9D4A" />
    <rect x="71" y="58" width="10" height="6" rx="1" fill="#2F6FB5" />
  </g>
  ```
  `detailed = size >= 40` as today; keep props, `aria-hidden`, `focusable="false"`. Rewrite the doc comment
  (WebFloppy mark, light ground, no keyline). `src/app/icon.svg`: the same drawing without the slot, `width="64"
  height="64"`, comment updated. Regenerate the apple icon:
  `node -e "require('sharp')(require('fs').readFileSync('src/app/icon.svg')).resize(180,180).flatten({background:'#F3EFE6'}).png().toFile('src/app/apple-icon.png')"`
  (sharp is installed with Next; if `require('sharp')` fails, resolve it from `node_modules/.pnpm/sharp@*/node_modules/sharp`).
  `git rm src/app/favicon.ico`.
- [ ] **Step 3: App shell** (`(app)/layout.tsx`): `<header data-testid="app-header" className="relative flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:h-[72px] sm:flex-nowrap sm:gap-4 sm:px-7 sm:py-0" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>`.
  Nav wrapper: `sm:top-4` → `sm:top-[19px]` (nothing else in that class string). Wordmark Link: `className="flex items-center gap-2.5 text-[18px] font-bold tracking-[-0.02em]"`, `style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}`,
  `<Logo size={24} />`, text stays `webadf` until Task 5. Right group: keep its children, order and
  wrappers; change only `gap-4` → `gap-2` (the search box's own `sm:mr-2`, Step 6, keeps it 16px from the icons). Rewrite the
  scrim comments (the bar is a light surface now). Admin shell (`(admin)/layout.tsx`): same header classes/style
  with `data-testid="admin-header"`, same `sm:top-[19px]`, wordmark span as the app's (Logo 24, 18px, display
  font, ink), the `admin` suffix `color: 'var(--muted)'`, `admin-email` and "Back to library" `color: 'var(--muted)'`
  (add `hover:text-(--ink)` to the link).
- [ ] **Step 4: Navs.** `top-nav.tsx`: `<nav aria-label="Main" className="seg w-max sm:w-auto">`; each Link
  `className="seg-item whitespace-nowrap"` with no `style`; remove the inline background/border. `admin-nav.tsx`:
  the same with `aria-label="Admin"`. Update both comments (drop the translucent-white and `#16273a` notes).
- [ ] **Step 5: Drive chips** (`drive-chips.tsx`), per spec §6.2: `CHIP_CLASS` →
  `'h-9 max-w-full items-center gap-1 rounded-[10px] border px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]'`;
  `CHIP_STYLE` → `{ background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--ink)' }`;
  `StatusDot` online `{ background: 'var(--online-dot)', boxShadow: '0 0 0 3px rgb(63 191 85 / 0.18)' }`, offline
  `{ border: '1.5px solid var(--muted)' }`; disk span `className="max-w-[3.5rem] truncate font-mono"` `style={{ color: 'var(--muted)' }}`;
  WP/RW tag `className="shrink-0 rounded-[5px] px-1 font-mono text-[9.5px] font-semibold leading-[14px]"`
  `style={{ background: 'var(--track)', color: 'var(--muted)' }}`; `MenuPopup` `className="w-64 max-w-[calc(100vw-2rem)] rounded-2xl"`,
  `style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-card)' }}`
  (drop `backdrop-blur-xl`); separators `background: 'var(--line)'`. Do not touch widths, caps, gaps, ids or
  breakpoint classes. Update the CHIP_STYLE comment.
- [ ] **Step 6: Search box** (`search-box.tsx`): root `relative w-full sm:mr-2 sm:w-auto`; input class
  `h-10 w-full rounded-[10px] border pl-9 pr-4 text-[14px] outline-none transition-colors placeholder:text-(--muted-2) sm:w-48 sm:pr-9`,
  style `{ background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--ink)' }`; before the input add
  `<SearchIcon aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" style={{ color: 'var(--muted-2)' }} />`
  (lucide-react); `kbd` style `{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }`,
  class `rounded-md` instead of `rounded`; panel style → `background: 'var(--surface)'`, `borderColor: 'var(--line)'`,
  `boxShadow: 'var(--shadow-card)'`, class `rounded-2xl` instead of `rounded-xl`, `top-[46px]` instead of
  `top-[42px]` (the input is 6px taller); the three highlighted-row styles `{ background: 'var(--surface-2)' }`.
  Rewrite the `#f1f4f5` comment block in 3 lines: the panel is the opaque surface; muted on the highlighted row is
  6.71:1.
- [ ] **Step 7: About, gear, Sign out.** `about-link.tsx`: add `data-testid="about-link"`, class
  `inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-(--muted) hover:bg-(--track) hover:text-(--ink)`.
  `settings-link.tsx`: `'use client'`, `const active = usePathname().startsWith('/settings');`, add
  `aria-current={active ? 'page' : undefined}`, class `inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border text-(--ink) hover:bg-(--track)`,
  style `active ? { background: 'var(--surface)', borderColor: 'var(--ink)' } : { borderColor: 'transparent' }`.
  `sign-out-button.tsx`: `data-testid="sign-out"`, class `h-9 rounded-[10px] px-3.5 text-[14px] font-medium text-(--muted) hover:bg-(--track) hover:text-(--ink)`;
  replace its long comment with one line (the ghost variant's colours are set here for the header).
- [ ] **Step 8: HeaderStart.** Add `data-pill-estimate={pillEstimate}` to the div. Run the Step 1 test:
  `PORT=3100 npx playwright test e2e/drive-chips.spec.ts --project=desktop -g "first-paint pill estimate"`. It fails
  and prints the measured width: put that number (rounded to an integer) in place of `312` in `(app)/layout.tsx`.
  For the Admin number, measure once the same way with a super-admin (temporarily duplicate the test using
  `signInAsSuperAdmin` from `e2e/admin-helpers.ts` after `signUpFresh`, as `contrast.spec.ts` does, read the printed width, then delete the duplicate) and replace `386`.
  Update the measured numbers and date (2026-10-24) in `header-start.tsx`'s comment and in `chipSlots`' comment in
  `src/lib/drive-chips.ts` (comment only; thresholds unchanged). Re-run → PASS.
- [ ] **Step 9: shell.spec additions:** `await expect(page.getByTestId('app-header')).toHaveCSS('background-color', 'rgb(255, 253, 248)');`
  and `await expect(page.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current', 'page');`
  then `await page.getByTestId('settings-link').click(); await expect(page.getByTestId('settings-link')).toHaveAttribute('aria-current', 'page');`.
- [ ] **Step 10: Run** `npx tsc --noEmit`; `npx vitest run`.
- [ ] **Step 11: e2e, one at a time:** `drive-chips.spec.ts --project=desktop` (whole file, unchanged tests must
  pass; if "centred between the wordmark and the pill" fails on the ≥16px gaps, drop the wordmark to `text-[17px]`
  and re-measure Step 8 — never touch `chipSlots` or the chips' caps); `shell.spec.ts --project=desktop`;
  `mobile.spec.ts --project=mobile -g "bottom bar"`; `search.spec.ts --project=desktop`; `states.spec.ts`;
  `user-settings.spec.ts`; `admin-guard.spec.ts`; `contrast.spec.ts --project=desktop -g "search panel"`;
  `help.mobile.spec.ts --project=mobile`.
- [ ] **Step 12: Commit** the Task 4 files by name (include the `git rm`'d favicon and the regenerated png);
  message `Phase B: the new header — surface bar, mark, segmented nav, chips, search, gear`.

### Task 5: The rename to WebFloppy

**Files:**
- Modify: `src/app/layout.tsx:19`, `src/app/(app)/layout.tsx:76`, `src/app/(admin)/layout.tsx:38`,
  `src/app/(app)/about/page.tsx:97`, `src/app/(app)/help/page.tsx:13`, `src/lib/help/topics.tsx:466`
- Modify: `e2e/shell.spec.ts`, `e2e/help.spec.ts` (only if it asserts the subtitle), `e2e/about-page.spec.ts` (add one assert)

- [ ] **Step 1: e2e first.** `shell.spec.ts`: `await expect(page.getByTestId('wordmark-home')).toHaveText('webfloppy');`
  and `await expect(page).toHaveTitle('WebFloppy');` (on `/library`, which sets no title of its own). Add in the
  same test `await page.goto('/help'); await expect(page).toHaveTitle('Help · WebFloppy');`.
  `about-page.spec.ts`: `await expect(page.getByTestId('about-about-webadf')).toContainText('WebFloppy');` (sections
  are `data-testid={`about-${id}`}`, as line 14-15 use).
- [ ] **Step 2: Run** `PORT=3100 npx playwright test e2e/shell.spec.ts --project=desktop` → FAIL on the title/wordmark.
- [ ] **Step 3: The six strings** (spec §9): metadata
  `title: { default: 'WebFloppy', template: '%s · WebFloppy' }` (description unchanged); wordmarks `webfloppy` and
  `webfloppy <span …>admin</span>`; About section `title="WebFloppy"` (keep `id="about-webadf"`); Help subtitle
  `"What the less obvious parts of WebFloppy do, and why."`; topics `"…The driver disk carries WebFloppy’s LZ4 build of his driver."`
  (keep the typographic apostrophe). Update the `Logo`/`icon.svg` comments that say "webadf mark" if Task 4 left any.
- [ ] **Step 4: Check nothing else changed:** `grep -rn "webadf" src --include=*.tsx | grep -vE "^\S+:\s*[0-9]+:\s*(//|\*|\{/\*)"`
  must list only `title-controls.tsx:34` (`webadf push`), `about/page.tsx` (`about-webadf` id, repo URL) and
  non-visible identifiers.
- [ ] **Step 5: Run** `npx tsc --noEmit`; `npx vitest run` (help topics have unit tests — `src/lib/help/*.test.ts` — they must pass).
- [ ] **Step 6: e2e, one at a time (desktop):** `shell.spec.ts`, `about-page.spec.ts`, `help.spec.ts`. PASS.
- [ ] **Step 7: Commit** by name; message `Phase B: rename to WebFloppy (title, wordmarks, About, Help)`.

### Task 6: Contrast on the new ground, regression sweep, screenshots

**Files:**
- Modify: `e2e/contrast.spec.ts`
- No product code unless a run finds a defect (then fix it in the file the failure names, inside this task, and
  say so in the commit message).

- [ ] **Step 1: contrast.spec.ts.** Rename the per-path test to `` `${path} text is legible on the ground` ``;
  rewrite the file-top bullet and the search-panel test's comment for the new surfaces (surface `#FFFDF8`,
  highlighted row `#F6F2E9`, `--muted` 6.71:1) — logic unchanged. Add:
  ```ts
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
  ```
  (If the empty library renders `game-table` for a fresh user, use that id — check `library/page.tsx`'s default view.)
- [ ] **Step 2: Run** `PORT=3100 npx playwright test e2e/contrast.spec.ts --project=desktop` → PASS.
- [ ] **Step 3: The roadmap's specs, one at a time** (split with `-g` if one nears 9 minutes):
  `button-affordance.spec.ts`, `shell.spec.ts`, `collections.spec.ts`, `devices-page.spec.ts`,
  `send-to-amiga.spec.ts`, `library-mount.spec.ts` (`--project=desktop`), `mobile.spec.ts --project=mobile`; then
  `disk-sets.spec.ts`, `drive-chips.spec.ts`, `library-table.spec.ts`, `time-machine.spec.ts`. All PASS with no
  spec edits beyond Tasks 1, 4, 5 and Step 1.
- [ ] **Step 4: Final greps** (spec §8 Step 6 commands of Task 2) — now with NO exceptions except `drive-bezel.tsx`,
  `category-overview.tsx`, `display-editor.tsx:293` and comments.
- [ ] **Step 5: Screenshots:** `PORT=3100 npx playwright test -c playwright.screenshots.config.ts` (refreshes
  `docs/screenshots/`; one test, under 6 minutes). Look at each PNG and at `test-results/shell.png`,
  `test-results/zz-*.png`: no light text on cream, no invisible button, no grey-blue left from the old palette.
  List anything odd in the report rather than fixing outside the spec.
- [ ] **Step 6: Commit** `e2e/contrast.spec.ts` and `docs/screenshots/*.png` by name; message
  `Phase B: contrast checks on the new ground; README screenshots`.
- [ ] **Step 7: Report** to the controller: commits, every spec run and its result, the measured pill widths, the
  wordmark size used, and any deviation from this plan.
