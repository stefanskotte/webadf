# Plan 4b — AP-Mode Provisioning Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a board learn its WiFi credentials and pairing code from a phone over a WPA2 access point, instead of having them compiled into the image.

**Architecture:** The same seam that made plan 4a provable. Each protocol module splits into a pure function over byte buffers (host-tested) and a thin lwIP binding (device-only). `provisioning.c` holds the state machine and includes no SDK header; `portal_net.c` is the only new file that touches the radio.

**Tech Stack:** C11 · pico-sdk 2.3.0 (RP2350, `PICO_BOARD=pimoroni_pico_plus2_w_rp2350`) · lwIP raw UDP/TCP + cyw43 AP mode · CMake + Ninja + ARM GNU Toolchain 15.3 · host tests in plain C under clang

**Spec:** `docs/superpowers/specs/2026-08-30-device-provisioning-portal-design.md`. Parents: `2026-08-30-device-firmware-protocol-design.md` (4a, which this extends), `2026-08-29-device-plane-disk-change-design.md`.

## Global Constraints

- **`provisioning.c` and the pure half of each server may not `#include` any pico-sdk or lwIP header.** This is what keeps them host-testable and it degrades silently — one include and nothing announces the loss. If a file seems to need one, move the seam.
- **A board that is already serving a disk never drops into the portal.** Spec §2. The portal is reachable only before a disk is mounted.
- **The association-failure counter is RAM-only.** Never persisted. A power-cycle restores patience; a flash-resident counter would eventually park a healthy board in AP mode permanently.
- **Verify, then commit.** Flash is written only after a successful association with the submitted credentials.
- **`400 invalid_or_used_code` from `/api/device/register` is terminal** — it returns to the portal rather than being retried.
- **Re-provisioning erases the stored token** as well as the credentials.
- **No flash write while `psram_active_slot() != SLOT_NONE`.** Inherited from 4a.
- **A failed association attempt is one `cyw43_arch_wifi_connect_timeout_ms()` call with a 15,000 ms timeout.** Three consecutive failures open the portal.
- AP: SSID `wifi-floppy-XXXX` (last two MAC octets, uppercase hex), WPA2-AES, password from `PORTAL_AP_PASSWORD`. Board is `192.168.4.1`.
- **Never log a WiFi password, a pairing code, or the device token.**
- **Compute every test fixture's length from its data.** Three separate rounds of plan 4a were lost to hand-counted `Content-Length` values.
- Cross-build: `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"` then `pnpm firmware:build`. If it fails oddly, `rm -rf wifi-floppy/firmware/build` first — a stale dir from a failed run mimics a toolchain failure.
- Run `pnpm firmware:test` and `pnpm firmware:build` before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config_store.c/.h` | **Create.** SSID, password, pairing code in flash, CRC-protected. |
| `src/provisioning.c/.h` | **Create.** The state machine. Pure. |
| `src/dns_server.c/.h` | **Create.** `dns_handle()` — answer every A query with the AP address. |
| `src/dhcp_server.c/.h` | **Create.** `dhcp_handle()` — DISCOVER→OFFER, REQUEST→ACK. |
| `src/portal_http.c/.h` | **Create.** `portal_request()` — routes, form decode, page render. |
| `src/portal_net.c/.h` | **Create.** lwIP/cyw43 glue: AP up/down, UDP sockets, TCP listener. Device-only. |
| `src/main.c` | **Modify.** Provisioning phase ahead of 4a's loop; stack re-measured. |
| `src/device_client.c/.h` | **Modify.** Distinguish `400 invalid_or_used_code` from other register failures. |
| `CMakeLists.txt` | **Modify.** Drop three defines, add `PORTAL_AP_PASSWORD`, add sources, force-link `portal_net`. |
| `test/run.sh` | **Modify.** Exclude `portal_net.c` from the host build. |
| `test/test_config_store.c`, `test_provisioning.c`, `test_dns_server.c`, `test_dhcp_server.c`, `test_portal_http.c` | **Create.** |

---

### Task 1: `config_store` — credentials in flash, CRC-protected

**Files:**
- Create: `wifi-floppy/firmware/src/config_store.c`, `config_store.h`
- Create: `wifi-floppy/firmware/test/test_config_store.c`

**Interfaces:**
- Consumes: `psram_active_slot()`, `SLOT_NONE` (from `psram_image.h`); `token_store_erase()` (from `token_store.h`).
- Produces:

```c
#define CONFIG_SSID_MAX 32     // 802.11 limit
#define CONFIG_PASS_MAX 63     // WPA2 passphrase limit
#define CONFIG_CODE_MAX 16     // pairing codes are 6; headroom

typedef struct {
    char ssid[CONFIG_SSID_MAX + 1];
    char pass[CONFIG_PASS_MAX + 1];
    char code[CONFIG_CODE_MAX + 1];
} device_config_t;

// False if nothing valid is stored (erased sector, bad magic, or CRC mismatch).
bool config_store_load(device_config_t *out);
// False on over-length fields or while a disk is mounted. Erases the token
// on success -- re-pairing issues a new one (spec §3).
bool config_store_save(const device_config_t *cfg);
// Clears credentials AND the token. Same mounted-disk guard.
void config_store_erase(void);
// Host tests only, both of them. Never called on device.
void config_store_test_simulate_torn_write(void);   // write that never finished
void config_store_test_corrupt_payload_byte(void);  // write that finished, payload damaged
```

The test file includes `../src/token_store.h` as well, for the erase-clears-the-token case.

- [ ] **Step 1: Write the failing tests**

`test/test_config_store.c`:

```c
#include "harness.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

static device_config_t mk(const char *s, const char *p, const char *c) {
    device_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    snprintf(cfg.ssid, sizeof cfg.ssid, "%s", s);
    snprintf(cfg.pass, sizeof cfg.pass, "%s", p);
    snprintf(cfg.code, sizeof cfg.code, "%s", c);
    return cfg;
}

static void test_round_trips(void) {
    config_store_erase();
    device_config_t out;
    CHECK(!config_store_load(&out), "nothing stored initially");

    device_config_t in = mk("my-network", "hunter2hunter2", "ABC123");
    CHECK(config_store_save(&in), "save");
    CHECK(config_store_load(&out), "load");
    CHECK(strcmp(out.ssid, "my-network") == 0, "ssid");
    CHECK(strcmp(out.pass, "hunter2hunter2") == 0, "pass");
    CHECK(strcmp(out.code, "ABC123") == 0, "code");
}

static void test_torn_write_reads_as_nothing_stored(void) {
    config_store_erase();
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(config_store_save(&in), "save");
    config_store_test_simulate_torn_write();
    device_config_t out;
    CHECK(!config_store_load(&out),
          "a torn write must read as nothing stored, never as partial credentials");
}

static void test_crc_mismatch_is_rejected(void) {
    // The whole reason config_store carries a CRC that token_store does not:
    // a write that completed the magic but corrupted the payload.
    config_store_erase();
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(config_store_save(&in), "save");
    config_store_test_corrupt_payload_byte();
    device_config_t out;
    CHECK(!config_store_load(&out), "a payload corruption must be caught by the CRC");
}

static void test_max_length_ssid_is_accepted(void) {
    // Named for what it actually asserts. Rejecting an OVER-length field is
    // portal_http's job (Task 5) -- by the time a device_config_t exists the
    // fields are fixed arrays and cannot be over-length. What this pins is
    // the boundary: exactly CONFIG_SSID_MAX must still round-trip.
    config_store_erase();
    device_config_t in;
    memset(&in, 0, sizeof in);
    memset(in.ssid, 'x', CONFIG_SSID_MAX);
    snprintf(in.pass, sizeof in.pass, "password");
    snprintf(in.code, sizeof in.code, "ABC123");
    CHECK(config_store_save(&in), "a max-length ssid is acceptable");
    device_config_t out;
    CHECK(config_store_load(&out), "and loads back");
    CHECK_EQ_INT((int)strlen(out.ssid), CONFIG_SSID_MAX);
}

static void test_save_refuses_while_a_disk_is_mounted(void) {
    config_store_erase();
    psram_publish_slot(0);
    device_config_t in = mk("net", "password", "ABC123");
    CHECK(!config_store_save(&in), "no flash write while a disk is streaming");
    psram_publish_slot(SLOT_NONE);
}

static void test_erase_also_erases_the_token(void) {
    // Re-pairing issues a new device row and a new token; keeping the old
    // one would leave the board authenticating as a device the server no
    // longer associates with these credentials.
    CHECK(token_store_save("tok-old"), "seed a token");
    config_store_erase();
    char buf[128];
    CHECK(!token_store_load(buf, sizeof buf), "token must be gone after config erase");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_round_trips);
    RUN(test_torn_write_reads_as_nothing_stored);
    RUN(test_crc_mismatch_is_rejected);
    RUN(test_max_length_ssid_is_accepted);
    RUN(test_save_refuses_while_a_disk_is_mounted);
    RUN(test_erase_also_erases_the_token);
    free(mem);
    return REPORT();
}
```

This needs `config_store_test_corrupt_payload_byte()` alongside the torn-write helper — add both to `config_store.h` under the same "host tests only" comment `token_store.h` uses.

- [ ] **Step 2: Run and watch every test fail**

```bash
pnpm firmware:test
```

Expected: compile failure (no `config_store.h`). Create the header with declarations only, re-run, and confirm you get link errors per test — that is the point at which each test has genuinely failed rather than never having run.

- [ ] **Step 3: Implement `config_store.c`**

Follow `token_store.c` closely — read it first. Differences:

```c
// Sector immediately below token_store's, which owns the top sector.
#define CONFIG_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE)
#define CONFIG_MAGIC 0x57464347u   // 'WFCG'
#define CONFIG_VERSION 1u
```

Record: `magic(4) · version(1) · ssid_len(1) · pass_len(1) · code_len(1) · ssid · pass · code · crc32(4)`, written as one program page.

The CRC covers everything from `version` through the last payload byte. Use a table-less bitwise CRC-32 (polynomial `0xEDB88320`) — roughly 12 lines, no table to size, and this runs once per provisioning rather than in any hot path.

Host build (`#ifdef WFMF_HOST_TEST`): a static byte array standing in for the sector, exactly as `token_store.c` does.

- [ ] **Step 4: Run — all pass**

```bash
pnpm firmware:test && pnpm firmware:build
```

- [ ] **Step 5: Prove the CRC is load-bearing**

Delete the CRC comparison in `config_store_load`, run `pnpm firmware:test`, confirm `test_crc_mismatch_is_rejected` fails by name, restore. Record the output in the report — this is the mutation proof for the one thing this store has that `token_store` does not.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/config_store.* wifi-floppy/firmware/test/test_config_store.c
git commit -m "Add config_store: CRC-protected credentials in flash"
```

---

### Task 2: `provisioning` — the state machine

**Files:**
- Create: `wifi-floppy/firmware/src/provisioning.c`, `provisioning.h`
- Create: `wifi-floppy/firmware/test/test_provisioning.c`

**Interfaces:**
- Consumes: `device_config_t`, `config_store_load/save/erase` (Task 1).
- Produces:

```c
#define PROV_MAX_ASSOC_FAILURES 3

typedef enum { PROV_PORTAL, PROV_RUNNING } prov_state_t;

typedef struct {
    prov_state_t state;
    int  assoc_failures;      // RAM ONLY. Never persisted -- a power cycle
                              // must restore patience (spec §3).
    bool have_config;
    device_config_t cfg;
} provisioning_t;

// Decide the starting state from what is stored. Does not touch the radio.
void prov_init(provisioning_t *p);
// Report the outcome of one association attempt. Returns the new state.
prov_state_t prov_on_assoc_result(provisioning_t *p, bool ok);
// The portal submitted credentials AND the association with them succeeded:
// commit and run. Returns false if the commit failed.
bool prov_on_verified_submit(provisioning_t *p, const device_config_t *cfg);
// Registration reported 400 invalid_or_used_code -- terminal (spec §3, D-4b-4).
prov_state_t prov_on_pairing_code_rejected(provisioning_t *p);
```

- [ ] **Step 1: Write the failing tests**

`test/test_provisioning.c`:

```c
#include "harness.h"
#include "../src/provisioning.h"
#include "../src/config_store.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

static device_config_t mk(const char *s) {
    device_config_t c; memset(&c, 0, sizeof c);
    snprintf(c.ssid, sizeof c.ssid, "%s", s);
    snprintf(c.pass, sizeof c.pass, "password");
    snprintf(c.code, sizeof c.code, "ABC123");
    return c;
}

static void test_no_config_starts_in_the_portal(void) {
    config_store_erase();
    provisioning_t p; prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
}

static void test_stored_config_starts_running(void) {
    config_store_erase();
    device_config_t c = mk("net");
    CHECK(config_store_save(&c), "seed config");
    provisioning_t p; prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    CHECK(strcmp(p.cfg.ssid, "net") == 0, "config is loaded, not just detected");
}

static void test_portal_opens_after_exactly_three_failures(void) {
    config_store_erase();
    device_config_t c = mk("net"); config_store_save(&c);
    provisioning_t p; prov_init(&p);
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);   // 1
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);   // 2
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_PORTAL);    // 3
}

static void test_a_success_resets_the_counter(void) {
    config_store_erase();
    device_config_t c = mk("net"); config_store_save(&c);
    provisioning_t p; prov_init(&p);
    prov_on_assoc_result(&p, false);
    prov_on_assoc_result(&p, false);
    CHECK_EQ_INT(prov_on_assoc_result(&p, true), PROV_RUNNING);
    CHECK_EQ_INT(p.assoc_failures, 0);
    // Two more failures must NOT open the portal -- the count restarted.
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);
    CHECK_EQ_INT(prov_on_assoc_result(&p, false), PROV_RUNNING);
}

static void test_verified_submit_commits_and_runs(void) {
    config_store_erase();
    provisioning_t p; prov_init(&p);
    CHECK_EQ_INT(p.state, PROV_PORTAL);
    device_config_t c = mk("new-net");
    CHECK(prov_on_verified_submit(&p, &c), "commit");
    CHECK_EQ_INT(p.state, PROV_RUNNING);
    device_config_t stored;
    CHECK(config_store_load(&stored), "credentials were persisted");
    CHECK(strcmp(stored.ssid, "new-net") == 0, "the submitted ssid");
}

static void test_rejected_pairing_code_returns_to_the_portal(void) {
    // Spec D-4b-4: the code now sits in flash and can outlive its 10-minute
    // TTL, so a 400 is terminal rather than retried forever.
    config_store_erase();
    device_config_t c = mk("net"); config_store_save(&c);
    provisioning_t p; prov_init(&p);
    CHECK_EQ_INT(prov_on_pairing_code_rejected(&p), PROV_PORTAL);
    device_config_t stored;
    CHECK(!config_store_load(&stored),
          "a rejected code must clear the stored config so a fresh one can be entered");
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(test_no_config_starts_in_the_portal);
    RUN(test_stored_config_starts_running);
    RUN(test_portal_opens_after_exactly_three_failures);
    RUN(test_a_success_resets_the_counter);
    RUN(test_verified_submit_commits_and_runs);
    RUN(test_rejected_pairing_code_returns_to_the_portal);
    free(mem);
    return REPORT();
}
```

- [ ] **Step 2: Run, watch each fail**

`test_portal_opens_after_exactly_three_failures` is the one to check carefully: against a stub returning `PROV_RUNNING` always, the first two assertions pass and only the third fails. Confirm you see exactly that, rather than assuming.

- [ ] **Step 3: Implement `provisioning.c`**

No SDK headers. `prov_on_verified_submit` calls `config_store_save`; `prov_on_pairing_code_rejected` calls `config_store_erase` (which also clears the token) and returns `PROV_PORTAL`.

- [ ] **Step 4: Run — all pass. Then mutate**

For each of the six tests, break the corresponding branch, confirm that named test fails, revert. Record the six names.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/provisioning.* wifi-floppy/firmware/test/test_provisioning.c
git commit -m "Add the provisioning state machine"
```

---

### Task 3: DNS server — answer everything with the AP address

The smallest of the three servers; it establishes the pure/glue split the next two follow.

**Files:**
- Create: `wifi-floppy/firmware/src/dns_server.c`, `dns_server.h`
- Create: `wifi-floppy/firmware/test/test_dns_server.c`

**Interfaces:**
- Produces:

```c
#define PORTAL_IP_0 192
#define PORTAL_IP_1 168
#define PORTAL_IP_2 4
#define PORTAL_IP_3 1

// Build a reply to `req`. Returns bytes written to `out`, or 0 for "do not
// reply" (malformed, not a query, or no question section). Pure: no sockets.
int dns_handle(const uint8_t *req, int len, uint8_t *out, int cap);
```

- [ ] **Step 1: Write the failing tests**

`test/test_dns_server.c`:

```c
#include "harness.h"
#include "../src/dns_server.h"
#include <string.h>

// A minimal DNS query for "captive.apple.com" type A, class IN.
static int build_query(uint8_t *b, int cap) {
    static const uint8_t q[] = {
        0x12, 0x34,             // id
        0x01, 0x00,             // flags: standard query, RD
        0x00, 0x01,             // qdcount 1
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        7, 'c','a','p','t','i','v','e',
        5, 'a','p','p','l','e',
        3, 'c','o','m',
        0,
        0x00, 0x01,             // qtype A
        0x00, 0x01,             // qclass IN
    };
    if (cap < (int)sizeof q) return 0;
    memcpy(b, q, sizeof q);
    return (int)sizeof q;
}

static void test_answers_an_a_query_with_the_portal_ip(void) {
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    int r = dns_handle(req, n, out, sizeof out);
    CHECK(r > n, "a reply carries the question plus an answer");
    CHECK_EQ_INT(out[0], 0x12); CHECK_EQ_INT(out[1], 0x34);   // id echoed
    CHECK_EQ_INT(out[2] & 0x80, 0x80);                        // QR = response
    CHECK_EQ_INT(out[7], 1);                                  // ancount 1
    // The A record's four address bytes are the last four of the reply.
    CHECK_EQ_INT(out[r - 4], PORTAL_IP_0);
    CHECK_EQ_INT(out[r - 3], PORTAL_IP_1);
    CHECK_EQ_INT(out[r - 2], PORTAL_IP_2);
    CHECK_EQ_INT(out[r - 1], PORTAL_IP_3);
}

static void test_truncated_query_is_ignored(void) {
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    CHECK_EQ_INT(dns_handle(req, 4, out, sizeof out), 0);       // header cut short
    CHECK_EQ_INT(dns_handle(req, n - 3, out, sizeof out), 0);   // question cut short
}

static void test_response_packet_is_ignored(void) {
    // Never answer something that is itself an answer -- that is how two
    // servers on one segment end up talking to each other forever.
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    req[2] |= 0x80;                                            // set QR
    CHECK_EQ_INT(dns_handle(req, n, out, sizeof out), 0);
}

static void test_no_question_section_is_ignored(void) {
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    req[4] = 0; req[5] = 0;                                    // qdcount 0
    CHECK_EQ_INT(dns_handle(req, n, out, sizeof out), 0);
}

static void test_reply_that_would_not_fit_is_refused(void) {
    uint8_t req[128], out[16];
    int n = build_query(req, sizeof req);
    CHECK_EQ_INT(dns_handle(req, n, out, sizeof out), 0);
}

int main(void) {
    RUN(test_answers_an_a_query_with_the_portal_ip);
    RUN(test_truncated_query_is_ignored);
    RUN(test_response_packet_is_ignored);
    RUN(test_no_question_section_is_ignored);
    RUN(test_reply_that_would_not_fit_is_refused);
    return REPORT();
}
```

- [ ] **Step 2: Run, watch each fail. Step 3: Implement `dns_server.c`.**

Copy the 12-byte header and the question section verbatim into the reply, set flags to `0x8180` (response, recursion available), `ancount = 1`, then append an answer: name pointer `0xC0 0x0C`, type A (`0x00 0x01`), class IN (`0x00 0x01`), TTL 60 (`0x00 0x00 0x00 0x3C`), rdlength 4, then the four address bytes. Walk the question's labels to find its length rather than assuming — a label length byte greater than the remaining input is malformed and returns 0.

- [ ] **Step 4: Run — pass. Mutate each. Commit.**

```bash
git commit -m "Add the DNS responder that makes the captive portal appear"
```

---

### Task 4: DHCP server

**Files:**
- Create: `wifi-floppy/firmware/src/dhcp_server.c`, `dhcp_server.h`
- Create: `wifi-floppy/firmware/test/test_dhcp_server.c`

**Interfaces:**
- Consumes: `PORTAL_IP_*` (Task 3).
- Produces:

```c
#define DHCP_POOL_SIZE 2        // one phone at a time, plus slack
// Build a reply to a BOOTP/DHCP request. Returns bytes written, or 0 for
// "do not reply". Pure.
int dhcp_handle(const uint8_t *req, int len, uint8_t *out, int cap);
void dhcp_reset_leases(void);   // host tests; also called when the AP starts
```

- [ ] **Step 1: Write the failing tests**

`test/test_dhcp_server.c`:

```c
#include "harness.h"
#include "../src/dhcp_server.h"
#include "../src/dns_server.h"     // PORTAL_IP_*
#include <string.h>

#define DHCP_MIN_LEN 240           // BOOTP header + magic cookie

// op=1 BOOTREQUEST, htype=1, hlen=6, one option 53 with `msg_type`.
static int build_request(uint8_t *b, int cap, uint8_t msg_type, const uint8_t mac[6]) {
    if (cap < DHCP_MIN_LEN + 6) return 0;
    memset(b, 0, cap);
    b[0] = 1; b[1] = 1; b[2] = 6;
    b[4] = 0xDE; b[5] = 0xAD; b[6] = 0xBE; b[7] = 0xEF;   // xid
    memcpy(b + 28, mac, 6);                                // chaddr
    b[236] = 0x63; b[237] = 0x82; b[238] = 0x53; b[239] = 0x63;
    b[240] = 53; b[241] = 1; b[242] = msg_type;
    b[243] = 255;                                          // end option
    return DHCP_MIN_LEN + 4;
}

static uint8_t opt(const uint8_t *p, int len, uint8_t want) {
    for (int i = DHCP_MIN_LEN; i + 1 < len; ) {
        if (p[i] == 255) break;
        if (p[i] == want) return p[i + 2];
        i += 2 + p[i + 1];
    }
    return 0;
}

static void test_discover_gets_an_offer(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1 /* DISCOVER */, mac);
    int r = dhcp_handle(req, n, out, sizeof out);
    CHECK(r > 0, "an offer is sent");
    CHECK_EQ_INT(out[0], 2);                       // BOOTREPLY
    CHECK_EQ_INT(opt(out, r, 53), 2);              // DHCPOFFER
    CHECK_EQ_INT(out[16], PORTAL_IP_0);            // yiaddr in our subnet
    CHECK_EQ_INT(out[18], PORTAL_IP_2);
    CHECK(out[19] != PORTAL_IP_3, "never offer the server's own address");
    CHECK(memcmp(out + 4, req + 4, 4) == 0, "xid is echoed");
}

static void test_request_gets_an_ack(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 3 /* REQUEST */, mac);
    int r = dhcp_handle(req, n, out, sizeof out);
    CHECK(r > 0, "an ack is sent");
    CHECK_EQ_INT(opt(out, r, 53), 5);              // DHCPACK
    CHECK_EQ_INT(opt(out, r, 54), PORTAL_IP_0);    // server id is us
}

static void test_the_same_mac_keeps_its_address(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], a[512], b[512];
    int n = build_request(req, sizeof req, 1, mac);
    int ra = dhcp_handle(req, n, a, sizeof a);
    int rb = dhcp_handle(req, n, b, sizeof b);
    CHECK(ra > 0 && rb > 0, "both answered");
    CHECK_EQ_INT(a[19], b[19]);                    // same yiaddr
}

static void test_a_bootreply_is_ignored(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1, mac);
    req[0] = 2;                                     // BOOTREPLY, not a request
    CHECK_EQ_INT(dhcp_handle(req, n, out, sizeof out), 0);
}

static void test_bad_magic_cookie_is_ignored(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1, mac);
    req[236] = 0;
    CHECK_EQ_INT(dhcp_handle(req, n, out, sizeof out), 0);
}

static void test_short_packet_is_ignored(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    build_request(req, sizeof req, 1, mac);
    CHECK_EQ_INT(dhcp_handle(req, 100, out, sizeof out), 0);
}

static void test_option_length_running_past_the_packet_is_ignored(void) {
    // A hostile or truncated option must not walk the parser off the end.
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1, mac);
    req[241] = 200;                                 // option 53 claims 200 bytes
    CHECK_EQ_INT(dhcp_handle(req, n, out, sizeof out), 0);
}

int main(void) {
    RUN(test_discover_gets_an_offer);
    RUN(test_request_gets_an_ack);
    RUN(test_the_same_mac_keeps_its_address);
    RUN(test_a_bootreply_is_ignored);
    RUN(test_bad_magic_cookie_is_ignored);
    RUN(test_short_packet_is_ignored);
    RUN(test_option_length_running_past_the_packet_is_ignored);
    return REPORT();
}
```

- [ ] **Step 2: Run, watch each fail. Step 3: Implement `dhcp_server.c`.**

Leases are a fixed `DHCP_POOL_SIZE` array of MACs, offering `192.168.4.16 + index`. Reply options: 53 (type), 1 (subnet `255.255.255.0`), 3 (router = us), 6 (DNS = us, which is what points the phone at our DNS responder), 51 (lease 1 hour), 54 (server id = us), then 255.

**The option walker must bound every step against `len` before dereferencing** — `test_option_length_running_past_the_packet_is_ignored` exists for exactly this, and an unbounded walk here is the same defect class that produced three separate integer-overflow findings in plan 4a.

- [ ] **Step 4: Run — pass. Mutate each. Commit.**

```bash
git commit -m "Add the DHCP server for the provisioning AP"
```

---

### Task 5: `portal_http` — routes, form decode, page

**Files:**
- Create: `wifi-floppy/firmware/src/portal_http.c`, `portal_http.h`
- Create: `wifi-floppy/firmware/test/test_portal_http.c`

**Interfaces:**
- Consumes: `device_config_t` (Task 1).
- Produces:

```c
typedef enum { PORTAL_ACT_NONE, PORTAL_ACT_SUBMIT } portal_action_t;

typedef struct {
    portal_action_t action;
    device_config_t submitted;   // valid only when action == PORTAL_ACT_SUBMIT
} portal_result_t;

// Render a reply for one request. `err` is shown on the form when non-NULL.
// Returns bytes written to `out`, or 0 if it would not fit.
int portal_request(const char *method, const char *path, const char *body,
                   const char *mac_str, const char *err,
                   char *out, int cap, portal_result_t *res);
```

- [ ] **Step 1: Write the failing tests**

`test/test_portal_http.c`:

```c
#include "harness.h"
#include "../src/portal_http.h"
#include <string.h>

static char out[8192];
static portal_result_t res;
#define REQ(m, p, b, e) portal_request((m), (p), (b), "AB:CD:EF:01:02:03", (e), \
                                       out, sizeof out, &res)

static void test_root_renders_the_form(void) {
    int n = REQ("GET", "/", NULL, NULL);
    CHECK(n > 0, "rendered");
    CHECK(strstr(out, "200 OK") != NULL, "200");
    CHECK(strstr(out, "name=\"ssid\"") != NULL, "ssid field");
    CHECK(strstr(out, "name=\"pass\"") != NULL, "password field");
    CHECK(strstr(out, "name=\"code\"") != NULL, "pairing code field");
    CHECK(strstr(out, "AB:CD:EF:01:02:03") != NULL,
          "the MAC is shown so you know which board you are configuring");
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

static void test_page_has_no_external_references(void) {
    // The AP has no route to the internet; anything external hangs the page.
    REQ("GET", "/", NULL, NULL);
    CHECK(strstr(out, "http://") == NULL || strstr(out, "http://192.168.4.1") != NULL,
          "no external http references");
    CHECK(strstr(out, "https://") == NULL, "no external https references");
}

static void test_unknown_path_redirects_to_the_portal(void) {
    // This catch-all is what makes iOS and Android open the sign-in sheet.
    int n = REQ("GET", "/hotspot-detect.html", NULL, NULL);
    CHECK(n > 0, "rendered");
    CHECK(strstr(out, "302") != NULL, "302 redirect");
    CHECK(strstr(out, "Location: http://192.168.4.1/") != NULL, "to the portal root");
}

static void test_android_probe_redirects_too(void) {
    REQ("GET", "/generate_204", NULL, NULL);
    CHECK(strstr(out, "302") != NULL, "a 204 here would mean 'internet works'");
}

static void test_submit_decodes_the_form(void) {
    int n = REQ("POST", "/save", "ssid=my+net&pass=p%40ssword&code=ABC123", NULL);
    CHECK(n > 0, "rendered");
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strcmp(res.submitted.ssid, "my net") == 0, "+ decodes to space");
    CHECK(strcmp(res.submitted.pass, "p@ssword") == 0, "%40 decodes to @");
    CHECK(strcmp(res.submitted.code, "ABC123") == 0, "code");
}

static void test_submit_with_missing_fields_is_not_a_submit(void) {
    REQ("POST", "/save", "ssid=only", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

static void test_oversized_field_is_rejected_not_truncated(void) {
    char body[512];
    snprintf(body, sizeof body, "ssid=");
    for (int i = 0; i < 200; i++) strcat(body, "x");
    strcat(body, "&pass=password&code=ABC123");
    REQ("POST", "/save", body, NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

static void test_error_is_shown_on_the_form(void) {
    REQ("GET", "/", NULL, "Wrong password");
    CHECK(strstr(out, "Wrong password") != NULL, "the reason is displayed");
}

static void test_password_is_never_echoed(void) {
    REQ("POST", "/save", "ssid=net&pass=secret123&code=ABC123", "Wrong password");
    CHECK(strstr(out, "secret123") == NULL,
          "a submitted password must never appear in a rendered page");
}

int main(void) {
    RUN(test_root_renders_the_form);
    RUN(test_page_has_no_external_references);
    RUN(test_unknown_path_redirects_to_the_portal);
    RUN(test_android_probe_redirects_too);
    RUN(test_submit_decodes_the_form);
    RUN(test_submit_with_missing_fields_is_not_a_submit);
    RUN(test_oversized_field_is_rejected_not_truncated);
    RUN(test_error_is_shown_on_the_form);
    RUN(test_password_is_never_echoed);
    return REPORT();
}
```

- [ ] **Step 2: Run, watch each fail. Step 3: Implement `portal_http.c`.**

Form decoding handles `+` → space and `%XX` → byte, and **rejects rather than truncates** an over-length field (a truncated SSID silently provisions the wrong network). The page is one static template with three `%s` substitutions: the MAC, the error block (empty when `err` is NULL), and nothing else. Inline `<style>`, no external URLs.

- [ ] **Step 4: Run — pass. Mutate each. Commit.**

```bash
git commit -m "Add the portal HTTP handler: form, routes, captive-portal catch-all"
```

---

### Task 6: `portal_net` — the lwIP and cyw43 glue

Device-only; no host tests. Its verification is the cross-build plus the link proof.

**Files:**
- Create: `wifi-floppy/firmware/src/portal_net.c`, `portal_net.h`
- Modify: `wifi-floppy/firmware/CMakeLists.txt`, `test/run.sh`

**Interfaces:**
- Consumes: `dhcp_handle`, `dns_handle`, `portal_request`, `device_config_t`.
- Produces:

```c
// Bring up the WPA2 AP and serve DHCP, DNS and the portal until someone
// submits credentials. Blocks. Fills `out` and returns true on submit.
bool portal_run(device_config_t *out, const char *err);
void portal_stop(void);   // tear the AP down before switching to STA mode
```

- [ ] **Step 1: Implement `portal_net.c`**

- AP up: `cyw43_arch_enable_ap_mode(ssid, PORTAL_AP_PASSWORD, CYW43_AUTH_WPA2_AES_PSK)`, where `ssid` is `wifi-floppy-XXXX` built from the last two MAC octets.
- The AP address is set in CMake, not code: `pico_configure_ip4_address(wifi_floppy PRIVATE CYW43_DEFAULT_IP_AP_ADDRESS 192.168.4.1)`.
- Two raw UDP PCBs (ports 67 and 53) whose receive callbacks pass the payload to `dhcp_handle`/`dns_handle` and send whatever comes back.
- One raw TCP listener on port 80: accumulate until the headers end, split method/path/body, call `portal_request`, write the reply, close.
- Every lwIP call goes inside `cyw43_arch_lwip_begin()`/`end()`. **Plan 4a lost a round to exactly this** — `transport_tls.c` mutated shared state and freed pbufs outside the lock while the RX callback wrote the same field, a use-after-free with silent data loss. Read `transport_tls.c`'s locking before writing this file.

- [ ] **Step 2: Exclude it from the host build**

Add `portal_net.c` to `test/run.sh`'s exclusion `grep -vE`, with a comment saying why, matching the existing entries.

- [ ] **Step 3: Add to CMake and force the link**

Add the new sources to `add_executable`, add `pico_configure_ip4_address`, add `PORTAL_AP_PASSWORD`, and extend the existing force-link line:

```cmake
target_link_options(wifi_floppy PRIVATE -Wl,-u,tls_transport -Wl,-u,sntp_sync_blocking -Wl,-u,portal_run)
```

- [ ] **Step 4: Prove the link is not vacuous**

Plan 4a's Critical was a green build in which `--gc-sections` had silently discarded the entire TLS stack, because nothing called it. Prove this one is real:

```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
rm -rf build && pnpm firmware:build
arm-none-eabi-nm build/wifi_floppy.elf | grep -E ' T (portal_run|dhcp_handle|dns_handle|portal_request)'
arm-none-eabi-nm -u build/wifi_floppy.elf | wc -l    # expect 0
```

Then temporarily remove `-Wl,-u,portal_run`, rebuild, and confirm the symbols disappear — that demonstrates the flag is what holds them in, rather than assuming it. Restore. Record both outputs in the report.

- [ ] **Step 5: Commit**

```bash
git commit -m "Add the AP-mode network glue for the provisioning portal"
```

---

### Task 7: Wire it into `main.c`

**Files:**
- Modify: `wifi-floppy/firmware/src/main.c`, `device_client.c`, `device_client.h`, `CMakeLists.txt`
- Modify: `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Produces: `dc_register_result_t { DC_REG_OK, DC_REG_RETRY, DC_REG_BAD_CODE }` replacing `dc_register`'s `bool`.

- [ ] **Step 1: Make a rejected pairing code distinguishable**

`dc_register` currently returns `bool`, so `400 invalid_or_used_code` is indistinguishable from a transient failure and is retried forever under 4a's backoff. Change it to return `dc_register_result_t`, with `DC_REG_BAD_CODE` for exactly that error body. Add a test:

```c
static void test_invalid_code_is_reported_as_bad_code_not_retry(void) {
    boot(); token_store_erase();
    push_ok_json(400, "{\"error\":\"invalid_or_used_code\"}");
    CHECK_EQ_INT(dc_register(&c, "WRONG", "4b.0", "aa:bb:cc:dd:ee:ff"), DC_REG_BAD_CODE);
}

static void test_other_400_is_still_retryable(void) {
    boot(); token_store_erase();
    push_ok_json(400, "{\"error\":\"invalid_body\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4b.0", "aa:bb:cc:dd:ee:ff"), DC_REG_RETRY);
}
```

Use the existing `push_ok_json` helper so `Content-Length` is computed, not typed.

- [ ] **Step 2: Rewrite `core1_main`'s opening**

Replace the `WIFI_SSID`/`WIFI_PASS` associate and the `WEBADF_PAIRING_CODE` register with:

```
prov_init(&prov)
loop:
  if prov.state == PROV_PORTAL:
      portal_run(&submitted, last_error)      // blocks until submit
      portal_stop()
      if associate(submitted) succeeded:
          prov_on_verified_submit(&prov, &submitted)
      else:
          last_error = reason; continue        // AP comes back with the error
  else:
      if associate(prov.cfg) failed:
          prov_on_assoc_result(&prov, false); continue
      prov_on_assoc_result(&prov, true)
      ... SNTP, token load or dc_register(prov.cfg.code) ...
      if register returned DC_REG_BAD_CODE:
          prov_on_pairing_code_rejected(&prov); continue
      ... 4a's RUNNING loop, unchanged ...
```

`last_error` comes from the cyw43 return code, and **spec §6 requires distinguishing *wrong
password* from *SSID not found*** — they call for different corrections, and a portal that
says only "failed" makes the user retype a password that was already right. Map the cyw43
status to one of those two messages plus a generic fallback.

Bump `FIRMWARE_VERSION` to `"4b.0"`, and drop `WIFI_SSID`, `WIFI_PASS` and `WEBADF_PAIRING_CODE` from `CMakeLists.txt`.

- [ ] **Step 3: Re-measure core 1's stack**

4a sized it at 16 KB against a measured ~5.3 KB worst case dominated by the TLS handshake. This task adds three servers to that core. The AP phase and the TLS phase never overlap, so the peak is probably unchanged — but "probably" is what produced 4a's silent heap corruption.

Measure the new worst-case chain on the built ELF (`arm-none-eabi-objdump -d`, or `-fstack-usage`), covering both the portal path and the TLS path, and **state the new margin in the report**. If the portal path exceeds the TLS path, raise `CORE1_STACK_BYTES` and say so. `PICO_USE_STACK_GUARDS` is already on, so a wrong number faults rather than corrupts — but the number should still be right.

- [ ] **Step 4: Everything green, then commit**

```bash
pnpm firmware:test && pnpm firmware:build && pnpm vitest run
git commit -m "Wire the provisioning portal into core 1's boot flow"
```

---

### Task 8: Reconcile the docs

**Files:**
- Modify: `HANDOFF.md`, `wifi-floppy/README.md`, `docs/superpowers/specs/2026-08-30-device-provisioning-portal-design.md`

- [ ] **Step 1: Mark 4b delivered** in its spec — what shipped, and that the captive-portal probe behaviour remains unverified without hardware.

- [ ] **Step 2: Update `HANDOFF.md`** — 4b done; plan 5 (hardware bring-up) is the only remaining piece. Replace the compile-time-credentials description with the portal flow, including the AP SSID pattern and that `PORTAL_AP_PASSWORD` is a build-time value. Note that `WEBADF_HOST` is still compile-time and deliberately so.

- [ ] **Step 3: Update `wifi-floppy/README.md`** — how to provision a board: join `wifi-floppy-XXXX`, enter SSID, password and a pairing code minted in webadf. Keep the "never run on hardware" caveat accurate.

- [ ] **Step 4: Commit**

```bash
git commit -m "Record plan 4b as delivered"
```

---

## Done when

- `pnpm firmware:test` green, including the five new test binaries.
- `pnpm firmware:build` clean; `pnpm vitest run` green.
- The force-link flag was observed to be load-bearing (symbols vanish without it).
- Core 1's stack was re-measured with the new margin stated.
- Every test named in Tasks 1-5 and 7 was observed to fail before it passed.
- `WIFI_SSID`, `WIFI_PASS` and `WEBADF_PAIRING_CODE` no longer appear in `CMakeLists.txt`.
