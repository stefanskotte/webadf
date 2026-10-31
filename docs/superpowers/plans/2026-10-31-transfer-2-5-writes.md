# Transfer 2.5: writing to the Amiga's own disks (protocol 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer 2.5 speaks protocol 4: `READY 4 <b> <w>`, the extended `FILE` (an absolute destination and a clash
mode `keep|replace|skip`), and the one-line requests `MKDIR`, `RENAME`, `DELETE` (a drawer emptied depth-first, with
`DEL` progress), `PROTECT` and `NOTE`, answered only while its owner ticked a second switch, "Let the web app change my
disks".

**Architecture:** As in 2.3, every decision lives in the portable core (`tools/receive/core/rx_proto.c`), host-tested
with the in-memory `fakefs.h`. Absolute paths reuse the protocol 1 file hooks: a path containing `:` is an Amiga path,
and the glue (`afs.c`, `rx_posix.c`) passes it through instead of joining it to ReceiveDir (a relative path can never
contain `:`, `rx_path_ok`). The write requests reuse phase 1's request machinery (one at a time, behind any file
moving, `rid`, length-prefixed paths), with five new hooks that return AmigaDOS error numbers. A drawer delete is a
loop in the core whose only state is one path buffer in the session (the path *is* the stack): each step opens the
current drawer, takes its first entry, and either descends into it or deletes it; no lock is held between steps and no
C recursion is used, so stack and memory stay flat with depth.

**Tech Stack:** C (core: C99 host build `cc -Wall -Wextra -Werror`; Amiga: amiga-gcc 6.5 pinned image,
`-m68000 -Os -noixemul -Wall -Werror`, Kickstart 2.04+), TypeScript (fake board, scenarios, vitest), FS-UAE, xdftool.

**Spec:** `docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md` §2 (Transfer 2.5), with §1 (decisions) and
§6 step 2. Background: phase 1 `docs/superpowers/specs/2026-10-30-net-volumes-design.md` §2 (protocol 3), protocol 1
`docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` §2 (`FILE`). Template:
`docs/superpowers/plans/2026-10-30-transfer-2-3-browsing.md`.

## Global Constraints

- **Kickstart 2.04 floor, any 68000.** Libraries as today (dos, exec, intuition, graphics, gadtools, asl, workbench,
  bsdsocket). `build.sh` must compile with no warning.
- **Memory (2.4's budget, HANDOFF §4-net-volumes):** the Shell form runs on an 8 KB stack (deepest measured 3,012 B).
  No recursion anywhere new; no new static buffers over 512 B in the Shell path; the walk keeps one 256-byte path in
  the session. gui.c's library bases stay defined `= NULL` (libstubs auto-open pitfall).
- **The core stays portable:** no stdio, no Amiga headers in `core/`.
- **Protocols 1, 2 and 3 are unchanged**, except that a hello of 4 or newer is now answered as 4 (`WEBADF 7` was
  answered `READY 3`; it is now `READY 4 <b> <w>`).
- **Wire contract (verbatim; the server and firmware are built against exactly this):**
  - hello `WEBADF 4 <key>` -> `READY 4 <b> <w>`; `<w>` is `1` only if `<b>` is `1`;
  - `FILE <id> <size> <crc32 hex> <protection hex> <len>:<path> <len>:<comment> <keep|replace|skip>`; an absolute
    path is `Vol:drawer/name` (volume part 1-30 bytes, no `/` or `:`; the rest as `rx_path_ok`, not empty); a relative
    path with no mode is today's `FILE` into ReceiveDir;
  - `skip` and the name exists -> `SKIP <id>`, no bytes follow;
  - writing off -> `ERR <id> readonly <text>` (FILE's ERR keeps today's unprefixed text);
  - requests `MKDIR <rid> <len>:<path>`, `RENAME <rid> <len>:<from> <len>:<to>`, `DELETE <rid> <len>:<path>`,
    `PROTECT <rid> <len>:<path> <hex>`, `NOTE <rid> <len>:<path> <len>:<comment>`;
  - answers `DONE <rid> <n>`, `ERR <rid> <code> <len>:<text>`, progress `DEL <rid> <n>` after every 50 entries removed
    and once before an `ERR` that stops a drawer delete;
  - codes: `readonly`, `exists`, `wprot`, `full`, `xvol`, plus phase 1's `notfound`, `notdir`, `busy`, `denied`,
    `bad`, `io`;
  - every write runs with `pr_WindowPtr = -1`; changing either switch drops the (idle) connection.
- **Fixed English texts:** `writing is off in Transfer` (readonly), `bad request` (bad), `rename works within one
  volume` (xvol), `path too long` (io), `no such volume` (FILE folder). All other texts are AmigaDOS's (`Fault()`).
- **The switch:** `ENVARC:webadf/Write` (`1`/`0`, copied to `ENV:`); checkbox "Let the web app change my disks" under
  the browse one, disabled while browsing is off; template
  `TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S,WRITE/S`; `$VER: Transfer 2.5`.
- **Git:** never `git add -A`, never `git stash`; stage files by name; no trailers. Never touch `wifi-floppy/` or
  `src/`. No e2e, nothing touching the production database. The driver disk is NOT rebuilt here (the controller does
  it at release).
- **FS-UAE:** one run at a time (port 6800 is the Mac's); stop only the PID `uae-test.sh` started; GUI mode ends by
  touching `<work>/stop`. Each Bash call foreground and under 9 minutes.

## Review Focus

1. **A destructive request through a name that is not a mounted volume, or at a volume's root** (`DELETE Work:`,
   `DELETE ENVARC:x`, `DELETE CON:x`, `RENAME SYS:a`): refused (`bad` / `notfound`) before any hook is called.
   Task 3 `write_paths_are_checked_before_any_hook`.
2. **`replace` whose old file cannot go** (delete-protected, open): the old file stays byte for byte, the temporary
   file is removed, `ERR <id> denied|busy`. Task 2 `replace_keeps_the_old_file_when_it_cannot_be_deleted`; FS-UAE
   `w-replace-busy`.
3. **Writing switched off while a drawer delete runs**: it stops at the next step with `DEL <rid> <n>` then
   `ERR <rid> readonly`. Task 3 `switching_writing_off_stops_a_delete_between_steps`.
4. **The connection dropping mid-delete**: the walk is forgotten (no further deletes after a reconnect), the owner is
   told. Task 3 `a_lost_connection_ends_a_delete`.
5. **A disk that is write-protected or full, or a missing disk**: an error code, never a requester (that would freeze
   Transfer and the board). Host: Task 2/3 code mapping tests; Amiga: every write hook in `afs.c` between
   `quiet_on()`/`quiet_off()`; FS-UAE `w-file-wprot`, `w-mkdir-wprot`, `w-file-full` (a requester would time the
   scenario out).

## Plan rulings (decisions the spec left open)

- **W1 — A path is absolute iff it contains `:`.** The glue passes such paths through to AmigaDOS; relative paths are
  joined to ReceiveDir as before. Cost if wrong: none found; `rx_path_ok` refuses `:` in relative paths.
- **W2 — An absolute `FILE` needs a mode, and a mode needs an absolute path** (else `ERR <id> name bad request`), and
  needs protocol 4: on protocol 1-3, an absolute `FILE` is `ERR <id> readonly`. Cost if wrong: a server that sent a
  relative path with a mode is refused visibly, not misfiled.
- **W3 — Write paths must name a mounted volume** (by name or device, as phase 1's reads; `vol_known`), else
  `notfound` (requests) or `ERR <id> folder no such volume` (FILE). Keeps CON:, PIPE: and assigns out.
- **W4 — No request acts on a volume root** (`Work:`): `bad`. A whole-volume delete is a format, out of scope.
- **W5 — The walk's stack is the path** (one 256-byte buffer in the session, no locks held between steps); a tree deeper
  than 255 bytes of path stops with `ERR io path too long`. Cost if wrong: such a tree cannot be deleted from the web
  app (the server cannot name paths over 255 bytes anyway).
- **W6 — `DONE <rid> <n>` counts every object removed, the named drawer included** (300 files in a drawer: `DONE 301`);
  `DEL <rid> 0` is sent when a drawer delete stops before removing anything (the contract says "once before an ERR
  that stops a drawer delete"). A file delete that fails sends no `DEL`.
- **W7 — The `ERR` text of a stopped drawer delete names the entry relative to the named drawer**
  (`Libs/foo.library: object is in use`), cut to 79 bytes; a failure on the named path itself carries Fault's text only.
- **W8 — `skip` is decided when FILE arrives;** a name that appears while the bytes arrive gets the collision-free name
  (as `keep`). A drawer of the target's name: `keep` picks `name_2`, `replace` is refused `ERR <id> denied a drawer
  has that name`, `skip` skips.
- **W9 — FILE error codes for an absolute path come from the DOS error:** 214 `wprot`, 221 `full`, 222/223/224
  `denied`, 202 `busy`, anything else `write`; free space is checked on the target's volume before `GO` (`full`).
  Relative paths keep `space`/`write` exactly as today.
- **W10 — Rename across volumes is caught before AmigaDOS:** both paths' volume parts are resolved through the volume
  list; different devices -> `xvol` (and DOS error 215 maps to `xvol` too).
- **W11 — `WRITE` implies `BROWSE` for that run** (writing is usable only while browsing is on); `WRITE SAVE` stores
  both. Unticking browsing unticks and stores writing off.
- **W12 — A write request on a connection where writing is off (protocol 3, another key, switch off) is `readonly`,**
  checked when it arrives and again when it starts (switched off meanwhile), and between delete steps.
- **W13 — DOS error mapping for requests extends `rx_err_code`:** 203 `exists`, 214 `wprot`, 215 `xvol`, 221 `full`,
  222/223 `denied`, plus phase 1's; the read mapping is unchanged for every number it already handled.
- **W14 — `SKIP` reaches the owner** as a new event `RX_EV_SKIP` (Shell: `<path>  skipped (it exists)`; window row
  "skipped").
- **W15 — Deferred minors:** `rx_upq.why` records why the last add failed (`RX_ADD_FULL`, `RX_ADD_NOMEM`,
  `RX_ADD_NAME`); `rx_upq.lost` counts files a walk could not queue for memory; `rx_upq_init` frees a queue's items
  (the caller passes zeroed or initialized memory, as every caller does).
- **W16 — The core's malloc is testable:** under `-DRX_TEST_HOOKS` (host tests only) `rx_test_fail_alloc` makes the
  Nth allocation fail and `rx_test_live` counts live allocations.

## Files

| File | Change |
|---|---|
| `tools/receive/core/rx_names.h/.c` | `rx_abs_path_ok`; `rx_candidate` treats `:` as a separator (Task 1) |
| `tools/receive/core/rx_proto.h/.c` | protocol 4 hello and switch, minors (Task 1); extended FILE (Task 2); write requests and the delete walk, words (Task 3) |
| `tools/receive/test/fakefs.h` | DOS errors, write-protect, delete-protect, busy, the new hooks; FF_MAX 400 (Tasks 1-3) |
| `tools/receive/test/test_write.c` | new: protocol 4 host tests (Tasks 1-3) |
| `tools/receive/test/test_names.c`, `test_proto.c`, `test_browse.c`, `run.sh` | abs paths; WEBADF 7 now 4; minors; -DRX_TEST_HOOKS |
| `tools/receive/posix/rx_posix.c` | absolute paths, write hooks, `WRITE 0/1`, RX_WRITE, RX_WPROT, RX_FULL (Task 4) |
| `tools/receive/fake-board.ts`, `scenarios.ts`, `run-scenarios.ts`, `receive.int.test.ts` | protocol 4 board and write scenarios (Task 4) |
| `tools/receive/amiga/afs.h/.c` | quiet write hooks, pass-through paths, DOS errors (Task 5) |
| `tools/receive/amiga/config.h/.c`, `main.c`, `ui.h`, `shell.c`, `gui.c`, `ipc.c` | the Write switch, words, minors, 2.5 (Task 5) |
| `tools/receive/uae/uae-test.sh`, `uae/send-scenarios.ts` | write mode; ver 2.5 (Task 6) |
| `tools/receive/README.md`, `tools/paulanet-disk/ReadMe` | protocol 4 (Task 6) |
| `tools/receive/receive.sha256`, `tools/receive/dist/Transfer` | the pin (Task 6) |

---

### Task 1: Protocol 4 hello, the write switch, absolute paths, the deferred minors (core)

**Interfaces — produces:**
- `rx_upq.write` (int, 1: the owner lets the web app change disks), `rx_upq.why` (`RX_ADD_OK|FULL|NOMEM|NAME`),
  `rx_upq.lost` (unsigned).
- `int rx_write_on(const rx_session *s)` — upq, browse and write on, peer_v >= 4, trusted.
- `int rx_abs_path_ok(const char *path)` — `Vol:rest`, rest non-empty and `rx_path_ok`, whole <= 255 bytes.
- session `hello_write`; `rx_hello_stale` also compares it.

- [ ] Step 1: tests in new `test/test_write.c` (`READY 4 1 1`, `READY 4 1 0`, `READY 4 0 0` with write but browse off,
  another key `READY 4 0 0`, stale on a changed write flag, protocol 3 unaffected by write); `test_names.c`
  (`rx_abs_path_ok`: `Work:a`, `Work:a/b`, `Gr\xfc\xdf e:x` ok; `Work:`, `:a`, `a`, `Work:/a`, `Work:a//b`,
  `Work:..`, `Work:.`, a 31-byte volume, a 31-byte part, `Wo/rk:a`, control bytes refused; `rx_candidate("Work:a.txt", 2)`
  = `Work:a_2.txt` and a 30-byte name after `Work:` keeps 30 bytes); `test_proto.c` minors (an add on a full queue sets
  `RX_ADD_FULL`, a bad name `RX_ADD_NAME`, a failed malloc `RX_ADD_NOMEM`; a drawer walk with the 2nd allocation failing
  queues the others and sets `lost`; `rx_upq_init` on a queue of 3 leaves `rx_test_live` at 0). `test_browse.c`:
  `WEBADF 7` now answers `READY 4 1 0`. Run `pnpm receive:test`: FAIL (undefined names).
- [ ] Step 2: implement (`on_hello` peer_v 4; `READY 4 <b> <w>`; `rx_write_on`; stale; names; `RX_MALLOC`/`RX_FREE`
  with the test hooks; `up_add_at` sets `why`; `walk_each` counts `lost`; `rx_upq_init` frees). `run.sh` adds
  `-DRX_TEST_HOOKS` and the new test file is picked up by its glob.
- [ ] Step 3: `pnpm receive:test` PASS; commit.

### Task 2: The extended FILE (core)

**Interfaces — consumes:** Task 1. **Produces:** hooks `long (*err)(void *ctx)` (the DOS error of the last failed
protocol 1 file hook) and `unsigned long (*free_at)(void *ctx, const char *path)` (free bytes on the volume of an
absolute path; 0xFFFFFFFF unknown) appended to `rx_fs`; event `RX_EV_SKIP` (id, path); `const char *rx_file_code(long)`.

Behaviour (spec §2.2, rulings W2, W3, W8, W9):
1. parse as today, then an optional mode token; anything after it is `bad request`;
2. relative + no mode = today, untouched; relative + mode, or absolute + no mode = `ERR <id> name bad request`;
3. absolute: `rx_abs_path_ok` else `name bad name`; `!rx_write_on` -> `readonly writing is off in Transfer`;
   `vol_known` 0 -> `folder no such volume`, -1 -> `folder cannot read the volume list`;
4. `stat`: exists and mode skip -> `SKIP <id>` (event RX_EV_SKIP), done; exists, a drawer, mode replace -> `denied a
   drawer has that name`;
5. `free_at(path)` < size + 8 KB -> `full not enough space`;
6. make parents, open `<parent>/.webadf-rx` (`parent_of` cuts after the last `/` or `:`); failures -> `rx_file_code(err)`
   with Fault's text (`write`/`cannot ...` text when the code is `write`);
7. finish: CRC, then replace -> `remove(old)` if it exists (failure: remove tmp, `ERR <id> <code> <Fault>`, old
   kept) then rename tmp to the name; keep (and skip, W8) -> collision-free candidate as today; set meta; `OK <id>
   <len>:<absolute saved path>`. Write errors mid-file on an absolute path report the DOS code (full/wprot) instead of
   `write`.

- [ ] Step 1: tests in `test_write.c`: `an_absolute_file_lands_on_its_volume`, `missing_drawers_are_made`,
  `keep_picks_a_free_name`, `replace_swaps_only_after_the_crc_matched` (bad CRC: the old one unchanged),
  `replace_keeps_the_old_file_when_it_cannot_be_deleted` (delete-protected -> `denied`; busy -> `busy`; tmp gone),
  `skip_answers_skip_and_takes_no_bytes` (next line parsed as a line), `skip_on_a_new_name_writes_it`,
  `a_drawer_of_that_name`, `writing_off_is_readonly` (switch off; browse off; protocol 3; another key),
  `bad_absolute_files` (no mode, relative with mode, `Work:`, junk after the mode, unknown mode, CON:),
  `a_write_protected_disk_is_wprot`, `a_full_volume_is_full` (free_at), `a_disk_full_mid_write_is_full`,
  `the_relative_file_is_unchanged` (relative FILE still uses `space`, `folder_ok`, `free_bytes`).
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS (all old tests too); commit.

### Task 3: MKDIR, RENAME, DELETE (with the walk), PROTECT, NOTE (core)

**Interfaces — consumes:** Tasks 1-2. **Produces:** hooks appended to `rx_fs`:
`long (*w_mkdir)(void *, const char *path)`, `long (*w_rename)(void *, const char *from, const char *to)`,
`long (*w_delete)(void *, const char *path)` (one file or one empty drawer), `long (*w_protect)(void *, const char *,
unsigned long)`, `long (*w_note)(void *, const char *, const char *)` — each 0 or a DOS error. `RX_REQ_MKDIR,
RX_REQ_RENAME, RX_REQ_DELETE, RX_REQ_PROTECT, RX_REQ_NOTE`; `rx_event.to` (RENAME's target); REQ_WORD codes
`mkdir rename delete protect note`; `rx_req_words` covers them. Session gains `wait_arg/req_arg[RX_LOCAL_MAX+1]`,
`wait_num/req_num`, `del_path[RX_LOCAL_MAX+1]`, `del_top` (length of the named path). Constants `RX_DEL_EVERY 50`,
`RX_DEL_PASS 4` (steps per output pass).

The walk (one step = one object removed):
```
step: loop {
  e = dir_open(del_path)           // not a drawer (212) at the top: it is a file -> w_delete(top); done
  r = dir_next(&ent); dir_close()
  r < 0: stop(-r, del_path)
  r == 1 && ent.is_dir: append "/name" (or "name" after ':'); over 255 -> stop io "path too long"; continue
  r == 1: w_delete(del_path/name) ; error -> stop(err, that path); count++; return
  r == 0: w_delete(del_path) ; error -> stop ; count++; if at top: DONE count; else strip last part; return
}
```
`DEL <rid> <count>` after each count % 50 == 0; `stop` = `DEL <rid> <count>` (drawer only, W6) then `ERR` (W7).
Each pass first checks `rx_write_on` (W12). The walk runs only while the output buffer has `RX_REQ_ROOM`.

- [ ] Step 1: tests in `test_write.c`: `mkdir_makes_one_level` (DONE 1; exists -> `exists`; parent missing ->
  `notfound`; wprot), `rename_within_a_volume_and_across_drawers`, `rename_across_volumes_is_xvol` (no hook call),
  `rename_onto_an_existing_name_is_exists`, `protect_sets_the_bits`, `note_sets_the_comment` (80 bytes refused `bad`;
  control bytes `bad`), `delete_a_file_is_done_1`, `delete_a_drawer_of_300_paces_del_every_50` (DEL 50..300 then
  DONE 301, nothing left, max take <= 1 KB), `delete_a_nested_tree`, `a_protected_entry_stops_the_delete` (DEL n then
  `ERR denied Sub/locked: ...`), `a_delete_that_stops_at_once_sends_del_0`, `out_of_memory_mid_delete_is_io` (the
  fake fails dir_open with 103 after k steps), `write_paths_are_checked_before_any_hook` (Review Focus 1),
  `write_requests_while_writing_is_off_are_readonly` (off; browse off; protocol 3),
  `switching_writing_off_stops_a_delete_between_steps` (Review Focus 3), `a_lost_connection_ends_a_delete` (Review
  Focus 4), `a_write_request_waits_behind_a_file`, `malformed_write_requests_are_bad`, `the_owners_words_for_writes`.
- [ ] Step 2: FAIL; Step 3: implement; Step 4: PASS; commit.

### Task 4: POSIX build, fake board, scenarios

**Files:** `posix/rx_posix.c`, `fake-board.ts`, `scenarios.ts`, `run-scenarios.ts`, `receive.int.test.ts`.

- rx_posix: absolute paths via `host_path` (with Latin-1 -> UTF-8 for the rest); `p_err` from errno (EROFS 214, ENOSPC
  221, EACCES/EPERM 223, ENOENT 205, EEXIST 203, ENOTEMPTY 216, EXDEV 215, ENOTDIR 212); env `RX_WRITE=1`,
  `RX_WPROT=<volume name>` (every write there fails 214), `RX_FULL=<volume name>` (free_at 0); stdin `WRITE 1|0`;
  stdout `SKIP`, `REQ mkdir|rename|delete|protect|note ...`, `PROT <path> <hex>`, `NOTE <path> <comment>`.
- fake-board: `connect(..., { v: 4 })` parses `READY 4 b w` (`write`); `send()` takes `dest`/`mode` and returns
  `{ ok: false, code: 'skip' }` on `SKIP <id>`.
- scenarios: `makeWriteFixture(root)` and `WRITE_SCENARIOS`, shared by POSIX and FS-UAE (see Task 6 for the fixture):
  `w-hello`, `w-file-new`, `w-file-parents`, `w-file-keep`, `w-file-replace`, `w-file-skip`, `w-file-wprot`,
  `w-file-full`, `w-mkdir`, `w-mkdir-wprot`, `w-rename`, `w-rename-xvol`, `w-protect`, `w-note`, `w-delete-file`,
  `w-delete-300`, `w-delete-denied` (uaeOnly), `w-delete-stops` (uaeOnly), `w-replace-busy` (uaeOnly), `w-off`
  (posixOnly), `w-protocol-3`.
- [ ] Steps: write the scenarios and the vitest case (`pnpm vitest run tools/receive/receive.int.test.ts`) first: FAIL;
  implement rx_posix; PASS; commit.

### Task 5: The Amiga side

- `afs.c`: `join` passes a path with `:` through; every write hook (open_w, write, close_w, rename, remove, make_dir,
  set_meta, the five w_*) runs between `quiet_on()`/`quiet_off()` and stores `IoErr()` in `c->err` on failure; `a_err`,
  `a_free_at` (Lock of the volume part, as `a_free`), `a_mkdir` (CreateDir+UnLock), `a_rename`, `a_delete`,
  `a_protect`, `a_note`. No new stack buffers over the existing 512-byte joins.
- `config.c`: `cfg_write_load`/`cfg_write_save` (`webadf/Write`).
- `main.c`: template with `WRITE/S` (args[7]), the SEND/M filter takes `WRITE`, W11, `$VER: Transfer 2.5 (31.10.2026)`.
- `shell.c`: `q->write`; "Writing on: the web app can change your disks"; RX_EV_SKIP line; "Web: copied to <path>" for
  an absolute DONE; the minors' messages (`not enough memory: N files not queued`; a single file's reason).
- `gui.c`: `G_WRITE` checkbox row "Let the web app change my disks", `GA_Disabled` while browse is off; unticking
  browse unticks and saves write; status words; skipped rows; the minors.
- `ipc.c`: the hand-off's answer names `q->why`.
- [ ] Steps: `build.sh` compiles (the pin check is expected to fail until Task 6); commit.

### Task 6: FS-UAE on 2.04, 3.1, 3.2; docs; the pin

- `uae-test.sh` mode `write`: Work: holds `Tools/`, `a.txt`, `Keep.txt`, `Old/` (300 files), `Hold.txt` (held open by
  `Run Wait >Work:Hold.txt 600`); DF0 `Prot` (ADF, write-protected); DF2 `Full` (ADF nearly full, `Locked` with the
  d-bit cleared, `Stuck/` with two files and a d-bit-cleared `Stuck/locked`); Transfer started
  `Work:Transfer BROWSE WRITE TO Work:Out >Work:receive.log`; then `run-scenarios.ts --write --uae`, and
  "WRITE without SAVE stored nothing".
- gui mode gains `WRITE`; a screenshot shows both checkboxes.
- `send-scenarios.ts` expects `Transfer 2.5`.
- README / ReadMe: protocol 4, the switch, the commands.
- Pin: `tools/receive/build.sh tools/receive/dist/Transfer --pin`, then a second build `PASS pinned`.
- [ ] Runs: `write` on 32, 31, 204; `shell`, `send`, `browse` on 31; `gui` on 32 (screenshot). Commit.
