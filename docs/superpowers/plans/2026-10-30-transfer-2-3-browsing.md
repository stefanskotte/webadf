# Transfer 2.3: browsing the Amiga's volumes (protocol 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer 2.3 answers the board's `VOLS`, `DIR` and `GET` requests (protocol 3), read-only and only when its
owner switched browsing on, so the web app's NET: pane can list the Amiga's volumes and drawers and copy files from them.

**Architecture:** Every decision lives in the portable core (`tools/receive/core/rx_proto.c`), host-tested with an
in-memory file system: the protocol 3 hello (`READY 3 <b>`), request parsing and refusals, one request at a time behind
any file moving, a drawer listed line by line only while the 1 KB output buffer has room (memory stays flat; 1000
entries then `cut`), and `GET` as a protocol 2 upload put at the front of the up-queue after `GOT <rid> <tag>`. The
Amiga glue (`amiga/afs.c`) adds the dos.library calls (DOS list, `Lock`/`Examine`/`ExNext`, `Info`, `Fault`) with DOS
requesters silenced; the window gains a checkbox, the Shell a `BROWSE/S` switch, both stored in
`ENVARC:webadf/Browse`. The POSIX build and the fake board play it end to end; FS-UAE runs it on Kickstart 2.04, 3.1
and 3.2.

**Tech Stack:** C (core: C99 host build with `cc -Wall -Wextra -Werror`; Amiga: amiga-gcc 6.5 in the pinned image,
`-m68000 -Os -noixemul -Wall -Werror`, Kickstart 2.04+), TypeScript (fake board, scenarios, vitest), FS-UAE, xdftool.

**Spec:** `docs/superpowers/specs/2026-10-30-net-volumes-design.md` §2 (Transfer 2.3), with §6 step 2 and §7 for
context. The server side (§4, §5) is already live (master 69afa0b) and fixes the line formats this plan must produce:
`src/lib/remote-wire.ts` `parseAnswerLine` is the reader. Background: protocol 1
`docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` §2, protocol 2
`docs/superpowers/specs/2026-10-18-amiga-to-web-upload-design.md` §3.

## Global Constraints

- **Kickstart 2.04 floor, any 68000, no FPU.** Libraries: dos, exec, intuition, graphics, gadtools, asl, workbench,
  bsdsocket only (as today). The Amiga build is `tools/receive/build.sh` (amiga-gcc image pinned by digest,
  `-Wall -Werror`); it must compile with no warning.
- **The core stays portable:** no stdio, no Amiga headers in `core/`; host tests build it with
  `cc -std=c99 -O1 -g -Wall -Wextra -Werror` (`tools/receive/test/run.sh`, `pnpm receive:test`).
- **Protocols 1 and 2 are unchanged.** Every existing host test (`test_proto.c`, `test_names.c`, `test_crc.c`), the
  POSIX integration tests (`pnpm vitest run tools/receive/receive.int.test.ts`) and the FS-UAE modes keep passing
  unedited, except where a task says otherwise.
- **Line formats, verbatim (spec §2.1-§2.2; the server's `parseAnswerLine` rejects anything else and fails the
  whole answer):**
  - hello answer: `READY 3 1` (browsing on) or `READY 3 0`;
  - `VOL <rid> <len>:<name> <len>:<device> <size> <free> <days>.<mins>.<ticks>`;
  - `ENT <rid> <d|f> <size> <prot hex> <days>.<mins>.<ticks> <len>:<name> <len>:<comment>`;
  - `DONE <rid> <count>`, or `DONE <rid> 1000 cut`;
  - `GOT <rid> <tag>`;
  - `ERR <rid> <code> <len>:<text>` (`-` as the rid when none could be read);
  - codes: `off`, `notfound`, `notdir`, `isdir`, `busy`, `toolarge`, `denied`, `bad`, `io`.
- **Fixed English texts** (the rest of the texts are AmigaDOS's own, from `Fault()`):
  - `browsing is off in Transfer` (off);
  - `bad request` (bad);
  - `another request is waiting` (busy);
  - `too many files waiting` (busy);
  - `file too large (4 MB at most)` (toolarge);
  - `cannot read the volume list` (io);
  - `cannot read the file` (io);
  - `cannot send that name` (io).
- **Limits:**
  - `RX_ENT_MAX` 1000 entries;
  - `RX_VOLS_MAX` 32 volumes;
  - `RX_FILE_MAX` 4,194,304 B per GET;
  - one request answered and at most one waiting;
  - rids of 1-40 characters of `[A-Za-z0-9_-]`.
- **The switch:**
  - the file `ENVARC:webadf/Browse` holds `1` or `0` and is copied to `ENV:webadf/Browse`; no file means off;
  - the window's checkbox reads "Let the web app browse my disks (read-only)";
  - the Shell template is `TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S`;
  - `$VER: Transfer 2.3`.
- **Read-only:** browsing writes nothing anywhere; locks are shared (`SHARED_LOCK`/`MODE_OLDFILE`) and released before
  the answer ends.
- **The build pin** (`tools/receive/receive.sha256`, `tools/receive/dist/Transfer`) and the driver disk pin
  (`tools/paulanet-disk/paulanet-disk.sha256`, `PAULANET_DISK_SHA256`) change only in Task 6.
- **FS-UAE:**
  - one run at a time, since every run listens on the Mac's port 6800;
  - `uae-test.sh` stops only the PID it started — never pattern-kill;
  - ROMs and Workbench disks live in the main checkout and `~/Downloads` and are never committed.
- **No production side effects from a task:** storing the new driver disk in the disk store and pushing master are the
  controller's (see "At merge").
- **Git:**
  - never `git add -A`, never `git stash`;
  - stage the files by name;
  - no attribution trailers in commit messages.
- **Worktree setup:**
  - a real `pnpm install --offline` (a symlinked node_modules crashes the tools);
  - `.env.local` is not needed: nothing here touches the database.

## Review Focus

1. **A disk taken out of a drive while it is listed or copied.** The Amiga must not show a "Please insert volume"
   requester (it would freeze Transfer until someone clicks), and the answer must end with `ERR <rid> io <Fault text>`.
   - Host test: Task 2 `a_drawer_that_fails_mid_listing_ends_with_err_and_lets_go`.
   - Code: every browsing hook in `afs.c` runs between `quiet_on()`/`quiet_off()` (Task 5).
2. **The board reconnecting mid-answer.** The drawer's lock must be released, and a GET's file not yet gone up must
   never go up later, because the board would land it in "From the Amiga" unasked.
   - Tasks 2 and 3: `a_lost_connection_mid_listing_releases_the_drawer`,
     `a_dropped_connection_forgets_get_files_not_yet_gone_up`.
3. **Latin-1 names** (`Café`, `Grüße`) in a drawer and a volume name must go out byte for byte, with byte-count length
   prefixes.
   - Task 2: `latin1_names_go_out_byte_for_byte`.
4. **A PING, or a refusal, arriving during a long listing** must still find room in the 1 KB buffer, and nothing may be
   dropped (`put()` silently drops a line that does not fit).
   - Task 2: `a_long_drawer_is_paced_and_nothing_is_lost` (a PING mid-listing).
   - Task 1: `a_second_request_while_one_waits_is_busy`.
5. **Browsing switched off while a listing is answered.** The listing finishes; only then does Transfer close so the
   board hears `READY 3 0`.
   - Task 1: `a_changed_switch_makes_the_hello_stale_once_idle`.

## Plan rulings (decisions the spec left open; each is recorded in HANDOFF in Task 6)

- **T1 — The switch changed while a board is connected.** The spec has no line to re-announce the flag, and the server
  learns it only from `READY 3`. So once the connection is idle, Transfer closes it: no file moving, no request, nothing
  waiting to be sent (`rx_hello_stale`). The board reconnects within seconds and hears the new flag. A TRUST that
  changes the key does the same.
- **T2 — Names the web app would refuse are left out** of VOLS and DIR answers, and not counted. That means names with
  a byte below 0x20, 0x7F or 0x80-0x9F, with `:` or `/`, `.`/`..`, blank names, or names over 30 bytes, and device
  names outside `[A-Za-z0-9_.-]{1,30}:`. One such line would fail the whole answer on the server
  (`remote-requests.ts` BAD).
- **T3 — How DOS errors become codes.**

  | DOS error | Code |
  |---|---|
  | 204, 205 (not found) | `notfound` |
  | 202 (in use) | `busy` |
  | 224 (read-protected) | `denied` |
  | 212 (wrong type) | `notdir` for DIR, `isdir` for GET |
  | anything else, including 226 "no disk" and 218 "not mounted" | `io` |

  `io` carries AmigaDOS's own words, which say more than "Object not found" would.
- **T4 — A GET's file still waiting to go up when the connection drops leaves the queue.** After a reconnect the board
  no longer knows its tag, so the file would land in "From the Amiga" unasked. The server fails the request after its
  10-minute wait.
- **T5 — Requests go before the owner's queued uploads.** An upload never starts while a listing is answered. A
  request still waits for a file that is already moving.
- **T6 — A second request while one already waits** gets `ERR <rid> busy 26:another request is waiting`.
- **T7 — A GET whose file name cannot go up** gets `ERR <rid> io`; `rx_path_ok` refuses such a name, for example one
  with control bytes.
- **T8 — DOS requesters are silenced** (`pr_WindowPtr = -1`) during every browsing call, and during every file read
  for an upload, the owner's own included. A disk taken out mid-send now fails the file instead of asking for the disk.
- **T9 — The checkbox stores its state at once,** in ENV: and ENVARC:. `BROWSE` switches browsing on for one run, and
  `BROWSE SAVE` also stores it. `SAVE` without `BROWSE` leaves the stored switch as it is; the window switches it off.
- **T10 — The driver disk is rebuilt and re-pinned now, in Task 6, not in spec §6 step 5.**
  - Why: the self-host image (`docker/Dockerfile`) builds the disk from `tools/receive/dist/Transfer` and fails on a
    pin mismatch.
  - Shipping 2.3 early is inert: browsing is off by default, and protocol 2 is unchanged.
  - Boards switch to the new disk only once their Amiga is off (`driverDiskFor`).
- **T11 — A volume whose device cannot be named is left out,** for example when no device entry shares its handler.
  RAM Disk's size is 0 (unknown), and its free space is free memory less 64 KB, as the folder check already counts it.

## Files

| File | Change |
|---|---|
| `tools/receive/core/rx_proto.h` | protocol 3 types, hooks, constants, session fields, prototypes (Tasks 1-3) |
| `tools/receive/core/rx_proto.c` | hello 3, requests, VOLS, DIR, GET, ordering, words (Tasks 1-3) |
| `tools/receive/core/rx_names.h`, `rx_names.c` | `rx_name_sendable`, `rx_device_sendable` (Task 1) |
| `tools/receive/test/fakefs.h` | the in-memory volumes, drawers, stat and fault (Task 1) |
| `tools/receive/test/test_browse.c` | new: the protocol 3 host tests (Tasks 1-3) |
| `tools/receive/test/test_names.c` | the two name checks (Task 1) |
| `tools/receive/posix/rx_posix.c` | volumes from `RX_VOLS`, `BROWSE` on stdin, REQ lines (Task 1 initializer, Task 4) |
| `tools/receive/fake-board.ts`, `scenarios.ts`, `run-scenarios.ts`, `receive.int.test.ts` | protocol 3 board and scenarios (Task 4) |
| `tools/receive/amiga/afs.h`, `afs.c` | dos.library browsing hooks (Task 5) |
| `tools/receive/amiga/config.h`, `config.c` | `webadf/Browse` (Task 5) |
| `tools/receive/amiga/net.c` | close on a stale hello (Task 5) |
| `tools/receive/amiga/main.c`, `ui.h`, `shell.c`, `gui.c` | BROWSE/S, checkbox, status lines, version 2.3 (Task 5) |
| `tools/receive/uae/uae-test.sh`, `uae/browse-demo.ts` | browse mode, three drives (Task 6) |
| `tools/receive/README.md`, `tools/paulanet-disk/ReadMe` | the switch and the commands (Task 6) |
| `tools/receive/receive.sha256`, `tools/receive/dist/Transfer` | the new pinned build (Task 6) |
| `tools/paulanet-disk/paulanet-disk.sha256`, `src/lib/paulanet-disk.ts`, `src/lib/paulanet-disk.test.ts` | the new driver disk (Task 6) |
| `HANDOFF.md` | §4-net-volumes: Transfer 2.3 (Task 6) |

---

### Task 1: The protocol 3 hello, the switch, refusals and VOLS (core)

**Files:**
- Modify: `tools/receive/core/rx_proto.h`, `tools/receive/core/rx_proto.c`, `tools/receive/core/rx_names.h`,
  `tools/receive/core/rx_names.c`, `tools/receive/test/fakefs.h`, `tools/receive/test/test_names.c`,
  `tools/receive/posix/rx_posix.c` (initializer only)
- Create: `tools/receive/test/test_browse.c`

**Interfaces:**
- Consumes: protocol 2's core as it is (`rx_session`, `rx_upq`, `emit_full`, `puts_`, `put_dec`, `put_lenstr`,
  `tok`, `lenstr`, `id_ok`, `put_due`, `rx_take_output`, `rx_want_output`, `rx_disconnected`).
- Produces (later tasks rely on these names exactly):
  - Types and hooks: `rx_vol`, `rx_dent`, and the `rx_fs` hooks `vols`, `dir_open`, `dir_next`, `dir_close`, `stat`,
    `fault` (signatures below).
  - Constants and enums: `RX_EV_REQ`, `RX_REQ_NONE/VOLS/DIR/GET`, `RX_DOS_*`, `RX_VOLS_MAX`, `RX_NAME_RAW`,
    `RX_ENT_MAX`, `RX_REQ_LINE`, `RX_REQ_ROOM`; `rx_upq.browse`.
  - Functions: `int rx_browse_on(const rx_session *)`, `int rx_hello_stale(const rx_session *)`,
    `int rx_name_sendable(const char *)`, `int rx_device_sendable(const char *)`.
  - Static helpers in rx_proto.c for Tasks 2-3: `req_err`, `emit_req`, `req_end`, `req_fail_text`, `req_done`,
    `put_date`, `clean`, `req_start`, `req_pump`, `on_request`.
  - In `fakefs.h`: fields `vols`, `nvols`, `vols_fail`, `dir_path`, `dir_pos`, `dir_given`, `dir_open`, `dir_opens`,
    `dir_closes`, `dir_fail_after`, `synth`, `synth_n`, `stat_err`, `stat_size`, `stat_calls`.

- [ ] **Step 1: Write the failing name tests**

In `tools/receive/test/test_names.c`, add before `int main`:

```c
static void sendable_names(void) {
    char n31[32];
    CHECK(rx_name_sendable("Work"), "plain");
    CHECK(rx_name_sendable("RAM Disk"), "a space inside");
    CHECK(rx_name_sendable("Caf\xe9"), "latin-1");
    CHECK(rx_name_sendable(".info"), "a leading dot");
    CHECK(rx_name_sendable("123456789012345678901234567890"), "30 bytes");
    memset(n31, 'a', 31); n31[31] = 0;
    CHECK(!rx_name_sendable(n31), "31 bytes");
    CHECK(!rx_name_sendable(""), "empty");
    CHECK(!rx_name_sendable("   "), "only spaces");
    CHECK(!rx_name_sendable("\xa0\xa0"), "only no-break spaces (JavaScript's trim takes them too)");
    CHECK(!rx_name_sendable("."), "dot");
    CHECK(!rx_name_sendable(".."), "dot dot");
    CHECK(!rx_name_sendable("a:b"), "colon");
    CHECK(!rx_name_sendable("a/b"), "slash");
    CHECK(!rx_name_sendable("a\x01"), "control byte");
    CHECK(!rx_name_sendable("a\x7f"), "DEL");
    CHECK(!rx_name_sendable("a\x85"), "C1 byte");
}
static void sendable_devices(void) {
    CHECK(rx_device_sendable("DF0:"), "DF0:");
    CHECK(rx_device_sendable("RAM:"), "RAM:");
    CHECK(rx_device_sendable("my.dev-1_:"), "dots, dashes, underscores");
    CHECK(rx_device_sendable("123456789012345678901234567890:"), "30 and a colon");
    CHECK(!rx_device_sendable("1234567890123456789012345678901:"), "31 and a colon");
    CHECK(!rx_device_sendable("DF0"), "no colon");
    CHECK(!rx_device_sendable(":"), "only a colon");
    CHECK(!rx_device_sendable("D F0:"), "a space");
    CHECK(!rx_device_sendable("DF0:x"), "after the colon");
}
```

Add `RUN(sendable_names); RUN(sendable_devices);` to its `main`.

- [ ] **Step 2: Write the failing protocol tests**

Create `tools/receive/test/test_browse.c`:

```c
/* Protocol 3 (spec docs/superpowers/specs/2026-10-30-net-volumes-design.md §2): the web app browses the Amiga. */
#include <stdio.h>
#include <stdlib.h>
#include "harness.h"
#include "rx_crc.h"
#include "fakefs.h"

#define KEY "0123456789abcdef0123456789abcdef"
#define KEY2 "fedcba9876543210fedcba9876543210"
static fakefs F; static rx_fs FS; static rx_session S; static rx_upq Q;
static rx_event ev[64]; static int n_ev;
static char ev_path[64][300], ev_text[64][100], ev_code[64][20], ev_id[64][48]; static int ev_has_text[64];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    if (n_ev >= 64) return;
    ev[n_ev] = *e;
    snprintf(ev_path[n_ev], 300, "%s", e->path ? e->path : "");
    snprintf(ev_text[n_ev], 100, "%s", e->text ? e->text : "");
    ev_has_text[n_ev] = e->text != NULL;
    snprintf(ev_code[n_ev], 20, "%s", e->code ? e->code : "");
    snprintf(ev_id[n_ev], 48, "%s", e->id ? e->id : "");
    ev[n_ev].path = NULL; ev[n_ev].text = NULL; ev[n_ev].code = NULL; ev[n_ev].id = NULL; ev[n_ev].key = NULL;
    n_ev++;
}
static int last_req(void) { int i; for (i = n_ev - 1; i >= 0; i--) if (ev[i].kind == RX_EV_REQ) return i; return -1; }
static void setup(int browse) {
    ff_init(&F, &FS); n_ev = 0;
    rx_upq_init(&Q, KEY); Q.browse = browse;
    rx_init(&S, &FS, on_ev, NULL); rx_attach(&S, &Q);
}
static int feed(const char *str) { return rx_feed(&S, (const unsigned char *)str, strlen(str)); }
/* What Transfer has to say now, taken as the net loop takes it: pass after pass while rx_want_output says so. */
static char ob[400000]; static unsigned ob_n; static int passes, max_take;
static void drain(void) {
    static char b[RX_UP_BLOCK + 1];
    ob_n = 0; ob[0] = 0; passes = 0; max_take = 0;
    while (rx_want_output(&S) && passes < 100000) {
        int k = rx_take_output(&S, b, sizeof b - 1);
        passes++;
        if (k < 0) break;
        if (k > max_take) max_take = k;
        memcpy(ob + ob_n, b, (size_t)k); ob_n += (unsigned)k; ob[ob_n] = 0;
    }
}
static void hello3(void) { feed("WEBADF 3 " KEY "\n"); }
static int lines_starting(const char *prefix) {
    int n = 0; const char *p = ob; size_t k = strlen(prefix);
    while (*p) { if (strncmp(p, prefix, k) == 0) n++; p = strchr(p, '\n'); if (!p) break; p++; }
    return n;
}
static void vol(const char *name, const char *dev, unsigned long size, unsigned long fr, unsigned long d) {
    rx_vol *v = &F.vols[F.nvols++];
    memset(v, 0, sizeof *v);
    snprintf(v->name, sizeof v->name, "%s", name); snprintf(v->device, sizeof v->device, "%s", dev);
    v->size = size; v->free = fr; v->days = d; v->mins = d + 1; v->ticks = d + 2;
}

static void a_protocol_3_hello_answers_ready_3_with_the_switch(void) {
    setup(0); hello3(); drain(); CHECK(strcmp(ob, "READY 3 0\n") == 0, ob);
    CHECK_EQ_INT(ev[0].kind, RX_EV_HELLO); CHECK_EQ_INT(ev[1].kind, RX_EV_TRUST); CHECK(strcmp(ev_code[1], "ok") == 0, ev_code[1]);
    setup(1); hello3(); drain(); CHECK(strcmp(ob, "READY 3 1\n") == 0, ob);
    setup(1); feed("WEBADF 7 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 3 1\n") == 0, "a newer board is answered as 3");
    setup(1); feed("WEBADF 2 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 2\n") == 0, "protocol 2 unchanged");
    setup(1); feed("WEBADF 1\n"); drain(); CHECK(strcmp(ob, "READY 1\n") == 0, "protocol 1 unchanged");
}
static void another_boards_key_hears_browsing_off(void) {
    setup(1); feed("WEBADF 3 " KEY2 "\n"); drain();
    CHECK(strcmp(ob, "READY 3 0\n") == 0, ob);
    feed("VOLS r1\n"); drain();
    CHECK(strcmp(ob, "ERR r1 off 27:browsing is off in Transfer\n") == 0, ob);
}
static void requests_while_off_are_refused_off(void) {
    setup(0); vol("Work", "DH0:", 1, 1, 1); hello3(); drain();
    feed("VOLS r1\n"); drain();
    CHECK(strcmp(ob, "ERR r1 off 27:browsing is off in Transfer\n") == 0, ob);
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_code[i], "vols") == 0 && strcmp(ev_text[i], "browsing is off in Transfer") == 0, "the owner sees it"); }
}
static void malformed_requests_are_bad(void) {
    setup(1); hello3(); drain();
    feed("VOLS\n"); drain(); CHECK(strcmp(ob, "ERR - bad 11:bad request\n") == 0, ob);
    feed("VOLS r1 extra\n"); drain(); CHECK(strcmp(ob, "ERR r1 bad 11:bad request\n") == 0, ob);
    feed("VOLS aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"); drain(); CHECK(strcmp(ob, "ERR - bad 11:bad request\n") == 0, "a 41-byte id");
    feed("VOLS r.1\n"); drain(); CHECK(strcmp(ob, "ERR - bad 11:bad request\n") == 0, "a dot in the id");
}
static void volumes_are_listed_by_plain_name_duplicates_included(void) {
    setup(1);
    vol("Work", "DH0:", 104857600, 43000000, 1); vol("Empty", "DF0:", 901120, 0, 4); vol("Empty", "DF2:", 901120, 0, 4);
    vol("RAM Disk", "RAM:", 0, 1000, 7);
    hello3(); drain(); feed("VOLS v1\n"); drain();
    CHECK(strcmp(ob, "VOL v1 4:Work 4:DH0: 104857600 43000000 1.2.3\n"
                     "VOL v1 5:Empty 4:DF0: 901120 0 4.5.6\n"
                     "VOL v1 5:Empty 4:DF2: 901120 0 4.5.6\n"
                     "VOL v1 8:RAM Disk 4:RAM: 0 1000 7.8.9\n"
                     "DONE v1 4\n") == 0, ob);
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_code[i], "vols") == 0 && !ev_has_text[i] && ev[i].size == 4, "the owner sees it"); }
    CHECK(!rx_want_output(&S), "nothing more to say");
}
static void volumes_the_web_app_cannot_name_are_left_out(void) {
    setup(1);
    vol("Bad\x01", "DF0:", 1, 1, 1); vol("1234567890123456789012345678901", "DF1:", 1, 1, 1);
    vol("Good", "DH0:", 1, 1, 1); vol("Spaced", "D H1:", 1, 1, 1); vol("NoDevice", "", 1, 1, 1);
    hello3(); drain(); feed("VOLS v2\n"); drain();
    CHECK(strcmp(ob, "VOL v2 4:Good 4:DH0: 1 1 1.2.3\nDONE v2 1\n") == 0, ob);
}
static void a_failed_volume_list_is_io(void) {
    setup(1); F.vols_fail = 1; hello3(); drain();
    feed("VOLS v3\n"); drain();
    CHECK(strcmp(ob, "ERR v3 io 27:cannot read the volume list\n") == 0, ob);
}
static void many_volumes_are_paced_by_the_buffer(void) {
    int i; char dev[8];
    setup(1);
    for (i = 0; i < RX_VOLS_MAX; i++) { sprintf(dev, "DH%d:", i); vol("abcdefghijklmnopqrstuvwxyz0123", dev, 4000000000UL, 3000000000UL, 99999); }
    hello3(); drain();
    feed("VOLS aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"); drain();
    CHECK_EQ_INT(lines_starting("VOL "), RX_VOLS_MAX);
    CHECK(strstr(ob, "DONE aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 32\n") != NULL, "DONE 32");
    CHECK(max_take <= RX_OUT_MAX, "never more than the 1 KB buffer at once");
    CHECK(passes >= 4, "several passes");
}
static void a_second_request_while_one_waits_is_busy(void) {
    setup(1); vol("Work", "DH0:", 1, 1, 1);
    ff_put(&F, "DH0:One", "1", 1, 0, ""); CHECK_EQ_INT(rx_up_add(&Q, "DH0:One", "One"), 1);
    hello3(); drain(); CHECK(strncmp(ob, "READY 3 1\nPUT 1 1 ", 18) == 0, ob);   /* One is going up */
    feed("VOLS a\nVOLS b\n"); drain();
    CHECK(strcmp(ob, "ERR b busy 26:another request is waiting\n") == 0, ob);
    feed("TAKE 1 0 1\n"); drain();                   /* the byte, then END */
    CHECK(strstr(ob, "VOL a") == NULL, "a waits while the file is going up");
    feed("DONE 1 3:One\n"); drain();
    CHECK(strcmp(ob, "VOL a 4:Work 4:DH0: 1 1 1.2.3\nDONE a 1\n") == 0, ob);
}
static void a_changed_switch_makes_the_hello_stale_once_idle(void) {
    setup(1); vol("Work", "DH0:", 1, 1, 1); hello3(); drain();
    CHECK(!rx_hello_stale(&S), "as said");
    Q.browse = 0; CHECK(rx_hello_stale(&S), "switched off: close, so the board hears READY 3 0");
    Q.browse = 1; CHECK(!rx_hello_stale(&S), "switched back");
    feed("VOLS v\n"); Q.browse = 0;
    CHECK(!rx_hello_stale(&S), "not while a request waits");
    drain(); CHECK(strcmp(ob, "VOL v 4:Work 4:DH0: 1 1 1.2.3\nDONE v 1\n") == 0, "the accepted request is answered");
    CHECK(rx_hello_stale(&S), "then stale");
    setup(1); feed("WEBADF 2 " KEY "\n"); drain(); Q.browse = 0; CHECK(!rx_hello_stale(&S), "never on protocol 2");
    setup(1); feed("WEBADF 3 " KEY2 "\n"); drain(); CHECK(!rx_hello_stale(&S), "another key: READY 3 0 was right");
    CHECK_EQ_INT(rx_trust_now(&S), 0); CHECK(rx_hello_stale(&S), "trusted now: the board must hear READY 3 1");
}
static void a_lost_connection_forgets_the_request(void) {
    setup(1); vol("Work", "DH0:", 1, 1, 1); hello3(); drain();
    feed("VOLS v\n");
    rx_disconnected(&S);
    CHECK(!rx_want_output(&S), "nothing left to answer");
    rx_init(&S, &FS, on_ev, NULL); rx_attach(&S, &Q); hello3(); drain();
    CHECK(strcmp(ob, "READY 3 1\n") == 0, "a fresh connection starts clean");
}

int main(void) {
    RUN(a_protocol_3_hello_answers_ready_3_with_the_switch); RUN(another_boards_key_hears_browsing_off);
    RUN(requests_while_off_are_refused_off); RUN(malformed_requests_are_bad);
    RUN(volumes_are_listed_by_plain_name_duplicates_included); RUN(volumes_the_web_app_cannot_name_are_left_out);
    RUN(a_failed_volume_list_is_io); RUN(many_volumes_are_paced_by_the_buffer);
    RUN(a_second_request_while_one_waits_is_busy); RUN(a_changed_switch_makes_the_hello_stale_once_idle);
    RUN(a_lost_connection_forgets_the_request);
    return REPORT();
}
```

- [ ] **Step 3: Extend the fake file system**

In `tools/receive/test/fakefs.h`, add these fields at the end of the `fakefs` struct (before `} fakefs;`):

```c
    /* protocol 3: the volumes, the drawer being listed, and a made-up drawer of synth_n files f0000.. (FF_MAX is far
       below the 1000-entry cut) */
    rx_vol vols[RX_VOLS_MAX]; int nvols, vols_fail;
    char dir_path[RX_LOCAL_MAX + 1]; int dir_pos, dir_given, dir_open, dir_opens, dir_closes; long dir_fail_after; /* -1 never */
    char synth[RX_LOCAL_MAX + 1]; int synth_n;
    long stat_err; unsigned long stat_size; int stat_calls;   /* stat_err: every stat fails so; stat_size: reported instead */
```

Add these functions before `ff_init`:

```c
static int ff_vols(void *c, rx_vol *out, int max) {
    fakefs *f = c; int i;
    if (f->vols_fail) return -1;
    for (i = 0; i < f->nvols && i < max; i++) out[i] = f->vols[i];
    return i;
}
/* nm's last part when nm is a child of the drawer dir ("Work:" holds "Work:x"; "Work:D" holds "Work:D/x"), else NULL. */
static const char *ff_child_of(const char *nm, const char *dir) {
    size_t n = strlen(dir); int root = n > 0 && dir[n - 1] == ':'; const char *rest;
    if (strncmp(nm, dir, n) != 0 || !nm[n]) return NULL;
    rest = root ? nm + n : (nm[n] == '/' ? nm + n + 1 : NULL);
    return rest && rest[0] && !strchr(rest, '/') ? rest : NULL;
}
static long ff_dir_open(void *c, const char *path) {
    fakefs *f = c;
    if (!(f->synth_n && strcmp(path, f->synth) == 0)) {
        int i = ff_find(f, path);
        if (i < 0) return RX_DOS_NOT_FOUND;
        if (!f->e[i].is_dir) return RX_DOS_WRONG_TYPE;
    }
    snprintf(f->dir_path, sizeof f->dir_path, "%s", path);
    f->dir_pos = 0; f->dir_given = 0; f->dir_open = 1; f->dir_opens++;
    return 0;
}
static long ff_dir_next(void *c, rx_dent *e) {
    fakefs *f = c;
    if (f->dir_fail_after >= 0 && f->dir_given == f->dir_fail_after) return -RX_DOS_NO_DISK;
    memset(e, 0, sizeof *e);
    if (f->synth_n && strcmp(f->dir_path, f->synth) == 0) {
        if (f->dir_pos >= f->synth_n) return 0;
        sprintf(e->name, "f%04d", f->dir_pos); e->size = (unsigned long)f->dir_pos;
        f->dir_pos++; f->dir_given++;
        return 1;
    }
    while (f->dir_pos < f->n) {
        ff_entry *x = &f->e[f->dir_pos++];
        const char *rest = ff_child_of(x->name, f->dir_path);
        if (!rest) continue;
        snprintf(e->name, sizeof e->name, "%s", rest);
        e->is_dir = x->is_dir; e->size = x->is_dir ? 0 : x->len; e->prot = x->prot;
        snprintf(e->comment, sizeof e->comment, "%s", x->comment);
        e->days = f->days; e->mins = f->mins; e->ticks = f->ticks;
        f->dir_given++;
        return 1;
    }
    return 0;
}
static void ff_dir_close(void *c) { fakefs *f = c; f->dir_open = 0; f->dir_closes++; }
static long ff_stat(void *c, const char *path, rx_finfo *info, int *is_dir) {
    fakefs *f = c; int i;
    f->stat_calls++;
    if (f->stat_err) return f->stat_err;
    i = ff_find(f, path);
    if (i < 0) return RX_DOS_NOT_FOUND;
    *is_dir = f->e[i].is_dir;
    info->size = f->stat_size ? f->stat_size : f->e[i].len; info->prot = f->e[i].prot;
    info->days = f->days; info->mins = f->mins; info->ticks = f->ticks;
    snprintf(info->comment, sizeof info->comment, "%s", f->e[i].comment);
    return 0;
}
static void ff_fault(void *c, long err, char *text, unsigned cap) { (void)c; snprintf(text, cap, "dos error %ld", err); }
```

In `ff_init`, after `f->read_idx = -1; f->fail_read_at = -1;` add `f->dir_fail_after = -1;`, and after the
`fs->close_r = ff_close_r;` assignment add:

```c
    fs->vols = ff_vols; fs->dir_open = ff_dir_open; fs->dir_next = ff_dir_next; fs->dir_close = ff_dir_close;
    fs->stat = ff_stat; fs->fault = ff_fault;
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm receive:test`
Expected: the build of `test_names` and `test_browse` fails (`rx_name_sendable`, `rx_vol`, `RX_EV_REQ` undeclared).

- [ ] **Step 5: The names**

In `tools/receive/core/rx_names.h`, before `#endif`:

```c
/* 1 if the web app takes name as a NET: name (src/lib/files/path.ts amigaNameProblem): 1..30 bytes, no byte < 0x20,
   0x7f or 0x80-0x9f, no ':' or '/', not "." or "..", not only spaces (0x20 or 0xa0). Plan ruling T2. */
int rx_name_sendable(const char *name);
/* 1 if dev is a device name the web app takes: 1..30 bytes of [A-Za-z0-9_.-], then ':' (remote-wire.ts DEVICE). */
int rx_device_sendable(const char *dev);
```

In `tools/receive/core/rx_names.c`, append:

```c
int rx_name_sendable(const char *name) {
    size_t n = strlen(name), i;
    int blank = 1;
    if (n == 0 || n > RX_PART_MAX || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return 0;
    for (i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)name[i];
        if (ch < 0x20 || ch == 0x7f || (ch >= 0x80 && ch < 0xa0) || ch == ':' || ch == '/') return 0;
        if (ch != ' ' && ch != 0xa0) blank = 0;
    }
    return !blank;
}
int rx_device_sendable(const char *dev) {
    size_t n = strlen(dev), i;
    if (n < 2 || n > RX_PART_MAX + 1 || dev[n - 1] != ':') return 0;
    for (i = 0; i + 1 < n; i++) {
        char ch = dev[i];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '.' || ch == '-'))
            return 0;
    }
    return 1;
}
```

(`rx_names.c` already includes `<string.h>`; check, and add it if not.)

- [ ] **Step 6: The header**

In `tools/receive/core/rx_proto.h`:

After the `#define RX_TREE_DEPTH 16 ...` line add:

```c
/* Protocol 3 (spec 2026-10-30 §2): the web app browses the Amiga's volumes, read-only. */
#define RX_VOLS_MAX 32           /* volumes in one VOLS answer; more are left out */
#define RX_NAME_RAW 108          /* a name as AmigaDOS gives it (fib_FileName); only names of 30 bytes or less are sent */
#define RX_ENT_MAX 1000          /* a DIR answer stops here with "cut" (spec §2.2) */
#define RX_REQ_LINE 256          /* the longest answer line: an ENT with a 40-byte id and a 79-byte comment is 217 */
#define RX_REQ_ROOM (RX_REQ_LINE + 128)   /* a request writes its next line only with this much room left: the rest
                                             is for a PONG, GO, OK or refusal that arrives meanwhile (put() drops
                                             what does not fit) */
/* AmigaDOS error numbers (dos/dos.h), for the core's choice of protocol code (plan ruling T3). */
#define RX_DOS_IN_USE 202
#define RX_DOS_DIR_NOT_FOUND 204
#define RX_DOS_NOT_FOUND 205
#define RX_DOS_WRONG_TYPE 212
#define RX_DOS_READ_PROTECTED 224
#define RX_DOS_NO_DISK 226
```

After the `rx_finfo` typedef add:

```c
typedef struct rx_vol {          /* a mounted volume */
    char name[RX_NAME_RAW], device[RX_NAME_RAW];   /* "Work", "DH0:" */
    unsigned long size, free, days, mins, ticks;   /* bytes (0: unknown); the volume's date */
} rx_vol;
typedef struct rx_dent {         /* one entry of a drawer */
    int is_dir; unsigned long size, prot, days, mins, ticks;
    char name[RX_NAME_RAW]; char comment[RX_COMMENT_MAX + 1];
} rx_dent;
```

In `rx_fs`, after `void (*close_r)(void *ctx);` add:

```c
    /* Protocol 3 (spec 2026-10-30 §2.2): browsing, read-only, with shared locks. Errors are AmigaDOS error numbers. */
    int (*vols)(void *ctx, rx_vol *out, int max);      /* the mounted volumes, at most max; -1 failed */
    long (*dir_open)(void *ctx, const char *path);     /* 0, or a DOS error (RX_DOS_WRONG_TYPE: not a drawer) */
    long (*dir_next)(void *ctx, rx_dent *e);           /* 1 an entry, 0 the end, -<DOS error> failed */
    void (*dir_close)(void *ctx);                      /* the drawer's lock released */
    long (*stat)(void *ctx, const char *path, rx_finfo *info, int *is_dir);   /* 0, or a DOS error */
    void (*fault)(void *ctx, long err, char *text, unsigned cap);             /* AmigaDOS's words for err */
```

Replace the event enum's last member line `       RX_EV_UP_FAILED };    /* text = why; code = the board's NO code, or "local" */` with:

```c
       RX_EV_UP_FAILED,      /* text = why; code = the board's NO code, or "local" */
       RX_EV_REQ };          /* a web request answered (protocol 3): id = its id, code "vols"|"dir"|"get", path (vols:
                                ""), size = entries sent, bytes = 1 if cut, text = NULL, or why it was refused */
enum { RX_REQ_NONE, RX_REQ_VOLS, RX_REQ_DIR, RX_REQ_GET };
```

In `rx_upq`, after `int trust_next; ...` add:

```c
    int browse;                     /* 1: the owner lets the web app browse (ENVARC:webadf/Browse; spec 2026-10-30 §2.3) */
```

In `rx_session`, after the protocol 2 fields (before `} rx_session;`) add:

```c
    /* protocol 3 */
    int hello_browse;                                   /* what READY 3 said */
    int req_kind, req_open, req_nvols; unsigned req_i, req_count;
    char req_id[RX_ID_MAX + 1], req_path[RX_LOCAL_MAX + 1];             /* the request being answered */
    int wait_kind; char wait_id[RX_ID_MAX + 1], wait_path[RX_LOCAL_MAX + 1];   /* the one request waiting */
    rx_vol req_vols[RX_VOLS_MAX];
```

Before `#endif` add:

```c
/* Protocol 3 (spec 2026-10-30). */
int rx_browse_on(const rx_session *s);    /* 1: requests are answered (switch on, protocol 3, the trusted key) */
/* 1 when READY 3's flag no longer matches the switch (or the trust) and the connection is idle: the front end closes
   it, so the board reconnects and hears the new flag (plan ruling T1). */
int rx_hello_stale(const rx_session *s);
```

- [ ] **Step 7: The core**

In `tools/receive/core/rx_proto.c`:

7a. Replace `on_hello` entirely with:

```c
/* "WEBADF <v> [<key>]": READY 1 to a protocol 1 board (or a stray WEBADF), READY 2 to a protocol 2 one, READY 3 <b> to
   protocol 3 and newer (spec 2026-10-30 §2.1: b = 1 while requests will be answered); then the key decides whether
   this connection may upload and browse. Downloads work either way. */
static void on_hello(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v = 1; const char *code = 0;
    if (tok(c, &t, &n) && !num(t, n, 10, &v)) v = 1;
    s->peer_key[0] = 0;
    if (v < 2) {
        s->peer_v = 1; s->trust = RX_TRUST_OLD;
        puts_(s, "READY 1\n");
        emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
        if (s->upq) emit_trust(s, "old");
        return;
    }
    s->peer_v = v >= 3 ? 3 : 2;
    if (!tok(c, &t, &n) || !hex_key(t, n, s->peer_key)) s->peer_key[0] = 0;
    if (!s->upq) s->trust = RX_TRUST_NONE;
    else if (!s->peer_key[0]) { s->trust = RX_TRUST_OTHER; code = "other"; }
    else if (!s->upq->trusted[0] || s->upq->trust_next) {
        strcpy(s->upq->trusted, s->peer_key); s->upq->trust_next = 0;
        s->trust = RX_TRUST_OK; code = "new";
    } else if (strcmp(s->upq->trusted, s->peer_key) == 0) { s->trust = RX_TRUST_OK; code = "ok"; }
    else { s->trust = RX_TRUST_OTHER; code = "other"; }
    if (s->peer_v == 3) {
        s->hello_browse = rx_browse_on(s);
        puts_(s, s->hello_browse ? "READY 3 1\n" : "READY 3 0\n");
    } else puts_(s, "READY 2\n");
    emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
    if (code) emit_trust(s, code);
}
```

`rx_browse_on` is defined further down, so add a prototype near the top of the file, after the includes:
`int rx_browse_on(const rx_session *s);`. It is already in the header, so no extra line is needed. Check that
rx_proto.c includes rx_proto.h first. It does.

7b. After `rx_key4` (end of the protocol 2 hello section) add the request machinery:

```c
/* --- protocol 3: requests (spec 2026-10-30 §2.2) --- */
static const char *const REQ_WORD[] = { "", "vols", "dir", "get" };
int rx_browse_on(const rx_session *s) { return s->upq && s->upq->browse && s->peer_v >= 3 && s->trust == RX_TRUST_OK; }
/* A request starts only with nothing moving: a file being received or going up finishes first (spec §2.2 Order). */
static int req_idle(const rx_session *s) { return !s->in_data && s->up_phase == RX_UP_IDLE && !s->up_closing; }
int rx_hello_stale(const rx_session *s) {
    return s->peer_v >= 3 && s->hello_browse != rx_browse_on(s) && req_idle(s) &&
           s->req_kind == RX_REQ_NONE && s->wait_kind == RX_REQ_NONE && s->out_n == 0;
}
/* in, without control bytes (a newline would end the line early), into out[cap]. */
static void clean(const char *in, char *out, unsigned cap) {
    unsigned i;
    for (i = 0; in[i] && i + 1 < cap; i++) out[i] = (unsigned char)in[i] < 0x20 ? ' ' : in[i];
    out[i] = 0;
}
/* "ERR <id> <code> <len>:<text>" (unlike FILE's ERR, the text is length-prefixed). */
static void req_err(rx_session *s, const char *id, const char *code, const char *text) {
    char t[80];
    clean(text, t, sizeof t);
    puts_(s, "ERR "); puts_(s, id[0] ? id : "-"); puts_(s, " "); puts_(s, code); puts_(s, " "); put_lenstr(s, t); puts_(s, "\n");
}
static void emit_req(rx_session *s, int kind, const char *id, const char *path, unsigned long count, int cut, const char *why) {
    emit_full(s, RX_EV_REQ, id, path, count, (unsigned long)cut, why, 0, REQ_WORD[kind], 0);
}
static void req_end(rx_session *s) {
    if (s->req_open) { s->fs->dir_close(s->fs->ctx); s->req_open = 0; }
    s->req_kind = RX_REQ_NONE;
}
/* The request being answered fails: its ERR, the owner told, the drawer let go. */
static void req_fail_text(rx_session *s, const char *code, const char *text) {
    req_err(s, s->req_id, code, text);
    emit_req(s, s->req_kind, s->req_id, s->req_path, s->req_count, 0, text);
    req_end(s);
}
static void req_done(rx_session *s, int cut) {
    puts_(s, "DONE "); puts_(s, s->req_id); puts_(s, " "); put_dec(s, s->req_count);
    if (cut) puts_(s, " cut");
    puts_(s, "\n");
    emit_req(s, s->req_kind, s->req_id, s->req_path, s->req_count, cut, 0);
    req_end(s);
}
static void put_date(rx_session *s, unsigned long d, unsigned long m, unsigned long t) {
    put_dec(s, d); puts_(s, "."); put_dec(s, m); puts_(s, "."); put_dec(s, t);
}
static void req_start(rx_session *s) {
    s->req_kind = s->wait_kind; strcpy(s->req_id, s->wait_id); strcpy(s->req_path, s->wait_path);
    s->wait_kind = RX_REQ_NONE;
    s->req_i = 0; s->req_count = 0; s->req_open = 0;
    if (s->req_kind == RX_REQ_VOLS) {
        int k = s->fs->vols(s->fs->ctx, s->req_vols, RX_VOLS_MAX);
        if (k < 0) { req_fail_text(s, "io", "cannot read the volume list"); return; }
        s->req_nvols = k;
    }
}
/* The answer goes out a line at a time, only while the buffer has room for one (spec §2.2 Long drawers): the rest
   waits for the next pass, so memory stays flat however long the answer. */
static void req_pump(rx_session *s) {
    if (s->req_kind == RX_REQ_NONE && s->wait_kind != RX_REQ_NONE && req_idle(s)) req_start(s);
    while (s->req_kind == RX_REQ_VOLS && RX_OUT_MAX - s->out_n >= RX_REQ_ROOM) {
        const rx_vol *v;
        if (s->req_i >= (unsigned)s->req_nvols) { req_done(s, 0); break; }
        v = &s->req_vols[s->req_i++];
        if (!rx_name_sendable(v->name) || !rx_device_sendable(v->device)) continue;   /* plan rulings T2, T11 */
        puts_(s, "VOL "); puts_(s, s->req_id); puts_(s, " "); put_lenstr(s, v->name); puts_(s, " "); put_lenstr(s, v->device);
        puts_(s, " "); put_dec(s, v->size); puts_(s, " "); put_dec(s, v->free); puts_(s, " ");
        put_date(s, v->days, v->mins, v->ticks); puts_(s, "\n");
        s->req_count++;
    }
}
static int req_due(const rx_session *s) {
    if (s->req_kind != RX_REQ_NONE) return RX_OUT_MAX - s->out_n >= RX_REQ_ROOM;
    return s->wait_kind != RX_REQ_NONE && req_idle(s);
}
/* An Amiga path to read: "<volume>:<rest>", no control byte. */
static int local_path_ok(const char *p) {
    const char *q;
    if (!p[0] || p[0] == ':' || !strchr(p, ':')) return 0;
    for (q = p; *q; q++) if ((unsigned char)*q < 0x20 || (unsigned char)*q == 0x7f) return 0;
    return 1;
}
static void refuse_req(rx_session *s, int kind, const char *id, const char *path, const char *code, const char *text) {
    req_err(s, id, code, text);
    emit_req(s, kind, id[0] ? id : "-", path, 0, 0, text);
}
/* "VOLS <rid>", "DIR <rid> <len>:<path>", "GET <rid> <len>:<path>": refused at once, or kept to be answered when
   nothing moves (at most one waits: plan ruling T6). */
static void on_request(rx_session *s, cur *c, int kind) {
    const char *t; unsigned n; char id[RX_ID_MAX + 1], path[RX_LOCAL_MAX + 1];
    id[0] = 0; path[0] = 0;
    if (!tok(c, &t, &n) || !id_ok(t, n)) { refuse_req(s, kind, "", "", "bad", "bad request"); return; }
    memcpy(id, t, n); id[n] = 0;
    if ((kind != RX_REQ_VOLS && (!lenstr(c, path, sizeof path, 0) || !local_path_ok(path))) || c->p < c->end) {
        refuse_req(s, kind, id, path, "bad", "bad request"); return;
    }
    if (!rx_browse_on(s)) { refuse_req(s, kind, id, path, "off", "browsing is off in Transfer"); return; }
    if (s->wait_kind != RX_REQ_NONE) { refuse_req(s, kind, id, path, "busy", "another request is waiting"); return; }
    s->wait_kind = kind; strcpy(s->wait_id, id); strcpy(s->wait_path, path);
}
```

`rx_names.h` is already included. `on_request` uses `tok`, `lenstr` and `id_ok`, which are defined earlier in the
file. The block goes after them, inside the hello section's end, which is below `--- line parsing ---`, so the order
works.

7c. In `put_due`, require no request: replace its body with

```c
    return s->upq && s->upq->n > 0 && s->up_phase == RX_UP_IDLE && !s->in_data && !s->up_closing && rx_uploads_on(s) &&
           s->req_kind == RX_REQ_NONE && s->wait_kind == RX_REQ_NONE;   /* requests first (plan ruling T5) */
```

`put_due` sits above the request block, so add the prototype `static int req_due(const rx_session *s);` and a forward
declaration of `req_pump` above it: `static void req_pump(rx_session *s);`.

7d. Replace `rx_take_output` and `rx_want_output` with:

```c
int rx_take_output(rx_session *s, char *dst, unsigned cap) {
    if (s->up_closing) return -1;
    if (s->up_phase == RX_UP_SKIP || s->up_phase == RX_UP_DATA) return up_bytes(s, (unsigned char *)dst, cap);
    req_pump(s);
    if (s->out_n == 0) up_put(s);
    return (int)take_lines(s, dst, cap);
}
int rx_want_output(const rx_session *s) {
    if (s->up_closing || s->up_phase == RX_UP_SKIP) return 1;
    if (s->up_phase == RX_UP_DATA) return s->up_sent < s->up_credit;
    return s->out_n > 0 || put_due(s) || req_due(s);
}
```

7e. In `on_line`, after the `else if (is(t, n, "NO")) on_no(s, &c);` line add:

```c
    else if (is(t, n, "VOLS")) on_request(s, &c, RX_REQ_VOLS);
```

7f. In `rx_disconnected`, before `s->up_closing = 0; s->proto_err = 0;` add:

```c
    if (s->req_kind != RX_REQ_NONE) { emit_req(s, s->req_kind, s->req_id, s->req_path, s->req_count, 0, "connection lost"); req_end(s); }
    s->wait_kind = RX_REQ_NONE; s->hello_browse = 0;
```

- [ ] **Step 8: Keep the POSIX build compiling**

In `tools/receive/posix/rx_posix.c`'s `main`, the `rx_fs fs = { ... };` initializer is positional. Append six `NULL`
after `p_close_r`:
`..., p_open_r, p_read, p_close_r, NULL, NULL, NULL, NULL, NULL, NULL };   /* protocol 3: none until Q.browse (Task 4) */`.
Q.browse stays 0, so the core never calls them.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm receive:test`
Expected: `test_browse.c: N checks, 0 failed`; `test_names.c`, `test_proto.c` and `test_crc.c` all `0 failed`.

Run: `pnpm vitest run tools/receive/receive.int.test.ts`
Expected: all pass, as before; protocols 1 and 2 are unchanged.

- [ ] **Step 10: Commit**

```bash
git add tools/receive/core/rx_proto.h tools/receive/core/rx_proto.c tools/receive/core/rx_names.h tools/receive/core/rx_names.c \
  tools/receive/test/fakefs.h tools/receive/test/test_browse.c tools/receive/test/test_names.c tools/receive/posix/rx_posix.c
git commit -m "Transfer 2.3 core: protocol 3 hello (READY 3 <b>), the browse switch, VOLS paced by the buffer, refusals off/bad/busy"
```

---

### Task 2: DIR — a drawer listed line by line, the 1000 cut, AmigaDOS's errors (core)

**Files:**
- Modify: `tools/receive/core/rx_proto.h`, `tools/receive/core/rx_proto.c`, `tools/receive/test/test_browse.c`

**Interfaces:**
- Consumes: Task 1's helpers and fields (`req_start`, `req_pump`, `req_fail_text`, `req_done`, `req_end`, `clean`,
  `put_date`, `req_open`, `req_count`, `fs->dir_open/dir_next/dir_close/fault`).
- Produces: `const char *rx_err_code(long err, int want_dir)`, and `static void req_fail(rx_session *s, long err,
  int want_dir)`, which Task 3 uses for GET.

- [ ] **Step 1: Write the failing tests**

Append to `tools/receive/test/test_browse.c`, before `int main`:

```c
static void a_drawer_lists_each_entry_then_done(void) {
    setup(1); F.days = 10; F.mins = 20; F.ticks = 30;
    ff_add(&F, "Work:", 1); ff_add(&F, "Work:Programs", 1);
    ff_put(&F, "Work:Programs/a.txt", "hello", 5, 0x40, "note"); ff_add(&F, "Work:Programs/Sub", 1);
    hello3(); drain();
    feed("DIR d1 13:Work:Programs\n"); drain();
    CHECK(strcmp(ob, "ENT d1 f 5 40 10.20.30 5:a.txt 4:note\nENT d1 d 0 0 10.20.30 3:Sub 0:\nDONE d1 2\n") == 0, ob);
    CHECK_EQ_INT(F.dir_opens, 1); CHECK_EQ_INT(F.dir_closes, 1); CHECK(!F.dir_open, "the lock is let go");
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_code[i], "dir") == 0 && strcmp(ev_path[i], "Work:Programs") == 0 && ev[i].size == 2 && !ev_has_text[i], "the owner sees it"); }
}
static void a_volume_root_lists(void) {
    setup(1); ff_add(&F, "Work:", 1); ff_add(&F, "Work:Programs", 1); ff_put(&F, "Work:Programs/a.txt", "x", 1, 0, "");
    hello3(); drain(); feed("DIR d2 5:Work:\n"); drain();
    CHECK(strcmp(ob, "ENT d2 d 0 0 0.0.0 8:Programs 0:\nDONE d2 1\n") == 0, ob);
}
static void a_long_drawer_is_paced_and_nothing_is_lost(void) {
    static char b[RX_UP_BLOCK + 1]; int k, n = 0, pass = 0;
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 600;
    hello3(); drain();
    feed("DIR d3 8:Work:Big\n");
    ob_n = 0; ob[0] = 0; max_take = 0;
    while (rx_want_output(&S) && pass < 100000) {
        k = rx_take_output(&S, b, sizeof b - 1);
        if (k < 0) break;
        if (k > max_take) max_take = k;
        memcpy(ob + ob_n, b, (size_t)k); ob_n += (unsigned)k; ob[ob_n] = 0;
        if (++pass == 3) { CHECK(F.dir_open, "the drawer stays locked across passes"); feed("PING\n"); n++; }
    }
    CHECK_EQ_INT(n, 1);
    CHECK_EQ_INT(lines_starting("ENT d3 f "), 600);
    CHECK_EQ_INT(lines_starting("PONG"), 1);
    CHECK(strstr(ob, "ENT d3 f 0 0 0.0.0 5:f0000 0:\n") != NULL, "the first");
    CHECK(strstr(ob, "ENT d3 f 299 0 0.0.0 5:f0299 0:\nENT d3 f 300 0 0.0.0 5:f0300 0:\n") != NULL ||
          strstr(ob, "ENT d3 f 299 0 0.0.0 5:f0299 0:\nPONG\nENT d3 f 300 0 0.0.0 5:f0300 0:\n") != NULL, "in order");
    CHECK(ob_n >= 12 && strcmp(ob + ob_n - 12, "DONE d3 600\n") == 0, "DONE 600, last");
    CHECK(max_take <= RX_OUT_MAX, "never more than the 1 KB buffer at once");
    CHECK(!F.dir_open, "let go at the end");
}
static void the_listing_stops_at_1000_with_cut(void) {
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 1005;
    hello3(); drain(); feed("DIR d4 8:Work:Big\n"); drain();
    CHECK_EQ_INT(lines_starting("ENT d4 "), 1000);
    CHECK(ob_n > 17 && strcmp(ob + ob_n - 17, "DONE d4 1000 cut\n") == 0, "DONE 1000 cut, last");
    CHECK_EQ_INT(F.dir_closes, 1);
    { int i = last_req(); CHECK(i >= 0 && ev[i].bytes == 1 && ev[i].size == 1000, "cut, for the owner"); }
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 1000;
    hello3(); drain(); feed("DIR d5 8:Work:Big\n"); drain();
    CHECK(ob_n > 13 && strcmp(ob + ob_n - 13, "DONE d5 1000\n") == 0, "exactly 1000: not cut");
}
static void names_the_web_app_cannot_take_are_left_out_of_a_drawer(void) {
    setup(1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/ok", "x", 1, 0, "");
    ff_put(&F, "Work:D/bad\x01name", "x", 1, 0, ""); ff_put(&F, "Work:D/1234567890123456789012345678901", "x", 1, 0, "");
    hello3(); drain(); feed("DIR d6 6:Work:D\n"); drain();
    CHECK(strcmp(ob, "ENT d6 f 1 0 0.0.0 2:ok 0:\nDONE d6 1\n") == 0, ob);
}
static void latin1_names_go_out_byte_for_byte(void) {
    setup(1); ff_add(&F, "Gr\xfc\xdf" "e:", 1); ff_put(&F, "Gr\xfc\xdf" "e:Caf\xe9", "x", 1, 0, "\xe9t\xe9");
    hello3(); drain(); feed("DIR d7 6:Gr\xfc\xdf" "e:\n"); drain();
    CHECK(strcmp(ob, "ENT d7 f 1 0 0.0.0 4:Caf\xe9 3:\xe9t\xe9\nDONE d7 1\n") == 0, ob);
}
static void comments_lose_control_bytes(void) {
    setup(1); ff_add(&F, "Work:", 1); ff_put(&F, "Work:a", "x", 1, 0, "a\nb");
    hello3(); drain(); feed("DIR d8 5:Work:\n"); drain();
    CHECK(strcmp(ob, "ENT d8 f 1 0 0.0.0 1:a 3:a b\nDONE d8 1\n") == 0, ob);
}
static void drawer_errors_carry_amigados_words(void) {
    setup(1); ff_put(&F, "Work:a.txt", "x", 1, 0, ""); hello3(); drain();
    feed("DIR e1 9:Work:Nope\n"); drain(); CHECK(strcmp(ob, "ERR e1 notfound 13:dos error 205\n") == 0, ob);
    feed("DIR e2 10:Work:a.txt\n"); drain(); CHECK(strcmp(ob, "ERR e2 notdir 13:dos error 212\n") == 0, ob);
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_text[i], "dos error 212") == 0, "the owner sees AmigaDOS's words"); }
    CHECK(strcmp(rx_err_code(205, 1), "notfound") == 0, "205"); CHECK(strcmp(rx_err_code(204, 1), "notfound") == 0, "204");
    CHECK(strcmp(rx_err_code(202, 1), "busy") == 0, "202"); CHECK(strcmp(rx_err_code(224, 0), "denied") == 0, "224");
    CHECK(strcmp(rx_err_code(212, 1), "notdir") == 0, "212 dir"); CHECK(strcmp(rx_err_code(212, 0), "isdir") == 0, "212 get");
    CHECK(strcmp(rx_err_code(226, 1), "io") == 0, "226 no disk"); CHECK(strcmp(rx_err_code(218, 1), "io") == 0, "218 not mounted");
    CHECK(strcmp(rx_err_code(103, 1), "io") == 0, "103");
}
static void a_drawer_that_fails_mid_listing_ends_with_err_and_lets_go(void) {
    setup(1); strcpy(F.synth, "DF0:"); F.synth_n = 50; F.dir_fail_after = 2;
    hello3(); drain(); feed("DIR e3 4:DF0:\n"); drain();
    CHECK(strcmp(ob, "ENT e3 f 0 0 0.0.0 5:f0000 0:\nENT e3 f 1 0 0.0.0 5:f0001 0:\nERR e3 io 13:dos error 226\n") == 0, ob);
    CHECK(!F.dir_open && F.dir_closes == 1, "let go");
}
static void malformed_and_off_dir_requests(void) {
    setup(1); hello3(); drain();
    feed("DIR r2 junk\n"); drain(); CHECK(strcmp(ob, "ERR r2 bad 11:bad request\n") == 0, ob);
    feed("DIR r3 3:abc\n"); drain(); CHECK(strcmp(ob, "ERR r3 bad 11:bad request\n") == 0, "no volume");
    feed("DIR r4 0:\n"); drain(); CHECK(strcmp(ob, "ERR r4 bad 11:bad request\n") == 0, "empty");
    feed("DIR r5 5:Work: x\n"); drain(); CHECK(strcmp(ob, "ERR r5 bad 11:bad request\n") == 0, "after the path");
    feed("DIR r6 6:Work:\x01\n"); drain(); CHECK(strcmp(ob, "ERR r6 bad 11:bad request\n") == 0, "a control byte");
    CHECK_EQ_INT(F.dir_opens, 0);
    setup(0); hello3(); drain();
    feed("DIR r7 5:Work:\n"); drain(); CHECK(strcmp(ob, "ERR r7 off 27:browsing is off in Transfer\n") == 0, ob);
}
static void a_lost_connection_mid_listing_releases_the_drawer(void) {
    static char b[RX_UP_BLOCK + 1];
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 600;
    hello3(); drain(); feed("DIR d9 8:Work:Big\n");
    CHECK(rx_take_output(&S, b, sizeof b) > 0, "a first part");
    CHECK(F.dir_open, "open mid-listing");
    rx_disconnected(&S);
    CHECK(!F.dir_open && F.dir_closes == 1, "let go");
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_text[i], "connection lost") == 0, "the owner sees why"); }
}
static void requests_go_before_queued_files(void) {
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 300; ff_put(&F, "DH0:Mine", "m", 1, 0, "");
    hello3(); drain();
    feed("DIR d10 8:Work:Big\n");
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:Mine", "Mine"), 1);
    drain();
    CHECK(strstr(ob, "PUT 1 ") != NULL && strstr(ob, "DONE d10 300\n") != NULL && strstr(ob, "PUT 1 ") > strstr(ob, "DONE d10 300\n"),
          "the listing first, then the owner's file");
}
```

Add to `main`'s RUN list:

```c
    RUN(a_drawer_lists_each_entry_then_done); RUN(a_volume_root_lists); RUN(a_long_drawer_is_paced_and_nothing_is_lost);
    RUN(the_listing_stops_at_1000_with_cut); RUN(names_the_web_app_cannot_take_are_left_out_of_a_drawer);
    RUN(latin1_names_go_out_byte_for_byte); RUN(comments_lose_control_bytes); RUN(drawer_errors_carry_amigados_words);
    RUN(a_drawer_that_fails_mid_listing_ends_with_err_and_lets_go); RUN(malformed_and_off_dir_requests);
    RUN(a_lost_connection_mid_listing_releases_the_drawer); RUN(requests_go_before_queued_files);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm receive:test`
Expected: `test_browse` fails to build: `rx_err_code` is undeclared. (Until DIR is parsed, the DIR lines would also
be ignored.)

- [ ] **Step 3: Implement**

In `rx_proto.h`, after `rx_hello_stale`'s prototype:

```c
/* The protocol code for an AmigaDOS error (plan ruling T3); want_dir: the request wanted a drawer (DIR), not a file. */
const char *rx_err_code(long err, int want_dir);
```

In `rx_proto.c`, in the request block after `req_done`, add:

```c
const char *rx_err_code(long err, int want_dir) {
    switch (err) {
    case RX_DOS_NOT_FOUND: case RX_DOS_DIR_NOT_FOUND: return "notfound";
    case RX_DOS_IN_USE: return "busy";
    case RX_DOS_READ_PROTECTED: return "denied";
    case RX_DOS_WRONG_TYPE: return want_dir ? "notdir" : "isdir";
    default: return "io";
    }
}
/* A DOS error ends the request, in AmigaDOS's own words (Fault()). */
static void req_fail(rx_session *s, long err, int want_dir) {
    char text[80];
    text[0] = 0;
    s->fs->fault(s->fs->ctx, err, text, sizeof text);
    if (!text[0]) strcpy(text, "error");
    req_fail_text(s, rx_err_code(err, want_dir), text);
}
static void put_ent(rx_session *s, const rx_dent *e) {
    char cm[RX_COMMENT_MAX + 1];
    clean(e->comment, cm, sizeof cm);
    puts_(s, "ENT "); puts_(s, s->req_id); puts_(s, e->is_dir ? " d " : " f "); put_dec(s, e->is_dir ? 0 : e->size);
    puts_(s, " "); put_hex(s, e->prot); puts_(s, " "); put_date(s, e->days, e->mins, e->ticks);
    puts_(s, " "); put_lenstr(s, e->name); puts_(s, " "); put_lenstr(s, cm); puts_(s, "\n");
}
```

In `req_start`, after the VOLS branch add:

```c
    else if (s->req_kind == RX_REQ_DIR) {
        long e = s->fs->dir_open(s->fs->ctx, s->req_path);
        if (e) { req_fail(s, e, 1); return; }
        s->req_open = 1;
    }
```

In `req_pump`, after the VOLS loop add:

```c
    while (s->req_kind == RX_REQ_DIR && RX_OUT_MAX - s->out_n >= RX_REQ_ROOM) {
        static rx_dent e;   /* static: the Amiga's stack is small */
        long r;
        memset(&e, 0, sizeof e);
        r = s->fs->dir_next(s->fs->ctx, &e);
        if (r < 0) { req_fail(s, -r, 1); break; }
        if (r == 0) { req_done(s, 0); break; }
        if (!rx_name_sendable(e.name)) continue;                 /* plan ruling T2 */
        if (s->req_count == RX_ENT_MAX) { req_done(s, 1); break; }   /* a 1001st entry: cut (spec §2.2) */
        put_ent(s, &e);
        s->req_count++;
    }
```

`req_fail` and `put_ent` must come before `req_start` and `req_pump` in the file. Place them right after `req_done`, as
written above.

In `up_put`, use `clean` for the PUT's comment. Replace the block
`{ char cm[RX_COMMENT_MAX + 1]; unsigned i; ... put_lenstr(s, cm); }` with
`{ char cm[RX_COMMENT_MAX + 1]; clean(s->up_info.comment, cm, sizeof cm); put_lenstr(s, cm); }`. `up_put` sits above
`clean`, so add `static void clean(const char *in, char *out, unsigned cap);` to the forward declarations from Task 1
step 7c. `test_proto.c`'s `the_comment_in_the_put_has_no_control_bytes` covers this.

In `on_line`, after the VOLS line add `else if (is(t, n, "DIR")) on_request(s, &c, RX_REQ_DIR);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm receive:test`
Expected: every test file `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add tools/receive/core/rx_proto.h tools/receive/core/rx_proto.c tools/receive/test/test_browse.c
git commit -m "Transfer 2.3 core: DIR listed a line at a time while the buffer has room, cut at 1000, AmigaDOS's words in ERR"
```

---

### Task 3: GET, the order of things, and the owner's words (core)

**Files:**
- Modify: `tools/receive/core/rx_proto.h`, `tools/receive/core/rx_proto.c`, `tools/receive/test/test_browse.c`

**Interfaces:**
- Consumes: `req_fail`, `req_fail_text`, `req_end`, `emit_req`, `fs->stat`, `up_put`, `rx_upq_remove`, `emit_up`.
- Produces:
  - `rx_up_item.rid`;
  - `unsigned rx_up_add_front(rx_upq *q, const char *local, const char *name, const char *rid)`;
  - `void rx_req_words(const rx_event *e, char *out, unsigned cap)`, used by Task 5's Shell and window lines.

- [ ] **Step 1: Write the failing tests**

Append to `test_browse.c` before `main`:

```c
static void file_line(char *dst, const char *id, const char *data, unsigned long len, const char *path) {
    unsigned long crc = rx_crc32_update(0, (const unsigned char *)data, len);
    sprintf(dst, "FILE %s %lu %lx 0 %u:%s 0:\n", id, len, crc, (unsigned)strlen(path), path);
}
static void a_file_is_got_then_goes_up_at_the_front(void) {
    setup(1); F.days = 1; F.mins = 2; F.ticks = 3;
    ff_put(&F, "Work:a.txt", "hello", 5, 0x40, "note");
    ff_put(&F, "DH0:One", "1", 1, 0, ""); ff_put(&F, "DH0:Two", "2", 1, 0, "");
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:One", "One"), 1); CHECK_EQ_INT(rx_up_add(&Q, "DH0:Two", "Two"), 2);
    hello3(); drain(); CHECK(strncmp(ob, "READY 3 1\nPUT 1 1 ", 18) == 0, ob);
    feed("GET g1 10:Work:a.txt\n"); drain();
    CHECK(strstr(ob, "GOT") == NULL, "the GET waits behind the file going up");
    feed("TAKE 1 0 1\n"); drain(); feed("DONE 1 3:One\n"); drain();
    CHECK(strcmp(ob, "GOT g1 3\nPUT 3 5 1.2.3 40 5:a.txt 4:note\n") == 0, ob);
    CHECK_EQ_INT(Q.n, 1); CHECK_EQ_INT(Q.q[0].tag, 2);
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_code[i], "get") == 0 && strcmp(ev_path[i], "Work:a.txt") == 0 && !ev_has_text[i], "the owner sees it"); }
}
static void get_refusals(void) {
    static char b[RX_UP_BLOCK + 1];
    setup(1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:locked", "x", 1, 0x08, ""); ff_put(&F, "Work:big", "x", 1, 0, "");
    hello3(); drain();
    feed("GET g2 9:Work:Nope\n"); drain(); CHECK(strcmp(ob, "ERR g2 notfound 13:dos error 205\n") == 0, ob);
    feed("GET g3 6:Work:D\n"); drain(); CHECK(strcmp(ob, "ERR g3 isdir 13:dos error 212\n") == 0, ob);
    feed("GET g4 11:Work:locked\n"); drain(); CHECK(strcmp(ob, "ERR g4 denied 13:dos error 224\n") == 0, ob);
    F.stat_size = RX_FILE_MAX + 1;
    feed("GET g5 8:Work:big\n"); drain(); CHECK(strcmp(ob, "ERR g5 toolarge 29:file too large (4 MB at most)\n") == 0, ob);
    F.stat_size = 0;
    feed("GET g6 4:Work\n"); drain(); CHECK(strcmp(ob, "ERR g6 bad 11:bad request\n") == 0, "no volume");
    CHECK_EQ_INT(Q.n, 0);
    /* a full queue: the GET is answered busy before any of the 64 starts */
    setup(1); ff_put(&F, "Work:a", "x", 1, 0, ""); ff_put(&F, "DH0:f", "x", 1, 0, ""); hello3(); drain();
    feed("GET g7 6:Work:a\n");
    { int i; for (i = 0; i < RX_UP_MAX; i++) rx_up_add(&Q, "DH0:f", "f"); }
    drain(); CHECK(strncmp(ob, "ERR g7 busy 22:too many files waiting\nPUT ", 42) == 0, ob);
    /* the file went before its turn came: ERR io after the GOT */
    setup(1); ff_put(&F, "Work:gone.txt", "x", 1, 0, ""); hello3(); drain();
    feed("GET g8 13:Work:gone.txt\n");
    { int k = rx_take_output(&S, b, sizeof b - 1); b[k > 0 ? k : 0] = 0; CHECK(strcmp(b, "GOT g8 1\n") == 0, b); }
    ff_remove(&F, "Work:gone.txt");
    drain(); CHECK(strcmp(ob, "ERR g8 io 20:cannot read the file\n") == 0, ob);
    setup(0); hello3(); drain();
    feed("GET g9 6:Work:a\n"); drain(); CHECK(strcmp(ob, "ERR g9 off 27:browsing is off in Transfer\n") == 0, ob);
}
static void a_request_right_after_a_files_last_byte(void) {
    char l[300];
    setup(1); vol("Work", "DH0:", 1, 1, 1); hello3(); drain();
    file_line(l, "f1", "hello", 5, "In.txt"); feed(l); drain(); CHECK(strcmp(ob, "GO f1\n") == 0, ob);
    feed("helloVOLS v1\n"); drain();
    CHECK(strcmp(ob, "OK f1 6:In.txt\nVOL v1 4:Work 4:DH0: 1 1 1.2.3\nDONE v1 1\n") == 0, ob);
}
static void a_dropped_connection_forgets_get_files_not_yet_gone_up(void) {
    static char b[RX_UP_BLOCK + 1];
    setup(1); ff_put(&F, "Work:a.txt", "hello", 5, 0, "");
    ff_put(&F, "DH0:One", "1", 1, 0, ""); ff_put(&F, "DH0:Two", "2", 1, 0, "");
    rx_up_add(&Q, "DH0:One", "One"); rx_up_add(&Q, "DH0:Two", "Two");
    hello3(); drain();
    feed("GET g1 10:Work:a.txt\n");
    feed("TAKE 1 0 1\n"); drain(); feed("DONE 1 3:One\n");
    { int k = rx_take_output(&S, b, sizeof b - 1); b[k > 0 ? k : 0] = 0; CHECK(strcmp(b, "GOT g1 3\n") == 0, b); }
    CHECK_EQ_INT(Q.n, 2); CHECK(strcmp(Q.q[0].rid, "g1") == 0, "the GET's file is first");
    rx_disconnected(&S);
    CHECK_EQ_INT(Q.n, 1); CHECK_EQ_INT(Q.q[0].tag, 2);
    { int i, seen = 0; for (i = 0; i < n_ev; i++) if (ev[i].kind == RX_EV_UP_FAILED && ev[i].tag == 3 && strcmp(ev_text[i], "connection lost") == 0) seen = 1;
      CHECK(seen, "the owner is told"); }
}
static void the_owners_words(void) {
    rx_event e; char w[80];
    memset(&e, 0, sizeof e); e.kind = RX_EV_REQ;
    e.code = "vols"; e.path = ""; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "listed volumes") == 0, w);
    e.code = "dir"; e.path = "Work:Programs"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "listed Work:Programs") == 0, w);
    e.bytes = 1; e.path = "Work:Big"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "listed Work:Big (first 1000)") == 0, w);
    e.bytes = 0; e.code = "get"; e.path = "Work:a.lha"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "copied Work:a.lha") == 0, w);
    e.code = "dir"; e.path = "Work:x"; e.text = "dos error 205"; rx_req_words(&e, w, sizeof w);
    CHECK(strcmp(w, "could not list Work:x: dos error 205") == 0, w);
    e.code = "vols"; e.path = ""; e.text = "cannot read the volume list"; rx_req_words(&e, w, sizeof w);
    CHECK(strcmp(w, "could not list volumes: cannot read the volume list") == 0, w);
    e.code = "get"; e.path = "Work:a"; e.text = "x"; rx_req_words(&e, w, sizeof w); CHECK(strcmp(w, "could not copy Work:a: x") == 0, w);
    e.code = "dir"; e.text = NULL;
    e.path = "Work:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    rx_req_words(&e, w, sizeof w); CHECK(strlen(w) == 7 + 40 && strcmp(w + strlen(w) - 3, "...") == 0, w);
    rx_req_words(&e, w, 10); CHECK_EQ_INT(strlen(w), 9);
}
```

Add to `main`:

```c
    RUN(a_file_is_got_then_goes_up_at_the_front); RUN(get_refusals); RUN(a_request_right_after_a_files_last_byte);
    RUN(a_dropped_connection_forgets_get_files_not_yet_gone_up); RUN(the_owners_words);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm receive:test`
Expected: the build fails: `rx_req_words` and `rid` are undeclared.

- [ ] **Step 3: Implement**

In `rx_proto.h`, replace the `rx_up_item` typedef with:

```c
typedef struct rx_up_item {
    unsigned tag; char local[RX_LOCAL_MAX + 1]; char name[RX_PATH_MAX + 1];
    char rid[RX_ID_MAX + 1];   /* a GET's request id (spec 2026-10-30 §2.2), "" for the owner's own files */
} rx_up_item;
```

After `rx_up_add`'s prototype add:

```c
/* A GET's file (spec 2026-10-30 §2.2): first in the queue; rid ties its PUT to the request. Tag, or 0. */
unsigned rx_up_add_front(rx_upq *q, const char *local, const char *name, const char *rid);
```

After `rx_err_code`'s prototype add:

```c
/* An RX_EV_REQ in the owner's words (spec §2.3): "listed volumes", "listed Work:Programs", "copied Work:a.lha",
   "could not list Work:x: <why>"; a path over 40 bytes ends "...". Cut to cap. */
void rx_req_words(const rx_event *e, char *out, unsigned cap);
```

In `rx_proto.c`, replace `rx_up_add` with:

```c
static unsigned up_add_at(rx_upq *q, unsigned at, const char *local, const char *name, const char *rid) {
    rx_up_item *it;
    if (q->n >= RX_UP_MAX || !local[0] || strlen(local) > RX_LOCAL_MAX || !rx_path_ok(name)) return 0;
    memmove(&q->q[at + 1], &q->q[at], (q->n - at) * sizeof q->q[0]);
    q->n++;
    it = &q->q[at];
    if (++q->next_tag > 999999999U) q->next_tag = 1;   /* the board reads 1-9 digits */
    it->tag = q->next_tag;
    strcpy(it->local, local);
    strcpy(it->name, name);
    strcpy(it->rid, rid);
    return it->tag;
}
unsigned rx_up_add(rx_upq *q, const char *local, const char *name) { return up_add_at(q, q->n, local, name, ""); }
unsigned rx_up_add_front(rx_upq *q, const char *local, const char *name, const char *rid) { return up_add_at(q, 0, local, name, rid); }
```

In `up_put`, make a GET's file that cannot go answer its request:

```c
        if (s->fs->open_r(s->fs->ctx, it.local, &s->up_info) != 0) {
            if (it.rid[0]) req_err(s, it.rid, "io", "cannot read the file");
            emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "cannot read the file", "local");
            continue;
        }
        if (s->up_info.size > RX_FILE_MAX) {
            s->fs->close_r(s->fs->ctx);
            if (it.rid[0]) req_err(s, it.rid, "toolarge", "file too large (4 MB at most)");
            emit_up(s, RX_EV_UP_FAILED, &it, 0, s->up_info.size, 0, "file too large (4 MB at most)", "local");
            continue;
        }
```

`req_err` is defined below `up_put`, so add `static void req_err(rx_session *s, const char *id, const char *code, const
char *text);` to the forward declarations.

In the request block, after `put_ent`, add:

```c
/* GET (spec §2.2): checked now, then GOT and the file first in the up-queue; it goes up by protocol 2 as soon as
   nothing else moves. */
static void get_start(rx_session *s) {
    rx_finfo info; int is_dir = 0; long e; char name[RX_PART_MAX + 1]; unsigned tag;
    memset(&info, 0, sizeof info);
    e = s->fs->stat(s->fs->ctx, s->req_path, &info, &is_dir);
    if (e) { req_fail(s, e, 0); return; }
    if (is_dir) { req_fail(s, RX_DOS_WRONG_TYPE, 0); return; }
    if (info.prot & 8UL) { req_fail(s, RX_DOS_READ_PROTECTED, 0); return; }   /* FIBF_READ set: not readable */
    if (info.size > RX_FILE_MAX) { req_fail_text(s, "toolarge", "file too large (4 MB at most)"); return; }
    rx_base_name(s->req_path, name);
    tag = rx_up_add_front(s->upq, s->req_path, name, s->req_id);
    if (!tag) {
        if (s->upq->n >= RX_UP_MAX) req_fail_text(s, "busy", "too many files waiting");
        else req_fail_text(s, "io", "cannot send that name");   /* plan ruling T7 */
        return;
    }
    puts_(s, "GOT "); puts_(s, s->req_id); puts_(s, " "); put_dec(s, tag); puts_(s, "\n");
    emit_req(s, RX_REQ_GET, s->req_id, s->req_path, 0, 0, 0);
    req_end(s);
}
static void cat(char *out, unsigned cap, const char *str) {
    size_t n = strlen(out);
    while (*str && n + 1 < cap) out[n++] = *str++;
    out[n] = 0;
}
void rx_req_words(const rx_event *e, char *out, unsigned cap) {
    int get = strcmp(e->code, "get") == 0;
    char p[44];
    if (!cap) return;
    out[0] = 0;
    if (strcmp(e->code, "vols") == 0) strcpy(p, "volumes");
    else if (strlen(e->path) > 40) { memcpy(p, e->path, 37); strcpy(p + 37, "..."); }
    else strcpy(p, e->path);
    if (e->text) { cat(out, cap, get ? "could not copy " : "could not list "); cat(out, cap, p); cat(out, cap, ": "); cat(out, cap, e->text); }
    else { cat(out, cap, get ? "copied " : "listed "); cat(out, cap, p); if (e->bytes) cat(out, cap, " (first 1000)"); }
}
```

In `req_start`, add the GET branch after the DIR branch: `else get_start(s);`. `get_start` must be defined above
`req_start`: place `get_start`, `cat` and `rx_req_words` right after `put_ent`.

In `on_line`, after the DIR line add `else if (is(t, n, "GET")) on_request(s, &c, RX_REQ_GET);`.

In `rx_disconnected`, after the lines Task 1 added, add:

```c
    if (s->upq) {   /* a GET's file not yet gone up: after a reconnect the board no longer knows its tag (ruling T4) */
        unsigned i = s->upq->n;
        while (i-- > 0) if (s->upq->q[i].rid[0]) {
            rx_up_item it = s->upq->q[i];
            rx_upq_remove(s->upq, it.tag);
            emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "connection lost", "local");
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm receive:test`
Expected: every test file `0 failed`.

Run: `pnpm vitest run tools/receive/receive.int.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tools/receive/core/rx_proto.h tools/receive/core/rx_proto.c tools/receive/test/test_browse.c
git commit -m "Transfer 2.3 core: GET answered GOT and sent first by protocol 2; GET files dropped with the connection; the owner's words"
```

---

### Task 4: The POSIX build and the fake board speak protocol 3 (scenarios, integration test)

**Files:**
- Modify: `tools/receive/posix/rx_posix.c`, `tools/receive/fake-board.ts`, `tools/receive/scenarios.ts`,
  `tools/receive/run-scenarios.ts`, `tools/receive/receive.int.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3's core; `RX_EV_REQ`; `rx_hello_stale`.
- Produces (Task 6 runs these against FS-UAE):
  - `connect(port, host, { v: 3, key })` returns a `Board` with `browse: boolean`, `request(line, ms?)`,
    `answer(id, ms?)`, `write(line)` and `closed(ms)`;
  - `BROWSE_SCENARIOS` and `runBrowseScenarios(port, ctl, { host?, uae?, only? })`;
  - `makeBrowseFixture(root)`, which returns the `RX_VOLS` value;
  - `A_TXT`;
  - the `browse-off` scenario in `SCENARIOS`;
  - `run-scenarios.ts --browse`.

- [ ] **Step 1: The failing integration test**

In `tools/receive/receive.int.test.ts`, change the import to
`import { runScenarios, runUploadScenarios, runBrowseScenarios, makeBrowseFixture } from './scenarios';` and add,
inside the `describe`:

```ts
  it('answers VOLS, DIR and GET with browsing on; a request waits behind a file; switching off reconnects', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'br-'));
    const src = fs.mkdtempSync(path.join(tmp, 'brsrc-'));
    const vols = makeBrowseFixture(fs.mkdtempSync(path.join(tmp, 'vols-')));
    const { proc, port, lines } = await start(dir, { RX_VOLS: vols, RX_BROWSE: '1' }, path.join(tmp, 'BrowseKey'));
    const ctl = {
      dir: src,
      send: (p: string) => proc.stdin!.write(`SEND ${p}\n`),
      browse: (on: boolean) => proc.stdin!.write(`BROWSE ${on ? 1 : 0}\n`),
    };
    try {
      const res = await runBrowseScenarios(port, ctl);
      expect(res.filter((r) => !r.ok)).toEqual([]);
      expect(res).toHaveLength(11);
      expect(lines).toContain('REQ dir Work:Big 1000 cut ok');
      expect(lines).toContain('REQ get Work:Programs/a.txt 0 ok');
    } finally { proc.kill(); }
  }, 300000);
```

Run: `pnpm vitest run tools/receive/receive.int.test.ts`
Expected: FAIL (`runBrowseScenarios` is not exported).

- [ ] **Step 2: The fake board**

In `tools/receive/fake-board.ts`:

- The header comment's first line gains protocol 3:
  `// ... and protocol 3 (spec 2026-10-30 §2: READY 3 <b>; VOLS, DIR and GET answered with VOL/ENT/DONE/GOT/ERR).`
- In `byteReader`'s returned object add:

```ts
    /** Waits up to ms for the receiver to close the connection; false if it stayed open. */
    async closed(ms: number): Promise<boolean> {
      try { await until(() => false, ms); } catch { return false; }
      return true;
    },
```

- In the `Board` interface add:

```ts
  /** READY 3's flag: the Amiga's owner lets the web app browse (protocol 3; false on 1 and 2). */
  browse: boolean;
  /** Protocol 3: sends a VOLS, DIR or GET line and returns its answer, up to DONE, ERR or GOT for its id. */
  request(line: string, ms?: number): Promise<string[]>;
  /** The answer lines of request id, up to DONE, ERR or GOT (lines for other ids, and PONG, are skipped). */
  answer(id: string, ms?: number): Promise<string[]>;
  /** Writes one line and does not wait. */
  write(line: string): void;
  /** True once the receiver closes the connection within ms. */
  closed(ms: number): Promise<boolean>;
```

- Change `connect`'s options to `opts: { v?: 1 | 2 | 3; key?: string } = {}` and its hello to:

```ts
  sock.write(v >= 2 ? `WEBADF ${v} ${opts.key ?? BOARD_KEY}\n` : 'WEBADF 1\n');
  const hello = await rd.line();
  const m3 = v === 3 ? /^READY 3 ([01])$/.exec(hello ?? '') : null;
  if (v === 3 ? !m3 : hello !== `READY ${v}`) throw new Error(`expected READY ${v}, got ${JSON.stringify(hello)}`);
  const answer = async (id: string, ms = 60000) => {
    const out: string[] = [];
    for (;;) {
      const l = await rd.line(ms);
      if (l === null) throw new Error(`closed during the answer to ${id}: ${JSON.stringify(out.slice(-3))}`);
      const [verb, rid] = l.split(' ');
      if (rid !== id) continue;
      out.push(l);
      if (verb === 'DONE' || verb === 'ERR' || verb === 'GOT') return out;
    }
  };
```

  and add to the returned object:

```ts
    browse: m3 ? m3[1] === '1' : false,
    request(line, ms) { sock.write(Buffer.from(`${line}\n`, 'latin1')); return answer(line.split(' ')[1], ms); },
    answer,
    write(line) { sock.write(Buffer.from(`${line}\n`, 'latin1')); },
    closed: (ms) => rd.closed(ms),
```

- [ ] **Step 3: The scenarios**

In `tools/receive/scenarios.ts`, add to `SCENARIOS` (after the last entry, before `];`):

```ts
  // Protocol 3, browsing off (the default; spec 2026-10-30 §2.3): the hello says so and every request is refused.
  { name: 'browse-off', run: async (p, _d, h) => {
      const b = await connect(p, h, { v: 3 });
      try {
        if (b.browse) return 'READY 3 1 with browsing off';
        const a = await b.request('VOLS o1');
        return a.join('|') === 'ERR o1 off 27:browsing is off in Transfer' ? null : `got ${JSON.stringify(a)}`;
      } finally { await b.close(); } } },
```

Append at the end of the file:

```ts
// --- Browsing (spec 2026-10-30 §2): the board's side of VOLS, DIR and GET against Transfer with browsing on. ---

/** Work:Programs/a.txt holds this; the fixture is the same on the POSIX build and in FS-UAE (uae-test.sh browse). */
export const A_TXT = Buffer.from('hello from the Amiga\n');
/**
 * The POSIX build's volumes, under root:
 * - Work (DH0:) holds Programs/a.txt, and Big/ with 1005 empty files f0000..f1004;
 * - two volumes are named Empty, in DF0: and DF2:, each with a Which.txt saying "df0\n" or "df2\n".
 *
 * Returns the RX_VOLS value for rx_posix.
 */
export function makeBrowseFixture(root: string): string {
  const w = path.join(root, 'Work');
  fs.mkdirSync(path.join(w, 'Programs'), { recursive: true }); fs.mkdirSync(path.join(w, 'Big'));
  fs.writeFileSync(path.join(w, 'Programs', 'a.txt'), A_TXT);
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(w, 'Big', `f${String(i).padStart(4, '0')}`), '');
  for (const d of ['0', '2']) { fs.mkdirSync(path.join(root, `Empty${d}`)); fs.writeFileSync(path.join(root, `Empty${d}`, 'Which.txt'), `df${d}\n`); }
  return `Work|DH0:|${w};Empty|DF0:|${path.join(root, 'Empty0')};Empty|DF2:|${path.join(root, 'Empty2')}`;
}
/** How a browse scenario changes Transfer: the POSIX build reads stdin; FS-UAE cannot, so those scenarios are POSIX-only. */
export interface BrowseCtl { browse?(on: boolean): void; send?(hostPath: string): void; dir?: string }
export interface BrowseScenario { name: string; posixOnly?: boolean; run: (port: number, host: string, ctl: BrowseCtl) => Promise<string | null> }
const lenp = (s: string) => `${Buffer.byteLength(s, 'latin1')}:${s}`;
async function b3(p: number, h: string) {
  const b = await connect(p, h, { v: 3 });
  if (!b.browse) { await b.close(); throw new Error('READY 3 0: browsing is off'); }
  return b;
}
const one = (a: string[], want: RegExp) => (a.length === 1 && want.test(a[0]) ? null : `got ${JSON.stringify(a)}`);

export const BROWSE_SCENARIOS: BrowseScenario[] = [
  { name: 'b-vols', run: async (p, h) => { const b = await b3(p, h); try {
      const a = await b.request('VOLS v1');
      const vols = a.filter((l) => l.startsWith('VOL v1 '));
      if (a[a.length - 1] !== `DONE v1 ${vols.length}`) return `ended ${a[a.length - 1]} after ${vols.length} VOL lines`;
      if (!vols.some((l) => /^VOL v1 4:Work 4:DH0: \d+ \d+ \d+\.\d+\.\d+$/.test(l))) return `no Work in DH0: ${JSON.stringify(vols)}`;
      const empties = vols.filter((l) => l.startsWith('VOL v1 5:Empty ')).map((l) => l.split(' ')[3]).sort();
      return JSON.stringify(empties) === '["4:DF0:","4:DF2:"]' ? null : `the two Empty volumes, both plain: ${JSON.stringify(vols)}`;
    } finally { await b.close(); } } },
  { name: 'b-dir', run: async (p, h) => { const b = await b3(p, h); try {
      const a = await b.request(`DIR d1 ${lenp('Work:Programs')}`);
      return a.length === 2 && /^ENT d1 f 21 [0-9a-f]+ \d+\.\d+\.\d+ 5:a\.txt 0:$/.test(a[0]) && a[1] === 'DONE d1 1' ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  { name: 'b-device-path', run: async (p, h) => { const b = await b3(p, h); try {
      // The server sends a path through the second "Empty" as its device's path (spec §2.2): DF2: must be DF2's disk.
      const a = await b.request(`DIR d2 ${lenp('DF2:')}`);
      if (!a.some((l) => / 9:Which\.txt 0:$/.test(l)) || a[a.length - 1] !== 'DONE d2 1') return `DIR DF2: ${JSON.stringify(a)}`;
      const g = await b.request(`GET g0 ${lenp('DF2:Which.txt')}`);
      const tag = /^GOT g0 (\d+)$/.exec(g[0] ?? '')?.[1];
      if (!tag) return `GET: ${JSON.stringify(g)}`;
      const r = await b.takeUpload();
      return r.ok && r.tag === tag && r.data.toString('latin1') === 'df2\n' ? null : `got ${JSON.stringify({ ...r, data: r.ok ? r.data.toString('latin1') : undefined })}`;
    } finally { await b.close(); } } },
  { name: 'b-cut', run: async (p, h) => { const b = await b3(p, h); try {
      const a = await b.request(`DIR d3 ${lenp('Work:Big')}`, 300000);
      const ents = a.filter((l) => l.startsWith('ENT d3 f 0 ')).length;
      return ents === 1000 && a.length === 1001 && a[1000] === 'DONE d3 1000 cut' ? null : `${ents} entries, then ${a[a.length - 1]}`;
    } finally { await b.close(); } } },
  { name: 'b-notfound', run: async (p, h) => { const b = await b3(p, h); try {
      return one(await b.request(`DIR d4 ${lenp('Work:Nope')}`), /^ERR d4 notfound \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'b-notdir', run: async (p, h) => { const b = await b3(p, h); try {
      return one(await b.request(`DIR d5 ${lenp('Work:Programs/a.txt')}`), /^ERR d5 notdir \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'b-get', run: async (p, h) => { const b = await b3(p, h); try {
      const g = await b.request(`GET g1 ${lenp('Work:Programs/a.txt')}`);
      const tag = /^GOT g1 (\d+)$/.exec(g[0] ?? '')?.[1];
      if (!tag || g.length !== 1) return `got ${JSON.stringify(g)}`;
      const r = await b.takeUpload();
      return r.ok && r.tag === tag && r.path === 'a.txt' && Buffer.compare(r.data, A_TXT) === 0 ? null : `got ${JSON.stringify({ ...r, data: undefined })}`;
    } finally { await b.close(); } } },
  { name: 'b-isdir', run: async (p, h) => { const b = await b3(p, h); try {
      return one(await b.request(`GET g2 ${lenp('Work:Programs')}`), /^ERR g2 isdir \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'b-bad', run: async (p, h) => { const b = await b3(p, h); try {
      return one(await b.request('DIR x1 nope'), /^ERR x1 bad 11:bad request$/);
    } finally { await b.close(); } } },
  // Spec §2.2 Order: a request arriving while a file goes up waits, and is answered once the file is done.
  { name: 'b-waits-behind-a-file', posixOnly: true, run: async (p, h, ctl) => {
      const f = path.join(ctl.dir!, 'Wait.bin'); fs.writeFileSync(f, bytes(100000, 31));
      ctl.send!(f);
      const b = await b3(p, h);
      try {
        b.write('VOLS w1');   // Transfer has sent the PUT already: this request waits behind the file
        const r = await b.takeUpload();
        if (!r.ok) return `upload: ${JSON.stringify({ ...r, data: undefined })}`;
        const a = await b.answer('w1');
        return a[a.length - 1].startsWith('DONE w1 ') ? null : `got ${JSON.stringify(a)}`;
      } finally { await b.close(); } } },
  // Plan ruling T1: switching browsing off closes an idle connection, so the board hears READY 3 0 when it reconnects.
  { name: 'b-switch-reconnects', posixOnly: true, run: async (p, h, ctl) => {
      let b = await b3(p, h);
      ctl.browse!(false);
      if (!(await b.closed(5000))) { await b.close(); return 'still open after switching off'; }
      b = await connect(p, h, { v: 3 });
      try {
        if (b.browse) return 'READY 3 1 after switching off';
        const a = await b.request('VOLS s1');
        if (a.join('|') !== 'ERR s1 off 27:browsing is off in Transfer') return `got ${JSON.stringify(a)}`;
        ctl.browse!(true);
        if (!(await b.closed(5000))) return 'still open after switching on';
      } finally { await b.close(); }
      b = await connect(p, h, { v: 3 });
      try { return b.browse ? null : 'READY 3 0 after switching on'; } finally { await b.close(); } } },
];

export async function runBrowseScenarios(port: number, ctl: BrowseCtl, opts: { host?: string; uae?: boolean; only?: string[] } = {}) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const s of BROWSE_SCENARIOS) {
    if (opts.only && !opts.only.includes(s.name)) continue;
    if (s.posixOnly && opts.uae) continue;
    try { const err = await s.run(port, opts.host ?? '127.0.0.1', ctl); out.push({ name: s.name, ok: err === null, detail: err ?? '' }); }
    catch (e) { out.push({ name: s.name, ok: false, detail: String(e) }); }
  }
  return out;
}
```

`bytes(n, seed)` is the helper `scenarios.ts` already uses for the upload scenarios. Check its name and signature with
`grep -n "function bytes\|const bytes" tools/receive/scenarios.ts`, and use it as it is.

In `tools/receive/run-scenarios.ts`, replace the body after `const arg = ...` with:

```ts
// --browse: the protocol 3 scenarios (FS-UAE's browse mode); otherwise the shared download scenarios.
const res = process.argv.includes('--browse')
  ? await runBrowseScenarios(Number(arg('--port') ?? 6800), {}, { host: arg('--host'), only: arg('--only')?.split(','), uae: process.argv.includes('--uae') })
  : await runScenarios(Number(arg('--port') ?? 6800), arg('--dir')!, {
      host: arg('--host'), only: arg('--only')?.split(','), uae: process.argv.includes('--uae'),
    });
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ': ' + r.detail : ''}`);
process.exit(res.every((r) => r.ok) ? 0 : 1);
```

Change its import to `import { runScenarios, runBrowseScenarios } from './scenarios';` and its usage comment to
`// Usage: tsx tools/receive/run-scenarios.ts --port 6800 (--dir <host folder> | --browse) [--host 127.0.0.1] [--only a,b] [--uae]`.

- [ ] **Step 4: The POSIX build**

In `tools/receive/posix/rx_posix.c`:

- The usage comment gains:
  `   env: RX_VOLS="<name>|<device>|<host folder>;..." (protocol 3 volumes), RX_BROWSE=1 (browsing on at start);`
  `   stdin also: "BROWSE 1" / "BROWSE 0" (spec 2026-10-30 §2.3).`
- Add `#include <strings.h>` with the other includes.
- In `pctx`, add `DIR *dh; char dpath[1024];`, so it reads `typedef struct { const char *root; FILE *fh; FILE *rh; DIR *dh; char dpath[1024]; } pctx;`.
- Add, after `to_latin1`:

```c
/* Protocol 3: the volumes this host build pretends to have (RX_VOLS). "Work:x/y" or "DF2:x" is that folder's x/y. */
typedef struct { char name[64], dev[32], dir[512]; } pvol;
static pvol g_vols[8]; static int g_nvols;
static void vols_load(void) {
    const char *e = getenv("RX_VOLS"); char buf[4096], *p, *save = NULL;
    if (!e) return;
    snprintf(buf, sizeof buf, "%s", e);
    for (p = strtok_r(buf, ";", &save); p && g_nvols < 8; p = strtok_r(NULL, ";", &save)) {
        char *a = strchr(p, '|'), *b = a ? strchr(a + 1, '|') : NULL;
        if (!a || !b) continue;
        *a = 0; *b = 0;
        snprintf(g_vols[g_nvols].name, 64, "%s", p); snprintf(g_vols[g_nvols].dev, 32, "%s", a + 1);
        snprintf(g_vols[g_nvols].dir, 512, "%s", b + 1);
        g_nvols++;
    }
}
/* An Amiga path as a host path; a path without ':' is a host path already (SEND). -1: no such volume. The first
   volume of a name wins, as in AmigaDOS. */
static int host_path(const char *local, char *out, size_t cap) {
    const char *colon = strchr(local, ':');
    if (!colon) { snprintf(out, cap, "%s", local); return 0; }
    size_t n = (size_t)(colon - local);
    for (int i = 0; i < g_nvols; i++) {
        size_t dn = strlen(g_vols[i].dev) - 1;
        if ((strlen(g_vols[i].name) == n && strncasecmp(g_vols[i].name, local, n) == 0) ||
            (dn == n && strncasecmp(g_vols[i].dev, local, n) == 0)) {
            snprintf(out, cap, "%s/%s", g_vols[i].dir, colon + 1);
            return 0;
        }
    }
    return -1;
}
static void amiga_date(time_t mtime, unsigned long *d, unsigned long *m, unsigned long *t) {
    long s = (long)mtime - 252460800L;   /* AmigaDOS counts from 1978-01-01 */
    if (s < 0) s = 0;
    *d = (unsigned long)(s / 86400); *m = (unsigned long)(s % 86400 / 60); *t = (unsigned long)(s % 60 * 50);
}
```

- Make the existing protocol 2 hooks resolve Amiga paths. In `p_is_dir`, `p_list` and `p_open_r`, resolve `local` first:
  `char hp[1024]; if (host_path(local, hp, sizeof hp) != 0) return -1;`, then use `hp` where `local` was used. In
  `p_list`, the child path is built from `hp`. In `p_open_r`, replace its date lines with
  `amiga_date(st.st_mtime, &info->days, &info->mins, &info->ticks);`.
- Add the protocol 3 hooks after `p_close_r`:

```c
static int p_vols(void *x, rx_vol *out, int max) {
    (void)x;
    int n = g_nvols < max ? g_nvols : max;
    for (int i = 0; i < n; i++) {
        memset(&out[i], 0, sizeof out[i]);
        snprintf(out[i].name, sizeof out[i].name, "%s", g_vols[i].name);
        snprintf(out[i].device, sizeof out[i].device, "%s", g_vols[i].dev);
        out[i].size = 901120; out[i].free = 450560; out[i].days = 17000;
    }
    return n;
}
static long p_dir_open(void *x, const char *path) {
    pctx *c = x; struct stat st;
    if (host_path(path, c->dpath, sizeof c->dpath) != 0 || stat(c->dpath, &st) != 0) return RX_DOS_NOT_FOUND;
    if (!S_ISDIR(st.st_mode)) return RX_DOS_WRONG_TYPE;
    c->dh = opendir(c->dpath);
    return c->dh ? 0 : RX_DOS_READ_PROTECTED;
}
static long p_dir_next(void *x, rx_dent *e) {
    pctx *c = x; struct dirent *d; char p[1200]; struct stat st;
    while ((d = readdir(c->dh)) != NULL) {
        if (!strcmp(d->d_name, ".") || !strcmp(d->d_name, "..")) continue;
        snprintf(p, sizeof p, "%s/%s", c->dpath, d->d_name);
        if (stat(p, &st) != 0) continue;
        memset(e, 0, sizeof *e);
        to_latin1(d->d_name, e->name, sizeof e->name);
        e->is_dir = S_ISDIR(st.st_mode); e->size = e->is_dir ? 0 : (unsigned long)st.st_size;
        amiga_date(st.st_mtime, &e->days, &e->mins, &e->ticks);
        return 1;
    }
    return 0;
}
static void p_dir_close(void *x) { pctx *c = x; if (c->dh) { closedir(c->dh); c->dh = NULL; } }
static long p_stat(void *x, const char *path, rx_finfo *info, int *is_dir) {
    char hp[1024]; struct stat st;
    (void)x;
    if (host_path(path, hp, sizeof hp) != 0 || stat(hp, &st) != 0) return RX_DOS_NOT_FOUND;
    *is_dir = S_ISDIR(st.st_mode);
    info->size = (unsigned long)st.st_size; info->prot = access(hp, R_OK) == 0 ? 0 : 8;
    amiga_date(st.st_mtime, &info->days, &info->mins, &info->ticks);
    info->comment[0] = 0;
    return 0;
}
static void p_fault(void *x, long err, char *text, unsigned cap) {
    (void)x;
    if (err == RX_DOS_NOT_FOUND) snprintf(text, cap, "object not found");
    else if (err == RX_DOS_WRONG_TYPE) snprintf(text, cap, "object is wrong type");
    else if (err == RX_DOS_READ_PROTECTED) snprintf(text, cap, "file is read protected");
    else snprintf(text, cap, "error %ld", err);
}
```

- In `on_event`, add before `default:`:

```c
    case RX_EV_REQ:
        printf("REQ %s %s %lu%s %s\n", e->code, e->path && e->path[0] ? e->path : "-", e->size, e->bytes ? " cut" : "",
               e->text ? e->text : "ok");
        break;
```

- In `command`, add `else if (!strcmp(l, "BROWSE 1") || !strcmp(l, "BROWSE 0")) q->browse = l[7] == '1';`.
- In `main`:
  - replace Task 1's six `NULL` with `p_vols, p_dir_open, p_dir_next, p_dir_close, p_stat, p_fault` (and its comment);
  - call `vols_load();` after `rx_upq_init(&Q, key);`;
  - then set `Q.browse = getenv("RX_BROWSE") && getenv("RX_BROWSE")[0] == '1';`;
  - after the output loop (`if (cl >= 0 && !bad) { while (...) ... }`) add
    `if (cl >= 0 && !bad && rx_hello_stale(&S)) bad = 1;   /* the switch changed: the board reconnects (ruling T1) */`.

- [ ] **Step 5: Run the integration test**

Run: `pnpm vitest run tools/receive/receive.int.test.ts`
Expected: every test passes. That includes the shared download scenarios (now with `browse-off`), the uploads, and the
new browse test with 11 scenarios.

Run: `pnpm receive:test`
Expected: unchanged, `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add tools/receive/posix/rx_posix.c tools/receive/fake-board.ts tools/receive/scenarios.ts tools/receive/run-scenarios.ts \
  tools/receive/receive.int.test.ts
git commit -m "Transfer 2.3: the host build and the fake board speak protocol 3; browse scenarios (VOLS, DIR, GET, cut, device paths, order, switch)"
```

---

### Task 5: The Amiga side: dos.library hooks, the switch, version 2.3

**Files:**
- Modify: `tools/receive/amiga/afs.h`, `afs.c`, `config.h`, `config.c`, `net.c`, `ui.h`, `shell.c`, `gui.c`, `main.c`

**Interfaces:**
- Consumes:
  - the `rx_fs` protocol 3 hooks;
  - `rx_upq.browse`, `RX_EV_REQ`, `rx_req_words`, `rx_hello_stale`;
  - `RX_VOLS_MAX`, `rx_vol`, `rx_dent`.
- Produces: `int cfg_browse_load(void)`, `int cfg_browse_save(int on)`,
  `int shell_main(const char *dir, STRPTR *send, int trust, int browse)`,
  `int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send, int trust, int browse)`.

The Amiga code cannot run on the host. The gate here is a clean cross-build with `-Wall -Werror`; Task 6 runs it in
FS-UAE.

- [ ] **Step 1: `afs.h`**

Replace the `afs_ctx` typedef with:

```c
typedef struct afs_ctx {
    char root[256]; BPTR fh; BPTR rh;
    BPTR dl; struct FileInfoBlock *dfib;   /* the drawer being listed for the web app (protocol 3) */
} afs_ctx;
```

- [ ] **Step 2: `afs.c`**

Add after the `#include` block:

```c
/* Plan ruling T8: while Transfer reads for the web app, a drive whose disk went never opens "Please insert volume" on
   the Amiga's screen -- it would stop Transfer, and the board, until someone clicks. The call fails instead. */
static APTR quiet_on(void) {
    struct Process *p = (struct Process *)FindTask(NULL);
    APTR w = p->pr_WindowPtr;
    p->pr_WindowPtr = (APTR)-1;
    return w;
}
static void quiet_off(APTR w) { ((struct Process *)FindTask(NULL))->pr_WindowPtr = w; }
static unsigned long mul_cap(unsigned long a, unsigned long b) { return (b && a > 0xFFFFFFFFUL / b) ? 0xFFFFFFFFUL : a * b; }
```

Wrap `a_open_r` and `a_read` in quiet (ruling T8):
- In `a_open_r`, make `APTR w = quiet_on();` its first statement, call `quiet_off(w);` before each `return`, and keep
  its logic.
- In `a_read`, do the same: `APTR w = quiet_on(); LONG got = Read(...); quiet_off(w); return ...;`.

Add the protocol 3 hooks before `afs_base_name`:

```c
/* --- Protocol 3 (spec 2026-10-30 §2.2): browsing, read-only, shared locks only --- */
static void bstr(BSTR b, char *out, unsigned cap) {
    const UBYTE *p = (const UBYTE *)BADDR(b);
    unsigned n = p ? p[0] : 0;
    if (n > cap - 1) n = cap - 1;
    if (n) memcpy(out, p + 1, n);
    out[n] = 0;
}
/* The size and free bytes of the volume in dev ("DH0:"), as a_free counts them; RAM: is free memory (ruling T11). */
static void vol_sizes(const char *dev, unsigned long *size, unsigned long *fr) {
    BPTR l = Lock((STRPTR)dev, SHARED_LOCK);
    struct InfoData *id;
    *size = 0; *fr = 0;
    if (!l) return;
    if (((struct FileLock *)BADDR(l))->fl_Task == DeviceProc((STRPTR)"RAM:")) {
        ULONG mem = AvailMem(MEMF_ANY);
        *fr = mem > 65536UL ? mem - 65536UL : 0;
        UnLock(l);
        return;
    }
    id = AllocVec(sizeof *id, MEMF_PUBLIC | MEMF_CLEAR);
    if (id && Info(l, id)) {
        unsigned long bpb = (unsigned long)id->id_BytesPerBlock;
        *size = mul_cap((unsigned long)id->id_NumBlocks, bpb);
        *fr = mul_cap((unsigned long)(id->id_NumBlocks - id->id_NumBlocksUsed), bpb);
    }
    if (id) FreeVec(id);
    UnLock(l);
}
/* Mounted volumes (a handler task: a disk is in), each with the device whose handler it shares ("DF1:"). Names are
   copied under the DOS list lock; Lock and Info run after it is let go. */
static int a_vols(void *x, rx_vol *out, int max) {
    static struct MsgPort *task[RX_VOLS_MAX];
    struct DosList *head, *dl;
    int n = 0, i;
    APTR w;
    (void)x;
    if (max > RX_VOLS_MAX) max = RX_VOLS_MAX;
    head = LockDosList(LDF_VOLUMES | LDF_DEVICES | LDF_READ);
    for (dl = head; n < max && (dl = NextDosEntry(dl, LDF_VOLUMES)) != NULL; ) {
        if (!dl->dol_Task) continue;   /* its disk was taken out */
        memset(&out[n], 0, sizeof out[n]);
        bstr(dl->dol_Name, out[n].name, sizeof out[n].name);
        out[n].days = (unsigned long)dl->dol_misc.dol_volume.dol_VolumeDate.ds_Days;
        out[n].mins = (unsigned long)dl->dol_misc.dol_volume.dol_VolumeDate.ds_Minute;
        out[n].ticks = (unsigned long)dl->dol_misc.dol_volume.dol_VolumeDate.ds_Tick;
        task[n++] = dl->dol_Task;
    }
    for (dl = head; (dl = NextDosEntry(dl, LDF_DEVICES)) != NULL; )
        for (i = 0; i < n; i++)
            if (!out[i].device[0] && dl->dol_Task == task[i]) {
                bstr(dl->dol_Name, out[i].device, sizeof out[i].device - 1);
                strcat(out[i].device, ":");
            }
    UnLockDosList(LDF_VOLUMES | LDF_DEVICES | LDF_READ);
    w = quiet_on();
    for (i = 0; i < n; i++) if (out[i].device[0]) vol_sizes(out[i].device, &out[i].size, &out[i].free);
    quiet_off(w);
    return n;
}
static void fill_dent(const struct FileInfoBlock *f, rx_dent *e) {
    e->is_dir = f->fib_DirEntryType > 0;
    e->size = e->is_dir ? 0 : (unsigned long)f->fib_Size;
    e->prot = (unsigned long)f->fib_Protection;
    e->days = (unsigned long)f->fib_Date.ds_Days; e->mins = (unsigned long)f->fib_Date.ds_Minute;
    e->ticks = (unsigned long)f->fib_Date.ds_Tick;
    strncpy(e->name, (const char *)f->fib_FileName, sizeof e->name - 1); e->name[sizeof e->name - 1] = 0;
    strncpy(e->comment, (const char *)f->fib_Comment, RX_COMMENT_MAX); e->comment[RX_COMMENT_MAX] = 0;
}
static void a_dir_close(void *x) {
    afs_ctx *c = x;
    if (c->dfib) { FreeDosObject(DOS_FIB, c->dfib); c->dfib = NULL; }
    if (c->dl) { UnLock(c->dl); c->dl = 0; }
}
static long a_dir_open(void *x, const char *path) {
    afs_ctx *c = x;
    APTR w = quiet_on();
    long e = 0;
    c->dl = Lock((STRPTR)path, SHARED_LOCK);
    if (!c->dl) e = IoErr();
    else if ((c->dfib = AllocDosObject(DOS_FIB, NULL)) == NULL) e = ERROR_NO_FREE_STORE;
    else if (!Examine(c->dl, c->dfib)) e = IoErr();
    else if (c->dfib->fib_DirEntryType <= 0) e = ERROR_OBJECT_WRONG_TYPE;
    quiet_off(w);
    if (e == 0 && c->dl) return 0;
    a_dir_close(c);
    return e ? e : ERROR_OBJECT_NOT_FOUND;
}
static long a_dir_next(void *x, rx_dent *e) {
    afs_ctx *c = x;
    APTR w = quiet_on();
    long r = 1;
    if (ExNext(c->dl, c->dfib)) fill_dent(c->dfib, e);
    else { LONG err = IoErr(); r = err == ERROR_NO_MORE_ENTRIES ? 0 : -(err ? err : ERROR_OBJECT_NOT_FOUND); }
    quiet_off(w);
    return r;
}
static long a_stat(void *x, const char *path, rx_finfo *info, int *is_dir) {
    APTR w = quiet_on();
    BPTR l = Lock((STRPTR)path, SHARED_LOCK);
    struct FileInfoBlock *f = NULL;
    long e = 0;
    (void)x;
    if (!l) e = IoErr();
    else if ((f = AllocDosObject(DOS_FIB, NULL)) == NULL) e = ERROR_NO_FREE_STORE;
    else if (!Examine(l, f)) e = IoErr();
    else {
        *is_dir = f->fib_DirEntryType > 0;
        info->size = (unsigned long)f->fib_Size; info->prot = (unsigned long)f->fib_Protection;
        info->days = (unsigned long)f->fib_Date.ds_Days; info->mins = (unsigned long)f->fib_Date.ds_Minute;
        info->ticks = (unsigned long)f->fib_Date.ds_Tick;
        strncpy(info->comment, (const char *)f->fib_Comment, RX_COMMENT_MAX); info->comment[RX_COMMENT_MAX] = 0;
    }
    if (f) FreeDosObject(DOS_FIB, f);
    if (l) UnLock(l);
    quiet_off(w);
    return (!l && !e) ? ERROR_OBJECT_NOT_FOUND : e;
}
static void a_fault(void *x, long err, char *text, unsigned cap) {
    (void)x;
    if (Fault(err, NULL, (STRPTR)text, (LONG)cap) <= 0) text[0] = 0;
}
```

In `afs_init`, after the protocol 2 assignments add:

```c
    fs->vols = a_vols; fs->dir_open = a_dir_open; fs->dir_next = a_dir_next; fs->dir_close = a_dir_close;
    fs->stat = a_stat; fs->fault = a_fault;
```

`afs_init` already `memset`s the context, so `dl` and `dfib` start at zero.

- [ ] **Step 3: `config.h`, `config.c`**

`config.h`, before `#endif`:

```c
int cfg_browse_load(void);         /* ENV:/ENVARC:webadf/Browse: 1 on, else off */
int cfg_browse_save(int on);       /* 0 if ENVARC: took it */
```

`config.c`, append:

```c
/* The browsing switch (spec 2026-10-30 §2.3): webadf/Browse holds "1" or "0"; anything else, or no file, is off. */
int cfg_browse_load(void) {
    char b[8];
    if (read_file("ENV:webadf/Browse", b, sizeof b)) return b[0] == '1';
    if (read_file("ENVARC:webadf/Browse", b, sizeof b)) return b[0] == '1';
    return 0;
}
int cfg_browse_save(int on) {
    write_one("ENV:", "Browse", on ? "1" : "0");
    return write_one("ENVARC:", "Browse", on ? "1" : "0");
}
```

- [ ] **Step 4: `net.c`**

In `net_run`, after the `for (round = 0; ...)` output loop and before `if (cl >= 0 && bad) drop(ui, s, &cl);`, add:

```c
        /* The switch (or the trust) changed since READY 3: close once idle, so the board reconnects and hears it
           (plan ruling T1). */
        if (cl >= 0 && !bad && rx_hello_stale(s)) bad = 1;
```

- [ ] **Step 5: `ui.h`, `main.c`**

`ui.h`:

```c
int shell_main(const char *dir, STRPTR *send, int trust, int browse);
int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send, int trust, int browse);
```

`main.c`:
- The header comment's template becomes `TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S`. Add one sentence:
  `BROWSE lets the web app browse the Amiga's disks, read-only, for this run; with SAVE it is stored too (spec 2026-10-30 §2.3).`
- Set `static const char version[] = "$VER: Transfer 2.3 (DD.MM.YYYY) webadf";` with the date the task is done.
- Change the static ints to `static int want_gui, want_trust, rc_swapped, browse;`.
- Make `run()` pass the switch:
  `return want_gui ? gui_main(dir, wb_args, wb_n, send_files, want_trust, browse) : shell_main(dir, send_files, want_trust, browse);`
- In `main`:
  - use `LONG args[7] = { 0, 0, 0, 0, 0, 0, 0 };` and `int rc, want_receive, want_browse;`;
  - on a Workbench start, after `cfg_load(dir, sizeof dir); want_gui = 1;` add `browse = cfg_browse_load();`;
  - the `ReadArgs` template is `"TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S"`;
  - after `want_receive = args[5] != 0;` add `want_browse = args[6] != 0;`;
  - in the SEND/M filter loop, add a branch `else if (is_word((const char *)*in, "BROWSE")) want_browse = 1;`, and
    extend the comment above it to say BROWSE too;
  - after the `RECEIVE or SEND` check, before the `cfg_save` line, add:

```c
    browse = want_browse || cfg_browse_load();
    if (args[1] && want_browse && cfg_browse_save(1) != 0) PutStr((STRPTR)"Could not save browsing to ENVARC:\n");
```

- [ ] **Step 6: `shell.c`**

- In `shell_main`, change the signature to `int shell_main(const char *dir, STRPTR *send, int trust, int browse)`, and
  after `rx_upq_init(&q, key);` add `q.browse = browse;`.
- In receive mode, after the `VPrintf((STRPTR)"Transfer: saving into %s. Ctrl-C to stop.\n", args);` line add:

```c
    if (browse) PutStr((STRPTR)"Browsing on: the web app can read your disks (read-only)\n");
```

- In `sh_event`, add before `default:`:

```c
    case RX_EV_REQ: {
        char w[80];
        rx_req_words(e, w, sizeof w); a[0] = (LONG)w; VPrintf((STRPTR)"Web: %s\n", a);
        break;
    }
```

- The file's header comment gains: `With browsing on (BROWSE), one line per web request: "Web: listed Work:Programs".`

- [ ] **Step 7: `gui.c`**

- The enum becomes `enum { G_DIR, G_CHOOSE, G_SEND, G_RETRY, G_TRUST, G_SAVE, G_BROWSE, G_STATUS, G_LIST, G_N };`.
- In `build()`, after the second row's `G->g[G_SAVE] = ...` and the `y = (UWORD)(y + gh + 4);` that follows it, insert:

```c
    /* The browsing switch (spec 2026-10-30 §2.3), on its own row. */
    ng.ng_LeftEdge = (WORD)x0; ng.ng_TopEdge = (WORD)y; ng.ng_Width = 26; ng.ng_Height = (WORD)gh;
    ng.ng_GadgetText = (UBYTE *)"Let the web app browse my disks (read-only)"; ng.ng_GadgetID = G_BROWSE;
    ng.ng_Flags = PLACETEXT_RIGHT;
    G->g[G_BROWSE] = g = CreateGadget(CHECKBOX_KIND, g, &ng, GTCB_Checked, (ULONG)(G->q->browse ? TRUE : FALSE), TAG_END);
    ng.ng_Flags = PLACETEXT_IN;
    y = (UWORD)(y + gh + 4);
```

  The status gadget's code that follows sets its own `ng_LeftEdge`, `ng_TopEdge`, `ng_Width` and `ng_GadgetText`, so
  it needs no change. The window height comes from `y`, so it grows by one row.
- Add above `on_signal`:

```c
/* The switch (spec 2026-10-30 §2.3; plan ruling T9): stored at once, in ENV: and ENVARC:. A connected board reconnects
   to hear it (rx_hello_stale, net.c). */
static void set_browse(gui *G, int on) {
    G->q->browse = on;
    if (cfg_browse_save(on) != 0) set_status(G, on ? "Browsing on (not saved: ENVARC:)" : "Browsing off (not saved: ENVARC:)");
    else set_status(G, on ? "Browsing on: the web app can read your disks" : "Browsing off");
}
```

- In `on_signal`'s IDCMP chain, add
  `else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_BROWSE) set_browse(G, (gad->Flags & GFLG_SELECTED) != 0);`.
- In `on_event`, declare `char w[80];` beside `char k4[5], t[80];`, and add before `default: return;`:

```c
    case RX_EV_REQ:
        rx_req_words(e, w, sizeof w);
        sprintf(t, "Web: %.70s", w);
        set_status(G, t);
        return;
```

- Change `gui_main`'s signature to `int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send, int trust, int browse)`,
  and add `q.browse = browse;` after `rx_upq_init(&q, key);`. That is before `build()`, which reads it for the checkbox.
- The file's header comment gains: `A checkbox lets the web app browse the Amiga's disks (read-only); the status line shows its last request.`

- [ ] **Step 8: The cross-build compiles cleanly**

Run: `bash tools/receive/build.sh "$TMPDIR/Transfer-t5"`. Use the session scratchpad or `$TMPDIR`, not the repo.

Expected:
- a line `<sha256>  …/Transfer-t5 (<n> bytes)`, which means it compiled with `-Wall -Werror`;
- then `FAIL: not the pinned binary (...)`. That is expected: Task 6 re-pins.

Any compiler warning or error is a failure. Note the byte size in the report. 2.2 was about 40 KB; growth of a few KB is
expected.

Run: `pnpm receive:test && pnpm vitest run tools/receive/receive.int.test.ts`
Expected: all pass (unchanged by this task).

- [ ] **Step 9: Commit**

```bash
git add tools/receive/amiga/afs.h tools/receive/amiga/afs.c tools/receive/amiga/config.h tools/receive/amiga/config.c \
  tools/receive/amiga/net.c tools/receive/amiga/ui.h tools/receive/amiga/main.c tools/receive/amiga/shell.c tools/receive/amiga/gui.c
git commit -m "Transfer 2.3 on the Amiga: volumes, drawers and stat through dos.library without requesters; BROWSE/S and the checkbox; status lines"
```

---

### Task 6: FS-UAE on 2.04, 3.1 and 3.2; the pin; the driver disk; the docs

**Files:**
- Modify: `tools/receive/uae/uae-test.sh`, `tools/receive/README.md`, `tools/paulanet-disk/ReadMe`,
  `tools/receive/receive.sha256`, `tools/receive/dist/Transfer`, `tools/paulanet-disk/paulanet-disk.sha256`,
  `src/lib/paulanet-disk.ts`, `src/lib/paulanet-disk.test.ts`, `HANDOFF.md`
- Create: `tools/receive/uae/browse-demo.ts`

**Interfaces:**
- Consumes: `run-scenarios.ts --browse --uae`, `BROWSE_SCENARIOS` (fixture as in `makeBrowseFixture`'s comment).
- Produces: the pinned Transfer 2.3 binary; the driver disk pin (its sha256 is what the controller stores before
  pushing).

FS-UAE runs open a window on the Mac and take minutes. Run them one at a time, in the foreground, each under 9 minutes.
Never start one while another FS-UAE is running (`pgrep -l fs-uae` must show none of yours). If one hangs, stop only its
PID, which `uae-test.sh` prints as `fs-uae pid <n>`.

- [ ] **Step 1: A browse mode in `uae-test.sh`**

- The usage lines (two places) become `uae-test.sh 204|31|32 [shell|gui|space|ram|send|browse]`.
- After the line `target='Work:Out'; df0=''`, add `df2=''; fdc=2`.
- After the `gui` fixture block (`if [ "$mode" = gui ]; then ... fi`), add:

```bash
if [ "$mode" = browse ]; then
  # NET: volumes (spec 2026-10-30 §2.4), the fixture scenarios.ts's makeBrowseFixture describes:
  # - Work:Programs/a.txt, and Work:Big with 1005 empty files;
  # - two floppies both named Empty (DF0:, DF2:), each with a Which.txt naming its drive.
  mkdir -p "$work/hd/Programs" "$work/hd/Big"
  printf 'hello from the Amiga\n' > "$work/hd/Programs/a.txt"
  for i in $(seq -w 0 1004); do : > "$work/hd/Big/f$i"; done
  printf 'df0\n' > "$work/which0"; printf 'df2\n' > "$work/which2"
  xdftool "$work/empty0.adf" create + format Empty ofs + write "$work/which0" Which.txt >/dev/null
  xdftool "$work/empty2.adf" create + format Empty ofs + write "$work/which2" Which.txt >/dev/null
  df0="$work/empty0.adf"; df2="$work/empty2.adf"; fdc=3
fi
```

- In the `case "$mode" in` that sets `run_line`, add `  browse) run_line="Work:Transfer BROWSE TO Work:Out >Work:receive.log";;`.
- In the gui mode's `run_line`, add `BROWSE` after `GUI`:
  `Run >NIL: Work:Transfer TO $target GUI BROWSE SEND Work:Up/Lemmings.adf Work:Up/Notes.txt`. This also exercises the
  SEND/M filter for BROWSE.
- In the `.fs-uae` heredoc, replace `floppy_drive_count = 2` with `floppy_drive_count = $fdc`, and add a line
  `floppy_drive_2 = $df2` after `floppy_drive_1_write_protected = 1`.
- In the final `case "$mode" in`, add:

```bash
  browse) pnpm exec tsx "$repo/tools/receive/run-scenarios.ts" --port 6800 --browse --uae || rc=1
          [ -e "$work/hd/EnvArc/webadf/Browse" ] && { echo "FAIL BROWSE without SAVE stored the switch"; rc=1; } \
            || echo "PASS BROWSE without SAVE stored nothing"
          sleep 2; echo "--- receive.log"; cat "$work/hd/receive.log" 2>/dev/null || true;;
```

- [ ] **Step 2: Run browse mode on all three Kickstarts**

Run each in turn and read its output:

```bash
pnpm receive:uae 32 browse
pnpm receive:uae 31 browse
pnpm receive:uae 204 browse
```

Expected, each time:
- `PASS` for `b-vols`, `b-dir`, `b-device-path`, `b-cut`, `b-notfound`, `b-notdir`, `b-get`, `b-isdir` and `b-bad`
  (nine);
- `PASS BROWSE without SAVE stored nothing`;
- `receive.log` shows `Browsing on: …` and one `Web: …` line per request.

If `b-vols` fails because FS-UAE names the hard drive's device something other than `DH0:`, look at the VOL lines the
failure prints. Then rule on the scenario's expectation and ledger the ruling: the device must still be a sendable
device name. Do not weaken the two-`Empty` check.

- [ ] **Step 3: Nothing old broke**

Run each in turn:

```bash
pnpm receive:uae 31 shell
pnpm receive:uae 31 send
```

Expected:
- `shell`: every `PASS`, including the new `browse-off`;
- `send`: every step `PASS`, and its `ver.log` now reads `Transfer 2.3`. If `send-scenarios.ts` checks the version text
  and expects 2.2, update that check to 2.3.

- [ ] **Step 4: The window**

1. Run `pnpm receive:uae 32 gui` in the background, and note the work folder it prints.
2. Once Transfer's window is up (about 60 s), run `pnpm exec tsx tools/receive/uae/browse-demo.ts`. Create that file
   first:

```ts
// Shows Transfer's window answering the web app (spec 2026-10-30 §2.3): a VOLS and a DIR, so the status line reads
// "Web: listed Work:Up". uae-test.sh's gui mode starts Transfer with BROWSE.
// Usage: tsx tools/receive/uae/browse-demo.ts
import { connect } from '../fake-board';

const b = await connect(6800, '127.0.0.1', { v: 3 });
console.log(`READY 3 ${b.browse ? 1 : 0}`);
console.log((await b.request('VOLS demo1')).join('\n'));
console.log((await b.request('DIR demo2 7:Work:Up')).join('\n'));
console.log('capture now');
await new Promise((r) => setTimeout(r, 5000));
await b.close();
```

3. When it prints `capture now`, run
   `screencapture -o -l "$(swift tools/receive/uae/window-id.swift)" "$TMPDIR/transfer-2.3-window.png"` and Read the
   PNG. It must show:
   - the checkbox row "Let the web app browse my disks (read-only)", ticked;
   - nothing overlapping;
   - the status line "Web: listed Work:Up".
4. Put the PNG path in the report.
5. End the run with `touch <work folder>/stop`.

The demo connects with the default key. Lemmings.adf may start going up first; the requests wait behind it (as
specified), so allow for that in the timing. Raise the demo's timeouts if a request times out while the 900 KB file goes
up.

- [ ] **Step 5: The docs**

In `tools/receive/README.md`:
- The intro paragraph's first sentence gains: `… and sends files up to it (send); with browsing switched on, the web
  app can also read your disks (read-only).`
- The Shell bullet's command and template become:
  `Transfer [RECEIVE] [TO <folder>] [SAVE] [GUI] [SEND <files>] [TRUST] [BROWSE]` (template
  `TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S`).
- Add a bullet after "Sending to the web app":

```markdown
- **Browsing from the web app (protocol 3, spec 2026-10-30 §2):** with **Let the web app browse my disks (read-only)**
  ticked, or `Transfer BROWSE`, the web app's Files can list the Amiga's volumes and drawers (NET:) and copy files from
  them. The board asks with `VOLS`, `DIR` and `GET`; Transfer answers only the board it trusts, reads with shared locks,
  and never writes. A drawer lists its first 1000 entries. A disk taken out mid-read fails the request, without a
  requester. The status line (or one Shell line per request) shows what the web app read: "Web: listed Work:Programs".
  The switch is the file `ENVARC:webadf/Browse` (`1`/`0`, copied to `ENV:`): the checkbox stores it at once;
  `BROWSE` switches it on for one run, `BROWSE SAVE` stores it too, and the window switches it off. Off is the default.
  Changing it closes the board's connection when idle, so the board reconnects and learns it. Needs board firmware
  1.22 or newer.
```

- The testing block's `uae-test` usage line gains `|browse`.

In `tools/paulanet-disk/ReadMe`, the Transfer section:
- The Shell usage gains `[BROWSE]` on the RECEIVE line:
  `  Transfer RECEIVE [TO <folder>] [SAVE] [GUI] [TRUST] [BROWSE]`.
- Add this paragraph after the "Sending" paragraph:

```
Browsing (board firmware 1.22 or newer): tick Let the web app
browse my disks in the window, or use BROWSE, and the web app's
Files can show your disks under NET: and copy files from them.
Transfer only reads; nothing on the Amiga changes. BROWSE SAVE
keeps it on; untick the box to switch it off.
```

Keep the ReadMe's line width; it is about 64 columns.

- [ ] **Step 6: Pin the build**

```bash
bash tools/receive/build.sh tools/receive/dist/Transfer --pin
bash tools/receive/build.sh "$TMPDIR/Transfer-check"
```

Expected:
- the first prints `pinned`;
- the second prints `PASS pinned`, which shows the build is deterministic;
- `cmp "$TMPDIR/Transfer-check" tools/receive/dist/Transfer` is silent.

Then re-run `pnpm receive:uae 31 browse` once more on the pinned binary (`uae-test.sh` builds from the sources, which
are now the pinned ones). Expected: all PASS.

- [ ] **Step 7: The driver disk (plan ruling T10)**

```bash
bash tools/paulanet-disk/build.sh "$TMPDIR/PaulaNET.adf"
```

Expected:
- `PASS Transfer is the pinned binary`;
- then `FAIL: not the pinned disk (9f58337d…)`, with the new sha256 printed on the line before.

Write that sha256 to `tools/paulanet-disk/paulanet-disk.sha256`, then run the build again. Expected: it ends without
FAIL. Keep `$TMPDIR/PaulaNET.adf`: the controller stores it at merge, and the report names its path and sha256.

In `src/lib/paulanet-disk.ts`:
- `PAULANET_DISK_SHA256 = '<the new sha256>'`;
- `PAULANET_DISK_PREVIOUS = '9f58337d1a8bde3da2cce4fc26e97eed9ca77f9c16b12c58fea0373e898699fa'`, with its comment:
  `The driver disk before Transfer 2.3 (2026-10-30: browsing the Amiga's volumes from the web app): Transfer 2.2.`;
- `PAULANET_DISK_OLDER` becomes
  `[PAULANET_DISK_PREVIOUS, '36bce70c114ad2eff6cdbb720ffaeabdbf79856592211080b437f7ac3110f796', '6e799db55e95a52900bff0ea6e3155b7787a44bcd5c5371510522cff0d5820f9', '1ca4f4cb…', 'fb363d45…', '05170a83…']`,
  with the last three digests in full as today. Its comment's list gains "then the disk before Transfer 2.2 (Transfer
  2.1)" after PAULANET_DISK_PREVIOUS.

In `src/lib/paulanet-disk.test.ts`, update the test titled
`'serves and keeps the current disk and every older one, and nothing else (Transfer 2.2, 2026-10-22)'`:
- the title becomes `(Transfer 2.3, 2026-10-30)`;
- the `PAULANET_DISK_OLDER` expectation gains `'36bce70c…'` (in full) after `PAULANET_DISK_PREVIOUS`;
- the `PAULANET_DISK_PREVIOUS` expectation becomes `'9f58337d1a8bde3da2cce4fc26e97eed9ca77f9c16b12c58fea0373e898699fa'`.

Run: `pnpm vitest run src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts src/app/api/paulanet-disk`
Expected: all pass.

- [ ] **Step 8: HANDOFF**

In `HANDOFF.md` §4-net-volumes, add a dated sub-entry "Transfer 2.3 (2026-10-30, step 2 of spec §6)". Facts only:
- what shipped;
- the commits;
- the FS-UAE results per Kickstart;
- the window screenshot's path;
- the new build pin and driver disk sha256;
- plan rulings T1-T11, one line each;
- "Next: firmware 1.22.0 (spec §3), then the A500 bench (§7)".

Note that the driver disk is not yet in the disk store: the controller stores it before pushing master.

- [ ] **Step 9: Run everything once more**

Run: `pnpm receive:test && pnpm vitest run tools/receive/receive.int.test.ts src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add tools/receive/uae/uae-test.sh tools/receive/uae/browse-demo.ts tools/receive/README.md tools/paulanet-disk/ReadMe \
  tools/receive/receive.sha256 tools/receive/dist/Transfer tools/paulanet-disk/paulanet-disk.sha256 \
  src/lib/paulanet-disk.ts src/lib/paulanet-disk.test.ts HANDOFF.md
git commit -m "Transfer 2.3 pinned; FS-UAE browse mode passes on 2.04/3.1/3.2; driver disk <short sha> carries it (9f58337d becomes PREVIOUS)"
```

If `send-scenarios.ts` needed the version change from Step 3, add it to this commit by name.

---

## At merge (controller only, after the final review)

1. **Store the driver disk.** Run
   `pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts <Task 6's PaulaNET.adf>`.
   - Expected: `stored adf/<sha> … read back and verified`, or `already stored`.
   - The script refuses any bytes but the pinned disk. Do it before the e2e and before pushing: the production
     deployment serves the new digest as soon as it is live.
2. **Run e2e on the driver disk areas**, one run at a time on `PORT=3100`, each under 9 minutes:
   - `PORT=3100 bash scripts/e2e-local.sh e2e/device-image.spec.ts e2e/second-drive.spec.ts --project=desktop`;
   - then the same with `--project=mobile`;
   - expected: all pass.
3. **Merge to master and push.**
4. **Check CI with `gh run list`:** the `receive` workflow (host tests, POSIX integration, pin, `cmp` with
   `dist/Transfer`) and the `image` workflow (it builds the driver disk against the new pin) must both pass.
5. **Report to the operator:** the FS-UAE results, the window screenshot, the rulings and the deferred minors. Say that
   the next plan is firmware 1.22.0.
