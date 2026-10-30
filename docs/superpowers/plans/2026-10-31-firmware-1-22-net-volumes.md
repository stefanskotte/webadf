# Firmware 1.22.0 (NET: volumes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board fetches the web app's browse requests (VOLS, DIR, GET), passes them to Transfer 2.3 one at a time over protocol 3, and posts Transfer's answers back to the server in pieces, so Files can list and copy from the Amiga's own volumes.

**Architecture:** A new pure module `amiga_req.c` holds the request state (fetched lines, the answer piece's JSON body, the table of GETs answered `GOT`); `amiga_send.c` decides when each thing happens inside its existing engine (one HTTPS request per `as_step()`, cheap work in `as_tick()`); `device_client.c` gains the `req` poll cursor, the `reqAck`/`rxv`/`browse` poll parameters, and the two HTTPS calls. `main.c` and `amiga_tcp.c` wire it up with the state in PSRAM.

**Tech Stack:** C11 on RP2350 (pico-sdk, lwIP), host tests via `wifi-floppy/firmware/test/run.sh` (harness.h: `CHECK`, `CHECK_EQ_INT`, `RUN`, `REPORT`).

**Spec:** `docs/superpowers/specs/2026-10-30-net-volumes-design.md` (§3 Firmware 1.22.0; §2.2 for the protocol 3 lines Transfer sends; §6 step 3). Shipped against: server/web `69afa0b` (routes `GET /api/device/req`, `POST /api/device/req/<rid>`, poll `req`/`reqAck`/`rxv`/`browse`, upload open `request`), Transfer 2.3 `13e7b87`.

## Global Constraints

- Hello: with uploads and requests on, the board says `WEBADF 3 <key>`. Transfer 2.3 answers `READY 3 1` or `READY 3 0`; Transfer 2.2 answers `READY 2`; Receive 1 answers `READY 1`. `READY 3 …` counts only as the answer to a protocol 3 hello, `READY 2` only as the answer to a hello of protocol 2 or 3.
- Request lines (from `GET /api/device/req`, Latin-1, one per line, at most 8): `VOLS <rid>`, `DIR <rid> <len>:<path>`, `GET <rid> <len>:<path>`. `<rid>` is 1-40 characters of `[A-Za-z0-9_-]`; path 1-255 bytes.
- Answer lines (from Transfer): `VOL <rid> …`, `ENT <rid> …`, `DONE <rid> <count>[ cut]`, `ERR <rid> <code> <len>:<text>`, `GOT <rid> <tag>`. `DONE`, `ERR` and `GOT` end an answer.
- `POST /api/device/req/<rid>` body: `{"piece":<n>,"lines":["…",…],"last":<bool>}`. `lines` holds at most 400 strings of at most 640 characters each. Latin-1 bytes are escaped `\u00XX` (`as_json_escape`). Pieces count from 0. A repeated piece number is harmless. 2xx = taken; 400/404/409 = refused for good.
- The board must ack (`reqAck`) the `v` it saw in the poll BEFORE its fetch, never a later one (spec §3, final review 2026-10-30).
- One HTTPS request per `as_step()`, none from `as_tick()`.
- Requests go to Transfer one at a time, only on a protocol 3 connection. A file moving either way finishes first. Then requests go before queued downloads.
- The answer piece is a 32 KB JSON body (`AR_BODY_BYTES 32768` = `DC_POST_BODY_MAX`).
- After `GOT <rid> <tag>` the upload that follows with that tag opens with `"request":"<rid>"`. A late `ERR <rid> io|toolarge|off <len>:<text>` for an already-GOT GET is posted as that request's piece 1.
- Board-made errors, exactly these texts:
  - `ERR <rid> norx 36:Transfer is not running on the Amiga` (not connected);
  - `ERR <rid> norx 35:The connection to Transfer was lost` (dropped mid-answer or after GOT);
  - `ERR <rid> old 31:Transfer 2.3 or newer is needed` (`READY 2` or `READY 1`);
  - `ERR <rid> timeout 26:Transfer stopped answering` (30 s silent mid-answer, `AS_REQ_SILENT_MS 30000u`).
- Poll query: `&reqAck=<n>` on every poll once requests are on; `&rxv=<2|3>&browse=<0|1>` added while Transfer is connected at protocol 2 or 3. Both go after `&xferAck=…&rx=…` and before `&boot=…`.
- SRAM: `.data` + `.bss` of `build/wifi_floppy.elf` may grow by at most 128 bytes against master's build (the heap floor is 20,480 B). Every new buffer goes in PSRAM (`__uninitialized_psram`). `.psram_noload` must stay at most 8,388,608 bytes.
- `FIRMWARE_SEMVER` becomes `1.22.0`.
- `wifi-floppy/firmware/test/test_amiga_send.c` is Latin-1 (ISO-8859). Write new text in it in ASCII only, with byte escapes such as `"\xe9"` in strings. Read it with `grep -a` or `iconv -f latin1`.
- Host tests must also pass under Linux gcc (CI's compiler; clang on the Mac misses `-Wformat-truncation`):
  `docker run --rm -v "$PWD/wifi-floppy/firmware:/f" -w /f/test gcc:14 ./run.sh test_amiga_req.c test_amiga_send.c test_device_client.c`
- Repo rules:
  - Never `git add -A`; stage named files only.
  - Never `git stash`.
  - No commit attribution or trailers.
  - Never pattern-kill processes.
  - Subagents never touch production: no publish, no DB scripts.

## Review Focus

1. **A drawer of Latin-1 names larger than one piece:** every line arrives once and in order. No piece is over 32,768 bytes or 400 lines. The last piece ends `"last":true`. Task 3 `a_drawer_of_latin1_names_arrives_in_pieces_under_32k`.
2. **A PUT from Transfer's own queue that crosses a request:** the board must serve the PUT first. Transfer answers no request while its PUT waits for TAKE, so otherwise both sides wait 30 s and the connection drops. Task 3 `a_put_that_crosses_a_request_goes_first`.
3. **Transfer's switch flipped:** Transfer closes the idle connection (its ruling T1). The board reconnects within 5 s, and the poll reports the new `browse`. Task 3 `a_close_at_protocol_3_reconnects_in_5s_and_reports_browse`.
4. **The Amiga reset or Transfer quit mid-answer, or after GOT:** the pane learns at once. The answer ends `norx` "lost", and every GOT'd GET fails `norx`. Task 3 `a_dropped_connection_mid_answer_ends_norx_lost` and Task 4 `a_dropped_connection_fails_every_got_get`.
5. **The server refuses a piece (request replaced by Refresh, or cleaned up):** the rest of that answer is read and dropped, and the next request is still served. Task 4 `a_refused_piece_discards_the_rest_and_the_next_request_goes`.

## Rulings made while planning (relay to the operator)

- **F1:** Transfer's protocol and browse flag ride the poll (`rxv`, `browse`), not `/api/device/status`. The shipped server reads them there (`poll/route.ts`, `recordSendRx`); spec §3's "Status" line is superseded.
- **F2:** One piece is a 32 KB JSON body, as the spec says. `DC_POST_BODY_MAX` goes from 16384 to 32768; it only bounds the body sent from the caller's memory, so no SRAM is involved. A piece also closes at 400 lines (the server's limit).
- **F3:** A PUT pending on the board goes before any request. Transfer answers no request while its PUT waits for TAKE (`req_idle`), so a request sent then would deadlock. The 30 s silence clock stands still while an upload is pending or moving, and while a piece waits for its POST.
- **F4:** After a timeout the connection is dropped, because Transfer's state is unknown. It reconnects as usual.
- **F5:** When the connection drops, the answer in progress ends with `ERR <rid> norx …lost`. Every GET answered GOT whose file has not finished fails the same way, because Transfer drops a GET's file with the connection (its ruling T4). An upload of a GET's file refused with `NO` fails that GET: `toolarge` for `NO size`, otherwise `io` with the NO's text.
- **F6:** A piece refused with 400/404/409 drops the rest of that answer: its lines are read and discarded, and a GOT entry for it is removed. Other failures back off and retry the same piece.
- **F7:** The board-made error texts are those in Global Constraints.
- **F8:** A drop on a protocol 3 connection reconnects after 5 s (`AS_RETRY_WAITING_MS`), not the idle 30 s, so Transfer's switch shows quickly (Review Focus 3). Requests fetched while not connected wait for a reconnect due within 5 s. Otherwise they are answered `norx` at once.
- **F9:**
  - Requests are fetched only when the board holds none unrelayed.
  - The ack is the `v` captured before the fetch call.
  - `GET /api/device/req` is not retried over a stale socket (`retryable=false`). It changes server state, like `dc_post_send_done`.
- **F10:** The SRAM budget is 128 bytes; everything else goes in PSRAM.
- **F11:** Requests go to Transfer even when it said `READY 3 0`. Transfer answers `ERR <rid> off` itself (spec §2.3).
- **F12:** With Network mode off, or no Amiga address yet, nothing is fetched. Requests stay on the server and the pane's own 20 s wait applies.
- **F13:** The GOT table holds 8 entries. When it is full, the oldest is dropped without a post (the server's 10-minute GET timeout covers it).

---

### Task 1: The request state (`amiga_req.c`)

**Files:**
- Create: `wifi-floppy/firmware/src/amiga_req.h`
- Create: `wifi-floppy/firmware/src/amiga_req.c`
- Create: `wifi-floppy/firmware/test/test_amiga_req.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (line ~125: add `src/amiga_req.c` to `WFMF_FIRMWARE_SOURCES` beside `src/amiga_send.c`)

`test/run.sh` compiles every `src/*.c` into every test, so it picks up the new file without changes.

**Interfaces:**
- Consumes: `int as_json_escape(char *dst, int cap, const char *src, int n)` from `amiga_send.h` (existing).
- Produces: everything in `amiga_req.h` below. Task 3 and Task 4 use:
  - `as_req_t`
  - `ar_init`, `ar_fetched`, `ar_pending`, `ar_take`
  - `ar_body_add`, `ar_body_full`, `ar_body_close`, `ar_body_posted`
  - `ar_end_err`, `ar_finish`, `ar_line_verb`
  - `ar_got_add`, `ar_got_by_tag`, `ar_got_by_rid`, `ar_got_fail`, `ar_got_late`, `ar_got_owed`, `ar_late_body`, `ar_got_remove`
  - `AR_FETCH_BYTES`, `AR_BODY_BYTES`, `AR_LINE_MAX`, `AR_MAX`, `AR_RID_MAX`

- [ ] **Step 1: Write the header**

`wifi-floppy/firmware/src/amiga_req.h`:

```c
#ifndef AMIGA_REQ_H
#define AMIGA_REQ_H
// NET: volumes (spec docs/superpowers/specs/2026-10-30-net-volumes-design.md section 3; fw 1.22.0): the server's
// requests (VOLS, DIR, GET) reach Transfer through the board, and Transfer's answers come back as pieces. This is the
// pure part: the fetched request lines, the answer piece's JSON body, and the GETs answered GOT whose files have not
// finished. amiga_send.c decides when each happens. RULE: no pico-sdk or lwIP header here -- it is compiled into every
// host test.
#include <stdbool.h>
#include <stdint.h>

#define AR_RID_MAX 40                 // the server's request id: 1-40 of [A-Za-z0-9_-]
#define AR_MAX 8                      // = the server's fetch limit (remote-requests.ts takeWaiting)
#define AR_FETCH_BYTES 4096           // 8 lines of "GET <40> 255:<255>\n" (305 bytes each) with room to spare
#define AR_BODY_BYTES 32768           // one piece's JSON body (= DC_POST_BODY_MAX, plan ruling F2)
#define AR_PIECE_LINES 400            // = the server's lines.max(400)
#define AR_LINE_MAX 640               // = AS_LINE_MAX and the server's z.string().max(640)
#define AR_TAG_MAX 9                  // Transfer's tag: 1-9 decimal digits
#define AR_ERR_MAX 200                // "ERR <40> <code> <len>:<text>": Transfer's text is at most 79
#define AR_LATE_BYTES 1280            // a late ERR's whole body: AR_ERR_MAX escaped (x6) plus the frame

typedef enum { AR_NONE = 0, AR_VOLS, AR_DIR, AR_GET } ar_kind_t;

// A GET Transfer answered GOT: its file comes up later as an upload with this tag. err_owed: the GET failed after its
// GOT (Transfer's late ERR, the upload refused, the connection lost); `err` is the line to post as piece 1.
typedef struct ar_got {
    bool used, err_owed;
    uint32_t seq;                     // when it was added: the oldest goes when the table is full (plan ruling F13)
    char rid[AR_RID_MAX + 1];
    char tag[AR_TAG_MAX + 1];
    char err[AR_ERR_MAX + 1];
} ar_got_t;

// The board's request state. The caller's, in PSRAM on the board (main.c), like as_up_t.
typedef struct as_req {
    uint32_t want_v, have_v;          // the poll's req.v, and the v acked (the one seen before the last fetch)
    char fetched[AR_FETCH_BYTES + 1]; // request lines not yet taken: fetched_off .. fetched_len
    int fetched_len, fetched_off;
    // The request being answered (taken from `fetched`): sent to Transfer, or answered by the board itself.
    bool active, sent, ended, discard;   // ended: its last line is in; discard: the server refused a piece (F6)
    ar_kind_t kind;
    char rid[AR_RID_MAX + 1];
    char out[AR_LINE_MAX + 8];        // its line as it goes to Transfer, '\n'-terminated
    int out_n;
    uint32_t t_last;                  // it went out, or its last answer line came
    uint32_t lines_total;
    // The piece being gathered: {"piece":N,"lines":["..",..  then  ],"last":B} once closed.
    char body[AR_BODY_BYTES];
    int body_len, body_lines;
    uint32_t piece;
    bool post_owed, post_last;        // closed, waiting for its POST
    char end_err[AR_ERR_MAX + 1];     // an ERR that ends the answer once the piece in flight is posted
    ar_got_t got[AR_MAX];
    uint32_t got_seq;
    char late[AR_LATE_BYTES];         // a late ERR's body, built when it is posted
    bool browse;                      // READY 3's flag: Transfer's switch, for the poll
} as_req_t;

void ar_init(as_req_t *r);
// n bytes were fetched into r->fetched: kept, to be taken line by line.
void ar_fetched(as_req_t *r, int n);
bool ar_pending(const as_req_t *r);   // a fetched line waits to be taken
// Takes the next valid request line: active, kind, rid and out set, piece 0 begun. Malformed lines are skipped (and
// counted in *skipped when it is not NULL). False when none is left.
bool ar_take(as_req_t *r, int *skipped);
// The answer's piece. add: false when the line does not fit (never after !ar_body_full). full: a line of AR_LINE_MAX
// bytes might not fit. close: ends the JSON and marks it owed.
void ar_body_begin(as_req_t *r);
bool ar_body_add(as_req_t *r, const char *line);
bool ar_body_full(const as_req_t *r);
void ar_body_close(as_req_t *r, bool last);
// A piece was posted: the next piece begins (carrying end_err if one waits), or, after the last, the request ends.
void ar_body_posted(as_req_t *r);
// Ends the active answer with the board's own "ERR <rid> <code> <len>:<text>". No-op once ended; with discard set
// the request just finishes (nothing more is posted for it).
void ar_end_err(as_req_t *r, const char *code, const char *text);
void ar_finish(as_req_t *r);          // the request is done with: nothing more is posted for it
// "ERR <rid> <code> <len>:<text>" into out[cap]; the text is cut to 79 characters. Length, or -1.
int ar_err_line(char *out, int cap, const char *rid, const char *code, const char *text);
// A line from Transfer: its verb (VOL, ENT, DONE, ERR or GOT) and rid. False for any other line.
bool ar_line_verb(const char *line, char verb[5], char rid[AR_RID_MAX + 1]);
// The GOT table.
ar_got_t *ar_got_add(as_req_t *r, const char *rid, const char *tag);   // the oldest entry goes when it is full
ar_got_t *ar_got_by_tag(as_req_t *r, const char *tag);
ar_got_t *ar_got_by_rid(as_req_t *r, const char *rid);
void ar_got_fail(ar_got_t *g, const char *code, const char *text);    // once: a later failure keeps the first
void ar_got_late(ar_got_t *g, const char *line);                      // Transfer's own late ERR line, as it came
ar_got_t *ar_got_owed(const as_req_t *r);                             // the first entry whose ERR waits
int ar_late_body(as_req_t *r, const ar_got_t *g);                     // r->late = {"piece":1,"lines":[err],"last":true}
void ar_got_remove(ar_got_t *g);

#endif
```

- [ ] **Step 2: Write the failing tests**

`wifi-floppy/firmware/test/test_amiga_req.c`:

```c
// amiga_req.c: NET: volumes' request state (spec 2026-10-30 section 3, fw 1.22.0).
#include <stdio.h>
#include <string.h>
#include "harness.h"
#include "../src/amiga_req.h"

static as_req_t R;
static void load(const char *text) { ar_init(&R); int n = (int)strlen(text); memcpy(R.fetched, text, (size_t)n); ar_fetched(&R, n); }

static void takes_vols_dir_and_get_in_order(void) {
    load("VOLS r1\nDIR r_2 5:Work:\nGET r-3 13:Work:Hello.txt\n");
    CHECK(ar_pending(&R), "pending");
    CHECK(ar_take(&R, NULL), "first");
    CHECK(R.kind == AR_VOLS && strcmp(R.rid, "r1") == 0, R.rid);
    CHECK(strcmp(R.out, "VOLS r1\n") == 0 && R.out_n == 8, R.out);
    CHECK(R.active && !R.sent && !R.ended && R.piece == 0, "fresh request");
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[") == 0, R.body);
    ar_finish(&R);
    CHECK(ar_take(&R, NULL) && R.kind == AR_DIR && strcmp(R.rid, "r_2") == 0, "DIR");
    CHECK(strcmp(R.out, "DIR r_2 5:Work:\n") == 0, R.out);
    ar_finish(&R);
    CHECK(ar_take(&R, NULL) && R.kind == AR_GET && strcmp(R.out, "GET r-3 13:Work:Hello.txt\n") == 0, R.out);
    ar_finish(&R);
    CHECK(!ar_pending(&R) && !ar_take(&R, NULL), "none left");
}

// The board checks the line's shape only; AmigaDOS syntax ("Work" without a colon) is Transfer's to refuse.
static void malformed_lines_are_skipped_and_counted(void) {
    load("POST x\nVOLS\nVOLS a b\nVOLS bad!id\nDIR d 9:Work:\nDIR d 0:\nDIR d 3:a\x01" "b\n"
         "VOLS 01234567890123456789012345678901234567890\nGET g 4:Work\nVOLS ok\n");
    int bad = 0;
    CHECK(ar_take(&R, &bad), "the first valid line is found");
    CHECK(strcmp(R.rid, "g") == 0, R.rid);
    CHECK_EQ_INT(bad, 8);
    ar_finish(&R);
    CHECK(ar_take(&R, &bad) && strcmp(R.rid, "ok") == 0, "then the next");
}

static void a_last_line_without_newline_still_counts(void) {
    load("VOLS a");
    CHECK(ar_take(&R, NULL) && strcmp(R.out, "VOLS a\n") == 0, R.out);
}

static void a_piece_is_json_with_latin1_escaped(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    CHECK(ar_body_add(&R, "ENT d f 5 0 1.0.0 5:Caf\xe9 0:"), "add");
    CHECK(ar_body_add(&R, "DONE d 1"), "add");
    ar_body_close(&R, true);
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[\"ENT d f 5 0 1.0.0 5:Caf\\u00e9 0:\",\"DONE d 1\"],\"last\":true}") == 0, R.body);
    CHECK(R.body_len == (int)strlen(R.body), "length");
    CHECK(R.post_owed && R.post_last && R.ended, "owed, last");
}

static void quotes_and_backslashes_are_escaped(void) {
    load("VOLS v\n"); ar_take(&R, NULL);
    ar_body_add(&R, "a\"b\\c"); ar_body_close(&R, false);
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[\"a\\\"b\\\\c\"],\"last\":false}") == 0, R.body);
    CHECK(R.post_owed && !R.post_last && !R.ended, "owed, not last");
}

static void full_leaves_room_for_any_line(void) {
    char line[AR_LINE_MAX + 1];
    memset(line, 0xe9, AR_LINE_MAX); line[AR_LINE_MAX] = 0;          // every byte an escape: the worst line
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    int added = 0;
    while (!ar_body_full(&R)) { CHECK(ar_body_add(&R, line), "a line always fits while not full"); added++; if (added > 100) break; }
    ar_body_close(&R, false);
    CHECK(R.body_len < AR_BODY_BYTES, "inside the buffer");
    CHECK(added >= 8 && added <= 9, "about 32 KB / 3843 bytes");
    CHECK(strcmp(R.body + R.body_len - 15, "],\"last\":false}") == 0, "closed");
}

static void a_piece_holds_at_most_400_lines(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    for (int i = 0; i < AR_PIECE_LINES; i++) CHECK(ar_body_add(&R, "x"), "fits");
    CHECK(ar_body_full(&R), "full at 400");
    CHECK(!ar_body_add(&R, "x"), "line 401 refused");
}

static void after_a_middle_piece_the_next_begins(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    ar_body_add(&R, "ENT d 1"); ar_body_close(&R, false);
    ar_body_posted(&R);
    CHECK(!R.post_owed && R.active && R.piece == 1, "piece 1");
    CHECK(strcmp(R.body, "{\"piece\":1,\"lines\":[") == 0, R.body);
    ar_body_add(&R, "DONE d 1"); ar_body_close(&R, true);
    ar_body_posted(&R);
    CHECK(!R.active && !R.post_owed && R.kind == AR_NONE, "finished");
}

static void end_err_while_a_piece_is_in_flight_goes_in_the_next(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    ar_body_add(&R, "ENT d 1"); ar_body_close(&R, false);
    ar_end_err(&R, "norx", "The connection to Transfer was lost");
    CHECK(R.ended && R.post_owed && !R.post_last, "the piece in flight is unchanged");
    ar_body_posted(&R);
    CHECK(strcmp(R.body, "{\"piece\":1,\"lines\":[\"ERR d norx 35:The connection to Transfer was lost\"],\"last\":true}") == 0, R.body);
    CHECK(R.post_owed && R.post_last, "the ERR piece is owed, last");
    ar_end_err(&R, "timeout", "Transfer stopped answering");
    CHECK(strstr(R.body, "timeout") == NULL, "ended: a second end changes nothing");
}

static void end_err_with_room_closes_at_once(void) {
    load("VOLS v\n"); ar_take(&R, NULL);
    ar_end_err(&R, "norx", "Transfer is not running on the Amiga");
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[\"ERR v norx 36:Transfer is not running on the Amiga\"],\"last\":true}") == 0, R.body);
}

static void end_err_on_a_discarded_answer_just_finishes(void) {
    load("VOLS v\n"); ar_take(&R, NULL);
    R.discard = true;
    ar_end_err(&R, "norx", "x");
    CHECK(!R.active && !R.post_owed, "nothing more is posted");
}

static void err_line_cuts_the_text_at_79(void) {
    char t[120], out[AR_ERR_MAX + 1];
    memset(t, 'a', 100); t[100] = 0;
    int n = ar_err_line(out, sizeof out, "rid", "io", t);
    CHECK(n > 0 && strncmp(out, "ERR rid io 79:aaa", 17) == 0, out);
    CHECK_EQ_INT((int)strlen(out), 14 + 79);
    CHECK_EQ_INT(ar_err_line(out, 10, "rid", "io", "text"), -1);
}

static void line_verbs_and_rids(void) {
    char v[5], rid[AR_RID_MAX + 1];
    CHECK(ar_line_verb("VOL r1 9:Workbench 4:DH0: 1 2 3.4.5", v, rid) && !strcmp(v, "VOL") && !strcmp(rid, "r1"), "VOL");
    CHECK(ar_line_verb("ENT r1 f 1 0 1.0.0 1:a 0:", v, rid) && !strcmp(v, "ENT"), "ENT");
    CHECK(ar_line_verb("DONE r1 3 cut", v, rid) && !strcmp(v, "DONE"), "DONE");
    CHECK(ar_line_verb("ERR r1 off 3:off", v, rid) && !strcmp(v, "ERR"), "ERR");
    CHECK(ar_line_verb("GOT r1 7", v, rid) && !strcmp(v, "GOT") && !strcmp(rid, "r1"), "GOT");
    CHECK(ar_line_verb("ERR 11111111-2222-4333-8444-555555555555 write disk full", v, rid), "a download's ERR parses too");
    CHECK(!ar_line_verb("PONG", v, rid), "PONG");
    CHECK(!ar_line_verb("DONEX r1 1", v, rid), "DONEX");
    CHECK(!ar_line_verb("ERR  x", v, rid), "empty rid");
    CHECK(!ar_line_verb("GOT bad!rid 7", v, rid), "bad rid");
    CHECK(!ar_line_verb("PUT 1 5 1.2.3 0 1:a 0:", v, rid), "PUT");
}

static void got_table_ties_tag_and_rid(void) {
    ar_init(&R);
    ar_got_t *g = ar_got_add(&R, "g1", "7");
    CHECK(g && ar_got_by_tag(&R, "7") == g && ar_got_by_rid(&R, "g1") == g, "found both ways");
    CHECK(ar_got_by_tag(&R, "8") == NULL && ar_got_owed(&R) == NULL, "nothing else");
    ar_got_fail(g, "io", "Read error");
    ar_got_fail(g, "norx", "later");
    CHECK(g->err_owed && strcmp(g->err, "ERR g1 io 10:Read error") == 0, g->err);
    CHECK(ar_got_owed(&R) == g, "owed");
    int n = ar_late_body(&R, g);
    CHECK(strcmp(R.late, "{\"piece\":1,\"lines\":[\"ERR g1 io 10:Read error\"],\"last\":true}") == 0, R.late);
    CHECK_EQ_INT(n, (int)strlen(R.late));
    ar_got_remove(g);
    CHECK(ar_got_by_rid(&R, "g1") == NULL && ar_got_owed(&R) == NULL, "removed");
}

static void a_late_err_keeps_transfers_own_line(void) {
    ar_init(&R);
    ar_got_t *g = ar_got_add(&R, "g1", "7");
    ar_got_late(g, "ERR g1 toolarge 13:Too big: 5 MB");
    CHECK(g->err_owed && strcmp(g->err, "ERR g1 toolarge 13:Too big: 5 MB") == 0, g->err);
}

static void a_full_got_table_drops_the_oldest(void) {
    char rid[8], tag[4];
    ar_init(&R);
    for (int i = 0; i < AR_MAX; i++) { snprintf(rid, sizeof rid, "r%d", i); snprintf(tag, sizeof tag, "%d", i); ar_got_add(&R, rid, tag); }
    ar_got_add(&R, "new", "99");
    CHECK(ar_got_by_rid(&R, "r0") == NULL, "the oldest went");
    CHECK(ar_got_by_rid(&R, "r1") != NULL && ar_got_by_tag(&R, "99") != NULL, "the rest stay");
}

int main(void) {
    RUN(takes_vols_dir_and_get_in_order);
    RUN(malformed_lines_are_skipped_and_counted);
    RUN(a_last_line_without_newline_still_counts);
    RUN(a_piece_is_json_with_latin1_escaped);
    RUN(quotes_and_backslashes_are_escaped);
    RUN(full_leaves_room_for_any_line);
    RUN(a_piece_holds_at_most_400_lines);
    RUN(after_a_middle_piece_the_next_begins);
    RUN(end_err_while_a_piece_is_in_flight_goes_in_the_next);
    RUN(end_err_with_room_closes_at_once);
    RUN(end_err_on_a_discarded_answer_just_finishes);
    RUN(err_line_cuts_the_text_at_79);
    RUN(line_verbs_and_rids);
    RUN(got_table_ties_tag_and_rid);
    RUN(a_late_err_keeps_transfers_own_line);
    RUN(a_full_got_table_drops_the_oldest);
    return REPORT();
}
```

The eight bad lines in `malformed_lines_are_skipped_and_counted` are:
- an unknown verb;
- no rid;
- VOLS with a path;
- a bad rid character;
- a length field that disagrees with the text (9 against 5);
- an empty path;
- a control byte;
- a 41-character rid.

- [ ] **Step 3: Run them to see them fail**

Run: `wifi-floppy/firmware/test/run.sh test_amiga_req.c`
Expected: `COMPILE FAIL: test_amiga_req.c`, with undefined references to `ar_init` and the other functions.

- [ ] **Step 4: Write the implementation**

`wifi-floppy/firmware/src/amiga_req.c`:

```c
// NET: volumes' request state (fw 1.22.0). See amiga_req.h.
#include "amiga_req.h"
#include "amiga_send.h"   // as_json_escape
#include <stdio.h>
#include <string.h>

#define AR_CLOSE_RESERVE 16            // "],\"last\":false}" is 15

static void cpy(char *d, size_t cap, const char *s) { size_t k = strnlen(s, cap - 1); memcpy(d, s, k); d[k] = 0; }

void ar_init(as_req_t *r) { memset(r, 0, sizeof *r); }

void ar_fetched(as_req_t *r, int n) {
    if (n < 0) n = 0;
    if (n > AR_FETCH_BYTES) n = AR_FETCH_BYTES;
    r->fetched[n] = 0;
    r->fetched_len = n;
    r->fetched_off = 0;
}
bool ar_pending(const as_req_t *r) { return r->fetched_off < r->fetched_len; }

static bool rid_ok(const char *t, int n) {
    if (n < 1 || n > AR_RID_MAX) return false;
    for (int i = 0; i < n; i++) {
        const char c = t[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
    }
    return true;
}
// "<len>:<text>" filling exactly n bytes: text 1..255 bytes, no control byte.
static bool path_ok(const char *p, int n) {
    int d = 0;
    unsigned len = 0;
    while (d < n && d < 4 && p[d] >= '0' && p[d] <= '9') { len = len * 10u + (unsigned)(p[d] - '0'); d++; }
    if (d == 0 || d >= n || p[d] != ':' || len < 1 || len > 255 || (int)len != n - d - 1) return false;
    for (int i = d + 1; i < n; i++) if ((unsigned char)p[i] < 0x20 || (unsigned char)p[i] == 0x7f) return false;
    return true;
}

bool ar_take(as_req_t *r, int *skipped) {
    while (ar_pending(r)) {
        const char *l = r->fetched + r->fetched_off;
        const char *nl = memchr(l, '\n', (size_t)(r->fetched_len - r->fetched_off));
        const int n = nl ? (int)(nl - l) : r->fetched_len - r->fetched_off;
        r->fetched_off += n + (nl ? 1 : 0);
        ar_kind_t k = AR_NONE;
        int vl = 0;
        if (n > 5 && strncmp(l, "VOLS ", 5) == 0) { k = AR_VOLS; vl = 5; }
        else if (n > 4 && strncmp(l, "DIR ", 4) == 0) { k = AR_DIR; vl = 4; }
        else if (n > 4 && strncmp(l, "GET ", 4) == 0) { k = AR_GET; vl = 4; }
        const char *id = l + vl;
        const char *sp = k == AR_NONE ? NULL : memchr(id, ' ', (size_t)(n - vl));
        const int idn = sp ? (int)(sp - id) : n - vl;
        const bool ok = k != AR_NONE && n <= AR_LINE_MAX && rid_ok(id, idn) &&
                        (k == AR_VOLS ? sp == NULL : (sp != NULL && path_ok(sp + 1, n - vl - idn - 1)));
        if (!ok) { if (skipped) (*skipped)++; continue; }
        r->active = true; r->sent = false; r->ended = false; r->discard = false;
        r->kind = k;
        memcpy(r->rid, id, (size_t)idn); r->rid[idn] = 0;
        memcpy(r->out, l, (size_t)n); r->out[n] = '\n'; r->out[n + 1] = 0; r->out_n = n + 1;
        r->piece = 0; r->lines_total = 0; r->end_err[0] = 0; r->post_owed = false; r->post_last = false;
        ar_body_begin(r);
        return true;
    }
    return false;
}

void ar_body_begin(as_req_t *r) {
    r->body_len = snprintf(r->body, sizeof r->body, "{\"piece\":%lu,\"lines\":[", (unsigned long)r->piece);
    r->body_lines = 0;
}
// The line's length once escaped as as_json_escape does.
static int esc_len(const char *s) {
    int k = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        k += (*p == '"' || *p == '\\') ? 2 : (*p < 0x20 || *p >= 0x7f) ? 6 : 1;
    return k;
}
bool ar_body_add(as_req_t *r, const char *line) {
    const int need = esc_len(line) + 3;   // the quotes and a comma
    if (r->body_lines >= AR_PIECE_LINES || r->body_len + need + AR_CLOSE_RESERVE > AR_BODY_BYTES) return false;
    char *o = r->body + r->body_len;
    if (r->body_lines) *o++ = ',';
    *o++ = '"';
    o += as_json_escape(o, AR_BODY_BYTES - (int)(o - r->body), line, (int)strlen(line));
    *o++ = '"';
    *o = 0;
    r->body_len = (int)(o - r->body);
    r->body_lines++;
    r->lines_total++;
    return true;
}
bool ar_body_full(const as_req_t *r) {
    return r->body_lines >= AR_PIECE_LINES || r->body_len + AR_LINE_MAX * 6 + 3 + AR_CLOSE_RESERVE > AR_BODY_BYTES;
}
void ar_body_close(as_req_t *r, bool last) {
    r->body_len += snprintf(r->body + r->body_len, (size_t)(AR_BODY_BYTES - r->body_len), "],\"last\":%s}",
                            last ? "true" : "false");
    r->post_owed = true;
    r->post_last = last;
    if (last) r->ended = true;
}
void ar_finish(as_req_t *r) {
    r->active = r->sent = r->ended = r->discard = r->post_owed = r->post_last = false;
    r->kind = AR_NONE; r->rid[0] = 0; r->end_err[0] = 0; r->body_len = 0; r->body_lines = 0;
}
void ar_body_posted(as_req_t *r) {
    r->post_owed = false;
    if (r->post_last) { ar_finish(r); return; }
    r->piece++;
    ar_body_begin(r);
    if (r->end_err[0]) {
        (void)ar_body_add(r, r->end_err);   // an empty piece always takes one line
        r->end_err[0] = 0;
        ar_body_close(r, true);
    }
}
int ar_err_line(char *out, int cap, const char *rid, const char *code, const char *text) {
    const int tn = (int)strnlen(text, 79);
    const int n = snprintf(out, (size_t)cap, "ERR %s %s %d:%.*s", rid, code, tn, tn, text);
    return (n < 0 || n >= cap) ? -1 : n;
}
void ar_end_err(as_req_t *r, const char *code, const char *text) {
    char line[AR_ERR_MAX + 1];
    if (!r->active || r->ended) return;
    if (r->discard) { ar_finish(r); return; }
    if (ar_err_line(line, sizeof line, r->rid, code, text) < 0) return;
    r->ended = true;
    if (r->post_owed) { cpy(r->end_err, sizeof r->end_err, line); return; }
    if (!ar_body_add(r, line)) { ar_body_close(r, false); r->ended = true; cpy(r->end_err, sizeof r->end_err, line); return; }
    ar_body_close(r, true);
}

bool ar_line_verb(const char *line, char verb[5], char rid[AR_RID_MAX + 1]) {
    static const char *const V[] = { "VOL", "ENT", "DONE", "ERR", "GOT" };
    for (unsigned i = 0; i < sizeof V / sizeof V[0]; i++) {
        const size_t vl = strlen(V[i]);
        if (strncmp(line, V[i], vl) != 0 || line[vl] != ' ') continue;
        const char *id = line + vl + 1, *e = id;
        while (*e && *e != ' ') e++;
        if (!rid_ok(id, (int)(e - id))) return false;
        memcpy(verb, V[i], vl + 1);
        memcpy(rid, id, (size_t)(e - id)); rid[e - id] = 0;
        return true;
    }
    return false;
}

ar_got_t *ar_got_add(as_req_t *r, const char *rid, const char *tag) {
    ar_got_t *g = NULL;
    for (int i = 0; i < AR_MAX && !g; i++) if (!r->got[i].used) g = &r->got[i];
    if (!g) { g = &r->got[0]; for (int i = 1; i < AR_MAX; i++) if (r->got[i].seq < g->seq) g = &r->got[i]; }
    memset(g, 0, sizeof *g);
    g->used = true;
    g->seq = ++r->got_seq;
    cpy(g->rid, sizeof g->rid, rid);
    cpy(g->tag, sizeof g->tag, tag);
    return g;
}
ar_got_t *ar_got_by_tag(as_req_t *r, const char *tag) {
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used && strcmp(r->got[i].tag, tag) == 0) return &r->got[i];
    return NULL;
}
ar_got_t *ar_got_by_rid(as_req_t *r, const char *rid) {
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used && strcmp(r->got[i].rid, rid) == 0) return &r->got[i];
    return NULL;
}
void ar_got_fail(ar_got_t *g, const char *code, const char *text) {
    if (g->err_owed) return;
    if (ar_err_line(g->err, sizeof g->err, g->rid, code, text) >= 0) g->err_owed = true;
}
void ar_got_late(ar_got_t *g, const char *line) {
    if (g->err_owed || strlen(line) > AR_ERR_MAX) return;
    cpy(g->err, sizeof g->err, line);
    g->err_owed = true;
}
ar_got_t *ar_got_owed(const as_req_t *r) {
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used && r->got[i].err_owed) return (ar_got_t *)&r->got[i];
    return NULL;
}
int ar_late_body(as_req_t *r, const ar_got_t *g) {
    int o = snprintf(r->late, sizeof r->late, "{\"piece\":1,\"lines\":[\"");
    o += as_json_escape(r->late + o, (int)sizeof r->late - o - 20, g->err, (int)strlen(g->err));
    o += snprintf(r->late + o, sizeof r->late - (size_t)o, "\"],\"last\":true}");
    return o;
}
void ar_got_remove(ar_got_t *g) { memset(g, 0, sizeof *g); }
```

Add `src/amiga_req.c` to `CMakeLists.txt` line ~125:

```cmake
  list(APPEND WFMF_FIRMWARE_SOURCES src/amiga_send.c src/amiga_req.c src/amiga_tcp.c src/key_store.c)
```

- [ ] **Step 5: Run the tests**

Run: `wifi-floppy/firmware/test/run.sh test_amiga_req.c`
Expected: `test_amiga_req.c: N checks, 0 failed`.

- [ ] **Step 6: Run them under Linux gcc too**

Run: `docker run --rm -v "$PWD/wifi-floppy/firmware:/f" -w /f/test gcc:14 ./run.sh test_amiga_req.c`
Expected: `0 failed`, no compile warnings (`-Werror`).

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/amiga_req.h wifi-floppy/firmware/src/amiga_req.c wifi-floppy/firmware/test/test_amiga_req.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "fw 1.22 NET: volumes: amiga_req -- fetched requests, answer pieces as JSON, the GOT table"
```

---

### Task 2: The server side of the board (`device_client.c`)

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h`:
  - add the request fields to `device_client_t` after `_send_rx`;
  - add the `dc_*_req` API after `dc_set_send`;
  - `DC_POST_BODY_MAX` goes from 16384 to 32768.
- Modify: `wifi-floppy/firmware/src/device_client.c`:
  - `DC_POLL_REQ_BYTES`;
  - `dc_take_req`, called beside `dc_take_xfer` (line ~2269);
  - `dc_set_req`;
  - the poll path (line ~2140) and its request buffer (line ~2159);
  - `dc_get_text` replaces the body of `dc_fetch_send_queue`;
  - `dc_fetch_req` and `dc_post_req`.
- Modify: `wifi-floppy/firmware/test/transport_fake.c` (`FAKE_MAX_REQUEST_BYTES` from 20480 to 40960)
- Test: `wifi-floppy/firmware/test/test_device_client.c`

**Interfaces:**
- Produces (Task 5 wires these, Task 3's ops call the two HTTPS ones):
  - `int dc_fetch_req(device_client_t *c, char *buf, int cap)`
  - `int dc_post_req(device_client_t *c, const char *rid, const char *json, int n)`
  - `void dc_set_req(device_client_t *c, uint32_t acked_version, int proto, bool browse)`
  - fields `uint32_t req_version; bool req_seen;`

- [ ] **Step 1: Write the failing tests**

Add to `test/test_device_client.c` beside `send_poll_params_only_once_set`, and RUN them in `main()` after the send tests:

```c
// NET: volumes (fw 1.22.0): reqAck rides every poll once set; rxv and browse only while Transfer is connected.
static void req_poll_params_only_once_set(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "reqAck") == NULL, "an untouched board polls as 1.21 did");
    boot(); dc_set_send(&c, 4, 'u'); dc_set_req(&c, 5, 0, false);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "&xferAck=4&rx=u&reqAck=5 HTTP/1.1\r\n") != NULL, "reqAck after rx, no rxv while unconnected");
    boot(); dc_set_send(&c, 4, 'c'); dc_set_req(&c, 5, 3, true);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "&rx=c&reqAck=5&rxv=3&browse=1 HTTP/1.1\r\n") != NULL, "rxv and browse while connected");
    boot(); dc_set_send(&c, 4, 'c'); dc_set_req(&c, 5, 2, false);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "&reqAck=5&rxv=2&browse=0 HTTP/1.1\r\n") != NULL, "a Transfer 2.2 is reported as 2");
}

// The worst-case poll path with every parameter at its longest: it must be sent whole (path buffer 208, request 480).
static void the_worst_case_poll_with_req_is_sent_whole(void) {
    boot(); dc_set_df1(&c, DF1_MODE_OFF, false);
    c.since = 4294967295u; c.nfc_ack = 4294967295u; c.display_ack = 4294967295u;
    c.drive_ack = 4294967295u; c.df1_ack = 4294967295u;
    dc_set_send(&c, 4294967295u, 'u');
    dc_set_req(&c, 4294967295u, 3, true);
    dc_set_boot(&c, 0xffffffffu, true);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "&xferAck=4294967295&rx=u&reqAck=4294967295&rxv=3&browse=1&boot=ffffffff&ota=1 HTTP/1.1\r\n") != NULL,
          "every parameter, in order");
}

static void req_version_is_read_from_the_poll(void) {
    boot(); dc_set_req(&c, 0, 0, false);
    push_ok_json("{\"version\":3,\"desired\":null,\"req\":{\"v\":9}}");
    dc_step(&c);
    CHECK_EQ_INT(c.req_version, 9);
    CHECK(c.req_seen, "seen");
    push_ok_json("{\"version\":4,\"desired\":null}");
    dc_step(&c);
    CHECK_EQ_INT(c.req_version, 9);
}

static void fetch_req_gets_the_lines(void) {
    boot();
    char buf[64];
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\nVOLS a\nVOLS b\n");
    CHECK_EQ_INT(dc_fetch_req(&c, buf, sizeof buf), 14);
    CHECK(strstr(fake_last_request(), "GET /api/device/req HTTP/1.1\r\n") != NULL, fake_last_request());
    CHECK(memcmp(buf, "VOLS a\nVOLS b\n", 14) == 0, "the lines");
    fake_push_response("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    CHECK_EQ_INT(dc_fetch_req(&c, buf, sizeof buf), -1);
}

static void post_req_sends_the_piece(void) {
    boot();
    const char *json = "{\"piece\":0,\"lines\":[\"DONE r 0\"],\"last\":true}";
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK_EQ_INT(dc_post_req(&c, "r_1-x", json, (int)strlen(json)), 204);
    CHECK(strstr(fake_last_request(), "POST /api/device/req/r_1-x HTTP/1.1\r\n") != NULL, fake_last_request());
    CHECK(strstr(fake_last_request(), "application/json") != NULL, "json");
    CHECK(strstr(fake_last_request(), json) != NULL, "the body");
}

static void post_req_takes_a_32k_body(void) {
    boot();
    static char json[DC_POST_BODY_MAX + 1];
    memset(json, 'x', DC_POST_BODY_MAX); json[DC_POST_BODY_MAX] = 0;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK_EQ_INT(dc_post_req(&c, "r", json, DC_POST_BODY_MAX), 204);
    CHECK(strstr(fake_last_request(), "Content-Length: 32768\r\n") != NULL, "32 KB");
    CHECK_EQ_INT(dc_post_req(&c, "r", json, DC_POST_BODY_MAX + 1), -1);
}
```

Raise `FAKE_MAX_REQUEST_BYTES` in `test/transport_fake.c` from 20480 to 40960, so a 32 KB body plus its head fits the fake's capture.

- [ ] **Step 2: Run them to see them fail**

Run: `wifi-floppy/firmware/test/run.sh test_device_client.c`
Expected: `COMPILE FAIL`, with `dc_set_req`, `dc_fetch_req`, `dc_post_req` and `req_version` undeclared.

- [ ] **Step 3: Implement**

`device_client.h`, after `char _send_rx;`:

```c
    // --- NET: volumes (spec 2026-10-30 section 3, fw 1.22.0): the web app's requests to Transfer ---
    // The poll's req.v (the server's request cursor), 0 until a body carries it; req_seen once one has.
    uint32_t req_version;
    bool     req_seen;
    // What the next poll reports (dc_set_req): &reqAck=, and &rxv=&browse= while Transfer is connected at protocol 2
    // or 3 (plan ruling F1). Absent until dc_set_req is first called, so a board that cannot browse polls as 1.21.
    bool     _req_on;
    uint32_t _req_ack;
    uint8_t  _req_proto;
    bool     _req_browse;
```

`device_client.h`, after `void dc_set_send(...)`:

```c
// --- NET: volumes (fw 1.22.0; amiga_send.c drives these) ---
// GET /api/device/req: up to 8 request lines (Latin-1). Body length, or -1. Never retried over a stale connection:
// the server marks what it returns as sent (plan ruling F9).
int dc_fetch_req(device_client_t *c, char *buf, int cap);
// POST /api/device/req/<rid> with one answer piece's JSON (n bytes, 1..DC_POST_BODY_MAX). HTTP status, or -1.
int dc_post_req(device_client_t *c, const char *rid, const char *json, int n);
// What the next poll reports: &reqAck=<acked>, plus &rxv=<proto>&browse=<0|1> when proto is 2 or 3.
void dc_set_req(device_client_t *c, uint32_t acked_version, int proto, bool browse);
```

`device_client.h`, replace the `DC_POST_BODY_MAX` define and extend its comment:

```c
// NET: volumes (fw 1.22.0, plan ruling F2): an answer piece is a 32 KB JSON body, so 32768. Content-Length stays five
// digits, so DC_POST_HEAD_BYTES is unchanged; the body is the caller's (PSRAM), so this costs no SRAM.
#define DC_POST_BODY_MAX 32768
```

`device_client.c`, below `#define DC_REQ_BUF_BYTES 448`:

```c
// The poll's own request buffer (fw 1.22.0): &reqAck=4294967295&rxv=3&browse=1 adds 33 to the worst poll request
// (435 with &boot=ffffffff&ota=1), 468, so 480. Only the poll carries it: the other DC_REQ_BUF_BYTES users keep 448.
#define DC_POLL_REQ_BYTES 480
```

`device_client.c`, after `dc_take_xfer`:

```c
// NET: volumes (fw 1.22.0): lifts `req` ({"v":N}) out of a 200 poll body and BLANKS it before any flat lookup, as
// dc_take_xfer does. The server sends it on every body to a board that sends reqAck.
static void dc_take_req(device_client_t *c, char *json) {
    static char obj[24];   // {"v":4294967295} is 16; static: see the STACK note
    if (!json_object(json, "req", obj, sizeof obj, true)) return;
    uint32_t v;
    if (!json_u32_strict(obj, "v", &v)) return;
    c->req_version = v;
    c->req_seen = true;
}
```

Call it on the line after `dc_take_xfer(c, body.buf);`:

```c
        dc_take_req(c, body.buf);            // NET: volumes: lifted and blanked first, like xfer
```

`device_client.c`, after `dc_set_send`:

```c
void dc_set_req(device_client_t *c, uint32_t acked_version, int proto, bool browse) {
    c->_req_on = true;
    c->_req_ack = acked_version;
    c->_req_proto = (proto == 2 || proto == 3) ? (uint8_t)proto : 0;
    c->_req_browse = browse;
}
```

In the poll (line ~2140):
- change `static char path[176];` to `static char path[208];`;
- extend the comment above it with `&reqAck=4294967295&rxv=3&browse=1 (fw 1.22.0) 199.`;
- after the `_send_on` block, insert:

```c
    plen = (int)strnlen(path, sizeof path);
    if (c->_req_on && plen > 0 && plen < (int)sizeof path) {
        snprintf(path + plen, sizeof path - (size_t)plen, "&reqAck=%lu", (unsigned long)c->_req_ack);
        plen = (int)strnlen(path, sizeof path);
        if (c->_req_proto && plen < (int)sizeof path)
            snprintf(path + plen, sizeof path - (size_t)plen, "&rxv=%u&browse=%u",
                     (unsigned)c->_req_proto, c->_req_browse ? 1u : 0u);
    }
```

Change the poll's `static char req[DC_REQ_BUF_BYTES];` (line ~2159, the one before `http_build_request(req, sizeof req, "GET", path, …)` in the poll) to `static char req[DC_POLL_REQ_BYTES];`.

Replace `dc_fetch_send_queue`'s body with a shared helper, so no new request buffer is added:

```c
// One GET whose body is text, into buf (cap bytes). Body length, or -1. retryable=false for a request the server acts
// on (GET /api/device/req marks its lines sent): a lost answer is not asked again over a fresh socket.
static int dc_get_text(device_client_t *c, const char *path, char *buf, int cap, bool retryable) {
    if (!buf || cap <= 0) return -1;
    static char req[DC_REQ_BUF_BYTES];   // static: see the STACK note above
    int req_len = http_build_request(req, sizeof req, "GET", path, c->host_header, c->token, NULL);
    if (req_len < 0) return -1;
    dc_bytes_sink_t s = { (uint8_t *)buf, cap, 0 };
    static http_resp_t r;
    bool ok = dc_exchange(c, req, req_len, dc_bytes_sink, &s, &r, retryable);
    if (!ok || !r.body_complete) return -1;
    if (r.status == 401) { c->state = DC_HALTED; return -1; }   // 401 anywhere halts
    if (r.status != 200 || (r.content_length >= 0 && r.content_length > cap)) return -1;
    return s.len;
}

int dc_fetch_send_queue(device_client_t *c, char *buf, int cap) {
    return dc_get_text(c, "/api/device/send/queue", buf, cap, /*retryable=*/true);
}
int dc_fetch_req(device_client_t *c, char *buf, int cap) {
    return dc_get_text(c, "/api/device/req", buf, cap, /*retryable=*/false);
}
```

After `dc_upload_close` (it uses `s_up_path`, declared just above):

```c
int dc_post_req(device_client_t *c, const char *rid, const char *json, int n) {
    int pn = snprintf(s_up_path, sizeof s_up_path, "/api/device/req/%s", rid);
    if (pn < 0 || pn >= (int)sizeof s_up_path || n <= 0) return -1;
    return dc_post(c, s_up_path, "application/json", (const uint8_t *)json, n, NULL, 0);
}
```

- [ ] **Step 4: Run the tests**

Run: `wifi-floppy/firmware/test/run.sh test_device_client.c`
Expected: `0 failed`. That includes the existing `post_sends_a_16k_body_from_the_callers_memory` and `send_poll_params_only_once_set`.

- [ ] **Step 5: Linux gcc**

Run: `docker run --rm -v "$PWD/wifi-floppy/firmware:/f" -w /f/test gcc:14 ./run.sh test_device_client.c`
Expected: `0 failed`, no warnings.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c wifi-floppy/firmware/test/test_device_client.c wifi-floppy/firmware/test/transport_fake.c
git commit -m "fw 1.22 NET: volumes: the req cursor, reqAck/rxv/browse on the poll, GET /api/device/req and POST /api/device/req/<rid>"
```

---

### Task 3: The relay in `amiga_send.c`: protocol 3, fetch, answers, board-made errors

**Files:**
- Modify: `wifi-floppy/firmware/src/amiga_send.h`
- Modify: `wifi-floppy/firmware/src/amiga_send.c`
- Test: `wifi-floppy/firmware/test/test_amiga_send.c` (Latin-1 file: ASCII only in new text)

**Interfaces:**
- Consumes: Task 1's `amiga_req.h` (everything listed there).
- Produces (Task 4 and Task 5):
  - `void as_set_req(amiga_send_t *s, as_req_t *r)`
  - `void as_set_req_version(amiga_send_t *s, uint32_t v)`
  - `bool as_req_capable(const amiga_send_t *s)`
  - `uint32_t as_req_acked(const amiga_send_t *s)`
  - `int as_rx_proto(const amiga_send_t *s)`
  - `bool as_browse(const amiga_send_t *s)`
  - ops `fetch_req` and `post_req` at the END of `as_ops_t`
  - field `as_req_t *req` at the END of `amiga_send_t`
  - static helpers `up_busy`, `req_end_drop` (used by Task 4)

- [ ] **Step 1: Extend the test fake and write the failing tests**

In `test/test_amiga_send.c`, add these fields to the fake `F` (before `uint32_t now;`):

```c
    // NET: volumes (fw 1.22.0)
    char reqs[AR_FETCH_BYTES + 1]; int req_status; int req_fetches;   // what GET /api/device/req returns next
    char req_rid[12][48]; char req_body[12][AR_BODY_BYTES + 1]; int req_posts; int req_post_status;
```

Add the two fake ops after `f_raw_arm`, and append them to `OPS`:

```c
static int f_req_fetch(void *c, char *buf, int cap) {
    (void)c; F.req_fetches++;
    if (F.req_status) return -1;
    int n = (int)strlen(F.reqs); if (n > cap) return -1;
    memcpy(buf, F.reqs, (size_t)n); F.reqs[0] = 0;          // the server marks them sent
    return n;
}
static int f_req_post(void *c, const char *rid, const char *json, int n) {
    (void)c;
    int i = F.req_posts < 12 ? F.req_posts : 11;
    snprintf(F.req_rid[i], sizeof F.req_rid[i], "%s", rid);
    memcpy(F.req_body[i], json, (size_t)n); F.req_body[i][n] = 0;
    F.req_posts++;
    return F.req_post_status ? F.req_post_status : 204;   // -1: a transport failure
}
static const as_ops_t OPS = { NULL, f_connect, f_state, f_send, f_recv, f_close, f_queue, f_chunk, f_post, f_now, f_up_open, f_up_chunk, f_up_close, f_raw_arm, f_req_fetch, f_req_post };
```

The helpers and tests go after the protocol 2 helpers (`KEY`, `ready2`, `amiga_sends`, `end_line`, `PUT5` must be defined above them):

```c
// --- NET: volumes (spec 2026-10-30 section 3, fw 1.22.0) ---
static as_req_t RQ;
// Connected to Transfer 2.3 (READY 3 <browse>), the queue empty, nothing fetched yet.
static void ready3(int browse) {
    fresh();
    as_set_key(&S, KEY);
    as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply(browse ? "READY 3 1" : "READY 3 0"); run(2);
    clear_out();
}
// The poll said req.v = v, and GET /api/device/req will return these lines.
static void wake(uint32_t v, const char *lines) { snprintf(F.reqs, sizeof F.reqs, "%s", lines); as_set_req_version(&S, v); }

static void the_hello_is_protocol_3_with_requests(void) {
    fresh(); as_set_key(&S, KEY); as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    char want[64]; snprintf(want, sizeof want, "WEBADF 3 %s\n", KEY);
    CHECK(strcmp(F.out, want) == 0, F.out);
    CHECK_EQ_INT(as_rx_proto(&S), 0);
    reply("READY 3 1"); run(2);
    CHECK_EQ_INT(as_rx_proto(&S), 3); CHECK(as_browse(&S), "browsing on");
    CHECK(as_req_capable(&S), "capable");
    ready3(0);
    CHECK_EQ_INT(as_rx_proto(&S), 3); CHECK(!as_browse(&S), "browsing off");
}

static void without_requests_the_hello_stays_2(void) {
    ready2();
    CHECK(!as_req_capable(&S), "not capable");
    CHECK_EQ_INT(as_rx_proto(&S), 2); CHECK(!as_browse(&S), "no browse");
    fresh(); as_set_req(&S, &RQ);                       // no key, so no uploads: requests stay off too
    as_set_key(&S, "not-hex");
    CHECK(as_req_capable(&S), "state given");
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, F.out);
}

static void a_ready_3_to_a_protocol_2_hello_counts_as_1(void) {
    fresh(); as_set_key(&S, KEY);                       // uploads, no requests: WEBADF 2
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 3 1"); run(2);
    CHECK_EQ_INT(as_rx_proto(&S), 1);                   // not READY 2 either: read as Receive 1, as 1.21 does
}

static void transfer_2_2_answers_ready_2_and_requests_get_old(void) {
    fresh(); as_set_key(&S, KEY); as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 2"); run(2);
    CHECK_EQ_INT(as_rx_proto(&S), 2);
    clear_out();
    wake(1, "VOLS a\n"); run(4);
    CHECK(strstr(F.out, "VOLS") == NULL, "never sent to a 2.2");
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ERR a old 31:Transfer 2.3 or newer is needed\"],\"last\":true}") == 0, F.req_body[0]);
    CHECK(!RQ.active, "done");
}

static void vols_is_relayed_and_answered_in_one_piece(void) {
    ready3(1);
    wake(1, "VOLS r1\n"); run(3);
    CHECK_EQ_INT(F.req_fetches, 1);
    CHECK_EQ_INT(as_req_acked(&S), 1);
    CHECK(strcmp(F.out, "VOLS r1\n") == 0, F.out);
    CHECK(as_has_work(&S), "work while an answer is awaited (no long poll)");
    reply("VOL r1 9:Workbench 4:DH0: 1000 500 17000.0.0");
    reply("DONE r1 1");
    run(3);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_rid[0], "r1") == 0, F.req_rid[0]);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"VOL r1 9:Workbench 4:DH0: 1000 500 17000.0.0\",\"DONE r1 1\"],\"last\":true}") == 0, F.req_body[0]);
    CHECK(!RQ.active && !as_has_work(&S), "idle after");
}

static void the_ack_is_the_v_seen_before_the_fetch(void) {
    ready3(1);
    wake(5, "VOLS a\nVOLS b\n"); run(2);
    CHECK_EQ_INT(as_req_acked(&S), 5);
    as_set_req_version(&S, 6);                          // the server bumped again (requests remain): not fetched yet
    run(2);
    CHECK_EQ_INT(F.req_fetches, 1);                     // the board still holds b: no fetch while it does
    CHECK_EQ_INT(as_req_acked(&S), 5);
    reply("DONE a 0"); run(3);
    CHECK(strstr(F.out, "VOLS b\n") != NULL, "b next");
    reply("DONE b 0"); run(4);
    CHECK_EQ_INT(F.req_fetches, 2);                     // now empty: fetched for 6
    CHECK_EQ_INT(as_req_acked(&S), 6);
}

static void requests_go_one_at_a_time_in_order(void) {
    ready3(1);
    wake(1, "VOLS a\nDIR b 5:Work:\n"); run(3);
    CHECK(strcmp(F.out, "VOLS a\n") == 0, F.out);
    run(3);
    CHECK(strstr(F.out, "DIR") == NULL, "b waits for a's answer");
    reply("DONE a 0"); run(3);
    CHECK(strstr(F.out, "DIR b 5:Work:\n") != NULL, F.out);
}

// Review Focus 1.
static void a_drawer_of_latin1_names_arrives_in_pieces_under_32k(void) {
    char name[31], com[80], line[300];
    memset(name, 0xe9, 30); name[30] = 0; memset(com, 0xe9, 79); com[79] = 0;
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    const int N = 100;
    for (int i = 0; i < N; ) {
        for (int k = 0; k < 10 && i < N; k++, i++) {
            snprintf(line, sizeof line, "ENT d f %d 0 1.0.0 30:%s 79:%s", i, name, com);
            reply(line);
        }
        run(2);
    }
    reply("DONE d 100"); run(6);
    CHECK(F.req_posts >= 3, "several pieces");
    int ents = 0;
    for (int p = 0; p < F.req_posts && p < 12; p++) {
        char head[32]; snprintf(head, sizeof head, "{\"piece\":%d,\"lines\":[", p);
        CHECK(strncmp(F.req_body[p], head, strlen(head)) == 0, F.req_body[p]);
        CHECK(strlen(F.req_body[p]) <= AR_BODY_BYTES, "inside 32 KB");
        const bool last = p == F.req_posts - 1;
        CHECK(strcmp(F.req_body[p] + strlen(F.req_body[p]) - (last ? 14 : 15), last ? "],\"last\":true}" : "],\"last\":false}") == 0, "closed");
        for (const char *q = F.req_body[p]; (q = strstr(q, "\"ENT d f ")) != NULL; q++) ents++;
    }
    CHECK_EQ_INT(ents, N);
    CHECK(strstr(F.req_body[F.req_posts - 1], "\"DONE d 100\"") != NULL, "DONE in the last piece");
    for (int p = 0, want = 0; p < F.req_posts; p++) {      // in order: each piece's first ENT continues the count
        char first[40]; snprintf(first, sizeof first, "\"ENT d f %d 0 ", want);
        if (strstr(F.req_body[p], "\"ENT d f ")) CHECK(strstr(F.req_body[p], first) == strstr(F.req_body[p], "\"ENT d f "), first);
        for (const char *q = F.req_body[p]; (q = strstr(q, "\"ENT d f ")) != NULL; q++) want++;
    }
}

static void a_piece_closes_at_400_lines(void) {
    char line[64];
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    for (int i = 0; i < 450; ) {
        for (int k = 0; k < 10 && i < 450; k++, i++) { snprintf(line, sizeof line, "ENT d f 1 0 1.0.0 3:%03d 0:", i); reply(line); }
        run(2);
    }
    reply("DONE d 450"); run(4);
    CHECK_EQ_INT(F.req_posts, 2);
    CHECK(strstr(F.req_body[0], "3:399") != NULL && strstr(F.req_body[0], "3:400") == NULL, "400 lines in piece 0");
    CHECK(strstr(F.req_body[1], "{\"piece\":1,") == F.req_body[1] && strstr(F.req_body[1], "3:400") != NULL, "the rest in piece 1");
}

static void lines_wait_in_the_socket_while_a_piece_cannot_post(void) {
    char line[64];
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    F.req_post_status = -1;                             // the server is unreachable
    for (int i = 0; i < 400; ) {
        for (int k = 0; k < 10 && i < 400; k++, i++) { snprintf(line, sizeof line, "ENT d f 1 0 1.0.0 3:%03d 0:", i); reply(line); }
        run(2);
    }
    reply("ENT d f 1 0 1.0.0 3:400 0:"); run(3);
    CHECK(F.in_head != F.in_tail, "line 401 still in the socket");
    F.req_post_status = 0; F.now += 2000; run(3);
    CHECK(F.in_head == F.in_tail, "read once the piece posted");
    reply("DONE d 401"); run(3);
    CHECK(strstr(F.req_body[F.req_posts - 1], "3:400") != NULL, "line 401 kept");
}

static void norx_when_transfer_is_not_connected(void) {
    fresh(); as_set_key(&S, KEY); as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2);
    F.sock = AS_SOCK_REFUSED; run(1);                   // Transfer not running: 30 s to the next try
    wake(1, "VOLS a\n"); run(3);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ERR a norx 36:Transfer is not running on the Amiga\"],\"last\":true}") == 0, F.req_body[0]);
}

// Review Focus 3 (plan ruling F8).
static void a_close_at_protocol_3_reconnects_in_5s_and_reports_browse(void) {
    ready3(1);
    CHECK(as_browse(&S), "on");
    F.recv_closed = true; run(1);                       // Transfer's switch changed: it closed the idle connection
    CHECK_EQ_INT(as_rx_proto(&S), 0); CHECK(!as_browse(&S), "unknown while closed");
    wake(1, "VOLS a\n"); run(3);
    CHECK_EQ_INT(F.req_posts, 0);                       // a reconnect is due in 5 s: the request waits for it
    F.recv_closed = false; F.now += AS_RETRY_WAITING_MS + 100; run(2);
    CHECK_EQ_INT(F.connects, 2);
    F.sock = AS_SOCK_OPEN; run(1); reply("READY 3 0"); run(3);
    CHECK(!as_browse(&S), "the new flag");
    CHECK(strstr(F.out, "VOLS a\n") != NULL, "relayed after the reconnect");
}

static void silent_transfer_mid_answer_is_timeout_and_drops(void) {
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    reply("ENT d f 1 0 1.0.0 1:a 0:"); run(2);
    F.now += AS_REQ_SILENT_MS - 1; run(2);
    CHECK_EQ_INT(F.req_posts, 0); CHECK(F.sock == AS_SOCK_OPEN, "not yet");
    F.now += 2; run(3);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped (plan ruling F4)");
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ENT d f 1 0 1.0.0 1:a 0:\",\"ERR d timeout 26:Transfer stopped answering\"],\"last\":true}") == 0, F.req_body[0]);
}

// Review Focus 4.
static void a_dropped_connection_mid_answer_ends_norx_lost(void) {
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    reply("ENT d f 1 0 1.0.0 1:a 0:"); run(2);
    F.recv_closed = true; run(3);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ENT d f 1 0 1.0.0 1:a 0:\",\"ERR d norx 35:The connection to Transfer was lost\"],\"last\":true}") == 0, F.req_body[0]);
}

static void a_request_waits_behind_a_moving_download(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    ready3(1);
    snprintf(F.queue, sizeof F.queue, "%s", q); as_set_inputs(&S, true, 0xAC100AEDu, 2); run(3);
    memcpy(F.file, "hello", 5); F.file_len = 5;
    char want[120]; snprintf(want, sizeof want, "FILE %s", ID);
    CHECK(strstr(F.out, want) != NULL, "the download started");
    wake(1, "VOLS a\n"); run(3);
    CHECK_EQ_INT(F.req_fetches, 0);                     // not even fetched while a file moves
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go); run(3);
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 5:Hello", ID); reply(ok);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    run(6);
    CHECK(strstr(F.out, "VOLS a\n") != NULL, "after the file");
}

static void a_request_goes_before_a_queued_download(void) {
    char q[600];
    ready3(1);
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    snprintf(F.queue, sizeof F.queue, "%s", q);
    as_set_inputs(&S, true, 0xAC100AEDu, 2);
    wake(1, "VOLS a\n");
    run(4);
    CHECK(strstr(F.out, "VOLS a\n") != NULL, "the request went");
    char want[120]; snprintf(want, sizeof want, "FILE %s", ID);
    CHECK(strstr(F.out, want) == NULL, "the download waits for the answer");
    reply("DONE a 0"); run(4);
    CHECK(strstr(F.out, want) != NULL, "then the download");
}

// Review Focus 2 (plan ruling F3).
static void a_put_that_crosses_a_request_goes_first(void) {
    ready3(1);
    wake(1, "VOLS a\n"); run(3);
    CHECK(strcmp(F.out, "VOLS a\n") == 0, F.out);
    reply(PUT5); run(2);                                 // Transfer sent its PUT before it read VOLS
    CHECK_EQ_INT(F.opens, 1);
    CHECK(strstr(F.out, "TAKE 1 0 5\n") != NULL, "the upload goes while the request waits");
    F.now += AS_REQ_SILENT_MS + 5000; run(2);           // no timeout while the upload moves
    CHECK(F.sock == AS_SOCK_OPEN && F.req_posts == 0, "still open");
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK_EQ_INT(F.closes, 1);
    reply("DONE a 0"); run(3);                          // then Transfer answers the request
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strstr(F.req_body[0], "\"DONE a 0\"") != NULL, F.req_body[0]);
}

static void browse_off_still_relays_and_transfer_says_off(void) {   /* plan ruling F11 */
    ready3(0);
    wake(1, "VOLS a\n"); run(3);
    CHECK(strcmp(F.out, "VOLS a\n") == 0, F.out);
    reply("ERR a off 34:Browsing is off in Transfer (A500)"); run(3);
    CHECK(strstr(F.req_body[0], "\"ERR a off 34:") != NULL, F.req_body[0]);
}

static void a_failing_fetch_backs_off(void) {
    ready3(1);
    F.req_status = 1; wake(1, "VOLS a\n"); run(2);
    CHECK_EQ_INT(F.req_fetches, 1);
    CHECK_EQ_INT(as_req_acked(&S), 0);                  // not acked: fetched again
    run(3);
    CHECK_EQ_INT(F.req_fetches, 1);                     // backing off
    F.req_status = 0; F.now += 1100; run(3);
    CHECK_EQ_INT(F.req_fetches, 2); CHECK_EQ_INT(as_req_acked(&S), 1);
}
```

RUN all of these in `main()`, in the order written, after the existing RUNs.

- [ ] **Step 2: Run them to see them fail**

Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c`
Expected: `COMPILE FAIL`, with `as_set_req`, `as_set_req_version`, `as_rx_proto` and the others undeclared, and too many initializers for `as_ops_t`.

- [ ] **Step 3: Implement: the header**

`amiga_send.h`:
- add `#include "amiga_req.h"` after the stdint include;
- after `AS_BACKOFF_MAX_MS` add:

```c
// NET: volumes (spec 2026-10-30 section 3, fw 1.22.0).
#define AS_REQ_SILENT_MS 30000u      // Transfer silent this long mid-answer: ERR timeout, and the connection goes (F4)
```

At the END of `as_ops_t` (after `raw_arm`):

```c
    // NET: volumes (fw 1.22.0). Each is one HTTPS request.
    int  (*fetch_req)(void *ctx, char *buf, int cap);                       // body length, <0 = failed
    int  (*post_req)(void *ctx, const char *rid, const char *json, int n);  // http status, <0 = failed
```

At the END of `amiga_send_t`:

```c
    as_req_t *req;                   // the caller's (PSRAM); NULL: no browsing (the hello stays protocol 2)
```

Update the field comments: `hello_v`: "the hello this connection sent: 1, 2 or 3"; `peer_v`: "3 only in answer to our protocol 3 hello".

After `as_put_json`'s declaration, change its signature and add the request API:

```c
// The open's JSON: {"size":..,"date":"..","protection":..,"path":"..","comment":".."[,"request":".."]}; request: the
// GET this file answers (NULL: none; [A-Za-z0-9_-] only). Length, or -1 if it cannot fit.
int as_put_json(const as_put_t *p, const char *request, char *json, int cap);

// NET: volumes (spec 2026-10-30 section 3). The request state (PSRAM on the board), only with uploads (as_init's up):
// the hello becomes protocol 3 and the poll says reqAck. NULL: no browsing.
void as_set_req(amiga_send_t *s, as_req_t *r);
void as_set_req_version(amiga_send_t *s, uint32_t req_version);   // the poll's req.v, every pass
bool as_req_capable(const amiga_send_t *s);
uint32_t as_req_acked(const amiga_send_t *s);                      // the poll's reqAck
int as_rx_proto(const amiga_send_t *s);                            // Transfer's protocol on the open connection, 0 = none
bool as_browse(const amiga_send_t *s);                             // READY 3's browse flag
```

Update the two existing `as_put_json(&p, json, sizeof json)` calls in `test/test_amiga_send.c` (lines ~536 and ~551) to `as_put_json(&p, NULL, json, sizeof json)`. Update the one in `up_open` in Step 4.

- [ ] **Step 4: Implement: `amiga_send.c`**

4a. Below the includes:

```c
_Static_assert(AR_LINE_MAX == AS_LINE_MAX, "an answer line is a line from Transfer");
#define AS_TXT_NORX "Transfer is not running on the Amiga"
#define AS_TXT_LOST "The connection to Transfer was lost"
#define AS_TXT_OLD "Transfer 2.3 or newer is needed"
#define AS_TXT_SILENT "Transfer stopped answering"
static void req_on_drop(amiga_send_t *s);
```

4b. `drop()`:
- first line: `if (s->req) req_on_drop(s);`;
- before `s->peer_v = 0;` add `const bool quick = up_cut || (s->req && s->peer_v >= 3);   // plan ruling F8: Transfer's switch shows quickly`;
- change the `t_retry` line to `s->t_retry = now(s) + (quick ? AS_RETRY_WAITING_MS : retry_ms(s));`.

4c. `as_put_json` with the request:

```c
int as_put_json(const as_put_t *p, const char *request, char *json, int cap) {
    int o = snprintf(json, (size_t)cap, "{\"size\":%lu,\"date\":\"%s\",\"protection\":%lu,\"path\":\"",
                     (unsigned long)p->size, p->date, (unsigned long)p->prot);
    if (o < 0 || o >= cap) return -1;
    const int rn = request ? (int)strnlen(request, AR_RID_MAX + 1) : 0;
    if (rn > AR_RID_MAX) return -1;
    if (p->path_n * 6 + p->comment_n * 6 + rn + o + 34 > cap) return -1;   // never cut a name; ",\"request\":\"\"" is 14
    o += as_json_escape(json + o, cap - o, p->path, p->path_n);
    int k = snprintf(json + o, (size_t)(cap - o), "\",\"comment\":\"");
    if (k < 0 || o + k >= cap) return -1;
    o += k;
    o += as_json_escape(json + o, cap - o, p->comment, p->comment_n);
    k = request ? snprintf(json + o, (size_t)(cap - o), "\",\"request\":\"%.*s\"}", rn, request)
                : snprintf(json + o, (size_t)(cap - o), "\"}");
    if (k < 0 || o + k >= cap) return -1;
    return o + k;
}
```

In `up_open`, `as_put_json(&p, u->json, sizeof u->json)` becomes `as_put_json(&p, NULL, u->json, sizeof u->json)`. Task 4 fills in the request.

4d. The hello in `case AS_CONNECTING:`:

```c
            if (s->up && s->up->key[0]) {   // protocol 2 (fw 1.19.0): uploads; protocol 3 (fw 1.22.0): requests too
                s->hello_v = s->req ? 3 : 2;
                int n = snprintf(s->up->line, sizeof s->up->line, "WEBADF %u %s\n", (unsigned)s->hello_v, s->up->key);
                push(s, (const uint8_t *)s->up->line, n);
            } else {
```

4e. READY in `case AS_HELLO:`. Replace the `s->peer_v = …` line and the log:

```c
                // Receive 1 says READY 1 to anything; READY 2 counts only as the answer to a protocol 2 or 3 hello
                // (Transfer 2.2 answers a protocol 3 hello READY 2), READY 3 <0|1> only as the answer to protocol 3.
                const char *v = s->line + 6;
                if (s->hello_v == 3 && v[0] == '3' && v[1] == ' ' && (v[2] == '0' || v[2] == '1') && v[3] == 0) {
                    s->peer_v = 3;
                    s->req->browse = v[2] == '1';
                } else {
                    s->peer_v = (s->hello_v >= 2 && v[0] == '2' && v[1] == 0) ? 2 : 1;
                }
                s->phase = AS_READY;
                s->rx = 'c';
                s->list_owed = true;
                s->t_ping = t;
                wf_logf(WF_INFO, "send: receiver connected %lu.%lu.%lu.%lu protocol %u%s", (unsigned long)(s->ip >> 24),
                        (unsigned long)((s->ip >> 16) & 255), (unsigned long)((s->ip >> 8) & 255), (unsigned long)(s->ip & 255),
                        (unsigned)s->peer_v, s->peer_v == 3 ? (s->req->browse ? ", browsing on" : ", browsing off") : "");
```

4f. The request section, after `up_close` and before `run`:

```c
// --- NET: volumes (spec 2026-10-30 section 3, fw 1.22.0) --------------------------------------------------------------
static bool up_busy(const amiga_send_t *s) { return s->up && (s->up->pending || up_moving(s)); }
static bool req_fetch_owed(const amiga_send_t *s) {
    const as_req_t *r = s->req;
    return r->want_v != r->have_v && !ar_pending(r) && !file_moving(s);   // plan ruling F9
}
// A reconnect is due within 5 s: a request waits for it rather than being answered norx (plan ruling F8).
static bool reconnect_soon(const amiga_send_t *s, uint32_t t) {
    return (int32_t)(s->t_retry - t) <= (int32_t)AS_RETRY_WAITING_MS;
}
static bool req_work(const amiga_send_t *s) {
    const as_req_t *r = s->req;
    return r->post_owed || ar_got_owed(r) != NULL || r->active || req_fetch_owed(s) ||
           (ar_pending(r) && (s->phase == AS_IDLE || s->phase == AS_READY));
}
static void req_log_take(int bad) { if (bad) wf_logf(WF_WARN, "req: %d malformed request lines skipped", bad); }

// At most one HTTPS request: an answer piece, then a late ERR, then the fetch.
static bool req_http(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    if (in_backoff(s)) return false;
    if (r->post_owed) {
        int st = s->ops->post_req(s->ops->ctx, r->rid, r->body, r->body_len);
        if (st >= 200 && st < 300) {
            s->backoff_ms = 0;
            if (r->post_last) wf_logf(WF_INFO, "req: %.8s answered, %lu lines in %lu pieces", r->rid,
                                      (unsigned long)r->lines_total, (unsigned long)r->piece + 1);
            ar_body_posted(r);
            r->t_last = t;
        } else if (st == 400 || st == 404 || st == 409) {
            // Refused for good (the request is gone, replaced by a Refresh, or failed): nothing more is posted for it,
            // and the rest of its answer is read and dropped (plan ruling F6).
            wf_logf(WF_WARN, "req: %.8s piece %lu refused (%d)", r->rid, (unsigned long)r->piece, st);
            ar_got_t *g = ar_got_by_rid(r, r->rid);
            if (g) ar_got_remove(g);
            if (r->post_last) ar_finish(r);
            else { r->post_owed = false; r->discard = true; r->t_last = t; }
            s->backoff_ms = 0;
        } else {
            http_failed(s, "answer", st);
        }
        return true;
    }
    ar_got_t *g = ar_got_owed(r);
    if (g) {
        int n = ar_late_body(r, g);
        int st = s->ops->post_req(s->ops->ctx, g->rid, r->late, n);
        if ((st >= 200 && st < 300) || st == 400 || st == 404 || st == 409) {
            s->backoff_ms = 0;
            wf_logf(WF_INFO, "req: %.8s failed after GOT (%d)", g->rid, st);
            ar_got_remove(g);
        } else {
            http_failed(s, "late answer", st);
        }
        return true;
    }
    if (req_fetch_owed(s)) {
        const uint32_t v = r->want_v;   // the v the poll said, BEFORE the fetch (spec section 3): that is the ack
        int n = s->ops->fetch_req(s->ops->ctx, r->fetched, AR_FETCH_BYTES);
        if (n < 0) { http_failed(s, "requests", n); return true; }
        s->backoff_ms = 0;
        ar_fetched(r, n);
        r->have_v = v;
        return true;
    }
    return false;
}

// Requests the board answers itself (spec section 3): Transfer not connected, and no reconnect due within 5 s.
static bool req_board(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    int bad = 0;
    if (r->active || !ar_pending(r) || s->phase != AS_IDLE || reconnect_soon(s, t)) return false;
    const bool took = ar_take(r, &bad);
    req_log_take(bad);
    if (!took) return bad > 0;
    wf_logf(WF_INFO, "req: %.8s norx", r->rid);
    ar_end_err(r, "norx", AS_TXT_NORX);
    return true;
}

// In READY, when the arbitration gives requests the turn: the next request goes to Transfer (or, to a Transfer older
// than 2.3, is answered "old" by the board).
static bool req_start(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    int bad = 0;
    if (r->active || s->out_n > 0 || up_busy(s)) return false;   // a waiting PUT goes first (plan ruling F3)
    const bool took = ar_take(r, &bad);
    req_log_take(bad);
    if (!took) return false;
    if (s->peer_v < 3) {
        wf_logf(WF_INFO, "req: %.8s old (Transfer protocol %u)", r->rid, (unsigned)s->peer_v);
        ar_end_err(r, "old", AS_TXT_OLD);
        return true;
    }
    push(s, (const uint8_t *)r->out, r->out_n);
    r->sent = true;
    r->t_last = t;
    wf_logf(WF_INFO, "req: %.*s", r->out_n - 1 > 80 ? 80 : r->out_n - 1, r->out);
    if (!flush(s)) drop(s, 'u', "send");
    return true;
}

// Before reading the next line: false while the piece being gathered cannot take one more. It is closed and waits for
// its POST, and Transfer's lines wait in the socket meanwhile: its own buffer paces the drawer scan (spec section 2.2).
static bool req_room(amiga_send_t *s) {
    as_req_t *r = s->req;
    if (!r || !r->active || !r->sent || r->ended || r->discard) return true;
    if (r->post_owed) return false;
    if (ar_body_full(r)) { ar_body_close(r, false); return false; }
    return true;
}

// A line of Transfer's: true when it belonged to a request (consumed).
static bool req_line(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    char verb[5], rid[AR_RID_MAX + 1];
    if (!ar_line_verb(s->line, verb, rid)) return false;
    if (r->active && r->sent && !r->ended && strcmp(rid, r->rid) == 0) {
        const bool end = !strcmp(verb, "DONE") || !strcmp(verb, "ERR") || !strcmp(verb, "GOT");
        r->t_last = t;
        if (r->discard) { if (end) ar_finish(r); return true; }
        (void)ar_body_add(r, s->line);       // req_room made room for any line before it was read
        if (end) ar_body_close(r, true);
        return true;
    }
    return false;   // a download's ERR, or a line for an answer already ended: the usual handling
}

// Transfer silent mid-answer (spec section 3): ERR timeout, and the connection goes (plan ruling F4). The clock
// stands still while an upload is pending or moving (Transfer answers after it, ruling F3) and while a piece waits.
static bool req_silent(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    if (!r || !r->active || !r->sent || r->ended) return false;
    if (up_busy(s) || r->post_owed) { r->t_last = t; return false; }
    if ((int32_t)(t - r->t_last) <= (int32_t)AS_REQ_SILENT_MS) return false;
    wf_logf(WF_WARN, "req: %.8s timeout", r->rid);
    ar_end_err(r, "timeout", AS_TXT_SILENT);
    drop(s, 'u', "request timeout");
    return true;
}

// The connection went: the answer in progress ends "lost" (plan ruling F5). Task 4 adds the GOT table here.
static void req_on_drop(amiga_send_t *s) {
    as_req_t *r = s->req;
    if (r->active && r->sent) ar_end_err(r, "norx", AS_TXT_LOST);
    r->browse = false;
}

void as_set_req(amiga_send_t *s, as_req_t *r) { s->req = s->up ? r : NULL; if (s->req) ar_init(s->req); }
void as_set_req_version(amiga_send_t *s, uint32_t v) { if (s->req) s->req->want_v = v; }
bool as_req_capable(const amiga_send_t *s) { return s->req != NULL; }
uint32_t as_req_acked(const amiga_send_t *s) { return s->req ? s->req->have_v : 0; }
int as_rx_proto(const amiga_send_t *s) { return s->phase >= AS_READY ? s->peer_v : 0; }
bool as_browse(const amiga_send_t *s) { return s->req && as_rx_proto(s) == 3 && s->req->browse; }
```

`up_moving` and `file_moving` are defined above `up_reset`; keep this section below them. `in_backoff` and `http_failed` are defined earlier too.

4g. `as_has_work`, extend the return:

```c
    return s->done_owed || file_moving(s) || s->phase == AS_CONNECTING || s->phase == AS_HELLO
        || (fetch_owed(s) && !file_moving(s))
        || (s->phase == AS_READY && (s->list_owed || s->out_n > 0 || next_present(s) || (s->up && s->up->pending)))
        || (s->req && req_work(s));
```

`req_work` is defined below `as_has_work`. Add a forward declaration `static bool req_work(const amiga_send_t *s);` at the top with the others.

4h. `run()`. After the `done_owed` block, before the queue fetch:

```c
    // NET: volumes: an answer piece, a late ERR or the fetch -- before the send queue (someone waits in a browser).
    if (http && s->req && req_http(s, t)) return true;
```

Just before `int sock = s->ops->sock_state(s->ops->ctx);`:

```c
    if (s->req && req_board(s, t)) return true;
```

In the line loop: put the room check BEFORE `recv_line`, and route request lines right after the PONG check:

```c
    for (;;) {
        if (s->req && !req_room(s)) break;   // a full piece waits for its POST: the lines wait in the socket
        int r = s->ops->recv_line(s->ops->ctx, s->line, sizeof s->line);
        if (r < 0) { drop(s, 'u', "closed"); return true; }
        if (r == 0) break;
        moved = true;
        if (strcmp(s->line, "PONG") == 0) { s->ping_out = false; continue; }
        if (s->req && req_line(s, t)) continue;
```

After the loop, before `switch (s->phase) {` (the second switch):

```c
    if (req_silent(s, t)) return true;
```

In `case AS_READY:`, inside the arbitration block, make the request turn come after the PUT turn and before the download:

```c
            if (s->up && s->up->pending && !(s->up_last && (down || unsure))) {
                ... unchanged ...
            }
            // NET: volumes: a request goes before a download -- someone waits in a browser (spec section 3) -- but
            // never before a waiting PUT (req_start checks it, ruling F3); and a download waits for an answer.
            if (s->req && req_start(s, t)) return true;
            if (down && !(s->req && s->req->active)) { s->up_last = false; start_file(s); if (!flush(s)) drop(s, 'u', "send"); return true; }
```

The old `if (down) { … }` line is replaced by the last line above.

- [ ] **Step 5: Run the tests**

Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c`
Expected: `0 failed`: every existing test and every new one.

If `a_put_that_crosses_a_request_goes_first` fails because `req_start` saw the PUT too late (the request was sent in the same pass the PUT arrived), that is the crossing the test models. The fix belongs in the engine, never in the test.

- [ ] **Step 6: Linux gcc**

Run: `docker run --rm -v "$PWD/wifi-floppy/firmware:/f" -w /f/test gcc:14 ./run.sh test_amiga_req.c test_amiga_send.c`
Expected: `0 failed`, no warnings.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/amiga_send.h wifi-floppy/firmware/src/amiga_send.c wifi-floppy/firmware/test/test_amiga_send.c
git commit -m "fw 1.22 NET: volumes: protocol 3 hello, requests fetched and relayed one at a time, answers posted in pieces, norx/old/timeout"
```

---

### Task 4: GET: GOT ties the upload; late ERRs; failures after GOT

**Files:**
- Modify: `wifi-floppy/firmware/src/amiga_send.c` (`req_line`, `req_on_drop`, `up_no`, `up_open`, `up_close`)
- Test: `wifi-floppy/firmware/test/test_amiga_send.c`

**Interfaces:**
- Consumes:
  - Task 1's GOT table (`ar_got_add`, `ar_got_by_tag`, `ar_got_by_rid`, `ar_got_fail`, `ar_got_late`, `ar_got_remove`);
  - Task 3's `req_line`, `req_on_drop`, `as_put_json(p, request, json, cap)`, `ready3`, `wake`;
  - the test helpers `amiga_sends`, `end_line`.
- Produces: the upload open's `"request":"<rid>"`; late ERR posts as piece 1.

- [ ] **Step 1: Write the failing tests**

Append after Task 3's tests in `test/test_amiga_send.c`, and RUN them in `main()`:

```c
static const char *PUT7 = "PUT 7 5 1.2.3 0 9:Hello.txt 0:";
// Transfer answered GET g1 with GOT g1 7: piece 0 posted.
static void got(void) {
    ready3(1);
    wake(1, "GET g1 13:Work:Hello.txt\n"); run(3);
    CHECK(strcmp(F.out, "GET g1 13:Work:Hello.txt\n") == 0, F.out);
    reply("GOT g1 7"); run(3);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"GOT g1 7\"],\"last\":true}") == 0, F.req_body[0]);
    CHECK(!RQ.active, "GOT ends the answer");
    clear_out();
}

static void got_ties_the_upload_to_the_request(void) {
    got();
    reply(PUT7); run(1);
    CHECK_EQ_INT(F.opens, 1);
    const char *tail = "\"comment\":\"\",\"request\":\"g1\"}";
    CHECK(strlen(F.open_json) > strlen(tail) && strcmp(F.open_json + strlen(F.open_json) - strlen(tail), tail) == 0, F.open_json);
    amiga_sends("hello", 5); end_line("7", (const uint8_t *)"hello", 5); run(4);
    CHECK_EQ_INT(F.closes, 1);
    CHECK_EQ_INT(F.req_posts, 1);                        // the server settles the GET when the upload closes
    CHECK(ar_got_by_rid(&RQ, "g1") == NULL, "the entry went with the upload");
    CHECK(!as_has_work(&S), "idle after");
}

static void an_upload_not_from_a_get_carries_no_request(void) {
    ready3(1);
    reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 1);
    CHECK(strstr(F.open_json, "request") == NULL, F.open_json);
}

static void a_late_err_after_got_is_posted_as_piece_1(void) {
    got();
    reply("ERR g1 io 14:Read error 205"); run(3);
    CHECK_EQ_INT(F.req_posts, 2);
    CHECK(strcmp(F.req_rid[1], "g1") == 0, F.req_rid[1]);
    CHECK(strcmp(F.req_body[1], "{\"piece\":1,\"lines\":[\"ERR g1 io 14:Read error 205\"],\"last\":true}") == 0, F.req_body[1]);
    CHECK(ar_got_by_rid(&RQ, "g1") == NULL, "removed once posted");
}

static void a_late_err_survives_a_failing_post(void) {
    got();
    F.req_post_status = -1;
    reply("ERR g1 io 14:Read error 205"); run(3);
    CHECK_EQ_INT(F.req_posts, 2);
    CHECK(ar_got_by_rid(&RQ, "g1") != NULL, "kept for the retry");
    F.req_post_status = 0; F.now += 1100; run(3);
    CHECK_EQ_INT(F.req_posts, 3);
    CHECK(ar_got_by_rid(&RQ, "g1") == NULL, "posted, removed");
}

static void a_get_upload_refused_too_large_fails_the_get(void) {
    got();
    reply("PUT 7 5000000 1.2.3 0 9:Hello.txt 0:"); run(3);
    CHECK(strstr(F.out, "NO 7 size") != NULL, F.out);
    CHECK_EQ_INT(F.req_posts, 2);
    CHECK(strcmp(F.req_body[1], "{\"piece\":1,\"lines\":[\"ERR g1 toolarge 29:file too large (4 MB at most)\"],\"last\":true}") == 0, F.req_body[1]);
}

static void a_get_upload_refused_by_the_server_fails_the_get_io(void) {
    got();
    F.open_status = 409; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"full\"}");
    reply(PUT7); run(3);
    CHECK(strstr(F.out, "NO 7 full") != NULL, F.out);
    CHECK(strstr(F.req_body[1], "\"ERR g1 io ") != NULL, F.req_body[1]);
}

// Review Focus 4 (plan ruling F5).
static void a_dropped_connection_fails_every_got_get(void) {
    ready3(1);
    wake(1, "GET g1 6:Work:a\nGET g2 6:Work:b\n"); run(3);
    reply("GOT g1 7"); run(3);
    reply("GOT g2 8"); run(3);
    CHECK_EQ_INT(F.req_posts, 2);
    F.recv_closed = true; run(6);
    CHECK_EQ_INT(F.req_posts, 4);
    CHECK(strcmp(F.req_body[2], "{\"piece\":1,\"lines\":[\"ERR g1 norx 35:The connection to Transfer was lost\"],\"last\":true}") == 0
          || strcmp(F.req_body[2], "{\"piece\":1,\"lines\":[\"ERR g2 norx 35:The connection to Transfer was lost\"],\"last\":true}") == 0, F.req_body[2]);
    CHECK(strcmp(F.req_rid[2], F.req_rid[3]) != 0, "one post each");
}

static void a_get_answered_err_has_no_entry(void) {
    ready3(1);
    wake(1, "GET g1 6:Work:a\n"); run(3);
    reply("ERR g1 notfound 16:Object not found"); run(3);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ERR g1 notfound 16:Object not found\"],\"last\":true}") == 0, F.req_body[0]);
    CHECK(ar_got_by_rid(&RQ, "g1") == NULL, "no GOT, no entry");
}

// Review Focus 5 (plan ruling F6).
static void a_refused_piece_discards_the_rest_and_the_next_request_goes(void) {
    char line[64];
    ready3(1);
    wake(1, "DIR d 5:Work:\nVOLS v\n"); run(3);
    F.req_post_status = 404;
    for (int i = 0; i < 420; ) {
        for (int k = 0; k < 10 && i < 420; k++, i++) { snprintf(line, sizeof line, "ENT d f 1 0 1.0.0 3:%03d 0:", i); reply(line); }
        run(2);
    }
    reply("DONE d 420"); run(4);
    CHECK_EQ_INT(F.req_posts, 1);                       // piece 0 refused; the rest read and dropped
    CHECK(F.in_head == F.in_tail, "every line read");
    F.req_post_status = 0;
    CHECK(strstr(F.out, "VOLS v\n") != NULL, "the next request went");
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c`
Expected: FAIL in these new tests. The open JSON has no `request`, no late posts are made, and no GOT entries exist.

- [ ] **Step 3: Implement**

`req_line`: when the active GET's GOT arrives, add the entry; route a late ERR by rid. Replace Task 3's `req_line` body with:

```c
static bool req_line(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    char verb[5], rid[AR_RID_MAX + 1];
    if (!ar_line_verb(s->line, verb, rid)) return false;
    if (r->active && r->sent && !r->ended && strcmp(rid, r->rid) == 0) {
        const bool got = !strcmp(verb, "GOT");
        const bool end = got || !strcmp(verb, "DONE") || !strcmp(verb, "ERR");
        r->t_last = t;
        if (r->discard) { if (end) ar_finish(r); return true; }
        if (got && r->kind == AR_GET) {
            // "GOT <rid> <tag>": the file comes up later as the upload with this tag (spec section 3, GET).
            const char *tag = s->line + 4 + strlen(rid) + 1;
            const size_t tn = strlen(tag);
            bool ok = tn >= 1 && tn <= AR_TAG_MAX;
            for (size_t i = 0; ok && i < tn; i++) ok = tag[i] >= '0' && tag[i] <= '9';
            if (ok) ar_got_add(r, rid, tag);
        }
        (void)ar_body_add(r, s->line);       // req_room made room for any line before it was read
        if (end) ar_body_close(r, true);
        return true;
    }
    if (!strcmp(verb, "ERR")) {
        // After GOT (spec section 3): Transfer's late ERR for a GET already answered, routed by its rid.
        ar_got_t *g = ar_got_by_rid(r, rid);
        if (g) { ar_got_late(g, s->line); wf_logf(WF_INFO, "req: %.8s failed after GOT", rid); return true; }
    }
    return false;   // a download's ERR, or a line for an answer already ended: the usual handling
}
```

`req_on_drop`: every GOT'd GET fails too:

```c
// The connection went: the answer in progress ends "lost", and every GET answered GOT whose file has not finished
// fails the same way -- Transfer drops a GET's file with the connection (its ruling T4; plan ruling F5).
static void req_on_drop(amiga_send_t *s) {
    as_req_t *r = s->req;
    if (r->active && r->sent) ar_end_err(r, "norx", AS_TXT_LOST);
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used) ar_got_fail(&r->got[i], "norx", AS_TXT_LOST);
    r->browse = false;
}
```

`up_no`: a GET's upload refused fails that GET. Add at the end of `up_no`:

```c
    // A GET's file refused (spec section 3, After GOT; plan ruling F5): toolarge for a file over 4 MB, io otherwise.
    ar_got_t *g = s->req ? ar_got_by_tag(s->req, u->tag) : NULL;
    if (g) ar_got_fail(g, strcmp(code, "size") == 0 ? "toolarge" : "io", text);
```

`up_open`: the open carries the request. Before the `as_put_json` call:

```c
    const ar_got_t *g = s->req ? ar_got_by_tag(s->req, u->tag) : NULL;   // a GET's file: tied to its request
```

and change the call to `as_put_json(&p, g ? g->rid : NULL, u->json, sizeof u->json)`. In the success log line, add `g ? " for a request" : ""` as a final `%s`.

`up_close`, on success, before `up_reset(s);`:

```c
        ar_got_t *g = s->req ? ar_got_by_tag(s->req, u->tag) : NULL;
        if (g) ar_got_remove(g);   // the server settles the GET when the upload closes
```

- [ ] **Step 4: Run the tests**

Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c test_amiga_req.c`
Expected: `0 failed` in both.

- [ ] **Step 5: Linux gcc**

Run: `docker run --rm -v "$PWD/wifi-floppy/firmware:/f" -w /f/test gcc:14 ./run.sh test_amiga_req.c test_amiga_send.c test_device_client.c`
Expected: `0 failed`, no warnings.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/amiga_send.c wifi-floppy/firmware/test/test_amiga_send.c
git commit -m "fw 1.22 NET: volumes: GOT ties the GET to its upload; late ERRs, refused uploads and drops fail it as piece 1"
```

---

### Task 5: Wire it on the board, 1.22.0, build, and docs

**Files:**
- Modify: `wifi-floppy/firmware/src/amiga_tcp.c` (two HTTPS wrappers, and `amiga_tcp_ops`)
- Modify: `wifi-floppy/firmware/src/main.c`:
  - a PSRAM `g_send_req` beside `g_send_up` (line ~100);
  - the PSRAM check and `as_set_req` (lines ~2252-2261);
  - per pass, `as_set_req_version` and `dc_set_req` (lines ~2466-2473).
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (`FIRMWARE_SEMVER "1.22.0"`, line ~273)
- Modify: `docs/superpowers/specs/2026-10-30-net-volumes-design.md` (§3: rulings F1, F2, F3, F5, F8 as amendments)
- Modify: `HANDOFF.md` (§4-net-volumes: the firmware 1.22.0 entry)

**Interfaces:**
- Consumes:
  - Task 2's `dc_fetch_req`, `dc_post_req`, `dc_set_req`, `c.req_version`;
  - Task 3's `as_set_req`, `as_set_req_version`, `as_req_capable`, `as_req_acked`, `as_rx_proto`, `as_browse`, and the ops `fetch_req` and `post_req`.

- [ ] **Step 1: Baseline sizes from master**

Run, from a checkout of master's HEAD:

```bash
git -C /Users/sfs/Devel/webadf worktree list
```

Measure master in a scratch worktree, so the branch's build directory is not disturbed:

```bash
git -C /Users/sfs/Devel/webadf worktree add /private/tmp/claude-501/fw-base master
cd /private/tmp/claude-501/fw-base/wifi-floppy/firmware && cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 >/dev/null && cmake --build build >/dev/null && arm-none-eabi-size -A build/wifi_floppy.elf | grep -E '^\.(data|bss|psram_noload) '
```

Expected: three lines (`.data`, `.bss`, `.psram_noload`). Write them in the report as BASE. Then remove the worktree with `git -C /Users/sfs/Devel/webadf worktree remove /private/tmp/claude-501/fw-base --force`.

- [ ] **Step 2: Wire it**

`amiga_tcp.c`, after `h_done`:

```c
static int h_req_fetch(void *ctx, char *buf, int cap) { (void)ctx; return dc_fetch_req(g_dc, buf, cap); }
static int h_req_post(void *ctx, const char *rid, const char *json, int n) { (void)ctx; return dc_post_req(g_dc, rid, json, n); }
```

and in `amiga_tcp_ops` after the `raw_arm` line:

```c
    ops->fetch_req = h_req_fetch; ops->post_req = h_req_post;   // NET: volumes (fw 1.22.0)
```

`main.c`, after `static __uninitialized_psram("sendup") as_up_t g_send_up;`:

```c
// NET: volumes' request state (fw 1.22.0): the fetched lines, the 32 KB answer piece and the GOT table. PSRAM, SRAM +0.
static __uninitialized_psram("sendreq") as_req_t g_send_req;
```

In the `psram_ok` expression, add:

```c
                                  psram_check_address((uint8_t *)&g_send_req + sizeof g_send_req - 1) &&
```

and change the key line to:

```c
            // Protocol 2 (fw 1.19.0): the key in the hello, and its 4 digits in the status report (spec §6).
            // Protocol 3 (fw 1.22.0): requests from the web app (NET: volumes) on the same connection.
            if (psram_ok && g_board_key.ok) {
                as_set_key(&g_send, g_board_key.hex);
                as_set_req(&g_send, &g_send_req);
                dc_set_up_key(&c, g_board_key.hex);
            }
```

Per pass (around line 2472), replace:

```c
            as_tick(&g_send);
            dc_set_send(&c, as_acked_version(&g_send), as_rx(&g_send));
```

with:

```c
            as_set_req_version(&g_send, c.req_version);   // NET: volumes: the poll's req.v
            as_tick(&g_send);
            dc_set_send(&c, as_acked_version(&g_send), as_rx(&g_send));
            if (as_req_capable(&g_send))
                dc_set_req(&c, as_req_acked(&g_send), as_rx_proto(&g_send), as_browse(&g_send));
```

These lines sit inside `#if WF_PNET_L2` with the rest of `g_send`'s uses. Check that with `grep -n "WF_PNET_L2" src/main.c` around them, and keep them inside it.

`CMakeLists.txt`: `set(FIRMWARE_SEMVER "1.22.0")`.

- [ ] **Step 3: Build and measure**

Run: `pnpm firmware:build 2>&1 | tail -5 && arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | grep -E '^\.(data|bss|psram_noload) '`
Expected:
- the build succeeds with no warnings (`-Werror` for the firmware sources);
- `.data` + `.bss` is at most BASE + 128;
- `.psram_noload` is at most 8,388,608.

Put both measurements in the report. If SRAM grew by more than 128 bytes, find out why and stop: report it, don't trim other code.

- [ ] **Step 4: The whole host suite, both compilers**

Run: `pnpm firmware:test 2>&1 | grep -E "checks|FAIL|CRASH"`
Expected: every `test_*.c: N checks, 0 failed`, no FAIL or CRASH.

Run: `docker run --rm -v "$PWD/wifi-floppy/firmware:/f" -w /f/test gcc:14 ./run.sh $(cd wifi-floppy/firmware/test && ls test_*.c | grep -v test_pnet_lz4.c) 2>&1 | grep -E "checks|FAIL|CRASH"`
Expected: `0 failed` for each. `test_pnet_lz4.c` needs liblz4, which the plain gcc image lacks. CI covers it, and this plan does not touch it.

- [ ] **Step 5: Docs**

Spec §3, add after the **Status** bullet (amendments, plan 2026-10-31):

```markdown
- **Amendments (firmware plan 2026-10-31):**
  - Transfer's protocol and browse flag ride the poll (`&rxv=2|3&browse=0|1`, beside `rx`), as the server reads them; the
    Status bullet above is superseded (ruling F1).
  - A piece closes at 32 KB of JSON or 400 lines; `DC_POST_BODY_MAX` is 32,768 (F2).
  - A PUT from Transfer that crosses a request goes first: Transfer answers no request while its PUT waits for TAKE.
    The 30 s silence clock stands still while an upload is pending or moving (F3); a timeout drops the connection (F4).
  - A dropped connection ends the answer in progress `ERR <rid> norx 35:The connection to Transfer was lost`, and every
    GET answered GOT whose file has not finished fails the same way (piece 1); a GET's upload refused with `NO` fails
    the GET `toolarge` (`NO size`) or `io` (F5).
  - A drop at protocol 3 reconnects after 5 s, so Transfer's switch shows within seconds; requests fetched meanwhile
    wait for it (F8).
```

HANDOFF §4-net-volumes, add an entry under the Transfer 2.3 one. Fill in the measured numbers and the commit:

```markdown
- **Firmware 1.22.0 (2026-10-31, plan `docs/superpowers/plans/2026-10-31-firmware-1-22-net-volumes.md`):** the board
  fetches `GET /api/device/req` when the poll's `req.v` moves (acking the v seen before the fetch), relays VOLS/DIR/GET
  to Transfer one at a time on protocol 3 (`WEBADF 3 <key>` → `READY 3 <0|1>`), and posts answers in pieces of at most
  32 KB / 400 lines. GOT ties the GET to its upload (`"request"` on the open); late ERRs go as piece 1. Board-made
  errors: norx, old, timeout. State in PSRAM (`g_send_req`); SRAM +<N> B. Rulings F1-F13 in the plan. TEST build and the
  A500 bench (spec §7) next.
```

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/amiga_tcp.c wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt docs/superpowers/specs/2026-10-30-net-volumes-design.md HANDOFF.md
git commit -m "fw 1.22.0 NET: volumes: requests wired on the board (PSRAM state, req cursor, reqAck/rxv/browse); spec amendments; HANDOFF"
```

---

## At merge (controller only)

1. Final whole-branch review. Then fix-up as the skill says.
2. Check `git status`, and stage only this branch's files.
3. Merge to master with a `--no-ff` merge, message `Merge feat/fw-1-22-net-volumes: firmware 1.22.0 relays NET: volumes requests (protocol 3)`. Push.
4. Wait for the `firmware` CI workflow on the merge commit to pass.
5. Build from master. Publish a TEST build, registry only:
   `pnpm firmware:publish --notes "TEST build -- 1.22.0: NET: volumes (the web app browses the Amiga's disks through Transfer 2.3)" --no-github`.
   - Read the notes back with `.fw-notes.mts` (they must start "TEST build").
   - Target the bench board with `.fw-target.mts <version>`.
   - The Amiga is off overnight. The board takes the update at its next poll with power.
6. Relay to the operator:
   - every ruling (F1-F13 and the ledger's);
   - the deferred minors;
   - the SRAM and PSRAM numbers;
   - the TEST version and seq.
   Then ask the operator to switch the Amiga on for the A500 bench (spec §7), as the last thing in the turn.
