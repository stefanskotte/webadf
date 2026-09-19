# Write-back piece 2b: the board uploads its writes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A track the Amiga writes reaches the server. The board uploads each dirty track,
closes the session 3 s after the last write, adopts the digest the server answers with, never
ejects or swaps with unsent writes, and shows sync state as a cloud on the OLED. The
`WF_WRITE_BACK` flag is removed: write-back is on in the normal build.

**Architecture:**
- `sha256.c`: a small pure-C SHA-256, so the board can state the digest of the image it holds
  when it closes a session. It is host-tested against the FIPS vectors.
- `http_build_head()`: request headers for a body that may be binary (a track has NUL bytes, so
  the C-string `http_build_request` cannot carry it).
- `device_client.c` gains four entry points the uploader needs: `dc_post` (one authenticated
  POST, binary-safe), `dc_set_hold` (a poll naming another disk, or an eject, waits while writes
  are pending), `dc_force_refetch` (the server's image won; fetch it even if the digest matches)
  and `dc_adopt_image` (a close answered 200; the board already holds those bytes).
- `uploader.c`: a pure, host-tested state machine on core1. It runs **instead of** the poll
  while writes are pending, one request at a time, and implements the device protocol exactly
  as HANDOFF §4g states it.
- `display.c`: the pencil becomes a cloud with three states; read-only keeps the padlock.
- `main.c`: core0 counts applied writes; core1 gives the uploader priority over the poll, ORs
  its forced write-protect into WPROT, reports status whenever the mount version changes, and
  the build flags go.

**Tech stack:** C11, pico-sdk 2.x on RP2350 (Pimoroni Pico Plus 2 W), the host test harness in
`wifi-floppy/firmware/test/` (`run.sh`, `harness.h`, `transport_fake.c`).

**Spec:** `docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md` §3.1, §3.2,
§5, §6. **Where the spec text and HANDOFF §4g disagree, HANDOFF §4g wins** — it records the
protocol the server actually implements (session tokens, mount fixed per session, write-protect
decided at open, the close answers, `reason:'behind'`).

## Global constraints

- Host tests: `cd wifi-floppy/firmware/test && ./run.sh`. Every test is compiled with
  `-std=c11 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1` against every `src/*.c` not excluded in
  `run.sh`. A new `src/*.c` is included automatically, so it must be host-portable: **no
  pico-sdk or lwIP includes** in `sha256.c`, `uploader.c`, `http.c` or `device_client.c`.
- A new `src/*.c` must ALSO be added to `add_executable(wifi_floppy ...)` in
  `wifi-floppy/firmware/CMakeLists.txt` — piece 1 forgot `write_back.c` there.
- Device build: `export PICO_SDK_PATH=/Users/sfs/pico-sdk`. Build options are cached in the
  build directory; pass every `-DWF_*` explicitly when configuring.
- **Core1 stack is 2 KB and shared with the mbedTLS handshake** (device_client.c's STACK note).
  Every buffer over ~64 bytes in code that runs on core1 (`uploader.c`, `sha256.c`,
  `dc_post`) is `static`, and the non-re-entrancy argument in the STACK note is extended to
  cover the new call paths.
- **Never `git add -A`** under `wifi-floppy/`: other sessions change this tree. Re-run
  `git status` immediately before staging, and stage explicit paths.
- Run long commands in the foreground (timeout up to 600000 ms). Do not use `git stash`.
- Protocol, verbatim from HANDOFF §4g (the server is live and already speaks it):
  - Upload: `POST /api/device/write?disk=<diskId>&mount=<n>&track=<0-159>&session=<token>&seq=<n>`,
    body `application/octet-stream`, exactly 5,632 bytes.
  - Close: `POST /api/device/write/close?disk=..&mount=..&session=..&seq=<last>&sha256=<hex>`,
    no body.
  - Token: 1–64 of `[A-Za-z0-9_-]`, random per boot, kept until a close resolves.
  - A session's `mount` is fixed from open to close.
  - Upload answers: 200 `{staged}` | 200 `{duplicate}` | 400 | 404 | 409 `not_mounted`
    (optionally `reason:'behind'`) | 409 `write_protected` (only when opening).
  - Close answers: 200 `{sha256}` | 200 `{sha256, unchanged:true}` | 409 `mismatch` |
    409 `conflict` (session kept; retry with capped backoff) | 409 `incomplete` (session kept;
    re-upload its tracks) | 409 `not_mounted` | 404.
- Uploader timing constants: idle close after **3000 ms** without an applied write; backoff
  floor **1000 ms**, doubling, cap **60000 ms**, jitter `now() % 250`.

---

### Task 1: SHA-256

**Files:**
- Create: `wifi-floppy/firmware/src/sha256.h`, `wifi-floppy/firmware/src/sha256.c`
- Create: `wifi-floppy/firmware/test/test_sha256.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (add `src/sha256.c` to `add_executable`)

**Interfaces:**
- Produces:
  ```c
  typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } sha256_t;
  void sha256_init(sha256_t *s);
  void sha256_update(sha256_t *s, const uint8_t *p, size_t len);
  void sha256_final(sha256_t *s, uint8_t out[32]);
  void sha256_hex(const uint8_t digest[32], char out[65]);   // lowercase, NUL-terminated
  ```

- [ ] **Step 1: Write the failing test** — `test/test_sha256.c`:

```c
#include "harness.h"
#include "../src/sha256.h"
#include <stdlib.h>
#include <string.h>

static void hex_of(const uint8_t *p, size_t n, char out[65]) {
    sha256_t s; uint8_t d[32];
    sha256_init(&s); sha256_update(&s, p, n); sha256_final(&s, d); sha256_hex(d, out);
}

static void fips_vectors(void) {
    char h[65];
    hex_of((const uint8_t *)"", 0, h);
    CHECK(strcmp(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") == 0, "empty");
    hex_of((const uint8_t *)"abc", 3, h);
    CHECK(strcmp(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0, "abc");
    const char *m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    hex_of((const uint8_t *)m, strlen(m), h);
    CHECK(strcmp(h, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1") == 0,
          "two-block message (padding crosses a block)");
}

static void million_a(void) {
    uint8_t *p = malloc(1000000); memset(p, 'a', 1000000);
    char h[65]; hex_of(p, 1000000, h); free(p);
    CHECK(strcmp(h, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0") == 0,
          "one million 'a'");
}

// The board hashes a disk track by track: 160 updates of 5,632 bytes. The
// digest must not depend on how the bytes were split.
static void chunked_equals_one_shot(void) {
    const size_t len = 901120;
    uint8_t *p = malloc(len);
    for (size_t i = 0; i < len; i++) p[i] = (uint8_t)(i * 31 + (i >> 9));
    char one[65]; hex_of(p, len, one);
    sha256_t s; uint8_t d[32]; char chunked[65];
    sha256_init(&s);
    for (size_t off = 0; off < len; off += 5632) sha256_update(&s, p + off, 5632);
    sha256_final(&s, d); sha256_hex(d, chunked);
    CHECK(strcmp(one, chunked) == 0, "track-sized chunks give the one-shot digest");
    free(p);
}

int main(void) {
    RUN(fips_vectors);
    RUN(million_a);
    RUN(chunked_equals_one_shot);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "sha256|COMPILE FAIL"`
Expected: `COMPILE FAIL: test_sha256.c` (no `sha256.h`).

- [ ] **Step 3: Implement** — `src/sha256.h`:

```c
#ifndef SHA256_H
#define SHA256_H
// FIPS 180-4 SHA-256, pure C, so the host tests and the board run the same
// code. The board uses it once per write session: the digest of the whole
// 901,120-byte image it holds, sent with the close so the server can confirm
// it recorded exactly those bytes (write-back spec §3.1).
#include <stdint.h>
#include <stddef.h>

typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } sha256_t;

void sha256_init(sha256_t *s);
void sha256_update(sha256_t *s, const uint8_t *p, size_t len);
void sha256_final(sha256_t *s, uint8_t out[32]);
/** Lowercase hex, NUL-terminated -- the form the server's routes compare. */
void sha256_hex(const uint8_t digest[32], char out[65]);
#endif
```

`src/sha256.c`:

```c
#include "sha256.h"
#include <string.h>

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void block(sha256_t *s, const uint8_t *p) {
    // static: 256 bytes is an eighth of core1's 2 KB stack, which the cyw43
    // IRQ shares (device_client.c's STACK note). Not re-entrant: only core1
    // hashes, and never from an interrupt.
    static uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16
             | (uint32_t)p[4 * i + 2] << 8 | (uint32_t)p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3];
    uint32_t e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
        uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d;
    s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

void sha256_init(sha256_t *s) {
    static const uint32_t H0[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    };
    memcpy(s->h, H0, sizeof H0);
    s->len = 0;
    s->n = 0;
}

void sha256_update(sha256_t *s, const uint8_t *p, size_t len) {
    s->len += len;
    while (len) {
        size_t take = 64 - s->n;
        if (take > len) take = len;
        memcpy(s->buf + s->n, p, take);
        s->n += take; p += take; len -= take;
        if (s->n == 64) { block(s, s->buf); s->n = 0; }
    }
}

void sha256_final(sha256_t *s, uint8_t out[32]) {
    const uint64_t bits = s->len * 8u;       // before the padding changes len
    s->buf[s->n++] = 0x80;
    if (s->n > 56) {
        memset(s->buf + s->n, 0, 64 - s->n);
        block(s, s->buf);
        s->n = 0;
    }
    memset(s->buf + s->n, 0, 56 - s->n);
    for (int i = 0; i < 8; i++) s->buf[56 + i] = (uint8_t)(bits >> (56 - 8 * i));
    block(s, s->buf);
    for (int i = 0; i < 8; i++) {
        out[4 * i]     = (uint8_t)(s->h[i] >> 24);
        out[4 * i + 1] = (uint8_t)(s->h[i] >> 16);
        out[4 * i + 2] = (uint8_t)(s->h[i] >> 8);
        out[4 * i + 3] = (uint8_t)s->h[i];
    }
}

void sha256_hex(const uint8_t digest[32], char out[65]) {
    static const char hx[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out[2 * i]     = hx[digest[i] >> 4];
        out[2 * i + 1] = hx[digest[i] & 15];
    }
    out[64] = '\0';
}
```

Add `src/sha256.c` to `add_executable(wifi_floppy ...)` in `CMakeLists.txt`.

- [ ] **Step 4: Run the tests**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | tail -30`
Expected: `test_sha256.c: 5 checks, 0 failed`, and every other binary still passes.

- [ ] **Step 5: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/sha256.h wifi-floppy/firmware/src/sha256.c \
        wifi-floppy/firmware/test/test_sha256.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: SHA-256, pure C, for the digest a board states when it closes a write session

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: A binary-safe request head, and a fake that records binary requests

**Files:**
- Modify: `wifi-floppy/firmware/src/http.h`, `wifi-floppy/firmware/src/http.c`
- Modify: `wifi-floppy/firmware/test/transport_fake.h`, `wifi-floppy/firmware/test/transport_fake.c`
- Test: `wifi-floppy/firmware/test/test_http.c`, `wifi-floppy/firmware/test/test_transport_fake.c`

**Interfaces:**
- Produces:
  ```c
  int http_build_head(char *out, int out_len, const char *method, const char *path,
                      const char *host, const char *bearer, const char *content_type,
                      int body_len);          // header bytes written, or -1
  int fake_last_request_len(void);            // bytes written since the last connect()
  ```
  `FAKE_MAX_REQUEST_BYTES` becomes 16384 (a track upload is ~6 KB).

- [ ] **Step 1: Write the failing tests.** Append to `test/test_http.c` (and add the `RUN`
lines to its `main`):

```c
static void head_for_a_binary_body(void) {
    char out[512];
    int n = http_build_head(out, sizeof out, "POST", "/api/device/write?track=3",
                            "h.example", "tok", "application/octet-stream", 5632);
    CHECK(n > 0, "fits");
    CHECK(strcmp(out,
        "POST /api/device/write?track=3 HTTP/1.1\r\n"
        "Host: h.example\r\n"
        "Authorization: Bearer tok\r\n"
        "Content-Type: application/octet-stream\r\n"
        "Content-Length: 5632\r\n"
        "Connection: keep-alive\r\n"
        "\r\n") == 0, "exact head");
    CHECK_EQ_INT(n, (long)strlen(out));
}

static void head_for_an_empty_post_still_says_zero(void) {
    char out[512];
    int n = http_build_head(out, sizeof out, "POST", "/c", "h", "tok", NULL, 0);
    CHECK(n > 0, "fits");
    CHECK(strstr(out, "Content-Length: 0\r\n") != NULL,
          "a POST with no body must still say so, or a proxy may wait for one");
    CHECK(strstr(out, "Content-Type") == NULL, "no type when there is no body");
}

static void head_that_does_not_fit_is_refused(void) {
    char out[40];
    CHECK_EQ_INT(http_build_head(out, sizeof out, "POST", "/a/long/path", "host", "tok",
                                 "application/octet-stream", 1), -1);
}
```

Append to `test/test_transport_fake.c` (and its `main`):

```c
static void records_binary_writes_with_their_length(void) {
    fake_reset();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    transport_t *t = fake_transport();
    CHECK_EQ_INT(t->connect(t, "h", 443), 0);
    static uint8_t body[6000];
    for (int i = 0; i < (int)sizeof body; i++) body[i] = (uint8_t)(i % 7);   // NULs included
    CHECK_EQ_INT(t->write(t, body, (int)sizeof body), (int)sizeof body);
    CHECK_EQ_INT(fake_last_request_len(), (int)sizeof body);
    CHECK(memcmp(fake_last_request(), body, sizeof body) == 0, "bytes past a NUL are kept");
    t->close(t);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "COMPILE FAIL|FAIL"`
Expected: `COMPILE FAIL: test_http.c` and `COMPILE FAIL: test_transport_fake.c`.

- [ ] **Step 3: Implement.** In `src/http.h`, below `http_build_request`:

```c
// Headers only, for a body the caller sends straight after them. Binary-safe
// where http_build_request is not: that one takes the body as a C string, and
// a disk track is full of NUL bytes. Always carries Content-Length (0 for no
// body). `content_type` NULL omits the header. Returns bytes written, or -1.
int  http_build_head(char *out, int out_len, const char *method, const char *path,
                     const char *host, const char *bearer, const char *content_type,
                     int body_len);
```

In `src/http.c`:

```c
int http_build_head(char *out, int out_len, const char *method, const char *path,
                    const char *host, const char *bearer, const char *content_type,
                    int body_len) {
    int n = snprintf(out, (size_t)out_len,
        "%s %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "%s%s%s"
        "%s%s%s"
        "Content-Length: %d\r\n"
        "Connection: keep-alive\r\n"
        "\r\n",
        method, path, host,
        bearer ? "Authorization: Bearer " : "", bearer ? bearer : "", bearer ? "\r\n" : "",
        content_type ? "Content-Type: " : "", content_type ? content_type : "",
        content_type ? "\r\n" : "",
        body_len);
    if (n < 0 || n >= out_len) return -1;
    return n;
}
```

In `test/transport_fake.c`: raise `FAKE_MAX_REQUEST_BYTES` to `16384`, and add

```c
int fake_last_request_len(void) {
    return g_request_len;
}
```

with its declaration in `transport_fake.h`, beside `fake_last_request`:

```c
// Exact length of the bytes written since the most recent connect(). Use it
// for a binary body: fake_last_request()'s C string stops at the first NUL.
int fake_last_request_len(void);
```

- [ ] **Step 4: Run the tests**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | tail -30`
Expected: all binaries pass, including the new checks.

- [ ] **Step 5: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/http.h wifi-floppy/firmware/src/http.c \
        wifi-floppy/firmware/test/transport_fake.h wifi-floppy/firmware/test/transport_fake.c \
        wifi-floppy/firmware/test/test_http.c wifi-floppy/firmware/test/test_transport_fake.c
git commit -m "firmware: a binary-safe request head; the fake records binary requests whole

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: What the device client must offer an uploader

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h`, `wifi-floppy/firmware/src/device_client.c`
- Test: `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Consumes: `http_build_head` (Task 2), `fake_last_request_len` (Task 2).
- Produces (in `device_client.h`):
  ```c
  typedef bool (*dc_hold_fn)(void *ctx);
  void dc_set_hold(device_client_t *c, dc_hold_fn fn, void *ctx);
  void dc_force_refetch(device_client_t *c);
  void dc_adopt_image(device_client_t *c, const char *sha256);
  #define DC_POST_BODY_MAX 5632
  int  dc_post(device_client_t *c, const char *path, const char *content_type,
               const uint8_t *body, int body_len, char *resp, int resp_cap);
  ```
  New private fields in `device_client_t`: `dc_hold_fn _hold; void *_hold_ctx; bool _refetch;`.

Behaviour:
- **Hold.** In `dc_handle_poll_body`, when a disk is mounted (`mounted_sha256[0] != '\0'`) and
  `_hold` returns true, a `desired: null` or a desired digest different from the mounted one is
  **not acted on**: nothing is ejected, fetched or published, `since` does not advance, the
  backoff is untouched, one `WF_INFO` line says `hold: <n> writes pending, not releasing the
  disk yet`, and the function returns `DC_IDLE_POLL`. With nothing mounted the hold is
  ignored (there is nothing to protect).
- **Force refetch.** Sets `_refetch = true` and `since = 0`. While `_refetch` is set, a poll
  naming the mounted digest takes the fetch path instead of the no-op path.
  `dc_complete_transition` clears `_refetch`.
- **Adopt.** Copies `sha256` into `mounted_sha256`. Nothing else changes.
- **Post.** Builds `http_build_head(...)` followed by `body` into one `static` buffer of
  `512 + DC_POST_BODY_MAX` bytes, runs `dc_exchange`, collects the response body with
  `dc_body_sink` into a `static dc_body_buf_t`, copies it NUL-terminated into `resp`. Returns
  the HTTP status; `-1` for a transport or framing failure, an incomplete body,
  `body_len > DC_POST_BODY_MAX`, or a head that does not fit. A 401 sets `state = DC_HALTED`
  and still returns 401.

- [ ] **Step 1: Write the failing tests.** Append to `test/test_device_client.c` (add each to
`main`). `boot()`, `push_ok_json`, `push_status_json` and `push_image_response` already exist in
this file; `push_image_response` pushes a valid image for digest `aa` (read it before use).

```c
static bool hold_true(void *ctx)  { (void)ctx; return true; }
static bool hold_false(void *ctx) { (void)ctx; return false; }

static void hold_keeps_the_disk_through_a_swap(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); strcpy(c.mounted_disk_id, "d1");
    c.since = 3; c.mounted_version = 3;
    dc_set_hold(&c, hold_true, NULL);
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"new\",\"diskId\":\"d2\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count(), 1);            // the poll, and no image fetch
    CHECK(strcmp(c.mounted_sha256, "old") == 0, "D7: never swap away from unsent writes");
    CHECK_EQ_INT(c.since, 3);                         // asked again once the hold lifts
    CHECK_EQ_INT(psram_active_slot(), 0);
}

static void hold_keeps_the_disk_through_an_eject(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); c.since = 3; c.mounted_version = 3;
    dc_set_hold(&c, hold_true, NULL);
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);
    CHECK(strcmp(c.mounted_sha256, "old") == 0, "D7: never eject with unsent writes");
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK_EQ_INT(c.since, 3);
}

static void a_lifted_hold_lets_the_eject_through(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); c.since = 3;
    dc_set_hold(&c, hold_false, NULL);
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);
    CHECK(c.mounted_sha256[0] == '\0', "no pending writes: the eject happens");
    CHECK_EQ_INT(psram_active_slot(), SLOT_NONE);
}

static void force_refetch_fetches_the_digest_already_mounted(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa"); c.since = 7; c.mounted_version = 7;
    dc_force_refetch(&c);
    CHECK_EQ_INT(c.since, 0);
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    push_image_response();
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "GET /api/device/image/aa") != NULL,
          "the server's image won: the board's copy must be replaced even though the digest matches");
    CHECK_EQ_INT(c.mounted_version, 8);
}

static void adopt_makes_the_next_poll_a_no_op(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa"); c.since = 7;
    dc_adopt_image(&c, "bb");
    CHECK(strcmp(c.mounted_sha256, "bb") == 0, "adopted");
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"bb\",\"diskId\":\"d1\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 1);            // no image fetch: already held
    CHECK_EQ_INT(c.mounted_version, 8);
}

static void post_sends_a_binary_body_whole(void) {
    boot();
    static uint8_t body[DC_POST_BODY_MAX];
    for (int i = 0; i < DC_POST_BODY_MAX; i++) body[i] = (uint8_t)(i * 13);
    push_ok_json("{\"staged\":3}");
    char resp[64];
    int st = dc_post(&c, "/api/device/write?track=3", "application/octet-stream",
                     body, DC_POST_BODY_MAX, resp, sizeof resp);
    CHECK_EQ_INT(st, 200);
    CHECK(strcmp(resp, "{\"staged\":3}") == 0, "response body returned");
    CHECK(strstr(fake_last_request(), "POST /api/device/write?track=3 HTTP/1.1") != NULL, "line");
    CHECK(strstr(fake_last_request(), "Content-Length: 5632\r\n") != NULL, "length");
    int n = fake_last_request_len();
    CHECK(n > DC_POST_BODY_MAX, "head + body");
    CHECK(memcmp(fake_last_request() + n - DC_POST_BODY_MAX, body, DC_POST_BODY_MAX) == 0,
          "the body arrives byte for byte, NULs and all");
}

static void post_reports_a_dead_link_and_a_dead_token(void) {
    boot();
    char resp[64];
    fake_push_connect_failure();
    CHECK_EQ_INT(dc_post(&c, "/c", NULL, NULL, 0, resp, sizeof resp), -1);
    push_status_json("HTTP/1.1 401 Unauthorized", "{\"error\":\"unauthorized\"}");
    CHECK_EQ_INT(dc_post(&c, "/c", NULL, NULL, 0, resp, sizeof resp), 401);
    CHECK_EQ_INT(c.state, DC_HALTED);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "COMPILE FAIL|test_device_client"`
Expected: `COMPILE FAIL: test_device_client.c`.

- [ ] **Step 3: Implement.**

In `device_client.h`, add the three fields to `device_client_t` (after `_obs_ctx`):

```c
    // --- write-back, see dc_set_hold / dc_force_refetch ---
    dc_hold_fn _hold;
    void      *_hold_ctx;
    bool       _refetch;
```

This needs `typedef bool (*dc_hold_fn)(void *ctx);` declared above the struct. Declare the four
functions and `DC_POST_BODY_MAX` below `dc_report_status`, each with a comment stating the
behaviour listed above.

In `device_client.c`:

```c
void dc_set_hold(device_client_t *c, dc_hold_fn fn, void *ctx) {
    c->_hold = fn;
    c->_hold_ctx = ctx;
}

void dc_force_refetch(device_client_t *c) {
    c->_refetch = true;
    c->since = 0;
}

void dc_adopt_image(device_client_t *c, const char *sha256) {
    strncpy(c->mounted_sha256, sha256, sizeof(c->mounted_sha256) - 1);
    c->mounted_sha256[sizeof(c->mounted_sha256) - 1] = '\0';
}

// D7: a disk with writes the server has not got is never released. Only
// when something IS mounted -- with nothing mounted there is nothing to lose.
static bool dc_held(device_client_t *c) {
    if (c->mounted_sha256[0] == '\0' || !c->_hold) return false;
    if (!c->_hold(c->_hold_ctx)) return false;
    wf_logf(WF_INFO, "hold: writes pending, not releasing the disk yet");
    return true;
}
```

In `dc_complete_transition`, add `c->_refetch = false;`.

In `dc_handle_poll_body`:
- first line inside `if (json_is_null(json, "desired")) {`:
  `if (dc_held(c)) { c->state = DC_IDLE_POLL; return c->state; }`
- change the no-op condition to
  `if (!c->_refetch && c->mounted_sha256[0] != '\0' && strcmp(d.sha256, c->mounted_sha256) == 0) {`
- immediately before `return dc_fetch_image(c, &d);`:
  `if (dc_held(c)) { c->state = DC_IDLE_POLL; return c->state; }`

`dc_post`:

```c
#define DC_POST_HEAD_BYTES 512

int dc_post(device_client_t *c, const char *path, const char *content_type,
            const uint8_t *body, int body_len, char *resp, int resp_cap) {
    if (body_len < 0 || body_len > DC_POST_BODY_MAX) return -1;
    // static: see the STACK note above. One head + one track, ~6.1 KB.
    static char req[DC_POST_HEAD_BYTES + DC_POST_BODY_MAX];
    int n = http_build_head(req, DC_POST_HEAD_BYTES, "POST", path, c->host, c->token,
                            content_type, body_len);
    if (n < 0) return -1;
    if (body_len) memcpy(req + n, body, (size_t)body_len);

    static dc_body_buf_t out;
    out.len = 0; out.truncated = false; out.buf[0] = '\0';
    static http_resp_t r;
    bool ok = dc_exchange(c, req, n + body_len, dc_body_sink, &out, &r);
    if (resp && resp_cap > 0) snprintf(resp, (size_t)resp_cap, "%s", out.buf);
    if (!ok || !r.body_complete) return -1;
    if (r.status == 401) c->state = DC_HALTED;    // 401 anywhere halts
    return r.status;
}
```

Extend the STACK note's call graph with `core1_main -> up_step -> dc_post -> dc_exchange`, a
straight line never nested inside `dc_step`.

- [ ] **Step 4: Run the tests**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | tail -30`
Expected: all binaries pass, including the seven new tests.

- [ ] **Step 5: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c \
        wifi-floppy/firmware/test/test_device_client.c
git commit -m "device client: hold a disk with unsent writes, force a refetch, adopt a closed image, post a binary body

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Dirty flags that are safe across cores

**Files:**
- Modify: `wifi-floppy/firmware/src/psram_image.h`, `wifi-floppy/firmware/src/psram_image.c`
- Test: `wifi-floppy/firmware/test/test_psram_image.c`

**Interfaces:**
- Produces:
  ```c
  void psram_image_set_dirty(int slot, int track);      // flag only; a PRESENT track becomes DIRTY
  int  psram_image_dirty_count(int slot);
  void psram_image_discard_dirty(int slot);             // every DIRTY track becomes PRESENT
  ```

Why: core0 marks a track dirty (payload, then flag); core1 clears the flag and then reads the
payload (spec §3.1 step 1). That order is only safe if the payload store is visible before the
flag store. `store()` gets `wfmf_barrier()` between its `memcpy`/`bits` stores and the `state`
store, and `psram_image_clear_dirty` gets one after its flag store, so core1's payload read
cannot be hoisted above it. `set_dirty` is the uploader's "put the flag back" when a read tore;
it never touches the payload, and it never marks an ABSENT track.

- [ ] **Step 1: Write the failing test.** Append to `test/test_psram_image.c` (and `main`),
using that file's existing backing setup:

```c
static void set_dirty_and_discard(void) {
    psram_image_reset_slot(0);
    uint8_t buf[16] = {1, 2, 3};
    psram_image_write_at(0, 5, 0, buf, sizeof buf);
    psram_image_commit(0, 5, 128);
    psram_image_set_dirty(0, 7);                          // ABSENT: refused
    CHECK_EQ_INT(psram_image_state(0, 7), TRK_ABSENT);
    psram_image_set_dirty(0, 5);
    CHECK_EQ_INT(psram_image_state(0, 5), TRK_DIRTY);
    CHECK_EQ_INT(psram_image_dirty_count(0), 1);
    uint8_t got[16]; uint32_t bits = 0;
    CHECK(psram_image_read(0, 5, got, &bits), "payload still there");
    CHECK(memcmp(got, buf, sizeof buf) == 0, "set_dirty never touches the payload");
    psram_image_discard_dirty(0);
    CHECK_EQ_INT(psram_image_state(0, 5), TRK_PRESENT);
    CHECK_EQ_INT(psram_image_dirty_count(0), 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "COMPILE FAIL"`
Expected: `COMPILE FAIL: test_psram_image.c`.

- [ ] **Step 3: Implement** in `psram_image.c` (declarations in the header next to
`psram_image_clear_dirty`, each with a one-line comment):

```c
void psram_image_set_dirty(int slot, int track) {
    if (psram_image_state(slot, track) == TRK_PRESENT) state[slot][track] = TRK_DIRTY;
}

int psram_image_dirty_count(int slot) {
    if (!have_psram || !slot_ok(slot)) return 0;
    int n = 0;
    for (int t = 0; t < NUM_TRACKS; t++) if (state[slot][t] == TRK_DIRTY) n++;
    return n;
}

void psram_image_discard_dirty(int slot) {
    if (!have_psram || !slot_ok(slot)) return;
    for (int t = 0; t < NUM_TRACKS; t++)
        if (state[slot][t] == TRK_DIRTY) state[slot][t] = TRK_PRESENT;
}
```

In `store()`, insert `wfmf_barrier();` between `bits[slot][track] = bit_count;` and
`state[slot][track] = st;`, with a comment: the payload must be visible to core1 before the
flag that tells it to read it. In `psram_image_clear_dirty`, add `wfmf_barrier();` after the
flag store, with the matching comment.

- [ ] **Step 4: Run the tests** — `./run.sh 2>&1 | tail -30`; all pass.

- [ ] **Step 5: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/psram_image.h wifi-floppy/firmware/src/psram_image.c \
        wifi-floppy/firmware/test/test_psram_image.c
git commit -m "psram image: barriers so a dirty flag is never seen before its payload; set, count and discard dirty

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The uploader — sending dirty tracks

**Files:**
- Create: `wifi-floppy/firmware/src/uploader.h`, `wifi-floppy/firmware/src/uploader.c`
- Create: `wifi-floppy/firmware/test/test_uploader.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (add `src/uploader.c`)

**Interfaces:**
- Consumes: `dc_post`, `dc_force_refetch`, `DC_POST_BODY_MAX` (Task 3);
  `psram_image_set_dirty`, `psram_image_dirty_count`, `psram_image_discard_dirty` (Task 4);
  `mfm_decode_track`, `MFM_TRACK_DATA_BYTES` (`mfm.h`); `json_str` (`json_scan.h`).
- Produces (`uploader.h`), used by Task 6, Task 7's caller and Task 8:
  ```c
  #define UP_IDLE_CLOSE_MS 3000u
  #define UP_SESSION_MAX   64
  typedef enum { UP_SYNCED, UP_PENDING, UP_OFFLINE } up_sync_t;
  typedef enum { UP_NOTHING, UP_WAITING, UP_DID_REQUEST } up_step_t;
  typedef uint32_t (*up_counter_fn)(void);

  typedef struct {
      device_client_t *dc;
      char     session[UP_SESSION_MAX + 1];
      up_counter_fn write_gen;       // +1 per write core0 applied
      up_counter_fn last_write_ms;   // dc->now() time of the last applied write
      bool     open;                 // a server session exists for (mount, session)
      uint32_t mount;                // fixed from open to close (HANDOFF 4g rule 2)
      char     disk_id[65];
      uint32_t seq;                  // last seq the server accepted in this session
      uint8_t  sent[(NUM_TRACKS + 7) / 8];
      bool     parked;               // after not_mounted, until the mount changes
      uint32_t parked_version;
      char     parked_sha[65];
      bool     online;               // last request reached the server
      uint32_t backoff_ms;
      uint32_t retry_at_ms;
      bool     force_wprot;          // after 409 write_protected, until the mount changes
      uint32_t wprot_version;
  } uploader_t;

  void      up_init(uploader_t *u, device_client_t *dc, const char *session,
                    up_counter_fn write_gen, up_counter_fn last_write_ms);
  bool      up_pending(const uploader_t *u);    // dirty tracks or an open session
  bool      up_has_work(uploader_t *u);         // run up_step instead of polling
  bool      up_holds(void *u);                  // a dc_hold_fn
  up_step_t up_step(uploader_t *u);             // at most one request
  up_sync_t up_sync(const uploader_t *u);
  bool      up_forces_wprot(uploader_t *u);
  ```

Behaviour (this task; closing is Task 6):
- `up_has_work` first refreshes: if `parked` and the device client's `mounted_version` or
  `mounted_sha256` differs from what was parked on, unpark; if `force_wprot` and
  `mounted_version != wprot_version`, clear it. Then it is true iff the device client is not
  `DC_HALTED`, a disk is published (`psram_active_slot() != SLOT_NONE`) and mounted
  (`mounted_sha256[0]`), not parked, and `up_pending`.
- `up_holds(u)` is `up_has_work(u)`.
- `up_step`: return `UP_NOTHING` if `!up_has_work`; `UP_WAITING` if
  `(int32_t)(now - retry_at_ms) < 0`. If a dirty track exists (`psram_image_next_dirty`,
  i.e. the lowest first), send it. Otherwise (session open, nothing dirty) hand over to the
  close in Task 6. In this task, return `UP_WAITING` there.
- Sending track `t`:
  1. If no session is open, open one: `open = true`, `mount = dc->mounted_version`,
     `disk_id = dc->mounted_disk_id`, `seq = 0`, `sent` cleared. This is local; the server
     opens its session on the first upload.
  2. `psram_image_clear_dirty(slot, t)`, then `psram_image_read` into a static 13,312-byte
     buffer, then `mfm_decode_track` into a static 5,632-byte buffer zeroed first. If
     `found != 0x7ff`, `!track_no_consistent` or `track_no != t`, the read overlapped core0
     rewriting it: `psram_image_set_dirty(slot, t)`, log `upload: trk %d torn, retrying`,
     return `UP_WAITING`. **A damaged track is never sent.**
  3. `dc_post` to `/api/device/write?disk=%s&mount=%lu&track=%d&session=%s&seq=%lu`, with
     `seq + 1` and `application/octet-stream`.
  4. `-1`: `set_dirty` back, `online = false`, back off. `200`: `online = true`,
     `backoff_ms = 0`, `seq++`, set `sent` bit `t`, log `upload: trk %d seq %lu ok`.
     `409` with `error == "write_protected"`: the server wins (below) and
     `force_wprot = true`, `wprot_version = dc->mounted_version`. `409 not_mounted`
     (any reason) or `404`: `set_dirty` back, then park (below). `401`: `set_dirty` back
     (the device client has already halted). Anything else: `set_dirty` back, `online = true`,
     back off, log the status. Every non-200 is logged with its status and `error`/`reason`.
     Return `UP_DID_REQUEST`.
- **Park:** mark every `sent` track dirty again (a fresh session must re-send them), clear the
  session, `parked = true`, and record `dc->mounted_version` and `mounted_sha256`. Log
  `upload: parked (%s) until the mount changes`.
- **The server wins:** `psram_image_discard_dirty(slot)`, clear the session, then
  `dc_force_refetch(dc)`. Log `upload: server image wins (%s), refetching`.
- **Back off:** the device client's formula (floor 1000 ms, doubling, cap 60000 ms, plus
  `now() % 250`, capped again); `retry_at_ms = now + backoff_ms`.
- `up_sync`: `UP_SYNCED` if not `up_pending`; else `UP_PENDING` if `online`, else `UP_OFFLINE`.
- `up_init` sets `online = true`.

- [ ] **Step 1: Write the failing tests** — `test/test_uploader.c`:

```c
#include "harness.h"
#include "transport_fake.h"
#include "../src/uploader.h"
#include "../src/device_client.h"
#include "../src/psram_image.h"
#include "../src/mfm.h"
#include "../src/sha256.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define TB MFM_TRACK_DATA_BYTES                  // 5632
static uint8_t adf[NUM_TRACKS * TB];             // what the board holds, decoded
static device_client_t c;
static uploader_t u;
static uint32_t gen, last_ms;
static bool gen_moves;                           // Task 6: a write lands mid-hash
static uint32_t write_gen(void) { return gen_moves ? gen++ : gen; }
static uint32_t last_write(void) { return last_ms; }

static void store_track(int t, const uint8_t *data, bool dirty) {
    static uint8_t mfm[MFM_TRACK_BYTES];
    uint32_t bits = mfm_encode_track(data, (uint8_t)t, mfm);
    if (dirty) { psram_image_mark_dirty(0, t, mfm, bits); return; }
    psram_image_write_at(0, t, 0, mfm, (int)((bits + 7) / 8));
    psram_image_commit(0, t, bits);
}

// A mounted disk in slot 0, every track present and clean, then the Amiga's
// writes on top: the image the board would hold after a save.
static void mounted(void) {
    fake_reset(); fake_set_clock(10000);
    psram_image_reset_slot(0); psram_image_reset_slot(1);
    for (int t = 0; t < NUM_TRACKS; t++) {
        for (int i = 0; i < TB; i++) adf[t * TB + i] = (uint8_t)(t * 7 + i);
        store_track(t, adf + t * TB, false);
    }
    psram_publish_slot(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "h", "tok");
    strcpy(c.mounted_sha256, "aa"); strcpy(c.mounted_disk_id, "d1");
    c.mounted_version = 7; c.since = 7;
    gen = 0; last_ms = 10000; gen_moves = false;
    up_init(&u, &c, "boot-abc", write_gen, last_write);
}

static void amiga_writes(int t, uint8_t fill) {
    memset(adf + t * TB, fill, TB);
    store_track(t, adf + t * TB, true);
    gen++; last_ms = fake_clock_ms();
}

static void push_json(const char *status, const char *body) {
    static char r[512];
    snprintf(r, sizeof r, "%s\r\nContent-Length: %zu\r\n\r\n%s", status, strlen(body), body);
    fake_push_response(r);
}

static void nothing_to_do_without_writes(void) {
    mounted();
    CHECK(!up_has_work(&u), "a clean disk needs no uploader");
    CHECK_EQ_INT(up_step(&u), UP_NOTHING);
    CHECK_EQ_INT(fake_request_count(), 0);
    CHECK_EQ_INT(up_sync(&u), UP_SYNCED);
}

static void a_dirty_track_is_uploaded_whole(void) {
    mounted();
    amiga_writes(40, 0x5a);
    CHECK(up_has_work(&u), "work");
    CHECK_EQ_INT(up_sync(&u), UP_PENDING);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(),
        "POST /api/device/write?disk=d1&mount=7&track=40&session=boot-abc&seq=1 HTTP/1.1") != NULL,
        "the protocol's query, verbatim");
    CHECK(strstr(fake_last_request(), "Content-Type: application/octet-stream") != NULL, "type");
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - TB, adf + 40 * TB, TB) == 0,
          "the body is the decoded track, byte for byte");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_PRESENT);
    CHECK_EQ_INT(u.seq, 1);
    CHECK(u.open, "session open until the close");
}

static void tracks_go_in_order_with_rising_seq(void) {
    mounted();
    amiga_writes(80, 1); amiga_writes(2, 2);
    push_json("HTTP/1.1 200 OK", "{\"staged\":2}");
    push_json("HTTP/1.1 200 OK", "{\"staged\":80}");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "track=2&session=boot-abc&seq=1") != NULL, "lowest first");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "track=80&session=boot-abc&seq=2") != NULL, "then the next");
}

static void the_mount_is_fixed_for_the_session(void) {
    mounted();
    amiga_writes(3, 1); amiga_writes(4, 2);
    push_json("HTTP/1.1 200 OK", "{\"staged\":3}");
    push_json("HTTP/1.1 200 OK", "{\"staged\":4}");
    up_step(&u);
    c.mounted_version = 8;                            // a bump acknowledged mid-session
    up_step(&u);
    CHECK(strstr(fake_last_request(), "mount=7&track=4") != NULL,
          "HANDOFF 4g rule 2: keep the mount the session opened under");
}

static void offline_keeps_the_write_and_backs_off(void) {
    mounted();
    amiga_writes(40, 0x5a);
    fake_push_connect_failure();
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
    CHECK_EQ_INT(up_sync(&u), UP_OFFLINE);
    CHECK(u.backoff_ms >= 1000, "backed off");
    CHECK(up_holds(&u), "D3/D7: offline, the disk is held");
    CHECK_EQ_INT(up_step(&u), UP_WAITING);            // not before retry_at
    CHECK_EQ_INT(fake_request_count(), 1);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_PRESENT);
    CHECK_EQ_INT(up_sync(&u), UP_PENDING);            // online again, close still to come
}

static void a_5xx_is_retried(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 503 Service Unavailable", "{\"error\":\"x\"}");
    up_step(&u);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
    CHECK_EQ_INT(up_sync(&u), UP_PENDING);            // the server answered: online
    CHECK(u.backoff_ms >= 1000, "backed off");
}

static void a_torn_read_is_never_sent(void) {
    mounted();
    amiga_writes(40, 0x5a);
    // Simulate core0 mid-rewrite: the stored MFM for track 40 is damaged.
    static uint8_t mfm[MFM_TRACK_BYTES]; uint32_t bits;
    psram_image_read(0, 40, mfm, &bits);
    mfm[2000] ^= 0xff;
    psram_image_mark_dirty(0, 40, mfm, bits);
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 0);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
}

static void not_mounted_parks_until_the_mount_changes(void) {
    mounted();
    amiga_writes(3, 1); amiga_writes(4, 2);
    push_json("HTTP/1.1 200 OK", "{\"staged\":3}");
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"not_mounted\",\"reason\":\"behind\"}");
    up_step(&u); up_step(&u);
    CHECK(u.parked, "parked");
    CHECK_EQ_INT(psram_image_state(0, 3), TRK_DIRTY);   // re-sent in a fresh session
    CHECK_EQ_INT(psram_image_state(0, 4), TRK_DIRTY);
    CHECK(!up_has_work(&u), "parked: the poll must run, or nothing ever reconciles");
    CHECK(!up_holds(&u), "and it may deliver a new disk");
    c.mounted_version = 8;                              // the poll's no-op reconciliation
    CHECK(up_has_work(&u), "unparked by the new mount");
    push_json("HTTP/1.1 200 OK", "{\"staged\":3}");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "mount=8&track=3&session=boot-abc&seq=1") != NULL,
          "a fresh session at the new mount");
}

static void write_protected_discards_and_refetches(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"write_protected\"}");
    up_step(&u);
    CHECK_EQ_INT(psram_image_dirty_count(0), 0);
    CHECK(up_forces_wprot(&u), "WPROT asserted now, not at the next poll");
    CHECK_EQ_INT(c.since, 0);                           // the server's image is fetched
    CHECK_EQ_INT(up_sync(&u), UP_SYNCED);
    c.mounted_version = 8;
    CHECK(!up_forces_wprot(&u), "the next mount decides again");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(nothing_to_do_without_writes);
    RUN(a_dirty_track_is_uploaded_whole);
    RUN(tracks_go_in_order_with_rising_seq);
    RUN(the_mount_is_fixed_for_the_session);
    RUN(offline_keeps_the_write_and_backs_off);
    RUN(a_5xx_is_retried);
    RUN(a_torn_read_is_never_sent);
    RUN(not_mounted_parks_until_the_mount_changes);
    RUN(write_protected_discards_and_refetches);
    free(mem);
    return REPORT();
}
```

If `psram_image_set_backing` needs `psram_image_init()`-style setup in this build, copy what
`test_write_back.c`'s `main` does, which is known to work.

- [ ] **Step 2: Run to verify it fails**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "COMPILE FAIL"`
Expected: `COMPILE FAIL: test_uploader.c`.

- [ ] **Step 3: Implement `uploader.h` and `uploader.c`** to the behaviour above. The header
opens with a comment that names the spec (§3.1), HANDOFF §4g, the one-request-at-a-time rule
(it runs on core1 and shares the device client's single transport, so a status report can
never race a close — HANDOFF §4g's fourth parked item is satisfied by construction), and the
rule that `uploader.c` includes no pico-sdk header. Static buffers:
`static uint8_t mfm[TRACK_MAX_BYTES]; static uint8_t trk[MFM_TRACK_DATA_BYTES];
static char path[256]; static char resp[256];`. Parse 409 bodies with
`json_str(resp, "error", ...)` and `json_str(resp, "reason", ...)`.

Add `src/uploader.c` to `add_executable(wifi_floppy ...)` in `CMakeLists.txt`.

- [ ] **Step 4: Run the tests** — `./run.sh 2>&1 | tail -30`; all pass.

- [ ] **Step 5: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/uploader.h wifi-floppy/firmware/src/uploader.c \
        wifi-floppy/firmware/test/test_uploader.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "uploader: send each dirty track under a per-boot session, one request at a time; park, back off, or let the server win

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The uploader — closing the session

**Files:**
- Modify: `wifi-floppy/firmware/src/uploader.c`
- Test: `wifi-floppy/firmware/test/test_uploader.c`

**Interfaces:**
- Consumes: `sha256_*` (Task 1), `dc_adopt_image` (Task 3), everything from Task 5.
- Produces: no new names. `up_step` now closes.

Behaviour, when a session is open, nothing is dirty and
`now - last_write_ms() >= UP_IDLE_CLOSE_MS`:
1. `g0 = write_gen()`. Hash the image: for each track 0..159, `psram_image_read` then
   `mfm_decode_track` (zeroed buffer), require a whole track exactly as in Task 5, and feed
   the 5,632 bytes to `sha256_update`. If any track fails, log `close: trk %d unreadable` and
   back off (no request).
2. If `write_gen() != g0` or a track is dirty again, a write landed while hashing: return
   `UP_WAITING` and send nothing.
3. `dc_post` with no body to
   `/api/device/write/close?disk=%s&mount=%lu&session=%s&seq=%lu&sha256=%s`
   (the session's `disk_id`, `mount`, the board's `session`, `seq`, the hex digest).
4. `-1`: `online = false`, back off; the session stays open. `200`: read `sha256` from the
   body; `dc_adopt_image(dc, it)`; log `close: %.12s%s` (with ` unchanged` when
   `"unchanged":true`), plus a warning if it differs from the board's own digest; clear the
   session; `online = true`; `backoff_ms = 0`. `409 mismatch`: the server wins. `409
   conflict`: back off, session kept. `409 incomplete`: mark every `sent` track dirty again
   and keep the session and its `seq`, so they go again with higher seqs. `409 not_mounted`
   or `404`: park. Anything else: back off.
   Return `UP_DID_REQUEST`.
5. While waiting for the idle interval, return `UP_WAITING`.

- [ ] **Step 1: Write the failing tests.** Append to `test/test_uploader.c` (and `main`):

```c
static void board_digest(char hex[65]) {
    sha256_t s; uint8_t d[32];
    sha256_init(&s); sha256_update(&s, adf, sizeof adf); sha256_final(&s, d);
    sha256_hex(d, hex);
}

static void upload_one(int t, uint8_t fill) {
    amiga_writes(t, fill);
    push_json("HTTP/1.1 200 OK", "{\"staged\":1}");
    up_step(&u);
}

static void closes_three_seconds_after_the_last_write(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS - 1);
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 1);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    char want[65]; board_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    char line[256];
    snprintf(line, sizeof line,
        "POST /api/device/write/close?disk=d1&mount=7&session=boot-abc&seq=1&sha256=%s HTTP/1.1", want);
    CHECK(strstr(fake_last_request(), line) != NULL,
          "the close names the digest of the whole image the board holds");
    CHECK(strcmp(c.mounted_sha256, want) == 0, "spec 3.1: adopted, no re-fetch");
    CHECK(!u.open, "closed");
    CHECK(!up_has_work(&u), "nothing left");
    CHECK_EQ_INT(up_sync(&u), UP_SYNCED);
}

static void a_write_during_the_hash_postpones_the_close(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    gen_moves = true;
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 1);              // no close sent
}

static void mismatch_lets_the_server_image_win(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"mismatch\",\"sha256\":\"cc\"}");
    up_step(&u);
    CHECK(!u.open, "never re-close after a mismatch (HANDOFF 4g)");
    CHECK_EQ_INT(c.since, 0);                           // re-download what the server holds
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "nothing adopted");
}

static void conflict_keeps_the_session_and_retries(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"conflict\"}");
    up_step(&u);
    CHECK(u.open, "kept");
    CHECK(u.backoff_ms >= 1000, "backed off");
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    char want[65]; board_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "/api/device/write/close?") != NULL, "the same close again");
    CHECK(!u.open, "closed on the retry");
}

static void incomplete_resends_the_sessions_tracks(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"incomplete\"}");
    up_step(&u);
    CHECK(u.open, "kept");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "track=40&session=boot-abc&seq=2") != NULL,
          "re-sent above the seq the server may already hold");
}

static void unchanged_is_adopted_too(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    push_json("HTTP/1.1 200 OK", "{\"sha256\":\"dd\",\"unchanged\":true}");
    up_step(&u);
    CHECK(strcmp(c.mounted_sha256, "dd") == 0, "adopted");
    CHECK(!u.open, "closed");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -A3 test_uploader`
Expected: the new tests FAIL (the close is never sent).

- [ ] **Step 3: Implement** the close in `uploader.c` as described. The hash buffers reuse the
`mfm`/`trk` statics from Task 5; `sha256_t` is a `static` too.

- [ ] **Step 4: Run the tests** — `./run.sh 2>&1 | tail -30`; all pass.

- [ ] **Step 5: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/uploader.c wifi-floppy/firmware/test/test_uploader.c
git commit -m "uploader: close 3 s after the last write with the image's digest; adopt it, or retry, resend, park, or yield

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The cloud on the OLED

**Files:**
- Modify: `wifi-floppy/firmware/src/display.h`, `wifi-floppy/firmware/src/display.c`
- Test: `wifi-floppy/firmware/test/test_display.c`

**Interfaces:**
- Produces: in `display.h`,
  ```c
  typedef enum { DISP_SYNC_SYNCED = 0, DISP_SYNC_PENDING, DISP_SYNC_OFFLINE } disp_sync_t;
  ```
  and a new field `disp_sync_t sync;` in `display_state_t`, after `writable`.

Spec §3.2: shown only when the disk is writable; a read-only disk keeps the padlock; three
states in one footprint, so nothing beside it moves. The cloud **replaces the pencil**: a cloud
is only ever drawn on a writable disk, so it still says "writable" (and the padlock still says
"read-only"), which keeps both values of the write state visible. Record that reasoning in the
comment above the glyphs.

Glyphs, 8×8, MSB = leftmost column, in the same format as `LOCK` and `PENCIL`:

```c
// synced: a plain cloud. pending: the same cloud with an up-arrow cut out of
// it. offline: the same cloud with a diagonal strike through it. All three
// share an outline, so they read as one symbol in three states.
static const uint8_t CLOUD[3][8] = {
    { 0x00, 0x18, 0x3C, 0x7E, 0xFF, 0xFF, 0x7E, 0x00 },   // DISP_SYNC_SYNCED
    { 0x00, 0x18, 0x24, 0x42, 0xE7, 0xE7, 0x66, 0x00 },   // DISP_SYNC_PENDING
    { 0x80, 0x58, 0x1C, 0x6E, 0xF7, 0xFB, 0x7C, 0x01 },   // DISP_SYNC_OFFLINE
};
```

`draw_write_state(fb, x, y, writable, sync)` draws `CLOUD[sync]` when writable and `LOCK`
otherwise, at the same position as today. `PENCIL` goes.

- [ ] **Step 1: Write the failing test.** Append to `test/test_display.c` (and `main`). Reuse
that file's existing helpers for rendering and for "any pixel lit in a region" (the pencil test
near line 139 uses them; read it first and use the same glyph box, `x` in
`[DISP_W - 18, DISP_W - 10)` on page 0):

```c
static void the_three_cloud_states_all_draw_and_all_differ(void) {
    display_state_t s; memset(&s, 0, sizeof s);
    s.status = DS_LOADED; s.writable = true;
    uint8_t fb[3][DISP_FB_BYTES];
    for (int k = 0; k < 3; k++) {
        s.sync = (disp_sync_t)k;
        display_render(&s, fb[k]);
        int lit = 0;
        for (int x = DISP_W - 18; x < DISP_W - 10; x++) lit += fb[k][x] != 0;
        CHECK(lit > 0, "every sync state must draw something");
    }
    CHECK(memcmp(fb[0], fb[1], DISP_FB_BYTES) != 0, "synced != pending");
    CHECK(memcmp(fb[1], fb[2], DISP_FB_BYTES) != 0, "pending != offline");
    CHECK(memcmp(fb[0], fb[2], DISP_FB_BYTES) != 0, "synced != offline");
    s.writable = false; s.sync = DISP_SYNC_SYNCED;
    uint8_t ro[DISP_FB_BYTES]; display_render(&s, ro);
    for (int k = 0; k < 3; k++)
        CHECK(memcmp(ro, fb[k], DISP_FB_BYTES) != 0, "read-only (padlock) differs from every cloud");
}
```

Adjust the existing pencil test's wording (not its assertions) from "pencil" to "cloud" where
it names the glyph.

- [ ] **Step 2: Run to verify it fails** — `./run.sh 2>&1 | grep -E "COMPILE FAIL"`:
`COMPILE FAIL: test_display.c` (no `sync` field).

- [ ] **Step 3: Implement** as above.

- [ ] **Step 4: Run the tests** — `./run.sh 2>&1 | tail -30`; all pass.

- [ ] **Step 5: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/display.h wifi-floppy/firmware/src/display.c \
        wifi-floppy/firmware/test/test_display.c
git commit -m "display: the pencil becomes a cloud -- synced, pending, offline -- on a writable disk; read-only keeps the padlock

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire it into the board, and remove the flags

**Files:**
- Modify: `wifi-floppy/firmware/src/main.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt`

**Interfaces:**
- Consumes: everything above.

Changes:
1. **Flags.** Delete `WRITE_BACK_IMPLEMENTED`, `WF_WRITE_CAPTURE`, `WF_WRITE_BACK` and
   `WF_ACCEPTS_WRITES` from `main.c`, and the `WF_WRITE_BACK` option block in
   `CMakeLists.txt` (plus a `WF_WRITE_CAPTURE` option if CMake has one). The apply path
   under `#if WF_WRITE_BACK` is now unconditional. The WPROT log line drops its `firmware=`
   field. Grep afterwards: `grep -n "WF_WRITE_BACK\|WF_WRITE_CAPTURE\|WRITE_BACK_IMPLEMENTED\|WF_ACCEPTS_WRITES" -r wifi-floppy/firmware/src wifi-floppy/firmware/CMakeLists.txt`
   must print nothing.
2. **Core0 counts writes.** Beside the other file statics:
   ```c
   // Written by core0 when a write lands, read by core1's uploader. last_ms
   // first, then the barrier, then gen: a reader that sees the new gen also
   // sees the time of the write that made it.
   static volatile uint32_t g_write_last_ms;
   static volatile uint32_t g_write_gen;
   static uint32_t wb_write_gen(void)    { return g_write_gen; }
   static uint32_t wb_last_write_ms(void) { return g_write_last_ms; }
   ```
   In the apply success branch (after `track_cache_invalidate(wt)`):
   `g_write_last_ms = clock_ms(); __dmb(); g_write_gen++;`
3. **Core1 session token and uploader.** After `dc_set_observer(&c, ui_observe, NULL);`:
   ```c
   // HANDOFF 4g rule 1: a token chosen per boot, so a rebooted board's seq 1
   // is never mistaken for the previous boot's seq 1.
   static char session[20];
   snprintf(session, sizeof session, "b%08lx%08lx",
            (unsigned long)get_rand_32(), (unsigned long)get_rand_32());
   static uploader_t up;
   up_init(&up, &c, session, wb_write_gen, wb_last_write_ms);
   dc_set_hold(&c, up_holds, &up);
   wf_logf(WF_INFO, "write-back: session %s", session);
   ```
   Include `pico/rand.h` and `uploader.h`; add `pico_rand` to `target_link_libraries`.
4. **The loop gives the uploader priority.** Replace `dc_state_t s = dc_step(&c);` with:
   ```c
   dc_state_t s;
   bool polled = false;
   if (up_has_work(&up)) {
       // Writes are pending: no long poll (it would hold the close for up
       // to 25 s), and no swap or eject (dc_set_hold). One request, then
       // round the loop so WPROT, status and the panel stay current.
       if (up_step(&up) == UP_WAITING) sleep_ms(50);
       s = c.state;
   } else {
       s = dc_step(&c);
       polled = true;
   }
   ```
   and make the existing `if (s == DC_BACKOFF) sleep_ms(c.backoff_ms);` apply only when
   `polled`, sleeping in 100 ms steps that stop early once `up_has_work(&up)` is true.
5. **WPROT** becomes `bool wprot = !mounted || c.mounted_write_protected || up_forces_wprot(&up);`
6. **Status on a mount-version change too.** The heartbeat condition gains
   `c.mounted_version != last_reported_version` (a `static uint32_t` next to
   `last_reported_sha`, updated where that is). The server decides `behind` and `not_mounted`
   from the `mountedVersion` it last heard. Until the board reports a new version, every
   upload under it is refused.
7. **Panel.** Add `static volatile int g_ui_sync;` next to `g_ui_writable`, set
   `g_ui_sync = (int)up_sync(&up);` beside `g_ui_writable = !wprot;`, and carry it into
   `display_state_t.sync` exactly the way `ui_snapshot` carries `writable`. `up_sync_t` and
   `disp_sync_t` have the same numbering, but convert with a `switch`, never a cast.
8. **A dead token with writes pending.** In the `DC_HALTED` branch, before
   `psram_publish_slot(SLOT_NONE)`, log
   `write-back: %d dirty tracks lost (token dead)` with
   `psram_image_dirty_count(psram_active_slot())` when it is non-zero.

- [ ] **Step 1: Make the changes above.**

- [ ] **Step 2: Host tests still pass** — `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | tail -30`.

- [ ] **Step 3: Device build is clean.**

```bash
cd wifi-floppy/firmware && export PICO_SDK_PATH=/Users/sfs/pico-sdk && \
cmake -S . -B build -DWF_BUS_SNIFF=OFF -DWF_VERIFY_TRACKS=OFF >/dev/null && \
cmake --build build -j8 2>&1 | grep -E "error:|warning:"; ls -la build/wifi_floppy.uf2
```

Expected: no `error:` or `warning:` lines, and a fresh `.uf2`. If configuring fails for
`PORTAL_AP_PASSWORD`, stop and report it: the operator supplies that value. Then check that
`uploader.c` and `sha256.c` are actually in the ELF (the plan-4a lesson: a green build proved
nothing when a file was not linked):
`arm-none-eabi-nm build/wifi_floppy.elf | grep -E " up_step$| sha256_final$| dc_post$"` must list
all three.

- [ ] **Step 4: Commit**

```bash
git status --short
git add wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: write-back is on -- the uploader runs before the poll, holds the disk, forces WPROT when refused; flags removed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Hardware acceptance, and handoff

This task needs the operator: only they can power the Amiga and type on it. **End the turn
with each request; never ask mid-turn.** The board is on `/dev/cu.usbmodem1101`; confirm
with `ls /dev/cu.usbmodem*` before flashing.

**Files:**
- Modify: `HANDOFF.md` (a new `### 4i` above `### 4h`)

- [ ] **Step 1: Prepare.** Mark a **scratch** Workbench disk writable in the web UI and mount
it on the board. Note its `disks.sha256` and its `disk_versions` rows. There should be none,
or only browser ones.

- [ ] **Step 2: Flash, and capture from the first line.** In the background, writing to the
scratchpad:

```bash
picotool load -f -x wifi-floppy/firmware/build/wifi_floppy.uf2; for i in $(seq 1 40); do [ -e /dev/cu.usbmodem1101 ] && break; sleep 0.25; done; stty -f /dev/cu.usbmodem1101 115200 raw -echo; exec cat /dev/cu.usbmodem1101 > <scratchpad>/2b.log
```

Confirm `write-back: session b…`, `wprot: RELEASED` for the disk, and (operator) a plain cloud.

- [ ] **Step 3: One save (spec §6 acceptance 1).** Ask the operator to type
`echo "written by 2b" >DF0:wb2b.txt` and watch the cloud: pending, then plain. From the log,
record every `upload: trk N seq S ok` with timestamps, the `close:` line, and **the time from
the last `write: trk .. applied` to the close's 200**. Then check the server independently:
`disks.sha256` equals the adopted digest; a `disk_versions` row with `source = 'amiga'` and this
device; and the ADF downloaded from `/api/disks/<id>/adf`, listed with `xdftool <file> list`,
contains `wb2b.txt` with the right size. Use xdftool, not the app's own reader.

- [ ] **Step 4: Eject, remount, power-cycle (acceptance 2 and 3).** Eject and remount from
the web UI, then ask the operator to `type DF0:wb2b.txt`. Then ask them to unplug the board's
USB and plug it back, and `type DF0:wb2b.txt` again.

- [ ] **Step 5: Flush before eject (D7).** Ask the operator to write a second file and, within
3 s, eject from the web UI. The log must show `hold: writes pending` and then the close before
the eject, and the server's image must contain both files.

- [ ] **Step 6: Offline (acceptance 5).** Ask the operator to cut the board's Wi-Fi (switch
off the access point), write a third file, and confirm the struck cloud. Then restore Wi-Fi:
the uploads and close follow, and the file is on the server. **Acceptance 4 (restore) waits for
piece 3**, which builds restore.

- [ ] **Step 7: Handoff.** Write `### 4i` in `HANDOFF.md`: what was verified on hardware, the
measured timings (per-upload latency, write-to-synced time, hash time for the close), anything
that surprised, and what piece 3 needs. Commit it.
