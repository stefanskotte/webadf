# Task 1 report: look rules, tokens, data, Modal (no visible change)

Status: DONE_WITH_CONCERNS

Tests written first and watched failing (10 failed / 51 passed across the 5 touched unit files before implementing).

## Commands and counts
- `npx vitest run` (full): 274 files, 3205 tests passed (before the design-tokens additions); `npx vitest run src/lib/design-tokens.test.ts`: 61 passed.
- `npx tsc --noEmit`: clean.
- `npm run lint`: 2 errors, 13 warnings, all pre-existing and outside this task (react-hooks/purity in src/app/(admin)/admin/page.tsx and admin/scan/page.tsx; unused-var warnings in untouched files).
- `PORT=3100 npx playwright test devices-page -g "four device states|desired title|another organization|pending eject"`: 4 passed (desktop).
- `PORT=3100 npx playwright test second-drive -g "Any disk|setting reads"`: 3 passed (desktop).

## What changed
New: src/lib/devices-look.ts (+test): firmwareCellText, driveBoxText, statusPill, signalCell; src/lib/display-elements.ts (+test): ELEMENT_LOOK;
src/components/ui/modal.tsx (Base UI Dialog, unused).
Extended: library-look (driveDiskColor), second-drive (secondDriveHelp), network-checklist (splitCheckLine), each with tests;
globals.css (--fw-line, --modal-foot, .seg--sm, [aria-checked="true"] on the active rule); design-tokens.test.ts (tokens + §12 pairs; the full §12 table with ratios is in devices-look.test.ts);
queries.ts (mountedGameId, desiredGameId from the org-scoped aliases); devices/page.tsx (transferById) -> DeviceList -> DeviceCard (`transfer` prop, unused until Task 3);
device-card.tsx heading/bigText/subText now come from driveBoxText; second-drive-setting.tsx help text from secondDriveHelp.

## Concern
The only non-identical output: the EMPTY state's sr-only words in the card. Today: heading `No disk`, big `No disk`, sub `Mount one from the library`.
Spec §4.2's table (which driveBoxText follows) says label `In the drive`, title `No disk`, meta `Mount a disk from any title in the library.`.
The brief's two requirements conflict here; I followed the spec table. It is screen-reader-only text; the e2e `toContainText('No disk')` still passes.
All other states/mode sentences are byte-identical.
Modal note: `dismissible=false` blocks Escape/backdrop; the close button is not disabled by the Modal itself (the consumer decides in Task 6/7).
