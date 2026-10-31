# Firmware 1.23.0 (NET: volumes, writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board speaks protocol 4 to Transfer 2.5: it reads Transfer's write switch, relays the web app's one-line
writes (MKDIR, RENAME, DELETE, PROTECT, NOTE), sends a queued file to an absolute destination with a clash mode, and
reports a skipped file -- while a Transfer 2.4 (protocol 3) is served exactly as by 1.22.

**Architecture:** `amiga_req.c` learns the five new request kinds and the `DEL` progress line (pure, host-tested).
`amiga_send.c` says `WEBADF 4`, parses `READY 4 <b> <w>`, answers writes itself `readonly` on a protocol 3 connection,
turns a queue entry with an absolute destination into the extended `FILE` (or fails it `readonly`), and reports
`SKIP <id>`. `device_client.c` adds `&write=` to the poll. A new pure `amiga_rxring.c` takes the line ring and its
TCP ack accounting out of the device-only `amiga_tcp.c`, so a host test can judge it.

**Tech Stack:** C11 on RP2350 (pico-sdk, lwIP raw TCP); host tests `wifi-floppy/firmware/test/run.sh` (harness.h
`CHECK`, `CHECK_EQ_INT`, `RUN`, `REPORT`).

**Spec:** `docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md` §2.1-2.3 (the wire), §3 (this firmware);
phase 1 `docs/superpowers/specs/2026-10-30-net-volumes-design.md` §3 with its amendments (F1-F13, I1, I2); template plan
`docs/superpowers/plans/2026-10-31-firmware-1-22-net-volumes.md`.

## Global Constraints

- Hello `WEBADF 4 <key>` (when requests are on; else as 1.22: `WEBADF 2 <key>` / `WEBADF 1`).
- `READY 4 <b> <w>` (each `0`/`1`) counts only as the answer to a protocol 4 hello; write = `w` and `b`. `READY 3 <b>`
  counts as the answer to a protocol 3 or 4 hello (Transfer 2.4: protocol 3, no writes). `READY 2` as today.
- Poll: `&rxv=<2|3|4>&browse=<0|1>&write=<0|1>` while Transfer is connected at protocol 2-4 (write `0` below 4);
  absent otherwise, as 1.22.
- Request lines (Latin-1, `<rid>` 1-40 `[A-Za-z0-9_-]`, paths 1-255 bytes, no control byte):
  `MKDIR <rid> <len>:<path>`, `RENAME <rid> <len>:<from> <len>:<to>`, `DELETE <rid> <len>:<path>`,
  `PROTECT <rid> <len>:<path> <hex>` (1-8 hex digits), `NOTE <rid> <len>:<path> <len>:<comment>` (comment 0-79 bytes).
- Order: VOLS, DIR and the five writes before any GET, each in arrival order (phase 1 I2).
- Answer lines: `DEL <rid> <n>` (progress, gathered like `ENT`, restarts the 30 s silence clock), `DONE <rid> <n>`,
  `ERR <rid> <code> <len>:<text>`.
- Board-made: a write request on a protocol 3 connection is answered `ERR <rid> readonly 26:Writing is off in Transfer`;
  below protocol 3 `old` as 1.22; not connected `norx` as 1.22.
- Queue entry with a destination: `FILE <id> <size> <crc hex> <prot hex> <len>:<dest> <len>:<comment> <keep|replace|skip>`
  only on protocol 4 with write on; otherwise the row is posted `{"ok":false,"code":"readonly","text":"Writing is off in Transfer"}`
  and nothing is sent. `SKIP <id>` after a `FILE` posts `{"ok":false,"code":"skipped","text":""}`.
- `FIRMWARE_SEMVER` 1.23.0.
- SRAM: `.data`+`.bss` growth justified line by line (baseline master 69d6051e: `.data` 11,092, `.bss` 429,012,
  `.psram_noload` 7,962,320). New state goes in `as_req_t` (PSRAM). Heap low-water >= 20,480 B is unaffected by design.
- core0/core1 stack: no new local over 64 bytes in `amiga_send.c`; the 1.22 STACK note's statics stay static.
- `test/test_amiga_send.c` is Latin-1: ASCII only in new text, byte escapes like `"\xe9"`.
- Repo rules: stage named files only (never `git add -A`), no `git stash`, no commit trailers, never pattern-kill, no
  publish/install, never touch `src/` (web) or `tools/receive/`.

## Review Focus

1. **Transfer 2.4 behind a 1.23 board:** it answers `WEBADF 4` with `READY 3 1`; reads keep working and every write
   (request or dest row) fails `readonly` without reaching it. Task 3 `transfer_2_4_answers_ready_3_and_writes_are_readonly`.
2. **A dest row while writing is off on 2.5 (`READY 4 1 0`):** never sent, failed `readonly`, the next row then goes.
   Task 4 `a_dest_row_with_writing_off_fails_readonly_and_the_next_goes`.
3. **A drawer delete with thousands of entries:** `DEL` lines keep the request alive past 30 s total; a gap of 30 s
   between `DEL`s still times out. Task 3 `del_lines_keep_a_long_delete_alive`.
4. **Write lines with spaces and Latin-1 in names, a 0-length comment, a 255-byte rename pair:** taken intact,
   relayed byte for byte. Task 2 `write_lines_parse_with_spaces_latin1_and_empty_comment`.
5. **TCP ack accounting:** a line byte is acked only when taken, raw bytes at once, a whole window fits, a close acks
   the unread bytes. Task 1 tests.

## Rulings made while planning (relay to the operator)

- **N1 (wire, cost if wrong: the server's NEXT line must match):** the queue row reaches the board only through
  `GET /api/device/send/queue`'s `NEXT` line (the poll's `xfer` carries `v` and `ip` only), so "`xfer.next` gains
  `dest` and `onClash`" means the NEXT line: `NEXT <id> <size> <crc> <prot> <len>:<dest> <len>:<comment> <mode>` -- the
  destination takes the path's place, so the line's tail IS the extended `FILE`'s. The board also accepts the
  destination as its own field after the comment (`... <len>:<path> <len>:<comment> <len>:<dest> <mode>`). A path
  with a `:` is absolute (the server's `cleanAmigaPath` never leaves one in a relative path); an absolute path with no
  mode is `keep`; a mode with a relative path is dropped (today's FILE). An unknown mode fails the row `name`. LIST
  lines are forwarded unchanged, so the server decides what path it lists to a Transfer 2.4.
- **N2:** a write request on a protocol 3 connection is answered by the board, `readonly` "Writing is off in
  Transfer" (it would be refused `bad` by 2.4). On protocol 4 the request goes to Transfer even with `<w>` 0 -- it
  answers `readonly` itself (as F11 for browsing).
- **N3:** `&write=` rides with `&rxv=` for every protocol 2-4 (`0` below 4), so a server that keeps `write_on` until
  told otherwise is told.
- **N4:** `AR_REFETCH_ROOM` grows to `AR_MAX * (AR_LINE_MAX + 1)` (5,128): a refetch may now bring eight RENAME lines
  of up to 568 bytes. Eight held GETs (2,440 B) still leave 5,752 of `AR_FETCH_BYTES` 8,192.
- **N5:** the ring's ack accounting moves to a pure `amiga_rxring.c` (prefix `rr_`); `amiga_tcp.c` keeps only lwIP calls.
- **N6:** the poll's `path` buffer grows 208 -> 216 bytes (+8 B .bss): the worst poll path becomes 207 with `&write=1`.

---

### Task 1: The line ring and its ack accounting (`amiga_rxring.c`)

**Files:** Create `wifi-floppy/firmware/src/amiga_rxring.h`, `src/amiga_rxring.c`, `test/test_amiga_rxring.c`;
Modify `src/amiga_tcp.c` (on_recv, t_close, t_recv_line use it), `CMakeLists.txt:125` (add `src/amiga_rxring.c`).

**Interfaces (produces):**

```c
typedef struct rr_ring { uint8_t *buf; int size; volatile int head, tail; } rr_ring_t;
void rr_init(rr_ring_t *r, uint8_t *buf, int size);
int  rr_used(const rr_ring_t *r);
// One pbuf segment from lwIP: raw bytes (while *raw is armed) go to as_raw_feed and are added to *ack_now; line bytes
// go to the ring (acked later, when taken). *raw becomes NULL when its section is complete. -1: past the credit or the
// ring full (the connection must close); else 0.
int  rr_feed(rr_ring_t *r, as_raw_t **raw, const uint8_t *b, int n, uint32_t *ack_now);
// 1 = a line into out (no LF, CRs dropped, cut at cap-1), *ack = bytes it used (line + LF); 0 = no whole line yet.
int  rr_take_line(rr_ring_t *r, char *out, int cap, int *ack);
// The unread bytes, acked at close; the ring is emptied.
int  rr_drain(rr_ring_t *r);
```

- [ ] Step 1: tests `test_amiga_rxring.c`: `line_bytes_are_acked_when_taken` (feed "PONG\nDONE a 1\n": ack_now 0;
  take "PONG" ack 5; take "DONE a 1" ack 9; take -> 0), `raw_bytes_are_acked_on_arrival` (armed section of 4, feed
  "abcdLINE\n": ack_now 4, raw NULL after, ring holds 5), `a_whole_window_fits` (49,152 ring, feed 46,720 bytes in
  1460-byte segments without LF -> 0 each, used 46,720), `a_full_ring_is_an_error` (size 8: feed 8 bytes -> -1),
  `crs_dropped_long_lines_cut_but_fully_acked` ("AB\r\nxxxxxxxxxx\n", cap 4: "AB" ack 4; "xxx" ack 11),
  `wraps_around`, `drain_acks_unread` (feed "abc", drain 3, used 0), `past_the_credit_is_an_error`.
- [ ] Step 2: run `./run.sh test_amiga_rxring.c` -> compile FAIL (no header).
- [ ] Step 3: implement (moves the loop body of `on_recv` and `t_recv_line` verbatim, minus lwIP calls).
- [ ] Step 4: run -> PASS. Rewire `amiga_tcp.c`: `T.ring` -> `rr_ring_t R`; `on_recv` calls `rr_feed` per pbuf and
  `tcp_recved(ack_now)` (in <= 0xFFFF steps); `t_recv_line` calls `rr_take_line` then `tcp_recved(ack)`; `t_close`
  calls `rr_drain` and acks it. Device build compiles.
- [ ] Step 5: commit `amiga_rxring.[ch]`, test, `amiga_tcp.c`, `CMakeLists.txt`.

### Task 2: Write requests and `DEL` in `amiga_req.c`

**Files:** Modify `src/amiga_req.h` (kinds, `AR_REFETCH_ROOM`), `src/amiga_req.c` (`line_at`, `ar_take`,
`ar_line_verb`, `ar_kind_is_write`); Test `test/test_amiga_req.c`.

**Interfaces (produces):** `typedef enum { AR_NONE = 0, AR_VOLS, AR_DIR, AR_GET, AR_MKDIR, AR_RENAME, AR_DELETE,
AR_PROTECT, AR_NOTE } ar_kind_t;` `bool ar_kind_is_write(ar_kind_t k);` `ar_line_verb` also returns `"DEL"`.

Line grammar after `<VERB> <rid> ` (whole line must be consumed, `n <= AR_LINE_MAX`):
MKDIR/DELETE `F`; RENAME `F F`; PROTECT `F H`; NOTE `F C`, where F = `<len>:<1-255 bytes>`, C = `<len>:<0-79 bytes>`,
H = 1-8 hex digits, no control byte in any field.

- [ ] Step 1: tests: `takes_each_write_kind` (one of each; kind, rid, out byte for byte),
  `write_lines_parse_with_spaces_latin1_and_empty_comment` (`RENAME r 9:Work:a b 255:<255 x \xe9>`, `NOTE n 6:Work:x 0:`),
  `malformed_write_lines_are_skipped` (`MKDIR m`, `MKDIR m 0:`, `RENAME r 6:Work:a`, `RENAME r 6:Work:a 6:Work:b x`,
  `PROTECT p 6:Work:a`, `PROTECT p 6:Work:a 123456789`, `PROTECT p 6:Work:a 0g`, `NOTE n 6:Work:a 80:<80>`,
  `DELETE d 3:a\x01b` -> 9 skipped), `writes_go_before_gets_in_order` (`GET g ...\nMKDIR m ...\nDIR d ...\nDELETE x ...`
  -> m, d, x, g), `del_is_an_answer_verb` (`DEL r 50` -> "DEL", "r"), `refetch_room_takes_eight_renames`
  (`AR_REFETCH_ROOM >= AR_MAX * 568` and `AR_FETCH_BYTES - 8 * 305 >= AR_REFETCH_ROOM`, static checks).
- [ ] Step 2: run -> FAIL.
- [ ] Step 3: implement: a verb table `{ "VOLS", "DIR", "GET", "MKDIR", "RENAME", "DELETE", "PROTECT", "NOTE" }`;
  a field reader `fld(p, end, min, max, &next)` for `<len>:<bytes>`; `hexw` for PROTECT; `vl` stored per kind so
  `ar_take` copies the rid from `l + vl`.
- [ ] Step 4: run -> PASS (old tests too).
- [ ] Step 5: commit.

### Task 3: Protocol 4 in `amiga_send.c` (hello, READY 4, writes relayed or refused)

**Files:** Modify `src/amiga_req.h` (`bool write;` beside `browse` in `as_req_t`), `src/amiga_send.h`
(`as_write`), `src/amiga_send.c`; Test `test/test_amiga_send.c`.

**Interfaces:** `bool as_write(const amiga_send_t *s);` -- `true` only on a protocol 4 connection with `READY 4 1 1`.
`as_browse` is true at protocol 3 or 4. `as_rx_proto` returns 4.

- [ ] Step 1: tests (helper `ready4(b, w)` as `ready3`): `the_hello_is_protocol_4_with_requests` (`WEBADF 4 <key>`,
  `READY 4 1 1` -> proto 4, browse, write; `READY 4 0 1` -> write false; `READY 4 1 0` -> write false),
  `transfer_2_4_answers_ready_3_and_writes_are_readonly` (`READY 3 1`: proto 3, browse, no write; `wake("MKDIR m 9:Work:New\nDIR d 5:Work:\n")`:
  `DIR` relayed, `MKDIR` never sent, posted `ERR m readonly 26:Writing is off in Transfer`), `a_ready_4_to_a_protocol_2_hello_counts_as_1`,
  `each_write_is_relayed_at_protocol_4` (MKDIR, RENAME, DELETE, PROTECT, NOTE each relayed, `DONE <rid> 1` posted),
  `a_write_with_writing_off_still_goes_to_transfer` (`READY 4 1 0`: relayed; Transfer's own ERR posted),
  `del_lines_keep_a_long_delete_alive` (DELETE; a `DEL x 50` every 20 s for 100 s: no timeout, pieces carry the DELs;
  then 31 s silence -> `ERR x timeout`), `a_partial_delete_posts_del_then_err` (`DEL x 37` then
  `ERR x busy 30:Libs/foo.library: object in use` -> one piece, both lines, last), `a_drop_mid_delete_ends_norx_lost`.
- [ ] Step 2: run -> FAIL.
- [ ] Step 3: implement: hello `s->hello_v = s->req ? 4 : 2`; READY parse:
  `READY 4 b w` with hello 4 -> peer 4, browse b, write w&&b; `READY 3 b` with hello >= 3 -> peer 3, write false;
  `READY 2` with hello >= 2 -> 2; else 1. `req_start`: `peer_v < 3` -> old; `peer_v == 3 && ar_kind_is_write(kind)`
  -> `ar_end_err(r, "readonly", AS_TXT_RO)`. `req_on_drop` clears `write`. Log line names writing on/off.
- [ ] Step 4: run -> PASS (all 1.22 tests unchanged except the hello string in `the_hello_is_protocol_3_with_requests`,
  which becomes protocol 4 -- its `READY 3` checks stay).
- [ ] Step 5: commit.

### Task 4: Copy onto a volume (`FILE` extended) and `SKIP`

**Files:** Modify `src/amiga_send.c` (`start_file`, AS_FILE_SENT), Test `test/test_amiga_send.c`.

`start_file` parses the NEXT line (Ruling N1) into id, size, crc, prot, path, comment, optional dest, optional mode:

```c
// after "<len>:<comment>": end | " <mode>" | " <len>:<dest>" [" <mode>"]
// absolute = dest given, or path contains ':'
// absolute && !(peer_v == 4 && write) -> set_failure(s, "readonly", AS_TXT_RO); no FILE
// absolute -> "FILE <id> <size> <crc> <prot> <len>:<dest> <len>:<comment> <mode>\n"  (mode default keep)
// relative -> "FILE " + the line's tail as today (byte for byte)
```

- [ ] Step 1: tests: `a_dest_row_goes_as_the_extended_file` (`NEXT id 5 3610a686 0 18:Work:Tools/x.txt 0: replace` on
  `ready4(1,1)` -> `FILE id 5 3610a686 0 18:Work:Tools/x.txt 0: replace\n`, then GO/bytes/OK posted ok),
  `a_dest_as_its_own_field_is_accepted` (`... 5:x.txt 0: 18:Work:Tools/x.txt skip` -> FILE with dest and skip),
  `an_absolute_path_without_a_mode_is_keep`, `a_dest_row_with_writing_off_fails_readonly_and_the_next_goes`
  (`READY 4 1 0`: no FILE, posted readonly; queue refetched; a relative row next goes), `a_dest_row_to_transfer_2_4_fails_readonly`,
  `skip_is_reported_as_skipped` (`SKIP id` -> posted `{"ok":false,"code":"skipped","text":""}`, phase READY, next row),
  `wprot_full_denied_pass_through` (`ERR id wprot 26:The disk is write-protected` -> code wprot),
  `an_unknown_mode_fails_the_row_name`, `a_relative_row_is_unchanged_at_protocol_4` (byte for byte as 1.22).
- [ ] Step 2: run -> FAIL.
- [ ] Step 3: implement as above; `SKIP <id>` handled in `AS_FILE_SENT` beside `ERR`.
- [ ] Step 4: run -> PASS.
- [ ] Step 5: commit.

### Task 5: The poll's `&write=`, main.c, version, spec ruling, build

**Files:** Modify `src/device_client.h` (`_req_write`, `dc_set_req(c, ack, proto, browse, write)`),
`src/device_client.c` (path 216, `&write=`), `src/main.c:2488`, `CMakeLists.txt:273` (1.23.0),
`test/test_device_client.c`, spec (Rulings N1-N6 appended to §3).

- [ ] Step 1: tests: extend `send_poll_params_only_once_set`-style test: proto 4 -> `&rxv=4&browse=1&write=1`; proto 3 ->
  `&rxv=3&browse=1&write=0`; unconnected -> no rxv/write; the worst poll path (`&rxv=4&browse=1&write=1&boot=ffffffff&ota=1`) whole.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS; full `./run.sh`; Linux gcc via docker if available.
- [ ] Step 5: `pnpm firmware:build`; record `.uf2` size, `.data`/`.bss`/`.psram_noload` against the baseline; commit.
