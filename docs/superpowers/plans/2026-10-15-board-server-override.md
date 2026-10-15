# Board Server Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hoster points their board at their own web app by typing `wf server ...` commands into the board's USB serial console; with nothing set, the board behaves exactly as today.

**Architecture:** A new flash record (`override_store`) holds host, port and TLS mode. core0's main loop reads USB-serial lines through a pure, host-tested parser (`serial_cmd`) and applies changes there (flash writes already happen in that loop). At boot the override, or the compiled-in default, decides the host, port, `Host:` header and TLS verification for every request; a weakened mode (`noverify`) shows on the OLED and, through the status report, on the device card.

**Tech Stack:** C11 firmware (pico-sdk 2.3.0, lwIP altcp_tls + mbedTLS), host tests via `wifi-floppy/firmware/test/run.sh`; Next.js server (Drizzle on Neon, vitest, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-15-board-server-override-design.md`

## Global Constraints

- No override stored => `webadf.vercel.app:443`, TLS verified against `src/roots.h` with the host name checked -- byte-for-byte today's behaviour (spec §1).
- Set only over the USB serial port; never from the setup portal, the server or NFC (D1).
- Always TLS. TLS modes are `verify` (default) and `noverify` (any certificate, self-signed included, no host-name check). `http://` is refused (D3, operator 2026-10-15).
- Changing the server (`set` to a different host/port, or `clear`) forgets the pairing: `config_store_erase()` (Wi-Fi credentials, pairing code and token) and a reboot into the setup portal, like a new board (D4; operator 2026-10-15: "repairing when you switch urls").
- `noverify` is never silent: OLED status word `INSECURE`, a log line at boot and on every new TLS connection, and the status report's `server` key -> the card (D5).
- Firmware updates are still verified against the compiled-in signing key (D6) -- nothing in this plan touches `fw_*`.
- Commands refuse to write flash while either drive holds a disk ("eject the disk first"), like `config_store_save`.
- Firmware version for this feature: **1.13.0** (`FIRMWARE_SEMVER` in `wifi-floppy/firmware/CMakeLists.txt`).
- Log lines fit 87 characters (`WF_LOG_MSG` is 88 with the NUL).
- Repo rules: e2e only the touched specs, `PORT=3100`, serialized, each run under 9 minutes; no `git stash`/`checkout`/`reset` in shared trees; never `git add -A`; commits end with the session's two attribution lines.

## Review Focus

1. A 63-character host with port 65535: every request (poll, status, image, firmware, register) still fits its buffer whole -- Task 3 adds the worst-case test.
2. `wf server set` with a disk in DF0 or DF1: refused with "eject the disk first", flash untouched -- Task 4's apply function returns the refusal; Task 2's parser test pins the message text.
3. A line typed slowly, with backspaces, CRLF, or longer than the line buffer: assembled correctly or refused whole, never executed truncated -- Task 2 line-assembler tests.
4. `wf server tls noverify` followed by anything other than `YES`: nothing changes -- Task 2 confirm tests.
5. A stored record that is torn or has a corrupt CRC: boot falls back to the default server, never a half-read host -- Task 1 store tests.

---

### Task 1: The override record (`override_store`)

**Files:**
- Create: `wifi-floppy/firmware/src/override_store.h`, `wifi-floppy/firmware/src/override_store.c`
- Create: `wifi-floppy/firmware/test/test_override_store.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt:70` (add `src/override_store.c` to the source list)

**Interfaces:**
- Produces:
  - `#define OVERRIDE_HOST_MAX 63`
  - `typedef enum { OVR_TLS_VERIFY = 0, OVR_TLS_NOVERIFY = 1 } ovr_tls_t;`
  - `typedef struct { char host[OVERRIDE_HOST_MAX + 1]; uint16_t port; uint8_t tls; } server_override_t;`
  - `bool override_store_load(server_override_t *out);` -- false: nothing valid (erased, bad magic, bad CRC, bad field)
  - `bool override_store_save(const server_override_t *o);` -- false: invalid fields or a flash error (no mounted-disk check here; the caller checks)
  - `void override_store_erase(void);`
  - `void server_effective(bool loaded, const server_override_t *o, const char *default_host, server_override_t *out);`
  - `bool server_is_custom(const server_override_t *eff, const char *default_host);`
  - `void server_host_header(const server_override_t *s, char *out, size_t cap);` -- `"host"` at port 443, else `"host:port"`

- [ ] **Step 1: Write the failing tests** -- `test/test_override_store.c` (uses `harness.h` like `test/test_drive_store.c`):

```c
#include "harness.h"
#include "override_store.h"
#include <string.h>

static server_override_t mk(const char *host, uint16_t port, uint8_t tls) {
    server_override_t o; memset(&o, 0, sizeof o);
    snprintf(o.host, sizeof o.host, "%s", host); o.port = port; o.tls = tls; return o;
}

static void round_trip_and_erase(void) {
    override_store_erase();
    server_override_t got;
    CHECK(!override_store_load(&got), "erased: nothing");
    server_override_t o = mk("my.host.example", 8443, OVR_TLS_NOVERIFY);
    CHECK(override_store_save(&o), "saved");
    CHECK(override_store_load(&got), "loaded");
    CHECK(strcmp(got.host, "my.host.example") == 0, "host");
    CHECK_EQ_INT(got.port, 8443);
    CHECK_EQ_INT(got.tls, OVR_TLS_NOVERIFY);
    override_store_erase();
    CHECK(!override_store_load(&got), "erased again");
}

static void invalid_fields_are_refused(void) {
    char longhost[80]; memset(longhost, 'a', 64); longhost[64] = '\0';
    server_override_t o; memset(&o, 0, sizeof o);
    memcpy(o.host, longhost, sizeof o.host);          // no NUL inside the array
    CHECK(!override_store_save(&o), "no terminator: refused");
    o = mk("", 443, OVR_TLS_VERIFY);
    CHECK(!override_store_save(&o), "empty host: refused");
    o = mk("h", 0, OVR_TLS_VERIFY);
    CHECK(!override_store_save(&o), "port 0: refused");
    o = mk("h", 443, 2);
    CHECK(!override_store_save(&o), "unknown tls mode: refused");
    o = mk("bad host", 443, OVR_TLS_VERIFY);
    CHECK(!override_store_save(&o), "a space in the host: refused");
}

static void a_corrupt_record_reads_as_nothing(void) {
    server_override_t o = mk("my.host", 443, OVR_TLS_VERIFY), got;
    CHECK(override_store_save(&o), "saved");
    override_store_test_corrupt_payload_byte();
    CHECK(!override_store_load(&got), "CRC catches a damaged payload");
    CHECK(override_store_save(&o), "saved");
    override_store_test_corrupt_magic();
    CHECK(!override_store_load(&got), "magic");
    override_store_erase();
}

static void the_effective_server(void) {
    server_override_t eff, o = mk("my.host", 8443, OVR_TLS_NOVERIFY);
    server_effective(false, NULL, "webadf.vercel.app", &eff);
    CHECK(strcmp(eff.host, "webadf.vercel.app") == 0 && eff.port == 443 && eff.tls == OVR_TLS_VERIFY, "default");
    CHECK(!server_is_custom(&eff, "webadf.vercel.app"), "default is not custom");
    server_effective(true, &o, "webadf.vercel.app", &eff);
    CHECK(strcmp(eff.host, "my.host") == 0 && eff.port == 8443 && eff.tls == OVR_TLS_NOVERIFY, "override");
    CHECK(server_is_custom(&eff, "webadf.vercel.app"), "custom");
    char hdr[OVERRIDE_HOST_MAX + 7];
    server_host_header(&eff, hdr, sizeof hdr);
    CHECK(strcmp(hdr, "my.host:8443") == 0, "Host header carries a non-default port");
    eff.port = 443;
    server_host_header(&eff, hdr, sizeof hdr);
    CHECK(strcmp(hdr, "my.host") == 0, "...and not 443");
}

int main(void) {
    RUN(round_trip_and_erase);
    RUN(invalid_fields_are_refused);
    RUN(a_corrupt_record_reads_as_nothing);
    RUN(the_effective_server);
    return REPORT();
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_override_store|COMPILE FAIL"`
Expected: `COMPILE FAIL: test_override_store.c` (header missing).

- [ ] **Step 3: Implement** -- copy `config_store.c`'s structure exactly (two backings, `WFMF_HOST_TEST` buffer vs one flash sector, magic + version + CRC-32 over version..payload, NOTRANSLATE read, `flash_safe_execute`). Differences:
  - Magic `0x52565357u` ('WSVR'), version 1. Layout: `magic(4) version(1) host_len(1) port_lo(1) port_hi(1) tls(1) host[host_len] crc32(4)`.
  - Sector: `#define OVERRIDE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 6 * FLASH_SECTOR_SIZE)` and extend the top-of-flash map comment in `drive_store.c:108-111` to six sectors.
  - Validation (both save and load): `1 <= host_len <= 63`; host characters only `[A-Za-z0-9.-]` (an IPv4 literal passes); `port >= 1`; `tls <= OVR_TLS_NOVERIFY`.
  - No `disk_is_mounted` check inside the store (the core0 caller checks; spec Global Constraints).
  - Test hooks `override_store_test_corrupt_payload_byte()` and `override_store_test_corrupt_magic()` as in `config_store.h`.
  - Pure helpers (both builds):

```c
void server_effective(bool loaded, const server_override_t *o, const char *default_host, server_override_t *out) {
    memset(out, 0, sizeof *out);
    if (loaded && o) { *out = *o; return; }
    snprintf(out->host, sizeof out->host, "%s", default_host);
    out->port = 443;
    out->tls = OVR_TLS_VERIFY;
}

bool server_is_custom(const server_override_t *eff, const char *default_host) {
    return strcmp(eff->host, default_host) != 0 || eff->port != 443 || eff->tls != OVR_TLS_VERIFY;
}

void server_host_header(const server_override_t *s, char *out, size_t cap) {
    if (s->port == 443) snprintf(out, cap, "%s", s->host);
    else snprintf(out, cap, "%s:%u", s->host, (unsigned)s->port);
}
```

- [ ] **Step 4: Run tests** -- `bash wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_override_store|COMPILE"` -> `test_override_store.c: N checks, 0 failed`, no COMPILE FAIL anywhere.

- [ ] **Step 5: Commit** -- `git add wifi-floppy/firmware/src/override_store.[ch] wifi-floppy/firmware/test/test_override_store.c wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/src/drive_store.c` ; message `fw: override_store -- the server override record (host, port, TLS mode) in its own flash sector`.

---

### Task 2: The serial command parser (`serial_cmd`)

**Files:**
- Create: `wifi-floppy/firmware/src/serial_cmd.h`, `wifi-floppy/firmware/src/serial_cmd.c`
- Create: `wifi-floppy/firmware/test/test_serial_cmd.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt:70` (add `src/serial_cmd.c`)

**Interfaces:**
- Consumes: `server_override_t`, `ovr_tls_t`, `OVERRIDE_HOST_MAX` (Task 1).
- Produces:

```c
#define SC_LINE_MAX 128
typedef enum { SC_NONE = 0, SC_SHOW, SC_SET, SC_TLS, SC_CLEAR, SC_REBOOT, SC_ASK, SC_ERROR } sc_kind_t;
typedef struct {
    sc_kind_t kind;
    char host[OVERRIDE_HOST_MAX + 1];   // SC_SET
    uint16_t port;                      // SC_SET
    uint8_t tls;                        // SC_TLS (ovr_tls_t)
    const char *text;                   // SC_ASK: the question; SC_ERROR: why (static strings)
} sc_cmd_t;
typedef struct {
    char line[SC_LINE_MAX + 1]; uint16_t len; bool overflow;
    bool pending;                       // a noverify waiting for YES
} sc_state_t;
void sc_init(sc_state_t *s);
// One character from the console. True when a whole line is ready in *out (the action to take).
bool sc_feed_char(sc_state_t *s, int ch, sc_cmd_t *out);
// One whole line (the same rules; sc_feed_char calls it). Lines not starting "wf " are SC_NONE (ignored).
void sc_feed_line(sc_state_t *s, const char *line, sc_cmd_t *out);
```

Exact command grammar (one space between words; leading/trailing spaces trimmed; case-sensitive):
- `wf server show` -> `SC_SHOW`
- `wf server set https://HOST[:PORT][/]` -> `SC_SET` with host/port (443 default). `http://...` -> `SC_ERROR` text `"plain http is not supported -- use https://"`. Any other scheme, an empty host, a host over 63 characters or with characters outside `[A-Za-z0-9.-]`, a path other than `/`, or a port outside 1..65535 -> `SC_ERROR` text `"usage: wf server set https://host[:port]"`.
- `wf server tls verify` -> `SC_TLS` tls=`OVR_TLS_VERIFY`
- `wf server tls noverify` -> `SC_ASK` text `"noverify accepts ANY certificate for this server -- type YES to confirm"`, sets `pending`; the next line `YES` -> `SC_TLS` tls=`OVR_TLS_NOVERIFY`; any other next line -> `SC_ERROR` text `"not confirmed -- nothing changed"` and clears `pending`.
- `wf server clear` -> `SC_CLEAR`
- `wf reboot` -> `SC_REBOOT`
- any other line starting `wf ` -> `SC_ERROR` text `"unknown command -- wf server show|set|tls|clear, wf reboot"`
- line assembly: `\r` and `\n` end a line (CRLF yields one line; an empty line is ignored); `0x08`/`0x7f` delete the last character; a line longer than `SC_LINE_MAX` is discarded whole when it ends, as `SC_ERROR` text `"line too long -- ignored"`.

- [ ] **Step 1: Write the failing tests** -- `test/test_serial_cmd.c`:

```c
#include "harness.h"
#include "serial_cmd.h"
#include "override_store.h"
#include <string.h>

static sc_cmd_t line(sc_state_t *s, const char *l) { sc_cmd_t c; sc_feed_line(s, l, &c); return c; }

static void show_set_clear_reboot(void) {
    sc_state_t s; sc_init(&s);
    CHECK_EQ_INT(line(&s, "wf server show").kind, SC_SHOW);
    sc_cmd_t c = line(&s, "wf server set https://my.host.example:8443/");
    CHECK_EQ_INT(c.kind, SC_SET);
    CHECK(strcmp(c.host, "my.host.example") == 0, "host");
    CHECK_EQ_INT(c.port, 8443);
    c = line(&s, "  wf server set https://10.0.0.5  ");
    CHECK_EQ_INT(c.kind, SC_SET); CHECK_EQ_INT(c.port, 443);
    CHECK_EQ_INT(line(&s, "wf server clear").kind, SC_CLEAR);
    CHECK_EQ_INT(line(&s, "wf reboot").kind, SC_REBOOT);
    CHECK_EQ_INT(line(&s, "hello").kind, SC_NONE);
    CHECK_EQ_INT(line(&s, "fwdbg x").kind, SC_NONE);
}

static void bad_urls_are_refused(void) {
    sc_state_t s; sc_init(&s);
    sc_cmd_t c = line(&s, "wf server set http://my.host");
    CHECK_EQ_INT(c.kind, SC_ERROR);
    CHECK(strcmp(c.text, "plain http is not supported -- use https://") == 0, "http refused in words");
    const char *bad[] = { "wf server set my.host", "wf server set https://", "wf server set https://a b",
                          "wf server set https://h:0", "wf server set https://h:65536", "wf server set https://h/x",
                          "wf server set ftp://h", "wf server set https://h:12ab" };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        c = line(&s, bad[i]);
        CHECK(c.kind == SC_ERROR && strcmp(c.text, "usage: wf server set https://host[:port]") == 0, bad[i]);
    }
    char longhost[100] = "wf server set https://";
    memset(longhost + strlen(longhost), 'a', 64); longhost[22 + 64] = '\0';
    CHECK_EQ_INT(line(&s, longhost).kind, SC_ERROR);
    CHECK(strcmp(line(&s, "wf server bogus").text, "unknown command -- wf server show|set|tls|clear, wf reboot") == 0, "unknown");
}

static void noverify_needs_yes(void) {
    sc_state_t s; sc_init(&s);
    sc_cmd_t c = line(&s, "wf server tls noverify");
    CHECK_EQ_INT(c.kind, SC_ASK);
    c = line(&s, "yes");
    CHECK(c.kind == SC_ERROR && strcmp(c.text, "not confirmed -- nothing changed") == 0, "lowercase is not YES");
    CHECK_EQ_INT(line(&s, "YES").kind, SC_NONE);                 // nothing pending any more: ignored
    CHECK_EQ_INT(line(&s, "wf server tls noverify").kind, SC_ASK);
    c = line(&s, "YES");
    CHECK(c.kind == SC_TLS && c.tls == OVR_TLS_NOVERIFY, "confirmed");
    c = line(&s, "wf server tls verify");
    CHECK(c.kind == SC_TLS && c.tls == OVR_TLS_VERIFY, "verify needs no confirmation");
}

static void line_assembly(void) {
    sc_state_t s; sc_init(&s);
    sc_cmd_t c; const char *in = "wf rebooX\x08t\r\n";
    int got = 0;
    for (const char *p = in; *p; p++) if (sc_feed_char(&s, (unsigned char)*p, &c)) { got++; CHECK_EQ_INT(c.kind, SC_REBOOT); }
    CHECK_EQ_INT(got, 1);                                         // CRLF is one line, backspace edits
    for (int i = 0; i < SC_LINE_MAX + 10; i++) CHECK(!sc_feed_char(&s, 'x', &c), "no line yet");
    CHECK(sc_feed_char(&s, '\n', &c), "the long line ends");
    CHECK(c.kind == SC_ERROR && strcmp(c.text, "line too long -- ignored") == 0, "discarded whole");
    const char *ok = "wf server show\n";
    got = 0;
    for (const char *p = ok; *p; p++) if (sc_feed_char(&s, (unsigned char)*p, &c)) { got++; CHECK_EQ_INT(c.kind, SC_SHOW); }
    CHECK_EQ_INT(got, 1);                                         // the next line is clean
}

int main(void) {
    RUN(show_set_clear_reboot);
    RUN(bad_urls_are_refused);
    RUN(noverify_needs_yes);
    RUN(line_assembly);
    return REPORT();
}
```

- [ ] **Step 2: Run to verify it fails** -- `bash wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_serial_cmd|COMPILE FAIL"` -> COMPILE FAIL.
- [ ] **Step 3: Implement `serial_cmd.c`** to the grammar above. Pure C, no SDK includes; every `text` is a string literal. A pending confirmation is answered by the very next non-empty line, whatever it is.
- [ ] **Step 4: Run tests** -> `test_serial_cmd.c: N checks, 0 failed`.
- [ ] **Step 5: Commit** -- `fw: serial_cmd -- the wf server/wf reboot console grammar, pure and host-tested`.

---

### Task 3: The client talks to the chosen server (port, `Host:`, buffers, status `server` key)

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h` (fields, `dc_set_server`, `dc_set_server_report`), `wifi-floppy/firmware/src/device_client.c` (`connect` port at `:389`, every `http_build_*` call uses the Host header, `DC_REQ_BUF_BYTES`, the status body)
- Modify: `wifi-floppy/firmware/CMakeLists.txt:259` -> `set(FIRMWARE_SEMVER "1.13.0")`
- Test: `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Produces:
  - `void dc_set_server(device_client_t *c, int port, const char *host_header);` -- after `dc_init`; `dc_init` defaults `port` = 443 and `host_header` = `host`. `host_header` must outlive the client (main.c passes a static buffer).
  - `void dc_set_server_report(device_client_t *c, bool custom, bool noverify);` -- after `dc_init`; makes every status report carry `,"server":{"custom":<bool>,"tls":"verify"|"noverify"}`. Before it is called (a test client) the key is omitted.
- Rules: `c->t->connect(c->t, c->host, c->port)`; every request's `Host:` argument is `c->host_header` (DNS, SNI and the certificate name use `c->host`, the transport's job). `DC_REQ_BUF_BYTES` 352 -> 416, with the comment extended: "a 63-character override host and `:65535` add up to 52 over the default host: 338 + 52 = 390 (1.13.0)". Check every other request buffer that carries `Host:` (`DC_POST_HEAD_BYTES`, `DC_STATUS_REQ_BYTES`, the register and firmware requests) against the same +52 and raise any that would not fit, each with its arithmetic in a comment. The status body grows by at most 43 bytes (`,"server":{"custom":false,"tls":"noverify"}`): 1471 + 43 = 1514 <= 1536 (`DC_STATUS_BODY_BYTES`), update the budget note in `device_client.h`.

- [ ] **Step 1: Write the failing tests** in `test/test_device_client.c` (add RUN lines in `main`):

```c
static void a_custom_server_uses_its_port_and_host_header(void) {
    boot();
    dc_set_server(&c, 8443, "my.host:8443");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "\r\nHost: my.host:8443\r\n") != NULL, "Host carries the port");
    CHECK_EQ_INT(fake_last_connect_port(), 8443);
}

static void the_longest_host_and_port_fit_every_request(void) {
    static char host[64], hdr[72];
    memset(host, 'h', 63); host[63] = '\0';
    snprintf(hdr, sizeof hdr, "%s:65535", host);
    boot_with_host(host);                         // dc_init with this host, as boot() does with its own
    dc_set_server(&c, 65535, hdr);
    c.since = 4294967295u; c.nfc_ack = 4294967295u; c.display_ack = 4294967295u;
    dc_set_df1(&c, DF1_MODE_OFF, false);
    c.drive_ack = 4294967295u; c.df1_ack = 4294967295u;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "&df1Ack=4294967295&netPick=1 HTTP/1.1\r\n") != NULL, "the poll path whole");
    CHECK(strstr(fake_last_request(), hdr) != NULL, "and the Host header");
    dc_set_server_report(&c, true, true);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.13.0");
    CHECK(strstr(fake_last_request(), ",\"server\":{\"custom\":true,\"tls\":\"noverify\"}") != NULL, "status server key");
}

static void status_names_the_server_both_ways(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.13.0");
    CHECK(strstr(fake_last_request(), "\"server\"") == NULL, "not set up: no key");
    dc_set_server_report(&c, false, false);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.13.0");
    CHECK(strstr(fake_last_request(), ",\"server\":{\"custom\":false,\"tls\":\"verify\"}") != NULL, "the default, said");
}
```

`fake_last_connect_port()` and `boot_with_host()` do not exist yet: add `int fake_last_connect_port(void)` to `test/transport_fake.[ch]` (record the `port` argument of the fake `connect`), and `boot_with_host(const char *host)` next to `boot()` in the test file (same body, `dc_init(&c, ..., host, TOKEN)`). Also extend the existing maximal-status-body test (the one printing "status body at maximum") with `dc_set_server_report(&c, true, true)` so the printed maximum includes the new key.

- [ ] **Step 2: Run to verify they fail** -- `bash wifi-floppy/firmware/test/run.sh 2>&1 | grep -E "test_device_client|COMPILE FAIL"` -> COMPILE FAIL (`dc_set_server` undeclared).
- [ ] **Step 3: Implement** the interfaces and rules above. The status key goes after the existing DF1/drive tails, emitted only when `dc_set_server_report` has been called.
- [ ] **Step 4: Run all host tests** -> 0 failed; the printed "status body at maximum" stays under 1536.
- [ ] **Step 5: Commit** -- `fw 1.13.0: the client uses the chosen server's port and Host header; status reports the server`.

---

### Task 4: Boot, console, TLS and OLED wiring

**Files:**
- Modify: `wifi-floppy/firmware/src/transport_tls.c` (+ its header `transport_tls.h` or wherever `tls_transport()` is declared): `void tls_set_noverify(bool on);`
- Modify: `wifi-floppy/firmware/src/display.h`, `src/display.c`: `display_state_t.insecure`; exported `const char *disp_status_word(disp_status_t s, bool insecure);`
- Modify: `wifi-floppy/firmware/src/main.c`: boot load, `dc_init`/`dc_set_server`/`dc_set_server_report` at all three `WEBADF_HOST` sites (`:1997`, `:2068`, `:2123`), the core0 console reader beside `wf_log_drain(4)` (`:4880`), the OLED snapshot (`ui_snapshot`, `:312`)
- Test: `wifi-floppy/firmware/test/test_display.c`

**Interfaces:**
- Consumes: Task 1 (`override_store_*`, `server_effective`, `server_is_custom`, `server_host_header`), Task 2 (`sc_*`), Task 3 (`dc_set_server`, `dc_set_server_report`).

- [ ] **Step 1: Write the failing display test** (append to `test/test_display.c`, add RUN):

```c
static void the_status_word_says_insecure_when_idle(void) {
    CHECK(strcmp(disp_status_word(DS_READY, false), "READY") == 0, "ready");
    CHECK(strcmp(disp_status_word(DS_READY, true), "INSECURE") == 0, "insecure replaces READY");
    CHECK(strcmp(disp_status_word(DS_LOADED, true), "INSECURE") == 0, "and LOADED");
    CHECK(strcmp(disp_status_word(DS_DOWNLOAD, true), "DOWNLOAD") == 0, "transient states unchanged");
    CHECK(strcmp(disp_status_word(DS_ERROR, true), "ERROR") == 0, "an error is never hidden");
}
```

- [ ] **Step 2: Run** -> COMPILE FAIL. **Step 3:** rename `status_word` to the exported `disp_status_word(s, insecure)` (READY/LOADED -> "INSECURE" when `insecure`), call it at `display.c:398` with `s->insecure`; add `bool insecure;` to `display_state_t`. The display goldens must stay byte-identical (insecure defaults false). Run -> pass.

- [ ] **Step 4: TLS `noverify`** in `transport_tls.c`: a file-static `bool s_noverify` set by `tls_set_noverify`. In connect, right after the successful `mbedtls_ssl_set_hostname(ssl, host)` (`:457`), when `s_noverify`:

```c
// noverify (wf server tls noverify, spec D3): ANY certificate, self-signed included, and no host-name check. The
// build's ALTCP_MBEDTLS_AUTHMODE stays REQUIRED (tls_guard.h); this clears the verification flags per connection.
// (mbedtls_ssl_set_hs_authmode cannot do it: it is honoured only with MBEDTLS_SSL_SRV_C, which this client lacks.)
static int accept_any(void *ctx, mbedtls_x509_crt *crt, int depth, uint32_t *flags) {
    (void)ctx; (void)crt; (void)depth;
    *flags = 0;
    return 0;
}
...
    if (s_noverify) {
        mbedtls_ssl_set_verify(ssl, accept_any, NULL);
        wf_logf(WF_WARN, "tls: certificate NOT checked for %s (wf server tls noverify)", host);
    }
```

- [ ] **Step 5: Boot wiring (`main.c`, core0 before core1 starts):**

```c
static server_override_t g_server;           // the server this boot talks to (spec §2)
static char g_server_hdr[OVERRIDE_HOST_MAX + 7];
...
    server_override_t stored;
    const bool have_override = override_store_load(&stored);
    server_effective(have_override, &stored, WEBADF_HOST, &g_server);
    server_host_header(&g_server, g_server_hdr, sizeof g_server_hdr);
    tls_set_noverify(g_server.tls == OVR_TLS_NOVERIFY);
    if (server_is_custom(&g_server, WEBADF_HOST))
        wf_logf(g_server.tls == OVR_TLS_NOVERIFY ? WF_WARN : WF_INFO, "server: custom %s tls=%s%s", g_server_hdr,
                g_server.tls == OVR_TLS_NOVERIFY ? "noverify" : "verify",
                g_server.tls == OVR_TLS_NOVERIFY ? " -- INSECURE" : "");
    else wf_logf(WF_INFO, "server: default %s", WEBADF_HOST);
```

  At the three `WEBADF_HOST` sites use `g_server.host`, and after each `dc_init` call `dc_set_server(&x, g_server.port, g_server_hdr)`; after the poll client's `dc_init` also `dc_set_server_report(&c, server_is_custom(&g_server, WEBADF_HOST), g_server.tls == OVR_TLS_NOVERIFY)`. In `ui_snapshot` set `s->insecure = g_server.tls == OVR_TLS_NOVERIFY;`.

- [ ] **Step 6: The console (core0 loop, just before `wf_log_drain(4)`):** compiled only when `WF_FW_DEBUG` is off (the debug build's `fwdbg` reader on core1 owns stdin; say so in a comment). Drain `getchar_timeout_us(0)` into `sc_feed_char`; act on each returned command:
  - `SC_SHOW`: `wf_logf(WF_INFO, "server: %s %s tls=%s", custom ? "custom" : "default", g_server_hdr, tls)` -- the one-line `server:` answer of spec §3.
  - `SC_ASK` / `SC_ERROR`: log the `text` (`WF_WARN` for errors) prefixed `server: `.
  - `SC_SET`, `SC_CLEAR`, `SC_TLS`: first refuse while a disk is in either drive (`disk_mounted || psram_active_slot() != SLOT_NONE || df1_mounted`) with `server: eject the disk first -- nothing changed`. Then:
    - `SC_TLS` with no custom server stored -> `server: set a server first (wf server set https://...)`; else save the stored record with the new `tls`, log `server: tls=<mode> stored -- applies at the next boot (wf reboot)`.
    - `SC_SET`: if host and port equal the current effective server, log `server: unchanged`; else save `{host, port, OVR_TLS_VERIFY}`, `config_store_erase()`, log `server: now <hdr> -- pairing forgotten, rebooting into setup`, then `fw_rom_request_reboot(0)`.
    - `SC_CLEAR`: if no override is stored, log `server: already the default`; else `override_store_erase()`, `config_store_erase()`, log `server: back to the default -- pairing forgotten, rebooting into setup`, then `fw_rom_request_reboot(0)`.
  - `SC_REBOOT`: log `server: rebooting` and `fw_rom_request_reboot(0)`.
  - A failed flash write logs `server: storing failed -- nothing changed` and does not erase the pairing.

- [ ] **Step 7: Build and test** -- `bash wifi-floppy/firmware/test/run.sh` (0 failed) and the release build (`cmake -S wifi-floppy/firmware -B wifi-floppy/firmware/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DPICO_SDK_PATH=$HOME/pico-sdk -DWF_BUS_SNIFF=OFF -DWF_DRIVE_ID=ON -DWF_FW_DEBUG=OFF -DWF_PNET_LOOP=ON -DWF_VERIFY_TRACKS=OFF && ninja -C wifi-floppy/firmware/build`) with no warnings.
- [ ] **Step 8: Commit** -- `fw 1.13.0: boot reads the server override; wf server console on core0; noverify TLS; INSECURE on the OLED`.

---

### Task 5: Server: store and show the board's server

**Files:**
- Create: `drizzle/0038_device_server.sql` (+ the drizzle journal/snapshot entry the repo's migration workflow generates; mirror `0037_df1_pick.sql`'s additive `ADD COLUMN IF NOT EXISTS` style)
- Modify: `src/db/schema/devices.ts` (`serverCustom: boolean('server_custom')`, `serverTls: text('server_tls')`), `src/app/api/device/status/route.ts` (schema + pass-through), `src/lib/mount.ts` (`recordStatus` patch), `src/lib/queries.ts` (`DeviceListItem` + select), `src/components/devices/device-card.tsx` (the line)
- Test: `src/app/api/device/status/route.test.ts`, `e2e/devices-page.spec.ts`

**Interfaces:**
- Status body (fw 1.13.0+): `server: {custom: boolean, tls: 'verify' | 'noverify'}`; dropped, never rejected, when malformed (the route's telemetry rule): `z.object({ custom: z.boolean(), tls: z.enum(['verify', 'noverify']) }).optional().catch(undefined)`.
- `recordStatus`: when present, `patch.serverCustom = s.server.custom; patch.serverTls = s.server.tls`; absent leaves both columns as they are (an older board never sends it; both stay null).
- Card (below the firmware line): only when `serverCustom === true` -- `<span data-testid={`device-server-${device.id}`}>` reading `Custom server` for `verify`, `Custom server · certificate not checked` for `noverify` (the latter in the warning colour the card already uses). Nothing for the default or for a board that never reported.

- [ ] **Step 1: Failing vitest** (route.test.ts): a body with `server: {custom: true, tls: 'noverify'}` reaches `recordStatus` with that object; `server: {custom: 'yes'}` is dropped (recordStatus gets `server: undefined`) while `mountedSha256` is still recorded; `tls: 'off'` is dropped.
- [ ] **Step 2:** run `npx vitest run src/app/api/device/status/route.test.ts` -> FAIL.
- [ ] **Step 3:** migration + schema + route + recordStatus + queries + card. Apply the migration to the live DB the way 0037 was applied (the repo's `pnpm db:migrate` or equivalent; check `package.json`).
- [ ] **Step 4:** vitest passes; `npx tsc --noEmit -p .` and eslint on the touched files clean.
- [ ] **Step 5: e2e** (append to `e2e/devices-page.spec.ts`): pair a device (helpers in `e2e/device-helpers.ts`), POST a status with `firmwareVersion: '1.13.0+gabc1234', server: {custom: true, tls: 'noverify'}` -> `device-server-<id>` reads `Custom server · certificate not checked`; then `{custom: true, tls: 'verify'}` -> `Custom server`; then `{custom: false, tls: 'verify'}` -> the element is absent. Run: `PORT=3100 npx playwright test e2e/devices-page.spec.ts --workers=1`.
- [ ] **Step 6: Commit** -- `Device card: a board on a custom server says so, and whether its certificate is checked`.

---

### Task 6: Words: help, README, spec, HANDOFF

**Files:**
- Modify: `src/lib/help/topics.tsx` (the `boards` topic: a short "Your own server" paragraph naming `wf server set https://host[:port]`, `wf server tls noverify` (self-signed), `wf server clear`, that a change means setting the board up again, and that the card says "Custom server"), `wifi-floppy/README.md` (a "Pointing the board at your own server" section with the full command list from spec §3 and how to open the serial console), `docs/superpowers/specs/2026-10-15-board-server-override-design.md` (D4: the setup portal asks for Wi-Fi and a pairing code again -- `config_store_erase` clears both; D7: `set`/`clear` reboot at once, `tls` applies at the next boot), `HANDOFF.md` (a new §3bn: what shipped, the bench steps of spec §7).
- Test: `e2e/help.spec.ts` if it asserts the boards topic's text (run it).

- [ ] **Step 1:** write the texts. **Step 2:** `PORT=3100 npx playwright test e2e/help.spec.ts --workers=1` passes. **Step 3:** commit -- `Docs: the server override in help, README, spec and HANDOFF`.
