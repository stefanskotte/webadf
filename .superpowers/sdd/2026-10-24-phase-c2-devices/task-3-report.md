# Task 3 report: drive tile, DF0 drive box, standalone Transfer box

Status: DONE_WITH_CONCERNS

## Built
- drive-art.tsx (+ drive-art.test.ts), drive-glass.tsx (from drive-bezel.tsx, deleted), drive-front.tsx (tile, caption, display-toggle, display help tip),
  drive-box.tsx, transfer-box.tsx, box-button.ts (shared secondary frame), next-disk-button / reinsert-button restyled, device-card.tsx wired
  (tile in the top row, drive box, error + last-boot strips, standalone Transfer box; old words block, protection tag, old send/upload lines removed),
  display-editor.tsx (own toggle removed; the drawer renders only when open), help topic `display` wording.
- e2e: devices-page "bezel display names the mounted disk" rewritten (box visible, no sr-only assert); new "protection switch flips the disk, title links, empty drive offers library";
  the "opens the drawer" test lost its inert assert and now expects `Change display`; display-layout:165 text `Change display`.

## Commands and counts
- `pnpm test src/components/devices/drive-art.test.ts`: 5 passed. `pnpm test src/components/devices src/lib`: 202 files, 2607 tests passed.
- `npx tsc --noEmit`: clean. `pnpm lint`: 2 errors, both pre-existing react-hooks/purity in src/app/(admin)/admin/page.tsx:51 and admin/scan/page.tsx:167 (not touched); warnings pre-existing.
- e2e desktop (PORT=3100, one at a time, `--list` checked first):
  - devices-page "four device states|stale card|last_error|eject|desired title|another organization|pending eject": 7 passed
  - devices-page "write-protect|bezel|upright|protection switch|disk title": 5 passed
  - next-disk (whole file; includes device card|preload) + reinsert: 8 passed
  - live-state 6 + write-protect-live 1: 7 passed
  - send-to-amiga/from-amiga "card|Devices|device": 2 passed
  - drive-chips "eject|link": 3 passed
  - display-layout (whole file, includes :287): 13 passed
  - mobile -g "Devices" (mobile project): 2 passed (incl. :133)
- Shots (not committed): .superpowers/sdd/2026-10-24-phase-c2-devices/shots/task3-{1280,390}-{all,holding,empty,offline,tall}.png

## Concerns
- The display drawer still opens inside the 340 px tile column (today's drawer, until Task 6's modal); it is narrow there.
- Eyeballed 1280 and 390 holding/empty/tall; the offline shot was saved but not inspected.
- I wrote the unit test before the component but did not run it red (the import target did not exist yet).
