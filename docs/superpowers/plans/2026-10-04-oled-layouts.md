# OLED panel type and per-board layouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each board's OLED panel type (128×32 or 128×64) and its running-screen layout can be chosen from the web
app, with free placement on a pixel-exact preview that runs the board's own renderer compiled to WebAssembly.

**Architecture:** One C module, `display_layout.c`, holds the element model, the blob decoder/validator and the
default layouts. It is compiled into the firmware and into a WebAssembly module (`public/display.wasm`) that the web
app uses for the editor preview and server-side validation. The renderer becomes layout-driven, and the panel driver
is parameterised by height. A layout reaches the board through a poll cursor (`displayAck`/`displayVersion`) and a
binary device endpoint. The board stores it in its own flash sector, written only while no disk is mounted.

**Tech Stack:** C11 + pico-sdk 2.3.0 (RP2350), host tests under clang (`wifi-floppy/firmware/test/run.sh`);
Homebrew LLVM 23 + lld + wasi-runtimes for wasm32-wasip1; Next.js (this repo's version — read
`node_modules/next/dist/docs/` before touching routes), Drizzle/Neon, zod, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-oled-layouts-design.md`

## Global Constraints

- Firmware version for this feature: **1.7.0**. The bump happens only in Task 11.
- Panels: `0` = 128×32, `1` = 128×64, both SSD1306 at I2C 0x3c. The 128×64 init uses multiplex 63 and COM pins
  `0x12`; the 128×32 init uses multiplex 31 and COM pins `0x02`.
- **Blob format (verbatim from spec §5):**
  - header `[0] format=1 [1] panel [2] n (0..16) [3] 0`;
  - records of 8 bytes `[0] id 1..8 [1] flags (bit0 visible, bit1 2x, rest 0) [2] x [3] y [4] w [5] opt [6] 0 [7] 0`;
  - maximum 132 bytes.
- **Element ids** (fixed forever): 1 status, 2 wifi, 3 write state, 4 title, 5 detail, 6 track, 7 download, 8 lemming.
- **Fixed sizes at 1× (w × h):**
  - status 48×8 (`STATUS_MAX_CHARS` 8 × 6);
  - wifi 11×8, write 8×8, lemming 8×8;
  - title `w` × (8 × lines);
  - detail `w`×8;
  - track 30×8 (`TRACK_MAX_CHARS` 5 × 6);
  - download `(w ? w + 2 : 0) + 24` × 8 (`PCT_MAX_CHARS` 4 × 6).

  2× doubles all of them.
- **Field rules:**
  - title `w` ≥ 12, lines 1..2;
  - detail `w` ≥ 12;
  - download `w` = 0 or ≥ 8;
  - every other element `w` = 0 and `opt` = 0;
  - track `opt` = 0.
- **The 128×32 default reproduces today's (1.6.5) pixels exactly**, for every state in the golden set (Task 1).
- **Which layout draws which state (ruling, refining spec §6's "built-in screens"):**
  - `DS_READY`, `DS_DOWNLOAD`, `DS_VERIFY` and `DS_LOADED` render with the board's layout.
  - `DS_BOOT`, `DS_PORTAL`, `DS_WIFI` and `DS_ERROR` always render with `layout_default(panel)`.

  Today's renderer is one layout for every state, so "built-in" means "the panel's default".
- **The device endpoint is binary (ruling, refining spec §6's JSON; no base64 on the board).**
  `GET /api/device/display` → `application/octet-stream`:
  `[u32 big-endian version][u8 panel][u8 has_layout][blob if has_layout]`.
- **The display cursor (ruling):**
  - The board sends `&displayAck=<n>` on every poll: the highest display version it has HANDLED, applied OR
    rejected.
  - The server wakes the hold when `display_version > displayAck` and puts `displayVersion` in the body.
  - A rejected layout still advances the ack, so it can never loop. The reason goes to `displayError`.
  - A board without `displayAck` is never woken for display.
- Display flash record: its own sector at `PICO_FLASH_SIZE_BYTES - 3 * FLASH_SECTOR_SIZE`.
  - Read through `XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE`, never `XIP_BASE` (run.sh guard).
  - Written with `flash_safe_execute`, **only while no disk is mounted**.
  - Never touches the config or token sectors.
- Host build: `cc -std=c11 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1`. Every new device-only `.c` is added to
  run.sh's exclusion list. Pure `.c` files are picked up by the glob.
- Device build, from the repo root:
  `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"; pnpm firmware:build`
  (leave PORTAL_AP_PASSWORD unset).
- **WebAssembly build (proven 2026-10-04):**
  `PATH="$(brew --prefix lld)/bin:$PATH" $(brew --prefix llvm)/bin/clang --target=wasm32-unknown-wasip1 -O2 -mexec-model=reactor ...`.
  The module imports a few WASI functions it never calls; JavaScript stubs them with a no-op proxy.
- e2e: the dev server is started by you on **PORT=3100** (`PORT=3100 BETTER_AUTH_URL=http://localhost:3100 pnpm dev --port 3100`).
  - e2e runs share the live database: never run two at once.
  - Never `pkill` by pattern; stop only your own PIDs.
  - Never background a test command and poll it: split long runs into foreground runs under 9 minutes.
- **Never `git stash`, in any form, for any reason.** Use `git show <sha>:<path>` instead.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the attribution your own session
  names).

## Review Focus

1. **A swap downloading while a disk is mounted.** `show_track` and `DS_DOWNLOAD` are both true. Expected: where the
   track and download boxes overlap, the track counter wins and the download is not drawn, exactly as today.
   Pinned by a golden state in Task 1 and `test_track_wins_overlap_with_download` in Task 3.
2. **A layout saved while a disk is mounted.** Expected:
   - it applies at once from RAM;
   - the flash write waits until the drive is empty;
   - a reboot before then shows the stored (older) layout, and the board re-fetches it on the first poll, because
     the stored ack is the older version.

   Pinned by `test_store_write_waits_for_an_empty_drive` and `test_reboot_before_write_refetches` in Task 5.
3. **A layout the board rejects.** Expected: the panel is unchanged, `displayError` is set, the ack still advances,
   and the poll does not wake again for it. Pinned by `test_rejected_layout_still_acks` in Task 6 and the route test
   in Task 8.
4. **A board on older firmware.** Expected: no `displayAck` is sent, so the poll never wakes for display; the editor
   PATCH answers 409 `firmware_too_old` with "Needs firmware 1.7.0 or newer". Pinned in Task 8's route tests and
   Task 10's e2e.
5. **Switching panel 128×32 ↔ 128×64 while running.** Expected: re-initialised in place, the whole framebuffer resent
   (no stale half-panel), with nothing drawn below row 32 on a 32-row panel. Pinned by
   `test_panel_change_resends_every_page` in Task 4.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `wifi-floppy/firmware/test/fixtures/display_golden/*.fb` | today's 128×32 framebuffers, one per golden state | 1 |
| `wifi-floppy/firmware/test/test_display_golden.c` | renders the golden states and compares them | 1, 3 |
| `wifi-floppy/firmware/src/display_layout.h/.c` | element model, decode/validate, defaults (pure) | 2 |
| `wifi-floppy/firmware/test/test_display_layout.c` | validator, decoder robustness, defaults | 2 |
| `wifi-floppy/firmware/test/fixtures/layouts/*.json` + `*.bin` | cross-language golden layouts | 2, 8 |
| `wifi-floppy/firmware/src/display.h/.c` | layout-driven `display_render`, 2×, panel height, pump | 3, 4 |
| `wifi-floppy/firmware/src/ssd1306.h/.c` | init by panel | 4 |
| `wifi-floppy/firmware/src/display_store.h/.c` | display flash record + deferred-write rule | 5 |
| `wifi-floppy/firmware/src/device_client.h/.c` | displayAck, displayVersion, `dc_fetch_display`, status fields | 6 |
| `wifi-floppy/firmware/src/main.c` | wiring: panel init, layout handoff, store, running vs built-in screens | 6 |
| `wifi-floppy/firmware/wasm/display_wasm.c` | WebAssembly exports | 7 |
| `scripts/display-wasm.sh` | builds `public/display.wasm` + `src/lib/display-wasm.version` | 7 |
| `src/lib/display-wasm.ts` | loads the module in browser and Node; render/validate/defaults | 7 |
| `drizzle/0030_display_layouts.sql`, `src/db/schema/devices.ts` | columns | 8 |
| `src/lib/display-layout.ts` | JSON ↔ blob encoder, element constants | 8 |
| `src/app/api/devices/[id]/display/route.ts` | PATCH (user) | 8 |
| `src/app/api/device/display/route.ts` | GET (device, binary) | 8 |
| `src/app/api/device/poll/route.ts`, `src/lib/mount.ts`, `src/app/api/device/status/route.ts` | cursor + status fields | 8 |
| `src/lib/queries.ts`, `src/lib/live-state.ts` | display fields on the device list and live state | 8 |
| `src/components/devices/display-editor.tsx`, `device-card.tsx` | editor UI | 9 |
| `e2e/display-layout.spec.ts` | e2e | 10 |
| `HANDOFF.md` | record | 11 |

---

### Task 1: Golden framebuffers of today's renderer (before anything changes)

**Files:**
- Create: `wifi-floppy/firmware/test/test_display_golden.c`, `wifi-floppy/firmware/test/fixtures/display_golden/` (generated files)

**Interfaces:**
- Produces: the golden files, and a test that compares `display_render` output with them. The helper
  `render_golden(const char *name, display_state_t s, uint8_t fb[512])` is used here and extended in Task 3.

- [ ] **Step 1: Write the golden test, with a write mode**

```c
// wifi-floppy/firmware/test/test_display_golden.c
#include "harness.h"
#include "../src/display.h"
#include <stdlib.h>
#include <string.h>

// Spec 2026-10-04-oled-layouts §6: the 128x32 default layout must reproduce
// the 1.6.5 panel byte for byte. These files ARE 1.6.5's output, captured
// before display.c changed. DISPLAY_GOLDEN_WRITE=1 rewrites them -- only ever
// from an unmodified renderer, and never in the same commit as a renderer change.

#define FB_BYTES 512   // 128 x 32 / 8: the golden set is 128x32 only

static display_state_t st(disp_status_t status) {
    display_state_t s;
    memset(&s, 0, sizeof s);
    s.status = status; s.bars = 3; s.max_cyl = 79; s.pct = -1;
    return s;
}

typedef struct { const char *name; display_state_t s; } golden_t;

static int golden_set(golden_t *g) {
    int n = 0;
    display_state_t s;
    s = st(DS_BOOT);                                              g[n++] = (golden_t){"boot", s};
    s = st(DS_PORTAL); strcpy(s.title, "wifi-floppy-6A38");
        strcpy(s.detail, "join to set up");                       g[n++] = (golden_t){"portal", s};
    s = st(DS_WIFI); strcpy(s.title, "HomeNet"); s.bars = 1;      g[n++] = (golden_t){"wifi", s};
    s = st(DS_READY); strcpy(s.title, "no disk");                 g[n++] = (golden_t){"ready", s};
    s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 0;   g[n++] = (golden_t){"dl0", s};
    s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 64;  g[n++] = (golden_t){"dl64", s};
    s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 100; g[n++] = (golden_t){"dl100", s};
    // Review Focus 1: a swap downloading while a disk is mounted -- the counter wins.
    s = st(DS_DOWNLOAD); strcpy(s.title, "Turrican"); s.pct = 40;
        s.show_track = true; s.cyl = 12;                          g[n++] = (golden_t){"dl_with_track", s};
    s = st(DS_VERIFY); strcpy(s.title, "Turrican");               g[n++] = (golden_t){"verify", s};
    s = st(DS_LOADED); strcpy(s.title, "Workbench 3.1 Install"); strcpy(s.detail, "disk 1 of 6");
        s.show_track = true; s.cyl = 0; s.writable = true;        g[n++] = (golden_t){"mounted_w_t0", s};
    s = st(DS_LOADED); strcpy(s.title, "Workbench 3.1 Install"); strcpy(s.detail, "disk 1 of 6");
        s.show_track = true; s.cyl = 79;                          g[n++] = (golden_t){"mounted_ro_t79", s};
    s = st(DS_LOADED); strcpy(s.title, "A"); s.show_track = true; s.cyl = 80; s.max_cyl = 83;
        s.writable = true; s.sync = DISP_SYNC_PENDING; s.tick = 1; g[n++] = (golden_t){"mounted_pending", s};
    s = st(DS_LOADED); strcpy(s.title, "A"); s.show_track = true; s.cyl = 5;
        s.writable = true; s.sync = DISP_SYNC_OFFLINE;            g[n++] = (golden_t){"mounted_offline", s};
    s = st(DS_LOADED);
        strcpy(s.title, "Gods v1.00 (1991-03-28)(Renegade)(Disk 1 of 2)");
        strcpy(s.detail, "a detail that is far too long");
        s.show_track = true; s.cyl = 42;                          g[n++] = (golden_t){"long_title", s};
    s = st(DS_LOADED); s.title[0] = '\0'; s.show_track = true; s.cyl = 1; g[n++] = (golden_t){"empty_title", s};
    s = st(DS_ERROR); strcpy(s.title, "no route"); s.bars = -1;   g[n++] = (golden_t){"error_noradio", s};
    return n;
}

static void path_for(char *out, size_t n, const char *name) {
    snprintf(out, n, "fixtures/display_golden/%s.fb", name);
}

static void render_golden(display_state_t s, uint8_t fb[FB_BYTES]) {
    display_render(&s, fb);
}

static void every_golden_state_matches(void) {
    golden_t g[32];
    const int n = golden_set(g);
    const bool write = getenv("DISPLAY_GOLDEN_WRITE") != NULL;
    for (int i = 0; i < n; i++) {
        uint8_t fb[FB_BYTES];
        render_golden(g[i].s, fb);
        char path[128];
        path_for(path, sizeof path, g[i].name);
        if (write) {
            FILE *f = fopen(path, "wb");
            CHECK(f != NULL, path);
            if (f) { fwrite(fb, 1, FB_BYTES, f); fclose(f); }
            continue;
        }
        uint8_t want[FB_BYTES];
        FILE *f = fopen(path, "rb");
        CHECK(f != NULL, path);
        if (!f) continue;
        size_t got = fread(want, 1, FB_BYTES, f);
        fclose(f);
        CHECK(got == FB_BYTES, path);
        CHECK(memcmp(fb, want, FB_BYTES) == 0, g[i].name);
    }
}

int main(void) {
    RUN(every_golden_state_matches);
    return REPORT();
}
```

- [ ] **Step 2: Run it before the files exist and see it fail**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "display_golden|FAIL" | head`
Expected: FAIL lines naming `fixtures/display_golden/boot.fb` (no files yet).

- [ ] **Step 3: Generate the golden files from the UNMODIFIED renderer**

```bash
cd wifi-floppy/firmware/test && mkdir -p fixtures/display_golden
cc -std=c11 -D_DEFAULT_SOURCE -O1 -DWFMF_HOST_TEST=1 -o .build/gen_golden test_display_golden.c ../src/display.c
DISPLAY_GOLDEN_WRITE=1 .build/gen_golden
ls fixtures/display_golden | wc -l     # expect 16
git diff --stat ../src/display.c         # expect NOTHING: the renderer is untouched
```

- [ ] **Step 4: Run the suite: it passes against the files just written**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "test_display_golden|FAIL"`
Expected: `test_display_golden.c: 32 checks, 0 failed` (2 checks per state) and no FAIL.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/test/test_display_golden.c wifi-floppy/firmware/test/fixtures/display_golden
git commit -m "test(firmware): golden framebuffers of the 1.6.5 OLED renderer (16 states)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `display_layout`: element model, decoder/validator, defaults

**Files:**
- Create: `wifi-floppy/firmware/src/display_layout.h`, `wifi-floppy/firmware/src/display_layout.c`, `wifi-floppy/firmware/test/test_display_layout.c`, `wifi-floppy/firmware/test/fixtures/layouts/{default32,default64,custom64,bad_bounds,bad_dup,bad_reserved}.{json,bin}`

**Interfaces:**
- Produces (exact):

```c
#define LAYOUT_FORMAT        1
#define LAYOUT_MAX_ELEMENTS  16
#define LAYOUT_BLOB_MAX      (4 + 8 * LAYOUT_MAX_ELEMENTS)   // 132
#define STATUS_MAX_CHARS     8     // "DOWNLOAD"
#define TRACK_MAX_CHARS      5     // "99/99"; the renderer clamps both numbers to 0..99
#define PCT_MAX_CHARS        4     // "100%"
#define LAYOUT_ADVANCE       6     // glyph 5 + 1 column
#define LAYOUT_LINE_H        8

typedef enum { PANEL_128x32 = 0, PANEL_128x64 = 1 } panel_t;
typedef enum { EL_STATUS = 1, EL_WIFI = 2, EL_WRITE = 3, EL_TITLE = 4,
               EL_DETAIL = 5, EL_TRACK = 6, EL_DOWNLOAD = 7, EL_LEMMING = 8 } element_id_t;

typedef struct { uint8_t id, visible, scale, x, y, w, opt; } layout_el_t;   // scale 1 or 2
typedef struct { panel_t panel; uint8_t n; layout_el_t el[LAYOUT_MAX_ELEMENTS]; } layout_t;

int  panel_height(panel_t p);                       // 32 or 64
void layout_el_size(const layout_el_t *e, int *w, int *h);  // fixed size per spec, scaled
bool layout_decode(const uint8_t *buf, size_t len, layout_t *out, char *why, size_t why_len);
int  layout_encode(const layout_t *l, uint8_t *buf, size_t cap);           // bytes or -1
const layout_t *layout_default(panel_t p);
```

- [ ] **Step 1: Write the failing tests**

```c
// wifi-floppy/firmware/test/test_display_layout.c
#include "harness.h"
#include "../src/display_layout.h"
#include <string.h>

static size_t enc(const layout_t *l, uint8_t *b) {
    int n = layout_encode(l, b, LAYOUT_BLOB_MAX);
    CHECK(n > 0, "encodes");
    return (size_t)n;
}

static void expect_reject(const uint8_t *b, size_t n, const char *needle) {
    layout_t l; char why[80] = "";
    CHECK(!layout_decode(b, n, &l, why, sizeof why), needle);
    CHECK(strstr(why, needle) != NULL, why);
}

static void defaults_decode_and_fit(void) {
    for (int p = 0; p <= 1; p++) {
        uint8_t b[LAYOUT_BLOB_MAX]; layout_t l; char why[80] = "";
        size_t n = enc(layout_default((panel_t)p), b);
        CHECK(layout_decode(b, n, &l, why, sizeof why), why);
        CHECK(l.panel == (panel_t)p, "panel round-trips");
    }
}

static void the_128x32_default_is_todays_layout(void) {
    const layout_t *l = layout_default(PANEL_128x32);
    // Positions from display.c as of 1.6.5 (wifi 0,0; status 14,0; write 110,0;
    // lemming 120,0; title 0,8 two lines; detail 0,24; track/percent right-aligned on row 24).
    int seen = 0;
    for (int i = 0; i < l->n; i++) {
        const layout_el_t *e = &l->el[i];
        if (e->id == EL_WIFI)    { CHECK(e->x == 0 && e->y == 0, "wifi"); seen++; }
        if (e->id == EL_STATUS)  { CHECK(e->x == 14 && e->y == 0, "status"); seen++; }
        if (e->id == EL_WRITE)   { CHECK(e->x == 110 && e->y == 0, "write"); seen++; }
        if (e->id == EL_LEMMING) { CHECK(e->x == 120 && e->y == 0, "lemming"); seen++; }
        if (e->id == EL_TITLE)   { CHECK(e->x == 0 && e->y == 8 && e->w == 128 && e->opt == 2, "title"); seen++; }
        if (e->id == EL_DETAIL)  { CHECK(e->x == 0 && e->y == 24 && e->w == 128, "detail"); seen++; }
        if (e->id == EL_TRACK)   { CHECK(e->x == 98 && e->y == 24, "track box ends at 128"); seen++; }
        if (e->id == EL_DOWNLOAD){ CHECK(e->x == 104 && e->y == 24 && e->w == 0, "percent box ends at 128"); seen++; }
    }
    CHECK_EQ_INT(seen, 8);
}

static void sizes_are_fixed_and_scale(void) {
    layout_el_t e = { EL_STATUS, 1, 1, 0, 0, 0, 0 }; int w, h;
    layout_el_size(&e, &w, &h); CHECK(w == 48 && h == 8, "status 48x8");
    e.scale = 2; layout_el_size(&e, &w, &h); CHECK(w == 96 && h == 16, "status 2x");
    layout_el_t t = { EL_TITLE, 1, 1, 0, 0, 60, 2 };
    layout_el_size(&t, &w, &h); CHECK(w == 60 && h == 16, "title w x 2 lines");
    layout_el_t d = { EL_DOWNLOAD, 1, 1, 0, 0, 40, 0 };
    layout_el_size(&d, &w, &h); CHECK(w == 66 && h == 8, "bar 40 + 2 + 24");
    layout_el_t tr = { EL_TRACK, 1, 1, 0, 0, 0, 0 };
    layout_el_size(&tr, &w, &h); CHECK(w == 30 && h == 8, "track 30x8");
}

static void each_rule_is_enforced(void) {
    uint8_t b[LAYOUT_BLOB_MAX]; layout_t l = *layout_default(PANEL_128x32); size_t n;
    n = enc(&l, b); b[0] = 2;                expect_reject(b, n, "format");
    n = enc(&l, b); b[1] = 7;                expect_reject(b, n, "panel");
    n = enc(&l, b); b[3] = 1;                expect_reject(b, n, "reserved");
    n = enc(&l, b);                          expect_reject(b, n - 1, "length");
    n = enc(&l, b); b[4] = 9;                expect_reject(b, n, "element id");
    n = enc(&l, b); b[4 + 8] = b[4];         expect_reject(b, n, "twice");
    n = enc(&l, b); b[4 + 1] = 0x04;         expect_reject(b, n, "flags");
    n = enc(&l, b); b[4 + 6] = 1;            expect_reject(b, n, "reserved");
    // bounds: the title (2 lines) moved to y=20 needs rows 20..35 on a 32-row panel
    layout_t m = l;
    for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_TITLE) m.el[i].y = 20;
    n = enc(&m, b);                          expect_reject(b, n, "outside");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_TITLE) m.el[i].w = 8;
    n = enc(&m, b);                          expect_reject(b, n, "width");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_TITLE) m.el[i].opt = 3;
    n = enc(&m, b);                          expect_reject(b, n, "lines");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_DOWNLOAD) m.el[i].w = 4;
    n = enc(&m, b);                          expect_reject(b, n, "bar");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_WIFI) m.el[i].w = 3;
    n = enc(&m, b);                          expect_reject(b, n, "w must be 0");
}

static void garbage_never_decodes(void) {
    uint8_t b[LAYOUT_BLOB_MAX + 8]; layout_t l; char why[80];
    CHECK(!layout_decode(b, 0, &l, why, sizeof why), "empty");
    CHECK(!layout_decode(b, 3, &l, why, sizeof why), "short header");
    memset(b, 0xFF, sizeof b);
    CHECK(!layout_decode(b, sizeof b, &l, why, sizeof why), "all ones");
    b[0] = 1; b[1] = 0; b[2] = 17; b[3] = 0;
    CHECK(!layout_decode(b, 4 + 17 * 8, &l, why, sizeof why), "n > 16");
    uint8_t empty[4] = { 1, 1, 0, 0 };
    CHECK(layout_decode(empty, 4, &l, why, sizeof why) && l.n == 0, "n = 0 is a valid (blank) layout");
}

static void why_is_always_terminated(void) {
    uint8_t b[4] = { 9, 0, 0, 0 }; layout_t l; char why[6];
    memset(why, 'x', sizeof why);
    layout_decode(b, 4, &l, why, sizeof why);
    CHECK(memchr(why, '\0', sizeof why) != NULL, "NUL-terminated");
}

// Cross-language fixtures (Task 8 reads the same files from TypeScript).
static void fixtures_decode_as_named(void) {
    const char *ok[] = { "default32", "default64", "custom64" };
    const char *bad[][2] = { { "bad_bounds", "outside" }, { "bad_dup", "twice" }, { "bad_reserved", "reserved" } };
    for (int i = 0; i < 3; i++) {
        char p[96]; snprintf(p, sizeof p, "fixtures/layouts/%s.bin", ok[i]);
        FILE *f = fopen(p, "rb"); CHECK(f != NULL, p); if (!f) continue;
        uint8_t b[LAYOUT_BLOB_MAX + 1]; size_t n = fread(b, 1, sizeof b, f); fclose(f);
        layout_t l; char why[80] = "";
        CHECK(layout_decode(b, n, &l, why, sizeof why), p);
    }
    for (int i = 0; i < 3; i++) {
        char p[96]; snprintf(p, sizeof p, "fixtures/layouts/%s.bin", bad[i][0]);
        FILE *f = fopen(p, "rb"); CHECK(f != NULL, p); if (!f) continue;
        uint8_t b[LAYOUT_BLOB_MAX + 1]; size_t n = fread(b, 1, sizeof b, f); fclose(f);
        expect_reject(b, n, bad[i][1]);
    }
    // default32.bin is exactly the encoded default
    uint8_t want[LAYOUT_BLOB_MAX]; size_t wn = enc(layout_default(PANEL_128x32), want);
    FILE *f = fopen("fixtures/layouts/default32.bin", "rb");
    if (f) { uint8_t b[LAYOUT_BLOB_MAX + 1]; size_t n = fread(b, 1, sizeof b, f); fclose(f);
             CHECK(n == wn && memcmp(b, want, n) == 0, "default32.bin == encode(default)"); }
}

int main(void) {
    RUN(defaults_decode_and_fit);
    RUN(the_128x32_default_is_todays_layout);
    RUN(sizes_are_fixed_and_scale);
    RUN(each_rule_is_enforced);
    RUN(garbage_never_decodes);
    RUN(why_is_always_terminated);
    RUN(fixtures_decode_as_named);
    return REPORT();
}
```

- [ ] **Step 2: Run, see it fail**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "test_display_layout|COMPILE"`
Expected: `COMPILE FAIL: test_display_layout.c`.

- [ ] **Step 3: Write `display_layout.h`** with exactly the Interfaces block above, wrapped in
`#ifndef DISPLAY_LAYOUT_H` and `<stdbool.h> <stddef.h> <stdint.h>`. Put a header comment pointing to spec §4-§5 and
the rule "sizes are fixed per element, never measured from the current text".

- [ ] **Step 4: Write `display_layout.c`**

```c
#include "display_layout.h"
#include <stdio.h>
#include <string.h>

// Spec 2026-10-04-oled-layouts §4-§5. Pure: no SDK. Compiled into the
// firmware AND the WebAssembly module, so the editor can never save what the
// board would refuse.

int panel_height(panel_t p) { return p == PANEL_128x64 ? 64 : 32; }

void layout_el_size(const layout_el_t *e, int *w, int *h) {
    int bw = 0, bh = LAYOUT_LINE_H;
    switch (e->id) {
        case EL_STATUS:   bw = STATUS_MAX_CHARS * LAYOUT_ADVANCE; break;
        case EL_WIFI:     bw = 11; break;
        case EL_WRITE:    bw = 8;  break;
        case EL_LEMMING:  bw = 8;  break;
        case EL_TITLE:    bw = e->w; bh = LAYOUT_LINE_H * (e->opt ? e->opt : 1); break;
        case EL_DETAIL:   bw = e->w; break;
        case EL_TRACK:    bw = TRACK_MAX_CHARS * LAYOUT_ADVANCE; break;
        case EL_DOWNLOAD: bw = (e->w ? e->w + 2 : 0) + PCT_MAX_CHARS * LAYOUT_ADVANCE; break;
        default: break;
    }
    const int s = e->scale == 2 ? 2 : 1;
    *w = bw * s; *h = bh * s;
}

static bool no(char *why, size_t n, const char *msg) {
    if (n) snprintf(why, n, "%s", msg);
    return false;
}

bool layout_decode(const uint8_t *b, size_t len, layout_t *out, char *why, size_t n) {
    if (n) why[0] = '\0';
    if (len < 4)                  return no(why, n, "length: shorter than the header");
    if (b[0] != LAYOUT_FORMAT)    return no(why, n, "format: unknown");
    if (b[1] > PANEL_128x64)      return no(why, n, "panel: unknown");
    if (b[3] != 0)                return no(why, n, "reserved: header byte 3 must be 0");
    if (b[2] > LAYOUT_MAX_ELEMENTS) return no(why, n, "length: more than 16 elements");
    if (len != 4u + 8u * b[2])    return no(why, n, "length: does not match the element count");

    layout_t l; memset(&l, 0, sizeof l);
    l.panel = (panel_t)b[1]; l.n = b[2];
    const int W = 128, H = panel_height(l.panel);
    bool seen[9] = { false };
    for (int i = 0; i < l.n; i++) {
        const uint8_t *r = b + 4 + 8 * i;
        if (r[0] < EL_STATUS || r[0] > EL_LEMMING) return no(why, n, "element id: unknown");
        if (seen[r[0]])                             return no(why, n, "element id: listed twice");
        seen[r[0]] = true;
        if (r[1] & ~0x03u)                          return no(why, n, "flags: unknown bits");
        if (r[6] != 0 || r[7] != 0)                 return no(why, n, "reserved: record bytes 6-7 must be 0");
        layout_el_t e = { r[0], (uint8_t)(r[1] & 1u), (uint8_t)((r[1] & 2u) ? 2 : 1), r[2], r[3], r[4], r[5] };
        switch (e.id) {
            case EL_TITLE:
                if (e.w < 12)                return no(why, n, "title: width must be at least 12");
                if (e.opt < 1 || e.opt > 2)  return no(why, n, "title: lines must be 1 or 2");
                break;
            case EL_DETAIL:
                if (e.w < 12)                return no(why, n, "detail: width must be at least 12");
                if (e.opt != 0)              return no(why, n, "detail: opt must be 0");
                break;
            case EL_DOWNLOAD:
                if (e.w != 0 && e.w < 8)     return no(why, n, "download: bar must be 0 or at least 8 wide");
                if (e.opt != 0)              return no(why, n, "download: opt must be 0");
                break;
            default:
                if (e.w != 0)                return no(why, n, "w must be 0 for this element");
                if (e.opt != 0)              return no(why, n, "opt must be 0 for this element");
                break;
        }
        int ew, eh; layout_el_size(&e, &ew, &eh);
        if (e.x + ew > W || e.y + eh > H)  return no(why, n, "outside the panel");
        l.el[i] = e;
    }
    *out = l;
    return true;
}

int layout_encode(const layout_t *l, uint8_t *b, size_t cap) {
    const size_t need = 4u + 8u * l->n;
    if (l->n > LAYOUT_MAX_ELEMENTS || need > cap) return -1;
    b[0] = LAYOUT_FORMAT; b[1] = (uint8_t)l->panel; b[2] = l->n; b[3] = 0;
    for (int i = 0; i < l->n; i++) {
        const layout_el_t *e = &l->el[i];
        uint8_t *r = b + 4 + 8 * i;
        r[0] = e->id;
        r[1] = (uint8_t)((e->visible ? 1u : 0u) | (e->scale == 2 ? 2u : 0u));
        r[2] = e->x; r[3] = e->y; r[4] = e->w; r[5] = e->opt; r[6] = 0; r[7] = 0;
    }
    return (int)need;
}

// Drawing order matters (spec §4: list order). Track and download come BEFORE
// detail so the renderer's clip rule (Task 3) sees them first -- the same order
// 1.6.5 drew them in.
static const layout_t DEFAULT_32 = {
    PANEL_128x32, 8, {
        { EL_WIFI,     1, 1,   0,  0,   0, 0 },
        { EL_LEMMING,  1, 1, 120,  0,   0, 0 },
        { EL_WRITE,    1, 1, 110,  0,   0, 0 },
        { EL_STATUS,   1, 1,  14,  0,   0, 0 },
        { EL_TITLE,    1, 1,   0,  8, 128, 2 },
        { EL_TRACK,    1, 1,  98, 24,   0, 0 },
        { EL_DOWNLOAD, 1, 1, 104, 24,   0, 0 },
        { EL_DETAIL,   1, 1,   0, 24, 128, 0 },
    }
};

// 128x64 (spec §5): the status row as today, the title at 2x on one line
// (64 x 2 = 128 px wide), the detail line, the counter at 2x bottom-right,
// and download as a bar.
static const layout_t DEFAULT_64 = {
    PANEL_128x64, 8, {
        { EL_WIFI,     1, 1,   0,  0,   0, 0 },
        { EL_LEMMING,  1, 1, 120,  0,   0, 0 },
        { EL_WRITE,    1, 1, 110,  0,   0, 0 },
        { EL_STATUS,   1, 1,  14,  0,   0, 0 },
        { EL_TITLE,    1, 2,   0, 12,  64, 1 },
        { EL_TRACK,    1, 2,  68, 46,   0, 0 },
        { EL_DOWNLOAD, 1, 1,   0, 56,  96, 0 },
        { EL_DETAIL,   1, 1,   0, 32, 128, 0 },
    }
};

const layout_t *layout_default(panel_t p) { return p == PANEL_128x64 ? &DEFAULT_64 : &DEFAULT_32; }
```

- [ ] **Step 5: Write the fixtures**

Write a host helper once, `test/gen_layout_fixtures.c`. Compile and run it like Task 1's generator. It writes
`default32.bin` and `default64.bin` (encoded defaults) and:
- `custom64.bin`: DEFAULT_64 with the title moved to (0,16), lines 1, 1×, w 128;
- `bad_bounds.bin`: DEFAULT_32 with the title at y = 20;
- `bad_dup.bin`: DEFAULT_32 with record 1's id set to record 0's;
- `bad_reserved.bin`: DEFAULT_32 with record 0 byte 6 = 1.

Then hand-write each matching `.json` in the web shape that Task 8's encoder reads:

```json
{ "panel": "128x32", "elements": [ { "id": "wifi", "visible": true, "scale": 1, "x": 0, "y": 0, "w": 0, "opt": 0 }, ... ] }
```

Keep element order identical to the `.bin`. Element names map as follows: 1 status, 2 wifi, 3 write, 4 title,
5 detail, 6 track, 7 download, 8 lemming. Keep the generator in `test/` and add `gen_layout_fixtures\.c` to the
`test_*.c` loop's exclusion: it is not a test.

- [ ] **Step 6: Run, pass, commit**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "test_display_layout|FAIL"`
Expected: `test_display_layout.c: N checks, 0 failed`.

```bash
git add wifi-floppy/firmware/src/display_layout.h wifi-floppy/firmware/src/display_layout.c \
        wifi-floppy/firmware/test/test_display_layout.c wifi-floppy/firmware/test/gen_layout_fixtures.c \
        wifi-floppy/firmware/test/fixtures/layouts wifi-floppy/firmware/test/run.sh
git commit -m "feat(firmware): display_layout -- element model, blob decoder/validator, 128x32 and 128x64 defaults

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The renderer draws a layout (2×, panel height, today's rules kept)

**Files:**
- Modify: `wifi-floppy/firmware/src/display.h`, `wifi-floppy/firmware/src/display.c`, `wifi-floppy/firmware/test/test_display.c` (call sites), `wifi-floppy/firmware/test/test_display_golden.c`

**Interfaces:**
- Consumes: `display_layout.h` (Task 2).
- Produces:
  - `#define DISP_W 128`, `#define DISP_H_MAX 64`, `#define DISP_FB_MAX (DISP_W * DISP_H_MAX / 8)` (1024).
  - `void display_render(const display_state_t *s, const layout_t *l, uint8_t fb[DISP_FB_MAX]);` renders into the
    first `panel_height(l->panel)/8` pages and zeroes the rest.
  - `bool display_state_is_running(disp_status_t st);`: READY, DOWNLOAD, VERIFY and LOADED return true.
  - `const layout_t *display_layout_for(const display_state_t *s, const layout_t *custom);` returns `custom` for
    running states and `layout_default(custom->panel)` otherwise.

- [ ] **Step 1: Update the golden test to the new signature, and add the Review Focus 1 test**

In `test_display_golden.c`, change `render_golden` to:

```c
static void render_golden(display_state_t s, uint8_t fb[FB_BYTES]) {
    uint8_t full[DISP_FB_MAX];
    display_render(&s, display_layout_for(&s, layout_default(PANEL_128x32)), full);
    memcpy(fb, full, FB_BYTES);          // a 32-row panel uses pages 0..3
    for (int i = FB_BYTES; i < DISP_FB_MAX; i++) CHECK(full[i] == 0, "nothing below row 32");
}
```

Add `#include "../src/display_layout.h"` and these tests:

```c
static int lit(const uint8_t *fb, int x0, int y0, int x1, int y1) {
    int n = 0;
    for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++)
        if (fb[(y / 8) * DISP_W + x] & (1u << (y % 8))) n++;
    return n;
}

static void test_track_wins_overlap_with_download(void) {
    // Review Focus 1, in a CUSTOM layout: download and track overlapping.
    layout_t l = *layout_default(PANEL_128x32);
    display_state_t s; memset(&s, 0, sizeof s);
    s.status = DS_DOWNLOAD; s.pct = 50; s.show_track = true; s.cyl = 12; s.max_cyl = 79; s.bars = 3;
    uint8_t fb[DISP_FB_MAX]; display_render(&s, &l, fb);
    // "50%" would start at 128-23 = 105; "12/79" starts at 128-29 = 99. Only the counter's pixels.
    uint8_t only_track[DISP_FB_MAX]; display_state_t t = s; t.status = DS_LOADED;
    display_render(&t, &l, only_track);
    CHECK(memcmp(fb + 3 * DISP_W + 98, only_track + 3 * DISP_W + 98, 30) == 0, "row 3 right side = counter only");
}

static void test_2x_doubles_pixels(void) {
    layout_t one = { PANEL_128x64, 1, { { EL_WIFI, 1, 1, 0, 0, 0, 0 } } };
    layout_t two = { PANEL_128x64, 1, { { EL_WIFI, 1, 2, 0, 0, 0, 0 } } };
    display_state_t s; memset(&s, 0, sizeof s); s.status = DS_READY; s.bars = 3;
    uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
    display_render(&s, &one, a); display_render(&s, &two, b);
    CHECK_EQ_INT(lit(b, 0, 0, 22, 16), 4 * lit(a, 0, 0, 11, 8));
}

static void test_built_in_states_ignore_a_custom_layout(void) {
    layout_t l = { PANEL_128x32, 0, {{0}} };           // blank custom layout
    display_state_t s; memset(&s, 0, sizeof s); s.status = DS_PORTAL; strcpy(s.title, "wifi-floppy-6A38");
    uint8_t fb[DISP_FB_MAX];
    display_render(&s, display_layout_for(&s, &l), fb);
    CHECK(lit(fb, 0, 8, 128, 16) > 0, "the portal SSID still shows");
    s.status = DS_LOADED; display_render(&s, display_layout_for(&s, &l), fb);
    CHECK_EQ_INT(lit(fb, 0, 0, 128, 32), 0);   // running state: the blank layout really is blank
}

static void test_128x64_default_draws_below_row_32(void) {
    display_state_t s; memset(&s, 0, sizeof s);
    s.status = DS_LOADED; strcpy(s.title, "Turrican"); s.show_track = true; s.cyl = 9; s.max_cyl = 79;
    uint8_t fb[DISP_FB_MAX]; display_render(&s, layout_default(PANEL_128x64), fb);
    CHECK(lit(fb, 0, 32, 128, 64) > 0, "lower half used");
}
```

Register them in `main` with `RUN(...)`. In `test_display.c`, replace every `display_render(&s, fb)` with
`display_render(&s, layout_default(PANEL_128x32), fb)` and every `uint8_t fb[DISP_FB_BYTES]` with
`uint8_t fb[DISP_FB_MAX]`. The `panel` array and `DISP_FB_BYTES` uses in the fake blit become `DISP_FB_MAX`.

- [ ] **Step 2: Run, see it fail to compile**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "COMPILE|display"`
Expected: COMPILE FAIL for `test_display.c` and `test_display_golden.c` (`DISP_FB_MAX` and the new signature are
unknown).

- [ ] **Step 3: Make `display.h` layout-driven**

Replace the `DISP_W/DISP_H/DISP_PAGES/DISP_FB_BYTES` block with:

```c
#include "display_layout.h"
#define DISP_W       128
#define DISP_H_MAX   64
#define DISP_FB_MAX  (DISP_W * DISP_H_MAX / 8)    // 1024: room for a 128x64 panel
```

Replace the `display_render` prototype with the three Produces functions. In `display_t` (the pump struct), change
`fb`/`shadow` to `uint8_t fb[DISP_FB_MAX], shadow[DISP_FB_MAX];` and add `panel_t panel;` and
`const layout_t *layout;`. Change `display_set(display_t *d, const display_state_t *s)` to render with
`display_layout_for(s, d->layout)`. Add `void display_set_layout(display_t *d, const layout_t *l);`, which stores
`l`. Task 4 handles the panel change.

- [ ] **Step 4: Make `display.c` render a layout**

Keep every glyph table, `draw_glyph`, `draw_text`, `text_px`, `split_title`, `status_word` and the bitmaps
unchanged. Change `px()` to scale:

```c
// Every drawing primitive goes through px(); a scale of 2 makes each pixel a
// 2x2 block, so glyphs, bitmaps and text all double without separate fonts.
static int g_scale = 1;
static int g_rows  = 32;
static void px(uint8_t *fb, int x, int y) {
    for (int dy = 0; dy < g_scale; dy++) for (int dx = 0; dx < g_scale; dx++) {
        const int X = x * g_scale + dx, Y = y * g_scale + dy;
        if (X < 0 || X >= DISP_W || Y < 0 || Y >= g_rows) continue;
        fb[(Y / 8) * DISP_W + X] |= (uint8_t)(1u << (Y % 8));
    }
}
```

Each element is drawn in its own coordinate space: element origin `(ox, oy)` and scale `s`. Draw at
`(ox / s + local)` with `g_scale = s`, so every existing helper keeps working in 1× units. Use a small wrapper:

```c
#define AT(v) ((v) / g_scale)          // element origin in the scaled coordinate space
```

and draw every element with `g_scale = e->scale` set first, passing `AT(e->x) + ...` and `AT(e->y)`. Element origins
for 2× elements must be even. That is guaranteed because the editor snaps 2× elements to even coordinates (Task 9),
and decoding rounds down otherwise: the drawing simply lands one pixel up/left. The validator still bounds the true
size.

Rewrite `display_render`:

```c
bool display_state_is_running(disp_status_t st) {
    return st == DS_READY || st == DS_DOWNLOAD || st == DS_VERIFY || st == DS_LOADED;
}

const layout_t *display_layout_for(const display_state_t *s, const layout_t *custom) {
    return display_state_is_running(s->status) ? custom : layout_default(custom->panel);
}

static const layout_el_t *find(const layout_t *l, int id) {
    for (int i = 0; i < l->n; i++) if (l->el[i].id == id && l->el[i].visible) return &l->el[i];
    return NULL;
}

// The right-aligned text of a track/download element: what it says and where it starts.
static int right_text(const layout_el_t *e, const char *t) {
    int bw, bh; layout_el_size(e, &bw, &bh);
    return e->x + bw - text_px(t) * e->scale;     // screen x of its first pixel
}

static void track_text(const display_state_t *s, char out[8]) {
    const int c = s->cyl < 0 ? 0 : s->cyl > 99 ? 99 : s->cyl;     // TRACK_MAX_CHARS = 5: "99/99"
    const int m = s->max_cyl < 0 ? 0 : s->max_cyl > 99 ? 99 : s->max_cyl;
    snprintf(out, 8, "%d/%d", c, m);
}

static void pct_text(const display_state_t *s, char out[8]) {
    snprintf(out, 8, "%d%%", s->pct > 100 ? 100 : s->pct);
}

void display_render(const display_state_t *s, const layout_t *l, uint8_t fb[DISP_FB_MAX]) {
    memset(fb, 0, DISP_FB_MAX);
    g_rows = panel_height(l->panel);

    const layout_el_t *track = s->show_track ? find(l, EL_TRACK) : NULL;
    const layout_el_t *dl = (s->status == DS_DOWNLOAD && s->pct >= 0) ? find(l, EL_DOWNLOAD) : NULL;
    // Review Focus 1: where both would be drawn on top of each other, the counter
    // wins -- a half-drawn "12/79" is a lie about which track is read (1.6.5's rule).
    if (track && dl) {
        int tw, th, dw, dh; layout_el_size(track, &tw, &th); layout_el_size(dl, &dw, &dh);
        const bool overlap = track->x < dl->x + dw && dl->x < track->x + tw &&
                             track->y < dl->y + dh && dl->y < track->y + th;
        if (overlap) dl = NULL;
    }

    for (int i = 0; i < l->n; i++) {
        const layout_el_t *e = &l->el[i];
        if (!e->visible) continue;
        g_scale = e->scale;
        const int x = AT(e->x), y = AT(e->y);
        int bw, bh; layout_el_size(e, &bw, &bh);
        switch (e->id) {
            case EL_WIFI:    draw_wifi(fb, x, y, s->bars); break;
            case EL_LEMMING: draw_lemming(fb, x, y, s->tick); break;
            case EL_WRITE:   draw_write_state(fb, x, y, s->writable, s->sync); break;
            case EL_STATUS:  draw_text(fb, x, y, status_word(s->status), x + bw / e->scale); break;
            case EL_TITLE: {
                const int line = e->w / ADVANCE;                 // characters per line, 1x units
                if (e->opt == 2) {
                    char a[64], b2[64]; split_title_n(s->title, a, b2, line);
                    draw_text(fb, x, y, a, x + e->w);
                    draw_text(fb, x, y + LINE_H, b2, x + e->w);
                } else {
                    char a[64]; one_line_n(s->title, a, line);
                    draw_text(fb, x, y, a, x + e->w);
                }
                break;
            }
            case EL_TRACK:
                if (track == e) { char t[8]; track_text(s, t);
                    draw_text(fb, AT(right_text(e, t)), y, t, AT(e->x + bw)); }
                break;
            case EL_DOWNLOAD:
                if (dl == e) {
                    char t[8]; pct_text(s, t);
                    if (e->w) draw_bar(fb, x, y, e->w, s->pct);
                    draw_text(fb, AT(right_text(e, t)), y, t, AT(e->x + bw));
                }
                break;
            case EL_DETAIL: {
                // Clipped against a drawn counter/percent on its rows to its right,
                // exactly as 1.6.5: limit = that text's first pixel - one ADVANCE.
                int limit = e->x + bw;
                const layout_el_t *rt[2] = { track, dl };
                char t[8];
                for (int k = 0; k < 2; k++) {
                    const layout_el_t *o = rt[k]; if (!o) continue;
                    int ow, oh; layout_el_size(o, &ow, &oh);
                    if (o->y >= e->y + bh || e->y >= o->y + oh) continue;   // different rows
                    if (o->id == EL_TRACK) track_text(s, t); else pct_text(s, t);
                    const int left = right_text(o, t) - ADVANCE * e->scale;
                    if (left > e->x && left < limit) limit = left;
                }
                g_scale = e->scale;
                draw_text(fb, x, y, s->detail, AT(limit));
                break;
            }
            default: break;
        }
    }
    g_scale = 1;
}
```

Add the two title helpers. They generalise `split_title`'s fixed `LINE = DISP_W / ADVANCE` (21) to `line`.
`split_title_n` is the existing `split_title` body with `LINE` replaced by the `line` argument and buffers of 64.
`one_line_n` copies up to `line` characters, and, when the title is longer, ends with `..` in the last two places
(`line >= 3`). Add `draw_bar`:

```c
// Outline 7 rows tall, filled left to right to pct; then 2 px gap before the text.
static void draw_bar(uint8_t *fb, int x, int y, int w, int pct) {
    if (pct < 0) pct = 0; if (pct > 100) pct = 100;
    for (int i = 0; i < w; i++) { px(fb, x + i, y); px(fb, x + i, y + 6); }
    for (int j = 0; j < 7; j++) { px(fb, x, y + j); px(fb, x + w - 1, y + j); }
    const int fill = (w - 2) * pct / 100;
    for (int i = 0; i < fill; i++) for (int j = 2; j < 5; j++) px(fb, x + 1 + i, y + j);
}
```

The pump: in `display_pump`, `display_in_sync` and `display_init`, use `d->panel`'s page count
(`panel_height(d->panel) / 8`) in place of `DISP_PAGES`, and `DISP_FB_MAX` for sizes. `display_init` sets
`d->panel = PANEL_128x32` and `d->layout = layout_default(PANEL_128x32)`.

- [ ] **Step 5: Run the suite: the goldens decide**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "test_display|FAIL"`
Expected: `test_display_golden.c` 0 failed, which proves the 128×32 default is pixel-identical to 1.6.5, and
`test_display.c` 0 failed.

If a golden fails, the renderer is wrong, not the golden. **Never regenerate the goldens in this task.** Compare
the named state's bytes against the file to find the moved pixels.

- [ ] **Step 6: Device build, commit**

Run the device build (Global Constraints). It must have no errors. `main.c` callers of `display_set` keep compiling,
because `display_set`'s signature is unchanged.

```bash
git add wifi-floppy/firmware/src/display.h wifi-floppy/firmware/src/display.c \
        wifi-floppy/firmware/test/test_display.c wifi-floppy/firmware/test/test_display_golden.c
git commit -m "feat(firmware): layout-driven OLED renderer -- 2x elements, 128x64 height; 128x32 default pixel-identical to 1.6.5

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Panel driver by panel type; switching panel re-initialises in place

**Files:**
- Modify: `wifi-floppy/firmware/src/ssd1306.h`, `wifi-floppy/firmware/src/ssd1306.c`, `wifi-floppy/firmware/src/display.h`, `wifi-floppy/firmware/src/display.c`, `wifi-floppy/firmware/test/test_display.c`

**Interfaces:**
- Consumes: `panel_t`, `panel_height()` (Task 2), and `display_t` with `panel`/`layout` (Task 3).
- Produces:
  - `bool ssd1306_init(uint8_t addr, panel_t panel);`
  - `bool ssd1306_blit(uint8_t addr, panel_t panel, int page, int col, const uint8_t *bytes, int n);`
  - `bool ssd1306_selftest(uint8_t addr, panel_t panel);`
  - `void display_set_panel(display_t *d, panel_t p);` clears `shadow` to `0xFF` (so every byte is dirty and
    resent) and `fb` to 0. The caller re-runs `ssd1306_init` first.

- [ ] **Step 1: Write the failing test (Review Focus 5)**

```c
static void test_panel_change_resends_every_page(void) {
    begin();
    display_t d; display_init(&d, fake_blit, NULL);
    display_state_t s = base_state(); strcpy(s.title, "x");
    display_set(&d, &s);
    while (display_pump(&d, 4096) > 0) {}
    CHECK(display_in_sync(&d), "settled at 128x32");

    display_set_panel(&d, PANEL_128x64);
    display_set_layout(&d, layout_default(PANEL_128x64));
    display_set(&d, &s);
    n_blits = 0; bool page_sent[8] = { false };
    while (display_pump(&d, 4096) > 0) {
        for (int i = 0; i < n_blits && i < MAX_BLITS; i++) page_sent[blits[i].page] = true;
    }
    for (int p = 0; p < 8; p++) CHECK(page_sent[p], "every page of the 64-row panel is sent");

    display_set_panel(&d, PANEL_128x32);
    display_set_layout(&d, layout_default(PANEL_128x32));
    display_set(&d, &s);
    n_blits = 0;
    while (display_pump(&d, 4096) > 0) {}
    for (int i = 0; i < n_blits && i < MAX_BLITS; i++) CHECK(blits[i].page < 4, "never past page 3 on 128x32");
}
```

Register it with `RUN(...)`.

- [ ] **Step 2: Run, see it fail**

Run: `./run.sh 2>&1 | grep -E "test_display.c|COMPILE"`
Expected: COMPILE FAIL (`display_set_panel` is undefined).

- [ ] **Step 3: Implement**

In `display.c`:

```c
void display_set_panel(display_t *d, panel_t p) {
    d->panel = p;
    memset(d->fb, 0, DISP_FB_MAX);
    memset(d->shadow, 0xFF, DISP_FB_MAX);   // every byte dirty: the glass holds the old panel's image
}
```

In `ssd1306.c`, drop `HEIGHT`/`PAGES`. Build the init table at runtime: the `0xA8` operand is
`panel_height(panel) - 1`, and the `0xDA` operand is `panel == PANEL_128x64 ? 0x12 : 0x02`. Keep the comment about
the COM pins, but update it, because both values are now used. `ssd1306_blit` and `ssd1306_clear` bound `page` by
`panel_height(panel) / 8`. `ssd1306_selftest` draws its frame and X over `panel_height(panel)` rows. Update the
prototypes in `ssd1306.h` (include `display_layout.h` for `panel_t`).

In `main.c`, where the panel is brought up (`ssd1306_selftest(panel)` and `display_init(&g_disp, panel_blit, NULL)`,
around line 2242), pass `g_disp.panel` / `PANEL_128x32` for now. Task 6 supplies the stored panel. `panel_blit`
passes `g_disp.panel` through to `ssd1306_blit`.

- [ ] **Step 4: Run, pass; device build; commit**

Run the host suite (0 failed) and the device build (no errors).

```bash
git add wifi-floppy/firmware/src/ssd1306.h wifi-floppy/firmware/src/ssd1306.c wifi-floppy/firmware/src/display.h \
        wifi-floppy/firmware/src/display.c wifi-floppy/firmware/test/test_display.c wifi-floppy/firmware/src/main.c
git commit -m "feat(firmware): SSD1306 init by panel type (32/64 rows, COM pins 0x02/0x12); a panel change resends the whole frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `display_store`: the display flash record and the deferred-write rule

**Files:**
- Create: `wifi-floppy/firmware/src/display_store.h`, `wifi-floppy/firmware/src/display_store.c`, `wifi-floppy/firmware/test/test_display_store.c`

**Interfaces:**
- Produces:

```c
typedef struct {
    uint32_t version;           // the display version this record holds (the board's displayAck after a reboot)
    uint8_t  panel;             // panel_t
    uint8_t  has_layout;        // 0 = the panel's default
    uint8_t  blob_len;          // 0..LAYOUT_BLOB_MAX
    uint8_t  blob[LAYOUT_BLOB_MAX];
} display_record_t;

bool display_store_load(display_record_t *out);     // false: nothing valid stored (erased, bad magic, bad CRC)
bool display_store_save(const display_record_t *r); // false while a disk is mounted, or on a flash error
void display_store_erase(void);                      // tests only, and a future reset

// The deferred-write rule (pure): write when something new is pending and the drive is empty.
bool display_store_should_write(bool pending, bool disk_mounted);
```

- [ ] **Step 1: Write the failing tests (Review Focus 2)**

```c
#include "harness.h"
#include "../src/display_store.h"
#include <string.h>

static display_record_t rec(uint32_t v) {
    display_record_t r; memset(&r, 0, sizeof r);
    r.version = v; r.panel = 1; r.has_layout = 1; r.blob_len = 4;
    r.blob[0] = 1; r.blob[1] = 1; r.blob[2] = 0; r.blob[3] = 0;
    return r;
}

static void test_nothing_stored_loads_false(void) {
    display_store_erase();
    display_record_t r; CHECK(!display_store_load(&r), "erased: nothing");
}

static void test_round_trip(void) {
    display_record_t a = rec(7), b;
    CHECK(display_store_save(&a), "saved");
    CHECK(display_store_load(&b), "loaded");
    CHECK(memcmp(&a, &b, sizeof a) == 0, "identical");
}

static void test_store_write_waits_for_an_empty_drive(void) {
    CHECK(!display_store_should_write(true, true), "pending but mounted: wait");
    CHECK(display_store_should_write(true, false), "pending and empty: write");
    CHECK(!display_store_should_write(false, false), "nothing pending: no write");
}

static void test_reboot_before_write_refetches(void) {
    // v5 saved; v6 applied from RAM while mounted, never written; reboot.
    display_record_t v5 = rec(5), after;
    CHECK(display_store_save(&v5), "v5 stored");
    CHECK(display_store_load(&after) && after.version == 5, "after reboot the ack is 5, so v6 is fetched again");
}

static void test_a_damaged_record_is_not_trusted(void) {
    display_record_t a = rec(9), b;
    display_store_save(&a);
    display_store_corrupt_for_test();      // flips one payload byte in the host buffer
    CHECK(!display_store_load(&b), "bad CRC: not trusted");
}

int main(void) {
    RUN(test_nothing_stored_loads_false);
    RUN(test_round_trip);
    RUN(test_store_write_waits_for_an_empty_drive);
    RUN(test_reboot_before_write_refetches);
    RUN(test_a_damaged_record_is_not_trusted);
    return REPORT();
}
```

- [ ] **Step 2: Run, see it fail** (COMPILE FAIL: no `display_store.h`).

- [ ] **Step 3: Implement**, following `config_store.c`'s structure exactly:
- a magic (`0x44535031`, "DSP1"), then `version`, `panel`, `has_layout`, `blob_len`, `blob`, then a CRC32;
- page build/load as pure functions;
- `#ifndef WFMF_HOST_TEST` for flash and `#else` for a static host buffer initialised to `0xFF`;
- `display_store_corrupt_for_test()` exists only under `WFMF_HOST_TEST`.

Device flash details:
- `#define DISPLAY_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 3 * FLASH_SECTOR_SIZE)`, with a comment that it is the
  sector below config_store's.
- Load through `XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + DISPLAY_FLASH_OFFSET`.
- Save refuses when `psram_active_slot() != SLOT_NONE`, then programs one page via `flash_safe_execute`. Unlike
  `config_store_save`, it does NOT call `token_store_erase()`.

```c
bool display_store_should_write(bool pending, bool disk_mounted) { return pending && !disk_mounted; }
```

Add `display_store\.c` to nothing: it builds on the host through its `WFMF_HOST_TEST` branch, like config_store.c.
Check `run.sh`'s exclusion list does not need it. Add `src/display_store.c` and `src/display_layout.c` to
`add_executable` in `CMakeLists.txt`.

- [ ] **Step 4: Run, pass; device build; commit**

```bash
git add wifi-floppy/firmware/src/display_store.h wifi-floppy/firmware/src/display_store.c \
        wifi-floppy/firmware/test/test_display_store.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "feat(firmware): display_store -- the layout's own flash record, written only with the drive empty

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Firmware protocol and wiring: displayAck, fetch, handoff, status

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h`, `wifi-floppy/firmware/src/device_client.c`, `wifi-floppy/firmware/src/main.c`, `wifi-floppy/firmware/test/test_device_client.c` (or the existing device-client host test file: find it with `grep -l "dc_step" test/*.c`)

**Interfaces:**
- Consumes: `layout_decode`, `layout_default` (Task 2); `display_set_layout`/`display_set_panel` (Tasks 3-4);
  `display_store_*` (Task 5).
- Produces, in `device_client_t`:
  - `uint32_t display_ack;`: the highest display version handled; seeded from `display_store_load` at boot.
  - `uint32_t display_want;`: from the last poll body, 0 when absent.
  - `char display_error[48];`: empty when none.
  - `bool display_layouts;`: capability, set true in `dc_init`.

  Functions:
  - `int dc_fetch_display(device_client_t *c, uint8_t *buf, int cap)` returns bytes, or -1 on a transport error.
  - `bool dc_display_owed(const device_client_t *c)` returns `c->display_want > c->display_ack`.
  - `bool dc_display_parse(const uint8_t *buf, int n, uint32_t *version, uint8_t *panel, const uint8_t **blob, int *blob_len)`
    is pure and host-tested.

- [ ] **Step 1: Write the failing tests (Review Focus 3)**

In the device-client host test file, add:

```c
static void test_display_body_parses(void) {
    const uint8_t body[] = { 0, 0, 0, 9,  1,  1,   1, 1, 0, 0 };   // v9, 128x64, has layout, a 4-byte blob
    uint32_t v; uint8_t p; const uint8_t *b; int bl;
    CHECK(dc_display_parse(body, sizeof body, &v, &p, &b, &bl), "parses");
    CHECK(v == 9 && p == 1 && bl == 4 && b == body + 6, "fields");
    const uint8_t dflt[] = { 0, 0, 0, 3, 0, 0 };                     // v3, 128x32, default
    CHECK(dc_display_parse(dflt, sizeof dflt, &v, &p, &b, &bl) && bl == 0, "default has no blob");
    CHECK(!dc_display_parse(body, 5, &v, &p, &b, &bl), "short is refused");
    const uint8_t bad[] = { 0, 0, 0, 9, 1, 1 };                        // claims a layout, carries none
    CHECK(!dc_display_parse(bad, sizeof bad, &v, &p, &b, &bl), "missing blob is refused");
}

static void test_rejected_layout_still_acks(void) {
    // The cursor rule: a layout the board refuses is still HANDLED, so it never re-wakes the poll.
    device_client_t c; memset(&c, 0, sizeof c);
    c.display_ack = 4; c.display_want = 5;
    CHECK(dc_display_owed(&c), "v5 owed");
    dc_display_handled(&c, 5, "outside the panel");
    CHECK(!dc_display_owed(&c) && c.display_ack == 5, "acked despite the rejection");
    CHECK(strcmp(c.display_error, "outside the panel") == 0, "reason kept for the status");
    dc_display_handled(&c, 6, NULL);
    CHECK(c.display_error[0] == '\0', "an applied layout clears the error");
}

static void test_poll_url_carries_display_ack(void) {
    // Uses the transport fake the file already has: run one dc_step and read the request line.
    // Expect "/api/device/poll?since=<n>&nfcAck=<n>&displayAck=<n>".
}
```

Write the last test the way the file's existing poll tests do: script a 204 on the fake transport, call `dc_step`,
assert the recorded request path contains `&displayAck=`. Add
`void dc_display_handled(device_client_t *c, uint32_t version, const char *error);` to the Produces list.

- [ ] **Step 2: Run, see it fail.**

- [ ] **Step 3: Implement in `device_client.c`**
- **Poll URL:** extend the snprintf at the `/api/device/poll?since=%lu&nfcAck=%lu` line to append
  `&displayAck=%lu` with `c->display_ack`. Update the "Worst case ... is 51" comment to the new worst case (70) and
  check the `path` buffer size.
- **Poll body:** in `dc_handle_poll_body`, before the disk logic, read `displayVersion` with `json_u32_strict` into
  `c->display_want`; leave it unchanged when absent.
- **Status body:** add `,"displayLayouts":true,"displayVersion":%lu` (`c->display_ack`) and `,"displayError":%s`
  (a JSON string or `null`) to the snprintf. Check `DC_STATUS_BODY_BYTES` still fits the worst case, raising it if
  not, and say so in the commit.
- **`dc_fetch_display`:** copy `dc_fetch_firmware`, GET `/api/device/display` into a small static sink that copies
  up to `cap` bytes, and return the byte count, or -1 (also on 401, which halts as everywhere).
- **`dc_display_parse` and `dc_display_handled`:** as tested.

- [ ] **Step 4: Wire it in `main.c`**
- **At boot,** before the first `display_set`: `display_record_t rec; if (display_store_load(&rec)) { ... }`.
  1. Decode `rec.blob` with `layout_decode` into a `static layout_t g_layout_store`. On failure, use
     `layout_default(rec.panel)`.
  2. Set `g_disp` panel/layout: `display_set_panel` + `ssd1306_init(panel_addr, panel)` + `display_set_layout`.
  3. Seed `c.display_ack = rec.version` after `dc_init`.
- **Core1, in the poll loop,** once per pass after `nfc_core1_event` and only when `dc_display_owed(&c)` and no
  writes are pending (`!up_has_work(&up)`):

```c
static uint8_t dbuf[8 + LAYOUT_BLOB_MAX];
int n = dc_fetch_display(&c, dbuf, sizeof dbuf);
uint32_t v; uint8_t p; const uint8_t *blob; int bl;
if (n > 0 && dc_display_parse(dbuf, n, &v, &p, &blob, &bl)) {
    layout_t l; char why[48] = "";
    bool ok = bl == 0 ? true : layout_decode(blob, (size_t)bl, &l, why, sizeof why);
    if (ok && bl > 0 && l.panel != (panel_t)p) { ok = false; snprintf(why, sizeof why, "panel mismatch"); }
    if (ok) display_handoff_publish(p, bl ? &l : NULL, v, blob, bl);   // core0 applies; store write deferred
    dc_display_handled(&c, v, ok ? NULL : why);
}
```

- **The handoff (`display_handoff_publish`, in main.c):** two `static layout_t` slots plus a `volatile uint32_t`
  sequence, the same pattern as the NFC event boxes.
  - core1 fills the slot the sequence does not name, then increments the sequence with a release barrier
    (`__dmb()`).
  - core0's display pump slot compares the sequence. When it changed:
    1. take the slot;
    2. if the panel differs, `ssd1306_init(addr, panel)` then `display_set_panel`;
    3. `display_set_layout`;
    4. set `g_display_store_pending = true`.
  - A `NULL` layout means `layout_default(panel)`.
- **The store write:** in core0's idle path, where the drive-empty state is known, call
  `if (display_store_should_write(g_display_store_pending, psram_active_slot() != SLOT_NONE)) { if (display_store_save(&rec)) g_display_store_pending = false; }`.
  `rec` is the published version, panel and blob, built by `display_handoff_publish`.
- **The status report** needs nothing new: the status body reads `c.display_ack` and `c.display_error`. Send a
  status after a display was handled: set the same "report owed" flag the NFC reader change uses
  (`nfc_report_owed`), or add `display_report_owed` if that flag is NFC-specific.

- [ ] **Step 5: Run the host suite and the device build; commit**

```bash
git add wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c \
        wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/<the device-client test file>
git commit -m "feat(firmware): display layouts over the poll -- displayAck cursor, binary fetch, core1->core0 handoff, deferred flash write

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The WebAssembly module and its loader

**Files:**
- Create: `wifi-floppy/firmware/wasm/display_wasm.c`, `scripts/display-wasm.sh`, `src/lib/display-wasm.ts`, `src/lib/display-wasm.test.ts`, `public/display.wasm` (built), `src/lib/display-wasm.version` (built)
- Modify: `package.json` (script `display:wasm`), `wifi-floppy/firmware/test/run.sh` (staleness check)

**Interfaces:**
- Produces (TypeScript, `src/lib/display-wasm.ts`):

```ts
export type PanelId = 0 | 1;
export interface PreviewState {
  status: 'boot' | 'portal' | 'wifi' | 'ready' | 'download' | 'verify' | 'loaded' | 'error';
  bars: number; title: string; detail: string; showTrack: boolean; cyl: number; maxCyl: number;
  pct: number; tick: number; writable: boolean; sync: 'synced' | 'pending' | 'offline';
}
export interface DisplayWasm {
  /** null when valid, else the C validator's reason. */
  validate(blob: Uint8Array): string | null;
  /** 1024-byte framebuffer (SSD1306 page layout) for `blob` (null = the panel's default). */
  render(state: PreviewState, panel: PanelId, blob: Uint8Array | null): Uint8Array;
  defaultBlob(panel: PanelId): Uint8Array;
}
export async function loadDisplayWasm(bytes?: ArrayBuffer): Promise<DisplayWasm>; // browser: fetches /display.wasm
```

- [ ] **Step 1: Write the exports (`wasm/display_wasm.c`)**

```c
// The board's own renderer and validator, for the web app (spec §7). Built by
// scripts/display-wasm.sh; nothing here is used by the firmware.
#include "display.h"
#include "display_layout.h"
#include <string.h>

static uint8_t  g_fb[DISP_FB_MAX];
static uint8_t  g_blob[LAYOUT_BLOB_MAX];
static char     g_why[80];
static display_state_t g_state;
static uint8_t  g_out[LAYOUT_BLOB_MAX];

__attribute__((export_name("fb_ptr")))    uint8_t *fb_ptr(void)    { return g_fb; }
__attribute__((export_name("blob_ptr")))  uint8_t *blob_ptr(void)  { return g_blob; }
__attribute__((export_name("why_ptr")))   char    *why_ptr(void)   { return g_why; }
__attribute__((export_name("state_ptr"))) display_state_t *state_ptr(void) { return &g_state; }
__attribute__((export_name("out_ptr")))   uint8_t *out_ptr(void)   { return g_out; }
__attribute__((export_name("state_size"))) int state_size(void) { return (int)sizeof g_state; }

/** 1 = valid, 0 = rejected (reason at why_ptr). */
__attribute__((export_name("validate"))) int validate(int len) {
    layout_t l; return layout_decode(g_blob, (size_t)len, &l, g_why, sizeof g_why) ? 1 : 0;
}

/** Render g_state with the blob (len 0 = the panel's default) into g_fb. 1 ok, 0 invalid blob. */
__attribute__((export_name("render"))) int render(int panel, int len) {
    layout_t l;
    const layout_t *use = layout_default((panel_t)panel);
    if (len > 0) { if (!layout_decode(g_blob, (size_t)len, &l, g_why, sizeof g_why)) return 0; use = &l; }
    display_render(&g_state, display_layout_for(&g_state, use), g_fb);
    return 1;
}

/** The encoded default for `panel` into g_out; returns its length. */
__attribute__((export_name("default_blob"))) int default_blob(int panel) {
    return layout_encode(layout_default((panel_t)panel), g_out, sizeof g_out);
}
```

`state_size` exists because TypeScript writes `display_state_t` fields by offset. Record the struct's field offsets
in `display-wasm.ts` as constants, derived from `display.h`'s `display_state_t`:
- `status`, `bars`, then `title[43]`, `detail[22]`;
- then `show_track`, `cyl`, `max_cyl`, `pct`, `tick`, `writable`, `sync`, with C alignment.

`display-wasm.test.ts` asserts `state_size()` equals the TypeScript-computed size. If they differ, the offsets are
wrong.

- [ ] **Step 2: The build script**

```bash
#!/usr/bin/env bash
# scripts/display-wasm.sh -- builds public/display.wasm from the firmware's own
# renderer, and records a hash of its C sources so a stale module cannot ship.
set -euo pipefail
cd "$(dirname "$0")/.."
F=wifi-floppy/firmware
SRC="$F/src/display.c $F/src/display_layout.c $F/wasm/display_wasm.c"
PATH="$(brew --prefix lld)/bin:$PATH" "$(brew --prefix llvm)/bin/clang" \
  --target=wasm32-unknown-wasip1 -O2 -mexec-model=reactor -I"$F/src" $SRC -o public/display.wasm
cat $SRC $F/src/display.h $F/src/display_layout.h | shasum -a 256 | cut -d' ' -f1 > src/lib/display-wasm.version
echo "public/display.wasm $(wc -c < public/display.wasm) bytes, sources $(cat src/lib/display-wasm.version)"
```

`package.json`: `"display:wasm": "bash scripts/display-wasm.sh"`.

`run.sh` staleness check, before `exit $fail`:

```bash
# Spec 2026-10-04-oled-layouts §7: the editor's preview IS this renderer. A
# changed display source without a rebuilt module would preview pixels the
# board does not draw.
want=$(cat ../src/display.c ../src/display_layout.c ../wasm/display_wasm.c ../src/display.h ../src/display_layout.h | shasum -a 256 | cut -d' ' -f1)
have=$(cat ../../../src/lib/display-wasm.version 2>/dev/null || echo missing)
if [ "$want" != "$have" ]; then
  echo "FAIL: public/display.wasm is stale -- run pnpm display:wasm"
  fail=1
fi
```

- [ ] **Step 3: The loader (`src/lib/display-wasm.ts`)**

Implement `loadDisplayWasm`:
1. Instantiate with `{ wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) }`.
2. Call `_initialize()` if it is exported.
3. Wrap the exports:
   - `validate`: copy the blob to `blob_ptr`, call `validate(len)`, and read the NUL-terminated reason at `why_ptr`.
   - `render`: write the state fields at `state_ptr` (status enum order as in `display.h`: boot 0, portal 1, wifi 2,
     ready 3, download 4, verify 5, loaded 6, error 7; sync synced 0 / pending 1 / offline 2), copy the blob, call
     `render(panel, len)`, and return a copy of the 1024 bytes at `fb_ptr`.
   - `defaultBlob`: `default_blob(panel)`, then copy from `out_ptr`.

In Node, pass the bytes: read `public/display.wasm` with `fs/promises` in the caller. In the browser, `fetch('/display.wasm')`.

- [ ] **Step 4: The test (`src/lib/display-wasm.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadDisplayWasm } from './display-wasm';

const wasmBytes = () => readFile('public/display.wasm').then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

describe('display wasm', () => {
  it('renders today’s 128x32 default byte-identically to the firmware golden', async () => {
    const w = await loadDisplayWasm(await wasmBytes());
    const fb = w.render({ status: 'loaded', bars: 3, title: 'Workbench 3.1 Install', detail: 'disk 1 of 6',
      showTrack: true, cyl: 0, maxCyl: 79, pct: -1, tick: 0, writable: true, sync: 'synced' }, 0, null);
    const golden = await readFile('wifi-floppy/firmware/test/fixtures/display_golden/mounted_w_t0.fb');
    expect(Buffer.from(fb.subarray(0, 512)).equals(golden)).toBe(true);
  });

  it('validates with the C rules', async () => {
    const w = await loadDisplayWasm(await wasmBytes());
    const bad = await readFile('wifi-floppy/firmware/test/fixtures/layouts/bad_bounds.bin');
    expect(w.validate(new Uint8Array(bad))).toMatch(/outside/);
    expect(w.validate(w.defaultBlob(1))).toBeNull();
  });
});
```

- [ ] **Step 5: Build, test, commit**

```bash
pnpm display:wasm
pnpm vitest run src/lib/display-wasm.test.ts
wifi-floppy/firmware/test/run.sh | tail -3          # the staleness check passes
git add wifi-floppy/firmware/wasm scripts/display-wasm.sh src/lib/display-wasm.ts src/lib/display-wasm.test.ts \
        public/display.wasm src/lib/display-wasm.version package.json wifi-floppy/firmware/test/run.sh
git commit -m "feat(display): the board's renderer and validator as WebAssembly, with a staleness check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Server: columns, encoder, endpoints, cursor, status

**Files:**
- Create: `drizzle/0030_display_layouts.sql`, `src/lib/display-layout.ts`, `src/lib/display-layout.test.ts`, `src/app/api/devices/[id]/display/route.ts`, `src/app/api/devices/[id]/display/route.test.ts`, `src/app/api/device/display/route.ts`
- Modify: `src/db/schema/devices.ts`, `src/app/api/device/poll/route.ts`, `src/lib/mount.ts` (`readPollTick`, `recordStatus`), `src/app/api/device/status/route.ts`, `src/lib/queries.ts` (`DeviceListItem`, `listDevices`), `src/lib/live-state.ts`

**Interfaces:**
- Consumes: `loadDisplayWasm` (Task 7); the layout fixtures (Task 2).
- Produces:
  - `src/lib/display-layout.ts`:
    - `ELEMENT_NAMES` (index = id - 1);
    - `type LayoutJson = { panel: '128x32' | '128x64'; elements: ElementJson[] }`;
    - `encodeLayout(j: LayoutJson): Uint8Array`;
    - `decodeLayout(b: Uint8Array): LayoutJson` (for loading into the editor);
    - `panelId(p: LayoutJson['panel']): 0 | 1`.
  - `DeviceListItem` gains `displayPanel: '128x32' | '128x64'`, `displayVersion: number`,
    `displayAppliedVersion: number | null`, `displayError: string | null`, `displayLayouts: boolean`,
    `displayLayout: string | null` (base64 for the editor).

- [ ] **Step 1: Migration and schema**

```sql
-- drizzle/0030_display_layouts.sql  (spec 2026-10-04-oled-layouts §7; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_panel" text DEFAULT '128x32' NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_layout" bytea;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_applied_version" integer;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_error" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_layouts" boolean;
```

Add the matching columns to `src/db/schema/devices.ts`, using `customType` for bytea if the schema has none yet:
check `grep -n bytea src/db/schema/*.ts`. Run `pnpm db:generate --name display_layouts`, then trim the generated SQL
to exactly the file above (earlier migrations were hand-written; see HANDOFF 3au/0029). Keep the snapshot and
journal.

- [ ] **Step 2: Encoder + cross-language test (failing first)**

```ts
// src/lib/display-layout.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { encodeLayout, decodeLayout, type LayoutJson } from './display-layout';

const FIX = 'wifi-floppy/firmware/test/fixtures/layouts';

describe('display layout encoding', () => {
  for (const name of ['default32', 'default64', 'custom64', 'bad_bounds', 'bad_dup', 'bad_reserved']) {
    it(`${name}.json encodes to exactly ${name}.bin, and back`, async () => {
      const json = JSON.parse(await readFile(`${FIX}/${name}.json`, 'utf8')) as LayoutJson;
      const bin = new Uint8Array(await readFile(`${FIX}/${name}.bin`));
      if (name === 'bad_reserved') return;   // carries a nonzero reserved byte JSON cannot express
      expect(Buffer.from(encodeLayout(json)).equals(Buffer.from(bin))).toBe(true);
      expect(decodeLayout(bin)).toEqual(json);
    });
  }
});
```

Implement `display-layout.ts` to the blob format in Global Constraints. Names map in order:
`['status','wifi','write','title','detail','track','download','lemming']`. For `bad_dup`, the JSON lists the
duplicated name twice, which the encoder must allow so the validator can refuse it.

- [ ] **Step 3: The PATCH route (tests first)**

`src/app/api/devices/[id]/display/route.test.ts`: copy the mocking style of the nearest existing device route test
(`src/app/api/devices/firmware-update/route.test.ts`). Cover:
- `invalid_layout` 400 with the WebAssembly reason, using `bad_bounds.json`;
- `firmware_too_old` 409 when `display_layouts` is not true, with reason exactly "Needs firmware 1.7.0 or newer";
- 404 for another org's device;
- 200 `{ version }` raises the version;
- `{ reset: true }` clears the layout and raises the version.

Then write the route:

```ts
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireOrg } from '@/lib/session';
import { encodeLayout } from '@/lib/display-layout';
import { loadDisplayWasm, type DisplayWasm } from '@/lib/display-wasm';
import { saveDisplay } from '@/lib/display-store';   // a small module: org-scoped read + update, below

let wasm: Promise<DisplayWasm> | null = null;
const getWasm = () => (wasm ??= readFile(path.join(process.cwd(), 'public', 'display.wasm'))
  .then((b) => loadDisplayWasm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))));

const element = z.object({
  id: z.enum(['status', 'wifi', 'write', 'title', 'detail', 'track', 'download', 'lemming']),
  visible: z.boolean(), scale: z.union([z.literal(1), z.literal(2)]),
  x: z.number().int().min(0).max(255), y: z.number().int().min(0).max(255),
  w: z.number().int().min(0).max(255), opt: z.number().int().min(0).max(255),
});
const body = z.union([
  z.object({ reset: z.literal(true), panel: z.enum(['128x32', '128x64']) }),
  z.object({ panel: z.enum(['128x32', '128x64']), elements: z.array(element).max(16) }),
]);

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown; try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });

  let blob: Uint8Array | null = null;
  if (!('reset' in parsed.data)) {
    blob = encodeLayout(parsed.data);
    const why = (await getWasm()).validate(blob);
    if (why) return Response.json({ error: 'invalid_layout', reason: why }, { status: 400 });
  }
  const r = await saveDisplay(orgId, id, parsed.data.panel, blob);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (r === 'firmware_too_old') {
    return Response.json({ error: 'firmware_too_old', reason: 'Needs firmware 1.7.0 or newer' }, { status: 409 });
  }
  return Response.json({ version: r.version });
}
```

`src/lib/display-store.ts` (`saveDisplay`) is ONE org-scoped
`update devices set display_panel, display_layout, display_version = display_version + 1 where id = $1 and org_id = $2 and display_layouts is true returning display_version`.
- If no row comes back, a second read decides between `not_found` (no row for this org) and `firmware_too_old`
  (the row exists but `display_layouts` is not true).
- A panel change without a layout (reset) stores `display_layout = null`.

- [ ] **Step 4: The device GET, poll cursor and status**

`src/app/api/device/display/route.ts`:
1. `requireDevice` (copy `src/app/api/device/firmware`'s auth handling).
2. Read `display_version`, `display_panel`, `display_layout`.
3. Respond `application/octet-stream`, `cache-control: no-store`, with the body
   `[u32 BE version][u8 panel id][u8 has_layout][layout bytes]`.

Poll route:
- **Cursor:** parse `displayAck` exactly like `nfcAck`: absent → `null`, garbled → 0.
- **`readPollTick`:** add `displayVersion: devices.displayVersion` to its single-row select.
- **The wake:** `const displayMoved = displayAck !== null && tick.displayVersion > displayAck;`, added to the hold's
  wake condition.
- **The body:** include `displayVersion: tick.displayVersion` whenever `displayAck !== null`. Keep it out of the body
  when the board did not send the param (old boards).
- **Comments:** next to the existing nfc comments, explain why a rejected layout cannot loop: the board acks what it
  handled.

Status route:
- **Schema:** add `displayLayouts: z.boolean().optional().catch(undefined)`,
  `displayVersion: z.number().int().min(0).optional().catch(undefined)` and
  `displayError: z.string().max(80).nullable().optional().catch(undefined)`.
- **`recordStatus`:** set `displayLayouts`, `displayAppliedVersion` and `displayError` when present. When
  `firmwareVersion` is present but `displayLayouts` absent, set `displayLayouts = false`, the same rule `playsHd`
  uses at `mount.ts:311`.

`DeviceListItem`/`listDevices` and `live-state.ts`: select the six display fields (`displayLayout` encoded base64 in
`listDevices`). Live state carries `displayAppliedVersion`, `displayVersion` and `displayError`, so the editor's
status line updates.

- [ ] **Step 5: Run, apply the migration, commit**

```bash
pnpm vitest run src/lib/display-layout.test.ts "src/app/api/devices/[id]/display" src/app/api/device
pnpm vitest run 2>&1 | tail -3
DB=$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"'); psql "$DB" -v ON_ERROR_STOP=1 -f drizzle/0030_display_layouts.sql
git add drizzle src/db/schema/devices.ts src/lib/display-layout.ts src/lib/display-layout.test.ts src/lib/display-store.ts \
        "src/app/api/devices/[id]/display" src/app/api/device/display src/app/api/device/poll/route.ts \
        src/app/api/device/status/route.ts src/lib/mount.ts src/lib/queries.ts src/lib/live-state.ts
git commit -m "feat(display): per-board display layouts on the server -- migration 0030, encoder, PATCH, device GET, poll cursor, status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The migration is additive and goes to the live database before e2e, as 0029 did. Record it in the commit body.

---

### Task 9: The editor

**Files:**
- Create: `src/components/devices/display-editor.tsx`
- Modify: `src/components/devices/device-card.tsx` (render `<DisplayEditor device={device} />` in a collapsible "Display" section below the existing rows, before `lastError`)

**Interfaces:**
- Consumes: `loadDisplayWasm`, `PreviewState` (Task 7); `encodeLayout`, `decodeLayout`, `LayoutJson`,
  `ELEMENT_NAMES` (Task 8); the `DeviceListItem` display fields (Task 8).

- [ ] **Step 1: The component**

Behaviour, with every value from the spec:
- **Collapsed by default:** a "Display" disclosure button (`data-testid="display-toggle-<id>"`). Opening it loads the
  WebAssembly module once (module-level promise).
- **When `device.displayLayouts` is false:** render only the line "Needs firmware 1.7.0 or newer"
  (`data-testid="display-needs-fw-<id>"`), with no editor.
- **Panel select** (`display-panel-<id>`), 128×32 or 128×64. Changing it loads that panel's default layout from
  `defaultBlob` into the editor state (unsaved).
- **Canvas** (`display-canvas-<id>`), 4× zoom: 512×(4 × rows). Draw every lit pixel of the framebuffer from
  `render(previewState, panelId, encodeLayout(layout))` as a 4×4 rectangle in `var(--ink)` on `var(--panel-bg)`.
  Re-render on every layout or preview-state change (cheap: about 1 KB).
- **Drag:**
  1. `pointerdown` on the canvas hit-tests the element boxes (from §4 sizes) in reverse draw order and captures the
     pointer.
  2. `pointermove` moves `x, y` by `Math.round(delta / 4)`; with "snap" ticked, rounds to 8 px; 2× elements always
     round to even coordinates.
  3. Positions are clamped so the element stays inside the panel.

  Use pointer events, so touch works.
- **Side list:** one row per element, with show/hide (`display-visible-<name>`), 1×/2× (`display-scale-<name>`), and
  box width/lines inputs for title and detail, bar width for download.
- **"Preview as" select** (`display-preview-<id>`):
  - Ready: `status: 'ready'`, title "no disk";
  - Downloading 64 %: `download`, pct 64;
  - Mounted, writable: `loaded`, title "Workbench 3.1 Install", detail "disk 1 of 6", showTrack, cyl 42, writable;
  - Mounted, read-only: as before, but `writable: false`;
  - Long title: "Gods v1.00 (1991-03-28)(Renegade)(Disk 1 of 2)".

  `tick` advances every 500 ms, so the lemming walks.
- **Overlaps:** any two visible elements whose boxes intersect get a 1-px amber outline on the canvas.
- **Live validation:** run `validate(blob)` on every change. When invalid, show the reason in amber and disable Save.
- **Save** (`display-save-<id>`) PATCHes `{ panel, elements }`. **Reset** (`display-reset-<id>`) PATCHes
  `{ reset: true, panel }`. Errors are shown from `reason`.
- **Status line** (`display-status-<id>`), showing both values of the state:
  - `displayError` set → "The board rejected it: \<error\>";
  - `displayAppliedVersion === displayVersion` → "Applied on the board";
  - otherwise → "Waiting for the board".
- **Loading the board's layout:** `device.displayLayout` (base64) → `decodeLayout`. When null, use `defaultBlob` for
  `displayPanel`.

Follow the device card's existing style tokens (`var(--input-bg)`, `var(--amber-text)`, etc.) and its comment
density.

- [ ] **Step 2: Typecheck, lint, run the unit suite; check by hand on the dev server**

Run: `npx tsc --noEmit -p . && pnpm lint 2>&1 | tail -5 && pnpm vitest run 2>&1 | tail -3`

Start the dev server on 3100 and open `/devices` with a seeded device that reports `displayLayouts: true` (Task 10's
helper can make one). Drag the title and check the canvas pixels move. Take a screenshot into the scratchpad and
look at it.

- [ ] **Step 3: Commit**

```bash
git add src/components/devices/display-editor.tsx src/components/devices/device-card.tsx
git commit -m "feat(display): the per-board layout editor -- WASM preview, drag, show/hide, 1x/2x, preview states, save/reset, applied status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: e2e

**Files:**
- Create: `e2e/display-layout.spec.ts`

- [ ] **Step 1: Write the spec**

Use `signUpFresh`, `pairDevice` and `authHeader` from `e2e/device-helpers.ts` and `e2e/helpers.ts`. The tests:
1. **Old firmware:** pair a board and do not report `displayLayouts`. Open `/devices`, open Display, and
   `display-needs-fw-<id>` shows "Needs firmware 1.7.0 or newer". Review Focus 4.
2. **Save and apply:**
   1. Report status with `displayLayouts: true, displayVersion: 0`.
   2. Open the editor, choose 128×64, drag the title down 8 px (`page.mouse` on the canvas), and Save.
   3. Read the device row: `display_version` is 1 and `display_panel` is `128x64`.
   4. As the board, GET `/api/device/display` with the device token. Check the body's first 4 bytes are version 1
      and the panel byte is 1.
   5. Report `displayVersion: 1`. The status shows "Applied on the board" (reload, or wait for live state).
3. **A rejected layout:** report `displayVersion: 1, displayError: 'outside the panel'`. The status shows "The board
   rejected it: outside the panel".
4. **Invalid in the editor:**
   1. With the canvas disabled, set the title box width to 8 via the side-list input.
   2. The amber reason names the width rule, and Save is disabled.
   3. A direct PATCH with `bad_bounds.json`'s elements returns 400 `invalid_layout`.
5. **The poll cursor:**
   - As the board, GET `/api/device/poll?since=0&nfcAck=0&displayAck=0` after a save: it returns at once with
     `displayVersion: 2`.
   - With `displayAck=2`, it does not wake for display (a 204 after the hold; use the route's test hold or accept
     the 25 s wait in this one test).

- [ ] **Step 2: Run it alone, then the full suite**

```bash
PORT=3100 BETTER_AUTH_URL=http://localhost:3100 pnpm dev --port 3100 > /tmp/dev3100.log 2>&1 &   # your own PID; stop it yourself after
PORT=3100 npx playwright test e2e/display-layout.spec.ts --reporter=line
```

Then the full suite, in foreground chunks under 9 minutes (for example by spec-file groups), with no other e2e
running. Grep the summary for `failed`, not just the exit code. Re-run any failure in isolation, and on master, before
blaming the code.

- [ ] **Step 3: Commit**

```bash
git add e2e/display-layout.spec.ts
git commit -m "test(e2e): display layout editor -- old firmware, save and apply, rejection, validation, poll cursor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Release 1.7.0, bench, record (controller)

This is the controller's job, not a subagent's. It needs the operator at the bench and the firmware-install
authorization (memory `firmware-installs-authorized`).

- [ ] **Step 1:** Bump `FIRMWARE_SEMVER` to `1.7.0`, commit, and build clean (no `-dirty`). Run `pnpm firmware:test`,
  `pnpm display:wasm`, and check the version file is unchanged and committed. Dry-run `pnpm firmware:publish`, then
  publish. Install through `.fw-target.mts` (it ejects; note the mounted disk and put it back with `setDesired`
  afterwards).
- [ ] **Step 2: Bench**, one step per turn, asked last in the turn:
  1. The 128×32 panel looks unchanged.
  2. With the 0.92" 128×64 panel fitted, choose 128×64 in the editor: the full panel draws, not half.
  3. A custom layout appears within one poll and survives a USB replug, with the drive empty at least once so it is
     written to flash.
  4. Force a rejection (save a layout with the server check bypassed, by PATCHing a crafted blob through a test-only
     path, or by checking that the editor's own validation makes this unreachable). The panel is unchanged and the
     editor shows the reason.
- [ ] **Step 3:** Write HANDOFF section `3ax`: what shipped, the rulings, bench results, and deferred items. Merge
  after the full e2e passes, and push.

---

## Self-review (done while writing)

**Spec coverage:**
- §1 done means: Task 3 (golden), Task 4 (64-row), Tasks 6/8 (one poll), Task 5 (reboot), Tasks 6/8/9 (rejection).
- §4 elements and sizes: Task 2. §5 format and validator: Task 2. §5 web encodes only: Task 8.
- §6 renderer: Task 3. Driver: Task 4. Store: Task 5. Protocol: Task 6.
- §7 migration and API: Task 8. Editor: Task 9. WebAssembly: Task 7.
- §8 tests: Tasks 1-10. Bench: Task 11.

**Rulings:** three rulings refine the spec (built-in screens use the default layout; the binary device endpoint; ack
on reject). They are stated in Global Constraints.

**Type names:** consistent across tasks: `layout_t`, `layout_el_t`, `panel_t`, `layout_decode`, `layout_encode`,
`layout_default`, `display_layout_for`, `display_set_layout`, `display_set_panel`, `display_record_t`,
`display_store_*`, `dc_display_*`, `DisplayWasm`, `encodeLayout`, `decodeLayout`.

**Review Focus:** each line has its test in the owning task (1: Tasks 1 and 3; 2: Task 5; 3: Task 6 and Task 8's
route; 4: Tasks 8 and 10; 5: Task 4).
