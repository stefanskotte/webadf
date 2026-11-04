# Create SysConf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Create SysConf…` replaces `Filter…` in the Files bank and writes a complete 232-byte `system-configuration` into the active pane from a dialog of the settings Kickstart uses.

**Architecture:** A pure, client-safe module (`sysconf.ts`) holds the settings type, defaults, limits and the byte builder, starting from a template made by `mksysconfig.py`. A new `create-sysconf` op validates the settings on the server and writes through the place's `driver.write`. The dialog and pointer editor are presentational; `files-manager.tsx` wires them like Create ADF.

**Tech Stack:** Next.js (read `node_modules/next/dist/docs/` before route code), React, zod, vitest, Playwright.

> **Superseded on the pointer and overscan size (operator and boot test, 2026-11-04):** the default pointer is the real Workbench pointer (`STANDARD_POINTER`), not `mksysconfig.py`'s, and the button is `Standard pointer`, not Reset. Overscan size came out. The spec holds the final version; this plan is the record of how it was built.

**Spec:** `docs/superpowers/specs/2026-11-04-create-sysconf-design.md`. Research: `docs/superpowers/research/system-configuration/`.

## Global Constraints

- Always exactly 232 bytes, big-endian. Never a shorter file, under any path.
- Mouse speed stored only as 1, 2 or 4. 0 must be impossible (Intuition divides by it).
- Never commit ROMs or real Workbench files. The fixture comes from `mksysconfig.py`, which holds no Commodore data.
- Serial and printer settings are not shown. All hidden fields keep the template's bytes.
- Self-hosting has full parity: no dependency on our deployment. No migration.
- e2e: only touched specs, `PORT=3100` only (no BASE_URL), `--project=desktop`, serialised, each run under 9 minutes. No `git stash`. Stage explicit paths, never `git add -A`.
- Worktree setup: `pnpm install --offline`, copy `.env.local`, `npx next typegen`, symlink `adf-archive`.
- Work on a branch, `feat/create-sysconf`. Merging to master ships to production.

## Review Focus

1. A name clash after a person has drawn a pointer: answering it must not lose what they entered.
2. A hot spot at (15, 15): `XOffset` -16 and `YOffset` -15 as signed bytes, not wrapped wrongly.
3. An emptied or non-numeric field (`""`, `abc`, `1,5`): Create is unavailable with a reason, never a NaN in the file.
4. A server request with fractions, out-of-range values, a 15-row pointer or a bad ink: refused, and nothing is written.
5. A double click on Create, and a refused write such as a full disk: one request only, and the dialog stays open with its values.

---

### Task 1: The file format

**Files:**
- Create: `src/lib/files/sysconf.ts`, `src/lib/files/sysconf.test.ts`, `src/lib/files/sysconf.fixture.bin`
- Commit too: `docs/superpowers/specs/2026-11-04-create-sysconf-design.md`, `docs/superpowers/plans/2026-11-04-create-sysconf.md`, `docs/superpowers/research/system-configuration/`

**Interfaces:**
- Produces, from `@/lib/files/sysconf` (CLIENT-SAFE, no database or server imports):

```ts
export const SYSCONF_NAME = 'system-configuration';
export const SYSCONF_SIZE = 232;
export type Ink = '.' | 'R' | 'K' | 'W';   // clear, color17, color18, color19
export type SysconfSettings = {
  fontHeight: 8 | 9; interlace: boolean;
  viewX: number; viewY: number;              // overscan position, integers, -16..16
  extraRows: number; extraColumns: number;   // overscan size, integers, -64..64
  colors: [number, number, number, number];                                // 0..0xFFF
  pointerColors: [number, number, number];                                 // 0..0xFFF
  pointer: string[];                                                       // 16 strings of 16 Inks
  hotSpot: { x: number; y: number };                                       // integers, 0..15
  keyDelayUs: number;    // 20000..2000000
  keySpeedUs: number;    // 20000..1000000
  doubleClickUs: number; // 20000..10000000
  mouseTicks: 1 | 2 | 4; acceleration: boolean;
};
export function sysconfDefaults(): SysconfSettings;                        // a fresh copy each call
export const sysconfSchema: z.ZodType<SysconfSettings>;                    // every limit above
export function buildSysconf(s: SysconfSettings): Uint8Array;              // the 232 bytes
```

- [ ] **Step 1: Make the fixture and commit the design documents**

Run: `python3 docs/superpowers/research/system-configuration/mksysconfig.py src/lib/files/sysconf.fixture.bin && wc -c src/lib/files/sysconf.fixture.bin`
Expected: `232`.

```bash
git add docs/superpowers/specs/2026-11-04-create-sysconf-design.md docs/superpowers/plans/2026-11-04-create-sysconf.md docs/superpowers/research/system-configuration
git commit -m "Create SysConf: design, plan and the system-configuration research"
```

- [ ] **Step 2: Write the failing tests in `sysconf.test.ts`**

```ts
const fixture = new Uint8Array(readFileSync(new URL('./sysconf.fixture.bin', import.meta.url)));
const differing = (a: Uint8Array, b: Uint8Array) => [...a.keys()].filter((i) => a[i] !== b[i]);
const changed = (o: Partial<SysconfSettings>) =>
  differing(buildSysconf(sysconfDefaults()), buildSysconf({ ...sysconfDefaults(), ...o }));

it('the defaults are what mksysconfig.py writes, byte for byte', () => {
  expect(buildSysconf(sysconfDefaults())).toEqual(fixture);
});
it('is always 232 bytes', () => expect(buildSysconf({ ...sysconfDefaults(), fontHeight: 9 }).length).toBe(232));
it.each([
  [{ fontHeight: 9 }, [0]],
  [{ interlace: true }, [185]],
  [{ viewX: 3 }, [118]], [{ viewY: -3 }, [119]],
  [{ extraRows: 2 }, [216]], [{ extraColumns: -2 }, [217]],
  [{ mouseTicks: 4 }, [109]],
  [{ acceleration: true }, [124]],
  [{ keySpeedUs: 60000 }, [10, 11]],
  [{ doubleClickUs: 2020000 }, [23]],
])('%o changes only its own bytes', (o, at) => expect(changed(o as Partial<SysconfSettings>)).toEqual(at));
it('stores a colour at its word', () => {
  const b = buildSysconf({ ...sysconfDefaults(), colors: [0x123, 0, 0xFFF, 0x68B], pointerColors: [0xABC, 0, 0xEEC] });
  expect([...b.subarray(110, 112)]).toEqual([0x01, 0x23]);
  expect([...b.subarray(102, 104)]).toEqual([0x0A, 0xBC]);
});
it('splits a time into seconds and microseconds', () => {
  const b = buildSysconf({ ...sysconfDefaults(), keyDelayUs: 1500000 });
  const v = new DataView(b.buffer, b.byteOffset);
  expect([v.getUint32(12), v.getUint32(16)]).toEqual([1, 500000]);
});
it('stores a hot spot as a negative offset', () => {
  expect([...buildSysconf(sysconfDefaults()).subarray(100, 102)]).toEqual([0xFF, 0x00]);       // -1, 0: pixel (0, 0)
  expect([...buildSysconf({ ...sysconfDefaults(), hotSpot: { x: 15, y: 15 } }).subarray(100, 102)]).toEqual([0xF0, 0xF1]);   // -16, -15
});
it('draws a pointer into two bitplanes, between its control words', () => {
  const pointer = Array.from({ length: 16 }, () => '.'.repeat(16));
  pointer[0] = 'RKW' + '.'.repeat(13);
  const b = buildSysconf({ ...sysconfDefaults(), pointer });
  const v = new DataView(b.buffer, b.byteOffset);
  expect(v.getUint32(28)).toBe(0);                     // the control words
  expect(v.getUint16(32)).toBe(0b1010000000000000);    // plane 0: R, W
  expect(v.getUint16(34)).toBe(0b0110000000000000);    // plane 1: K, W
  expect(v.getUint32(96)).toBe(0);                     // the end words
});
it.each([
  ['a fraction', { viewX: 1.5 }], ['out of range', { viewX: 17 }], ['mouse speed 0', { mouseTicks: 0 }], ['mouse speed 3', { mouseTicks: 3 }],
  ['font 10', { fontHeight: 10 }], ['a short pointer', { pointer: Array(15).fill('.'.repeat(16)) }],
  ['a bad ink', { pointer: Array(16).fill('X'.repeat(16)) }], ['a colour too large', { colors: [0x1000, 0, 0, 0] }],
  ['a hot spot off the grid', { hotSpot: { x: 16, y: 0 } }], ['too fast a repeat', { keySpeedUs: 19999 }],
  ['a NaN', { keyDelayUs: NaN }], ['a string', { keyDelayUs: '600000' }],
])('the schema refuses %s', (_w, o) => expect(sysconfSchema.safeParse({ ...sysconfDefaults(), ...o }).success).toBe(false));
it('the schema takes the defaults', () => expect(sysconfSchema.safeParse(sysconfDefaults()).success).toBe(true));
```

- [ ] **Step 3: Run it**

Run: `npx vitest run src/lib/files/sysconf.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 4: Implement `sysconf.ts`**

The template is the fixture as a base64 constant in the module (the file must work in the browser and in a standalone server, so no file reads); `buildSysconf` copies it and pokes only the fields in the spec's table. Default pointer rows: copy `POINTER` from `mksysconfig.py`. Default values: the spec's dialog table. Inks: `.` = (0,0), `R` = (1,0), `K` = (0,1), `W` = (1,1) as (plane0, plane1). Hot spot: `XOffset = -x - 1`, `YOffset = -y`, offsets 100 and 101. Mouse speed: big-endian word at 108. Acceleration: bit 15 of the word at 124, leaving the template's other bits alone. Interlace: bit 0 of byte 185. Time fields: seconds then microseconds, big-endian longs, at 4 (speed), 12 (delay), 20 (double-click).

- [ ] **Step 5: Run it**

Run: `npx vitest run src/lib/files/sysconf.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/files/sysconf.ts src/lib/files/sysconf.test.ts src/lib/files/sysconf.fixture.bin
git commit -m "Create SysConf: the 232-byte file from named settings"
```

### Task 2: The server op

**Files:**
- Create: `src/lib/files/create-sysconf.ts`, `src/lib/files/create-sysconf.db.test.ts`
- Modify: `src/lib/files/ops.ts:18,35,123`, `src/app/api/files/ops/route.ts:12-22`, `src/lib/files/shelf-rules.ts`

**Interfaces:**
- Consumes: Task 1's `sysconfSchema`, `buildSysconf`, `SYSCONF_NAME`.
- Produces:

```ts
// src/lib/files/shelf-rules.ts, client-safe
export const SYSCONF_ON_SHELF = 'Open a disk, STASH: or an Amiga volume to make it there';
// src/lib/files/create-sysconf.ts, SERVER ONLY
export type CreateSysconfRequest = { dest: string; settings: unknown; onClash: OnClash };
export async function createSysconf(ctx: OpCtx, req: CreateSysconfRequest): Promise<Outcome>;
// src/lib/files/ops.ts: OpRequest gains
| ({ op: 'create-sysconf' } & CreateSysconfRequest)
```

- [ ] **Step 1: Write the failing test `create-sysconf.db.test.ts`** (setup as in `create-adf.db.test.ts:20-38`)

```ts
const make = (dest: string, o: { settings?: unknown; onClash?: OnClash } = {}) =>
  runOp(ctx, { op: 'create-sysconf', dest, settings: o.settings ?? sysconfDefaults(), onClash: o.onClash ?? 'ask' });

it('writes the 232 bytes into a STASH: folder', async () => {
  expect(await make('STASH:/Boot')).toMatchObject({ kind: 'done', items: [{ ok: true }] });
  const f = (await stashDriver.read(ctx, P('STASH:/Boot/system-configuration')))!;
  expect(f.bytes).toEqual(buildSysconf(sysconfDefaults()));
});
it('writes into a Devs drawer on a writable disk, and the disk still reads', async () => { /* a seeded blank disk: Makedir Devs, make, read back 232 bytes */ });
it('a clash follows the setting', async () => {
  await make('STASH:/Clash');
  expect(await make('STASH:/Clash')).toMatchObject({ kind: 'clashes', clashes: [{ name: 'system-configuration' }] });
  expect(await make('STASH:/Clash', { onClash: 'skip' })).toMatchObject({ kind: 'done', items: [{ ok: true, skipped: true }] });
  expect(await make('STASH:/Clash', { onClash: 'replace', settings: { ...sysconfDefaults(), fontHeight: 9 } })).toMatchObject({ kind: 'done' });
  expect((await stashDriver.read(ctx, P('STASH:/Clash/system-configuration')))!.bytes[0]).toBe(9);
});
it.each([[{ mouseTicks: 0 }], [{ viewX: 1.5 }], [{ pointer: [] }]])('refuses bad settings %o and writes nothing', async (o) => {
  expect(await make('STASH:/Bad', { settings: { ...sysconfDefaults(), ...o } })).toMatchObject({ kind: 'refused', status: 400 });
  expect((await listStash(getDb(), 'o1')).some((x) => x.path === 'Bad/system-configuration')).toBe(false);
});
it('refuses settings that are not an object', async () => {
  expect(await make('STASH:', { settings: 'nope' })).toMatchObject({ kind: 'refused', status: 400 });
});
it('refuses LIBRARY: shelves with the words', async () => {
  expect(await make('LIBRARY:')).toMatchObject({ kind: 'refused', refusal: { detail: SYSCONF_ON_SHELF } });
});
it('refuses an unknown path', async () => expect(await make('NOPE:')).toMatchObject({ kind: 'refused', status: 404 }));
```

Add a NET: case to `net-driver.db.test.ts` using its existing fixtures: a create onto a writable volume answers done with a `job`, and onto a read-only one is refused.

- [ ] **Step 2: Run it**

Run: `TEST_DATABASE_URL=$(bash scripts/dev-db.sh url) npx vitest run -c vitest.db.config.mts src/lib/files/create-sysconf.db.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`createSysconf`: `sysconfSchema.safeParse(req.settings)`, on failure `refuse('unsupported', 400, 'Those settings are not valid')`. Then `parsePath`, 404 as in `create-adf.ts`; `shelfDest(ctx, p)` (export it if it is local to `ops.ts`, as `makedir` uses it) refuses `unsupported`, 400, `SYSCONF_ON_SHELF`. Then call the place's write as `need(d, 'write')`, with one top: `{ source: SYSCONF_NAME, items: [{ rel: [SYSCONF_NAME], kind: 'file', bytes, date: new Date(), protection: 0, comment: null }] }`, and return its `Outcome` unchanged (so `versions` and `job` reach the client). In the route: `z.object({ op: z.literal('create-sysconf'), dest: path, settings: z.unknown(), onClash: z.enum(['ask', 'replace', 'skip', 'keep-both']) })`; the engine is the one gate for the settings, so `runOp` called directly is covered too.

- [ ] **Step 4: Run it**

Run the Step 2 command, and `TEST_DATABASE_URL=$(bash scripts/dev-db.sh url) npx vitest run -c vitest.db.config.mts src/lib/files/net-driver.db.test.ts`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/create-sysconf.ts src/lib/files/create-sysconf.db.test.ts src/lib/files/net-driver.db.test.ts src/lib/files/ops.ts src/lib/files/shelf-rules.ts src/app/api/files/ops/route.ts
git commit -m "Create SysConf: the create-sysconf op, validated on the server"
```

### Task 3: The dialog and the pointer editor

**Files:**
- Create: `src/components/files/sysconf-dialog.tsx`, `src/components/files/sysconf-dialog.test.ts`, `src/components/files/pointer-editor.tsx`

**Interfaces:**
- Consumes: Task 1's types, `sysconfDefaults`, `sysconfSchema`, `SYSCONF_SIZE`.
- Produces:

```ts
// sysconf-dialog.tsx
export type SysconfDraft = Omit<SysconfSettings, 'keyDelayUs' | 'keySpeedUs' | 'doubleClickUs'> & {
  keyDelay: string; keySpeed: string; doubleClick: string;   // seconds, as typed: "0.60"
};
export function draftOf(s: SysconfSettings): SysconfDraft;
/** The settings, or the words saying the first thing wrong. */
export function settingsOf(d: SysconfDraft): { settings: SysconfSettings } | { problem: string };
export function SysconfDialog(p: {
  where: string; busy: boolean; clash: boolean;          // clash: this place already has the file
  onCreate(s: SysconfSettings): void; onClash(c: 'replace' | 'keep-both' | 'skip', s: SysconfSettings): void;
  onBack(): void; onCancel(): void;
}): JSX.Element;
// pointer-editor.tsx
export function PointerEditor(p: {
  pointer: string[]; hotSpot: { x: number; y: number }; colors: [number, number, number];
  onChange(next: { pointer: string[]; hotSpot: { x: number; y: number } }): void;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing test `sysconf-dialog.test.ts`** (style as `create-adf-dialog.test.ts`)

```ts
it('the defaults round-trip through the draft', () => {
  expect(settingsOf(draftOf(sysconfDefaults()))).toEqual({ settings: sysconfDefaults() });
});
it('shows seconds to two places', () => expect(draftOf(sysconfDefaults()).keyDelay).toBe('0.60'));
it('reads typed seconds as whole microseconds', () => {
  const r = settingsOf({ ...draftOf(sysconfDefaults()), keyDelay: '1.5' });
  expect('settings' in r && r.settings.keyDelayUs).toBe(1500000);
  const f = settingsOf({ ...draftOf(sysconfDefaults()), keySpeed: '0.07' });
  expect('settings' in f && f.settings.keySpeedUs).toBe(70000);      // never 70000.00000000001
});
it.each(['', 'abc', '1,5', '-1', 'Infinity', '0.01', '3'])('a key delay of %j has a problem naming the field', (v) => {
  const r = settingsOf({ ...draftOf(sysconfDefaults()), keyDelay: v });
  expect('problem' in r && r.problem).toMatch(/Key repeat delay/);
});
it('a display position out of range has a problem', () => {
  expect(settingsOf({ ...draftOf(sysconfDefaults()), viewX: 17 })).toHaveProperty('problem');
});
it('renders every group and the size, with no serial or printer words', () => {
  const html = renderToStaticMarkup(createElement(SysconfDialog, props));
  for (const w of ['Display', 'Workbench colours', 'Pointer', 'Keyboard and mouse', '232 bytes', 'read at boot only', 'Devs']) expect(html).toContain(w);
  expect(html).not.toMatch(/serial|printer|baud/i);
});
it('the clash state offers Replace, Keep both and Skip', () => {
  const html = renderToStaticMarkup(createElement(SysconfDialog, { ...props, clash: true }));
  for (const t of ['files-sysconf-replace', 'files-sysconf-keep-both', 'files-sysconf-skip']) expect(html).toContain(t);
});
```

If Base UI's portal makes the Modal render nothing in `renderToStaticMarkup`, split the body into an exported `SysconfForm` and render that, as other dialog tests here do.

- [ ] **Step 2: Run it**

Run: `npx vitest run src/components/files/sysconf-dialog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Modal: `Modal` with `finalFocus={managerReturnsFocus}`, `dismissible={!busy}`, testId `files-sysconf`, close `files-sysconf-close`, submit `files-sysconf-submit`, width 560, title `Create SysConf`, subtitle `` `In ${where}` ``. Follow the spec's dialog table, its Words section and the approved mock-up's order. Draft state lives in the dialog and survives `clash` turning on and off. The problem shows beside the footer with `role="alert"`, testid `files-sysconf-problem`, and disables Create. Footer's left: `232 bytes`. Use `SegRadioGroup` for font and mouse speed. Colour control: `<input type="color">` mapped to 12-bit (each channel rounded to 4 bits); tests pin the mapping if it is a helper. In the clash state the footer becomes the words `system-configuration is already here` with Replace, Keep both, Skip and Back, with Replace named plainly so it reads as overwriting a file.

Pointer editor: a `role="grid"` of 256 cells, `touch-action: none`, ink picker of four buttons plus a `Hot spot` tool, Clear, Reset. Pointer events paint on press and drag (`setPointerCapture`, then find the cell from coordinates). Arrow keys move a roving cell, Space paints or sets the hot spot. Cells at least 14 px on desktop; below `sm` they fill the width so a finger can hit them. Testids: `pointer-cell-<x>-<y>`, `pointer-ink-<clear|1|2|3>`, `pointer-hotspot`, `pointer-clear`, `pointer-reset`.

- [ ] **Step 4: Run it**

Run: `npx vitest run src/components/files/sysconf-dialog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/files/sysconf-dialog.tsx src/components/files/sysconf-dialog.test.ts src/components/files/pointer-editor.tsx
git commit -m "Create SysConf: the dialog and the pointer editor"
```

### Task 4: The bank, the wiring and the words

**Files:**
- Modify: `src/lib/files/bank.ts`, `src/lib/files/bank.test.ts`, `src/components/files/button-bank.test.ts`, `src/components/files/files-manager.tsx` (`Dialog` union near 138, `reasons` near 792, `bankReasons` near 802, `act` 1128-1152, `bank` 1302, More menu 1786, dialogs near 1833), `src/lib/help/topics.tsx:29,103,115` and their comment lines, `e2e/disk-files-layout.spec.ts:162`, `e2e/files-2.spec.ts:163-205`
- Create: `e2e/files-sysconf.spec.ts`

**Interfaces:**
- Consumes: Task 2's `create-sysconf` op and `SYSCONF_ON_SHELF`; Task 3's `SysconfDialog`.
- Produces: `BankCommand` loses `'filter'` and gains `'createsysconf'`, labelled `Create SysConf…`, at the same grid position; test id `files-createsysconf`; More menu test id `files-more-createsysconf`.

- [ ] **Step 1: Write the failing e2e `e2e/files-sysconf.spec.ts`** (helpers as in `e2e/files-2.spec.ts`)

```ts
test('the button replaces Filter…, and the filter field and / still work', ...);
  // the grid has no Filter…; has Create SysConf…; typing in pane-right-filter narrows rows; '/' focuses it
test('creates the file in STASH: and it is 232 bytes', ...);
  // click, dialog shows, Create; row system-configuration shows, selected, its size reads 232
test('creates in a drawer on a disk', ...);
  // a seeded disk, into a folder; the row appears; the file downloads as 232 bytes with byte 0 = 9 after choosing Topaz 9
test('a clash keeps the drawn pointer', ...);
  // onClash setting Ask; create once; again: draw a cell, Create; the clash state; Back; the cell is still painted;
  // Create, Replace; the downloaded bytes hold the painted pixel
test('a bad value disables Create with the reason, and fixing it enables it', ...);
test('shelves and archives say why', ...);
  // LIBRARY: root and a title: aria-disabled, the toast says SYSCONF_ON_SHELF; an archive's read-only words
test('a double click on Create sends one request', ...);
  // count POST /api/files/ops with op create-sysconf: 1
test('on a phone it is in More, and the grid can be painted', ...);   // the phone project or a phone viewport
```

- [ ] **Step 2: Run it**

Run: `PORT=3100 npx playwright test e2e/files-sysconf.spec.ts --project=desktop`
Expected: FAIL.

- [ ] **Step 3: Implement**

`bank.ts`: as in Interfaces, and fix its test. Manager: `createsysconf: shelf ? SYSCONF_ON_SHELF : reasons.makedir`, added to `reasons` and `bankReasons`; remove `case 'filter'` (leave `filterRefs`, used by `find`); add `'createsysconf'` to `act`: `guarded([src?.disk], () => setDialog({ kind: 'sysconf', side, clash: false }))`. New function beside `createDisk`:

```ts
async function createSysconf(side: Side, settings: SysconfSettings, onClash: OnClash)
```

It posts `{ op: 'create-sysconf', dest: l.path, settings, onClash }` with the label `Creating the file…`. `clashes` sets `clash: true` on the dialog and keeps it open. A refusal keeps the dialog open: `post` has already said why. An item with `!ok` keeps it open and toasts the words, as `createDisk` does. Done closes the dialog; `r.job` goes to `watchFetch(r.job, '')` as `runFromDialog` does; otherwise a toast `Made system-configuration in <place>.`, or `skippedWords(1)`, passing `r.versions` so a disk write gets its Undo as `report` does; `load(side, l.path, { select: made.source })`, and reload the other pane when it shows the same path. Use the `createOnce` guard so a double click sends once. First press uses `prefs.files.onClash`. Dialog `where`: as `CreateAdfDialog`'s. Help: add `Create SysConf…` beside Create ADF with one or two sentences, what it makes and that it goes in `Devs` on the boot disk; remove any `Filter…` mention; `Type in a filter box` stays. Update the two e2e specs: the label list, and drop the part of `files-2` that clicks `Filter…`, keeping its filter-box assertions with a direct focus.

- [ ] **Step 4: Run the affected tests**

Run: `npx vitest run src/lib/files src/components/files src/lib/help && npx tsc --noEmit && pnpm lint`
Then, serialised: `PORT=3100 npx playwright test e2e/files-sysconf.spec.ts e2e/files-2.spec.ts e2e/disk-files-layout.spec.ts --project=desktop`
Expected: PASS. Split the Playwright run if it nears 9 minutes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/bank.ts src/lib/files/bank.test.ts src/components/files/button-bank.test.ts src/components/files/files-manager.tsx src/lib/help/topics.tsx e2e/files-sysconf.spec.ts e2e/disk-files-layout.spec.ts e2e/files-2.spec.ts
git commit -m "Create SysConf: replaces Filter… in the bank; the phone's More menu, help and e2e"
```

### Task 5: The boot test and the wrap-up (controller, not a subagent)

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/research/system-configuration/README.md`, and the dialog, if a setting fails.

- [ ] **Step 1: Local byte check, not committed**

Compare the defaults' bytes with `~/Downloads/workbench-3.2-adf/Workbench3.2.adf`'s `Devs/system-configuration`.
Expected: differences only at 28-99, the pointer image, plus whatever `mksysconfig.py` already differs by; report them.

- [ ] **Step 2: Emulator boot test**

In a scratchpad, with `xdftool`, copy each local Workbench disk (never committed) and give it a startup with no IPrefs: `LoadWB`, `EndCLI`. Put in `Devs/system-configuration` a file made by `buildSysconf` that changes every setting visibly: Topaz 9 against the disk's 8, interlace, four unusual colours, an odd pointer and colours, hot spot (8, 8), overscan position and size. Boot on Kickstart 2.04, 3.1, 3.1.4 and 3.2 with FS-UAE, driven and captured as `tools/receive/uae/uae-test.sh` does, stopping only the PID it started. Screenshot each, compare with a boot of the defaults.
Expected: every visible setting takes effect on each. Hot spot checked by clicking a small gadget with the pointer's centre.

- [ ] **Step 3: A full Workbench**

Boot one unchanged Workbench with IPrefs and saved prefs and the same file. Report which values IPrefs replaces. Update the dialog's sentence if it is wrong.

- [ ] **Step 4: Ask the operator for the A500**

Last thing in a turn: ask for it to be on. Boot the disk through the board. Ask the operator to judge key repeat, double-click, mouse speed and acceleration by hand. Report anything not tried as read from the code only.

- [ ] **Step 5: Act on the result**

Anything that does not take effect comes out of the dialog (and its schema field stays at the template's value), and is reported to the operator. Re-run Task 1 and Task 4's tests.

- [ ] **Step 6: Record**

Update `HANDOFF.md` §4 and its Current order; answer the research README's questions or point them at the spec. Save a memory: Create SysConf shipped, what was proven, the one-shot fields, `PointerTicks` as a divisor.

- [ ] **Step 7: After merge**

Ask the operator about the self-host sync, per the standing rule. Do not tag without asking.
