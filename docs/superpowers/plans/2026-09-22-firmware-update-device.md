# Firmware update, device half (2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wifi-floppy board downloads a signed release, flashes it into its other A/B
slot, boots it on trial, and keeps it only once it has proven it can reach the server.
Otherwise it reverts on its own.

**Architecture:**
- **Boot ROM does the heavy lifting.** The RP2350 boot ROM handles slot choice, trial boot
  (TBYB) and revert. The firmware adds a signed-manifest check, its own anti-rollback
  record, a PSRAM staging download, and an idle-gated flash write.
- **Decisions live in pure, host-tested C units:** `fw_state`, `fw_trial`, `fw_offer`,
  `fw_verify`, `fw_stage`, `fw_apply` and `fw_update`.
- **Only the glue touches the chip.** `fw_rom.c` and `main.c` call the boot ROM, flash,
  watchdog and cores.
- **The server change is small:** a `signature_format` column, a manifest signature, and
  offering only verifiable releases.

**Tech Stack:**
- C11 on pico-sdk 2.3.0, RP2350B (Pimoroni Pico Plus 2 W)
- The existing host-test harness (`wifi-floppy/firmware/test/run.sh`)
- Monocypher 4.0.2 (ed25519, vendored)
- Next.js 16 / Drizzle / vitest / Playwright for the server side
- picotool 2.3.0

**Spec:** `docs/superpowers/specs/2026-09-22-firmware-update-device-design.md`. Read it
first. Decisions are cited as D1–D11 and measurements as M1–M10. HANDOFF §3aj is the
authority on the 2a protocol.

## Global Constraints

- **Partition table:** A = `0x8000–0x408000`, B = `0x408000–0x808000` (4 MB each, B
  `"link": ["a", 0]`). Everything above is unpartitioned.
- **Firmware-state sector:** at `PICO_FLASH_SIZE_BYTES - 3 * FLASH_SECTOR_SIZE`
  (16 MB − 12 KB). Config stays at −8 KB and the token at −4 KB.
- **Flash reads outside the booted image:** always through
  `XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE` (0x1c000000), never `XIP_BASE` (M3: hard fault).
- **Image cap:** a release image larger than **2 MB (2,097,152 bytes)** is refused, by
  both the publish script and the board.
- **Signed manifest:** exact ASCII, no trailing newline:
  `webadf-fw-v1\n<version>\n<sequence>\n<sha256 hex>\n<sizeBytes>`.
- **Signature:** ed25519 (RFC 8032, SHA-512), base64 in the poll body, verified against
  the compiled-in key whose id must equal `keyId`.
- **`signature_format`:** 1 = hash only (release 1), 2 = manifest. Only format 2 is ever
  offered to a board.
- **Release artifacts:** the `.bin` (`firmware/<version>.bin` in the blob store). USB
  installs use the `.uf2` from the same build.
- **Release images:** built with `PICO_CRT0_IMAGE_TYPE_TBYB=1` and `pico_hash_binary`.
  The publish script refuses one without `tbyb: not bought` and a hash in
  `picotool info`.
- **Trial deadline:** 5 minutes (`300000` ms) from boot.
- **Watchdog:** 8,000 ms, fed only by core0's loop.
- **Reboots:** after `rom_reboot`, nothing may feed the watchdog (M9), so every reboot
  is performed on core0.
- **No flash write while a disk is mounted:** `fw_state_save` refuses exactly as
  `config_store_save` does.
- **Status fields:** `updateProtocol` (1), `firmwareUpdateState` (`queued` |
  `downloading` | `applying` | `failed` | null), `firmwareUpdateError` (≤ 200 chars |
  null), `firmwareInstructionAck` (uint).
- **`pnpm db:push` is forbidden in this repo.** Migrations are applied as the generated
  `ALTER TABLE` wrapped in an existence guard, via `psql`.
- **Commits:** end every message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Other sessions change this tree.** Run `git status` before staging, and stage named
  paths only, never `git add -A`.
- **Hardware steps** (anything marked **BENCH**) need the operator's board. Driving it with
  `picotool` over USB is fine. Anything needing a button, power or the Amiga is the
  operator's job: end the turn and ask.

## Review Focus

These are the failure modes most likely to bite a real user that no ordinary test covers.
Each is pinned by a test in the task named.

1. **A poll body carries a disk AND an update, and both have `version`/`sha256`.** The disk
   logic must read the disk's keys, never the update's. Pinned in Task 5,
   `test_update_object_does_not_leak_into_disk_fields`.
2. **The operator cancels while the board is waiting (queued, or staged waiting for an
   eject).** Nothing may be flashed, and the phase returns to idle. Pinned in Task 10,
   `test_cancel_while_staged_never_applies`.
3. **An update arrives while a disk is mounted.** It downloads, then waits, and applies only
   once idle. Pinned in Task 10, `test_staged_waits_for_idle`.
4. **The operator presses Update again after a failure** (a new instruction for the same
   release). It must re-queue from `failed`, not stay failed. Pinned in Task 10,
   `test_new_instruction_after_failure_requeues`.
5. **The board restarts mid-download.** After boot it must not claim progress it isn't
   making. A fresh `fwu_t` reports no state (null), which the server shows as "update
   requested". Pinned in Task 10, `test_fresh_updater_reports_nothing`.

---

## File map

**Firmware (`wifi-floppy/firmware/`):**
- Modify `src/config_store.c`, `src/token_store.c` — no-translate reads (Task 1)
- Modify `src/json_scan.h/.c` — `json_object()` span extraction (Task 5)
- Create `src/fw_state.h/.c` — the firmware-state sector record (Task 2)
- Create `src/fw_trial.h/.c` — trial-boot and boot-reconcile decisions (Task 3)
- Create `src/fw_rom.h/.c` — **device-only** boot ROM, flash, watchdog and reboot glue
  (Tasks 4, 9)
- Create `src/fw_offer.h/.c` — parse the poll body's `update` object, base64 (Task 6)
- Create `src/fw_verify.h/.c` — manifest, anti-rollback, keyId, ed25519 (Task 6)
- Create `src/fw_pubkey.h` — generated from `keys/*.pem`, committed (Task 6)
- Create `src/vendor/monocypher/` — Monocypher 4.0.2 core + ed25519 (Task 6)
- Create `src/fw_stage.h/.c` — PSRAM staging sink with a running SHA-256 (Task 8)
- Create `src/fw_apply.h/.c` — slot writer: header erased first, written last; readback
  hash (Task 9)
- Create `src/fw_update.h/.c` — the update state machine (Task 10)
- Modify `src/device_client.h/.c` — firmware fields in the poll, status and register;
  `dc_fetch_firmware` (Tasks 5, 8)
- Modify `src/main.c` — boot info, watchdog, trial, updater wiring (Tasks 4, 11)
- Create `partitions.json`. Modify `CMakeLists.txt` for TBYB, hash, partition UF2 and the
  new sources (Tasks 4, 6).
- Modify `test/run.sh` for exclusions, vendored objects and guards. Create
  `test/test_fw_*.c` and `test/fw_fixture.h`.

**Server / tooling (repo root):**
- Create `src/lib/firmware-manifest.ts` (+ test) — the manifest string and the `picotool
  info` check (Task 7)
- Create `src/lib/firmware-c-headers.ts` (+ test) — generators for `fw_pubkey.h` and
  `test/fw_fixture.h`, plus drift checks (Task 6)
- Modify `src/db/schema/firmware.ts` and add migration `drizzle/0022_*.sql` —
  `signature_format` (Task 7)
- Modify `src/lib/firmware-releases.ts`, `src/lib/mount.ts`,
  `src/lib/firmware-update-rules.ts`, `src/lib/firmware-state.ts` (Task 7)
- Modify `scripts/firmware-release.ts` — `.bin`, manifest signature, refusals (Task 7)
- Create `scripts/firmware-install-partitioned.sh`. Add a `package.json` script
  `firmware:install-partitioned` (Task 4).
- Modify `e2e/device-helpers.ts` — seeds use `signatureFormat: 2` (Task 7)
- Modify `HANDOFF.md` (Task 12)

---

### Task 1: Read flash outside the image through the no-translate window (D2)

**Files:**
- Modify: `wifi-floppy/firmware/src/config_store.c:139-171`
- Modify: `wifi-floppy/firmware/src/token_store.c:74-114`
- Modify: `wifi-floppy/firmware/test/run.sh` (append a guard)

**Interfaces:**
- Consumes: nothing new.
- Produces: the rule "no `XIP_BASE +` in `src/`", enforced by `run.sh`. Every later task
  relies on it.

- [ ] **Step 1: Add the failing guard to `test/run.sh`**

Append after the `gpio_put` guard block:

```bash
# M3 (spec 2026-09-22-firmware-update-device-design.md): once the board boots
# from a partition, the boot ROM's address translation maps only the booted
# slot at XIP_BASE. Reading anything else through XIP_BASE -- the config and
# token sectors at the top of flash -- HARD-FAULTS, measured on the bench.
# XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE reads physical flash in every layout.
if grep -nE 'XIP_BASE[[:space:]]*\+' ../src/*.c; then
  echo "FAIL: flash read through XIP_BASE (use XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE)"
  fail=1
fi
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm firmware:test 2>&1 | tail -5`
Expected: it names `config_store.c:169` and `token_store.c:112`, then
`FAIL: flash read through XIP_BASE`.

- [ ] **Step 3: Switch both reads**

In `src/config_store.c`, replace the include comment and the load:

```c
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
```

```c
bool config_store_load(device_config_t *out) {
    // NOTRANSLATE, never XIP_BASE: from a partitioned (A/B) boot the boot ROM
    // maps only the booted slot at XIP_BASE, and reading the top of flash
    // through it hard-faults (spec M3, measured). This window is physical
    // flash in every layout, partitioned or not.
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + CONFIG_FLASH_OFFSET);
    return page_load(p, CONFIG_STORE_CAP, out);
}
```

In `src/token_store.c`, make the same change:

```c
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
```

```c
bool token_store_load(char *out, int out_len) {
    if (out_len <= 0) return false;
    // NOTRANSLATE: see config_store_load -- XIP_BASE faults here from an A/B boot.
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + TOKEN_FLASH_OFFSET);
    return page_load(p, TOKEN_STORE_CAP, out, out_len);
}
```

The no-translate window is also uncached, which is correct here: a cached copy of a sector
that was just erased and reprogrammed could otherwise be read stale.

- [ ] **Step 4: Run the host tests and build the firmware**

Run: `pnpm firmware:test 2>&1 | tail -3 && pnpm firmware:build 2>&1 | tail -2`
Expected: every host test file reports `0 failed`, there is no `FAIL:` line, and the
build links `wifi_floppy.elf`.

- [ ] **Step 5: BENCH, flash the unpartitioned board and confirm nothing changed**

The board is still unpartitioned (restored 2026-09-22), and on this layout the two windows
read the same bytes. So this proves the change is harmless before the layout moves.

```bash
picotool load -f wifi-floppy/firmware/build/wifi_floppy.uf2 && picotool reboot
```

Then confirm the board heartbeats with its pairing intact. Its `last_seen_at` age should
stay under 60 s:

```bash
set -a; . ./.env.local; set +a
for i in 1 2 3; do psql "${DATABASE_URL_UNPOOLED:-$DATABASE_URL}" -XAtc \
  "select round(extract(epoch from now()-last_seen_at)), firmware_version from devices where id like '12593d21%';"; sleep 20; done
```

Expected: ages under 60, and a `firmware_version` equal to the new build's
`WF_FIRMWARE_VERSION`. If the board shows the portal instead, config reads broke: stop
and investigate. Don't continue.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/config_store.c wifi-floppy/firmware/src/token_store.c wifi-floppy/firmware/test/run.sh
git commit -m "firmware: read config and token through the no-translate window

An A/B boot maps only the booted slot at XIP_BASE; reading the top of flash
through it hard-faults (measured on the bench, spec M3). run.sh now refuses
any XIP_BASE + read in src/.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `fw_state`, the firmware-state sector record (D5)

**Files:**
- Create: `wifi-floppy/firmware/src/fw_state.h`, `wifi-floppy/firmware/src/fw_state.c`
- Test: `wifi-floppy/firmware/test/test_fw_state.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (add `src/fw_state.c` to `add_executable`)

**Interfaces:**
- Produces:

```c
#define FW_STATE_VERSION_MAX 64
#define FW_STATE_REASON_MAX  48
#define FW_STATE_RECORD_BYTES 132
typedef struct {
    uint32_t installed_sequence;                    // 0 = none recorded (hand-flashed / first install)
    bool     pending;                               // flashed + rebooted into, not yet confirmed
    uint32_t pending_sequence;
    char     pending_version[FW_STATE_VERSION_MAX + 1];
    char     failure[FW_STATE_REASON_MAX + 1];      // why the trial image gave up, "" if unknown
} fw_state_t;
bool fw_state_encode(const fw_state_t *s, uint8_t out[FW_STATE_RECORD_BYTES]);
bool fw_state_decode(const uint8_t *p, fw_state_t *out);   // false => *out zeroed
bool fw_state_load(fw_state_t *out);                        // false => *out zeroed
bool fw_state_save(const fw_state_t *s);                    // false while a disk is mounted
void fw_state_test_erase(void);                             // host build only
uint8_t *fw_state_test_raw(void);                           // host build only
```

- [ ] **Step 1: Write the failing test** at `test/test_fw_state.c`

```c
#include "harness.h"
#include "../src/fw_state.h"
#include "../src/psram_image.h"
#include <string.h>

static fw_state_t sample(void) {
    fw_state_t s;
    memset(&s, 0, sizeof s);
    s.installed_sequence = 3;
    s.pending = true;
    s.pending_sequence = 4;
    snprintf(s.pending_version, sizeof s.pending_version, "%s", "1.1.0+gabc1234");
    snprintf(s.failure, sizeof s.failure, "%s", "no heartbeat within 5 minutes");
    return s;
}

static void test_round_trip(void) {
    fw_state_test_erase();
    fw_state_t in = sample(), out;
    CHECK(fw_state_save(&in), "save");
    CHECK(fw_state_load(&out), "load");
    CHECK_EQ_INT(out.installed_sequence, 3);
    CHECK(out.pending, "pending survives");
    CHECK_EQ_INT(out.pending_sequence, 4);
    CHECK(strcmp(out.pending_version, "1.1.0+gabc1234") == 0, "version survives");
    CHECK(strcmp(out.failure, "no heartbeat within 5 minutes") == 0, "failure survives");
}

// An erased sector is the state of every board before its first update: it must read as
// "nothing recorded" (all zero), never as garbage a caller could act on.
static void test_erased_sector_reads_as_zero(void) {
    fw_state_test_erase();
    fw_state_t out;
    memset(&out, 0x5a, sizeof out);
    CHECK(!fw_state_load(&out), "an erased sector holds no record");
    CHECK_EQ_INT(out.installed_sequence, 0);
    CHECK(!out.pending, "and nothing pending");
    CHECK(out.pending_version[0] == '\0', "and no version");
}

static void test_one_flipped_byte_is_rejected(void) {
    fw_state_test_erase();
    fw_state_t in = sample(), out;
    CHECK(fw_state_save(&in), "save");
    fw_state_test_raw()[20] ^= 0x01;           // inside pending_version
    CHECK(!fw_state_load(&out), "the CRC must catch a flipped payload byte");
    CHECK_EQ_INT(out.installed_sequence, 0);
}

static void test_bad_magic_is_rejected(void) {
    fw_state_test_erase();
    fw_state_t in = sample(), out;
    CHECK(fw_state_save(&in), "save");
    fw_state_test_raw()[0] ^= 0xff;
    CHECK(!fw_state_load(&out), "a wrong magic is not a record");
}

// Anti-rollback rests on installed_sequence. A version string with no terminator must be
// refused at encode time rather than written as a record that decodes to something else.
static void test_unterminated_version_is_refused(void) {
    fw_state_t s = sample();
    memset(s.pending_version, 'v', sizeof s.pending_version);   // no NUL anywhere
    uint8_t rec[FW_STATE_RECORD_BYTES];
    CHECK(!fw_state_encode(&s, rec), "an unterminated version must not encode");
}

// Same guard as config_store/token_store: a flash write parks core0, which the Amiga would
// see as a drive that stops answering mid-read.
static void test_save_refuses_while_a_disk_is_mounted(void) {
    fw_state_test_erase();
    psram_publish_slot(0);
    fw_state_t in = sample();
    CHECK(!fw_state_save(&in), "no flash write with a disk mounted");
    psram_publish_slot(SLOT_NONE);
}

int main(void) {
    psram_image_init();
    RUN(test_round_trip);
    RUN(test_erased_sector_reads_as_zero);
    RUN(test_one_flipped_byte_is_rejected);
    RUN(test_bad_magic_is_rejected);
    RUN(test_unterminated_version_is_refused);
    RUN(test_save_refuses_while_a_disk_is_mounted);
    return REPORT();
}
```

Check `test/test_config_store.c` for how it gets a host PSRAM backing
(`psram_image_set_backing`). If `psram_publish_slot(0)` needs a backing to report slot 0
as active, set one up the same way here, before `RUN`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm firmware:test 2>&1 | grep -A2 test_fw_state`
Expected: `COMPILE FAIL: test_fw_state.c` (no `fw_state.h`).

- [ ] **Step 3: Write `src/fw_state.h`** with exactly the interface above, include guard
`FW_STATE_H`, and `#include <stdint.h>`, `<stdbool.h>`, `<stddef.h>`.

- [ ] **Step 4: Write `src/fw_state.c`**

```c
#include "fw_state.h"
#include "psram_image.h"
#include <string.h>

// Layout (little-endian), 132 bytes, one program page:
//   [0..3]    magic "FWS1"
//   [4]       format (1)
//   [5..8]    installed_sequence
//   [9]       pending (0/1)
//   [10..13]  pending_sequence
//   [14..78]  pending_version, NUL-padded (65)
//   [79..127] failure, NUL-padded (49)
//   [128..131] CRC-32 over [4..127]
#define FW_STATE_MAGIC  0x31535746u
#define FW_STATE_FORMAT 1u
#define OFF_FORMAT    4
#define OFF_INSTALLED 5
#define OFF_PENDING   9
#define OFF_PSEQ      10
#define OFF_PVER      14
#define OFF_FAIL      (OFF_PVER + FW_STATE_VERSION_MAX + 1)
#define OFF_CRC       (OFF_FAIL + FW_STATE_REASON_MAX + 1)
_Static_assert(OFF_CRC + 4 == FW_STATE_RECORD_BYTES, "record layout");

static uint32_t crc32_bytes(const uint8_t *p, size_t n) {
    uint32_t c = 0xffffffffu;
    for (size_t i = 0; i < n; i++) {
        c ^= p[i];
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u)));
    }
    return ~c;
}
static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool fw_state_encode(const fw_state_t *s, uint8_t out[FW_STATE_RECORD_BYTES]) {
    if (!memchr(s->pending_version, '\0', sizeof s->pending_version)) return false;
    if (!memchr(s->failure, '\0', sizeof s->failure)) return false;
    memset(out, 0, FW_STATE_RECORD_BYTES);
    put_u32(out, FW_STATE_MAGIC);
    out[OFF_FORMAT] = FW_STATE_FORMAT;
    put_u32(out + OFF_INSTALLED, s->installed_sequence);
    out[OFF_PENDING] = s->pending ? 1 : 0;
    put_u32(out + OFF_PSEQ, s->pending_sequence);
    memcpy(out + OFF_PVER, s->pending_version, strlen(s->pending_version));
    memcpy(out + OFF_FAIL, s->failure, strlen(s->failure));
    put_u32(out + OFF_CRC, crc32_bytes(out + OFF_FORMAT, OFF_CRC - OFF_FORMAT));
    return true;
}

bool fw_state_decode(const uint8_t *p, fw_state_t *out) {
    memset(out, 0, sizeof *out);
    if (get_u32(p) != FW_STATE_MAGIC) return false;
    if (p[OFF_FORMAT] != FW_STATE_FORMAT) return false;
    if (get_u32(p + OFF_CRC) != crc32_bytes(p + OFF_FORMAT, OFF_CRC - OFF_FORMAT)) return false;
    if (p[OFF_PENDING] > 1) return false;
    if (!memchr(p + OFF_PVER, '\0', FW_STATE_VERSION_MAX + 1)) return false;
    if (!memchr(p + OFF_FAIL, '\0', FW_STATE_REASON_MAX + 1)) return false;
    out->installed_sequence = get_u32(p + OFF_INSTALLED);
    out->pending = p[OFF_PENDING] == 1;
    out->pending_sequence = get_u32(p + OFF_PSEQ);
    memcpy(out->pending_version, p + OFF_PVER, FW_STATE_VERSION_MAX + 1);
    memcpy(out->failure, p + OFF_FAIL, FW_STATE_REASON_MAX + 1);
    return true;
}

// Same guard as config_store/token_store: never write flash under a mounted disk.
static bool disk_is_mounted(void) { return psram_active_slot() != SLOT_NONE; }

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"

// Below config (-8 KB) and token (-4 KB); outside both A/B partitions, which end at
// 8 MB + 32 KB (partitions.json).
#define FW_STATE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 3 * FLASH_SECTOR_SIZE)

static void do_program(void *param) {
    flash_range_erase(FW_STATE_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(FW_STATE_FLASH_OFFSET, (const uint8_t *)param, FLASH_PAGE_SIZE);
}

bool fw_state_load(fw_state_t *out) {
    // NOTRANSLATE: see config_store_load (spec M3).
    return fw_state_decode((const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + FW_STATE_FLASH_OFFSET), out);
}

bool fw_state_save(const fw_state_t *s) {
    if (disk_is_mounted()) return false;
    static uint8_t page[FLASH_PAGE_SIZE];   // static: flash_safe_execute keeps its window short
    memset(page, 0xFF, sizeof page);
    if (!fw_state_encode(s, page)) return false;
    return flash_safe_execute(do_program, page, 1000) == PICO_OK;
}

#else   // WFMF_HOST_TEST

static uint8_t g_raw[FW_STATE_RECORD_BYTES];
void fw_state_test_erase(void) { memset(g_raw, 0xFF, sizeof g_raw); }
uint8_t *fw_state_test_raw(void) { return g_raw; }
bool fw_state_load(fw_state_t *out) { return fw_state_decode(g_raw, out); }
bool fw_state_save(const fw_state_t *s) {
    if (disk_is_mounted()) return false;
    uint8_t rec[FW_STATE_RECORD_BYTES];
    if (!fw_state_encode(s, rec)) return false;
    memcpy(g_raw, rec, sizeof rec);
    return true;
}
#endif
```

Add `src/fw_state.c` to `add_executable(wifi_floppy ...)` in `CMakeLists.txt`, next to
`src/config_store.c`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm firmware:test 2>&1 | grep -E "test_fw_state|FAIL"`
Expected: `test_fw_state.c: N checks, 0 failed` and no FAIL lines.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/fw_state.[ch] wifi-floppy/firmware/test/test_fw_state.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: the firmware-state sector record (anti-rollback, pending update)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `fw_trial`, the trial-boot and boot-reconcile decisions (D8)

**Files:**
- Create: `wifi-floppy/firmware/src/fw_trial.h`, `wifi-floppy/firmware/src/fw_trial.c`
- Test: `wifi-floppy/firmware/test/test_fw_trial.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (add `src/fw_trial.c`)

**Interfaces:**
- Consumes: `fw_state_t` (Task 2).
- Produces:

```c
#define FW_TRIAL_DEADLINE_MS 300000u
typedef enum { FW_TRIAL_NONE, FW_TRIAL_WAIT, FW_TRIAL_BUY, FW_TRIAL_GIVE_UP } fw_trial_action_t;
typedef struct {
    bool              trial_boot;       // boot ROM: TBYB buy pending on this boot
    const fw_state_t *st;               // loaded (zeroed if no record)
    const char       *running_version;  // WF_FIRMWARE_VERSION
    bool              heartbeat_ok;     // a status report naming running_version got a 2xx
    uint32_t          ms_since_boot;
} fw_trial_in_t;
fw_trial_action_t fw_trial_decide(const fw_trial_in_t *in, const char **reason);
bool fw_trial_after_buy(fw_state_t *st);   // true if *st changed and must be saved
typedef enum { FW_BOOT_CLEAN, FW_BOOT_REVERTED, FW_BOOT_CONFIRMED_LATE } fw_boot_t;
fw_boot_t fw_boot_reconcile(fw_state_t *st, const char *running_version, char *err, int err_len);
```

- [ ] **Step 1: Write the failing test** at `test/test_fw_trial.c`

```c
#include "harness.h"
#include "../src/fw_trial.h"
#include <string.h>

static fw_state_t st_pending(const char *ver, uint32_t seq) {
    fw_state_t s; memset(&s, 0, sizeof s);
    s.installed_sequence = seq - 1; s.pending = true; s.pending_sequence = seq;
    snprintf(s.pending_version, sizeof s.pending_version, "%s", ver);
    return s;
}
static fw_trial_in_t in_for(const fw_state_t *st, bool trial, bool hb, uint32_t ms) {
    fw_trial_in_t in = { trial, st, "1.1.0+gnew", hb, ms };
    return in;
}

static void test_a_normal_boot_is_not_a_trial(void) {
    fw_state_t s; memset(&s, 0, sizeof s);
    fw_trial_in_t in = in_for(&s, false, true, 0);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_NONE);
}
static void test_waits_until_a_heartbeat_lands(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, false, 1000);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_WAIT);
}
static void test_buys_after_a_heartbeat(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, true, 1000);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_BUY);
}
// A mislabelled release: the server derives completion from the reported version, so a
// board that bought an image reporting a different version would leave the update
// "requested" forever. Give up at once, even with a heartbeat.
static void test_version_mismatch_gives_up_immediately(void) {
    fw_state_t s = st_pending("1.1.0+gOTHER", 5);
    fw_trial_in_t in = in_for(&s, true, true, 10);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
    CHECK(why && strstr(why, "version") != NULL, "the reason names the version");
}
static void test_deadline_gives_up(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    fw_trial_in_t in = in_for(&s, true, true, FW_TRIAL_DEADLINE_MS);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_GIVE_UP);
    CHECK(why && strstr(why, "5 minutes") != NULL, "the reason names the deadline");
}
// First USB install (D11): a trial boot with no pending record buys on connectivity alone
// and leaves installed_sequence alone.
static void test_usb_install_buys_without_a_pending_record(void) {
    fw_state_t s; memset(&s, 0, sizeof s);
    fw_trial_in_t in = in_for(&s, true, true, 1000);
    const char *why = NULL;
    CHECK_EQ_INT(fw_trial_decide(&in, &why), FW_TRIAL_BUY);
    CHECK(!fw_trial_after_buy(&s), "nothing to record after a USB install");
    CHECK_EQ_INT(s.installed_sequence, 0);
}
static void test_after_buy_records_the_sequence_and_clears_pending(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    CHECK(fw_trial_after_buy(&s), "state changed");
    CHECK_EQ_INT(s.installed_sequence, 5);
    CHECK(!s.pending, "pending cleared");
    CHECK(s.pending_version[0] == '\0', "version cleared");
}
static void test_reconcile_clean_boot(void) {
    fw_state_t s; memset(&s, 0, sizeof s); s.installed_sequence = 4;
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.0.0+gold", err, sizeof err), FW_BOOT_CLEAN);
    CHECK_EQ_INT(s.installed_sequence, 4);
}
// The old image booted with a pending record: the trial did not stick.
static void test_reconcile_revert_reports_the_trial_reason(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    snprintf(s.failure, sizeof s.failure, "%s", "no heartbeat within 5 minutes");
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.0.0+gold", err, sizeof err), FW_BOOT_REVERTED);
    CHECK(strstr(err, "reverted") && strstr(err, "no heartbeat"), "names what happened and why");
    CHECK(!s.pending && s.failure[0] == '\0', "cleared so it is reported once");
    CHECK_EQ_INT(s.installed_sequence, 4);
}
// A hang or power cut leaves no reason behind: say so rather than inventing one.
static void test_reconcile_revert_without_a_reason(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.0.0+gold", err, sizeof err), FW_BOOT_REVERTED);
    CHECK(strstr(err, "did not confirm") != NULL, "honest about not knowing why");
}
// Bought, but power was lost before the state write: the running image IS the pending one.
static void test_reconcile_confirms_a_buy_whose_record_was_lost(void) {
    fw_state_t s = st_pending("1.1.0+gnew", 5);
    char err[96] = "";
    CHECK_EQ_INT(fw_boot_reconcile(&s, "1.1.0+gnew", err, sizeof err), FW_BOOT_CONFIRMED_LATE);
    CHECK_EQ_INT(s.installed_sequence, 5);
    CHECK(!s.pending, "cleared");
}

int main(void) {
    RUN(test_a_normal_boot_is_not_a_trial);
    RUN(test_waits_until_a_heartbeat_lands);
    RUN(test_buys_after_a_heartbeat);
    RUN(test_version_mismatch_gives_up_immediately);
    RUN(test_deadline_gives_up);
    RUN(test_usb_install_buys_without_a_pending_record);
    RUN(test_after_buy_records_the_sequence_and_clears_pending);
    RUN(test_reconcile_clean_boot);
    RUN(test_reconcile_revert_reports_the_trial_reason);
    RUN(test_reconcile_revert_without_a_reason);
    RUN(test_reconcile_confirms_a_buy_whose_record_was_lost);
    return REPORT();
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm firmware:test 2>&1 | grep -A2 test_fw_trial`
Expected: `COMPILE FAIL: test_fw_trial.c`.

- [ ] **Step 3: Write `src/fw_trial.h`** (the interface above, `#include "fw_state.h"`,
guard `FW_TRIAL_H`) **and `src/fw_trial.c`**

```c
#include "fw_trial.h"
#include <stdio.h>
#include <string.h>

fw_trial_action_t fw_trial_decide(const fw_trial_in_t *in, const char **reason) {
    *reason = NULL;
    if (!in->trial_boot) return FW_TRIAL_NONE;
    if (in->st->pending && strcmp(in->st->pending_version, in->running_version) != 0) {
        *reason = "version mismatch: the image does not report the release version";
        return FW_TRIAL_GIVE_UP;
    }
    if (in->ms_since_boot >= FW_TRIAL_DEADLINE_MS) {
        *reason = "no heartbeat within 5 minutes";
        return FW_TRIAL_GIVE_UP;
    }
    return in->heartbeat_ok ? FW_TRIAL_BUY : FW_TRIAL_WAIT;
}

static void clear_pending(fw_state_t *st) {
    st->pending = false;
    st->pending_sequence = 0;
    st->pending_version[0] = '\0';
    st->failure[0] = '\0';
}

bool fw_trial_after_buy(fw_state_t *st) {
    if (!st->pending) return false;
    st->installed_sequence = st->pending_sequence;
    clear_pending(st);
    return true;
}

fw_boot_t fw_boot_reconcile(fw_state_t *st, const char *running_version, char *err, int err_len) {
    if (!st->pending) return FW_BOOT_CLEAN;
    if (strcmp(st->pending_version, running_version) == 0) {
        st->installed_sequence = st->pending_sequence;
        clear_pending(st);
        return FW_BOOT_CONFIRMED_LATE;
    }
    snprintf(err, (size_t)err_len, "reverted: %s",
             st->failure[0] ? st->failure : "the new firmware did not confirm itself");
    clear_pending(st);
    return FW_BOOT_REVERTED;
}
```

Add `src/fw_trial.c` to `add_executable` in `CMakeLists.txt`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm firmware:test 2>&1 | grep -E "test_fw_trial|FAIL"`
Expected: `test_fw_trial.c: N checks, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/fw_trial.[ch] wifi-floppy/firmware/test/test_fw_trial.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: trial-boot and boot-reconcile decisions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Partitioned TBYB build, boot-ROM glue, watchdog, and the USB install (D1, D8, D10, D11)

This is the first task that changes how the board boots. **It ends at a BENCH checkpoint**:
the operator's board running the current firmware from slot A, confirmed by itself, with
its pairing intact.

**Files:**
- Create: `wifi-floppy/firmware/partitions.json`
- Create: `wifi-floppy/firmware/src/fw_rom.h`, `wifi-floppy/firmware/src/fw_rom.c`
  (device-only)
- Modify: `wifi-floppy/firmware/CMakeLists.txt`, `wifi-floppy/firmware/test/run.sh`
  (exclude `fw_rom.c`), `wifi-floppy/firmware/src/main.c`
- Create: `scripts/firmware-install-partitioned.sh`. Modify: `package.json`.

**Interfaces:**
- Consumes: `fw_state_*` (Task 2) and `fw_trial_*` (Task 3).
- Produces (`fw_rom.h`), used by Tasks 9 and 11:

```c
void fw_rom_boot_init(void);           // core0, before core1 launches: loads PT, records boot info
bool fw_rom_trial_boot(void);          // this boot is an unconfirmed TBYB trial
int  fw_rom_booted_partition(void);    // 0, 1, or -1 (unpartitioned)
bool fw_rom_other_slot(uint32_t *flash_off, uint32_t *len);
bool fw_rom_buy(void);                 // rom_explicit_buy under flash_safe_execute
void fw_rom_request_reboot(uint32_t flash_update_off); // 0 = normal reboot; any core
void fw_rom_watchdog_start(void);      // core0, right before its loop
void fw_rom_service(void);             // core0, every loop turn: feed, deadline, honour reboot
```

- [ ] **Step 1: Write `partitions.json`**. It's the one the probe measured (spec M1–M8):

```json
{
  "version": [1, 0],
  "unpartitioned": { "families": ["absolute"], "permissions": { "secure": "rw", "nonsecure": "rw", "bootloader": "rw" } },
  "partitions": [
    { "name": "A", "id": 0, "start": "32K", "size": "4096K", "families": ["rp2350-arm-s"],
      "permissions": { "secure": "rw", "nonsecure": "rw", "bootloader": "rw" } },
    { "name": "B", "id": 1, "start": "4128K", "size": "4096K", "families": ["rp2350-arm-s"],
      "permissions": { "secure": "rw", "nonsecure": "rw", "bootloader": "rw" }, "link": ["a", 0] }
  ]
}
```

- [ ] **Step 2: Build release images as TBYB + hashed, and emit the partition-table UF2**

In `CMakeLists.txt`, after `pico_enable_stdio_usb(wifi_floppy 1)`:

```cmake
# 2b (spec D1/D10): every image is a try-before-you-buy image with a hash the
# boot ROM checks. A TBYB image boots only through a flash-update reboot and
# is reverted unless it confirms itself (rom_explicit_buy) -- measured, spec
# M5-M8. The publish script refuses an image that lacks either.
target_compile_definitions(wifi_floppy PRIVATE PICO_CRT0_IMAGE_TYPE_TBYB=1)
pico_hash_binary(wifi_floppy)

# The partition table, as a UF2 for first installs over USB (spec D11).
find_program(WF_PICOTOOL picotool REQUIRED)
add_custom_command(
  OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/wifi_floppy_pt.uf2
  COMMAND ${WF_PICOTOOL} partition create ${CMAKE_CURRENT_LIST_DIR}/partitions.json
          ${CMAKE_CURRENT_BINARY_DIR}/wifi_floppy_pt.uf2
  DEPENDS ${CMAKE_CURRENT_LIST_DIR}/partitions.json
  COMMENT "partition table -> wifi_floppy_pt.uf2")
add_custom_target(wifi_floppy_pt ALL DEPENDS ${CMAKE_CURRENT_BINARY_DIR}/wifi_floppy_pt.uf2)
```

Also add `src/fw_rom.c` to `add_executable(wifi_floppy ...)`, and `hardware_watchdog` to
`target_link_libraries(wifi_floppy ...)`.

Build and inspect: `pnpm firmware:build && picotool info -a wifi-floppy/firmware/build/wifi_floppy.bin -t bin`
Expected: a `tbyb: not bought` line, and a hash line in the image-def metadata block.
**Copy that exact `picotool info` output to
`src/lib/__fixtures__/picotool-info-release.txt`** (create the directory). Task 7's test
pins the publish-script check against that real output.

- [ ] **Step 3: Exclude the device-only glue from host tests**

In `test/run.sh`, append `|fw_rom\.c` inside the `grep -vE '...'` list, and add a line to
the exclusion comment: `fw_rom.c - boot ROM, flash, watchdog; every decision it acts on
lives in fw_trial.c / fw_apply.c / fw_update.c, which are tested`.

- [ ] **Step 4: Write `src/fw_rom.h`** (interface above, guard `FW_ROM_H`, includes
`<stdint.h>` and `<stdbool.h>`) **and `src/fw_rom.c`**

```c
// Device-only boot ROM / flash / watchdog glue for 2b. Every DECISION it acts
// on is made in a host-tested unit (fw_trial, fw_apply, fw_update); this file
// only performs them.
#include "fw_rom.h"
#include "fw_trial.h"
#include "wf_log.h"
#include <string.h>
#include "pico/stdlib.h"
#include "pico/bootrom.h"
#include "pico/flash.h"
#include "hardware/flash.h"
#include "hardware/watchdog.h"
#include "boot/bootrom_constants.h"
#include "boot/picobin.h"
#include "boot/picoboot_constants.h"

static bool     g_trial;
static int      g_partition = -1;
static volatile bool     g_bought;
static volatile uint32_t g_reboot_req;        // 0 none, 1 normal, 2 flash update
static volatile uint32_t g_reboot_off;
static uint8_t __aligned(4) g_work[4096];     // PT load (3.25 KB) and explicit_buy (4 KB)

void fw_rom_boot_init(void) {
    boot_info_t bi;
    memset(&bi, 0, sizeof bi);
    if (rom_get_boot_info(&bi)) {
        g_partition = bi.partition;
        g_trial = (bi.tbyb_and_update_info & BOOT_TBYB_AND_UPDATE_FLAG_BUY_PENDING) != 0;
    }
    int rc = rom_load_partition_table(g_work, sizeof g_work, false);
    wf_logf(WF_INFO, "boot: partition %d type 0x%02x%s, pt load rc %d",
            g_partition, (unsigned)bi.boot_type, g_trial ? " TRIAL (buy pending)" : "", rc);
}

bool fw_rom_trial_boot(void)      { return g_trial && !g_bought; }
int  fw_rom_booted_partition(void) { return g_partition; }

static bool part_range(int n, uint32_t *off, uint32_t *len) {
    uint32_t buf[4];
    int rc = rom_get_partition_table_info(buf, 4,
        PT_INFO_PARTITION_LOCATION_AND_FLAGS | PT_INFO_SINGLE_PARTITION | ((uint32_t)n << 24));
    if (rc < 2) return false;
    uint32_t first = (buf[1] >> PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_LSB) & 0x1fffu;
    uint32_t last  = (buf[1] >> PICOBIN_PARTITION_LOCATION_LAST_SECTOR_LSB) & 0x1fffu;
    *off = first * 4096u;
    *len = (last + 1u - first) * 4096u;
    return true;
}

bool fw_rom_other_slot(uint32_t *off, uint32_t *len) {
    if (g_partition != 0 && g_partition != 1) return false;   // unpartitioned: no OTA
    return part_range(g_partition == 0 ? 1 : 0, off, len);
}

static void do_buy(void *p) { *(int *)p = rom_explicit_buy(g_work, sizeof g_work); }

bool fw_rom_buy(void) {
    int rc = -1;
    if (flash_safe_execute(do_buy, &rc, 2000) != PICO_OK) return false;
    wf_logf(rc == 0 ? WF_INFO : WF_ERR, "boot: explicit buy rc %d", rc);
    if (rc == 0) g_bought = true;
    return rc == 0;
}

void fw_rom_request_reboot(uint32_t flash_update_off) {
    g_reboot_off = flash_update_off;
    __dmb();
    g_reboot_req = flash_update_off ? 2u : 1u;
}

void fw_rom_watchdog_start(void) { watchdog_enable(8000, true); }

void fw_rom_service(void) {
    // The trial deadline is enforced HERE, on core0, independent of core1: a
    // trial image whose network side hangs must still revert (spec M5/M6).
    if (g_trial && !g_bought && g_reboot_req == 0 &&
        to_ms_since_boot(get_absolute_time()) >= FW_TRIAL_DEADLINE_MS) {
        wf_logf(WF_WARN, "boot: trial not confirmed within 5 minutes -- rebooting to revert");
        g_reboot_req = 1u;
    }
    if (g_reboot_req) {
        // M9: rom_reboot schedules the reset on the watchdog, and feeding the
        // watchdog cancels it. So this is the one place a reboot happens, and
        // nothing feeds the watchdog after it.
        uint32_t type = g_reboot_req == 2u ? REBOOT2_FLAG_REBOOT_TYPE_FLASH_UPDATE
                                            : REBOOT2_FLAG_REBOOT_TYPE_NORMAL;
        // The boot ROM's convention for "start of the updated region" is an XIP
        // address (spec M5). Built in two statements so Task 1's `XIP_BASE +`
        // guard stays a rule without exceptions -- this is not a flash read.
        uint32_t base = 0;
        if (g_reboot_req == 2u) { base = (uint32_t)XIP_BASE; base += g_reboot_off; }
        wf_log_drain(64);
        rom_reboot(type | REBOOT2_FLAG_NO_RETURN_ON_SUCCESS, 100, base, 0);
        for (;;) tight_loop_contents();
    }
    watchdog_update();
}
```

Confirm Task 1's guard still passes with this file in place:
`grep -nE 'XIP_BASE[[:space:]]*\+' wifi-floppy/firmware/src/*.c` must print nothing.

- [ ] **Step 5: Wire boot, watchdog and trial into `main.c`**

Add `#include "fw_rom.h"`, `#include "fw_state.h"` and `#include "fw_trial.h"`.

In `main()`, **before** `multicore_launch_core1_with_stack(...)`:

```c
    fw_rom_boot_init();
```

In `main()`, immediately before core0's `while (true) {` loop:

```c
    fw_rom_watchdog_start();
```

As the first statement inside core0's `while (true) {` loop, before `dskchg_poll();`:

```c
        fw_rom_service();
```

In `core1_main()`, immediately after
`wf_logf(WF_INFO, "entering poll loop against %s", WEBADF_HOST);` and before
`static char last_reported_sha[65] = "";`, insert the trial gate. **It runs before the
first poll, so a trial image never mounts a disk before it has confirmed itself**, and
every flash write here happens with nothing mounted:

```c
        // 2b trial (spec D8): prove the network works, THEN confirm, THEN poll.
        {
            static fw_state_t fst;
            fw_state_load(&fst);                        // zeroed if no record
            if (fw_rom_trial_boot()) {
                for (;;) {
                    bool hb = dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL,
                                               WF_FIRMWARE_VERSION);
                    fw_trial_in_t tin = { true, &fst, WF_FIRMWARE_VERSION, hb, clock_ms() };
                    const char *why = NULL;
                    fw_trial_action_t a = fw_trial_decide(&tin, &why);
                    if (a == FW_TRIAL_BUY) {
                        if (!fw_rom_buy()) {
                            wf_logf(WF_ERR, "trial: buy failed -- rebooting to revert");
                            fw_rom_request_reboot(0);
                            for (;;) sleep_ms(1000);
                        }
                        if (fw_trial_after_buy(&fst) && !fw_state_save(&fst))
                            wf_logf(WF_ERR, "trial: bought, but the state record did not save");
                        wf_logf(WF_INFO, "trial: confirmed %s", WF_FIRMWARE_VERSION);
                        break;
                    }
                    if (a == FW_TRIAL_GIVE_UP) {
                        wf_logf(WF_WARN, "trial: giving up (%s) -- rebooting to revert", why);
                        snprintf(fst.failure, sizeof fst.failure, "%s", why);
                        fw_state_save(&fst);
                        fw_rom_request_reboot(0);
                        for (;;) sleep_ms(1000);
                    }
                    tls_release_if_unreusable();
                    sleep_ms(5000);
                }
            }
        }
```

The trial runs inside the `for (;;)` provisioning loop and after association, so a trial
image that can't associate never reaches it. `fw_rom_service` (core0) then reverts it at
the deadline. That is the design, not a gap.

Also block `main.c` from calling the buy twice: `fw_rom_trial_boot()` returns false once
`g_bought` is set, which covers re-entry after a re-association.

- [ ] **Step 6: Build, and run the host tests**

Run: `pnpm firmware:test 2>&1 | tail -3 && pnpm firmware:build 2>&1 | tail -3 && ls -la wifi-floppy/firmware/build/wifi_floppy_pt.uf2`
Expected: all host tests pass, the image links, and the partition-table UF2 exists.

- [ ] **Step 7: Write `scripts/firmware-install-partitioned.sh`**

```bash
#!/usr/bin/env bash
# One-time USB install of the partitioned firmware (spec D11). Saves a full
# flash backup first: it holds the Wi-Fi password and the device token, so it
# lives outside the repo, owner-only.
set -euo pipefail
FW="$(cd "$(dirname "$0")/.." && pwd)/wifi-floppy/firmware/build"
BK="$HOME/.webadf/board-backups"
mkdir -p "$BK"; chmod 700 "$BK"

wait_bootsel() { for _ in $(seq 1 40); do picotool info >/dev/null 2>&1 && return 0; sleep 0.5; done;
  echo "board did not reach BOOTSEL -- hold BOOTSEL and tap RESET, then re-run"; exit 1; }

picotool reboot -f -u >/dev/null 2>&1 || true
wait_bootsel
out="$BK/$(date +%Y-%m-%d-%H%M%S)-before-partitioned-install.bin"
picotool save -a "$out"; chmod 600 "$out"
echo "backup: $out ($(shasum -a 256 "$out" | cut -c1-16)...)"

picotool load "$FW/wifi_floppy_pt.uf2"
picotool reboot -u; wait_bootsel
picotool partition info
picotool load -p 0 "$FW/wifi_floppy.uf2"
picotool reboot
echo "installed into slot A; watch the serial log for 'trial: confirmed'"
```

`chmod +x` it, and add to `package.json` scripts:
`"firmware:install-partitioned": "scripts/firmware-install-partitioned.sh"`.

- [ ] **Step 8: BENCH, the first install**

Run `pnpm firmware:install-partitioned` and watch the serial port
(`cat /dev/cu.usbmodem*`) for up to 2 minutes.

Expected, in order:
- `boot: partition 0 ... TRIAL (buy pending)`
- association
- `trial: confirmed <version>`
- the normal poll loop

**If the board instead comes up in BOOTSEL, or with no serial port at all**, the TBYB
image did not start from a plain `picotool reboot`. M5 says a TBYB image boots only via a
flash-update reboot, and the probe only ever loaded non-TBYB images over USB. The fix is
to load and start it in one step: re-run the last two lines as
`picotool load -p 0 -x "$FW/wifi_floppy.uf2"`. If that also fails, measure what `-x` does
before changing anything else. Record the answer in the script and in HANDOFF, whichever
it is.

Then confirm, reading the database and not only the log:
- `select firmware_version, round(extract(epoch from now()-last_seen_at)) from devices where id like '12593d21%';`
  gives the new version and an age under 60.
- `picotool info -a -f` (BOOTSEL round trip) shows partition 0 holding the image, with
  `tbyb` no longer "not bought".
- The pairing survived: the board never raised the portal.

- [ ] **Step 9: BENCH, confirm the revert path on the real firmware**

Hold the board in a failing trial without shipping a bad release: flash the same UF2 into
slot B with a flash-update reboot, while the board's network is unreachable.

Simplest: have the operator switch off the Wi-Fi access point, or temporarily point the
SSID at a wrong password through the portal. **That is the operator's step, so end the
turn and ask.**

Expected: after 5 minutes the log says `trial not confirmed within 5 minutes -- rebooting
to revert`, and the board comes back on slot A.

If the operator prefers not to touch the network now, defer this step to Task 12 item 4,
where a no-network build does the same job. Say which.

- [ ] **Step 10: Commit**

```bash
git add wifi-floppy/firmware/partitions.json wifi-floppy/firmware/src/fw_rom.[ch] wifi-floppy/firmware/src/main.c \
        wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/test/run.sh scripts/firmware-install-partitioned.sh \
        package.json src/lib/__fixtures__/picotool-info-release.txt
git commit -m "firmware: A/B partitions, TBYB images, and a trial that confirms itself

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Firmware fields on the wire: `instructionVersion`, `update`, and the status/register fields

**Files:**
- Modify: `wifi-floppy/firmware/src/json_scan.h`, `wifi-floppy/firmware/src/json_scan.c`
- Modify: `wifi-floppy/firmware/src/device_client.h`, `wifi-floppy/firmware/src/device_client.c`
- Test: `wifi-floppy/firmware/test/test_json_scan.c`, `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Produces:

```c
// json_scan.h
// Copies the {...} value of `key` (brace-matched, strings respected) into out.
// If `blank` is true the object is overwritten with spaces in `json` afterwards, so
// later flat key lookups can no longer see keys nested inside it.
bool json_object(char *json, const char *key, char *out, int out_len, bool blank);

// device_client.h
#define DC_UPDATE_PROTOCOL        1
#define DC_FW_UPDATE_JSON_BYTES   512
typedef struct {
    int         update_protocol;   // 0 = omit the field (and send 0 at register)
    const char *state;             // NULL => JSON null
    const char *error;             // NULL => JSON null
    uint32_t    instruction_ack;
} dc_fw_report_t;
void dc_set_fw_report(device_client_t *c, const dc_fw_report_t *r); // pointer is kept
// New device_client_t fields:
//   bool     fw_instruction_new;       // set by dc_step when instructionVersion moved past fw_instruction_version
//   uint32_t fw_instruction_version;
//   bool     fw_offer_present;         // an "update" object came with it
//   char     fw_update_json[DC_FW_UPDATE_JSON_BYTES];
//   const dc_fw_report_t *_fw_report;
```

- [ ] **Step 1: Write failing tests**

Append to `test/test_json_scan.c` (and `RUN` them in its `main`):

```c
static void test_json_object_extracts_and_blanks(void) {
    char body[] = "{\"version\":7,\"desired\":{\"sha256\":\"aa\"},\"instructionVersion\":3,"
                  "\"update\":{\"version\":\"1.1.0+gx\",\"sha256\":\"bb\",\"s\":\"}{\\\"\"}}";
    char obj[128];
    CHECK(json_object(body, "update", obj, sizeof obj, true), "found");
    CHECK(strcmp(obj, "{\"version\":\"1.1.0+gx\",\"sha256\":\"bb\",\"s\":\"}{\\\"\"}") == 0,
          "braces inside strings do not end the object");
    char v[16];
    CHECK(json_str(body, "sha256", v, sizeof v) && strcmp(v, "aa") == 0,
          "after blanking, the only sha256 left is the desired disk's");
    uint32_t iv = 0;
    CHECK(json_u32(body, "instructionVersion", &iv) && iv == 3, "siblings are untouched");
}
static void test_json_object_too_small_fails_cleanly(void) {
    char body[] = "{\"update\":{\"version\":\"1.1.0+gx\"}}";
    char obj[8];
    CHECK(!json_object(body, "update", obj, sizeof obj, true), "does not fit");
    CHECK(strstr(body, "1.1.0+gx") != NULL, "nothing blanked when the copy failed");
}
static void test_json_object_absent(void) {
    char body[] = "{\"version\":1}";
    char obj[32];
    CHECK(!json_object(body, "update", obj, sizeof obj, true), "absent key");
}
```

Append to `test/test_device_client.c` (and `RUN` them):

```c
// Review Focus 1: a disk and an update in one body. Both carry version/sha256.
static void test_update_object_does_not_leak_into_disk_fields(void) {
    boot();
    push_ok_json("{\"version\":7,\"desired\":null,\"instructionVersion\":2,"
                 "\"update\":{\"version\":\"1.1.0+gx\",\"sequence\":5,\"sha256\":\""
                 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\","
                 "\"sizeBytes\":1000,\"signature\":\"AA==\",\"keyId\":\"wf-x\"}}");
    dc_step(&c);
    CHECK_EQ_INT(c.since, 7);                  // the top-level version, not the update's
    CHECK(c.mounted_sha256[0] == '\0', "desired:null stays an eject; the update's sha256 is not a disk");
    CHECK(c.fw_instruction_new, "a moved instruction is flagged");
    CHECK_EQ_INT(c.fw_instruction_version, 2);
    CHECK(c.fw_offer_present, "the update came with it");
    CHECK(strstr(c.fw_update_json, "\"sequence\":5") != NULL, "and is kept whole for the parser");
}
static void test_unchanged_instruction_is_not_new(void) {
    boot();
    c.fw_instruction_version = 2;
    push_ok_json("{\"version\":1,\"desired\":null,\"instructionVersion\":2}");
    dc_step(&c);
    CHECK(!c.fw_instruction_new, "the same cursor again is not a new instruction");
}
static void test_a_cancel_is_new_with_no_offer(void) {
    boot();
    c.fw_instruction_version = 2;
    push_ok_json("{\"version\":1,\"desired\":null,\"instructionVersion\":3}");
    dc_step(&c);
    CHECK(c.fw_instruction_new && !c.fw_offer_present, "moved, no update: a cancellation");
}
static void test_status_carries_the_firmware_fields(void) {
    boot();
    dc_fw_report_t r = { DC_UPDATE_PROTOCOL, "downloading", NULL, 4 };
    dc_set_fw_report(&c, &r);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.0.0+gt"), "sent");
    const char *q = fake_last_request();
    CHECK(strstr(q, "\"updateProtocol\":1") != NULL, "protocol");
    CHECK(strstr(q, "\"firmwareUpdateState\":\"downloading\"") != NULL, "state");
    CHECK(strstr(q, "\"firmwareUpdateError\":null") != NULL, "an absent error is an explicit null");
    CHECK(strstr(q, "\"firmwareInstructionAck\":4") != NULL, "ack");
}
static void test_status_without_a_fw_report_omits_the_fields(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.0.0+gt");
    CHECK(strstr(fake_last_request(), "updateProtocol") == NULL,
          "a board that has not opted in must not claim the capability");
}
static void test_register_sends_the_protocol_only_when_set(void) {
    boot();
    dc_fw_report_t r = { DC_UPDATE_PROTOCOL, NULL, NULL, 0 };
    dc_set_fw_report(&c, &r);
    push_ok_json("{\"token\":\"t\"}");
    dc_register(&c, "ABC123", "1.0.0+gt", "aa:bb:cc:dd:ee:ff");
    CHECK(strstr(fake_last_request(), "\"updateProtocol\":1") != NULL, "register declares it");
}
```

Extend `test_status_body_fits_at_maximum` too: before `dc_report_status`, set a report
with a 200-character error and a 10-digit ack:

```c
    static char long_fw_err[201]; memset(long_fw_err, 'F', 200); long_fw_err[200] = '\0';
    dc_fw_report_t fr = { DC_UPDATE_PROTOCOL, "downloading", long_fw_err, 4294967295u };
    dc_set_fw_report(&c, &fr);
```

and add
`CHECK(strstr(r, "\"firmwareInstructionAck\":4294967295") != NULL, "the last firmware field survives");`.
Register and status bodies with the report set must still fit.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm firmware:test 2>&1 | grep -E "COMPILE FAIL|FAIL" | head`
Expected: compile failures for `json_object`, `dc_set_fw_report` and `fw_instruction_new`.

- [ ] **Step 3: Implement `json_object`** in `json_scan.c` (declare it in `json_scan.h`)

```c
bool json_object(char *json, const char *key, char *out, int out_len, bool blank) {
    const char *v = find_value(json, key);
    if (!v || *v != '{' || out_len <= 0) return false;
    int depth = 0;
    const char *p = v;
    for (; *p; p++) {
        if (*p == '"') {                       // walk a string whole, escapes included
            p++;
            while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; }
            if (!*p) return false;
            continue;
        }
        if (*p == '{') depth++;
        else if (*p == '}' && --depth == 0) break;
    }
    if (!*p) return false;                     // unterminated object
    int n = (int)(p - v) + 1;
    if (n >= out_len) return false;
    memcpy(out, v, (size_t)n);
    out[n] = '\0';
    if (blank) memset((char *)v, ' ', (size_t)n);
    return true;
}
```

Update `find_value`'s header comment: "every key this device reads is unique across the
whole response shape, **once `update` has been lifted out by `json_object(..., true)`**;
dc_step does that before anything else reads the body."

- [ ] **Step 4: Implement the device-client side**

In `device_client.h`, add the defines, `dc_fw_report_t`, the new `device_client_t` fields
from the interface block, and `dc_set_fw_report`. Raise the status budgets for the four
new fields. The worst case adds ~`,"updateProtocol":1,"firmwareUpdateState":"downloading","firmwareUpdateError":"<200>","firmwareInstructionAck":4294967295`
≈ 300 bytes:

```c
#define DC_STATUS_BODY_BYTES  1024
#define DC_STATUS_REQ_BYTES   1536
```

In `device_client.c`:

```c
void dc_set_fw_report(device_client_t *c, const dc_fw_report_t *r) { c->_fw_report = r; }

// Lifts `update` out of a 200 poll body BEFORE anything else reads it: its
// version/sha256 keys would otherwise be found by the disk logic's flat scans.
static void dc_take_fw_fields(device_client_t *c, char *json) {
    c->fw_offer_present = json_object(json, "update", c->fw_update_json,
                                      sizeof c->fw_update_json, true);
    uint32_t iv = 0;
    if (json_u32(json, "instructionVersion", &iv) && iv > c->fw_instruction_version) {
        c->fw_instruction_version = iv;
        c->fw_instruction_new = true;
    } else if (c->fw_offer_present) {
        // An update with no moved cursor is stale. Never act on it.
        c->fw_offer_present = false;
    }
}
```

In `dc_step`'s `case 200:`, after the `body.truncated` refusal and before
`return dc_handle_poll_body(c, body.buf);`, add `dc_take_fw_fields(c, body.buf);`.

In `dc_report_status`, after building `ver_field`, build the optional firmware tail and
splice it in before the closing brace:

```c
    static char fw_tail[DC_STATUS_ERR_BYTES + 160];
    fw_tail[0] = '\0';
    if (c->_fw_report && c->_fw_report->update_protocol > 0) {
        const dc_fw_report_t *f = c->_fw_report;
        static char st_field[40], er_field[DC_STATUS_ERR_BYTES + 2];
        if (f->state) {
            static char st_esc[32];
            dc_json_escape(st_esc, sizeof st_esc, f->state);
            snprintf(st_field, sizeof st_field, "\"%s\"", st_esc);
        } else snprintf(st_field, sizeof st_field, "null");
        if (f->error) {
            static char er_esc[201];
            dc_json_escape(er_esc, sizeof er_esc, f->error);
            snprintf(er_field, sizeof er_field, "\"%s\"", er_esc);
        } else snprintf(er_field, sizeof er_field, "null");
        snprintf(fw_tail, sizeof fw_tail,
                 ",\"updateProtocol\":%d,\"firmwareUpdateState\":%s,"
                 "\"firmwareUpdateError\":%s,\"firmwareInstructionAck\":%lu",
                 f->update_protocol, st_field, er_field, (unsigned long)f->instruction_ack);
    }
```

and change the body format's ending from `...\"rssi\":%d}"` to `...\"rssi\":%d%s}"`,
passing `fw_tail` as the last argument.

In `dc_register`'s body builder (line ~799), change the format to
`"{\"pairingCode\":\"%s\",\"firmwareVersion\":\"%s\",\"macAddress\":\"%s\"%s}"` and pass a
tail that is `,"updateProtocol":%d` when `c->_fw_report && c->_fw_report->update_protocol > 0`,
and `""` otherwise. Check that register's request buffer has room for the extra ~20
bytes, and raise its define if the new register test fails on size.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm firmware:test 2>&1 | grep -E "test_json_scan|test_device_client|FAIL"`
Expected: both report `0 failed`.

- [ ] **Step 6: Check the server's poll-body budget still holds**

Run: `pnpm vitest run src/lib/device-limits.test.ts`
Expected: pass. This test (from 2a) computes the worst-case poll body, including `update`,
against `DC_POLL_BODY_BYTES`. Nothing here changes that constant, so it must stay green.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/json_scan.[ch] wifi-floppy/firmware/src/device_client.[ch] \
        wifi-floppy/firmware/test/test_json_scan.c wifi-floppy/firmware/test/test_device_client.c
git commit -m "firmware: read the firmware instruction off the poll, report update state

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Signature verification: Monocypher, `fw_offer`, `fw_verify`, the compiled-in key (D4, D5)

**Files:**
- Create: `wifi-floppy/firmware/src/vendor/monocypher/` (`monocypher.c/.h`,
  `monocypher-ed25519.c/.h`, `LICENCE.md`, `VENDORED.md`)
- Create: `wifi-floppy/firmware/src/fw_offer.h/.c`, `wifi-floppy/firmware/src/fw_verify.h/.c`
- Create (generated, committed): `wifi-floppy/firmware/src/fw_pubkey.h`,
  `wifi-floppy/firmware/test/fw_fixture.h`
- Create: `src/lib/firmware-c-headers.ts`, `src/lib/firmware-c-headers.test.ts`,
  `scripts/firmware-c-headers.ts`
- Test: `wifi-floppy/firmware/test/test_fw_verify.c`
- Modify: `wifi-floppy/firmware/test/run.sh`, `wifi-floppy/firmware/CMakeLists.txt`, `package.json`

**Interfaces:**
- Consumes: `json_str`/`json_u32` (existing) and the manifest format (Global Constraints).
- Produces:

```c
// fw_offer.h
#define FW_MAX_IMAGE_BYTES (2u * 1024u * 1024u)
#define FW_KEY_ID_MAX 32
typedef struct {
    char     version[65];
    uint32_t sequence;
    char     sha256[65];
    uint32_t size_bytes;
    uint8_t  signature[64];
    char     key_id[FW_KEY_ID_MAX + 1];
} fw_offer_t;
bool fw_offer_parse(const char *update_json, fw_offer_t *out);
// fw_verify.h
typedef enum { FW_OK, FW_BAD_FIELDS, FW_TOO_BIG, FW_ROLLBACK, FW_UNKNOWN_KEY, FW_BAD_SIGNATURE } fw_verdict_t;
int fw_manifest(const fw_offer_t *o, char *out, int out_len);   // length, or -1
fw_verdict_t fw_check_offer_with_key(const fw_offer_t *o, uint32_t installed_sequence,
                                     const char *key_id, const uint8_t pubkey[32]);
fw_verdict_t fw_check_offer(const fw_offer_t *o, uint32_t installed_sequence); // FW_PUBKEY
const char *fw_verdict_text(fw_verdict_t v);
```

```ts
// src/lib/firmware-c-headers.ts
export function pubkeyHeader(pemText: string): string;           // -> fw_pubkey.h contents
export function fixtureHeader(): string;                         // -> test/fw_fixture.h contents (deterministic)
export const FIXTURE_SEED_HEX: string;                           // test-only key seed
```

- [ ] **Step 1: Vendor Monocypher 4.0.2**

```bash
cd "$(mktemp -d)"
curl -fsSLO https://monocypher.org/download/monocypher-4.0.2.tar.gz
curl -fsSL -o gh.tar.gz https://github.com/LoupVaillant/Monocypher/archive/refs/tags/4.0.2.tar.gz
shasum -a 256 monocypher-4.0.2.tar.gz
tar xzf monocypher-4.0.2.tar.gz
D=/Users/sfs/Devel/webadf/wifi-floppy/firmware/src/vendor/monocypher; mkdir -p $D
cp monocypher-4.0.2/src/monocypher.[ch] monocypher-4.0.2/src/optional/monocypher-ed25519.[ch] $D/
cp monocypher-4.0.2/LICENCE.md $D/
tar xzf gh.tar.gz && diff -r monocypher-4.0.2/src Monocypher-4.0.2/src && echo "tarball matches the GitHub tag"
```

If the diff reports differences, **stop**. Two sources disagreeing about a crypto library
is not a mismatch to work around.

Write `$D/VENDORED.md` with the version, both URLs, the tarball's SHA-256 as printed, the
date, and the note: "unmodified; only `crypto_ed25519_check` (RFC 8032, SHA-512) is used."

- [ ] **Step 2: Compile the vendored files into host tests without holding them to our
warning flags**

In `test/run.sh`, before the `for t in test_*.c` loop:

```bash
# Vendored Monocypher 4.0.2 (src/vendor/monocypher/VENDORED.md): compiled once,
# warnings off -- it is not our code and is not edited -- and linked into every
# test binary. It lives under src/vendor/, so the ../src/*.c glob never sees it.
cc -std=c11 -O1 -w -c ../src/vendor/monocypher/monocypher.c -o .build/monocypher.o
cc -std=c11 -O1 -w -I../src/vendor/monocypher -c ../src/vendor/monocypher/monocypher-ed25519.c -o .build/monocypher-ed25519.o
```

and add `.build/monocypher.o .build/monocypher-ed25519.o -I../src/vendor/monocypher` to
the per-test `cc` line.

In `CMakeLists.txt`, add the two `.c` files to `add_executable`, plus
`target_include_directories(wifi_floppy PRIVATE src/vendor/monocypher)`, and
`set_source_files_properties(src/vendor/monocypher/monocypher.c src/vendor/monocypher/monocypher-ed25519.c PROPERTIES COMPILE_OPTIONS "-w")`.

- [ ] **Step 3: Write the header generators and their drift tests (TypeScript)**

`src/lib/firmware-c-headers.ts`:

```ts
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { firmwareManifest } from '@/lib/firmware-manifest';

/** An SPKI-encoded ed25519 public key is this 12-byte prefix + the raw 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** PKCS#8 for an ed25519 private key is this 16-byte prefix + the 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyIdOf(spkiDer: Buffer): string {
  return `wf-${createHash('sha256').update(spkiDer).digest('hex').slice(0, 16)}`;
}
function cBytes(b: Buffer): string {
  return [...b].map((x) => `0x${x.toString(16).padStart(2, '0')}`).join(', ');
}

export function pubkeyHeader(pemText: string): string {
  const der = createPublicKey(pemText).export({ type: 'spki', format: 'der' }) as Buffer;
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('not an ed25519 SPKI public key');
  }
  return [
    '// GENERATED by scripts/firmware-c-headers.ts from wifi-floppy/firmware/keys/*.pem.',
    '// Do not edit. src/lib/firmware-c-headers.test.ts fails if this drifts from the key.',
    '#ifndef FW_PUBKEY_H',
    '#define FW_PUBKEY_H',
    '#include <stdint.h>',
    `#define FW_PUBKEY_ID "${keyIdOf(der)}"`,
    `static const uint8_t FW_PUBKEY[32] = { ${cBytes(der.subarray(12))} };`,
    '#endif',
    '',
  ].join('\n');
}

/** A TEST-ONLY key. Never the release key: its seed is in the repository. */
export const FIXTURE_SEED_HEX = '0f'.repeat(32);

export function fixtureHeader(): string {
  const priv = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(FIXTURE_SEED_HEX, 'hex')]),
    format: 'der', type: 'pkcs8',
  });
  const der = createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer;
  const offer = { version: '1.2.0+gfixture', sequence: 7, sha256: 'ab'.repeat(32), sizeBytes: 533624 };
  const manifest = firmwareManifest(offer);
  const sig = sign(null, Buffer.from(manifest, 'ascii'), priv);   // ed25519 is deterministic
  return [
    '// GENERATED by scripts/firmware-c-headers.ts. A cross-implementation fixture:',
    '// signed by node:crypto over the manifest the SERVER builds, verified in C by',
    '// Monocypher over the manifest the FIRMWARE builds. Test key only.',
    '#ifndef FW_FIXTURE_H',
    '#define FW_FIXTURE_H',
    '#include <stdint.h>',
    `#define FIX_KEY_ID "${keyIdOf(der)}"`,
    `static const uint8_t FIX_PUBKEY[32] = { ${cBytes(der.subarray(12))} };`,
    `#define FIX_VERSION "${offer.version}"`,
    `#define FIX_SEQUENCE ${offer.sequence}u`,
    `#define FIX_SHA256 "${offer.sha256}"`,
    `#define FIX_SIZE ${offer.sizeBytes}u`,
    `#define FIX_SIGNATURE_B64 "${sig.toString('base64')}"`,
    `#define FIX_MANIFEST ${JSON.stringify(manifest)}`,
    '#endif',
    '',
  ].join('\n');
}
```

`scripts/firmware-c-headers.ts`:

```ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pubkeyHeader, fixtureHeader } from '@/lib/firmware-c-headers';

const fw = join(process.cwd(), 'wifi-floppy', 'firmware');
const pems = readdirSync(join(fw, 'keys')).filter((f) => f.endsWith('.pem'));
if (pems.length !== 1) throw new Error(`expected exactly one key in keys/, found ${pems.length}`);
writeFileSync(join(fw, 'src', 'fw_pubkey.h'), pubkeyHeader(readFileSync(join(fw, 'keys', pems[0]), 'utf8')));
writeFileSync(join(fw, 'test', 'fw_fixture.h'), fixtureHeader());
console.log('wrote src/fw_pubkey.h and test/fw_fixture.h');
```

Add to `package.json`: `"firmware:headers": "tsx scripts/firmware-c-headers.ts"`.

`src/lib/firmware-c-headers.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pubkeyHeader, fixtureHeader } from '@/lib/firmware-c-headers';

const fw = join(process.cwd(), 'wifi-floppy', 'firmware');

describe('generated firmware headers', () => {
  it('fw_pubkey.h is the committed key, byte for byte', () => {
    const pem = readdirSync(join(fw, 'keys')).find((f) => f.endsWith('.pem'))!;
    expect(readFileSync(join(fw, 'src', 'fw_pubkey.h'), 'utf8'))
      .toBe(pubkeyHeader(readFileSync(join(fw, 'keys', pem), 'utf8')));
  });
  it('names the key by the same id the publish script records', () => {
    expect(readFileSync(join(fw, 'src', 'fw_pubkey.h'), 'utf8')).toContain('"wf-1138f25902223da4"');
  });
  it('test/fw_fixture.h has not drifted from the manifest the server builds', () => {
    expect(readFileSync(join(fw, 'test', 'fw_fixture.h'), 'utf8')).toBe(fixtureHeader());
  });
});
```

This test imports `firmwareManifest`. **Create `src/lib/firmware-manifest.ts` now with
only these two exports.** Task 7 adds `refuseReleaseImage` test-first.

```ts
/**
 * The exact bytes a release's signature covers (spec D4). The firmware builds
 * the same string in fw_verify.c; test/fw_fixture.h proves they agree.
 * Changing a single character here strands every board in the field.
 */
export const FIRMWARE_MAX_BYTES = 2 * 1024 * 1024;

export function firmwareManifest(m: { version: string; sequence: number; sha256: string; sizeBytes: number }): string {
  return `webadf-fw-v1\n${m.version}\n${m.sequence}\n${m.sha256}\n${m.sizeBytes}`;
}
```

Run: `pnpm firmware:headers && pnpm vitest run src/lib/firmware-c-headers.test.ts`
Expected: the headers are written and all 3 tests pass.

- [ ] **Step 4: Write the failing C test** at `test/test_fw_verify.c`

```c
#include "harness.h"
#include "fw_fixture.h"
#include "../src/fw_offer.h"
#include "../src/fw_verify.h"
#include "../src/fw_pubkey.h"
#include <string.h>

static const char *OFFER_JSON =
    "{\"version\":\"" FIX_VERSION "\",\"sequence\":7,\"sha256\":\"" FIX_SHA256 "\","
    "\"sizeBytes\":533624,\"signature\":\"" FIX_SIGNATURE_B64 "\",\"keyId\":\"" FIX_KEY_ID "\"}";

static fw_offer_t parsed(void) {
    fw_offer_t o; memset(&o, 0, sizeof o);
    CHECK(fw_offer_parse(OFFER_JSON, &o), "the fixture offer parses");
    return o;
}

// The one test that matters most: node:crypto signed the SERVER's manifest; Monocypher
// must verify it over the FIRMWARE's manifest. If the two manifests differ by one byte,
// this fails.
static void test_cross_implementation_signature_verifies(void) {
    fw_offer_t o = parsed();
    char m[256];
    CHECK(fw_manifest(&o, m, sizeof m) == (int)strlen(FIX_MANIFEST), "manifest length");
    CHECK(strcmp(m, FIX_MANIFEST) == 0, "the firmware builds the server's manifest exactly");
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_OK);
}
// RFC 8032 section 7.1, TEST 2: proves the SHA-512 Ed25519 variant, not Monocypher's
// default BLAKE2b EdDSA, is what is linked.
static void test_rfc8032_test2(void) {
    static const uint8_t pk[32] = {
        0x3d,0x40,0x17,0xc3,0xe8,0x43,0x89,0x5a,0x92,0xb7,0x0a,0xa7,0x4d,0x1b,0x7e,0xbc,
        0x9c,0x98,0x2c,0xcf,0x2e,0xc4,0x96,0x8c,0xc0,0xcd,0x55,0xf1,0x2a,0xf4,0x66,0x0c };
    static const uint8_t sig[64] = {
        0x92,0xa0,0x09,0xa9,0xf0,0xd4,0xca,0xb8,0x72,0x0e,0x82,0x0b,0x5f,0x64,0x25,0x40,
        0xa2,0xb2,0x7b,0x54,0x16,0x50,0x3f,0x8f,0xb3,0x76,0x22,0x23,0xeb,0xdb,0x69,0xda,
        0x08,0x5a,0xc1,0xe4,0x3e,0x15,0x99,0x6e,0x45,0x8f,0x36,0x13,0xd0,0xf1,0x1d,0x8c,
        0x38,0x7b,0x2e,0xae,0xb4,0x30,0x2a,0xee,0xb0,0x0d,0x29,0x16,0x12,0xbb,0x0c,0x00 };
    static const uint8_t msg[1] = { 0x72 };
    CHECK(fw_ed25519_check(sig, pk, msg, 1), "RFC 8032 TEST 2 verifies");
    uint8_t bad[64]; memcpy(bad, sig, 64); bad[0] ^= 1;
    CHECK(!fw_ed25519_check(bad, pk, msg, 1), "and a flipped bit does not");
}
static void test_tampered_sequence_is_refused(void) {
    fw_offer_t o = parsed(); o.sequence = 99;   // a server lying about the sequence
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_BAD_SIGNATURE);
}
static void test_tampered_sha_is_refused(void) {
    fw_offer_t o = parsed(); o.sha256[0] = 'c';
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_BAD_SIGNATURE);
}
static void test_rollback_is_refused_before_the_signature(void) {
    fw_offer_t o = parsed();
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 7, FIX_KEY_ID, FIX_PUBKEY), FW_ROLLBACK);
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 8, FIX_KEY_ID, FIX_PUBKEY), FW_ROLLBACK);
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 6, FIX_KEY_ID, FIX_PUBKEY), FW_OK);
}
static void test_unknown_key_is_refused(void) {
    fw_offer_t o = parsed();
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, "wf-someoneelse", FIX_PUBKEY), FW_UNKNOWN_KEY);
}
static void test_too_big_is_refused(void) {
    fw_offer_t o = parsed(); o.size_bytes = FW_MAX_IMAGE_BYTES + 1;
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_TOO_BIG);
}
static void test_the_release_key_is_compiled_in(void) {
    CHECK(strcmp(FW_PUBKEY_ID, "wf-1138f25902223da4") == 0, "the committed release key");
    fw_offer_t o = parsed();   // signed by the TEST key: the real key must refuse it
    CHECK_EQ_INT(fw_check_offer(&o, 0), FW_UNKNOWN_KEY);
}
static void test_malformed_offers_do_not_parse(void) {
    fw_offer_t o;
    CHECK(!fw_offer_parse("{\"version\":\"1.0.0+g\",\"sequence\":7}", &o), "missing fields");
    CHECK(!fw_offer_parse("{\"version\":\"1.0.0+g\",\"sequence\":7,\"sha256\":\"xyz\","
                          "\"sizeBytes\":1,\"signature\":\"" FIX_SIGNATURE_B64 "\",\"keyId\":\"k\"}", &o),
          "a sha256 that is not 64 hex");
    CHECK(!fw_offer_parse("{\"version\":\"1.0.0+g\",\"sequence\":7,\"sha256\":\"" FIX_SHA256 "\","
                          "\"sizeBytes\":1,\"signature\":\"AA==\",\"keyId\":\"k\"}", &o),
          "a signature that is not 64 bytes");
    CHECK(!fw_offer_parse("{\"version\":\"\",\"sequence\":7,\"sha256\":\"" FIX_SHA256 "\","
                          "\"sizeBytes\":1,\"signature\":\"" FIX_SIGNATURE_B64 "\",\"keyId\":\"k\"}", &o),
          "an empty version");
}

int main(void) {
    RUN(test_cross_implementation_signature_verifies);
    RUN(test_rfc8032_test2);
    RUN(test_tampered_sequence_is_refused);
    RUN(test_tampered_sha_is_refused);
    RUN(test_rollback_is_refused_before_the_signature);
    RUN(test_unknown_key_is_refused);
    RUN(test_too_big_is_refused);
    RUN(test_the_release_key_is_compiled_in);
    RUN(test_malformed_offers_do_not_parse);
    return REPORT();
}
```

`fw_ed25519_check(sig, pk, msg, len)` is a thin `bool` wrapper exported by `fw_verify.h`,
so the RFC vector exercises the same linked function as the offer path. Before relying on
the RFC 8032 TEST 2 bytes above, check them against the RFC text itself, §7.1 (public key
`3d4017c3…660c`, signature `92a009a9…bb0c00`, message `72`).

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm firmware:test 2>&1 | grep -A2 test_fw_verify`
Expected: `COMPILE FAIL`.

- [ ] **Step 6: Implement `fw_offer.c` and `fw_verify.c`**

`src/fw_offer.c`:

```c
#include "fw_offer.h"
#include "json_scan.h"
#include <string.h>

static int b64v(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
// Strict: length a multiple of 4, '=' only as the last one or two characters.
static int b64_decode(const char *in, uint8_t *out, int cap) {
    size_t n = strlen(in);
    if (n == 0 || n % 4) return -1;
    int o = 0;
    for (size_t i = 0; i < n; i += 4) {
        int v[4], pad = 0;
        for (int k = 0; k < 4; k++) {
            char ch = in[i + (size_t)k];
            if (ch == '=') {
                if (i + 4 != n || k < 2) return -1;
                v[k] = 0; pad++;
            } else {
                if (pad) return -1;
                v[k] = b64v(ch);
                if (v[k] < 0) return -1;
            }
        }
        uint32_t w = ((uint32_t)v[0] << 18) | ((uint32_t)v[1] << 12) | ((uint32_t)v[2] << 6) | (uint32_t)v[3];
        for (int k = 0; k < 3 - pad; k++) {
            if (o >= cap) return -1;
            out[o++] = (uint8_t)(w >> (16 - 8 * k));
        }
    }
    return o;
}
static bool is_hex64(const char *s) {
    if (strlen(s) != 64) return false;
    for (int i = 0; i < 64; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return true;
}

bool fw_offer_parse(const char *j, fw_offer_t *o) {
    memset(o, 0, sizeof *o);
    char sig_b64[96];
    if (!json_str(j, "version", o->version, sizeof o->version) || o->version[0] == '\0') return false;
    if (!json_u32(j, "sequence", &o->sequence) || o->sequence == 0) return false;
    if (!json_str(j, "sha256", o->sha256, sizeof o->sha256) || !is_hex64(o->sha256)) return false;
    if (!json_u32(j, "sizeBytes", &o->size_bytes) || o->size_bytes == 0) return false;
    if (!json_str(j, "signature", sig_b64, sizeof sig_b64)) return false;
    if (b64_decode(sig_b64, o->signature, sizeof o->signature) != 64) return false;
    if (!json_str(j, "keyId", o->key_id, sizeof o->key_id) || o->key_id[0] == '\0') return false;
    return true;
}
```

`src/fw_verify.c`:

```c
#include "fw_verify.h"
#include "fw_pubkey.h"
#include "monocypher-ed25519.h"
#include <stdio.h>
#include <string.h>

int fw_manifest(const fw_offer_t *o, char *out, int out_len) {
    int n = snprintf(out, (size_t)out_len, "webadf-fw-v1\n%s\n%lu\n%s\n%lu",
                     o->version, (unsigned long)o->sequence, o->sha256, (unsigned long)o->size_bytes);
    return (n < 0 || n >= out_len) ? -1 : n;
}

bool fw_ed25519_check(const uint8_t sig[64], const uint8_t pk[32], const uint8_t *msg, size_t len) {
    return crypto_ed25519_check(sig, pk, msg, len) == 0;
}

fw_verdict_t fw_check_offer_with_key(const fw_offer_t *o, uint32_t installed_sequence,
                                     const char *key_id, const uint8_t pubkey[32]) {
    if (o->version[0] == '\0' || strlen(o->sha256) != 64 || o->sequence == 0) return FW_BAD_FIELDS;
    if (o->size_bytes == 0 || o->size_bytes > FW_MAX_IMAGE_BYTES) return FW_TOO_BIG;
    if (o->sequence <= installed_sequence) return FW_ROLLBACK;
    if (strcmp(o->key_id, key_id) != 0) return FW_UNKNOWN_KEY;
    char m[192];
    int n = fw_manifest(o, m, sizeof m);
    if (n < 0) return FW_BAD_FIELDS;
    return fw_ed25519_check(o->signature, pubkey, (const uint8_t *)m, (size_t)n) ? FW_OK : FW_BAD_SIGNATURE;
}

fw_verdict_t fw_check_offer(const fw_offer_t *o, uint32_t installed_sequence) {
    return fw_check_offer_with_key(o, installed_sequence, FW_PUBKEY_ID, FW_PUBKEY);
}

const char *fw_verdict_text(fw_verdict_t v) {
    switch (v) {
    case FW_OK:            return "ok";
    case FW_BAD_FIELDS:    return "malformed update instruction";
    case FW_TOO_BIG:       return "image larger than 2 MB";
    case FW_ROLLBACK:      return "not newer than the installed release (anti-rollback)";
    case FW_UNKNOWN_KEY:   return "signed by an unknown key";
    case FW_BAD_SIGNATURE: return "signature does not verify";
    }
    return "unknown";
}
```

Declare `fw_ed25519_check` in `fw_verify.h`, with `#include <stddef.h>`. Add
`src/fw_offer.c` and `src/fw_verify.c` to `add_executable`.

- [ ] **Step 7: Run all the tests to verify they pass**

Run: `pnpm firmware:test 2>&1 | grep -E "test_fw_verify|FAIL" && pnpm firmware:build 2>&1 | tail -2`
Expected: `test_fw_verify.c: N checks, 0 failed`, no FAIL lines, and a clean firmware
build.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/src/vendor wifi-floppy/firmware/src/fw_offer.[ch] wifi-floppy/firmware/src/fw_verify.[ch] \
        wifi-floppy/firmware/src/fw_pubkey.h wifi-floppy/firmware/test/fw_fixture.h wifi-floppy/firmware/test/test_fw_verify.c \
        wifi-floppy/firmware/test/run.sh wifi-floppy/firmware/CMakeLists.txt \
        src/lib/firmware-c-headers.ts src/lib/firmware-c-headers.test.ts src/lib/firmware-manifest.ts \
        scripts/firmware-c-headers.ts package.json
git commit -m "firmware: verify a signed manifest (Monocypher ed25519, compiled-in key)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Server: `signature_format`, manifest signing, and offering only verifiable releases (D4, D10)

**Files:**
- Create: `src/lib/firmware-manifest.ts` (created in Task 6; the tests land here),
  `src/lib/firmware-manifest.test.ts`
- Modify: `src/db/schema/firmware.ts`. Create: `drizzle/0022_*.sql` via
  `pnpm drizzle-kit generate`.
- Modify: `src/lib/firmware-releases.ts`, `src/lib/mount.ts` (`readFirmwareInstruction`),
  `src/lib/firmware-state.ts` (`ReleaseRef`), `src/lib/firmware-update-rules.ts` (+ test)
- Modify: `scripts/firmware-release.ts`
- Modify: `e2e/device-helpers.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/firmware-manifest.ts
export const FIRMWARE_MAX_BYTES = 2 * 1024 * 1024;
export function firmwareManifest(m: { version: string; sequence: number; sha256: string; sizeBytes: number }): string;
/** null when the image may be published, else the refusal reason. */
export function refuseReleaseImage(picotoolInfo: string, sizeBytes: number, bytes: Buffer): string | null;
// firmware_releases.signature_format: integer NOT NULL DEFAULT 1
// ReleaseRef gains `signatureFormat?: number`
// TargetRefusal gains 'unverifiable_release'
// publishRelease(input, userId, expectedSequence: number)
```

- [ ] **Step 1: Write the failing tests** at `src/lib/firmware-manifest.test.ts`

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firmwareManifest, refuseReleaseImage, FIRMWARE_MAX_BYTES } from '@/lib/firmware-manifest';

const realInfo = readFileSync(join(__dirname, '__fixtures__', 'picotool-info-release.txt'), 'utf8');
const bytes = Buffer.from('image');

describe('firmwareManifest', () => {
  it('is exactly the spec text, no trailing newline', () => {
    expect(firmwareManifest({ version: '1.2.0+gabc1234', sequence: 7, sha256: 'ab'.repeat(32), sizeBytes: 1068032 }))
      .toBe(`webadf-fw-v1\n1.2.0+gabc1234\n7\n${'ab'.repeat(32)}\n1068032`);
  });
});

describe('refuseReleaseImage', () => {
  it('accepts the real TBYB, hashed build output', () => {
    expect(refuseReleaseImage(realInfo, 533624, bytes)).toBeNull();
  });
  it('refuses an image that is not TBYB -- it would boot unconditionally and never revert', () => {
    expect(refuseReleaseImage(realInfo.replace(/tbyb:.*\n/g, ''), 533624, bytes)).toMatch(/TBYB/);
  });
  it('refuses an image with no hash for the boot ROM to check', () => {
    expect(refuseReleaseImage(realInfo.replace(/^.*hash.*$/gim, ''), 533624, bytes)).toMatch(/hash/);
  });
  it('refuses anything over 2 MB', () => {
    expect(refuseReleaseImage(realInfo, FIRMWARE_MAX_BYTES + 1, bytes)).toMatch(/2 MB/);
  });
  it('refuses a build with the debug-only firmware command compiled in', () => {
    expect(refuseReleaseImage(realInfo, 533624, Buffer.from('xx fwdbg xx'))).toMatch(/debug/);
  });
});
```

Add to `src/lib/firmware-update-rules.test.ts`:

```ts
it('refuses a target release the board cannot verify (signature format 1)', () => {
  const reg = buildRegistry([{ ...rel('1.1.0+ga', 2), signatureFormat: 1 }]);
  expect(refuseTarget(capable('1.0.0+gold'), reg.latest!, reg)).toBe('unverifiable_release');
});
```

Use the file's existing helpers. If it has none named `rel`/`capable`, construct the
`ReleaseRef` and `TargetCandidate` literals the way its other tests do, and give every
existing `ReleaseRef` literal in that file `signatureFormat: 2`, so none of them starts
refusing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/firmware-manifest.test.ts src/lib/firmware-update-rules.test.ts`
Expected: FAIL, with `refuseReleaseImage` not exported and `unverifiable_release` never
returned.

- [ ] **Step 3: Add `refuseReleaseImage` to `src/lib/firmware-manifest.ts`** (the
manifest half already exists from Task 6)

```ts
/**
 * Spec D10: the one packaging mistake that removes the safety net is a release
 * without TBYB -- it boots unconditionally on update and can never revert. A
 * machine checks it, from picotool's own reading of the image.
 */
export function refuseReleaseImage(picotoolInfo: string, sizeBytes: number, bytes: Buffer): string | null {
  if (sizeBytes > FIRMWARE_MAX_BYTES) return `image is ${sizeBytes} bytes; the limit is 2 MB`;
  if (!/^\s*tbyb:\s+not bought\s*$/m.test(picotoolInfo)) {
    return 'image is not a TBYB (try-before-you-buy) image; build with PICO_CRT0_IMAGE_TYPE_TBYB=1';
  }
  if (!/hash/i.test(picotoolInfo)) return 'image carries no hash for the boot ROM to check; build with pico_hash_binary';
  if (bytes.includes(Buffer.from('fwdbg', 'ascii'))) return 'image contains the debug-only firmware command (WF_FW_DEBUG)';
  return null;
}
```

Run the manifest test against the real fixture captured in Task 4 Step 2. If the hash
line's wording differs from `/hash/i` (for example the label is different), change the
regex to the observed wording and **keep the test that deletes that line**.

- [ ] **Step 4: Add the column and generate the migration**

In `src/db/schema/firmware.ts`, add to `firmwareReleases` (after `signingKeyId`, and
import `integer` if not already imported):

```ts
  /** 1 = signature over the sha256 only (release 1). 2 = over the manifest (spec D4). Only 2 is offered to a board. */
  signatureFormat: integer('signature_format').notNull().default(1),
```

Run the repo's generate script (`grep -n drizzle package.json` for its name; otherwise `pnpm drizzle-kit generate`)
Expected: a new `drizzle/0022_<name>.sql` containing exactly
`ALTER TABLE "firmware_releases" ADD COLUMN "signature_format" integer DEFAULT 1 NOT NULL;`.
Read it. If it contains anything else, stop: that is `db:push`'s truncation hazard
arriving another way.

Apply it with a guard. **Never `db:push`.**

```bash
set -a; . ./.env.local; set +a
psql "${DATABASE_URL_UNPOOLED:-$DATABASE_URL}" -X -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='firmware_releases' AND column_name='signature_format') THEN
    ALTER TABLE \"firmware_releases\" ADD COLUMN \"signature_format\" integer DEFAULT 1 NOT NULL;
  END IF; END \$\$;"
psql "${DATABASE_URL_UNPOOLED:-$DATABASE_URL}" -XAtc "select version, signature_format from firmware_releases order by sequence;"
```

Expected: release 1 (`1.0.0+gf53ad10`) reads `1`.

- [ ] **Step 5: Offer only format-2 releases, and refuse to target anything else**

In `src/lib/firmware-state.ts`, `ReleaseRef` gains `signatureFormat?: number;`.
`listReleases()` in `src/lib/firmware-releases.ts` selects
`signatureFormat: firmwareReleases.signatureFormat`.

In `src/lib/firmware-update-rules.ts`, add `'unverifiable_release'` to `TargetRefusal`,
and in `refuseTarget` directly after the `cannot_update` check:

```ts
  // A release the board cannot verify is never offered (readFirmwareInstruction
  // filters it out). Targeting it would leave the card on "update requested"
  // forever, so refuse it up front.
  if ((target.signatureFormat ?? 1) < 2) return 'unverifiable_release';
```

In `src/lib/mount.ts` `readFirmwareInstruction`, select
`signatureFormat: firmwareReleases.signatureFormat`, and return `null` when
`row.signatureFormat !== 2`, next to the existing `row.version === null` check. Add a
one-line comment citing spec D4.

In `publishRelease` (`src/lib/firmware-releases.ts`), add a third parameter
`expectedSequence: number`, and after computing `sequence`:

```ts
  if (sequence !== expectedSequence) {
    // The signature covers the sequence (spec D4). A sequence that moved between
    // signing and recording would publish a signature that never verifies.
    throw new PublishRefused(`sequence moved from ${expectedSequence} to ${sequence} while publishing; re-run`);
  }
```

Import `PublishRefused` from `@/lib/firmware-publish-rules`, and match its constructor
signature as defined there. `PublishInput` gains `signatureFormat: number`.

- [ ] **Step 6: The publish script signs the manifest, publishes the `.bin`, and refuses unsafe images**

In `scripts/firmware-release.ts`:
- Point the artifact at `wifi-floppy/firmware/build/wifi_floppy.bin` (rename `uf2Path` →
  `binPath`, and update the messages).
- Change `blobPath` to `firmware/${version}.bin`.
- Right after the version-in-image check, run picotool and refuse:

```ts
import { execFileSync } from 'node:child_process';
import { firmwareManifest, refuseReleaseImage } from '@/lib/firmware-manifest';
// ...
const info = execFileSync('picotool', ['info', '-a', binPath, '-t', 'bin'], { encoding: 'utf8' });
const refusal = refuseReleaseImage(info, bytes.byteLength, bytes);
if (refusal) die(`Publish refused: ${refusal}`);
```

- Move signing to **after** `decidePublish` has produced `sequence`, and sign the
  manifest:

```ts
const manifest = firmwareManifest({ version, sequence, sha256, sizeBytes: bytes.byteLength });
const signature = edSign(null, Buffer.from(manifest, 'ascii'), key).toString('base64');
```

  Keep the key loading where it is, so a missing key still fails before anything else.
  Print `signature` after `sequence`.
- Pass `signatureFormat: 2` in the `publishRelease` input, and `sequence` as its new third
  argument.
- Update the header comment's usage and step list to say `.bin`, manifest, and format 2.

Dry-run it against the Task 4 build:
`pnpm firmware:publish --dry-run`
Expected: it prints `sequence 2` and a signature, then `--dry-run: nothing uploaded`. With
the `-dirty` guard, dry-run a clean build. If the tree is dirty, expect the existing
`-dirty` refusal instead, which is also correct.

- [ ] **Step 7: e2e seeds use format 2**

In `e2e/device-helpers.ts`, add `signatureFormat: 2` to both `firmwareReleases` inserts
(`publishTestRelease` and `publishTestReleaseWithBlob`). Without it,
`readFirmwareInstruction` now withholds every seeded release, and the 2a poll specs lose
their `update` object.

- [ ] **Step 8: Run the gates**

Run: `pnpm vitest run && pnpm build 2>&1 | tail -3`
Expected: all vitest files pass and the build is clean.

Run: `pnpm e2e e2e/device-poll.spec.ts e2e/devices-firmware.spec.ts e2e/admin-firmware.spec.ts --reporter=line`
Expected: all pass. This checks that no port is held first. If a spec fails, re-run it
alone before concluding anything; memory records cross-spec interference in this suite.

- [ ] **Step 9: Commit**

```bash
git status --short
git add src/lib/firmware-manifest.test.ts src/db/schema/firmware.ts drizzle/0022_*.sql drizzle/meta \
        src/lib/firmware-releases.ts src/lib/mount.ts src/lib/firmware-state.ts src/lib/firmware-update-rules.ts \
        src/lib/firmware-update-rules.test.ts scripts/firmware-release.ts e2e/device-helpers.ts
git commit -m "firmware releases: sign a manifest, publish the .bin, offer only format 2

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `fw_stage` and `dc_fetch_firmware`, download into PSRAM (D3)

**Files:**
- Create: `wifi-floppy/firmware/src/fw_stage.h`, `wifi-floppy/firmware/src/fw_stage.c`
- Modify: `wifi-floppy/firmware/src/device_client.h/.c` (`dc_fetch_firmware`)
- Test: `wifi-floppy/firmware/test/test_fw_stage.c`, `wifi-floppy/firmware/test/test_device_client.c`
- Modify: `CMakeLists.txt` (add `src/fw_stage.c`)

**Interfaces:**
- Consumes: `sha256_t`, `sha256_init/update/final/hex` (`sha256.h`).
- Produces:

```c
typedef struct { uint8_t *buf; uint32_t cap; uint32_t got; bool overflow; sha256_t sha; } fw_stage_t;
void fw_stage_begin(fw_stage_t *s, uint8_t *buf, uint32_t cap);
void fw_stage_sink(void *ctx, const uint8_t *b, int n);          // a dc_exchange sink
bool fw_stage_matches(fw_stage_t *s, uint32_t expect_len, const char *expect_sha_hex);
// device_client.h
// GET /api/device/firmware/<version>. Body bytes go to `sink`. Returns the HTTP status of a
// COMPLETE response, or -1 (transport, framing, incomplete). 401 halts, as everywhere.
int dc_fetch_firmware(device_client_t *c, const char *version,
                      void (*sink)(void *ctx, const uint8_t *b, int n), void *ctx);
```

- [ ] **Step 1: Write the failing tests**

`test/test_fw_stage.c`:

```c
#include "harness.h"
#include "../src/fw_stage.h"
#include "../src/sha256.h"
#include <string.h>

static uint8_t buf[64];

static void hex_of(const uint8_t *p, uint32_t n, char out[65]) {
    sha256_t s; uint8_t d[32]; sha256_init(&s); sha256_update(&s, p, n); sha256_final(&s, d); sha256_hex(d, out);
}
static void test_whole_image_in_chunks_matches(void) {
    const char *img = "0123456789abcdefghij";
    char want[65]; hex_of((const uint8_t *)img, 20, want);
    fw_stage_t s; fw_stage_begin(&s, buf, sizeof buf);
    fw_stage_sink(&s, (const uint8_t *)img, 7);
    fw_stage_sink(&s, (const uint8_t *)img + 7, 13);
    CHECK(fw_stage_matches(&s, 20, want), "chunked arrival hashes the same as whole");
    CHECK(memcmp(buf, img, 20) == 0, "and the bytes are staged in order");
}
static void test_short_download_does_not_match(void) {
    const char *img = "0123456789";
    char want[65]; hex_of((const uint8_t *)img, 10, want);
    fw_stage_t s; fw_stage_begin(&s, buf, sizeof buf);
    fw_stage_sink(&s, (const uint8_t *)img, 9);
    CHECK(!fw_stage_matches(&s, 10, want), "a truncated download never matches");
}
static void test_overflow_is_refused_not_wrapped(void) {
    fw_stage_t s; fw_stage_begin(&s, buf, 8);
    fw_stage_sink(&s, (const uint8_t *)"0123456789", 10);
    CHECK(s.overflow, "more than the stage holds is an overflow");
    CHECK(!fw_stage_matches(&s, 10, "00"), "and never matches");
}
static void test_right_length_wrong_bytes_does_not_match(void) {
    char want[65]; hex_of((const uint8_t *)"AAAA", 4, want);
    fw_stage_t s; fw_stage_begin(&s, buf, sizeof buf);
    fw_stage_sink(&s, (const uint8_t *)"AAAB", 4);
    CHECK(!fw_stage_matches(&s, 4, want), "the hash, not the length, decides");
}
int main(void) {
    RUN(test_whole_image_in_chunks_matches);
    RUN(test_short_download_does_not_match);
    RUN(test_overflow_is_refused_not_wrapped);
    RUN(test_right_length_wrong_bytes_does_not_match);
    return REPORT();
}
```

Append to `test/test_device_client.c` (and `RUN` them):

```c
static uint8_t fw_got[64]; static int fw_got_n;
static void fw_sink(void *ctx, const uint8_t *b, int n) { (void)ctx; memcpy(fw_got + fw_got_n, b, (size_t)n); fw_got_n += n; }

static void test_fetch_firmware_streams_the_body(void) {
    boot(); fw_got_n = 0;
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHELLO");
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), 200);
    CHECK(strstr(fake_last_request(), "GET /api/device/firmware/1.1.0+gx ") != NULL, "path");
    CHECK(fw_got_n == 5 && memcmp(fw_got, "HELLO", 5) == 0, "body streamed to the sink");
}
static void test_fetch_firmware_incomplete_is_minus_one(void) {
    boot(); fw_got_n = 0;
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nHELLO", 45);
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), -1);
}
static void test_fetch_firmware_401_halts(void) {
    boot();
    fake_push_response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), 401);
    CHECK_EQ_INT(c.state, DC_HALTED);
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm firmware:test 2>&1 | grep -E "COMPILE FAIL"`
Expected: `test_fw_stage.c` and `test_device_client.c` fail to compile.

- [ ] **Step 3: Implement**

`src/fw_stage.c`:

```c
#include "fw_stage.h"
#include <string.h>

void fw_stage_begin(fw_stage_t *s, uint8_t *buf, uint32_t cap) {
    s->buf = buf; s->cap = cap; s->got = 0; s->overflow = false;
    sha256_init(&s->sha);
}
void fw_stage_sink(void *ctx, const uint8_t *b, int n) {
    fw_stage_t *s = ctx;
    if (n <= 0 || s->overflow) return;
    if ((uint32_t)n > s->cap - s->got) { s->overflow = true; return; }
    memcpy(s->buf + s->got, b, (size_t)n);
    sha256_update(&s->sha, b, (size_t)n);
    s->got += (uint32_t)n;
}
bool fw_stage_matches(fw_stage_t *s, uint32_t expect_len, const char *expect_sha_hex) {
    if (s->overflow || s->got != expect_len) return false;
    uint8_t d[32]; char hex[65];
    sha256_final(&s->sha, d);
    sha256_hex(d, hex);
    return strcmp(hex, expect_sha_hex) == 0;
}
```

The header includes `sha256.h`, `<stdint.h>` and `<stdbool.h>`.

In `device_client.c`, after `dc_post`:

```c
int dc_fetch_firmware(device_client_t *c, const char *version,
                      void (*sink)(void *ctx, const uint8_t *b, int n), void *ctx) {
    static char path[DC_REQ_BUF_BYTES];   // static: see the STACK note above
    int pn = snprintf(path, sizeof path, "/api/device/firmware/%s", version);
    if (pn < 0 || pn >= (int)sizeof path) return -1;
    static char req[DC_REQ_BUF_BYTES];
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host, c->token, NULL);
    if (req_len < 0) return -1;
    static http_resp_t r;
    bool ok = dc_exchange(c, req, req_len, sink, ctx, &r, /*retryable=*/true);
    if (!ok || !r.body_complete) return -1;
    if (r.status == 401) c->state = DC_HALTED;   // 401 anywhere halts
    return r.status;
}
```

Add `core1_main -> fw_update -> dc_fetch_firmware -> dc_exchange` to the call-graph list in
the STACK comment. It is a straight line, never nested in `dc_step`.

Add `src/fw_stage.c` to `add_executable`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm firmware:test 2>&1 | grep -E "test_fw_stage|test_device_client|FAIL"`
Expected: both report `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/fw_stage.[ch] wifi-floppy/firmware/src/device_client.[ch] \
        wifi-floppy/firmware/test/test_fw_stage.c wifi-floppy/firmware/test/test_device_client.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: stage a firmware download with a running SHA-256

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `fw_apply`, write the other slot so a power cut leaves nothing half-bootable (D7)

**Files:**
- Create: `wifi-floppy/firmware/src/fw_apply.h`, `wifi-floppy/firmware/src/fw_apply.c`
- Modify: `wifi-floppy/firmware/src/fw_rom.h/.c` (the device flash ops)
- Test: `wifi-floppy/firmware/test/test_fw_apply.c`
- Modify: `CMakeLists.txt` (add `src/fw_apply.c`)

**Interfaces:**
- Produces:

```c
#define FW_SECTOR_BYTES 4096u
typedef struct {
    bool (*erase_sector)(void *ctx, uint32_t flash_off);
    bool (*program_sector)(void *ctx, uint32_t flash_off, const uint8_t data[4096]);
    const uint8_t *(*raw)(void *ctx, uint32_t flash_off);     // physical flash, readable
    void *ctx;
} fw_flash_t;
typedef enum { FWA_OK, FWA_TOO_BIG, FWA_ERASE_FAILED, FWA_PROGRAM_FAILED, FWA_READBACK_MISMATCH } fw_apply_result_t;
fw_apply_result_t fw_apply_image(const fw_flash_t *f, uint32_t slot_off, uint32_t slot_len,
                                 const uint8_t *img, uint32_t len, const char *sha_hex);
const char *fw_apply_text(fw_apply_result_t r);
// fw_rom.h
extern const fw_flash_t fw_rom_flash;
```

- [ ] **Step 1: Write the failing test** at `test/test_fw_apply.c`

```c
#include "harness.h"
#include "../src/fw_apply.h"
#include "../src/sha256.h"
#include <string.h>

#define FLASH_BYTES (64u * 4096u)
static uint8_t flash[FLASH_BYTES];
static uint32_t log_off[64]; static char log_op[64]; static int log_n;
static int fail_program_at = -1;

static bool fe(void *ctx, uint32_t off) { (void)ctx; memset(flash + off, 0xFF, 4096); log_op[log_n] = 'E'; log_off[log_n++] = off; return true; }
static bool fp(void *ctx, uint32_t off, const uint8_t d[4096]) {
    (void)ctx;
    if ((int)(off / 4096) == fail_program_at) return false;
    for (int i = 0; i < 4096; i++) flash[off + (uint32_t)i] &= d[i];   // NOR: program only clears bits
    log_op[log_n] = 'P'; log_off[log_n++] = off; return true;
}
static const uint8_t *fr(void *ctx, uint32_t off) { (void)ctx; return flash + off; }
static const fw_flash_t F = { fe, fp, fr, NULL };

static uint8_t img[3 * 4096 + 100];
static void hex_of(const uint8_t *p, uint32_t n, char out[65]) {
    sha256_t s; uint8_t d[32]; sha256_init(&s); sha256_update(&s, p, n); sha256_final(&s, d); sha256_hex(d, out);
}
static void reset(void) {
    memset(flash, 0x5a, sizeof flash);   // the slot holds an OLD image
    log_n = 0; fail_program_at = -1;
    for (uint32_t i = 0; i < sizeof img; i++) img[i] = (uint8_t)(i * 7u);
}

static void test_writes_and_verifies(void) {
    reset();
    char want[65]; hex_of(img, sizeof img, want);
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, want), FWA_OK);
    CHECK(memcmp(flash + 8 * 4096, img, sizeof img) == 0, "the image is in the slot");
    CHECK(flash[8 * 4096 + sizeof img] == 0xFF, "the tail of the last sector is erased, not stale");
}
// D7: erase the header FIRST, program it LAST. Until the final program there is no valid
// IMAGE_DEF in the slot, old or new.
static void test_header_erased_first_and_programmed_last(void) {
    reset();
    char want[65]; hex_of(img, sizeof img, want);
    fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, want);
    CHECK(log_op[0] == 'E' && log_off[0] == 8 * 4096, "the first operation erases the header sector");
    CHECK(log_op[log_n - 1] == 'P' && log_off[log_n - 1] == 8 * 4096, "the last operation programs it");
    for (int i = 1; i < log_n - 1; i++)
        CHECK(!(log_op[i] == 'P' && log_off[i] == 8 * 4096), "nothing programs the header in between");
}
static void test_power_cut_midway_leaves_no_header(void) {
    reset();
    fail_program_at = 10;   // the third sector's program fails, as a cut would stop it
    char want[65]; hex_of(img, sizeof img, want);
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, want), FWA_PROGRAM_FAILED);
    for (int i = 0; i < 4096; i++) if (flash[8 * 4096 + (uint32_t)i] != 0xFF) { CHECK(false, "header sector must still be erased"); break; }
}
static void test_too_big_touches_nothing(void) {
    reset();
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 2 * 4096, img, sizeof img, "00"), FWA_TOO_BIG);
    CHECK_EQ_INT(log_n, 0);
}
static void test_readback_mismatch_is_reported(void) {
    reset();
    CHECK_EQ_INT(fw_apply_image(&F, 8 * 4096, 16 * 4096, img, sizeof img, "00"), FWA_READBACK_MISMATCH);
}

int main(void) {
    RUN(test_writes_and_verifies);
    RUN(test_header_erased_first_and_programmed_last);
    RUN(test_power_cut_midway_leaves_no_header);
    RUN(test_too_big_touches_nothing);
    RUN(test_readback_mismatch_is_reported);
    return REPORT();
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm firmware:test 2>&1 | grep -A2 test_fw_apply`
Expected: `COMPILE FAIL`.

- [ ] **Step 3: Implement `src/fw_apply.c`** (header per the interface; includes
`sha256.h`)

```c
#include "fw_apply.h"
#include "sha256.h"
#include <string.h>

static bool program_chunk(const fw_flash_t *f, uint32_t off, const uint8_t *src, uint32_t n) {
    static uint8_t sector[FW_SECTOR_BYTES];   // static: 4 KB is too much for core1's stack
    memset(sector, 0xFF, sizeof sector);
    memcpy(sector, src, n);
    return f->program_sector(f->ctx, off, sector);
}

fw_apply_result_t fw_apply_image(const fw_flash_t *f, uint32_t slot_off, uint32_t slot_len,
                                 const uint8_t *img, uint32_t len, const char *sha_hex) {
    uint32_t nsec = (len + FW_SECTOR_BYTES - 1) / FW_SECTOR_BYTES;
    if (len == 0 || nsec * FW_SECTOR_BYTES > slot_len) return FWA_TOO_BIG;
    // Header first: from here until the very last program, the slot holds no
    // valid IMAGE_DEF -- neither the old image's nor a half-written new one.
    if (!f->erase_sector(f->ctx, slot_off)) return FWA_ERASE_FAILED;
    for (uint32_t i = 1; i < nsec; i++) {
        uint32_t off = slot_off + i * FW_SECTOR_BYTES;
        uint32_t n = len - i * FW_SECTOR_BYTES;
        if (n > FW_SECTOR_BYTES) n = FW_SECTOR_BYTES;
        if (!f->erase_sector(f->ctx, off)) return FWA_ERASE_FAILED;
        if (!program_chunk(f, off, img + i * FW_SECTOR_BYTES, n)) return FWA_PROGRAM_FAILED;
    }
    if (!program_chunk(f, slot_off, img, len < FW_SECTOR_BYTES ? len : FW_SECTOR_BYTES))
        return FWA_PROGRAM_FAILED;
    sha256_t s; uint8_t d[32]; char hex[65];
    sha256_init(&s);
    sha256_update(&s, f->raw(f->ctx, slot_off), len);
    sha256_final(&s, d);
    sha256_hex(d, hex);
    return strcmp(hex, sha_hex) == 0 ? FWA_OK : FWA_READBACK_MISMATCH;
}

const char *fw_apply_text(fw_apply_result_t r) {
    switch (r) {
    case FWA_OK:                return "ok";
    case FWA_TOO_BIG:           return "image does not fit the slot";
    case FWA_ERASE_FAILED:      return "flash erase failed";
    case FWA_PROGRAM_FAILED:    return "flash write failed";
    case FWA_READBACK_MISMATCH: return "flash readback did not match the signed hash";
    }
    return "unknown";
}
```

Add `src/fw_apply.c` to `add_executable`.

- [ ] **Step 4: Add the device flash ops to `fw_rom.c`** (declare
`extern const fw_flash_t fw_rom_flash;` in `fw_rom.h`, which includes `fw_apply.h`)

```c
#include "fw_apply.h"
#include "hardware/address_mapped.h"

typedef struct { uint32_t off; const uint8_t *data; } fr_prog_t;
static void do_erase(void *p) { flash_range_erase(*(uint32_t *)p, FLASH_SECTOR_SIZE); }
static void do_prog(void *p) { fr_prog_t *a = p; flash_range_program(a->off, a->data, FLASH_SECTOR_SIZE); }
static bool fr_erase(void *ctx, uint32_t off) { (void)ctx; return flash_safe_execute(do_erase, &off, 1000) == PICO_OK; }
static bool fr_program(void *ctx, uint32_t off, const uint8_t data[4096]) {
    (void)ctx; fr_prog_t a = { off, data };
    return flash_safe_execute(do_prog, &a, 1000) == PICO_OK;
}
// NOTRANSLATE: the other slot is not mapped at XIP_BASE (spec M3).
static const uint8_t *fr_raw(void *ctx, uint32_t off) {
    (void)ctx; return (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + off);
}
const fw_flash_t fw_rom_flash = { fr_erase, fr_program, fr_raw, NULL };
```

Each sector is its own short `flash_safe_execute` window: tens of milliseconds with core0
parked, never seconds. The watchdog (8 s, core0) is safe.

- [ ] **Step 5: Run the tests and build**

Run: `pnpm firmware:test 2>&1 | grep -E "test_fw_apply|FAIL"; pnpm firmware:build 2>&1 | tail -2`
Expected: `test_fw_apply.c: N checks, 0 failed`, and a clean build.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/fw_apply.[ch] wifi-floppy/firmware/src/fw_rom.[ch] wifi-floppy/firmware/test/test_fw_apply.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: write the other slot header-last, verify by readback

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `fw_update`, the update state machine (D6, D9)

**Files:**
- Create: `wifi-floppy/firmware/src/fw_update.h`, `wifi-floppy/firmware/src/fw_update.c`
- Test: `wifi-floppy/firmware/test/test_fw_update.c`
- Modify: `CMakeLists.txt` (add `src/fw_update.c`)

**Interfaces:**
- Consumes: `fw_offer_t`, `fw_verdict_t`, `fw_verdict_text` (Task 6); `fw_stage_*`
  (Task 8); `fw_apply_result_t`, `fw_apply_text` (Task 9); `fw_state_t` (Task 2).
- Produces:

```c
typedef enum { FWU_IDLE, FWU_QUEUED, FWU_DOWNLOADING, FWU_STAGED, FWU_APPLYING, FWU_REBOOTING, FWU_FAILED } fwu_phase_t;
#define FWU_ERROR_MAX      200
#define FWU_RETRY_FLOOR_MS 5000u
#define FWU_RETRY_CAP_MS   300000u
typedef struct {
    int  (*fetch)(void *ctx, const char *version, fw_stage_t *stage);   // HTTP status or -1
    fw_apply_result_t (*apply)(void *ctx, const uint8_t *img, uint32_t len, const char *sha_hex,
                               uint32_t *slot_off_out);
    bool (*save_state)(void *ctx, const fw_state_t *st);
    void (*request_reboot)(void *ctx, uint32_t slot_off);
    void *ctx;
} fwu_ops_t;
typedef struct {
    fwu_phase_t phase;
    fw_offer_t  offer;
    char        error[FWU_ERROR_MAX + 1];
    uint8_t    *stage_buf;
    uint32_t    stage_cap;
    fw_stage_t  stage;
    uint32_t    retry_at_ms;
    uint32_t    backoff_ms;
} fwu_t;
void fwu_init(fwu_t *u, uint8_t *stage_buf, uint32_t stage_cap);
void fwu_fail(fwu_t *u, const char *why);
void fwu_on_instruction(fwu_t *u, const fw_offer_t *offer_or_null, fw_verdict_t verdict);
bool fwu_step(fwu_t *u, const fwu_ops_t *ops, fw_state_t *st, bool idle, uint32_t now_ms);
const char *fwu_state_text(const fwu_t *u);   // NULL when there is nothing to report
const char *fwu_error_text(const fwu_t *u);   // NULL unless FAILED
```

- [ ] **Step 1: Write the failing test** at `test/test_fw_update.c`

```c
#include "harness.h"
#include "../src/fw_update.h"
#include "../src/sha256.h"
#include <string.h>

static uint8_t stage[64];
static const char IMG[] = "new-firmware-image";
static int fetch_status; static int fetches, applies, saves, reboots;
static fw_apply_result_t apply_result;
static fw_state_t saved;

static int f_fetch(void *ctx, const char *v, fw_stage_t *s) {
    (void)ctx; (void)v; fetches++;
    if (fetch_status == 200) fw_stage_sink(s, (const uint8_t *)IMG, (int)strlen(IMG));
    return fetch_status;
}
static fw_apply_result_t f_apply(void *ctx, const uint8_t *img, uint32_t len, const char *sha, uint32_t *off) {
    (void)ctx; (void)img; (void)len; (void)sha; applies++; *off = 0x408000; return apply_result;
}
static bool f_save(void *ctx, const fw_state_t *st) { (void)ctx; saves++; saved = *st; return true; }
static void f_reboot(void *ctx, uint32_t off) { (void)ctx; (void)off; reboots++; }
static const fwu_ops_t OPS = { f_fetch, f_apply, f_save, f_reboot, NULL };

static fw_offer_t offer(void) {
    fw_offer_t o; memset(&o, 0, sizeof o);
    snprintf(o.version, sizeof o.version, "%s", "1.1.0+gnew");
    o.sequence = 5; o.size_bytes = (uint32_t)strlen(IMG);
    sha256_t s; uint8_t d[32]; sha256_init(&s); sha256_update(&s, (const uint8_t *)IMG, strlen(IMG));
    sha256_final(&s, d); sha256_hex(d, o.sha256);
    return o;
}
static fwu_t u; static fw_state_t st;
static void fresh(void) {
    fwu_init(&u, stage, sizeof stage); memset(&st, 0, sizeof st); st.installed_sequence = 4;
    fetch_status = 200; apply_result = FWA_OK; fetches = applies = saves = reboots = 0;
}
static void run_until_quiet(bool idle) { for (int i = 0; i < 10; i++) fwu_step(&u, &OPS, &st, idle, 1000); }

static void test_fresh_updater_reports_nothing(void) {           // Review Focus 5
    fresh();
    CHECK(fwu_state_text(&u) == NULL, "a board that just booted claims no progress");
}
static void test_happy_path_ends_in_a_reboot_with_pending_recorded(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    CHECK(strcmp(fwu_state_text(&u), "queued") == 0, "queued first");
    run_until_quiet(true);
    CHECK_EQ_INT(u.phase, FWU_REBOOTING);
    CHECK_EQ_INT(reboots, 1);
    CHECK(saved.pending && saved.pending_sequence == 5 && strcmp(saved.pending_version, "1.1.0+gnew") == 0,
          "pending recorded BEFORE the reboot");
    CHECK_EQ_INT(saved.installed_sequence, 4);
}
static void test_each_step_is_one_phase_so_it_can_be_reported(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    CHECK(fwu_step(&u, &OPS, &st, true, 1000) && strcmp(fwu_state_text(&u), "downloading") == 0, "downloading, not yet fetched");
    CHECK_EQ_INT(fetches, 0);
    CHECK(fwu_step(&u, &OPS, &st, true, 1000) && u.phase == FWU_STAGED, "fetched and verified");
    CHECK(fwu_step(&u, &OPS, &st, true, 1000) && strcmp(fwu_state_text(&u), "applying") == 0, "applying, not yet written");
    CHECK_EQ_INT(applies, 0);
}
static void test_staged_waits_for_idle(void) {                    // Review Focus 3
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(false);
    CHECK_EQ_INT(u.phase, FWU_STAGED);
    CHECK_EQ_INT(applies, 0);
    CHECK(strcmp(fwu_state_text(&u), "queued") == 0, "reported as queued while it waits");
    run_until_quiet(true);
    CHECK_EQ_INT(applies, 1);
}
static void test_cancel_while_staged_never_applies(void) {        // Review Focus 2
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(false);
    fwu_on_instruction(&u, NULL, FW_OK);
    run_until_quiet(true);
    CHECK_EQ_INT(applies, 0);
    CHECK_EQ_INT(u.phase, FWU_IDLE);
    CHECK(fwu_state_text(&u) == NULL, "idle reports nothing");
}
static void test_refused_offer_fails_with_the_reason(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_ROLLBACK);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
    CHECK(strstr(fwu_error_text(&u), "anti-rollback") != NULL, "says why");
    run_until_quiet(true);
    CHECK_EQ_INT(fetches, 0);
}
static void test_new_instruction_after_failure_requeues(void) {  // Review Focus 4
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_BAD_SIGNATURE);
    fwu_on_instruction(&u, &o, FW_OK);
    CHECK_EQ_INT(u.phase, FWU_QUEUED);
    CHECK(fwu_error_text(&u) == NULL, "the old failure is cleared");
}
static void test_hash_mismatch_fails_without_applying(void) {
    fresh();
    fw_offer_t o = offer(); o.sha256[0] = (o.sha256[0] == 'a') ? 'b' : 'a';
    fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(true);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
    CHECK_EQ_INT(applies, 0);
}
static void test_404_fails_5xx_retries_with_backoff(void) {
    fresh();
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    fetch_status = 503;
    fwu_step(&u, &OPS, &st, true, 1000);   // -> downloading
    fwu_step(&u, &OPS, &st, true, 1000);   // fetch 503 -> queued, retry later
    CHECK_EQ_INT(u.phase, FWU_QUEUED);
    CHECK(!fwu_step(&u, &OPS, &st, true, 1000 + FWU_RETRY_FLOOR_MS - 1), "not before the backoff");
    CHECK(fwu_step(&u, &OPS, &st, true, 1000 + FWU_RETRY_FLOOR_MS), "retried after it");
    fetch_status = 404;
    fwu_step(&u, &OPS, &st, true, 1000 + FWU_RETRY_FLOOR_MS);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
}
static void test_flash_failure_is_reported_and_no_reboot(void) {
    fresh();
    apply_result = FWA_READBACK_MISMATCH;
    fw_offer_t o = offer(); fwu_on_instruction(&u, &o, FW_OK);
    run_until_quiet(true);
    CHECK_EQ_INT(u.phase, FWU_FAILED);
    CHECK_EQ_INT(reboots, 0);
    CHECK(!saved.pending, "nothing pending recorded for an image that did not write");
}

int main(void) {
    RUN(test_fresh_updater_reports_nothing);
    RUN(test_happy_path_ends_in_a_reboot_with_pending_recorded);
    RUN(test_each_step_is_one_phase_so_it_can_be_reported);
    RUN(test_staged_waits_for_idle);
    RUN(test_cancel_while_staged_never_applies);
    RUN(test_refused_offer_fails_with_the_reason);
    RUN(test_new_instruction_after_failure_requeues);
    RUN(test_hash_mismatch_fails_without_applying);
    RUN(test_404_fails_5xx_retries_with_backoff);
    RUN(test_flash_failure_is_reported_and_no_reboot);
    return REPORT();
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm firmware:test 2>&1 | grep -A2 test_fw_update`
Expected: `COMPILE FAIL`.

- [ ] **Step 3: Implement `src/fw_update.c`** (header per the interface; includes
`fw_offer.h`, `fw_verify.h`, `fw_stage.h`, `fw_apply.h`, `fw_state.h`)

```c
#include "fw_update.h"
#include <stdio.h>
#include <string.h>

void fwu_init(fwu_t *u, uint8_t *stage_buf, uint32_t stage_cap) {
    memset(u, 0, sizeof *u);
    u->stage_buf = stage_buf;
    u->stage_cap = stage_cap;
    u->phase = FWU_IDLE;
}

void fwu_fail(fwu_t *u, const char *why) {
    u->phase = FWU_FAILED;
    snprintf(u->error, sizeof u->error, "%s", why);
}

void fwu_on_instruction(fwu_t *u, const fw_offer_t *offer, fw_verdict_t verdict) {
    if (u->phase == FWU_APPLYING || u->phase == FWU_REBOOTING) return;   // past the point of no return
    u->error[0] = '\0';
    if (!offer) { u->phase = FWU_IDLE; return; }                         // a cancellation
    if (verdict != FW_OK) {
        char why[FWU_ERROR_MAX + 1];
        snprintf(why, sizeof why, "refused: %s", fw_verdict_text(verdict));
        fwu_fail(u, why);
        return;
    }
    u->offer = *offer;
    u->phase = FWU_QUEUED;
    u->retry_at_ms = 0;
    u->backoff_ms = 0;
}

static void retry_later(fwu_t *u, uint32_t now) {
    u->backoff_ms = u->backoff_ms ? u->backoff_ms * 2u : FWU_RETRY_FLOOR_MS;
    if (u->backoff_ms > FWU_RETRY_CAP_MS) u->backoff_ms = FWU_RETRY_CAP_MS;
    u->retry_at_ms = now + u->backoff_ms;
    u->phase = FWU_QUEUED;
}

bool fwu_step(fwu_t *u, const fwu_ops_t *ops, fw_state_t *st, bool idle, uint32_t now) {
    switch (u->phase) {
    case FWU_QUEUED:
        if (u->retry_at_ms && (int32_t)(now - u->retry_at_ms) < 0) return false;
        u->phase = FWU_DOWNLOADING;          // reported before the (blocking) fetch
        return true;
    case FWU_DOWNLOADING: {
        fw_stage_begin(&u->stage, u->stage_buf, u->stage_cap);
        int status = ops->fetch(ops->ctx, u->offer.version, &u->stage);
        if (status == 200) {
            if (fw_stage_matches(&u->stage, u->offer.size_bytes, u->offer.sha256)) u->phase = FWU_STAGED;
            else fwu_fail(u, "download did not match the signed hash");
        } else if (status == 404) {
            fwu_fail(u, "release not published");
        } else if (status == 400) {
            fwu_fail(u, "server refused the version");
        } else {
            retry_later(u, now);             // -1, 5xx: transient
        }
        return true;
    }
    case FWU_STAGED:
        if (!idle) return false;             // D6: nothing mounted, motor off, no unsent writes
        u->phase = FWU_APPLYING;             // reported before the flash write
        return true;
    case FWU_APPLYING: {
        uint32_t slot_off = 0;
        fw_apply_result_t r = ops->apply(ops->ctx, u->stage_buf, u->offer.size_bytes,
                                         u->offer.sha256, &slot_off);
        if (r != FWA_OK) { fwu_fail(u, fw_apply_text(r)); return true; }
        st->pending = true;
        st->pending_sequence = u->offer.sequence;
        snprintf(st->pending_version, sizeof st->pending_version, "%s", u->offer.version);
        st->failure[0] = '\0';
        if (!ops->save_state(ops->ctx, st)) {
            st->pending = false;
            fwu_fail(u, "could not record the pending update");
            return true;
        }
        u->phase = FWU_REBOOTING;
        ops->request_reboot(ops->ctx, slot_off);
        return true;
    }
    default:
        return false;
    }
}

const char *fwu_state_text(const fwu_t *u) {
    switch (u->phase) {
    case FWU_QUEUED: case FWU_STAGED:       return "queued";
    case FWU_DOWNLOADING:                   return "downloading";
    case FWU_APPLYING: case FWU_REBOOTING:  return "applying";
    case FWU_FAILED:                        return "failed";
    default:                                return NULL;
    }
}
const char *fwu_error_text(const fwu_t *u) { return u->phase == FWU_FAILED ? u->error : NULL; }
```

Add `src/fw_update.c` to `add_executable`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm firmware:test 2>&1 | grep -E "test_fw_update|FAIL"`
Expected: `test_fw_update.c: N checks, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/fw_update.[ch] wifi-floppy/firmware/test/test_fw_update.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: the update state machine -- queue, stage, wait for idle, apply

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Wire the updater into `main.c`, plus the debug-only offer command

**Files:**
- Modify: `wifi-floppy/firmware/src/main.c`, `wifi-floppy/firmware/CMakeLists.txt`

**Interfaces:**
- Consumes everything above: `dc_set_fw_report`, `c.fw_instruction_*`, `fw_offer_parse`,
  `fw_check_offer`, `fwu_*`, `fw_state_*`, `fw_boot_reconcile`, `fw_rom_*`,
  `fw_rom_flash`, `fw_apply_image`, `dc_fetch_firmware`, `fw_stage_sink`.

- [ ] **Step 1: The PSRAM stage and the ops, in `main.c`**

Near the other file-scope statics:

```c
// 2b staging (spec D3): a verified download lives here until it is flashed.
// Separate from the disk image's two slots (psram_image.c), which take ~4.26 MB
// of the 8 MB; 2 MB here is the release cap (FW_MAX_IMAGE_BYTES).
static __uninitialized_psram("fwstage") uint8_t g_fw_stage[FW_MAX_IMAGE_BYTES];

static int fwu_fetch(void *ctx, const char *version, fw_stage_t *stage) {
    return dc_fetch_firmware((device_client_t *)ctx, version, fw_stage_sink, stage);
}
static fw_apply_result_t fwu_apply(void *ctx, const uint8_t *img, uint32_t len,
                                   const char *sha, uint32_t *slot_off) {
    (void)ctx;
    uint32_t off, slot_len;
    if (!fw_rom_other_slot(&off, &slot_len)) return FWA_TOO_BIG;   // unpartitioned: no OTA
    *slot_off = off;
    return fw_apply_image(&fw_rom_flash, off, slot_len, img, len, sha);
}
static bool fwu_save(void *ctx, const fw_state_t *st) { (void)ctx; return fw_state_save(st); }
static void fwu_reboot(void *ctx, uint32_t off) { (void)ctx; fw_rom_request_reboot(off); }

// Published by core0 every loop turn. core1 reads it for the idle gate only;
// dskchg.c's own state stays core0's.
static volatile bool g_motor_on;
```

In core0's loop, right after `dskchg_poll();`, add `g_motor_on = dskchg_motor_on();`.

In `main()`, after `psram_image_init()` succeeds, check the stage is really backed by PSRAM:

```c
    if (!psram_check_address(&g_fw_stage[FW_MAX_IMAGE_BYTES - 1]))
        wf_logf(WF_ERR, "fw: the update stage is not backed by PSRAM -- updates disabled");
```

and keep that result in a `static bool g_fw_stage_ok`, used below.

- [ ] **Step 2: Reconcile at boot, opt in, and drive the updater from core1's loop**

Replace Task 4's trial block's opening (`static fw_state_t fst; fw_state_load(&fst);`) so
that the state is shared with the updater and reconciled on a non-trial boot:

```c
        static fw_state_t fst;
        static fwu_t fwu;
        static fwu_ops_t fwu_ops;
        static dc_fw_report_t fw_report;
        fw_state_load(&fst);
        fwu_init(&fwu, g_fw_stage, sizeof g_fw_stage);
        fwu_ops = (fwu_ops_t){ fwu_fetch, fwu_apply, fwu_save, fwu_reboot, &c };
        if (!fw_rom_trial_boot()) {
            char why[FWU_ERROR_MAX + 1] = "";
            fw_boot_t b = fw_boot_reconcile(&fst, WF_FIRMWARE_VERSION, why, sizeof why);
            if (b != FW_BOOT_CLEAN) fw_state_save(&fst);
            if (b == FW_BOOT_REVERTED) { fwu_fail(&fwu, why); wf_logf(WF_WARN, "fw: %s", why); }
        }
        // The capability is declared ONLY by a build that can update itself, on a
        // partitioned board with a working stage. An unpartitioned board says 0.
        fw_report.update_protocol =
            (g_fw_stage_ok && fw_rom_booted_partition() >= 0) ? DC_UPDATE_PROTOCOL : 0;
        dc_set_fw_report(&c, &fw_report);
        bool fw_report_owed = true;
```

Keep Task 4's `if (fw_rom_trial_boot()) { for (;;) { ... } }` block after this unchanged.
It already uses `fst`.

Inside `while (true)`, directly after the `if/else` that calls `dc_step`/`up_step`, add:

```c
            if (c.fw_instruction_new) {
                c.fw_instruction_new = false;
                fw_report.instruction_ack = c.fw_instruction_version;
                if (c.fw_offer_present) {
                    fw_offer_t o;
                    if (fw_offer_parse(c.fw_update_json, &o)) {
                        fw_verdict_t v = fw_check_offer(&o, fst.installed_sequence);
                        wf_logf(v == FW_OK ? WF_INFO : WF_WARN, "fw: offered %s (seq %lu): %s",
                                o.version, (unsigned long)o.sequence, fw_verdict_text(v));
                        fwu_on_instruction(&fwu, &o, v);
                    } else {
                        fwu_fail(&fwu, "refused: malformed update instruction");
                    }
                } else {
                    wf_logf(WF_INFO, "fw: instruction %lu carries no update (cancelled)",
                            (unsigned long)c.fw_instruction_version);
                    fwu_on_instruction(&fwu, NULL, FW_OK);
                }
                fw_report_owed = true;   // the ack must reach the server, or its poll busy-loops
            }
            {
                bool idle = c.mounted_sha256[0] == '\0' && !up_has_work(&up) && !g_motor_on;
                if (fwu_step(&fwu, &fwu_ops, &fst, idle, clock_ms())) {
                    wf_logf(WF_INFO, "fw: %s%s%s", fwu_state_text(&fwu) ? fwu_state_text(&fwu) : "idle",
                            fwu_error_text(&fwu) ? " -- " : "", fwu_error_text(&fwu) ? fwu_error_text(&fwu) : "");
                    fw_report_owed = true;
                }
                fw_report.state = fwu_state_text(&fwu);
                fw_report.error = fwu_error_text(&fwu);
                if (fwu.phase == FWU_REBOOTING) {
                    // core0 performs the reboot (M9). Report "applying" once, then stop.
                    dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL, WF_FIRMWARE_VERSION);
                    for (;;) sleep_ms(1000);
                }
            }
```

In the heartbeat condition (`if (!report_retry && s != DC_HALTED && (disk_changed || version_changed || ...`),
add `|| fw_report_owed` to the parenthesised trigger list, and set
`fw_report_owed = false;` inside its success branch next to `last_status_ms = now;`.

A board whose fetch path is not partitioned (`update_protocol == 0`) is never targeted by
the server (2a D1), so it never receives an offer. If it somehow did, `fwu_apply` refuses
with `FWA_TOO_BIG` → `failed`.

- [ ] **Step 3: The debug-only offer command** (spec §8 items 5 and 6)

In `CMakeLists.txt`:

```cmake
option(WF_FW_DEBUG "Bench-only: accept a crafted firmware offer over USB serial. NEVER in a release (the publish script refuses it)." OFF)
if (WF_FW_DEBUG)
  target_compile_definitions(wifi_floppy PRIVATE WF_FW_DEBUG=1)
endif ()
```

In `main.c`, inside core1's `while (true)` loop, before the instruction block above:

```c
#if WF_FW_DEBUG
            // Bench only (spec 8.5/8.6): "fwdbg {json}\n" on USB serial is handed to the SAME
            // parse -> check -> fwu path a real poll takes. The string "fwdbg" is what the
            // publish script refuses to ship.
            {
                static char line[DC_FW_UPDATE_JSON_BYTES + 8]; static int n;
                int ch;
                while ((ch = getchar_timeout_us(0)) != PICO_ERROR_TIMEOUT) {
                    if (ch == '\n' || n == (int)sizeof line - 1) {
                        line[n] = '\0'; n = 0;
                        if (strncmp(line, "fwdbg ", 6) == 0) {
                            snprintf(c.fw_update_json, sizeof c.fw_update_json, "%s", line + 6);
                            c.fw_offer_present = true;
                            c.fw_instruction_new = true;
                            wf_logf(WF_WARN, "fwdbg: injected an offer");
                        }
                    } else line[n++] = (char)ch;
                }
            }
#endif
```

This leaves `c.fw_instruction_version` untouched, so the ack reported is the real
server's.

- [ ] **Step 4: Build both variants, and prove the release build is clean**

```bash
pnpm firmware:test 2>&1 | tail -3
pnpm firmware:build 2>&1 | tail -2
grep -c fwdbg wifi-floppy/firmware/build/wifi_floppy.bin || echo "release build: no fwdbg (correct)"
cmake -S wifi-floppy/firmware -B /tmp/wf-dbg -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DWF_FW_DEBUG=ON >/dev/null && cmake --build /tmp/wf-dbg | tail -1
grep -c fwdbg /tmp/wf-dbg/wifi_floppy.bin
```

Expected: the host tests pass; the release `.bin` contains no `fwdbg` (grep prints 0 and
the echo line); the debug build links and contains `fwdbg`.

- [ ] **Step 5: BENCH, flash over USB and confirm the capability is declared**

Flash the release build with a plain `picotool load -f` and no `-p`: M4 says a plain load
goes to the non-current slot. Then start it with **the same load-and-start method Task 4
Step 8 established and recorded**. A plain `picotool reboot` is a normal boot, which M5
says will NOT start an unconfirmed TBYB image. It is a trial image, so watch for
`trial: confirmed`.

Then check the database for `update_protocol = 1` and `firmware_update_state is null`:
`select update_protocol, firmware_update_state, firmware_version from devices where id like '12593d21%';`

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: the board updates itself -- offer, verify, stage, apply, reboot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Bench acceptance, the first real over-the-air update, and HANDOFF

Every item here runs on the operator's board. It is read from **both** the serial log and
the `devices` row: `update_protocol`, `desired_firmware_version`,
`firmware_update_state`, `firmware_update_error`, `firmware_version`,
`firmware_instruction_version`, `firmware_instruction_ack`. Items needing the operator
(the Devices tab, power, the Amiga) end the turn with a request.

- [ ] **Step 1: Publish release N (the build now on the board) and N+1**

The board runs build N from Task 11, but N has never been published, because the registry
holds only `1.0.0+gf53ad10`. Publish it:
- `pnpm firmware:publish --notes "2b: first self-updating firmware"` (from a clean tree).
- Bump `FIRMWARE_SEMVER` to `1.1.0` in `wifi-floppy/firmware/CMakeLists.txt`, commit,
  build, and publish that as N+1.
- `/admin/firmware` should list both, with `signature_format = 2` in the database.

- [ ] **Step 2: Item 2, N → N+1 from the Devices tab (operator)**

Ask the operator to select the board, press Update and enter the password, with no disk
mounted. Expected, in the serial log:
- `fw: offered ... ok`
- `fw: downloading`
- `fw: queued` (staged)
- `fw: applying`
- a reboot
- `boot: partition 1 ... TRIAL`
- `trial: confirmed 1.1.0+g...`

In the database: `firmware_version` becomes N+1, and `desired_firmware_version`,
`firmware_update_state` and `firmware_update_error` are all cleared. The card reads up to
date.

- [ ] **Step 3: Item 3, N+1 → N+2 (the B → A direction)**

Bump to `1.1.1`, publish, and update again. Expected: the same as Step 2, ending on
`partition 0`.

- [ ] **Step 4: Item 4, a release that never confirms**

Build N+3 with a one-line change that makes the trial never succeed: in the trial block,
`bool hb = false && dc_report_status(...)`. Commit it on a throwaway branch and publish.
Update to it.

Expected:
- `trial: giving up (no heartbeat within 5 minutes)` after 5 minutes, and a reboot.
- The old slot boots and logs `fw: reverted: no heartbeat within 5 minutes`.
- The card reads `update failed — reverted: no heartbeat within 5 minutes`.
- `firmware_version` is unchanged.

Then publish a fixed N+4 so the registry's newest release is good, and delete the
throwaway branch.

- [ ] **Step 5: Items 5 and 6, a tampered signature and a rollback, via `WF_FW_DEBUG`**

Flash the debug build over USB. It confirms itself as a trial. Over serial, send
`fwdbg {...}` with:
- a real release's fields and **one base64 character changed** in the signature. Expected:
  `fw: offered ...: signature does not verify`, then `failed`, and no `downloading`.
- a real, older release (sequence below `installed_sequence`). Expected:
  `not newer than the installed release (anti-rollback)`.

Check that the other slot is untouched: `picotool save -f -r` its first 16 bytes before
and after, and compare. Then re-flash the release build over USB.

- [ ] **Step 6: Item 7, an update requested while a disk is mounted (operator)**

Mount a disk from the browser, then press Update. Expected: `downloading`, then `queued`,
which holds while the disk is mounted. The card reads `update queued — waiting for eject`.
Eject from the browser. Expected: `applying`, then the normal update.

- [ ] **Step 7: Item 8, a power cut during `applying` (operator)**

Ask the operator to pull USB power the moment the log prints `fw: applying`. On power-up
the board must boot its old slot and report
`reverted: the new firmware did not confirm itself`, or, if the cut came before `pending`
was written, report nothing and remain on the old version with the card on "update
requested". Either is correct. **A board that doesn't boot is the failure this step exists
to catch.**

- [ ] **Step 8: Gates, then HANDOFF**

Run: `pnpm firmware:test`, `pnpm vitest run`, `pnpm build`, and the full `pnpm e2e`
(foreground). Re-run any failures alone, and report both results.

Add a HANDOFF entry `### 3ak. The board updates itself — 2b` with:
- what shipped
- every bench item's outcome, with the log lines and `devices` rows that prove it
- the `-x` answer from Task 4 Step 8
- the release numbers used
- anything that moved from the spec: M-numbered facts go to the spec's §2 as addenda

Update the §3aj entry's "NO FIRMWARE IMPLEMENTS THIS" to point at §3ak.

- [ ] **Step 9: Commit**

```bash
git add HANDOFF.md docs/superpowers/specs/2026-09-22-firmware-update-device-design.md
git commit -m "HANDOFF: 3ak, the board updates itself, and what the bench proved

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
