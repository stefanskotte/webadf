# WebFloppy redesign, Phase B: design foundation

Status: draft, 2026-10-24, for the operator's review. Scope is the roadmap's Phase B section
(`docs/superpowers/specs/2026-10-23-webfloppy-redesign-roadmap-design.md`). The approved designs are the Modern
boards of the canvas (local copies: `ModernHeader`, `ModernHeaderMenu`, `ModernLibrary`, `ModernDisk`,
`ModernDevicesV2`, `InfSettings`, `InfAdmin*`, `InfPhone`). Measured against master `df042b6`.

## 1. Goal

The whole app wears the new look (the cream ground, flat surfaces with hairlines, ink buttons, the rust accent,
Bricolage Grotesque, Geist and Geist Mono), keeps every page layout it has today, and is called **WebFloppy**. The
change lives mostly in one CSS file (`src/app/globals.css`) and the shell (`src/app/(app)/layout.tsx`,
`src/app/(admin)/layout.tsx`, `src/components/shell/*`). Every `data-testid` stays.

## 2. What is there today (measured)

- **The ground is dark at the top.** `body` carries `.bg-page-gradient` (`#1b2534` → `#eef1f2`, fixed). The header,
  the page titles (`PageHeader`), breadcrumbs and a few page-level controls sit on its dark band and use
  `--on-dark` / `--on-dark-muted` (light text). Content sits on `.glass-card` (62% white, blur 12px, white border,
  a two-layer shadow).
- **Token uses:** 888 `var(--…)` reads in 101 `.tsx`/`.ts` files (663 `style={{` objects). Most used: `--muted` 243,
  `--ink` 162, `--hairline` 59, `--primary-action` 58, `--amber-text` 55, `--hairline-strong` 52, `--glass-strong`
  39, `--danger-fg` 35, `--muted-2` 31, `--input-bg` 24, `--on-dark` 23, `--on-dark-muted` 22, `--faint` 15. `.glass-card`:
  76 uses in 48 files. No `var(--grad-*)` reader outside `globals.css`.
- **Two `--foreground` and two `--muted`.** shadcn's `:root` block defines them in oklch; the later webadf block
  redefines `--foreground` (#223140) and `--muted` (#4c5966, a TEXT grey). The later one wins, so Tailwind's
  `bg-muted` is a dark grey today (2 uses). This spec keeps webadf's meaning of `--muted`.
- **shadcn `--accent` is a menu highlight** (`bg-accent`/`text-accent` 17 uses, mostly `ui/dropdown-menu.tsx`).
  A new token called `--accent` would turn every focused menu item orange.
- **No dark mode.** No `ThemeProvider`, no `.dark` on `<html>` (`ui/sonner.tsx` says so), zero `dark:` utilities in
  app code. The `.dark` block in `globals.css` is unused shadcn scaffolding. The designs have no dark variant.
- **Fonts:** `src/app/layout.tsx` loads Space Grotesk (`--font-sans`) and IBM Plex Mono (`--font-mono`) through
  `next/font/google`; `@theme inline` maps `--font-sans`, `--font-mono` and `--font-heading` (= sans).
- **Buttons** are mostly inline: `background: var(--primary-action)` plus `text-white` (the hover rule in
  `globals.css` keys on `.text-white`). Only 3 files use shadcn `Button`. There is no shared Dialog: 12 dialogs each
  draw their own backdrop (10 × `rgb(11 18 28 / 0.55)`, 2 × black) and a `.glass-card` panel.

## 3. Decisions

1. **Map the new palette onto the existing token names.** Change values in `globals.css`; do not rename the 888
   reads. Add only the tokens that are missing (§4.3).
   Ruling: remap in place. Cost if wrong: token names stop describing their values (`--on-dark` becomes ink,
   `--glass` becomes an opaque surface). That is a naming debt, handled by a comment block in `globals.css` and paid
   off area by area in Phase C, not a behaviour risk.
2. **`--on-dark` becomes "text on the page ground" (ink), `--on-dark-muted` becomes muted.** Its 45 readers are
   text on the ground (page titles, breadcrumbs, the pairing code), so they come out right. The 8 sites that use
   `--on-dark` as a pale button FILL under navy text become ink-on-ink and are fixed by hand (§8, list A).
   Ruling: remap and fix the 8. Cost if wrong: a missed site renders an invisible button; the grep in §8 and the
   contrast spec catch it.
3. **The design's accent lives in the existing amber pair.** `--accent-amber` (fill) becomes `#B5541A`;
   `--amber-text` (text) becomes `#A84C16`, a darker step of the same hue, because `#B5541A` is 4.31:1 on the ground
   and 4.42:1 on `--surface-2` (under AA; it passes only on the surface, 4.86:1). No token named `--accent` is added
   (it is shadcn's menu highlight).
   Ruling: as above. Cost if wrong: accent text reads a shade darker than the board draws it.
4. **The design's light grey `#7A7262` fails AA on three of the app's four grounds** (4.15 on ground, 4.26 on
   surface-2, 3.94 on the nav track; 4.68 on surface only), and `--muted-2`/`--faint` carry 10–11 px text. They become
   `#6E6657` (the same hue, darkened until it clears 4.5:1 on the track: 4.69). `--muted` is the design's `#5B5446`.
   Ruling: deviate from the board by one step. Cost if wrong: captions read a little darker than drawn; the
   alternative is shipping AA failures the contrast work of 2026-09 removed.
5. **`.glass-card` becomes a flat surface with a hairline.** Verified against the boards: title cards and the table
   wrapper are `background:#FFFDF8; border-radius:16px; box-shadow:0 0 0 1px #E4DCCB` (ModernLibrary); settings
   sections the same at 20px (InfSettings); no blur, no drop shadow at rest. The class keeps its 1px BORDER (in
   `--line`) rather than the design's ring shadow, so every card keeps its exact box (collections and disk-sets
   specs compare bounding boxes). `backdrop-filter` goes, which also removes the containing-block trap the dialogs
   portal around (comments in `delete-disk-dialog.tsx:125`, `file-actions.tsx:224`); the portals stay.
   Ruling: flat, border, 16px. Cost if wrong: none to geometry; a look change only.
6. **No dark mode.** The app has none and the boards draw none. Add `color-scheme: light` on `:root` so native
   controls (scrollbars, `<select>`, date inputs) do not go dark on a dark-mode OS against the cream ground. Leave the
   unused `.dark` block alone.
   Ruling: light only. Cost if wrong: a dark theme later needs a second value set; the token map is where it goes.
7. **The header gets the new look; its geometry stays.** Today's header centres the nav on the viewport
   (absolute), measures the nav's width (`HeaderStart`), and fits 1/2/3 drive chips at 1280/1536/1920
   (`chipSlots`, measured). The board instead runs logo → drive chip → nav → spacer → search → gear → Sign out in
   flow. Phase B keeps the centred nav, the chip budget and the mobile bottom bar, and restyles every piece to the
   board: a 72 px surface bar with a hairline, the segmented nav, chip, search box, gear and Sign out.
   Ruling: restyle, do not re-lay. Cost if wrong: a later follow-up moves the nav into flow, which reworks
   `HeaderStart`, `chipSlots` and four `drive-chips.spec.ts` tests; nothing in Phase B blocks it.
8. **Drive chips stay chips.** The board shows one "Controlling" chip and a dialog; the app has a chip per board
   with a menu each (Go to disk / write protection / Next / Eject, 30+ test ids). A "current drive" is a concept the
   app does not have. Phase B gives the chips and menus the board's look (surface-2 chip, 10 px radius, LED with a
   halo, mono disk text, `WP` tag; the menu as a 16 px surface panel), keeps their text sizes and truncation caps so
   the measured budget holds, and keeps every id.
   Ruling: restyle. Cost if wrong: the single-drive menu becomes its own feature.
9. **Help and About stay in the header.** The board drops Help from the nav and puts About on the Settings page;
   both moves belong to Phase C step 5 (Help + "?" popover, Settings). Removing them now would remove a way in before
   its replacement exists.
   Ruling: keep both. Cost if wrong: the header is one nav item and one icon wider than drawn.
10. **Wordmark lowercase, prose capitalised.** The board's logotype is lowercase `webfloppy` (header, sign-in);
    the roadmap names the product **WebFloppy**. The wordmark (a drawing) is `webfloppy`; titles, metadata and
    sentences say `WebFloppy`.
    Ruling: as above. Open question for the operator (§12). Cost if wrong: two strings.
11. **Wordmark size is set by the chip budget, not the board.** The board's 30 px mark + 22 px Bricolage wordmark is
    about 145 px wide against today's ~92 px. At 1280 that leaves 8–10 px either side of the chip group, and
    `drive-chips.spec.ts` requires 16. Phase B uses a 24 px mark and an 18 px wordmark (~120 px), measured in Task 4.
    Ruling: 24/18, with the spec as the arbiter (fallback 17 px). Cost if wrong: a smaller brand than drawn until the
    header geometry is redone.
12. **Buttons keep their shapes.** The ~60 inline buttons take the new colours through the tokens (ink primary,
    surface secondary, rust/red where they are today) but keep today's radius and padding (many are `rounded-full`;
    the board's are 10 px). Reshaping each is a layout edit per area and goes with that area in Phase C. shadcn
    `Button` (3 files) gets the board's variants now.
    Ruling: colour now, shape in Phase C. Cost if wrong: pill-shaped buttons beside rectangular cards for one phase.
13. **The hover rule stays and is re-tinted.** `globals.css`'s pressability rule (inset wash on hover/active,
    pointer/not-allowed) keeps its mechanism; its colour goes from navy `rgb(22 39 58 / …)` to ink
    `rgb(36 33 27 / …)`. `button-affordance.spec.ts` asserts the shadow CHANGES, not its value, so it passes
    unchanged.
14. **Icons.** `src/app/icon.svg` is redrawn with the new mark; `apple-icon.png` is regenerated from it (sharp, already
    installed through Next); `favicon.ico` is deleted so browsers use `icon.svg`.
    Ruling: as above. Cost if wrong: legacy browsers that ignore SVG icons show no favicon (never the old brand).

## 4. Token map

### 4.1 webadf tokens (`globals.css`, the "webadf design tokens" `:root` block)

| Token | Today | Becomes | Note |
|---|---|---|---|
| `--ink` | `#16232f` | `#24211B` | ink |
| `--foreground` | `#223140` | `#24211B` | body text |
| `--muted` | `#4c5966` | `#5B5446` | muted |
| `--muted-2` | `#5f6874` | `#6E6657` | design `#7A7262`, darkened (§3.4) |
| `--faint` | `#666d75` | `#6E6657` | same as `--muted-2`; size carries the rest |
| `--on-dark` | `#eef3f6` | `#24211B` | now "text on the ground" (§3.2) |
| `--on-dark-muted` | `rgb(233 240 244 / .78)` | `#5B5446` | |
| `--glass` | `rgb(255 255 255 / .62)` | `#FFFDF8` | surface |
| `--glass-panel` | `… / .68` | `#FFFDF8` | surface |
| `--glass-strong` | `… / .80` | `#FFFDF8` | surface (menus, panels) |
| `--glass-subtle` | `… / .45` | `#F6F2E9` | surface-2 |
| `--glass-border` | `… / .65` | `#E4DCCB` | line |
| `--input-bg` | `… / .75` | `#FFFDF8` | inputs sit on cards; the line border marks them |
| `--hairline` | `rgb(30 45 60 / .08)` | `#F0EADF` | the board's row divider |
| `--hairline-strong` | `rgb(30 45 60 / .14)` | `#E4DCCB` | line |
| `--shadow-card` | two-layer card shadow | `0 24px 48px -12px rgb(36 33 27 / .28), 0 4px 12px rgb(36 33 27 / .08)` | now the POPOVER shadow (its 3 readers are popovers); cards no longer use it |
| `--nav-scrim` | `rgb(27 37 52 / .90)` | `rgb(255 253 248 / .96)` | mobile bottom bar = surface (InfPhone) |
| `--nav-scrim-hairline` | `rgb(255 255 255 / .14)` | `#E4DCCB` | |
| `--primary-action` | `#16273a` | `#24211B` | ink buttons, `#FFFDF8`/white text |
| `--accent-blue` | `#1a35d6` | `#1D4F86` | the board's blue text |
| `--accent-amber` | `#f5822e` | `#B5541A` | the accent, FILL/outline (§3.3) |
| `--amber-text` | `#a8560f` | `#A84C16` | accent TEXT (§3.3) |
| `--success-bg` / `-fg` | `#dff2e2` / `#1c7a3e` | `#DDF0DC` / `#1F6A2A` | |
| `--warning-bg` / `-fg` | `#fdf1cf` / `#8a6207` | `#FBEBD3` / `#7A4A08` | |
| `--danger-bg` / `-fg` | `#fbe1e1` / `#c0342e` | `#F8E1DB` / `#B3341F` | `#B3341F` is the board's danger text and fill |
| `--online-dot` | `#5fd18b` | `#3FBF55` | |
| `--grad-top` … `--grad-bot` | gradient stops | removed | no readers; `.bg-page-gradient` goes (§4.4) |
| `--radius-card` (`@theme`) | `14px` | `16px` | |

### 4.2 shadcn tokens (the first `:root` block)

`--background` `#F3EFE6`; `--card`, `--popover` `#FFFDF8`; `--card-foreground`, `--popover-foreground`,
`--secondary-foreground`, `--accent-foreground` `#24211B`; `--primary` `#24211B`; `--primary-foreground` `#FFFDF8`;
`--secondary` `#EFE9DD`; `--accent` `#F6F2E9` (menu highlight, the board's `.m-item:hover`); `--muted-foreground`
`#5B5446`; `--destructive` `#B3341F`; `--border`, `--input` `#E4DCCB`; `--ring` `#7A7262` (a focus ring, non-text,
4.68:1 on surface). `--muted` and `--foreground` are overridden by §4.1 as today. Sidebar and chart tokens: unused,
left alone.

### 4.3 New tokens

| Token | Value | Use |
|---|---|---|
| `--ground` | `#F3EFE6` | page background |
| `--surface` | `#FFFDF8` | cards, header, menus, modals |
| `--surface-2` | `#F6F2E9` | chip, search box, hover rows, highlighted search result |
| `--track` | `#EFE9DD` | segmented-control track, neutral pill |
| `--line` | `#E4DCCB` | borders |
| `--line-strong` | `#D3C8B2` | dashed empty states, hover ring |
| `--scrim` | `rgb(36 33 27 / 0.45)` | modal backdrop (replaces 12 literals) |
| `--shadow-modal` | `0 40px 80px -20px rgb(36 33 27 / 0.5)` | modal panel |
| `--font-display` | set by `next/font` | Bricolage Grotesque |

`@theme inline` adds `--color-ground`, `--color-surface`, `--color-surface-2`, `--color-track`, `--color-line`, and
sets `--font-heading: var(--font-display)`.

### 4.4 Utilities

- `.bg-page-gradient` is replaced by `.bg-page { background: var(--ground); min-height: 100vh; }`
  (`src/app/layout.tsx:26` changes its class).
- `.glass-card`: `background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card);`
  no `backdrop-filter`, no `box-shadow`.
- `.wf-modal` (new, added beside `glass-card` on the 12 dialog panels): `border-radius: 20px; box-shadow:
  var(--shadow-modal), 0 0 0 1px var(--line);`.
- `.seg` / `.seg-item` (new): the segmented control (§7).
- The pressability rule's `rgb(22 39 58 / x)` and `rgb(30 45 60 / x)` become `rgb(36 33 27 / x)` (same alphas).
- `@layer base`: `h1 { font-family: var(--font-display); }`; `:root { color-scheme: light; }`.

### 4.5 Contrast pairs (WCAG 2.x, computed 2026-10-24; AA = 4.5:1 for text)

| Pair | Ratio | |
|---|---|---|
| ink `#24211B` on ground `#F3EFE6` | 13.99 | pass |
| ink on surface `#FFFDF8` | 15.79 | pass |
| ink on track `#EFE9DD` | 13.28 | pass |
| muted `#5B5446` on surface | 7.37 | pass |
| muted on ground / surface-2 / track | 6.53 / 6.71 / 6.20 | pass |
| muted-2 `#6E6657` on surface / ground / track | 5.58 / 4.94 / 4.69 | pass |
| (design `#7A7262` on surface / ground / surface-2 / track) | 4.68 / 4.15 / 4.26 / 3.94 | fails off the surface: not used for text |
| accent `#B5541A` on surface | 4.86 | pass (links on cards) |
| accent `#B5541A` on ground / surface-2 | 4.31 / 4.42 | FAIL: text uses `--amber-text` |
| amber-text `#A84C16` on track / ground / surface-2 | 4.68 / 4.93 / 5.07 | pass |
| white on accent `#B5541A` | 4.94 | pass (`#FFFDF8` on it: 4.86) |
| ink on accent | 3.25 | FAIL: never ink text on an accent fill |
| white on ink | 16.05 | pass |
| danger `#B3341F` on surface / on danger-bg | 6.03 / 4.90 | pass |
| white on danger | 6.13 | pass |
| success `#1F6A2A` on `#DDF0DC`; warning `#7A4A08` on `#FBEBD3` | 5.57; 6.38 | pass |
| `#A39B8B` (board's disabled grey) on surface | 2.71 | not adopted |

These are pinned by a unit test that reads the values out of `globals.css` (Task 1).

## 5. Fonts

Read `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` and
`.../03-api-reference/02-components/font.md` (Next 16.3.2). Findings: the API is unchanged from what the app already
uses — `next/font/google` functions with `subsets`, `variable`, optional `display` (default `swap`); variable fonts
need no `weight`; `axes` (extra variable axes) is google-only and needs a variable font; the Tailwind route is the
`variable` option on `<html>` plus a CSS-variable mapping. The typings
(`node_modules/next/dist/compiled/@next/font/dist/google/index.d.ts`) have `Bricolage_Grotesque` (axes `opsz`,
`wdth`), `Geist` and `Geist_Mono`, all variable.

```ts
const sans    = Geist({ variable: '--font-sans', subsets: ['latin'] });
const mono    = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });
const display = Bricolage_Grotesque({ variable: '--font-display', subsets: ['latin'], axes: ['opsz'] });
<html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable} h-full`}>
```

The variable names `--font-sans`/`--font-mono` stay, so the `@theme inline` mapping and every `font-mono` utility are
untouched. Bricolage is used for every `h1` (base rule: `PageHeader`, `StateCard`, sign-in/up, About), the wordmark,
and shadcn `CardTitle` (`font-heading`). `h2`s stay Geist (the boards use Geist for card headings at 17 px and
Bricolage only for large section and modal titles; modal titles move to Bricolage in Phase C).

Self-hosting: `next/font/google` downloads at BUILD time, as Space Grotesk does today; the Docker image already
builds with network. No parity change.

## 6. Header

### 6.1 App shell (`src/app/(app)/layout.tsx`)

Structure (left to right, unchanged order): wordmark (`Logo` + `webfloppy`) → drive chips / compact Drives →
centred nav → search → About (i) → Settings gear → Sign out. Below `sm`: two lines plus the fixed bottom nav bar,
as today.

- `<header data-testid="app-header">`: `background: var(--surface)`, `border-bottom: 1px solid var(--line)`;
  `sm:h-[72px] sm:py-0` with `items-center`; below sm `py-3`. Side padding stays `px-4 sm:px-7` (the chip budget
  is measured from it).
- Nav wrapper: `sm:top-4` → `sm:top-[19px]` ((72 − 34) / 2, so the 42 px pill centres on the bar).
- Wordmark: `Logo size={24}`, text `webfloppy`, `font-family: var(--font-display)`, 18 px, 700,
  `letter-spacing: -0.02em`, `color: var(--ink)`.
- Right group: `gap-2` between the icon buttons (About, gear), `gap-4` before the search box.

### 6.2 Pieces

- **`Logo`** (`shell/logo.tsx`): redrawn from the board's header mark (viewBox `0 0 106 108`): ink body with the
  chamfered corner, `#D6D9DD` shutter with an ink slot, `#FBF8F1` label with the four stripes `#D9453A`
  `#EE8A2A` `#4F9D4A` `#2F6FB5`. No keyline (the ground is light now). Below 40 px the slot drops off, as today.
  Literal colours (it is also `icon.svg`).
- **`TopNav`** / **`AdminNav`**: `<nav aria-label="Main">` / `aria-label="Admin"` with class `seg`; items
  `seg-item`, 14 px. No inline colours.
- **`DriveChips`**: `CHIP_CLASS` → `h-9 … rounded-[10px] border px-2 text-[12px]` (gap, padding and the 3.5rem
  caps unchanged); `CHIP_STYLE` → `background: var(--surface-2); borderColor: var(--line); color: var(--ink)`;
  disk text `font-mono` in `var(--muted)`; online dot `var(--online-dot)` with `box-shadow: 0 0 0 3px rgb(63 191 85
  / 0.18)`, offline ring `1.5px solid var(--muted)`; the `WP`/`RW` tag `background: var(--track)`, no border,
  `color: var(--muted)`; focus ring `focus-visible:ring-[color:var(--ring)]`. Menu panel: `background:
  var(--surface)`, `border: 1px solid var(--line)`, `rounded-2xl`, `box-shadow: var(--shadow-card)`, no blur;
  separators `var(--line)`.
- **`SearchBox`**: input `h-10 rounded-[10px] border pl-9`, `background: var(--surface-2)`, `border-color:
  var(--line)`, `color: var(--ink)`, placeholder `var(--muted-2)`, width `sm:w-48` unchanged; a lucide
  `SearchIcon` (16 px, `var(--muted-2)`, `aria-hidden`) absolutely placed at the left (still ONE `header input`).
  `kbd`: `background: var(--surface)`, `border-color: var(--line)`, `color: var(--muted)`. Panel: `background:
  var(--surface)` (was opaque `#f1f4f5`), `border-color: var(--line)`, `rounded-2xl`, `box-shadow:
  var(--shadow-card)`; highlighted row `background: var(--surface-2)` (was `rgb(30 45 60 / .08)`); muted metadata
  on it 6.71:1.
- **`AboutLink`**: `size-9 rounded-[10px]`, `color: var(--muted)`, hover `bg-(--track) text-(--ink)`.
- **`SettingsLink`**: becomes a client component (`usePathname`); `size-9 rounded-[10px]`, `color: var(--ink)`;
  on `/settings…` it carries `aria-current="page"`, `background: var(--surface)`, `border: 1px solid var(--ink)`;
  otherwise a transparent border. It stays immediately before Sign out.
- **`SignOutButton`**: `h-9 rounded-[10px] px-3.5 text-[14px] font-medium`, `color: var(--muted)`, hover
  `bg-(--track) text-(--ink)`.
- **Mobile bottom bar**: its tokens (`--nav-scrim`, `--nav-scrim-hairline`) carry the change; no class edits.
- **`HeaderStart`**: `pillEstimate` re-measured at 1280 in Chromium (both shells' numbers, today 312/386) and the
  measurement written into its comment and `chipSlots`' comment; it exposes `data-pill-estimate`.

### 6.3 Admin shell (`src/app/(admin)/layout.tsx`)

Same bar (`data-testid="admin-header"`), same wrapper offset; wordmark `webfloppy` + ` admin` in `var(--muted)`;
`admin-email` and "Back to library" in `var(--muted)` (hover ink).

### 6.4 Test ids

Kept, unchanged: `wordmark-home`, `header-start`, `drive-chips`, `drives-compact`, `drives-compact-menu`,
`drive-chip-<id>`, `drive-chip-name-<id>`, `drive-chip-disk-<id>`, `drive-chip-wp-<id>`, `drive-chip-menu-<id>`,
`drive-chip-more`, `drive-chip-more-menu`, `drive-entry-*`, `drive-goto-*`, `drive-protect-*`, `drive-next-*`,
`drive-preload-*`, `drive-eject-*`, `search-input`, `search-hint`, `search-panel`, `search-result`, `search-empty`,
`settings-link`, `admin-email`, the `data-nav-pill` attribute.
New: `app-header`, `admin-header`, `about-link`, `sign-out`; attribute `data-pill-estimate` on `header-start`.

## 7. Building blocks

Kept small: the token map restyles nearly everything; these are the pieces that need code.

- **Card**: `.glass-card` (§4.4). shadcn `Card` follows through `--card`/`ring-foreground/10` → set
  `ring-1 ring-(--line)` in `ui/card.tsx` and `rounded-2xl`.
- **Buttons**: shadcn `ui/button.tsx` variants: `default` = ink fill, `#FFFDF8` text, `rounded-[10px]`;
  `outline` = surface fill, line border, ink text; `ghost` = transparent, `var(--muted)` text, hover track;
  `destructive` = `#B3341F` fill, white text. Inline buttons: tokens only (§3.12), plus the list-A fixes (§8).
- **Pills**: `ui/status-chip.tsx` takes the board's pill (`rounded-full px-[9px] py-0.5 text-[12px]
  font-semibold`); `neutral` → `background: var(--track); color: var(--muted)`; `blue` →
  `color-mix(in srgb, var(--accent-blue) 12%, var(--surface))`. Kinds and props unchanged.
- **Segmented control**: `.seg` (track `var(--track)`, padding 4 px, radius 12 px, gap 2 px) and `.seg-item`
  (34 px high, 0 16 px, radius 9 px, 14 px/500, `var(--muted)`; hover `rgb(255 253 248 / .6)` + ink; active —
  `[aria-current="page"]` or `[aria-pressed="true"]` — `var(--surface)`, ink, 600, `box-shadow: 0 1px 2px rgb(36 33
  27 / .12), 0 0 0 1px rgb(36 33 27 / .04)`). Used by `TopNav`, `AdminNav` and `library/view-toggle.tsx` (its two
  links keep their sizes, `h-10 w-11 sm:h-8 sm:w-9`, via a `seg-item--icon` modifier with `padding: 0`).
- **Modals**: the 12 dialogs keep their own markup; their backdrop literal becomes `var(--scrim)` and their panel
  gains `wf-modal`. Backdrop `rgb(11 18 28 / 0.55)` in: `ingest/staging-confirm.tsx:43`,
  `library/card-mount-button.tsx:227`, `library/move-to-collection.tsx:79`, `library/delete-disk-dialog.tsx:135`,
  `library/set-drop-dialog.tsx:121`, `nfc/fob-button.tsx:287`, `disks/file-actions.tsx:233`,
  `disks/history-panel.tsx:325`, `devices/delete-device-dialog.tsx:60`, `games/add-disks-dialog.tsx:177`; backdrop
  `rgb(0 0 0 / 0.45)` in `admin/delete-user-dialog.tsx:117` and `rgb(0 0 0 / 0.5)` in `devices/device-list.tsx:258`.
- **Disk icon** (new): `src/components/ui/disk-icon.tsx` (`DiskIcon`) ported from `ModernDisk.dc.html`, with its
  sizing maths in `src/lib/disk-icon.ts` (`diskIconMetrics(size)`, pure, unit-tested). Props: `color: 'black' |
  'blue' | 'grey' | 'red' | 'green' | 'cream'`, `size` (24–320), `hd`, `wp`, `stack`, `mounted`, `set`, `title`.
  Gradient ids are made unique per instance (`useId`) so two icons on a page do not share `wfSheen`. Used in Phase B
  in ONE place: `EmptyLibrary` (`library/title-controls.tsx`), cream, `set="Empty"`, `title="New box"`, 96 px,
  above "No disks yet" (as the board's empty collection). Phase C puts it on cards and in the drive menu.

## 8. Sites that relied on the dark ground (fixed by hand)

**A. `--on-dark` used as a fill** (ink-on-ink after the remap) → `background: var(--primary-action)` + `text-white`
class, navy literal removed: `library/create-adf.tsx:92`, `admin/issue-invite-button.tsx:50` and `:61`,
`admin/run-scan-button.tsx:48`, `nfc/fob-button.tsx:239`; `devices/display-editor.tsx:589` (primary fill with
`--on-dark` text) → `text-white`; `shell/top-nav.tsx:55` and `admin/admin-nav.tsx:39` (rewritten, §6.2).

**B. Navy text on a fill that changes:** `devices/device-list.tsx:208` and `:316` (`--amber-text` fill, `#16273a`
text → white text + `text-white`, 5.66:1); `library/cover.tsx:105` and `:111` (white badge, `#16273a` → `var(--ink)`).

**C. Translucent-white borders meant for the dark band** → `var(--hairline-strong)`: `library/demozoo-badge.tsx:9`,
`games/cover-control.tsx:69`, `games/edit-details.tsx:140`; `(admin)/layout.tsx:86` text `rgb(233 240 244 / .78)`
→ `var(--muted)`; `hover:bg-white/10` in `about-link.tsx`, `settings-link.tsx`, `sign-out-button.tsx` (rewritten).

**D. Old-palette literals** → ink-based: `rgb(30 45 60 / x)` → `rgb(36 33 27 / x)` in `collections/collection-rail.tsx:169`,
`library/game-table.tsx:35`, `library/cover.tsx` (shadows), `shell/skeleton.tsx:14`; `Bone`'s `onDark` shade
`rgb(255 255 255 / .16)` → `rgb(36 33 27 / 0.07)` (the prop stays, both branches equal); `app/global-error.tsx:11`
and `:21` (renders outside `globals.css`) → `#F3EFE6` / `#24211B` / button `#24211B`.

**E. Modal backdrops** → `var(--scrim)` (the 12 sites of §7).

Left as they are: `devices/drive-bezel.tsx:113` and `:120` (the drive's own LED and bezel, a picture of hardware);
`devices/display-editor.tsx:293` (reads `--accent-amber` at run time; fallback literal updated to `#B5541A`);
`collections/category-overview.tsx:153` (a dark fade over cover art, still over art).

After the edits, these two greps return only the "left as they are" lines and comments:
`grep -rnE "#16273a|#16232f|#f1f4f5|rgb\(11 18 28|rgb\(233 240 244|rgb\(30 45 60|bg-white/" src --include=*.tsx` and
`grep -rnE "background: ?'var\(--on-dark\)'|rgb\(255 255 255 / 0\.(1|2)[0-9]?\)" src --include=*.tsx`

## 9. The rename to WebFloppy

Visible product names today (comments, identifiers and tests excluded):

| # | File:line | Today | Becomes |
|---|---|---|---|
| 1 | `src/app/layout.tsx:19` | `title: "webadf"` | `title: { default: 'WebFloppy', template: '%s · WebFloppy' }` (template applies to child segments: `/help` becomes "Help · WebFloppy") |
| 2 | `src/app/(app)/layout.tsx:76` | wordmark `webadf` | `webfloppy` (§3.10) |
| 3 | `src/app/(admin)/layout.tsx:38` | `webadf admin` | `webfloppy admin` |
| 4 | `src/app/(app)/about/page.tsx:97` | section title `webadf` | `WebFloppy` (section `id="about-webadf"` and its test stay) |
| 5 | `src/app/(app)/help/page.tsx:13` | "What the less obvious parts of webadf do, and why." | "…of WebFloppy do, and why." |
| 6 | `src/lib/help/topics.tsx:466` | "webadf’s LZ4 build of his driver" | "WebFloppy’s LZ4 build of his driver" |
| 7 | `src/app/icon.svg`, `apple-icon.png`, `favicon.ico` | old mark | new mark (§3.14) |

Not renamed, on purpose: `library/title-controls.tsx:34` `webadf push` (the CLI's real command, `cli/package.json`
`bin`); `about/page.tsx:101` the repository URL; `lib/about/hosting.ts:9` `Hosted (webadf.vercel.app)` (a real
domain; `about-page.spec.ts:18` asserts it); `lib/help/topics.tsx:78` "the WiFi floppy drive" (describes the
hardware) and `:84` the `wifi-floppy-…` access point (the board's firmware name); user agents, event keys, env
names, the HMAC label, firmware headers and artefact names. README/docs: not UI, out of scope.

## 10. What is NOT done

- No page layout changes: grids, columns, card proportions, the library's collection rail, Devices cards, Upload,
  Disk files, Settings, Admin, Help and the phone layouts are Phase C.
- The header's nav stays viewport-centred; the single "Controlling" drive chip is not built.
- Inline buttons keep their shapes; card hover lift, the "…" title menu, the disk icon on cards, Bricolage modal
  titles: Phase C.
- No dark mode. No sign-in wordmark (Phase C step 5).

## 11. Testing

**Unit (`npx vitest run`):**
- `src/lib/design-tokens.test.ts` (new): reads `src/app/globals.css`, takes the LAST `--name: #hex` per name across
  `:root` blocks, and asserts every pair in §4.5 marked "pass" is ≥ 4.5 and that the new values are the §4.1/§4.3
  values (a typo in a hex fails here, not on screen).
- `src/lib/disk-icon.test.ts` (new): `diskIconMetrics` heights (`round(size*108/106)`), `showText` from 72 px,
  minimum paddings/sizes at 24 px, and the colour table.
- `src/lib/drive-chips.test.ts`: unchanged (`chipSlots` thresholds do not move).

**e2e** (`PORT=3100 npx playwright test <spec> --project=desktop|mobile`, one at a time, < 9 min each). The specs
the roadmap named, with what changes:

| Spec | Change |
|---|---|
| `shell.spec.ts:9` | `toContain('Space Grotesk')` → `toContain('Geist')` |
| `shell.spec.ts:11-13` | `backgroundImage` contains `linear-gradient` → `backgroundColor` is `rgb(243, 239, 230)` |
| `shell.spec.ts` (new asserts) | `h1` font contains `Bricolage Grotesque`; `app-header` background `rgb(255, 253, 248)`; `wordmark-home` text `webfloppy`; `await expect(page).toHaveTitle('WebFloppy')` on `/library`; test name "on the gradient" → "on the ground" |
| `contrast.spec.ts:117` | test name "legible on the gradient" → "legible on the ground"; logic unchanged |
| `contrast.spec.ts` (new test) | on `/library` (empty): `[data-testid=wordmark-home]`, `header nav a:not([aria-current])` (muted on track), `h1` (ink on ground), `[data-testid=game-grid] p:nth-of-type(2)` (muted on surface; the empty library), each > 4.5 |
| `contrast.spec.ts:150-183` | unchanged; the comment's `#f1f4f5`/`#e0e4e6` maths is rewritten for surface/surface-2 |
| `button-affordance.spec.ts` | unchanged; must still pass (hover shadow changes, §3.13) |
| `mobile.spec.ts:86` | unchanged; one `nav` (the `aria-label="Main"` addition does not add a nav) |
| `collections.spec.ts`, `devices-page.spec.ts`, `send-to-amiga.spec.ts`, `library-mount.spec.ts` | no colour asserts found (only opacity, visibility, `borderTopStyle` of `drive-ring`, bounding boxes); run as regression |
| `drive-chips.spec.ts:231-310, 323-362` | NOT in the roadmap's list but it measures the header: wordmark/chip/pill boxes, centring within 4 px, ≥ 16 px gaps, the 390 px line. Must pass unchanged; plus a new test that `data-pill-estimate` is within 2 px of the measured pill for a non-admin user |
| `states.spec.ts`, `user-settings.spec.ts:39`, `about-page.spec.ts`, `time-machine.spec.ts:109`, `help.spec.ts` | header ids and texts; regression |

**Screenshots:** `shell.spec.ts` and `contrast.spec.ts` already write `test-results/*.png`; the plan's last task
also refreshes the README set with `PORT=3100 npx playwright test -c playwright.screenshots.config.ts` (its own
config; `e2e/screenshots.shots.ts`) for the operator to compare with the boards.

## 12. Risks and open questions

- **Header geometry under new fonts.** Geist and Bricolage change every width the chip budget was measured with.
  `drive-chips.spec.ts` is the guard; the fallbacks are fixed in advance (wordmark 17 px; chip text stays 12 px),
  never `chipSlots`.
- **A missed dark-ground site** renders light-on-light or ink-on-ink. Guards: §8's grep, the contrast spec, a
  page-by-page screenshot look in the last task.
- **The two `--muted` meanings** (shadcn bg vs webadf text) stay tangled; `bg-muted` (2 uses) remains dark-ish
  (`#5B5446`). Not made worse; flagged.
- **`.glass-card` losing its blur** changes how translucent overlays over covers look (none measured); the dialogs'
  portals are unaffected.
- **The e2e suite writes to the live production DB**; runs are serialised.
- Open (operator): wordmark lowercase `webfloppy` (board) or `WebFloppy` (roadmap)? Spec assumes lowercase for the
  drawing, capitalised in prose.
- Open (operator): accept `#6E6657` for the light grey and `#A84C16` for accent text, one step darker than the board,
  for AA?
