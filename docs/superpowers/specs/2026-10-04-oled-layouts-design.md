# OLED panel type and per-board layouts — design

Status: approved in conversation 2026-10-04, section by section. The written spec awaits operator review.
Firmware target: 1.7.0.

## 1. What this is for

Each board's owner can personalise its OLED from the web app: **free placement** of the panel's elements on a
pixel-accurate preview, with show/hide and 1×/2× size. The **panel type is chosen per board**: today's 128×32 0.91",
or a 128×64 0.92" (operator has one).

Done means:
- On a 128×32 board running 1.7.0 with no saved layout, the panel looks exactly as it does on 1.6.5.
- Choosing 128×64 with that panel fitted draws the whole panel.
- A layout saved in the editor appears on the board within one poll, and survives a reboot.
- A layout the board rejects never changes what the panel shows, and the editor says why.

## 2. Decisions

| Decision | By |
|---|---|
| Per-board personalisation is the purpose | operator, 2026-10-04 |
| Free placement: drag anywhere, show/hide, 1×/2× | operator |
| The layout controls the running screens only (ready, downloading, mounted). Boot, portal, connecting and error stay built-in, so a board can always be set up and diagnosed | operator, recommended |
| The editor's preview runs the board's own renderer compiled to WebAssembly: pixel-identical by construction, one source | operator ("definitely the best option") |
| Stored per board on the server and announced through the poll with a version cursor | this design (sections 2-4 approved) |
| v1 elements are only those the panel draws today; no new fonts; SSD1306 only | this design |

## 3. What exists today (read 2026-10-04, master `2c9c3a2`)

**`src/display.c` / `display.h`:**
- The renderer is pure C, host-tested (`test/test_display.c`): `display_render(state, fb)`, fixed at
  `DISP_W 128`, `DISP_H 32`.
- One 5×7 font (6-px advance, 8-px line).
- Glyphs: WiFi (`WIFI_W` 11×8), write state (cloud ×3 / padlock, `PENCIL_W` 8×8), lemming (`LEM_W` 8×8, 2 frames).
- Positions are hard-coded in `display_render`.
- `display_state_t` carries status, bars, title, detail, show_track/cyl/max_cyl, pct, tick, writable and sync.
- `display_pump` pushes dirty bytes through a blit callback.

**`src/ssd1306.c`:**
- `HEIGHT 32`, multiplex `HEIGHT-1`, COM pins `0x02` (sequential, the 128×32 wiring); 128×64 needs `0x12`.
- Memory: a wrong-height init draws partially instead of failing.

**`src/config_store.c`:**
- Holds WiFi credentials.
- **Refuses to save while a disk is mounted** (a flash erase stalls XIP while core0 serves the bus).
- **Erases the device token on a successful save.**
- It is therefore NOT a place for display data.

**Device protocol:**
- `GET /api/device/poll` (desired state, cursors).
- `POST /api/device/status` reports capabilities such as `playsHd` and `trackMaxBytes` (`src/app/api/device/status/route.ts`).
- Device routes live under `src/app/api/device/`.

## 4. Elements

Ids are fixed forever; new elements get new ids.

| id | Element | Size at 1× (w×h) | `w` field | `opt` field |
|---|---|---|---|---|
| 1 | Status word | its text, 6 px per character × 8 | 0 = natural | — |
| 2 | WiFi bars | 11×8 | 0 | — |
| 3 | Write state (cloud/padlock, with sync) | 8×8 | 0 | — |
| 4 | Title | `w` × (8 × lines) | box width, ≥ 12 | lines: 1 or 2 |
| 5 | Detail line | `w` × 8 | box width, ≥ 12 | — |
| 6 | Track counter | its text × 8 | 0 = natural | 0 = number |
| 7 | Download | `w` × 8 | bar width (0 = percent only, else ≥ 8) | — |
| 8 | Lemming | 8×8 | 0 | — |

**2× sizing:** every pixel is doubled, so width, height and box width all double.

**Text in a box** (title, detail) is truncated with an ellipsis, as today. Elements that don't apply in a state draw
nothing in that state: the track counter while nothing is mounted, download outside downloading.

**Drawing order** is the list order, and overlaps are allowed.

## 5. The layout blob (one format, one validator in C)

```
header, 4 bytes:  [0] format = 1   [1] panel: 0 = 128x32, 1 = 128x64   [2] n = element count (0..16)   [3] 0
record, 8 bytes each (n of them):
  [0] element id (1..8)
  [1] flags: bit0 visible, bit1 2x; all other bits 0
  [2] x   [3] y   (top-left, pixels)
  [4] w   (see §4)
  [5] opt (see §4)
  [6] 0   [7] 0   (reserved)
```

The maximum is 4 + 16 × 8 = 132 bytes.

**`display_layout.c`** (new, pure C, host-tested; compiled into the firmware AND the WebAssembly module):
- `bool layout_decode(const uint8_t *buf, size_t len, layout_t *out, char *why, size_t why_len)`. It rejects, with
  a reason, any of the following:
  - a wrong length for `n`;
  - an unknown format, panel or element id;
  - a duplicate id;
  - nonzero reserved bits or bytes;
  - `w`/`opt` outside §4's rules;
  - any element, at its size, extending past the panel (x + w > 128, y + h > 32 or 64).
- `layout_default(panel)`: the built-in defaults as `const` tables.
  - The **128×32 default reproduces today's positions exactly**.
  - The **128×64 default**:
    - the status row at the top as today (WiFi, status word, write state, lemming);
    - the title at 2×, one line, full width;
    - the detail line;
    - the track counter at 2× bottom-right;
    - download as a full-width bar.

**The web app encodes, and never validates on its own.** `src/lib/display-layout.ts` turns the editor's JSON
(`{ panel, elements: [{ id, visible, scale, x, y, w, opt }] }`) into the blob. The server validates the blob by
calling the WebAssembly `layout_decode`.

**Golden files** (`wifi-floppy/firmware/test/fixtures/layouts/*.{json,bin}`) are checked by both the C and the
TypeScript tests. TypeScript must encode each JSON to exactly its `.bin`, and C must decode each `.bin` to the
expected layout or the expected rejection.

## 6. Firmware (1.7.0)

**Renderer:**
- `display_render(state, layout, fb)` draws each visible element of the layout, in order, at its position and
  scale.
- The panel size comes from the layout (`layout.panel`). The framebuffer is sized for 128×64
  (`DISP_FB_MAX` = 1024 bytes); a 128×32 panel uses its first 4 pages.
- The built-in screens (boot, portal, connecting, error) keep their hand-coded drawing, adapted to the panel height:
  on 128×64 the same content is centred vertically.
- 2× draws each glyph or bitmap pixel as a 2×2 block.

**Golden framebuffers:**
- Before the refactor, `test_display.c` captures the current 128×32 framebuffer for a fixed set of states:
  - boot, portal, connecting, ready;
  - downloading at 0, 64 and 100 %;
  - mounted writable, read-only, and each sync state;
  - a long title, an empty title, and track 0, 79 and 80.
- After the refactor, rendering those states with `layout_default(128x32)` must match byte for byte.

**Panel driver:** `ssd1306_init(addr, panel)` sets the multiplex ratio (31/63), COM pins (`0x02`/`0x12`) and page
count from the panel. `display_set_panel()` re-initialises in place when the panel changes (no reboot), clears, and
marks every byte dirty. The self-test frame and the pump follow the height.

**Persistence (`display_store.c`, new):**
- Its own flash sector, next to the config and token sectors, holding magic, version, CRC, panel and the blob.
- **Written only while no disk is mounted**, the same reason as `config_store`. A new layout applies at once from
  RAM, and the write is deferred to the first moment the drive is empty.
- Loaded at boot before the first frame. Nothing stored, or a bad CRC, means the 128×32 default.
- It never touches the config or token sectors.

**Protocol:**
- The poll answer gains `displayVersion` (int).
- When it is greater than the applied version, core1 calls a new device-authenticated `GET /api/device/display`,
  which returns `{ version, panel, layout: <base64 blob or null for default> }`.
- core1 decodes and validates. On success it hands the layout to core0, through a double buffer plus a sequence
  number, so core0 never renders a half-written layout. On failure it keeps the current one.
- `POST /api/device/status` gains:
  - `displayLayouts: 1` (capability);
  - `displayVersion` (the version applied);
  - `displayError` (a short reason or null).

## 7. Server and web app

**Migration 0030 (additive):** on `devices`:
- `display_panel` text, default `'128x32'`;
- `display_layout` bytea, nullable (null = default);
- `display_version` integer, default 0;
- `display_applied_version` integer, nullable;
- `display_error` text, nullable;
- `display_layouts` boolean, nullable (the capability).

**API:**
- `PATCH /api/devices/[id]/display`, org-scoped like every device route:
  - body `{ panel, elements }` (zod);
  - encode, then validate through WebAssembly. 400 `{ error: 'invalid_layout', reason }` names the rule.
  - If the board has not reported `display_layouts`: 409 `{ error: 'firmware_too_old' }`, reason "Needs firmware
    1.7.0 or newer".
  - Otherwise store, `display_version += 1`, 200 `{ version }`.
  - `{ reset: true }` clears the layout (back to default) and also raises the version.
- `GET /api/device/display` (device auth): `{ version, panel, layout }`.
- The poll adds `displayVersion`; the status route stores applied/error/capability. The live device state carries
  them, so the editor updates without a reload.

**Editor** (`src/components/devices/display-editor.tsx`, under each board on Devices → "Display"):
- Panel select.
- A canvas at 4× zoom drawn by the WebAssembly renderer from `(state, layout)`.
- Pointer-event drag (mouse and touch) with 1 px moves, optional 8 px snap, clamped to the panel.
- A side list: show/hide, 1×/2×, box width and lines where they apply.
- "Preview as": Ready, Downloading 64 %, Mounted writable, Mounted read-only, Long title.
- Overlapping elements are outlined.
- Reset to default; Save.
- Status line, showing both values:
  - "Applied on the board" / "Waiting for the board" / "The board rejected it: \<reason\>";
  - "Needs firmware 1.7.0 or newer" for boards without the capability.

**WebAssembly build:**
- `wifi-floppy/firmware/wasm/` with a CMake (or plain clang) target using wasi-sdk, from `display.c`,
  `display_layout.c` and the font, exporting render, decode and defaults.
- `pnpm display:wasm` writes `public/display.wasm` and `src/lib/display-wasm.version` (a hash of the C sources).
- A host-test check fails when the committed hash does not match the sources, so a stale preview cannot ship.

## 8. Testing

- **Firmware host tests:**
  - golden framebuffers (§6);
  - one validator case per rejection rule;
  - decoder robustness (truncated, too long, garbage, n = 0, n = 16);
  - 2× rendering;
  - 128×64 bounds and defaults;
  - `display_store` load and save (magic, CRC, deferred while mounted).
- **Cross-language:** the golden layout fixtures (§5).
- **WebAssembly:** the staleness check (§7). A web unit test renders a default layout through the module and
  compares it with the C golden framebuffer.
- **Web:**
  - unit tests for the encoder and API validation;
  - e2e: open the editor, drag the title, save, and `display_version` rises. A simulated board GETs the layout and
    reports it applied, and the editor shows "Applied". Also an invalid layout is refused with its reason, and an old
    board shows "Needs firmware 1.7.0".
  - The full e2e suite runs before merging.
- **Bench (operator):**
  1. 128×32 is unchanged on 1.7.0.
  2. 128×64 with the 0.92" panel: the full panel draws.
  3. A custom layout saved in the editor appears within one poll and survives a reboot.
  4. A forced-invalid layout leaves the panel as it was, and the editor shows the reason.

## 9. Out of scope (v1)

- New element types (next disk, clock, IP, RSSI number).
- Panels other than SSD1306 128×32/128×64 (SH1106's 132-column offset, SPI panels).
- Custom fonts.
- Layouts for the built-in screens.
- Per-state layouts.
- Sharing layouts between boards (copying one board's layout to another is a later convenience).
