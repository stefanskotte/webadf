# Plan 4a — Device Firmware Protocol Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `wifi-floppy/firmware/` compile for the first time, then give it the device contract it has never spoken — TLS, a bearer token, the `since`-based poll loop, two-slot PSRAM with fetch-before-transition — all provable on the host before hardware arrives.

**Architecture:** One seam: a transport vtable plus an injected clock. Above it, `device_client.c` holds the entire state machine in pure C that never includes an SDK or lwIP header. Below it, mbedTLS over lwIP on the board, or a scriptable fake with fault injection on the host. The floppy-bus half (`floppy.pio`, `dskchg.c`, core0's ISRs) is untouched except for one ISR attribute.

**Tech Stack:** C11 · pico-sdk 2.x (RP2350, `PICO_BOARD=pimoroni_pico_plus2_w_rp2350`) · lwIP + mbedTLS via `pico_lwip_mbedtls`/`pico_mbedtls` · CMake + Ninja + `arm-none-eabi-gcc` · host tests in plain C under clang

**Spec:** `docs/superpowers/specs/2026-08-30-device-firmware-protocol-design.md`. Parents: `2026-08-29-device-plane-disk-change-design.md` (§10 is the contract this plan implements), `2026-08-23-webadf-design.md` (D14/D15/D16).

## Global Constraints

- **`device_client.c` may not `#include` any SDK or lwIP header.** This is the property that makes the plan verifiable, and it degrades silently — one include and the state machine stops being host-testable with nothing failing to announce it. If it seems to need one, move the seam, do not add the include.
- **`since` is RAM-only and starts at 0 on every cold boot.** Never persisted, never in flash, never in `token_store`. Parent spec §10 is emphatic: a persisted `since` replayed after a power-cycle produces a device that boots diskless forever, with no error and no retry that helps.
- **`since` advances only after a completed swap** — never on receipt of the response that named it.
- **An absence of signal never ejects.** Timeouts, 5xx, dropped connections, and a poll `404` all leave the mounted disk exactly as it is. Only an explicit `desired: null` ejects.
- **Never release the current disk before the replacement is fetched and verified.** Fetch into the inactive slot; swap last.
- **`ALTCP_MBEDTLS_AUTHMODE=MBEDTLS_SSL_VERIFY_REQUIRED`** must be set. Its default is `MBEDTLS_SSL_VERIFY_OPTIONAL`, which completes a handshake against any certificate and returns success.
- **Socket read timeout ≥ 30 s.** The poll holds 25 s; a 10 s default tears down every poll mid-hold and looks exactly like a network fault.
- **Status reports send all six fields** every time: `mountedSha256`, `mountedDiskId`, `version`, `error`, `psramFree`, `rssi`.
- **No `Range` support** on the image endpoint — a mid-transfer drop restarts the whole body from zero.
- **Two sizes, both correct:** `2,027,536` bytes is the `WFMF` wire size; `2,129,920` (160 × 13,312) is the PSRAM slot allocation. Transfer budgets use the former, slot arithmetic the latter.
- **Never log the device token or a pairing code.** The token is returned exactly once by `/api/device/register`.
- Run `pnpm firmware:test` and `pnpm firmware:build` before each commit from Task 2 onward.

---

## File Structure

| File | Responsibility |
|---|---|
| `wifi-floppy/firmware/src/transport.h` | **Create.** The seam: `connect/write/read/close` vtable + clock fn. No implementation. |
| `wifi-floppy/firmware/src/http.c/.h` | **Create.** Request builder, response parser, body framing (Content-Length + chunked). Pure. |
| `wifi-floppy/firmware/src/json_scan.c/.h` | **Create.** Minimal field extractor for the four keys the device reads. Pure. |
| `wifi-floppy/firmware/src/device_client.c/.h` | **Create.** The §10 state machine. Pure. The heart of this plan. |
| `wifi-floppy/firmware/src/token_store.c/.h` | **Create.** Token persistence: flash on device, memory on host. |
| `wifi-floppy/firmware/src/transport_tls.c` | **Create.** mbedTLS over altcp_tls. Device-only. |
| `wifi-floppy/firmware/src/roots.h` | **Create (generated).** Curated CA bundle. |
| `wifi-floppy/firmware/src/sntp_time.c/.h` | **Create.** Wall clock before first handshake. Device-only. |
| `wifi-floppy/firmware/src/psram_image.c/.h` | **Modify.** Two slots; injectable backing. |
| `wifi-floppy/firmware/src/image_loader.c/.h` | **Modify.** Both defect fixes; targets a named slot. |
| `wifi-floppy/firmware/src/track_cache.c/.h` | **Modify.** Read through `active_slot`. |
| `wifi-floppy/firmware/src/main.c` | **Modify.** Wire it up; `__not_in_flash_func` on the DMA ISR. |
| `wifi-floppy/firmware/src/http_fetch.c/.h` | **Delete.** Superseded whole. |
| `wifi-floppy/firmware/test/*` | **Create.** Host harness + tests. |
| `wifi-floppy/firmware/tools/gen_roots.sh` | **Create.** Regenerates `roots.h` from pinned PEMs. |
| `src/lib/adfmfm/firmware-parser.ts` | **Modify.** Stop mirroring the fixed defect. |
| `src/lib/adfmfm/wfmf.test.ts` | **Modify.** Update the asymmetry assertions. |

---

### Task 1: Make the existing firmware compile, unchanged

The "never compiled" milestone, and it comes first for a reason: doing it before any new code isolates SDK API drift from our own mistakes. If Tasks 2+ landed first, every compile error would be ambiguous.

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (only if the board header is missing)
- Modify: `wifi-floppy/firmware/src/*.c` (only as needed for SDK drift)
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm firmware:build` → `wifi-floppy/firmware/build/wifi_floppy.uf2`.

- [ ] **Step 1: Install the toolchain**

```bash
brew install cmake ninja picotool
brew install --cask gcc-arm-embedded || brew install arm-none-eabi-gcc
arm-none-eabi-gcc --version && cmake --version && ninja --version
```

- [ ] **Step 2: Clone a pinned pico-sdk**

```bash
git clone --branch 2.1.1 --depth 1 https://github.com/raspberrypi/pico-sdk.git ~/pico-sdk
cd ~/pico-sdk && git submodule update --init --depth 1 lib/lwip lib/mbedtls lib/cyw43-driver
```

Record the exact tag you land on — a later task pins it in the build script.

- [ ] **Step 3: Verify the board header exists (spec §9, verify-not-assume #1)**

```bash
ls ~/pico-sdk/src/boards/include/boards/ | grep -i pimoroni
```

Expected: `pimoroni_pico_plus2_w_rp2350.h` present.

**If it is absent, STOP and report it to the main conversation.** Do not invent a header. The fallback is vendoring one into `wifi-floppy/firmware/boards/`, and it must define `PICO_PSRAM_CS_PIN` (47) and `PICO_PSRAM_SIZE_BYTES` (8 MB) or PSRAM will not come up before `main()` and every later task's assumptions break silently.

- [ ] **Step 4: Add the build script**

In `package.json` scripts:

```json
"firmware:build": "cd wifi-floppy/firmware && cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 && cmake --build build"
```

- [ ] **Step 5: Build, and fix only what the compiler says**

```bash
WIFI_SSID=x WIFI_PASS=y pnpm firmware:build
```

Expect errors — this code has never been through a compiler. Fix **only** genuine compile/link errors: missing headers, renamed SDK functions, signature drift (`add_alarm_in_us` callback types, `pio_add_program` on RP2350, `hardware_psram` naming). Do not refactor, do not fix logic, do not touch the two known defects — Task 3 owns those, and mixing them makes the mutation proof there meaningless.

Note that `floppy.pio` is referenced by `CMakeLists.txt` but was not in the file listing; if it is missing, **STOP and report** — the PIO program is the floppy bus and cannot be reconstructed from this plan.

- [ ] **Step 6: Confirm the artifact**

```bash
ls -la wifi-floppy/firmware/build/wifi_floppy.uf2
```

Expected: the file exists. Record its size in the commit message — it is the first ever built.

- [ ] **Step 7: Commit**

```bash
git add package.json wifi-floppy/firmware
git commit -m "Compile the firmware for the first time"
```

---

### Task 2: Host test harness

**Files:**
- Create: `wifi-floppy/firmware/test/harness.h`
- Create: `wifi-floppy/firmware/test/run.sh`
- Create: `wifi-floppy/firmware/test/test_psram_image.c`
- Modify: `wifi-floppy/firmware/src/psram_image.c`, `psram_image.h`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm firmware:test`; `harness.h` exporting `CHECK(cond, msg)`, `CHECK_EQ_INT(a,b)`, `RUN(fn)`, `int tests_failed`; `psram_image_set_backing(void *base, size_t len)` for host use.

- [ ] **Step 1: Write the harness**

`test/harness.h`:

```c
#ifndef HARNESS_H
#define HARNESS_H
#include <stdio.h>
#include <string.h>
static int tests_failed = 0;
static int checks_run = 0;
#define CHECK(cond, msg) do { checks_run++; if (!(cond)) { \
    printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, (msg)); tests_failed++; } } while (0)
#define CHECK_EQ_INT(a, b) do { checks_run++; long _a=(long)(a), _b=(long)(b); \
    if (_a != _b) { printf("  FAIL %s:%d: expected %ld, got %ld\n", __FILE__, __LINE__, _b, _a); \
    tests_failed++; } } while (0)
#define RUN(fn) do { printf("- %s\n", #fn); fn(); } while (0)
#define REPORT() (printf("%s: %d checks, %d failed\n", __FILE__, checks_run, tests_failed), \
                  tests_failed ? 1 : 0)
#endif
```

- [ ] **Step 2: Give `psram_image` an injectable backing**

The device gets PSRAM from the SDK at a fixed address; the host needs malloc. Add to `psram_image.h`:

```c
// Host tests only: point the image store at ordinary memory. On device the
// SDK's PSRAM window is used and this is never called.
void psram_image_set_backing(void *base, size_t len);
```

In `psram_image.c`, replace the hardcoded PSRAM base with a static `g_base`/`g_len` pair that `psram_image_init()` fills from the SDK and `psram_image_set_backing()` fills on the host.

- [ ] **Step 3: Write the first test**

`test/test_psram_image.c` — a real behaviour, not a smoke test:

```c
#include "harness.h"
#include "../src/psram_image.h"
#include <stdlib.h>

static void test_written_track_reads_back(void) {
    size_t len = (size_t)TRACK_SLOT_BYTES * NUM_TRACKS;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    psram_image_reset();

    uint8_t src[64];
    for (int i = 0; i < 64; i++) src[i] = (uint8_t)i;
    psram_image_write_at(5, 0, src, 64);
    psram_image_commit(5, 512);

    CHECK(psram_image_have(5), "track 5 should be present after commit");
    CHECK_EQ_INT(psram_image_bits(5), 512);

    uint8_t dst[64] = {0};
    uint32_t bits = 0;
    CHECK(psram_image_read(5, dst, &bits), "read should succeed");
    CHECK_EQ_INT(bits, 512);
    CHECK(memcmp(src, dst, 64) == 0, "bytes should round-trip");

    CHECK(!psram_image_have(6), "an uncommitted track must not read as present");
    free(mem);
}

int main(void) { RUN(test_written_track_reads_back); return REPORT(); }
```

- [ ] **Step 4: Write the runner**

`test/run.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
fail=0
for t in test_*.c; do
  out=".build/${t%.c}"
  cc -std=c11 -g -O1 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 \
     -o "$out" "$t" $(ls ../src/*.c | grep -vE 'main\.c|transport_tls\.c|sntp_time\.c|http_fetch\.c') \
     || { echo "COMPILE FAIL: $t"; fail=1; continue; }
  "$out" || fail=1
done
exit $fail
```

`chmod +x test/run.sh`, and in `package.json`: `"firmware:test": "wifi-floppy/firmware/test/run.sh"`.

Device-only files are excluded by name. `psram_image.c` must not pull in SDK headers unless guarded by `#ifndef WFMF_HOST_TEST`.

- [ ] **Step 5: Watch it fail, then pass**

```bash
pnpm firmware:test
```

Before Step 2's change is complete this must FAIL to compile or fail the round-trip. Verify you see a real failure first. Then complete Step 2 and re-run: expected PASS.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/test wifi-floppy/firmware/src/psram_image.* package.json
git commit -m "Add a host test harness for the firmware"
```

---

### Task 3: The two recorded defects, and the mirror that must move with them

**Files:**
- Modify: `wifi-floppy/firmware/src/psram_image.h`, `image_loader.c`
- Create: `wifi-floppy/firmware/test/test_image_loader.c`
- Modify: `src/lib/adfmfm/firmware-parser.ts`, `src/lib/adfmfm/wfmf.test.ts`

**Interfaces:**
- Consumes: `harness.h`, `psram_image_set_backing` (Task 2).
- Produces: a single `TRACK_MAX_BYTES` constant replacing `TRACK_SLOT_BYTES`/`TRACK_MFM_MAX`.

- [ ] **Step 1: Write both failing tests**

`test/test_image_loader.c`. These need a WFMF builder; write it in the test file:

```c
#include "harness.h"
#include "../src/image_loader.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

static uint8_t buf[64 * 1024];
static size_t buf_len;

static void put_u32(size_t off, uint32_t v) {
    buf[off]=v&0xff; buf[off+1]=(v>>8)&0xff; buf[off+2]=(v>>16)&0xff; buf[off+3]=(v>>24)&0xff;
}

// A one-track WFMF whose single track claims `bits`.
static void build(uint32_t bits, uint32_t payload_bytes) {
    memset(buf, 0, sizeof buf);
    put_u32(0, IMAGE_MAGIC); put_u32(4, IMAGE_VERSION); put_u32(8, 1); put_u32(12, 0);
    put_u32(16, bits);
    buf_len = 20 + payload_bytes;
}

static void test_oversized_track_is_refused(void) {
    // 13313 bytes: one over TRACK_MAX_BYTES. Real tracks are 12668, so this
    // path has never fired in practice -- which is exactly why it is latent.
    build(13313u * 8u, 13313);
    CHECK(!image_parse_buffer(0, buf, buf_len), "a track over TRACK_MAX_BYTES must be refused");
}

static void test_bit_count_overflow_is_refused(void) {
    // (bits + 7) / 8 wraps to 0 on uint32 and sails past a size guard.
    build(0xFFFFFFF9u, 16);
    CHECK(!image_parse_buffer(0, buf, buf_len),
          "a bit_count that overflows (bits+7)/8 must be refused, not parsed as 0 bytes");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_oversized_track_is_refused);
    RUN(test_bit_count_overflow_is_refused);
    free(mem);
    return REPORT();
}
```

This needs `image_parse_buffer(int slot, const uint8_t *data, size_t len)` — a synchronous whole-buffer entry point around the existing incremental parser. Add it to `image_loader.h` and implement it by feeding the buffer through the existing chunk sink in one call.

- [ ] **Step 2: Run and watch both fail**

```bash
pnpm firmware:test
```

Expected: `test_image_loader` FAILS both checks. **Both must fail for the right reason** — the oversized track is accepted, and the overflow track parses as present. If either passes now, the test is not exercising the defect; fix the test before touching the source.

- [ ] **Step 3: Fix defect 1 — one constant**

In `psram_image.h`, replace `TRACK_SLOT_BYTES` with:

```c
// One constant for both the PSRAM slot and the SRAM staging buffer. These
// were TRACK_SLOT_BYTES=13312 (PSRAM) and TRACK_MFM_MAX=13000 (SRAM); the
// 312-byte gap was a latent overflow for any track between the two, since
// the loader accepted up to the larger and track_cache copied into the
// smaller. Real tracks are 12668, under both, so it never fired.
//
// Reconciled UPWARDS to 13312: the SRAM staging buffer grows by 312 bytes,
// which is free, and no previously-valid image becomes invalid. Reconciling
// downwards to 13000 would have been a silent format restriction.
#define TRACK_MAX_BYTES 13312u
```

Update `track_cache.c`'s `TRACK_MFM_MAX` to use it, and every reference to the old names across `psram_image.c`, `image_loader.c`, `track_cache.c`, `main.c` — including `main.c`'s `track_words[(TRACK_MFM_MAX + 3) / 4]`, whose staging array grows with it.

- [ ] **Step 4: Fix defect 2 — bound before the arithmetic**

In `image_loader.c`, where `payload_bytes = (bits + 7) / 8` is computed:

```c
// Bound `bits` BEFORE the arithmetic. (bits + 7) on a uint32_t wraps for
// bits >= 0xFFFFFFF9, yielding payload_bytes == 0, which then slips past a
// `payload_bytes > TRACK_MAX_BYTES` check and marks every track present with
// a nonsense bit count -- the firmware would present a disk of empty tracks
// instead of refusing the image.
if (bits > (uint32_t)TRACK_MAX_BYTES * 8u) return false;
uint32_t payload_bytes = (bits + 7u) / 8u;
```

- [ ] **Step 5: Run — both pass**

```bash
pnpm firmware:test && pnpm firmware:build
```

- [ ] **Step 6: Prove each fix with a mutation**

Required, not optional. For each fix: revert it, run `pnpm firmware:test`, confirm the *named* test fails, restore it. Record both test names in the commit message. A fix without a mutation proof is a claim.

- [ ] **Step 7: Move the TypeScript mirror with the fix**

`src/lib/adfmfm/firmware-parser.ts` deliberately reproduces defect 2 so it models what the device actually accepts. The device now refuses that input, so the mirror is wrong.

Update `firmware-parser.ts` to bound bits the same way; update the asymmetry assertions in `wfmf.test.ts` that assert the mirror accepts what `readWfmf` rejects; and rewrite the comments in both to say the two parsers now agree here, and why the mirror still exists (it still models the device's acceptance envelope — that envelope just changed).

**Leaving this out leaves a green suite asserting the firmware is still broken**, which is worse than either state alone because it looks like coverage.

- [ ] **Step 8: Full suite, then commit**

```bash
pnpm vitest run && pnpm firmware:test && pnpm firmware:build
```

```bash
git add wifi-floppy/firmware src/lib/adfmfm
git commit -m "Fix both recorded firmware defects and move the mirror with them"
```

---

### Task 4: HTTP request builder and response parser

**Files:**
- Create: `wifi-floppy/firmware/src/http.c`, `http.h`
- Create: `wifi-floppy/firmware/test/test_http.c`

**Interfaces:**
- Consumes: nothing.
- Produces:

```c
typedef struct {
    int      status;            // 0 until the status line is parsed
    bool     headers_done;
    bool     chunked;
    long     content_length;    // -1 if absent
    bool     body_complete;
} http_resp_t;

void http_resp_init(http_resp_t *r);
// Feed received bytes. Body bytes are handed to `sink` as they are framed.
// Returns false on a malformed response.
bool http_resp_feed(http_resp_t *r, const uint8_t *data, int len,
                    void (*sink)(void *ctx, const uint8_t *b, int n), void *ctx);
// Build a request into `out`. Returns bytes written, or -1 if it would not fit.
int  http_build_request(char *out, int out_len, const char *method, const char *path,
                        const char *host, const char *bearer, const char *body);
```

- [ ] **Step 1: Probe the live endpoint first (spec §9, verify-not-assume #2)**

The parser must handle whatever framing the real endpoint uses. Find out before writing it:

```bash
curl -si -o /dev/null -D - https://webadf.vercel.app/api/device/image/$(printf 'a%.0s' {1..64}) | head -20
```

A `401` is expected (no token) — the point is the framing headers. Also check a large-body route if one is reachable unauthenticated. Record in the commit message whether `Content-Length`, `Transfer-Encoding: chunked`, or both appear. **Implement both paths regardless** — the platform may switch on body size, and 2 MB is exactly where it might.

- [ ] **Step 2: Write failing tests**

`test/test_http.c`:

```c
#include "harness.h"
#include "../src/http.h"
#include <string.h>

static uint8_t body[4096];
static int body_len;
static void sink(void *ctx, const uint8_t *b, int n) {
    (void)ctx; memcpy(body + body_len, b, n); body_len += n;
}
#define FEED(r, s) http_resp_feed((r), (const uint8_t *)(s), (int)strlen(s), sink, NULL)

static void test_content_length_body(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"), "should parse");
    CHECK_EQ_INT(r.status, 200);
    CHECK(r.body_complete, "body should be complete at content-length");
    CHECK_EQ_INT(body_len, 5);
    CHECK(memcmp(body, "hello", 5) == 0, "body bytes");
}

static void test_chunked_body(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                   "5\r\nhello\r\n3\r\n123\r\n0\r\n\r\n"), "should parse");
    CHECK_EQ_INT(body_len, 8);
    CHECK(r.body_complete, "zero chunk terminates the body");
}

static void test_split_across_feeds(void) {
    // The real transport delivers arbitrary fragments; a status line split
    // mid-token must not lose the status.
    http_resp_t r; http_resp_init(&r); body_len = 0;
    FEED(&r, "HTTP/1.1 20");
    FEED(&r, "4 No Content\r\n\r\n");
    CHECK_EQ_INT(r.status, 204);
}

static void test_204_has_no_body(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    FEED(&r, "HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(r.body_complete, "204 is complete with no body");
    CHECK_EQ_INT(body_len, 0);
}

static void test_request_includes_bearer(void) {
    char out[512];
    int n = http_build_request(out, sizeof out, "GET", "/api/device/poll?since=0",
                               "webadf.vercel.app", "tok123", NULL);
    CHECK(n > 0, "should build");
    CHECK(strstr(out, "Authorization: Bearer tok123\r\n") != NULL, "bearer header");
    CHECK(strstr(out, "Host: webadf.vercel.app\r\n") != NULL, "host header");
}

static void test_request_refuses_overflow(void) {
    char out[32];
    CHECK_EQ_INT(http_build_request(out, sizeof out, "GET", "/very/long/path",
                                    "webadf.vercel.app", "tok", NULL), -1);
}

int main(void) {
    RUN(test_content_length_body); RUN(test_chunked_body);
    RUN(test_split_across_feeds); RUN(test_204_has_no_body);
    RUN(test_request_includes_bearer); RUN(test_request_refuses_overflow);
    return REPORT();
}
```

- [ ] **Step 3: Run, watch every test fail**

```bash
pnpm firmware:test
```

Expected: compile failure (no `http.h`). That counts as failing for the right reason only once `http.h` exists with the declarations but no implementation — create the header first, then confirm link errors, so you have seen each test genuinely fail.

- [ ] **Step 4: Implement `http.c`**

A byte-at-a-time state machine over `{STATUS, HEADERS, BODY_LEN, BODY_CHUNK_SIZE, BODY_CHUNK_DATA, DONE}`. Requirements it must meet, each pinned by a test above: status parsed across feed boundaries; header names compared case-insensitively; `204` and `304` complete with no body; a chunk size line parsed as hex; the terminating `0` chunk sets `body_complete`.

Keep it under ~200 lines. It parses; it does not allocate and it does not know about TLS.

- [ ] **Step 5: Run — all pass**

```bash
pnpm firmware:test && pnpm firmware:build
```

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/http.* wifi-floppy/firmware/test/test_http.c
git commit -m "Add the HTTP request builder and response parser"
```

---

### Task 5: The transport seam and a fake that can inject faults

**Files:**
- Create: `wifi-floppy/firmware/src/transport.h`
- Create: `wifi-floppy/firmware/test/transport_fake.c`, `transport_fake.h`
- Create: `wifi-floppy/firmware/test/test_transport_fake.c`

**Interfaces:**
- Consumes: nothing.
- Produces:

```c
// transport.h — the seam. No SDK, no lwIP, no implementation here.
typedef struct transport {
    // Returns 0 on success, negative on failure.
    int  (*connect)(struct transport *t, const char *host, int port);
    int  (*write)(struct transport *t, const uint8_t *b, int n);
    // Returns bytes read, 0 on clean close, negative on error/timeout.
    int  (*read)(struct transport *t, uint8_t *b, int cap, int timeout_ms);
    void (*close)(struct transport *t);
    void *impl;
} transport_t;

// Injected clock: milliseconds since boot, monotonic.
typedef uint32_t (*clock_ms_fn)(void);
```

And from `transport_fake.h`:

```c
void fake_reset(void);
// Queue a whole response to be delivered for the next request.
void fake_push_response(const char *raw);
// Deliver only the first `n` bytes of the next response, then report a
// dropped connection. This is how fetch-interruption is tested.
void fake_push_truncated(const char *raw, int n);
void fake_push_connect_failure(void);
transport_t *fake_transport(void);
const char *fake_last_request(void);   // what the client sent
int  fake_request_count(void);
void fake_set_clock(uint32_t ms);      // drives the injected clock
uint32_t fake_clock_ms(void);
```

- [ ] **Step 1: Write the fake's own test first**

The fake is test infrastructure, and infrastructure that lies produces tests that pass against nothing. `test/test_transport_fake.c`:

```c
#include "harness.h"
#include "transport_fake.h"
#include <string.h>

static void test_truncation_reports_close(void) {
    fake_reset();
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789", 20);
    transport_t *t = fake_transport();
    CHECK_EQ_INT(t->connect(t, "h", 443), 0);
    uint8_t b[64];
    int n = t->read(t, b, sizeof b, 1000);
    CHECK_EQ_INT(n, 20);
    CHECK_EQ_INT(t->read(t, b, sizeof b, 1000), 0);  // clean close, mid-body
}

static void test_connect_failure_is_negative(void) {
    fake_reset();
    fake_push_connect_failure();
    transport_t *t = fake_transport();
    CHECK(t->connect(t, "h", 443) < 0, "connect should fail");
}

static void test_records_request(void) {
    fake_reset();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    transport_t *t = fake_transport();
    t->connect(t, "h", 443);
    t->write(t, (const uint8_t *)"GET /x\r\n", 8);
    CHECK(strstr(fake_last_request(), "GET /x") != NULL, "request recorded");
    CHECK_EQ_INT(fake_request_count(), 1);
}

int main(void) {
    RUN(test_truncation_reports_close); RUN(test_connect_failure_is_negative);
    RUN(test_records_request);
    return REPORT();
}
```

- [ ] **Step 2: Run, watch it fail**

Expected: compile failure, then link errors once the header exists.

- [ ] **Step 3: Implement the fake**

A queue of canned responses, a byte cursor, a recorded request buffer, and a settable clock. No allocation beyond static buffers. Update `test/run.sh` so `transport_fake.c` is compiled into every test binary.

- [ ] **Step 4: Run — pass. Then commit**

```bash
pnpm firmware:test
git add wifi-floppy/firmware/src/transport.h wifi-floppy/firmware/test
git commit -m "Add the transport seam and a fault-injecting fake"
```

---

### Task 6: `device_client` — the poll loop and the two `since` rules

The task this whole plan exists for. Everything here is host-testable because of Tasks 4 and 5.

**Files:**
- Create: `wifi-floppy/firmware/src/device_client.c`, `device_client.h`
- Create: `wifi-floppy/firmware/src/json_scan.c`, `json_scan.h`
- Create: `wifi-floppy/firmware/test/test_device_client.c`, `test_json_scan.c`

**Interfaces:**
- Consumes: `transport_t`, `clock_ms_fn` (Task 5); `http_*` (Task 4).
- Produces:

```c
typedef enum {
    DC_UNPROVISIONED, DC_IDLE_POLL, DC_FETCHING, DC_VERIFYING,
    DC_SWAPPING, DC_BACKOFF, DC_HALTED
} dc_state_t;

typedef struct {
    char     sha256[65];
    char     disk_id[65];
    uint32_t version;
    bool     write_protected;
    bool     present;          // false => desired: null => eject
} dc_desired_t;

typedef struct {
    transport_t *t;
    clock_ms_fn  now;
    const char  *host;
    const char  *token;
    uint32_t     since;        // RAM ONLY. Never persisted. Always 0 at boot.
    dc_state_t   state;
    uint32_t     backoff_ms;
    uint32_t     mounted_version;
    char         mounted_sha256[65];
} device_client_t;

void dc_init(device_client_t *c, transport_t *t, clock_ms_fn now,
             const char *host, const char *token);
// One iteration: poll, and act on whatever comes back. Returns the new state.
dc_state_t dc_step(device_client_t *c);
```

And from `json_scan.h` — the device reads four keys, so a full JSON parser is not warranted:

```c
// Extract a string value by key. Returns false if absent. Handles the value
// being null (returns true with out[0] == 0).
bool json_str(const char *json, const char *key, char *out, int out_len);
bool json_u32(const char *json, const char *key, uint32_t *out);
bool json_bool(const char *json, const char *key, bool *out);
// True if `key` is present with a literal null value.
bool json_is_null(const char *json, const char *key);
```

- [ ] **Step 1: Write `json_scan` tests and implementation**

`test/test_json_scan.c` — the shapes are taken from the real routes:

```c
#include "harness.h"
#include "../src/json_scan.h"
#include <string.h>

static const char *POLL_200 =
  "{\"version\":7,\"desired\":{\"sha256\":\"abc123\",\"diskId\":\"d-1\","
  "\"gameId\":\"g-1\",\"game\":\"Lemmings\",\"diskNo\":1,\"diskCount\":2,"
  "\"writeProtected\":true}}";
static const char *POLL_EJECT = "{\"version\":9,\"desired\":null}";

static void test_reads_version_and_sha(void) {
    uint32_t v = 0; char sha[65] = {0};
    CHECK(json_u32(POLL_200, "version", &v), "version present"); CHECK_EQ_INT(v, 7);
    CHECK(json_str(POLL_200, "sha256", sha, sizeof sha), "sha present");
    CHECK(strcmp(sha, "abc123") == 0, "sha value");
}

static void test_write_protected(void) {
    bool wp = false;
    CHECK(json_bool(POLL_200, "writeProtected", &wp), "present"); CHECK(wp, "true");
}

static void test_null_desired_is_distinguishable_from_absent(void) {
    // This distinction IS the eject instruction. Getting it wrong either
    // ejects on a malformed response or never ejects at all.
    CHECK(json_is_null(POLL_EJECT, "desired"), "explicit null recognised");
    CHECK(!json_is_null(POLL_200, "desired"), "an object is not null");
    CHECK(!json_is_null(POLL_200, "nosuchkey"), "an absent key is not null");
}

int main(void) {
    RUN(test_reads_version_and_sha); RUN(test_write_protected);
    RUN(test_null_desired_is_distinguishable_from_absent);
    return REPORT();
}
```

Run, watch fail, implement a scanner that skips strings correctly (so a `"key"` inside a string value is not matched), run, pass.

- [ ] **Step 2: Write the `since` tests — the two that matter most**

`test/test_device_client.c`:

```c
#include "harness.h"
#include "transport_fake.h"
#include "../src/device_client.h"
#include <string.h>

static device_client_t c;
static void boot(void) {
    fake_reset(); fake_set_clock(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "webadf.vercel.app", "tok");
}

static void test_cold_boot_polls_since_zero(void) {
    boot();
    c.mounted_version = 0;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "since=0") != NULL,
          "cold boot MUST poll since=0 or the device boots diskless forever");
}

static void test_since_does_not_advance_on_a_failed_fetch(void) {
    boot();
    // Poll names version 7...
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 120\r\n\r\n"
        "{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    // ...but the image fetch dies partway through.
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    dc_step(&c);
    CHECK_EQ_INT(c.since, 0);
    CHECK_EQ_INT(c.mounted_version, 0);
    CHECK(c.mounted_sha256[0] == 0, "nothing may be reported as mounted");
}

static void test_poll_404_keeps_the_disk_mounted(void) {
    boot();
    c.mounted_version = 5; strcpy(c.mounted_sha256, "deadbeef");
    fake_push_response("HTTP/1.1 404 Not Found\r\nContent-Length: 30\r\n\r\n"
                       "{\"error\":\"device_not_found\"}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_HALTED);
    CHECK(strcmp(c.mounted_sha256, "deadbeef") == 0,
          "a deleted device row is an absence of signal, never an eject");
}

static void test_401_halts(void) {
    boot();
    fake_push_response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 24\r\n\r\n"
                       "{\"error\":\"unauthorized\"}");
    CHECK_EQ_INT(dc_step(&c), DC_HALTED);
}

static void test_204_repolls_with_same_since(void) {
    boot();
    c.since = 4;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK_EQ_INT(c.since, 4);
    CHECK(strstr(fake_last_request(), "since=4") != NULL, "same since re-polled");
}

// --- image endpoint status codes (spec §4.2, second table) ---------------
// A digest that can never succeed must not be retried forever, but must also
// not stop the device polling -- the desired state may change to something
// it CAN fetch. Retrying a 422 in a tight loop is the obvious wrong answer.

static void poll_then_image(const char *image_response) {
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 120\r\n\r\n"
        "{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    fake_push_response(image_response);
}

static void test_image_422_does_not_retry_the_digest_but_keeps_polling(void) {
    boot();
    poll_then_image("HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: 24\r\n\r\n"
                    "{\"error\":\"unencodable\"}");
    dc_state_t s = dc_step(&c);
    CHECK(s != DC_HALTED, "a bad digest must not stop the poll loop");
    CHECK_EQ_INT(c.since, 0);
    CHECK(dc_digest_is_blocked(&c, "aa"), "this digest must not be retried");
}

static void test_image_404_behaves_the_same_as_422(void) {
    boot();
    poll_then_image("HTTP/1.1 404 Not Found\r\nContent-Length: 22\r\n\r\n"
                    "{\"error\":\"not_found\"}");
    CHECK(dc_step(&c) != DC_HALTED, "keep polling");
    CHECK(dc_digest_is_blocked(&c, "aa"), "do not retry this digest");
}

static void test_image_400_is_a_firmware_bug_and_never_retried(void) {
    boot();
    poll_then_image("HTTP/1.1 400 Bad Request\r\nContent-Length: 26\r\n\r\n"
                    "{\"error\":\"invalid_body\"}");
    dc_step(&c);
    CHECK(dc_digest_is_blocked(&c, "aa"), "a malformed digest will not become valid");
}

static void test_image_503_is_retried(void) {
    boot();
    poll_then_image("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 21\r\n\r\n"
                    "{\"error\":\"no_blob\"}");
    dc_step(&c);
    CHECK(!dc_digest_is_blocked(&c, "aa"),
          "503 is transient -- blocking the digest would strand a fetchable disk");
    CHECK(c.backoff_ms > 0, "503 should back off");
}

int main(void) {
    RUN(test_cold_boot_polls_since_zero);
    RUN(test_since_does_not_advance_on_a_failed_fetch);
    RUN(test_poll_404_keeps_the_disk_mounted);
    RUN(test_401_halts);
    RUN(test_204_repolls_with_same_since);
    RUN(test_image_422_does_not_retry_the_digest_but_keeps_polling);
    RUN(test_image_404_behaves_the_same_as_422);
    RUN(test_image_400_is_a_firmware_bug_and_never_retried);
    RUN(test_image_503_is_retried);
    return REPORT();
}
```

The blocked-digest set needs somewhere to live. Add to `device_client.h`:

```c
// Digests that returned 400/404/422 -- permanently unfetchable for this
// device. Small and fixed: the desired state rarely cycles through many bad
// digests, and an unbounded set on a device with no allocator is worse than
// forgetting the oldest.
#define DC_BLOCKED_MAX 4
bool dc_digest_is_blocked(const device_client_t *c, const char *sha256);
```

- [ ] **Step 3: Run — every test must fail before implementation**

```bash
pnpm firmware:test
```

Confirm each named test appears and fails. Two of these (`test_poll_404...`, `test_since_does_not_advance...`) assert an *absence* of change; against an unimplemented `dc_step` they could pass vacuously. **Verify each fails for the stated reason** — this project has shipped two tests that passed against a page that did not exist, both of which asserted only an absence.

- [ ] **Step 4: Implement `device_client.c`**

Structure `dc_step` as: build poll request → write → read with `DC_POLL_TIMEOUT_MS` → parse → dispatch on status per §4.2 of the spec. `since` is assigned in exactly one place in the file, after the swap completes; add a comment there saying so.

Reminder: no SDK or lwIP includes in this file.

- [ ] **Step 5: Run — pass. Then mutate**

For each of the five tests, break the corresponding logic, confirm that named test fails, revert. Record the five names in the commit message.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/device_client.* wifi-floppy/firmware/src/json_scan.* wifi-floppy/firmware/test
git commit -m "Add the device client poll loop and the two since rules"
```

---

### Task 7: Backoff, timeouts, and status reporting

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.c`, `device_client.h`
- Modify: `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Consumes: Task 6's `device_client_t`.
- Produces:

```c
// Read timeout must exceed the server's 25s hold; 30s is the floor.
#define DC_POLL_TIMEOUT_MS  30000
#define DC_BACKOFF_FLOOR_MS  1000
#define DC_BACKOFF_CAP_MS   60000
#define DC_STATUS_PERIOD_MS 60000
void dc_report_status(device_client_t *c, int psram_free, int rssi, const char *err);
```

- [ ] **Step 1: Write failing tests**

```c
static void test_read_timeout_exceeds_the_hold(void) {
    // The poll holds 25s. A timeout at or under that tears down every poll
    // mid-hold and looks exactly like a network fault.
    CHECK(DC_POLL_TIMEOUT_MS > 25000, "read timeout must exceed the 25s hold");
}

static void test_backoff_grows_and_is_capped(void) {
    boot();
    uint32_t prev = 0;
    for (int i = 0; i < 8; i++) {
        fake_push_connect_failure();
        dc_step(&c);
        CHECK(c.backoff_ms >= prev, "backoff must not shrink on repeated failure");
        CHECK(c.backoff_ms <= DC_BACKOFF_CAP_MS, "backoff must be capped");
        prev = c.backoff_ms;
    }
    CHECK(prev > 1000, "backoff should have grown beyond the 1s floor");
}

static void test_backoff_resets_after_success(void) {
    boot();
    fake_push_connect_failure(); dc_step(&c);
    CHECK(c.backoff_ms > 0, "failure sets backoff");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n"); dc_step(&c);
    CHECK_EQ_INT(c.backoff_ms, 0);
}

static void test_status_sends_all_six_fields(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL);
    const char *r = fake_last_request();
    CHECK(strstr(r, "mountedSha256") != NULL, "mountedSha256");
    CHECK(strstr(r, "mountedDiskId") != NULL, "mountedDiskId");
    CHECK(strstr(r, "\"version\"")   != NULL, "version");
    CHECK(strstr(r, "\"error\"")     != NULL, "error");
    CHECK(strstr(r, "psramFree")     != NULL, "psramFree");
    CHECK(strstr(r, "\"rssi\"")      != NULL, "rssi");
}

static void test_unmounted_reports_null_not_omitted(void) {
    // null means "I hold no disk" -- an honest report. Omitting the key means
    // "no opinion" and leaves the server's column stale.
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL);
    CHECK(strstr(fake_last_request(), "\"mountedSha256\":null") != NULL,
          "an unmounted device must report null explicitly");
}
```

- [ ] **Step 2: Run, watch each fail. Step 3: Implement.**

Backoff: exponential from `DC_BACKOFF_FLOOR_MS` (1000) doubling to `DC_BACKOFF_CAP_MS` (60000), plus jitter derived from the injected clock so tests stay deterministic — take jitter as `now % 250` rather than `rand()`.

- [ ] **Step 4: Run — pass. Mutate each. Commit.**

```bash
git commit -m "Add backoff, the poll read timeout, and six-field status reports"
```

---

### Task 8: Two PSRAM slots and fetch-before-transition

**Files:**
- Modify: `wifi-floppy/firmware/src/psram_image.c`, `psram_image.h`, `track_cache.c`, `track_cache.h`, `image_loader.c`, `image_loader.h`, `device_client.c`
- Modify: `wifi-floppy/firmware/test/test_psram_image.c`, `test_device_client.c`

**Interfaces:**
- Produces: every `psram_image_*` gains a leading `int slot` (so Task 2's `test_psram_image.c` calls must be updated), plus:

```c
#define SLOT_COUNT 2
#define SLOT_NONE  (-1)
void psram_publish_slot(int slot);      // the single volatile store core0 reads
int  psram_active_slot(void);           // SLOT_NONE when ejected
int  psram_inactive_slot(void);         // the fetch target; SLOT_NONE -> 0
void psram_image_reset_slot(int slot);  // clear one slot, leaving the other
```

- [ ] **Step 1: Write failing tests**

```c
static void test_fetch_targets_the_inactive_slot(void) {
    psram_publish_slot(0);
    CHECK_EQ_INT(psram_inactive_slot(), 1);
    psram_publish_slot(1);
    CHECK_EQ_INT(psram_inactive_slot(), 0);
}

static void test_publish_is_all_or_nothing(void) {
    // Core0 must never see a half-filled slot. Writing tracks into the
    // inactive slot must not change what active reads.
    psram_publish_slot(0);
    psram_image_reset_slot(1);
    uint8_t src[64] = {7};
    psram_image_write_at(1, 3, 0, src, 64);
    psram_image_commit(1, 3, 512);
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK(!psram_image_have(psram_active_slot(), 3),
          "the active slot must be unaffected by a fetch into the other");
}

static void test_eject_publishes_slot_none(void) {
    psram_publish_slot(0);
    psram_publish_slot(SLOT_NONE);
    CHECK_EQ_INT(psram_active_slot(), SLOT_NONE);
}
```

And in `test_device_client.c`, the rule this task exists for:

```c
static void test_current_disk_survives_a_failed_replacement_fetch(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old");
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 120\r\n\r\n"
        "{\"version\":8,\"desired\":{\"sha256\":\"new\",\"diskId\":\"d2\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    dc_step(&c);
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK(strcmp(c.mounted_sha256, "old") == 0,
          "a failed fetch must leave the Amiga holding the disk it had");
}
```

- [ ] **Step 2: Run, watch fail. Step 3: Implement.**

`active_slot` is a `static volatile int32_t`, written only by `psram_publish_slot` and read by `track_cache_get`. Naturally aligned, so no lock. Add a comment stating that the safety argument depends on only ever publishing complete, verified images.

- [ ] **Step 4: Run, mutate, commit.**

```bash
git commit -m "Add two PSRAM slots and fetch-before-transition"
```

---

### Task 9: TLS transport, SNTP, and the root bundle

Device-only. Verified by the cross-build and by the guard test, not by the host suite.

**Files:**
- Create: `wifi-floppy/firmware/src/transport_tls.c`, `sntp_time.c`, `sntp_time.h`, `roots.h`, `tools/gen_roots.sh`, `src/tls_guard.h`
- Modify: `wifi-floppy/firmware/CMakeLists.txt`, `lwipopts.h`
- Create: `wifi-floppy/firmware/mbedtls_config.h`

- [ ] **Step 1: Generate the root bundle**

`tools/gen_roots.sh` fetches five pinned roots and emits `roots.h` as a PEM string literal with each SHA-256 fingerprint in a comment: GTS Root R1, ISRG Root X1, DigiCert Global Root G2, Amazon Root CA 1, GlobalSign Root CA.

Verify the bundle actually validates the live chain before trusting it:

```bash
openssl s_client -connect webadf.vercel.app:443 -servername webadf.vercel.app \
  -CAfile wifi-floppy/firmware/tools/roots.pem 2>&1 | grep "Verify return code"
```

Expected: `Verify return code: 0 (ok)`. **If it is not 0, STOP and report** — shipping a bundle that cannot validate production is the whole failure this task exists to prevent.

- [ ] **Step 2: The guard that cannot be silently removed**

`src/tls_guard.h`:

```c
#ifndef TLS_GUARD_H
#define TLS_GUARD_H
// ALTCP_MBEDTLS_AUTHMODE defaults to MBEDTLS_SSL_VERIFY_OPTIONAL, under which
// a handshake against ANY certificate completes and returns success. That is
// functionally setInsecure() -- the upstream behaviour D5 cited as a reason
// not to use Gotek_WiFi_Dongle. It fails silently: the fetch works, the disk
// mounts, nothing logs. Hence a build break rather than a comment.
#if !defined(ALTCP_MBEDTLS_AUTHMODE)
#error "ALTCP_MBEDTLS_AUTHMODE must be set to MBEDTLS_SSL_VERIFY_REQUIRED"
#endif
#if ALTCP_MBEDTLS_AUTHMODE != MBEDTLS_SSL_VERIFY_REQUIRED
#error "ALTCP_MBEDTLS_AUTHMODE must be MBEDTLS_SSL_VERIFY_REQUIRED, not OPTIONAL/NONE"
#endif
#endif
```

Included by `transport_tls.c`.

- [ ] **Step 3: Prove the guard fires**

```bash
cd wifi-floppy/firmware && cmake -B build-guardtest -G Ninja \
  -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWFMF_OMIT_AUTHMODE=1 && cmake --build build-guardtest 2>&1 | grep -c "ALTCP_MBEDTLS_AUTHMODE"
```

Add a `WFMF_OMIT_AUTHMODE` option to `CMakeLists.txt` that omits the define, used only to demonstrate the guard. Expected: the build FAILS with that `#error`. Then `rm -rf build-guardtest`. This is the mutation proof for the highest-severity item in the spec.

- [ ] **Step 4: CMake and mbedTLS config**

```cmake
target_link_libraries(wifi_floppy
  ... pico_lwip_mbedtls pico_mbedtls)
target_compile_definitions(wifi_floppy PRIVATE
  ALTCP_MBEDTLS_AUTHMODE=MBEDTLS_SSL_VERIFY_REQUIRED
  WEBADF_HOST=\"webadf.vercel.app\")
set_source_files_properties(
  ${PICO_LWIP_PATH}/src/apps/altcp_tls/altcp_tls_mbedtls.c
  PROPERTIES COMPILE_OPTIONS "-Wno-unused-result")
```

`mbedtls_config.h` enables TLS 1.2+1.3, `MBEDTLS_HAVE_TIME_DATE`, and the cipher suites the live probe showed (`TLS_AES_128_GCM_SHA256`).

- [ ] **Step 5: SNTP before the first handshake**

`sntp_time.c` exposes `bool sntp_sync_blocking(uint32_t timeout_ms)` and `bool sntp_time_valid(void)`. `transport_tls.c`'s `connect` returns a distinct negative code if `!sntp_time_valid()` and never attempts a handshake — the device stays diskless rather than skipping expiry validation.

- [ ] **Step 6: Cross-build green, then commit**

```bash
pnpm firmware:build && pnpm firmware:test
git commit -m "Add TLS with a verified root bundle, an authmode guard, and SNTP"
```

---

### Task 10: Token store, registration, and wiring it together

**Files:**
- Create: `wifi-floppy/firmware/src/token_store.c`, `token_store.h`
- Create: `wifi-floppy/firmware/test/test_token_store.c`
- Modify: `wifi-floppy/firmware/src/device_client.c`, `main.c`, `CMakeLists.txt`
- Delete: `wifi-floppy/firmware/src/http_fetch.c`, `http_fetch.h`

**Interfaces:**
- Consumes: `device_client_t` (Task 6), `psram_active_slot`/`SLOT_NONE` (Task 8).
- Produces:

```c
// token_store.h -- flash on device, a static buffer under WFMF_HOST_TEST.
bool token_store_load(char *out, int out_len);   // false if none stored
bool token_store_save(const char *token);        // false if a disk is mounted
void token_store_erase(void);

// device_client.h -- one-shot registration. The pairing code IS the
// credential; this is the only request in the protocol with no bearer.
bool dc_register(device_client_t *c, const char *pairing_code,
                 const char *firmware_version, const char *mac);
```

- [ ] **Step 1: Write failing tests**

```c
static char buf[128];

static void test_token_round_trips(void) {
    token_store_erase();
    CHECK(!token_store_load(buf, sizeof buf), "no token initially");
    CHECK(token_store_save("tok-abc"), "save");
    CHECK(token_store_load(buf, sizeof buf), "load");
    CHECK(strcmp(buf, "tok-abc") == 0, "value");
}

static void test_register_body_has_the_three_required_fields(void) {
    boot();
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 60\r\n\r\n"
        "{\"token\":\"t-1\",\"deviceId\":\"d-1\",\"name\":\"Device x\"}");
    CHECK(dc_register(&c, "ABC123", "4a.0", "aa:bb:cc:dd:ee:ff"), "register");
    const char *r = fake_last_request();
    CHECK(strstr(r, "pairingCode")     != NULL, "pairingCode");
    CHECK(strstr(r, "firmwareVersion") != NULL, "firmwareVersion");
    CHECK(strstr(r, "macAddress")      != NULL, "macAddress");
    CHECK(strstr(r, "Authorization")   == NULL,
          "register is deliberately unauthenticated -- the code IS the credential");
}

static void test_register_stores_the_returned_token(void) {
    /* as above, then: */
    CHECK(token_store_load(buf, sizeof buf), "token persisted");
    CHECK(strcmp(buf, "t-1") == 0, "the returned token");
}

static void test_bad_code_does_not_store_anything(void) {
    boot(); token_store_erase();
    fake_push_response("HTTP/1.1 400 Bad Request\r\nContent-Length: 32\r\n\r\n"
                       "{\"error\":\"invalid_or_used_code\"}");
    CHECK(!dc_register(&c, "WRONG", "4a.0", "aa:bb:cc:dd:ee:ff"), "should fail");
    CHECK(!token_store_load(buf, sizeof buf), "nothing may be stored on failure");
}
```

- [ ] **Step 2: Run, watch fail. Step 3: Implement.**

Host build: a static buffer. Device build (`#ifndef WFMF_HOST_TEST`): a dedicated flash sector via `hardware/flash.h`, written with `flash_safe_execute`.

- [ ] **Step 4: The flash-versus-bus constraint**

In `main.c`, annotate the DMA IRQ:

```c
// Flash writes disable XIP. This handler re-arms the DMA each revolution and
// raises INDEX; stalling it mid-revolution presents to the Amiga as a
// malformed revolution -- a flaky drive, essentially undiagnosable without a
// scope. Kept in RAM so a token write can never reach it.
static void __isr __not_in_flash_func(dma_irq)(void) { ... }
```

And in `token_store.c`, assert that saving only happens while nothing is mounted:

```c
// Belt and braces with __not_in_flash_func above. Registration runs before
// any disk is mounted; if that ever stops being true, this catches it.
if (psram_active_slot() != SLOT_NONE) return false;
```

- [ ] **Step 5: Wire `main.c`, delete `http_fetch.c`**

`core1_main` becomes: connect WiFi → SNTP → load token or `dc_register` → loop `dc_step` with backoff sleeps and a 60 s status heartbeat. Remove `image_load(0)` and both `http_fetch` files, and drop them from `CMakeLists.txt`.

- [ ] **Step 6: Everything green, then commit**

```bash
pnpm firmware:test && pnpm firmware:build && pnpm vitest run
git commit -m "Add the token store, registration, and wire the client into main"
```

---

### Task 11: Reconcile the docs

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/specs/2026-08-30-device-firmware-protocol-design.md`

- [ ] **Step 1: Mark 4a delivered** in the spec, stating what shipped and what plan 5 still owes.

- [ ] **Step 2: Update `HANDOFF.md`** — the firmware compiles; 4a is done; the remaining unbuilt pieces are 4b (captive portal) and plan 5 (hardware bring-up). Remove "never compiled" everywhere it appears, including the firmware `README.md`'s "Honest caveats". Record the pico-sdk tag pinned in Task 1, the `pnpm firmware:*` scripts, and that `firmware-parser.ts` no longer mirrors the fixed defect — HANDOFF currently says never to fix it.

- [ ] **Step 3: Commit**

```bash
git commit -m "Record plan 4a as delivered"
```

---

## Done when

- `pnpm firmware:build` produces a `.uf2` — the firmware has been compiled.
- `pnpm firmware:test` green.
- `pnpm vitest run` green (241 + the mirror changes), `pnpm build` clean.
- The `ALTCP_MBEDTLS_AUTHMODE` guard was observed to break the build when the define is omitted.
- The root bundle was observed to validate the live `webadf.vercel.app` chain.
- Every test named in Tasks 3, 6, 7, 8 and 10 was observed to fail before it passed, and every defect fix was proved with a mutation.
- `http_fetch.c` is gone; `device_client.c` includes no SDK or lwIP header.
