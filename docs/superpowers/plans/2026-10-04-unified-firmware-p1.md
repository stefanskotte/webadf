# Unified firmware P1: board table and net_radio on the PIM726 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every pin, the I2C instance and every WiFi-chip call behind two seams (a board table and a
`net_radio` interface), with exactly one board (PIM726) and one radio (CYW43). The board's behaviour must not change.

**Architecture:**
- `board.h`/`board.c` hold a `board_t` per module, plus `g_board`, a pointer fixed at compile time to `BOARD_PIM726`.
  `floppy_io.h`'s `PIN_*` names stay, but each now reads a field of `*g_board`, so ~60 call sites need no edit. A pure,
  host-tested `board_check()` holds the invariants the PIO programs depend on.
- `net_radio.h` is the radio seam. `net_radio_cyw43.c` is the only file allowed to name `cyw43_`/`CYW43_`, enforced by
  a grep guard in `test/run.sh`.
- lwIP, mbedTLS and all transport code stay exactly as they are.

**Tech Stack:** C11, pico-sdk 2.3.0 (RP2350, `pico_cyw43_arch_lwip_threadsafe_background`), lwIP, host tests under
clang via `wifi-floppy/firmware/test/run.sh` (`-Wall -Wextra -Werror`).

**Spec:** `docs/superpowers/specs/2026-10-04-unified-firmware-design.md` (§3, §5, §8, §11 phase P1).

## Global Constraints

- **No behaviour change on the PIM726:** same pins, same I2C bus (i2c1, GP18/19), same radio calls in the same order,
  same log lines, with two intended exceptions:
  - one new `board:` line at boot;
  - the radio-init failure line reads `radio init failed, radio is dead` instead of
    `cyw43_arch_init failed, radio is dead`. The guard forbids `cyw43_` outside comments, string literals included.
- PSRAM is still started by the SDK before `main()` (`PICO_PSRAM_CS_PIN` from the board header). §7 is **P2**, not here.
- `drive_id` still waits on `gpio 2` literally (P2 lifts it). `board_check()` therefore requires `sel0 == 2`.
- The step tracker reads SEL0..DIR as `in pins, 4`. `board_check()` requires `sel1 == sel0+1`, `mtr == sel0+2` and
  `dir == sel0+3`.
- The status gate drives an OUT window GP0..GP(`BUS_GATE_OUT_COUNT` - 1) (14). Every status pin must be below 14.
- Host build: `cc -std=c11 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1`. Device-only files are excluded by name in
  `test/run.sh`, and every new device-only file must be added to that exclusion.
- Device build: `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"` then
  `pnpm firmware:build` from the repo root. Leave `PORTAL_AP_PASSWORD` unset (CMake defaults it).
- **Never `git stash`, in any form, for any reason** (shared stash across worktrees and sessions). To compare with an
  earlier state, use `git show <sha>:<path>`.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- The version bump to 1.6.3 happens only in Task 4.

## Review Focus

1. **A `PIN_*` used where C needs a constant expression** (a `case` label, a file-scope initialiser, `_Static_assert`,
   an array size) stops compiling once `PIN_*` reads `g_board`. Expected: Task 1 finds every such use with the device
   build and turns it into a runtime form. The only known one, `bus_out.c:21`'s `_Static_assert`, becomes
   `board_check()` at boot.
2. **`g_board` read before anything sets it** (ISRs, `bus_gate` in host tests). Expected: `g_board` is a
   compile-time-initialised `const board_t *const`, so there is no window. Task 1's
   `test_board_default_is_pim726` pins it.
3. **The lock must stay recursive.** `default_route_str()` takes the lwIP lock while callers may already hold it
   (main.c's comment: "cyw43_arch_lwip_begin()/end() is recursive"). Expected: `net_radio_lock()` is a direct call
   to `cyw43_arch_lwip_begin()`, with identical semantics. Task 2's bench check reads the
   `default route now w00 ip=...` line after the portal.
4. **The panel's portal SSID versus the AP's real SSID.** `main.c:1192` reads `cyw43_hal_get_mac(0)`;
   `portal_net.c:720` reads `cyw43_wifi_get_mac(STA)`. Both become `net_radio_mac()`. Expected: the SSID on the OLED
   equals the SSID the AP advertises. Task 3's bench step compares them; if they ever differed, the panel was wrong
   before.
5. **The guard's false positives and negatives.** Comments all over the tree mention `cyw43_`. Expected: the
   `run.sh` guard strips `//` comments and `/* */` single-line comments before matching. It catches `cyw43_state` and
   `CYW43_ITF_STA`, not just calls. Task 3 proves it by mutation: a deliberate `cyw43_` call outside the allowed file
   must fail the run.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `wifi-floppy/firmware/src/board.h` | `board_t`, `BOARD_PIM726`, `g_board`, `board_check()`; host-portable | 1 |
| `wifi-floppy/firmware/src/board.c` | the PIM726 values, the invariants | 1 |
| `wifi-floppy/firmware/src/board_hw.h` | device-only: `board_i2c()` maps the board's I2C index to `i2c0`/`i2c1` | 1 |
| `wifi-floppy/firmware/test/test_board.c` | host tests for `board_check()` and the default board | 1 |
| `wifi-floppy/firmware/src/floppy_io.h` | `PIN_*` read `g_board` (names unchanged) | 1 |
| `wifi-floppy/firmware/src/bus_out.c` | the `_Static_assert` goes (enforced by `board_check()` at boot instead) | 1 |
| `wifi-floppy/firmware/src/main.c` | boot: `board_check()` + `board:` log line; later all radio calls via `net_radio` | 1, 2, 3 |
| `wifi-floppy/firmware/src/i2c_probe.c`, `ssd1306.c`, `nfc_bus_i2c.c` | `i2c1` → `board_i2c()` | 1 |
| `wifi-floppy/firmware/src/net_radio.h` | the radio seam; no SDK types except `struct netif` (lwIP is shared) | 2 |
| `wifi-floppy/firmware/src/net_radio_cyw43.c` | the only file that may name `cyw43_`/`CYW43_` | 2, 3 |
| `wifi-floppy/firmware/src/transport_tls.c`, `sntp_time.c`, `portal_net.c` | lock calls → `net_radio_lock/unlock`; portal radio calls → `net_radio_*` | 2, 3 |
| `wifi-floppy/firmware/CMakeLists.txt` | add `board.c`, `net_radio_cyw43.c`; version 1.6.3 | 1, 2, 4 |
| `wifi-floppy/firmware/test/run.sh` | exclude `net_radio_cyw43.c`; the `cyw43_` guard | 2, 3 |
| `HANDOFF.md` | the P1 record | 4 |

---

### Task 1: The board table

**Files:**
- Create: `wifi-floppy/firmware/src/board.h`, `wifi-floppy/firmware/src/board.c`, `wifi-floppy/firmware/src/board_hw.h`, `wifi-floppy/firmware/test/test_board.c`
- Modify: `wifi-floppy/firmware/src/floppy_io.h` (the pin `#define`s), `wifi-floppy/firmware/src/bus_out.c:21`, `wifi-floppy/firmware/src/main.c` (boot), `wifi-floppy/firmware/src/i2c_probe.c:30,45`, `wifi-floppy/firmware/src/ssd1306.c:56,103,127`, `wifi-floppy/firmware/src/nfc_bus_i2c.c:8,17,18`, `wifi-floppy/firmware/CMakeLists.txt` (sources)

**Interfaces:**
- Produces: `typedef struct board board_t;` with the fields below; `extern const board_t BOARD_PIM726;`;
  `extern const board_t *const g_board;`; `bool board_check(const board_t *b, char *why, size_t why_len);`; and, in
  device-only `board_hw.h`, `i2c_inst_t *board_i2c(void);`.

- [ ] **Step 1: Write the failing test**

Create `wifi-floppy/firmware/test/test_board.c`:

```c
#include <stdio.h>
#include <string.h>
#include "../src/board.h"
#include "../src/bus_gate.h"

static int checks, failed;
#define CHECK(c, msg) do { checks++; if (!(c)) { failed++; printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); } } while (0)

static void test_board_default_is_pim726(void) {
    CHECK(g_board == &BOARD_PIM726, "g_board points at the PIM726 before anything runs");
    CHECK(strcmp(g_board->name, "pim726") == 0, "name");
}

static void test_pim726_matches_rev_b(void) {
    // The rev B netlist (pnpm hw:verify) and floppy_io.h as of 1.6.2.
    const board_t *b = &BOARD_PIM726;
    CHECK(b->sel0 == 2 && b->sel1 == 3 && b->mtr == 4 && b->dir == 5, "SEL0..DIR GP2-5");
    CHECK(b->step == 6 && b->wdata == 7 && b->wgate == 8 && b->side == 9, "inputs GP6-9");
    CHECK(b->wprot == 10 && b->rdata == 11 && b->rdy == 12 && b->trk0 == 13, "outputs GP10-13");
    CHECK(b->index == 0 && b->chng == 1, "INDEX GP0, CHNG GP1");
    CHECK(b->act_led == 22 && b->i2c_sda == 18 && b->i2c_scl == 19 && b->i2c_index == 1, "LED, I2C1");
}

static void test_pim726_passes(void) {
    char why[96] = "";
    CHECK(board_check(&BOARD_PIM726, why, sizeof why), why);
}

static board_t broken(void) { return BOARD_PIM726; }

static void expect_fail(board_t b, const char *needle, const char *label) {
    char why[96] = "";
    bool ok = board_check(&b, why, sizeof why);
    CHECK(!ok, label);
    CHECK(strstr(why, needle) != NULL, label);
}

static void test_each_invariant_is_enforced(void) {
    board_t b;
    b = broken(); b.sel1 = 7;            expect_fail(b, "consecutive", "SEL1 not SEL0+1");
    b = broken(); b.dir = 9;             expect_fail(b, "consecutive", "DIR not SEL0+3");
    b = broken(); b.sel0 = 26; b.sel1 = 27; b.mtr = 28; b.dir = 29;
                                         expect_fail(b, "GP2", "drive_id still needs SEL0 == GP2 in P1");
    b = broken(); b.step = b.wdata;      expect_fail(b, "twice", "two roles on one pin");
    b = broken(); b.rdy = 20;            expect_fail(b, "window", "status pin outside the status_gate window");
    b = broken(); b.radio_pins[0] = b.step;
                                         expect_fail(b, "radio", "a role on a radio pin");
    b = broken(); b.i2c_index = 2;       expect_fail(b, "I2C", "I2C index must be 0 or 1");
}

static void test_why_is_always_terminated(void) {
    board_t b = broken(); b.sel1 = 7;
    char why[8];
    memset(why, 'x', sizeof why);
    board_check(&b, why, sizeof why);
    CHECK(memchr(why, '\0', sizeof why) != NULL, "why is NUL-terminated even when truncated");
}

int main(void) {
    test_board_default_is_pim726();
    test_pim726_matches_rev_b();
    test_pim726_passes();
    test_each_invariant_is_enforced();
    test_why_is_always_terminated();
    printf("test_board.c: %d checks, %d failed\n", checks, failed);
    return failed ? 1 : 0;
}
```

- [ ] **Step 2: Run the test and see it fail**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_board|COMPILE FAIL"`
Expected: `COMPILE FAIL: test_board.c` (`board.h` does not exist yet).

- [ ] **Step 3: Write `board.h`**

```c
#ifndef BOARD_H
#define BOARD_H
// Which module this firmware is running on, and where its signals are
// (spec 2026-10-04-unified-firmware-design.md §5). P1 has ONE board, the
// PIM726 (Pimoroni Pico Plus 2 W), and g_board is fixed to it at compile
// time; P2 chooses at boot from the RP2350 package. Host-portable: no SDK
// types, so bus_gate.c and its tests can read pins through it.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BOARD_RADIO_PINS_MAX 8

typedef struct board {
    const char *name;               // "pim726"; logged at boot
    // Floppy inputs (via 74LVC541A). SEL0..DIR MUST be consecutive in this
    // order: floppy.pio's step_dir reads them as one `in pins, 4`.
    uint8_t sel0, sel1, mtr, dir;
    uint8_t step, wdata, wgate, side;
    // Floppy outputs (via BSS138: GPIO high asserts the bus line).
    uint8_t wprot, rdata, rdy, trk0, index, chng;
    // Aux.
    uint8_t act_led;
    uint8_t i2c_sda, i2c_scl;
    uint8_t i2c_index;              // 0 = i2c0, 1 = i2c1 (board_hw.h maps it)
    // Pins the module's radio owns. No role may land on one.
    uint8_t radio_pins[BOARD_RADIO_PINS_MAX];
    uint8_t radio_pin_count;
} board_t;

extern const board_t BOARD_PIM726;

// The board this firmware runs on. A const pointer initialised at compile
// time, so it is valid in every ISR and in host tests with no init call.
extern const board_t *const g_board;

// True when `b` satisfies everything the firmware relies on. On false,
// `why` (always NUL-terminated) says which rule broke. Used by the host tests
// and once at boot (main.c), where a failure stops the board before any
// pin is driven.
bool board_check(const board_t *b, char *why, size_t why_len);

#endif
```

- [ ] **Step 4: Write `board.c`**

```c
#include "board.h"
#include "bus_gate.h"   // BUS_GATE_OUT_COUNT: the status_gate OUT window
#include <stdio.h>

const board_t BOARD_PIM726 = {
    .name = "pim726",
    .sel0 = 2, .sel1 = 3, .mtr = 4, .dir = 5,
    .step = 6, .wdata = 7, .wgate = 8, .side = 9,
    .wprot = 10, .rdata = 11, .rdy = 12, .trk0 = 13, .index = 0, .chng = 1,
    .act_led = 22,
    .i2c_sda = 18, .i2c_scl = 19, .i2c_index = 1,
    // RM2 on the PIM726 (pico-sdk pimoroni_pico_plus2_w_rp2350.h):
    // WL_REG_ON 23, WL_DATA 24, WL_CS 25, WL_CLOCK 29.
    .radio_pins = {23, 24, 25, 29}, .radio_pin_count = 4,
};

const board_t *const g_board = &BOARD_PIM726;

static bool fail(char *why, size_t n, const char *msg) {
    if (n) snprintf(why, n, "%s", msg);
    return false;
}

bool board_check(const board_t *b, char *why, size_t n) {
    if (n) why[0] = '\0';
    if (b->sel1 != b->sel0 + 1 || b->mtr != b->sel0 + 2 || b->dir != b->sel0 + 3)
        return fail(why, n, "SEL0,SEL1,MTR,DIR must be consecutive (step_dir in pins, 4)");
    if (b->sel0 != 2)
        return fail(why, n, "SEL0 must be GP2 until P2 (drive_id waits on gpio 2)");
    if (b->i2c_index > 1)
        return fail(why, n, "I2C index must be 0 or 1");

    const uint8_t roles[] = {
        b->sel0, b->sel1, b->mtr, b->dir, b->step, b->wdata, b->wgate, b->side,
        b->wprot, b->rdata, b->rdy, b->trk0, b->index, b->chng,
        b->act_led, b->i2c_sda, b->i2c_scl,
    };
    const size_t nroles = sizeof roles / sizeof roles[0];
    for (size_t i = 0; i < nroles; i++) {
        for (size_t j = i + 1; j < nroles; j++)
            if (roles[i] == roles[j]) return fail(why, n, "a pin is used twice");
        for (size_t r = 0; r < b->radio_pin_count && r < BOARD_RADIO_PINS_MAX; r++)
            if (roles[i] == b->radio_pins[r]) return fail(why, n, "a role sits on a radio pin");
    }

    const uint8_t status[] = { b->wprot, b->rdy, b->trk0, b->index, b->chng };
    for (size_t i = 0; i < sizeof status; i++)
        if (status[i] >= BUS_GATE_OUT_COUNT)
            return fail(why, n, "a status pin is outside the status_gate window");
    return true;
}
```

- [ ] **Step 5: Run the test and see it pass**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_board|FAIL"`
Expected: `test_board.c: 25 checks, 0 failed` (the count is whatever the file makes, 0 failed) and no `FAIL` lines.

- [ ] **Step 6: Make `PIN_*` read the board**

In `wifi-floppy/firmware/src/floppy_io.h`, replace the 17 pin `#define`s (keep every comment block exactly where it
is) with:

```c
#include "board.h"
// The pin map lives in board.c (spec 2026-10-04 §5); these names stay so the
// ~60 call sites and test/run.sh's gpio_put guard read as before. They are
// runtime reads of *g_board now: never use one where C needs a constant.
#define PIN_SEL0    (g_board->sel0)
#define PIN_SEL1    (g_board->sel1)
#define PIN_MTR     (g_board->mtr)
#define PIN_DIR     (g_board->dir)      // high = step outwards (towards track 0) per Shugart DIRC
#define PIN_STEP    (g_board->step)
#define PIN_WDATA   (g_board->wdata)    // PIO capture
#define PIN_WGATE   (g_board->wgate)
#define PIN_SIDE    (g_board->side)     // low = side 1 (upper head)
// Outputs drive BSS138 gates: GPIO HIGH  ->  bus line pulled LOW (asserted).
#define PIN_WPROT   (g_board->wprot)
#define PIN_RDATA   (g_board->rdata)    // PIO side-set
#define PIN_RDY     (g_board->rdy)
#define PIN_TRK0    (g_board->trk0)
#define PIN_INDEX   (g_board->index)    // north-edge pin; GP14/15 sit in antenna keepout
#define PIN_CHNG    (g_board->chng)
```

and later in the same file:

```c
#define PIN_ACT_LED  (g_board->act_led)
#define PIN_I2C_SDA  (g_board->i2c_sda)    // header pin 24 on the PIM726, I2C1 SDA
#define PIN_I2C_SCL  (g_board->i2c_scl)    // header pin 25 on the PIM726, I2C1 SCL
```

- [ ] **Step 7: Replace the compile-time assert with the boot check**

In `wifi-floppy/firmware/src/bus_out.c`, delete line 21
(`_Static_assert(PIN_SEL0 == 2, "floppy.pio's drive_id waits on GP2 literally");`) and put this comment in its place:

```c
// floppy.pio's drive_id waits on GP2 literally: board_check() (board.c)
// refuses any board whose SEL0 is not GP2, at boot, before this file runs.
```

In `wifi-floppy/firmware/src/main.c`, at the very start of `main()` (before the first pin, PIO or I2C call, and
after the log/stdio setup it already does so the line gets out), add:

```c
    {
        char why[96];
        if (!board_check(g_board, why, sizeof why)) {
            // A code error, not a field condition: the table in board.c is
            // wrong. Stop before driving a single pad; the OTA trial (if this
            // is one) reverts after FW_TRIAL_DEADLINE_MS with no heartbeat.
            wf_logf(WF_ERR, "board: %s fails its check: %s", g_board->name, why);
            while (1) tight_loop_contents();
        }
        wf_logf(WF_INFO, "board: %s", g_board->name);
    }
```

Read `main()` first to place this after whatever starts the log drain, and before `bus_out_init`, `i2c_probe_bus` and
any `gpio_init`. If the log is only drained by core0's loop later, the line is still queued. Put the check where
the existing `wifi-floppy boot:` line is logged, right after it.

- [ ] **Step 8: Route the I2C instance through the board**

Create `wifi-floppy/firmware/src/board_hw.h`:

```c
#ifndef BOARD_HW_H
#define BOARD_HW_H
// Device-only companion to board.h: SDK types live here, not there, so
// board.h stays host-portable.
#include "board.h"
#include "hardware/i2c.h"

static inline i2c_inst_t *board_i2c(void) {
    return g_board->i2c_index == 1 ? i2c1 : i2c0;
}
#endif
```

Replace every `i2c1` used as a value (not in comments) with `board_i2c()`: `i2c_probe.c:30` and `:45`,
`ssd1306.c:56`, `:103` and `:127`, `nfc_bus_i2c.c:8`, `:17` and `:18`. Add `#include "board_hw.h"` to those three
files. Log text that says `i2c1:` stays as is: on the PIM726 it is still i2c1, and P2 can reword it.

- [ ] **Step 9: Add the sources to the device build**

In `wifi-floppy/firmware/CMakeLists.txt`, add `src/board.c` to the `add_executable(wifi_floppy ...)` source list,
next to `src/bus_gate.c`. (`board.c` is host-portable, so `test/run.sh` picks it up through its `../src/*.c` glob
with no change.)

- [ ] **Step 10: Run the full host suite and the device build**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"`
Expected: no `FAIL`, no `COMPILE FAIL`, exit 0. `test_bus_gate.c` must pass unchanged: its 26 `PIN_` uses now read
`g_board`.

Run, from the repo root: `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"; pnpm firmware:build 2>&1 | grep -E "error|warning: |firmware version"`
Expected: no errors. If the compiler reports a `PIN_*` used as a constant expression (Review Focus 1), turn that use
into a runtime form at that site and note it in the commit message.

- [ ] **Step 11: Commit**

```bash
git add wifi-floppy/firmware/src/board.h wifi-floppy/firmware/src/board.c wifi-floppy/firmware/src/board_hw.h \
        wifi-floppy/firmware/test/test_board.c wifi-floppy/firmware/src/floppy_io.h wifi-floppy/firmware/src/bus_out.c \
        wifi-floppy/firmware/src/main.c wifi-floppy/firmware/src/i2c_probe.c wifi-floppy/firmware/src/ssd1306.c \
        wifi-floppy/firmware/src/nfc_bus_i2c.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "refactor(firmware): board table -- pins and I2C instance read g_board (PIM726 only, no behaviour change)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `net_radio`: the seam, and the lwIP lock through it

**Files:**
- Create: `wifi-floppy/firmware/src/net_radio.h`, `wifi-floppy/firmware/src/net_radio_cyw43.c`
- Modify: `wifi-floppy/firmware/src/transport_tls.c` (every `cyw43_arch_lwip_begin/end`, and the `#include "pico/cyw43_arch.h"`), `wifi-floppy/firmware/src/sntp_time.c:13,38,46`, `wifi-floppy/firmware/src/portal_net.c` (the lock calls only: setup_dhcp/dns/http, portal_run's result copy, portal_stop's two lock pairs), `wifi-floppy/firmware/src/main.c:217,220,925,928,933`, `wifi-floppy/firmware/CMakeLists.txt`, `wifi-floppy/firmware/test/run.sh`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (all of `net_radio.h`; Task 3 implements the rest, but the header is complete now):

```c
#ifndef NET_RADIO_H
#define NET_RADIO_H
// The WiFi chip behind one seam (spec 2026-10-04-unified-firmware-design.md
// §8). Everything above it -- lwIP, mbedTLS, transport_tls.c, the portal's
// servers, SNTP, OTA -- is shared. P1 has one implementation,
// net_radio_cyw43.c, which is the ONLY file that may name cyw43_/CYW43_
// (test/run.sh enforces it).
#include <stdbool.h>
#include <stdint.h>
struct netif;

/** Bring the radio up. Returns 0 on success, nonzero on failure. Core1 only. */
int  net_radio_init(void);
/** Station mode on (no association yet). */
void net_radio_sta_enable(void);
/** Associate with a WPA2-PSK network. Returns PICO_OK (0) or a PICO_ERROR_* code,
 *  exactly as cyw43_arch_wifi_connect_timeout_ms did (main.c's assoc_failure_message maps them). */
int  net_radio_sta_connect(const char *ssid, const char *pass, uint32_t timeout_ms);
/** Start / stop the WPA2-PSK access point the setup portal serves on. */
void net_radio_ap_start(const char *ssid, const char *pass);
void net_radio_ap_stop(void);
/** The station interface, to restore it as lwIP's default route after the AP. */
struct netif *net_radio_sta_netif(void);
/** The station MAC. */
void net_radio_mac(uint8_t mac[6]);
/** RSSI of the current association, dBm. */
int32_t net_radio_rssi(void);
/** The lwIP lock. RECURSIVE (callers nest it). Never from an interrupt. */
void net_radio_lock(void);
void net_radio_unlock(void);
#endif
```

- [ ] **Step 1: Write the guard first, scoped to the files this task migrates, and see it fail**

Add to `wifi-floppy/firmware/test/run.sh`, before the final `exit $fail`:

```bash
# Spec 2026-10-04 §8: the WiFi chip sits behind net_radio.h. Only
# net_radio_cyw43.c may name it. // and single-line /* */ comments are
# stripped first: comments all over the tree explain cyw43 behaviour, and
# that is welcome. Identifiers, not just calls: cyw43_state and CYW43_ITF_STA
# count.
radio_leak=$(for f in ../src/*.c ../src/*.h; do
  case "$f" in */net_radio_cyw43.c) continue ;; esac
  sed -E -e 's#//.*##' -e 's#/\*.*\*/##g' "$f" |
    { grep -nE '\b(cyw43_[a-z_]+|CYW43_[A-Z_]+|pico/cyw43_arch\.h)' || true; } | sed "s#^#$f:#"
done | grep -E "${RADIO_GUARD_FILES:-transport_tls|sntp_time}" || true)
if [ -n "$radio_leak" ]; then
  echo "$radio_leak"
  echo "FAIL: the WiFi chip is named outside net_radio_cyw43.c (use net_radio.h)"
  fail=1
fi
```

The `RADIO_GUARD_FILES` filter keeps the guard to the files this task finishes. Task 3 widens it to every file by
deleting the filter.

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -A2 "WiFi chip is named" | head; echo`
Expected: `FAIL: the WiFi chip is named outside net_radio_cyw43.c`, listing `transport_tls.c` and `sntp_time.c` lines.

- [ ] **Step 2: Create `net_radio.h`**

Write `wifi-floppy/firmware/src/net_radio.h` with exactly the content in this task's **Interfaces** block above.

- [ ] **Step 3: Create `net_radio_cyw43.c`**

```c
// The CYW43439 (RM2 on the PIM726) behind net_radio.h. Each function is the
// call it replaces, unchanged: P1 must not change behaviour. Device-only.
#include "net_radio.h"
#include "pico/cyw43_arch.h"
#include "lwip/netif.h"

int  net_radio_init(void)       { return cyw43_arch_init(); }
void net_radio_sta_enable(void) { cyw43_arch_enable_sta_mode(); }

int net_radio_sta_connect(const char *ssid, const char *pass, uint32_t timeout_ms) {
    return cyw43_arch_wifi_connect_timeout_ms(ssid, pass, CYW43_AUTH_WPA2_AES_PSK, timeout_ms);
}

void net_radio_ap_start(const char *ssid, const char *pass) {
    cyw43_arch_enable_ap_mode(ssid, pass, CYW43_AUTH_WPA2_AES_PSK);
}
void net_radio_ap_stop(void) { cyw43_arch_disable_ap_mode(); }

struct netif *net_radio_sta_netif(void) { return &cyw43_state.netif[CYW43_ITF_STA]; }

void net_radio_mac(uint8_t mac[6]) { cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac); }

int32_t net_radio_rssi(void) {
    int32_t rssi = 0;
    cyw43_wifi_get_rssi(&cyw43_state, &rssi);
    return rssi;
}

void net_radio_lock(void)   { cyw43_arch_lwip_begin(); }
void net_radio_unlock(void) { cyw43_arch_lwip_end(); }
```

Add `src/net_radio_cyw43.c` to `add_executable` in `CMakeLists.txt`. In `test/run.sh`, add `net_radio_cyw43\.c|` to
the exclusion regex in the `$(ls ../src/*.c | grep -vE '...')` line, and add a line to the device-only comment block
at the top:

```bash
#   net_radio_cyw43.c - the CYW43 driver behind net_radio.h (spec 2026-10-04 §8);
#                       each function is one SDK call, nothing to judge on a host
```

- [ ] **Step 4: Migrate the lock callers in `transport_tls.c` and `sntp_time.c`**

In both files:
- replace `#include "pico/cyw43_arch.h"` with `#include "net_radio.h"`;
- replace every `cyw43_arch_lwip_begin()` with `net_radio_lock()`;
- replace every `cyw43_arch_lwip_end()` with `net_radio_unlock()`.

Comments that explain the cyw43 concurrency model stay word for word: they describe the CYW43 implementation, which
is still what runs.

If `transport_tls.c` uses another `cyw43_` symbol beyond the lock (check with
`grep -n "cyw43_\|CYW43_" wifi-floppy/firmware/src/transport_tls.c | grep -v "^\s*[0-9]*:\s*//"`), stop and report it.
This plan assumes there is none.

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -c "WiFi chip is named"`
Expected: `0`.

- [ ] **Step 5: Migrate the remaining lock calls in `portal_net.c` and `main.c`**

`portal_net.c`: in `setup_dhcp`, `setup_dns`, `setup_http`, `portal_run`'s `*out = g_pending_cfg` copy and both lock
pairs in `portal_stop`, replace `cyw43_arch_lwip_begin()` with `net_radio_lock()` and `cyw43_arch_lwip_end()` with
`net_radio_unlock()`. Add `#include "net_radio.h"`. Keep `#include "pico/cyw43_arch.h"`: Task 3 removes it.

`main.c`: same replacement in `ip_str()` (lines 217, 220) and `default_route_str()` (925, 928, 933). Add
`#include "net_radio.h"`.

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -2; echo "exit ${PIPESTATUS[0]}"`
Expected: exit 0.

Run the device build (as in Task 1 Step 10).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/net_radio.h wifi-floppy/firmware/src/net_radio_cyw43.c \
        wifi-floppy/firmware/src/transport_tls.c wifi-floppy/firmware/src/sntp_time.c \
        wifi-floppy/firmware/src/portal_net.c wifi-floppy/firmware/src/main.c \
        wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/test/run.sh
git commit -m "refactor(firmware): net_radio seam; the lwIP lock goes through it (CYW43 only, no behaviour change)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `net_radio`: radio lifecycle, MAC and RSSI through the seam; guard on everything

**Files:**
- Modify: `wifi-floppy/firmware/src/main.c:909,939,1142,1161,1192,1246-1248,1284-1286`, `wifi-floppy/firmware/src/portal_net.c:108,225,720,724,823,857`, `wifi-floppy/firmware/test/run.sh` (widen the guard)

**Interfaces:**
- Consumes: `net_radio.h` from Task 2, exactly as declared there.
- Produces: no `cyw43_`/`CYW43_` identifier anywhere in `src/` outside `net_radio_cyw43.c`.

- [ ] **Step 1: Widen the guard to every file and see it fail**

In `test/run.sh`, change `| grep -E "${RADIO_GUARD_FILES:-transport_tls|sntp_time}" || true)` to `|| true)`, so the
guard covers every file.

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -B30 "WiFi chip is named" | grep -E "main\.c|portal_net\.c" | head -20`
Expected: listings for `main.c` (rssi, mac, init, sta, hal_get_mac, two connects) and `portal_net.c` (include, two
MAC reads, AP start, AP stop, `cyw43_state.netif`).

- [ ] **Step 2: Migrate `main.c`**

```c
// main.c:909 wifi_rssi()
static int wifi_rssi(void) {
    return (int)net_radio_rssi();
}

// main.c:939 mac_address_string()
    uint8_t mac[6] = {0};
    net_radio_mac(mac);

// main.c:1142 core1_main()
    if (net_radio_init()) {
        // The one intended log change of P1 (Global Constraints): the
        // guard forbids cyw43_ outside net_radio_cyw43.c, strings included.
        wf_logf(WF_ERR, "radio init failed, radio is dead");
        while (1) tight_loop_contents();
    }

// main.c:1161
    net_radio_sta_enable();

// main.c:1192 (portal SSID for the panel)
                uint8_t mac[6] = {0};
                net_radio_mac(mac);

// main.c:1246 and main.c:1284
            int err = net_radio_sta_connect(submitted.ssid, submitted.pass, 15000);
        int err = net_radio_sta_connect(prov.cfg.ssid, prov.cfg.pass, 15000);
```

Keep every existing comment. Remove `#include "pico/cyw43_arch.h"` from `main.c` **only if** nothing else in the file
needs it. `tight_loop_contents()` comes from `pico/platform.h`, so add `#include "pico/platform.h"` if removing the
cyw43 include drops it. Let the compiler decide.

Line 1192 used `cyw43_hal_get_mac(0, mac)` while every other site used the station MAC. `net_radio_mac()` reads the
station MAC. This is Review Focus 4. On the PIM726 both return the chip's station address. Step 6's bench check
confirms it.

- [ ] **Step 3: Migrate `portal_net.c`**

```c
// :108   #include "pico/cyw43_arch.h"   ->   (delete; net_radio.h is already included)
//        keep "pico/platform.h" and "pico/time.h"; add #include "lwip/netif.h" if netif_set_default no longer resolves

// :225 format_mac_colon()
    uint8_t mac[6] = {0};
    net_radio_mac(mac);

// :720-724 portal_run()
    uint8_t mac[6] = {0};
    net_radio_mac(mac);
    char ssid[24];
    snprintf(ssid, sizeof ssid, "wifi-floppy-%02X%02X", mac[4], mac[5]);

    net_radio_ap_start(ssid, PORTAL_AP_PASSWORD);

// :823 portal_stop()
    net_radio_ap_stop();

// :856-858 portal_stop()
    net_radio_lock();
    netif_set_default(net_radio_sta_netif());
    net_radio_unlock();
```

The long "Review round 1 (Critical)" comment above the `netif_set_default` call stays word for word. It explains why
the call exists, which is still true.

- [ ] **Step 4: Run the host suite (the guard now covers everything)**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"`
Expected: exit 0, and no "WiFi chip is named" line.

- [ ] **Step 5: Prove the guard by mutation (Review Focus 5)**

Temporarily append to `wifi-floppy/firmware/src/sntp_time.c`:

```c
static void leak_probe(void) { (void)cyw43_state; }
```

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -c "WiFi chip is named"`
Expected: `1`.

Then remove the line, run `git diff --stat wifi-floppy/firmware/src/sntp_time.c`, and confirm it prints nothing.

Also check the comment stripping holds. `grep -c "cyw43" wifi-floppy/firmware/src/transport_tls.c` should still be
greater than 0 (the comments remain) while the guard passes.

- [ ] **Step 6: Device build**

Run the device build (Task 1 Step 10).
Expected: no errors, and `firmware version: 1.6.2+g<sha>-dirty` or similar. The version is bumped in Task 4.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/main.c wifi-floppy/firmware/src/portal_net.c wifi-floppy/firmware/test/run.sh
git commit -m "refactor(firmware): radio lifecycle, MAC, RSSI and the AP through net_radio; guard covers all of src/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Release 1.6.3, install on the bench board, prove no behaviour change

This task is the **controller's** (the main session's), not a subagent's. It publishes and installs firmware
(authorized by the operator 2026-10-02 for their own board while there are no other users; memory
`firmware-installs-authorized`) and needs the operator at the Amiga.

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt:166` (`1.6.2` → `1.6.3`), `HANDOFF.md`

- [ ] **Step 1: Bump the version, build, dry-run publish**

```bash
sed -i '' 's/  set(FIRMWARE_SEMVER "1.6.2")/  set(FIRMWARE_SEMVER "1.6.3")/' wifi-floppy/firmware/CMakeLists.txt
git add wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware 1.6.3: unified-firmware P1 (board table, net_radio), no behaviour change

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
(cd wifi-floppy/firmware && cmake -U FIRMWARE_SEMVER -B build >/dev/null)
pnpm firmware:build 2>&1 | grep "firmware version"     # expect 1.6.3+g<sha>, NOT -dirty
pnpm firmware:test 2>&1 | grep -E "checks, [1-9]|FAIL" # expect nothing
pnpm firmware:publish --dry-run --notes "Unified firmware P1: board table and net_radio seam; no behaviour change"
```

- [ ] **Step 2: Publish and install**

```bash
pnpm firmware:publish --notes "Unified firmware P1: board table and net_radio seam; no behaviour change"
# Note the mounted disk first; the board applies firmware only with an empty drive.
npx dotenv -e .env.local -- npx tsx .fw-target.mts 1.6.3+g<sha>
```

Watch the serial log (a DTR-raising reader). Expect:
- `fw: queued`, then `applying`, then a reboot;
- `wifi-floppy boot:`;
- **`board: pim726`** (new);
- `i2c1: device at 0x28` and `0x3c` (if the reader is fitted);
- `fw: update to 1.6.3+g<sha> confirmed`;
- `tls: up ... handshake ~330`.

Then put the noted disk back with `setDesired` (as in HANDOFF 3au).

- [ ] **Step 3: Bench checks (operator at the Amiga; ask for them as the LAST thing in a turn, one at a time)**

Each one exercises a migrated seam:
1. **Boot and read** (pins, PIO, I2C): Workbench boots from a mounted DD disk; the OLED shows status; an NFC tap
   mounts a disk.
2. **DD and HD writes** (pins `WGATE`/`WDATA`/`SIDE`, the capture): save a file on a DD disk and on HD Bench. Each
   lands as a version; the `write:` lines decode in full.
3. **The setup portal** (AP start/stop, MAC, the lock, Review Focus 3 and 4): trigger the portal (the existing way:
   clear the stored WiFi config, or the portal button if fitted). Confirm the OLED's SSID **equals** the SSID the
   phone sees. Submit credentials. The log must show `portal: AP down, default route now w00 ip=...` (not `NONE`),
   then association and the poll loop.
4. **OTA once more** (the trial path, which needs a heartbeat): publish nothing new; instead confirm the 1.6.3 update
   itself in Step 2 reached `confirmed`. Enough.

- [ ] **Step 4: Record and merge**

Add a HANDOFF section `### 3av. Unified firmware P1 -- board table and net_radio (1.6.3)`. Record:
- what moved;
- the guard;
- the bench results with log lines;
- anything the review or the bench found.

Merge the branch to master and push. The web tree is untouched, so no e2e (record that, as 3au did).

---

## Self-review notes (done while writing)

- **Spec coverage, P1 row of §11:**
  - Board table, Task 1.
  - `net_radio` interface plus CYW43 implementation, Tasks 2 and 3.
  - "No behaviour change", Global Constraints plus Task 4's bench list.
  - PSRAM stays with the SDK (constraint).
  - §6's PIO changes and §4's detection are **P2** and deliberately absent.
- **Types:** `board_t` fields are used identically in `board.c`, `test_board.c` and `floppy_io.h`. The `net_radio_*`
  names match between the header (Task 2), the implementation (Task 2) and the call sites (Tasks 2 and 3).
  `net_radio_sta_connect` returns `int` with PICO_* codes, as `assoc_failure_message(err)` expects.
- **Review Focus:** 1 is Task 1 Step 10; 2 is `test_board_default_is_pim726`; 3 and 4 are Task 4 Step 3.3; 5 is
  Task 3 Step 5.
