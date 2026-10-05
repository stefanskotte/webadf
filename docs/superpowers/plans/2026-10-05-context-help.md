# Context help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "?" beside the controls that need explaining. Each opens a one-to-two sentence popover with a "More" link to a
`/help` page that has one section per feature. Both are fed from one typed source.

**Architecture:**
- `src/lib/help/topics.tsx` holds the 8 topics. Each has a `title`, a plain-text `short`, and a React `body`.
- `src/components/help/help-tip.tsx` renders the "?" and its base-ui `Popover`.
- `src/app/(app)/help/page.tsx` renders every body.
- Call sites import `HelpTip` and pass a typed topic id.

**Tech Stack:** Next.js (this repo's version — read `node_modules/next/dist/docs/` before touching routes or pages),
React, `@base-ui/react` Popover (already used by `src/components/library/create-adf.tsx`), lucide-react icons, vitest,
Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-context-help-design.md`

## Global Constraints

- **Topic ids** (fixed): `boards`, `nfc`, `next-disk`, `write-back`, `write-protect`, `disk-sets`, `hd-hfe`, `display`.
- **`short`:** plain text, at most 2 sentences, answering "what is this?".
- **`body`:** about 80–200 words, answering "how do I use it, and why does it behave like this?".
  - No images.
  - An optional "Good to know" list.
  - Plain words for an Amiga user.
  - These internal words never appear in help text: PSRAM, TBYB, poll, sha256, cursor, WPROT.
- **Accuracy:** every claim matches the code or HANDOFF. A claim that cannot be confirmed is left out. The texts in
  Task 1 were checked against the sources it lists. Do not add claims to them.
- **Labels:** use the UI's real ones. The write-protect toggle reads **"Protected" / "Writable"** (not WP/RW), and new
  disks start **Protected** (`src/db/schema/catalog.ts:142`).
- **Popover behaviour:** opens by tap, click and keyboard; closes on Esc or a tap outside; stays inside a 390 px viewport.
  No hover-only behaviour.
- **One "?" per feature per page.** In tight rows the "?" goes on a heading or label, or on the first row only, never
  on every row.
- **Test ids:**
  - `help-tip-<id>` on the "?" button;
  - `help-pop-<id>` on the popover;
  - `help-more-<id>` on the "More" link;
  - `help-section-<id>` on the /help `<section>`, whose DOM id is `<id>`.
- **e2e rules:**
  - Run on **PORT=3103** (`PORT=3103 npx playwright test …`). Port 3100 is held by a process you must not touch.
  - Never `pkill` by pattern.
  - One Playwright process at a time; the suite shares the live database.
  - Foreground runs under 9 minutes per call.
- **Never `git stash`, in any form.** Use `git show <sha>:<path>`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, or your session's own attribution.

## Review Focus

1. **A "?" inside something clickable** (a disk row with drag handles, a device card, the Display toggle row).
   - Expected: tapping "?" opens help and does nothing else. It doesn't toggle write-protect, start a drag, follow a
     link or collapse the Display section.
   - Pinned by the e2e test "the help button does not trigger the control beside it" in Task 4.
2. **Phone width (390 px) near the right edge.**
   - Expected: the popover is fully inside the viewport, and the "More" link can be tapped.
   - Pinned by the mobile-project e2e test in Task 4.
3. **"More" landing under the sticky header.**
   - Expected: the section title is visible after navigating to `/help#<id>`, not hidden behind the header.
   - Pinned by `scroll-mt` on each section (Task 2) and the e2e assertion `toBeInViewport()` on the section heading
     (Task 4).
4. **Keyboard.**
   - Expected: Tab reaches "?", Enter opens it, and Esc closes it and returns focus to "?".
   - Pinned in the Task 4 e2e test.
5. **Signed out.**
   - Expected: `/help` behaves like every other app page (redirect to sign-in), never a crash.
   - Pinned by the Task 4 e2e test.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/help/topics.tsx` | the 8 topics (title, short, body), `HelpTopicId`, `HELP_ORDER` | 1 |
| `src/lib/help/topics.test.ts` | shape rules for every topic | 1 |
| `src/components/help/help-tip.tsx` | the "?" button and its popover | 2 |
| `src/app/(app)/help/page.tsx` | the /help page | 2 |
| `src/components/shell/top-nav.tsx` | "Help" nav item | 2 |
| `src/components/shell/page-header.tsx` | optional `help` prop beside the title | 3 |
| call sites listed in Task 3 | place the "?" buttons | 3 |
| `e2e/help.spec.ts` | e2e | 4 |

---

### Task 1: The help topics (single source) and their shape rules

**Files:**
- Create: `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HelpTopic = { title: string; short: string; body: React.ReactNode };
  export const HELP_TOPICS: { readonly boards: HelpTopic; readonly nfc: HelpTopic; /* … all 8 … */ };
  export type HelpTopicId = keyof typeof HELP_TOPICS;
  export const HELP_ORDER: readonly HelpTopicId[];   // the /help table of contents, in this order
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/help/topics.test.ts
import { describe, it, expect } from 'vitest';
import { HELP_TOPICS, HELP_ORDER, type HelpTopicId } from './topics';

const IDS: HelpTopicId[] = ['boards', 'nfc', 'next-disk', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display'];
const BANNED = /\b(PSRAM|TBYB|poll|sha256|cursor|WPROT)\b/i;

// Sentence ends: . ! ? followed by a space or the end -- but not inside "e.g." or a number like "1.7".
function sentences(s: string): number {
  return s.split(/(?<!\be\.g|\bi\.e)[.!?](?=\s|$)/).filter((p) => p.trim().length > 0).length;
}

describe('help topics', () => {
  it('has exactly the eight spec topics', () => {
    expect(Object.keys(HELP_TOPICS).sort()).toEqual([...IDS].sort());
  });

  it('lists every topic once in the table of contents', () => {
    expect([...HELP_ORDER].sort()).toEqual([...IDS].sort());
    expect(new Set(HELP_ORDER).size).toBe(HELP_ORDER.length);
  });

  for (const id of IDS) {
    it(`${id}: a title, a 1-2 sentence short, a body, no internal words`, () => {
      const t = HELP_TOPICS[id];
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(sentences(t.short)).toBeGreaterThanOrEqual(1);
      expect(sentences(t.short)).toBeLessThanOrEqual(2);
      expect(t.short).not.toMatch(BANNED);
      expect(t.body).toBeTruthy();
    });
  }
});
```

Also add a body word-count and banned-word check by rendering each body to text. Use `react-dom/server`'s
`renderToStaticMarkup`, strip the tags, and assert 60–260 words and no `BANNED` match. That leaves slack around the
spec's ~80–200.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run src/lib/help/topics.test.ts`
Expected: FAIL, because `./topics` does not exist.

- [ ] **Step 3: Write `src/lib/help/topics.tsx` with exactly this content**

Sources per topic are given as comments; keep them in the file. They tell the next editor where each claim was checked.

```tsx
import type { ReactNode } from 'react';

// Context help (spec docs/superpowers/specs/2026-10-05-context-help-design.md).
// One source for the "?" popovers (title + short) and the /help page (body).
// Every claim here was checked against the code/HANDOFF named beside it --
// change the behaviour, change the text.

export type HelpTopic = { title: string; short: string; body: ReactNode };

function GoodToKnow({ items }: { items: ReactNode[] }) {
  return (
    <>
      <p className="font-semibold">Good to know</p>
      <ul className="list-disc pl-5">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </>
  );
}

export const HELP_TOPICS = {
  // Sources: pair-button.tsx, devices/page.tsx:58-68, device-state.ts:19 (60 s),
  // firmware-state.ts:107-148, HANDOFF trial/revert (5546-5577) and "waits for eject" (2064, 5148).
  boards: {
    title: 'Boards',
    short:
      'A board is the WiFi floppy drive plugged into your Amiga. Pair it once with a code from this page, and from then on it plays whatever you mount here.',
    body: (
      <>
        <p>
          <strong>Pairing.</strong> Press <em>Pair a device</em> to get a short code. A new board starts its own Wi-Fi
          network named <em>wifi-floppy-…</em>; join it, and in the page that opens enter your home Wi-Fi details and
          the code. If the code runs out first, mint a new one.
        </p>
        <p>
          <strong>Online / Offline.</strong> A board counts as online while it has been heard from in the last minute.
        </p>
        <p>
          <strong>Firmware updates.</strong> When a newer version is published, tick <em>Select for update</em> on the
          board. Its card then shows <em>update queued</em>, <em>downloading</em> and <em>applying — do not power
          off</em>. A new version first runs on trial: if it doesn&apos;t start up and check in within 5 minutes, the
          board goes back to the version it had by itself, and the card says <em>update failed</em> with the reason.
        </p>
        <GoodToKnow items={[
          'A board never updates while a disk is mounted — the update waits for the eject.',
          'Updates also wait until the Amiga is switched on and the drive is idle.',
        ]} />
      </>
    ),
  },

  // Sources: nfc/fob-button.tsx (flow, 120 s wait, texts), devices/page.tsx:19,59 (Next-disk card, fw 1.6.0+),
  // HANDOFF tap-to-mount (5248-5296) and Next-disk card (4968-4971).
  nfc: {
    title: 'NFC cards',
    short:
      'Stick an NFC sticker or fob on a real floppy case, link it to a disk here, and tapping it on the board mounts that disk. A Next-disk card instead moves whatever is mounted to its next disk.',
    body: (
      <>
        <p>
          <strong>Linking a tag.</strong> Press the NFC button on a disk — it only appears when one of your boards has
          an NFC reader. Pick the disk and the board, then hold the tag on that board&apos;s reader within two
          minutes. Lift any tag that is already on the reader first: the board never writes to a tag that was lying
          there when you started.
        </p>
        <p>
          <strong>Tapping.</strong> Tapping a tag mounts its disk. Tapping the disk that is already in the drive does
          nothing. The tag stores which disk it is, so it keeps working after the Amiga has saved to that disk.
        </p>
        <p>
          <strong>Next-disk card.</strong> Write one with <em>Write a Next-disk card</em> on the Devices page. Tapping
          it moves a multi-disk game on to its next disk.
        </p>
        <GoodToKnow items={['Next-disk cards need board firmware 1.6.0 or newer.']} />
      </>
    ),
  },

  // Sources: drive-chips.ts:14-18 (preload texts), next-disk-button.tsx, drive-chips.tsx:332,
  // HANDOFF next disk (4960-4991) and the swap gate (4811-4880: 3 s idle, 20 s forced, OLED text).
  'next-disk': {
    title: 'Next disk and preloading',
    short:
      'Next disk steps a multi-disk game on to its next disk, in the disk set’s order. The board loads that disk ahead of time, so the swap is close to instant.',
    body: (
      <>
        <p>
          Use the <em>Next: disk N</em> button on the board&apos;s card, the drive menu, or a Next-disk card. After the
          last disk it wraps around to the first.
        </p>
        <p>
          <strong>Preloading.</strong> The line under the board shows <em>Disk N ready (instant swap)</em>,{' '}
          <em>Disk N loading…</em> or <em>Disk N not preloaded yet</em>. The board only preloads when it has nothing
          else to do, such as saves still to send or an update.
        </p>
        <p>
          <strong>Why a swap sometimes waits.</strong> After a save, the Amiga goes on writing for a moment. Taking
          the disk away then would damage it, just like ejecting a real floppy with the drive light on. So the board
          swaps only when the drive light is off and nothing has been written for 3 seconds. Its display says{' '}
          <em>Saving, then disk N</em> meanwhile.
        </p>
        <GoodToKnow items={[
          'If the drive stays busy without writing (some games keep the motor running), the board swaps anyway after 20 seconds of quiet.',
        ]} />
      </>
    ),
  },

  // Sources: history-panel.tsx (labels, Restore dialog, mounted refusal), disk-history/history.ts:98-107,
  // HANDOFF write-back (3188-3215), restore (2975-2982), re-dating (4813-4863, volume-date.ts).
  'write-back': {
    title: 'Saves and the time machine',
    short:
      'When the Amiga saves to a writable disk, the change is sent here and kept as a new version. The History lists every version, and you can browse or restore any of them.',
    body: (
      <>
        <p>
          A save arrives a few seconds after the Amiga stops writing. If you eject or swap sooner, the board finishes
          sending first. Each version in the History says where it came from: <em>As uploaded</em>,{' '}
          <em>Edited in browser</em>, <em>Amiga: &lt;board&gt;</em> or <em>Restored to version N</em>.
        </p>
        <p>
          <strong>Restore</strong> adds the old version back as the newest one. Nothing is thrown away, so you can
          restore forward again. A disk that is mounted on a board can&apos;t be restored — eject it there first.
        </p>
        <p>
          <strong>Why a restored disk gets a new date.</strong> The Amiga recognises a disk by its creation date and
          name. If a restored disk looked exactly like the one it remembers, it could write its old memory of that
          disk back onto it. So a restore moves the disk&apos;s creation date on by one tick (a fiftieth of a second),
          and the Amiga treats it as a different disk.
        </p>
        <GoodToKnow items={[
          'Because of that date, a restored disk is not byte-for-byte the old version.',
          'Disks that are not standard AmigaDOS, such as many games, are restored exactly.',
        ]} />
      </>
    ),
  },

  // Sources: write-protect-toggle.tsx:38 (labels + tooltips), catalog.ts:142 (default protected),
  // HANDOFF write protect (1900-1901, 3113-3125, 3199-3202), disk-row.tsx:155-159 (HFE).
  'write-protect': {
    title: 'Write protection',
    short:
      'Writable lets the Amiga save to this disk, and each save becomes a new version here. Protected makes the disk read-only for the Amiga, like sliding the tab on a real floppy.',
    body: (
      <>
        <p>
          New disks start <em>Protected</em>. The setting belongs to the disk, so it goes with the disk to whichever
          board mounts it.
        </p>
        <p>
          Changing it while the disk is mounted tells the Amiga the disk was taken out and put back. A program with a
          file open on that disk may then ask you to put the volume back in. That is normal: click through, and carry
          on.
        </p>
        <GoodToKnow items={[
          'The board can also protect a disk by itself, when this site refuses its saves (for example because the disk was changed here meanwhile). It stays protected until the disk is mounted again.',
          'HFE disks are always read-only.',
        ]} />
      </>
    ),
  },

  // Sources: disk-set-section.tsx:166-175 (header texts), add-disks-dialog.tsx, disk-set-menu.tsx:58-100,
  // ingest/set-suggestion.tsx, card-mount-button.tsx:211, HANDOFF disk sets (4902-4941).
  'disk-sets': {
    title: 'Disk sets',
    short:
      'A disk set is a title with several disks, such as a multi-disk game or a Workbench install. Its order is the order Next disk steps through.',
    body: (
      <>
        <p>
          <strong>Making a set.</strong> When you upload loose disks that seem to belong together, the upload page
          suggests <em>These N disks look like one set</em>. You can also use <em>Add disks…</em> on a title, choose{' '}
          <em>Add to a disk set…</em> from a single disk&apos;s menu, or drag one library card onto another.
        </p>
        <p>
          <strong>Ordering.</strong> Press <em>Reorder</em> and drag, or use the ⋯ menu&apos;s <em>Move up</em>,{' '}
          <em>Move down</em> and <em>Move out of set</em>. Once you have arranged a set yourself, automatic renumbering
          leaves it alone.
        </p>
        <p>
          <strong>Mounting.</strong> The mount button on a set&apos;s library card asks which disk, and which board if
          you have more than one.
        </p>
      </>
    ),
  },

  // Sources: create-adf.tsx:181 (HD, Kickstart 3.x), hfe/messages.ts (texts), extract-action.tsx,
  // HANDOFF HD (5000-5100), HFE long tracks (5326-5413), copy protection (1553-1569).
  'hd-hfe': {
    title: 'HD disks and HFE images',
    short:
      'HD disks hold 1.76 MB and need Kickstart 3.x on the Amiga. HFE images store a disk as its raw magnetic signal, so they can hold games an ordinary ADF cannot, but they are play-only.',
    body: (
      <>
        <p>
          <strong>HD disks.</strong> Create one from <em>New disk</em>, or upload one. Saving to HD disks needs board
          firmware 1.5.0 or newer.
        </p>
        <p>
          <strong>HFE images.</strong> Some games use tracks longer or stranger than a normal disk&apos;s (Turrican is
          one), which an ADF cannot hold. An HFE image keeps them. If a board&apos;s firmware is too old for a
          disk&apos;s longest track, mounting it says so.
        </p>
        <p>
          <strong>Extract as ADF</strong> makes an ordinary, editable ADF copy of an HFE disk, when every part of it
          is standard AmigaDOS. Otherwise the disk is marked play only.
        </p>
        <GoodToKnow items={[
          'A copy-protected original can boot from an ADF and still not be complete: the protection check can fail quietly later in the game. A version with the protection removed avoids that.',
          'Weak-bit copy protections are not supported.',
        ]} />
      </>
    ),
  },

  // Sources: display-editor.tsx, display-editor-geometry.ts:172-178 (status texts), HANDOFF 3ax.
  display: {
    title: "The board's display",
    short:
      "Choose the panel fitted to the board and arrange what its screen shows. The preview is drawn by the board's own code, so it matches the real panel pixel for pixel.",
    body: (
      <>
        <p>
          Pick the <em>Panel</em> (128×32 or 128×64), then drag elements where you want them. Each element can be
          shown or hidden and drawn at 1× or 2×. <em>Preview as</em> shows the layout in different situations, such
          as downloading or with a long title.
        </p>
        <p>
          After <em>Save</em> the status reads <em>Waiting for the board</em>, then <em>Applied on the board</em> a
          moment later. If the board refuses a layout, it says why.
        </p>
        <p>
          Your layout is used while the board is running: ready, downloading and with a disk mounted. The start-up,
          setup, connecting and error screens always use the standard layout, so a board can still be set up and
          diagnosed whatever its layout.
        </p>
        <GoodToKnow items={['Display layouts need board firmware 1.7 or newer.']} />
      </>
    ),
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;

export const HELP_ORDER: readonly HelpTopicId[] = [
  'boards', 'nfc', 'next-disk', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display',
];
```

If `as const satisfies` conflicts with the ReactNode bodies under this TypeScript version, drop `as const` and keep
`satisfies`. The keys still type `HelpTopicId`. Do not change any text to make a test pass; report it instead.

- [ ] **Step 4: Run, pass, typecheck**

Run: `pnpm vitest run src/lib/help/topics.test.ts && npx tsc --noEmit -p .`
Expected: all pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/help/topics.tsx src/lib/help/topics.test.ts
git commit -m "feat(help): the eight help topics, one typed source for popovers and /help

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The "?" component, the /help page, and the nav item

**Files:**
- Create: `src/components/help/help-tip.tsx`, `src/app/(app)/help/page.tsx`
- Modify: `src/components/shell/top-nav.tsx` (ITEMS)

**Interfaces:**
- Consumes: `HELP_TOPICS`, `HELP_ORDER`, `HelpTopicId` (Task 1).
- Produces: `export function HelpTip({ topic, className }: { topic: HelpTopicId; className?: string }): JSX.Element`.

- [ ] **Step 1: Read the Next docs for the page/route conventions in this repo's version** (`node_modules/next/dist/docs/`),
  and read `src/app/(app)/devices/page.tsx` for how an app page is laid out (PageHeader, auth via the `(app)` layout).

- [ ] **Step 2: Write `HelpTip`**

```tsx
'use client';
import { Popover } from '@base-ui/react/popover';
import { CircleHelpIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';
import { HELP_TOPICS, type HelpTopicId } from '@/lib/help/topics';

/**
 * A "?" that explains the control beside it (spec 2026-10-05-context-help).
 * Tap, click or keyboard opens it -- never hover-only, because a phone has no
 * hover. The click is stopped here so a "?" inside a clickable row, card or
 * toggle never also triggers the thing it explains (Review Focus 1).
 */
export function HelpTip({ topic, className }: { topic: HelpTopicId; className?: string }) {
  const t = HELP_TOPICS[topic];
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid={`help-tip-${topic}`}
        aria-label={`About ${t.title}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full align-middle opacity-70 hover:opacity-100 focus-visible:opacity-100 ${className ?? ''}`}
        style={{ color: 'var(--ink-muted, currentColor)' }}
      >
        <CircleHelpIcon className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} collisionPadding={16} className="z-50">
          <Popover.Popup
            data-testid={`help-pop-${topic}`}
            className="w-[min(300px,calc(100vw-32px))] rounded-xl p-3 text-[13px] leading-snug shadow-lg outline-none"
            style={{
              background: 'var(--glass-strong)', color: 'var(--ink)',
              border: '1px solid var(--hairline-strong)', backdropFilter: 'blur(16px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Popover.Title className="mb-1 text-[13px] font-bold">{t.title}</Popover.Title>
            <Popover.Description>{t.short}</Popover.Description>
            <Link href={`/help#${topic}`} data-testid={`help-more-${topic}`}
                  className="mt-2 inline-block font-semibold underline-offset-2 hover:underline">
              More about {t.title} →
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
```

Check against the installed `@base-ui/react` that:
- `Popover.Description` exists, and Positioner takes `collisionPadding`;
- the `@/components/shell/link` `Link` passes through `data-testid`.

Adjust to the real API if not. Use whatever style token the app uses for muted ink; grep `globals.css` for
`--ink-muted` or its equivalent.

- [ ] **Step 3: Write the /help page**

```tsx
// src/app/(app)/help/page.tsx
import { PageHeader } from '@/components/shell/page-header';
import { HELP_TOPICS, HELP_ORDER } from '@/lib/help/topics';

export const metadata = { title: 'Help' };

export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help" subtitle="What the less obvious parts of webadf do, and why." />
      <div className="px-4 pb-16 sm:px-7">
        <nav aria-label="Topics" className="mb-8">
          <ul className="flex flex-wrap gap-2">
            {HELP_ORDER.map((id) => (
              <li key={id}><a href={`#${id}`} className="underline-offset-2 hover:underline">{HELP_TOPICS[id].title}</a></li>
            ))}
          </ul>
        </nav>
        {HELP_ORDER.map((id) => (
          <section key={id} id={id} data-testid={`help-section-${id}`}
                   className="mb-10 max-w-[68ch] scroll-mt-24 space-y-3 text-[14.5px] leading-relaxed">
            <h2 className="text-[18px] font-bold">{HELP_TOPICS[id].title}</h2>
            {HELP_TOPICS[id].body}
          </section>
        ))}
      </div>
    </>
  );
}
```

Match the visual container used by other app pages; open `devices/page.tsx` and copy its wrapper (a card or glass
panel class) if it has one. `scroll-mt-24` keeps a section title clear of the sticky header (Review Focus 3). Measure
the header height and adjust if it is taller than 6 rem.

- [ ] **Step 4: Add the nav item**

In `src/components/shell/top-nav.tsx` ITEMS, append `{ href: "/help", label: "Help" }` after Upload.

- [ ] **Step 5: Check by hand, typecheck, lint, commit**

Start a dev server on **port 3104**:
`PORT=3104 BETTER_AUTH_URL=http://localhost:3104 pnpm dev --port 3104`.
Stop only that PID afterwards.

Create a signed-in session with a throwaway Playwright script under the scratchpad that uses `e2e/helpers.ts`
`signUpFresh`, and run the e2e teardown afterwards. Then:
1. Screenshot `/help` at 1280 and at 390 px into the scratchpad, and look at them.
2. Temporarily render `<HelpTip topic="boards" />` on a page to check it. Remove it before committing; Task 3 places
   the real ones.

Run `npx tsc --noEmit -p .` and `pnpm lint` on the changed files.

```bash
git add src/components/help/help-tip.tsx "src/app/(app)/help/page.tsx" src/components/shell/top-nav.tsx
git commit -m "feat(help): the \"?\" popover and the /help page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Place the "?" buttons

**Files (modify):**
- `src/components/shell/page-header.tsx`
- `src/app/(app)/devices/page.tsx`
- `src/components/devices/device-card.tsx`
- `src/components/devices/display-editor.tsx`
- `src/components/disks/history-panel.tsx`
- `src/components/games/disk-set-section.tsx`
- `src/components/games/disk-row.tsx`, plus its parent that maps the rows
- `src/components/games/extract-action.tsx`

**Interfaces:**
- Consumes: `HelpTip` (Task 2), `HelpTopicId` (Task 1).
- Produces: `PageHeader` gains `help?: HelpTopicId`. When set, a `<HelpTip topic={help} />` sits right after the
  `<h1>` text, inside the same flex line.

- [ ] **Step 1: Place each one exactly here**

| Topic | Where (file) | How |
|---|---|---|
| `boards` | `devices/page.tsx` | `<PageHeader … help="boards">` |
| `boards` | `device-card.tsx` | after the firmware line (the "up to date" / "N releases behind" / update-state text) |
| `nfc` | `devices/page.tsx` | in the header actions, directly after the "Write a Next-disk card" button |
| `nfc` | game page disk rows | on the **first** row only, after its NFC button; pass `showHelp` from the parent's map for index 0. If the row has no NFC button (no reader), no "?" is rendered |
| `next-disk` | `device-card.tsx` | after the preload line (`Disk N ready…` / `loading…` / `not preloaded yet`) |
| `write-back` | `history-panel.tsx:185` | inside the `<h2>History</h2>` line, after the text |
| `write-protect` | game page disk rows | on the **first** row only, after the Protected/Writable toggle (same `showHelp` prop). Not on HFE rows; if the first row is HFE, the first non-HFE row |
| `disk-sets` | `disk-set-section.tsx:166` | after the "Disk set" label |
| `hd-hfe` | `extract-action.tsx` | after "Extract as ADF", or after the "play only" reason when extraction is not offered |
| `display` | `display-editor.tsx` | after the "Display" toggle label. Must sit outside the toggle `<button>`; nest it as a sibling, never inside the button |

`HelpTip` already stops click and pointer-down propagation, so a "?" in a row with drag handlers or a link does not
trigger them. Never nest the "?" `<button>` inside another `<button>` or `<a>` (invalid HTML); place it as a sibling.

- [ ] **Step 2: Typecheck, lint, unit suite**

Run: `npx tsc --noEmit -p . && pnpm lint && pnpm vitest run 2>&1 | tail -3`
Expected: clean for your files, and the suite passes. Existing component tests must still pass: some snapshot or text
assertions may now see an extra "About …" label. If one fails, update the assertion to the new markup, and only that.

- [ ] **Step 3: Check by hand at 390 px**

Use the same port-3104 approach and throwaway script as Task 2. Pair a simulated board with `e2e/device-helpers.ts`
`pairDevice`, and report a status with `displayLayouts: true`. Then:
1. Screenshot the Devices page and a game page, at 1280 and at 390 px.
2. Confirm each "?" sits on its label's line and nothing wraps badly.
3. Run the teardown, and stop your server PID.

- [ ] **Step 4: Commit**

```bash
git add src/components/shell/page-header.tsx "src/app/(app)/devices/page.tsx" src/components/devices/device-card.tsx \
        src/components/devices/display-editor.tsx src/components/disks/history-panel.tsx \
        src/components/games/disk-set-section.tsx src/components/games/disk-row.tsx \
        src/components/games/extract-action.tsx <the disk-row parent file>
git commit -m "feat(help): \"?\" beside boards, NFC, next disk, history, write protection, disk sets, HFE and the display editor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: e2e

**Files:**
- Create: `e2e/help.spec.ts`

- [ ] **Step 1: Write the spec** using `signUpFresh` (`e2e/helpers.ts`), `pairDevice`/`authHeader`/`cleanupSeeded`
(`e2e/device-helpers.ts`). Follow `e2e/display-layout.spec.ts` for the setup style.

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

test('a help button opens a short explanation that links to its /help section', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request);
  await page.goto('/devices');
  const tip = page.getByTestId('help-tip-boards').first();
  await tip.click();
  const pop = page.getByTestId('help-pop-boards');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Pair it once');
  await expect(pop).toBeInViewport({ ratio: 1 });            // Review Focus 2 (run on both projects)
  await page.getByTestId('help-more-boards').click();
  await expect(page).toHaveURL(/\/help#boards$/);
  await expect(page.getByTestId('help-section-boards').getByRole('heading')).toBeInViewport();  // Review Focus 3
});

test('/help lists all eight topics', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/help');
  for (const id of ['boards', 'nfc', 'next-disk', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display']) {
    await expect(page.getByTestId(`help-section-${id}`)).toBeVisible();
  }
});

test('keyboard: Tab reaches the "?", Enter opens it, Esc closes it and returns focus', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request);
  await page.goto('/devices');
  const tip = page.getByTestId('help-tip-boards').first();
  await tip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('help-pop-boards')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help-pop-boards')).toBeHidden();
  await expect(tip).toBeFocused();                             // Review Focus 4
});

test('the help button does not trigger the control beside it', async ({ page, request }) => {
  // Review Focus 1: the Display "?" sits beside the Display toggle; opening help must not expand the editor.
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const r = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, displayLayouts: true, displayVersion: 0 },
  });
  expect(r.status()).toBe(204);
  await page.goto('/devices');
  await page.getByTestId('help-tip-display').first().click();
  await expect(page.getByTestId('help-pop-display')).toBeVisible();
  await expect(page.getByTestId(`display-canvas-${deviceId}`)).toHaveCount(0);   // editor stayed collapsed
});

test('signed out, /help goes to sign-in like every app page', async ({ page }) => {
  await page.goto('/help');                                    // Review Focus 5
  await expect(page).not.toHaveURL(/\/help/);
});
```

Check the last test against how other app pages redirect a signed-out visitor: look at an existing auth e2e for the
target URL, and assert that exact URL instead of the negative.

- [ ] **Step 2: Run the spec alone on both projects, then the full suite**

```bash
PORT=3103 npx playwright test e2e/help.spec.ts --reporter=line
```

Then run the full suite in foreground chunks under 9 minutes each (groups of spec files), one process at a time, and
grep each summary for `failed`. Re-run any failure alone before blaming the code.

- [ ] **Step 3: Commit**

```bash
git add e2e/help.spec.ts
git commit -m "test(e2e): context help -- popover, /help sections, keyboard, no click-through, signed out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done while writing)

- **Spec coverage:**

  | Spec | Task |
  |---|---|
  | §3 topics | 1 |
  | §4 module | 1 |
  | §4 component, page, nav | 2 |
  | §4 placement | 3 |
  | §5 content rules (banned words and sentence count tested) | 1 |
  | §6 unit tests | 1 |
  | §6 type check | 1, 3 |
  | §6 e2e and the full suite | 4 |
- **Deviation from the spec, on purpose:** the spec's sample said "RW/WP". The UI's real labels are
  "Writable/Protected", so the text uses those (Global Constraints, accuracy rule).
- **Placeholders:** none. The disk-row parent file is named by role, because only the implementer can see which
  component maps the rows. Step 1 of Task 3 says how to find it.
- **Types:** `HelpTopicId`, `HELP_TOPICS`, `HELP_ORDER`, `HelpTip({ topic })` and `PageHeader help` are the same in
  every task.
- **Review Focus:** each line has its test in Task 4. Line 3 is also pinned by `scroll-mt` in Task 2.
