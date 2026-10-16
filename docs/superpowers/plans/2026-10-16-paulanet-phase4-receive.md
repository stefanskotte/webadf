# PaulaNET Phase 4, increment 1: `Receive` (the Amiga side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Receive`, the Amiga program that takes files a board pushes over TCP port 6800 and saves them in a
chosen folder. It has a Shell form and a gadtools window. It is proven on Kickstart 2.04 and 3.1 in FS-UAE against a
fake board running on the Mac.

**Architecture:**
- A portable C core (`tools/receive/core/`) holds every decision and is host-tested:
  - the CRC32;
  - name and path rules;
  - the protocol state machine, which reaches the filesystem through a callback table.
- Three thin front ends sit on top of it:
  - a POSIX one, used for fast integration tests on the Mac and in CI;
  - the Amiga Shell form;
  - the Amiga gadtools window.
- A TypeScript fake board (`tools/receive/fake-board.ts`) speaks the board's side of the protocol. Shared scenarios
  check outcomes against the files on disk, for both the POSIX build and FS-UAE.

**Tech Stack:**
- C89-style C, built two ways:
  - with the host `cc` for tests;
  - with `m68k-amigaos-gcc` 6.5.0b, from Docker image
    `stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f` (linux/amd64),
    with `-m68000 -Os -noixemul`.
- AmigaOS V37 libraries: exec, dos, intuition, gadtools, graphics, asl, bsdsocket.
- Node 24+ with `tsx` and vitest.
- FS-UAE (`/Applications/FS-UAE.app`) with `bsdsocket_library = 1`.

**Spec:** `docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md`. This plan covers spec §2
(protocol), §5 (`Receive`) and §7's core, FS-UAE and 2.04 lines. Increments 2 (firmware 1.14.0 and the server queue)
and 3 (web sources, card, and the driver disk with `Install`) get their own plans once this one has landed.

## Global Constraints

- **TCP port 6800**, protocol version 1, ASCII lines ending in LF; names and comments are ISO-8859-1 bytes,
  length-prefixed `<len>:<bytes>`.
- **The Amiga floor:**
  - Kickstart 2.04 (V37), 68000, no FPU;
  - only intuition, gadtools, graphics, asl, dos, exec and bsdsocket; no MUI, ReAction, ClassAct, BOOPSI classes or
    third-party libraries.
- **Names:**
  - each path part is at most 30 bytes; no `:`, no control bytes (< 0x20, 0x7f), and not `.` or `..`;
  - `/` separates parts; the whole path is at most 255 bytes;
  - nothing is ever overwritten: `Name_2.ext`, `Name_3.ext`, …;
  - the receiver never writes outside the chosen folder.
- **Files:**
  - 4 MB per file maximum (4,194,304 bytes);
  - at most 32 waiting files in a list;
  - a comment is at most 79 bytes, which is AmigaDOS's limit.
- **Settings:** the folder setting is the file `ENVARC:webadf/ReceiveDir`, copied to `ENV:webadf/ReceiveDir`; the
  default is `RAM:`.
- **Shell template:** `TO/K,SAVE/S,GUI/S`. Ctrl-C stops the program.
- **The window:** gadtools, font-sensitive, and it fits 640×200. Its status texts are exactly:
  - `Listening on port 6800`;
  - `No TCP/IP stack running (bsdsocket.library)`;
  - `Folder not found`.
- **Error codes:** `space`, `crc`, `name`, `write`, `folder`, `busy`, plus `size` (see the ruling below).
- **Never pattern-kill.** Stop FS-UAE and the POSIX receiver only by the PID your own script started. Never commit
  Kickstart ROMs or Workbench ADFs.
- **Git:** never `git stash`; never `git add -A`. Work in worktree `.claude/worktrees/receive` on branch
  `feat/receive`.

**Rulings made while writing this plan** (spec deviations, recorded so the executor carries them):
- **Ruling: the temporary file is `.webadf-rx` in the target folder**, not `.rx<id>`. An id can be 40 characters,
  and `.rx` plus 40 would break the 30-character limit. Only one file is received at a time, so one fixed name per
  folder is enough. A crash leftover is simply overwritten by the next file. Cost if wrong: a rename. Task 2 updates
  spec §2 to match.
- **Ruling: error code `size`** is added for a `FILE` larger than 4 MB. The server never sends one, so it only guards
  against a buggy or foreign sender. Cost if wrong: one string. Task 2 adds it to spec §2.
- **Ruling: increment 1 does not change the PaulaNET disk.** Adding `Receive` to the disk changes
  `PAULANET_DISK_SHA256`, and therefore what production boards are sent. That switch needs a rollout plan (keeping
  the old sha referenced, and what a board in Network mode does when DF1's disk changes), so it belongs to increment
  3. Increment 1 ships `Receive` as a pinned binary built by `tools/receive/build.sh`. Cost if wrong: none for
  users; increment 3 does the disk.

## Review Focus

1. **A LAN port scanner or a browser hits port 6800** (`GET / HTTP/1.0`, or junk with no LF). `Receive` must not
   crash, must drop that connection, and must serve the next real board. *Pinned in Task 2 (garbage line, overflow)
   and Task 3 (a garbage connection, then a real session).*
2. **A second connection while one is active** must get `ERR - busy receiver busy` and be closed, and the first must
   finish undisturbed. *Pinned in Task 3.*
3. **Latin-1 names** (`Café.txt`) must arrive under that name, not mangled. *Pinned in Task 3 (POSIX: it converts to
   UTF-8 on the host) and Task 4 (FS-UAE).*
4. **The folder disappears while `Receive` runs** (a deleted drawer, a removed disk). The next file must get
   `ERR folder`, not a write into the wrong place. *Pinned in Task 2 and Task 3.*
5. **AmigaDOS names are case-insensitive:** `HELLO.TXT` after `Hello.txt` must not overwrite it. *Pinned in Task 4
   (FS-UAE `case` scenario).*

---

## File structure

```
tools/receive/
  core/rx_crc.h, rx_crc.c        CRC-32 (IEEE, reflected 0xEDB88320), incremental
  core/rx_names.h, rx_names.c    path rules, collision candidates, rx_utoa
  core/rx_proto.h, rx_proto.c    the protocol state machine over an rx_fs callback table
  test/run.sh                    builds and runs the host tests (uses wifi-floppy/firmware/test/harness.h)
  test/test_crc.c, test_names.c, test_proto.c, fakefs.h
  posix/rx_posix.c               host front end: BSD sockets + POSIX files (tests, CI)
  fake-board.ts                  the board's side of the protocol (TypeScript, node:net)
  scenarios.ts                   shared scenarios + checks against a folder
  run-scenarios.ts               CLI: run the scenarios against a listening receiver
  receive.int.test.ts            vitest: POSIX receiver x scenarios
  amiga/afs.h, afs.c             rx_fs over dos.library
  amiga/config.c, config.h       ENV:/ENVARC: folder setting
  amiga/net.c, net.h             bsdsocket listener + WaitSelect loop shared by both front ends
  amiga/shell.c, gui.c, ui.h     the two front ends
  amiga/main.c                   Workbench vs Shell dispatch, ReadArgs
  build.sh                       Docker cross-build, deterministic, sha pinned in receive.sha256
  receive.sha256                 the pin
  uae/uae-test.sh                boots FS-UAE (2.04 or 3.1) with Receive, runs the scenarios
  uae/window-id.swift            finds FS-UAE's window id for a screenshot
  README.md                      what it is, how to build and test
.github/workflows/receive.yml    host tests + POSIX integration + build pin, on tools/receive/** changes
```

`package.json` gets three scripts: `receive:test`, `receive:build` and `receive:uae`. `vitest.config.*` gets
`'tools/**/*.test.ts'` in `include`.

---

### Task 1: CRC-32 and name rules (core) with the host test runner

**Files:**
- Create: `tools/receive/core/rx_crc.h`, `tools/receive/core/rx_crc.c`
- Create: `tools/receive/core/rx_names.h`, `tools/receive/core/rx_names.c`
- Create: `tools/receive/test/run.sh`, `tools/receive/test/test_crc.c`, `tools/receive/test/test_names.c`
- Modify: `package.json` (scripts: `"receive:test": "tools/receive/test/run.sh"`)

**Interfaces:**
- Produces:
  - `unsigned long rx_crc32_update(unsigned long crc, const unsigned char *p, unsigned long n);` Start with `crc = 0`
    and chain the calls; the result is the standard CRC-32 (zlib's `crc32`).
  - `#define RX_PART_MAX 30`, `#define RX_PATH_MAX 255`.
  - `int rx_path_ok(const char *path);` returns 1 if the path is safe, else 0.
  - `int rx_candidate(const char *path, unsigned n, char *out);` writes candidate `n` (1 = the path itself) into
    `out[RX_PATH_MAX+1]`; returns 0, or -1 if it cannot fit.
  - `unsigned rx_utoa(unsigned long v, char *out);` writes the decimal digits and a NUL; returns the digit count.

- [ ] **Step 1: Set up the worktree**

```bash
cd /Users/sfs/Devel/webadf
git worktree add .claude/worktrees/receive -b feat/receive master
cd .claude/worktrees/receive
```

(The worktree needs no `pnpm install` until Task 3. Then run a real `pnpm install --offline`, never a symlinked
node_modules.)

- [ ] **Step 2: Write the test runner**

`tools/receive/test/run.sh`:

```bash
#!/usr/bin/env bash
# Host tests for Receive's portable core. Uses the firmware's harness.h (CHECK, RUN, REPORT).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
fail=0
CC="${CC:-cc}"
for t in test_*.c; do
  bin=".build/${t%.c}"
  "$CC" -std=c99 -O1 -g -Wall -Wextra -Werror -I../core -I../../../wifi-floppy/firmware/test \
    -o "$bin" "$t" ../core/rx_crc.c ../core/rx_names.c ../core/rx_proto.c
  "$bin" || fail=1
done
exit $fail
```

`rx_proto.c` does not exist until Task 2. For Task 1, create it as an empty translation unit, so the link line stays
the same from the start:

`tools/receive/core/rx_proto.c` (temporary content, replaced in Task 2):

```c
/* Replaced by the protocol state machine in Task 2. */
typedef int rx_proto_empty_unit;
```

Then `chmod +x tools/receive/test/run.sh`, and add `.build/` to `tools/receive/test/.gitignore`:

```
.build/
```

- [ ] **Step 3: Write the failing tests**

`tools/receive/test/test_crc.c`:

```c
#include "harness.h"
#include "rx_crc.h"

static void crc_check_vector(void) {
    CHECK(rx_crc32_update(0, (const unsigned char *)"123456789", 9) == 0xCBF43926UL, "check value");
}
static void crc_hello(void) {
    CHECK(rx_crc32_update(0, (const unsigned char *)"hello", 5) == 0x3610A686UL, "crc32(hello)");
}
static void crc_chained_equals_whole(void) {
    unsigned long c = rx_crc32_update(0, (const unsigned char *)"1234", 4);
    c = rx_crc32_update(c, (const unsigned char *)"56789", 5);
    CHECK(c == 0xCBF43926UL, "chained");
}
static void crc_empty_is_zero(void) {
    CHECK(rx_crc32_update(0, (const unsigned char *)"", 0) == 0, "empty");
}
int main(void) {
    RUN(crc_check_vector); RUN(crc_hello); RUN(crc_chained_equals_whole); RUN(crc_empty_is_zero);
    return REPORT();
}
```

`tools/receive/test/test_names.c`:

```c
#include "harness.h"
#include "rx_names.h"

static void ok_paths(void) {
    CHECK(rx_path_ok("Hello.txt"), "plain");
    CHECK(rx_path_ok("mods/axelf.mod"), "subfolder");
    CHECK(rx_path_ok("Caf\xe9.txt"), "latin-1");
    CHECK(rx_path_ok("123456789012345678901234567890"), "30 bytes");
    CHECK(rx_path_ok(".info"), "leading dot is a name");
    CHECK(rx_path_ok("a b/c d"), "spaces");
}
static void bad_paths(void) {
    CHECK(!rx_path_ok(""), "empty");
    CHECK(!rx_path_ok("../x"), "dotdot");
    CHECK(!rx_path_ok("a/../x"), "inner dotdot");
    CHECK(!rx_path_ok("./x"), "dot");
    CHECK(!rx_path_ok("/x"), "absolute");
    CHECK(!rx_path_ok("x/"), "trailing slash");
    CHECK(!rx_path_ok("a//b"), "double slash");
    CHECK(!rx_path_ok("DH0:x"), "device");
    CHECK(!rx_path_ok("a\nb"), "control byte");
    CHECK(!rx_path_ok("a\x7f"), "DEL");
    CHECK(!rx_path_ok("1234567890123456789012345678901"), "31 bytes");
    char longp[300]; memset(longp, 'a', 299); longp[299] = 0;
    for (int i = 20; i < 299; i += 21) longp[i] = '/';
    CHECK(!rx_path_ok(longp), "over 255 bytes");
}
static void candidates(void) {
    char out[RX_PATH_MAX + 1];
    CHECK_EQ_INT(rx_candidate("Hello.txt", 1, out), 0); CHECK(strcmp(out, "Hello.txt") == 0, "n=1 is the path");
    rx_candidate("Hello.txt", 2, out); CHECK(strcmp(out, "Hello_2.txt") == 0, "Hello_2.txt");
    rx_candidate("dir/Foo", 3, out); CHECK(strcmp(out, "dir/Foo_3") == 0, "no extension");
    rx_candidate(".info", 2, out); CHECK(strcmp(out, ".info_2") == 0, "leading dot is not an extension");
    rx_candidate("a.b.lha", 2, out); CHECK(strcmp(out, "a.b_2.lha") == 0, "last dot");
    /* 26 + 4 = 30 bytes: the stem is cut to make room for "_2" and then "_10". */
    rx_candidate("AAAAAAAAAAAAAAAAAAAAAAAAAA.lha", 2, out);
    CHECK(strcmp(out, "AAAAAAAAAAAAAAAAAAAAAAAA_2.lha") == 0, "stem truncated, 30 bytes");
    CHECK_EQ_INT(strlen(out), 30);
    rx_candidate("AAAAAAAAAAAAAAAAAAAAAAAAAA.lha", 10, out);
    CHECK(strcmp(out, "AAAAAAAAAAAAAAAAAAAAAAA_10.lha") == 0, "_10");
    /* An extension so long that no stem byte is left: refused. */
    CHECK_EQ_INT(rx_candidate("a.12345678901234567890123456789", 2, out), -1);
}
static void utoa(void) {
    char b[12];
    CHECK_EQ_INT(rx_utoa(0, b), 1); CHECK(strcmp(b, "0") == 0, "0");
    CHECK_EQ_INT(rx_utoa(4194304UL, b), 7); CHECK(strcmp(b, "4194304") == 0, "4194304");
    CHECK_EQ_INT(rx_utoa(4294967295UL, b), 10); CHECK(strcmp(b, "4294967295") == 0, "max");
}
int main(void) { RUN(ok_paths); RUN(bad_paths); RUN(candidates); RUN(utoa); return REPORT(); }
```

- [ ] **Step 4: Run the tests to watch them fail**

Run: `tools/receive/test/run.sh`
Expected: compile errors, `rx_crc.h: No such file or directory`.

- [ ] **Step 5: Implement**

`tools/receive/core/rx_crc.h`:

```c
#ifndef RX_CRC_H
#define RX_CRC_H
/* CRC-32 as zlib computes it (IEEE 802.3, reflected polynomial 0xEDB88320). Start with crc = 0 and chain. */
unsigned long rx_crc32_update(unsigned long crc, const unsigned char *p, unsigned long n);
#endif
```

`tools/receive/core/rx_crc.c`:

```c
#include "rx_crc.h"

static unsigned long table[256];
static int ready;

static void init(void) {
    unsigned long c;
    int n, k;
    for (n = 0; n < 256; n++) {
        c = (unsigned long)n;
        for (k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320UL ^ (c >> 1) : c >> 1;
        table[n] = c;
    }
    ready = 1;
}

unsigned long rx_crc32_update(unsigned long crc, const unsigned char *p, unsigned long n) {
    if (!ready) init();
    crc = (crc ^ 0xFFFFFFFFUL) & 0xFFFFFFFFUL;
    while (n--) crc = table[(crc ^ *p++) & 0xFF] ^ (crc >> 8);
    return (crc ^ 0xFFFFFFFFUL) & 0xFFFFFFFFUL;
}
```

`tools/receive/core/rx_names.h`:

```c
#ifndef RX_NAMES_H
#define RX_NAMES_H
#define RX_PART_MAX 30
#define RX_PATH_MAX 255
/* 1 if path is a safe relative path: 1..255 bytes, '/'-separated parts of 1..30 bytes, no ':', no byte < 0x20
   or 0x7f, no part "." or "..", no leading, trailing or double '/'. */
int rx_path_ok(const char *path);
/* Candidate n for path into out[RX_PATH_MAX+1]: n <= 1 is path itself; n >= 2 puts "_n" before the last part's
   extension (its last '.', unless that dot starts the name), cutting the stem so the part stays <= 30 bytes.
   Returns 0, or -1 if it cannot fit. */
int rx_candidate(const char *path, unsigned n, char *out);
/* Decimal digits of v and a NUL into out (>= 11 bytes); returns the number of digits. */
unsigned rx_utoa(unsigned long v, char *out);
#endif
```

`tools/receive/core/rx_names.c`:

```c
#include <string.h>
#include "rx_names.h"

static int part_ok(const char *p, size_t n) {
    size_t i;
    if (n < 1 || n > RX_PART_MAX) return 0;
    if ((n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.')) return 0;
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)p[i];
        if (c < 0x20 || c == 0x7f || c == ':') return 0;
    }
    return 1;
}

int rx_path_ok(const char *path) {
    size_t len = strlen(path), start = 0, i;
    if (len < 1 || len > RX_PATH_MAX) return 0;
    for (i = 0; i <= len; i++) {
        if (i == len || path[i] == '/') {
            if (!part_ok(path + start, i - start)) return 0;
            start = i + 1;
        }
    }
    return 1;
}

unsigned rx_utoa(unsigned long v, char *out) {
    char tmp[11];
    unsigned n = 0, i;
    do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    for (i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
    out[n] = 0;
    return n;
}

int rx_candidate(const char *path, unsigned n, char *out) {
    const char *last = strrchr(path, '/');
    size_t dirlen = last ? (size_t)(last - path + 1) : 0;
    const char *name = path + dirlen;
    size_t nlen = strlen(name), stem, extlen, slen;
    const char *dot;
    char suf[12];
    if (n <= 1) {
        if (strlen(path) > RX_PATH_MAX) return -1;
        strcpy(out, path);
        return 0;
    }
    dot = strrchr(name, '.');
    if (!dot || dot == name) dot = name + nlen;
    stem = (size_t)(dot - name);
    extlen = nlen - stem;
    suf[0] = '_';
    slen = 1 + rx_utoa(n, suf + 1);
    if (stem + slen + extlen > RX_PART_MAX) {
        if (slen + extlen >= RX_PART_MAX) return -1;
        stem = RX_PART_MAX - slen - extlen;
    }
    if (dirlen + stem + slen + extlen > RX_PATH_MAX) return -1;
    memcpy(out, path, dirlen);
    memcpy(out + dirlen, name, stem);
    memcpy(out + dirlen + stem, suf, slen);
    memcpy(out + dirlen + stem + slen, dot, extlen);
    out[dirlen + stem + slen + extlen] = 0;
    return 0;
}
```

- [ ] **Step 6: Run the tests to watch them pass**

Run: `tools/receive/test/run.sh`
Expected: `test_crc.c: 4 checks, 0 failed` and `test_names.c: … 0 failed`, exit 0. (`test_proto.c` does not exist
yet, so the glob runs only these two.)

- [ ] **Step 7: Commit**

```bash
git add tools/receive/core tools/receive/test package.json
git commit -m "receive: CRC-32 and name rules for the Amiga receiver's core, host-tested"
```

---

### Task 2: The protocol state machine (core)

**Files:**
- Create: `tools/receive/core/rx_proto.h`; replace `tools/receive/core/rx_proto.c`
- Create: `tools/receive/test/fakefs.h`, `tools/receive/test/test_proto.c`
- Modify: `docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` §2 (the temp name and the `size`
  code; see the rulings)

**Interfaces:**
- Consumes: `rx_crc32_update`, `rx_path_ok`, `rx_candidate`, `rx_utoa`, `RX_PATH_MAX` (Task 1).
- Produces (exact; Tasks 3-5 call these):

```c
#define RX_PORT 6800
#define RX_ID_MAX 40
#define RX_LIST_MAX 32
#define RX_LINE_MAX 640
#define RX_OUT_MAX 1024
#define RX_FILE_MAX 4194304UL
#define RX_COMMENT_MAX 79
#define RX_TMP_NAME ".webadf-rx"

typedef struct rx_fs {
    void *ctx;
    int (*folder_ok)(void *ctx);                    /* 1 if the target folder exists and is a folder */
    unsigned long (*free_bytes)(void *ctx);         /* free bytes on its volume; 0xFFFFFFFF if unknown or more */
    int (*exists)(void *ctx, const char *rel);      /* 1 if rel exists (file or folder) */
    int (*make_dir)(void *ctx, const char *rel);    /* 0 if rel is now a folder */
    int (*open_w)(void *ctx, const char *rel);      /* 0 ok; creates or truncates; one file at a time */
    int (*write)(void *ctx, const unsigned char *b, unsigned long n); /* 0 ok */
    int (*close_w)(void *ctx);                      /* 0 ok */
    int (*rename)(void *ctx, const char *from, const char *to);       /* 0 ok */
    int (*remove)(void *ctx, const char *rel);      /* 0 ok */
    int (*set_meta)(void *ctx, const char *rel, unsigned long prot, const char *comment); /* 0 ok */
} rx_fs;

enum { RX_EV_HELLO, RX_EV_LIST, RX_EV_BEGIN, RX_EV_PROGRESS, RX_EV_DONE, RX_EV_FAILED };
typedef struct rx_event {
    int kind;
    const char *id;       /* BEGIN, PROGRESS, DONE, FAILED */
    const char *path;     /* BEGIN, FAILED: as sent; DONE: as saved */
    unsigned long size;   /* BEGIN, PROGRESS, DONE */
    unsigned long bytes;  /* PROGRESS */
    const char *text;     /* FAILED: the reason, e.g. "checksum mismatch" */
} rx_event;
typedef void (*rx_event_fn)(void *uctx, const rx_event *ev);

typedef struct rx_item { char id[RX_ID_MAX + 1]; unsigned long size; char path[RX_PATH_MAX + 1]; } rx_item;

typedef struct rx_session { /* fields private to rx_proto.c except list/list_n */
    const rx_fs *fs; rx_event_fn on_event; void *uctx;
    int in_data;
    char line[RX_LINE_MAX + 1]; unsigned line_n;
    rx_item list[RX_LIST_MAX]; unsigned list_n, list_expect, list_seen;
    char cur_id[RX_ID_MAX + 1], cur_path[RX_PATH_MAX + 1], cur_tmp[RX_PATH_MAX + 1], cur_comment[RX_COMMENT_MAX + 1];
    unsigned long cur_size, cur_left, cur_crc_want, cur_crc, cur_prot, cur_mark;
    int cur_open, cur_write_failed;
    char out[RX_OUT_MAX]; unsigned out_n;
} rx_session;

void rx_init(rx_session *s, const rx_fs *fs, rx_event_fn on_event, void *uctx);
int rx_feed(rx_session *s, const unsigned char *data, unsigned long n); /* 0, or -1: close the connection */
unsigned rx_take_output(rx_session *s, char *dst, unsigned cap);       /* moves pending reply bytes out */
void rx_disconnected(rx_session *s);   /* the peer went away: drop a half-written file */
int rx_busy(const rx_session *s);      /* 1 while a file is being received */
```

**Behaviour (each point is a test below):**
- `WEBADF <v>` → `READY 1\n` and a HELLO event.
- `PING` → `PONG\n`.
- `LIST <n>` takes the next `n` lines (`<id> <size> <len>:<path>`), keeps at most 32 valid ones, then sends a LIST
  event. `LIST 0` sends it at once.
- `FILE <id> <size> <crc hex> <prot hex> <len>:<path> <len>:<comment>` is checked in this order:
  1. a malformed line → `ERR <id or -> name bad request`;
  2. size > 4 MB → `ERR <id> size file too large`;
  3. a bad path → `ERR <id> name bad name`;
  4. the folder is missing → `ERR <id> folder folder not found`;
  5. free bytes < size + 8192 → `ERR <id> space not enough space`;
  6. a parent folder cannot be made → `ERR <id> write cannot create folder`;
  7. the temp file cannot be opened → `ERR <id> write cannot write`;
  8. otherwise `GO <id>\n`. A comment over 79 bytes is cut to 79.
- **Data:** exactly `size` bytes after `GO` (zero bytes means the file finishes at once). A PROGRESS event is sent
  every 16 KB.
- **The end of a file:**
  - a write failure → the temp file is removed, `ERR <id> write cannot write`;
  - a CRC mismatch → the temp file is removed, `ERR <id> crc checksum mismatch`;
  - otherwise the first free candidate (1..99) is chosen; none free → `ERR <id> name no free name`;
  - the rename fails → `ERR <id> write cannot write`;
  - then `set_meta` (its failure is ignored) and `OK <id> <len>:<saved>\n` with a DONE event.
- **Unknown lines** are ignored. A line longer than 640 bytes makes `rx_feed` return -1. A `\r` before the LF is
  dropped.
- **`rx_disconnected`** during a file: close, remove the temp file, FAILED event "connection lost".

- [ ] **Step 1: Write the fake filesystem**

`tools/receive/test/fakefs.h`:

```c
/* An in-memory rx_fs for the core's tests: up to 32 entries, 64 KB each. */
#include <string.h>
#include "rx_proto.h"

#define FF_MAX 32
typedef struct { char name[RX_PATH_MAX + 1]; int is_dir; unsigned char data[65536]; unsigned long len;
                 unsigned long prot; char comment[RX_COMMENT_MAX + 1]; } ff_entry;
typedef struct {
    ff_entry e[FF_MAX]; int n;
    int folder_present; unsigned long free; int fail_write_after; /* -1 never */ long written;
    int open_idx; int make_dir_calls; int fail_make_dir;
} fakefs;

static int ff_find(fakefs *f, const char *rel) {
    for (int i = 0; i < f->n; i++) if (strcmp(f->e[i].name, rel) == 0) return i;
    return -1;
}
static int ff_add(fakefs *f, const char *rel, int is_dir) {
    int i = ff_find(f, rel);
    if (i >= 0) return i;
    i = f->n++;
    memset(&f->e[i], 0, sizeof f->e[i]);
    strcpy(f->e[i].name, rel); f->e[i].is_dir = is_dir;
    return i;
}
static int ff_folder_ok(void *c) { return ((fakefs *)c)->folder_present; }
static unsigned long ff_free(void *c) { return ((fakefs *)c)->free; }
static int ff_exists(void *c, const char *rel) { return ff_find(c, rel) >= 0; }
static int ff_make_dir(void *c, const char *rel) {
    fakefs *f = c; f->make_dir_calls++;
    if (f->fail_make_dir) return -1;
    ff_add(f, rel, 1); return 0;
}
static int ff_open_w(void *c, const char *rel) {
    fakefs *f = c; int i = ff_add(f, rel, 0); f->e[i].len = 0; f->open_idx = i; f->written = 0; return 0;
}
static int ff_write(void *c, const unsigned char *b, unsigned long n) {
    fakefs *f = c;
    if (f->fail_write_after >= 0 && f->written + (long)n > f->fail_write_after) return -1;
    ff_entry *e = &f->e[f->open_idx];
    memcpy(e->data + e->len, b, n); e->len += n; f->written += (long)n; return 0;
}
static int ff_close_w(void *c) { ((fakefs *)c)->open_idx = -1; return 0; }
static int ff_rename(void *c, const char *from, const char *to) {
    fakefs *f = c; int i = ff_find(f, from);
    if (i < 0 || ff_find(f, to) >= 0) return -1;
    strcpy(f->e[i].name, to); return 0;
}
static int ff_remove(void *c, const char *rel) {
    fakefs *f = c; int i = ff_find(f, rel);
    if (i < 0) return -1;
    f->e[i] = f->e[--f->n]; return 0;
}
static int ff_set_meta(void *c, const char *rel, unsigned long prot, const char *comment) {
    fakefs *f = c; int i = ff_find(f, rel);
    if (i < 0) return -1;
    f->e[i].prot = prot; strcpy(f->e[i].comment, comment); return 0;
}
static void ff_init(fakefs *f, rx_fs *fs) {
    memset(f, 0, sizeof *f);
    f->folder_present = 1; f->free = 0xFFFFFFFFUL; f->fail_write_after = -1; f->open_idx = -1;
    fs->ctx = f; fs->folder_ok = ff_folder_ok; fs->free_bytes = ff_free; fs->exists = ff_exists;
    fs->make_dir = ff_make_dir; fs->open_w = ff_open_w; fs->write = ff_write; fs->close_w = ff_close_w;
    fs->rename = ff_rename; fs->remove = ff_remove; fs->set_meta = ff_set_meta;
}
```

- [ ] **Step 2: Write the failing tests**

`tools/receive/test/test_proto.c`:

```c
#include <stdio.h>
#include <stdlib.h>
#include "harness.h"
#include "rx_crc.h"
#include "fakefs.h"

static fakefs F; static rx_fs FS; static rx_session S;
static rx_event last_ev[64]; static int n_ev; static char ev_text[64][300];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    last_ev[n_ev] = *e;
    snprintf(ev_text[n_ev], 300, "%s", e->kind == RX_EV_DONE || e->kind == RX_EV_FAILED ? (e->path ? e->path : "") : "");
    n_ev++;
}
static void setup(void) { ff_init(&F, &FS); n_ev = 0; rx_init(&S, &FS, on_ev, NULL); }
static int feed(const char *str) { return rx_feed(&S, (const unsigned char *)str, strlen(str)); }
static char outbuf[4096];
static const char *out(void) { unsigned n = rx_take_output(&S, outbuf, sizeof outbuf - 1); outbuf[n] = 0; return outbuf; }
static void file_line(char *dst, const char *id, const char *data, unsigned long len, unsigned long prot,
                      const char *path, const char *comment, int bad_crc) {
    unsigned long crc = rx_crc32_update(0, (const unsigned char *)data, len) ^ (bad_crc ? 1UL : 0UL);
    sprintf(dst, "FILE %s %lu %lx %lx %u:%s %u:%s\n", id, len, crc, prot, (unsigned)strlen(path), path,
            (unsigned)strlen(comment), comment);
}
static int has(const char *name) { return ff_find(&F, name) >= 0; }

static void hello_and_ping(void) {
    setup();
    feed("WEBADF 1\n"); CHECK(strcmp(out(), "READY 1\n") == 0, "READY");
    CHECK_EQ_INT(last_ev[0].kind, RX_EV_HELLO);
    feed("PING\r\n"); CHECK(strcmp(out(), "PONG\n") == 0, "PONG, CR dropped");
}
static void list_items(void) {
    setup();
    feed("LIST 2\na1 412000 13:Turrican2.lha\nb2 58000 14:mods/axelf.mod\n");
    CHECK_EQ_INT(S.list_n, 2);
    CHECK(strcmp(S.list[1].path, "mods/axelf.mod") == 0, "path"); CHECK_EQ_INT(S.list[0].size, 412000);
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_LIST);
    feed("LIST 0\n"); CHECK_EQ_INT(S.list_n, 0);
}
static void list_split_across_feeds_and_bad_line_skipped(void) {
    setup();
    feed("LIST 3\na1 5 3:a"); feed("bc\n../bad line\nc3 9 1:z\n");
    CHECK_EQ_INT(S.list_n, 2); CHECK(strcmp(S.list[0].path, "abc") == 0, "split");
}
static void one_file(void) {
    char l[600]; setup();
    file_line(l, "a1", "hello", 5, 0, "Hello.txt", "", 0);
    feed(l); CHECK(strcmp(out(), "GO a1\n") == 0, "GO");
    CHECK(rx_busy(&S), "busy while receiving");
    feed("hel"); feed("lo");
    CHECK(strcmp(out(), "OK a1 9:Hello.txt\n") == 0, "OK");
    CHECK(has("Hello.txt") && !has(RX_TMP_NAME), "renamed, temp gone");
    CHECK(memcmp(F.e[ff_find(&F, "Hello.txt")].data, "hello", 5) == 0, "content");
    CHECK(!rx_busy(&S), "idle after");
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_DONE);
}
static void line_and_data_in_one_feed_then_next_line(void) {
    char l[700]; setup();
    file_line(l, "a1", "hi", 2, 0, "X", "", 0); strcat(l, "hiPING\n");
    feed(l); CHECK(strcmp(out(), "GO a1\nOK a1 1:X\nPONG\n") == 0, "all three replies");
}
static void collision(void) {
    char l[600]; setup(); ff_add(&F, "Hello.txt", 0); ff_add(&F, "Hello_2.txt", 0);
    file_line(l, "a2", "x", 1, 0, "Hello.txt", "", 0); feed(l); feed("x");
    CHECK(strstr(out(), "OK a2 11:Hello_3.txt\n") != NULL, "third candidate");
}
static void subfolder_made(void) {
    char l[600]; setup();
    file_line(l, "b1", "m", 1, 0, "mods/new/axelf.mod", "", 0); feed(l); feed("m");
    CHECK(has("mods") && has("mods/new") && has("mods/new/axelf.mod"), "folders and file");
    CHECK(!has("mods/new/" RX_TMP_NAME), "temp in the target folder is gone");
}
static void bad_crc(void) {
    char l[600]; setup();
    file_line(l, "c1", "abc", 3, 0, "Bad.bin", "", 1); feed(l); feed("abc");
    CHECK(strstr(out(), "ERR c1 crc checksum mismatch\n") != NULL, "crc error");
    CHECK(!has("Bad.bin") && !has(RX_TMP_NAME), "nothing left");
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_FAILED);
}
static void refusals(void) {
    char l[600];
    setup(); file_line(l, "d1", "x", 1, 0, "../x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d1 name bad name\n") == 0, "bad name");
    setup(); F.folder_present = 0; file_line(l, "d2", "x", 1, 0, "x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d2 folder folder not found\n") == 0, "folder");
    setup(); F.free = 8192; file_line(l, "d3", "x", 1, 0, "x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d3 space not enough space\n") == 0, "space");
    setup(); feed("FILE d4 4194305 0 0 1:x 0:\n");
    CHECK(strcmp(out(), "ERR d4 size file too large\n") == 0, "size");
    setup(); feed("FILE d5 zz 0 0 1:x 0:\n");
    CHECK(strcmp(out(), "ERR d5 name bad request\n") == 0, "malformed");
    setup(); F.fail_make_dir = 1; file_line(l, "d6", "x", 1, 0, "a/x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d6 write cannot create folder\n") == 0, "mkdir");
    /* After a refusal the receiver is idle and takes the next file. */
    setup(); file_line(l, "d7", "x", 1, 0, "../x", "", 0); feed(l); out();
    file_line(l, "d8", "y", 1, 0, "y", "", 0); feed(l); feed("y");
    CHECK(strstr(out(), "OK d8 1:y\n") != NULL, "next file after refusal");
}
static void write_failure_consumes_data(void) {
    char l[600]; setup(); F.fail_write_after = 2;
    file_line(l, "e1", "abcdef", 6, 0, "W", "", 0); feed(l); out();
    feed("abcdefPING\n");
    CHECK(strcmp(out(), "ERR e1 write cannot write\nPONG\n") == 0, "error after all bytes, then next line");
    CHECK(!has("W") && !has(RX_TMP_NAME), "removed");
}
static void zero_length(void) {
    setup(); feed("FILE f1 0 0 0 5:Empty 0:\n");
    CHECK(strcmp(out(), "GO f1\nOK f1 5:Empty\n") == 0, "GO then OK at once");
    CHECK(has("Empty"), "file");
}
static void meta_and_comment(void) {
    char l[600]; setup();
    file_line(l, "g1", "x", 1, 0x40, "Script", "a comment with spaces", 0); feed(l); feed("x");
    int i = ff_find(&F, "Script");
    CHECK(i >= 0 && F.e[i].prot == 0x40, "protection");
    CHECK(i >= 0 && strcmp(F.e[i].comment, "a comment with spaces") == 0, "comment");
    char longc[100]; memset(longc, 'c', 99); longc[99] = 0;
    setup(); file_line(l, "g2", "x", 1, 0, "C", longc, 0); feed(l); feed("x");
    i = ff_find(&F, "C"); CHECK(i >= 0 && strlen(F.e[i].comment) == RX_COMMENT_MAX, "comment cut to 79");
}
static void disconnect_mid_file(void) {
    char l[600]; setup();
    file_line(l, "h1", "abcdef", 6, 0, "D", "", 0); feed(l); out(); feed("abc");
    rx_disconnected(&S);
    CHECK(!has(RX_TMP_NAME) && !has("D"), "temp removed");
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_FAILED);
    CHECK(strcmp(last_ev[n_ev - 1].text, "connection lost") == 0, "reason");
    CHECK(!rx_busy(&S), "idle");
}
static void garbage_ignored_overflow_closes(void) {
    setup();
    CHECK_EQ_INT(feed("GET / HTTP/1.0\r\n\r\n"), 0); CHECK(strcmp(out(), "") == 0, "no reply to junk");
    feed("WEBADF 1\n"); CHECK(strcmp(out(), "READY 1\n") == 0, "still works");
    char big[700]; memset(big, 'x', 699); big[699] = 0;
    CHECK_EQ_INT(feed(big), -1);
}
static void progress_every_16k(void) {
    static unsigned char d[40000]; char l[600]; setup();
    for (int i = 0; i < 40000; i++) d[i] = (unsigned char)i;
    F.e[0].len = 0;
    unsigned long crc = rx_crc32_update(0, d, sizeof d);
    sprintf(l, "FILE p1 40000 %lx 0 1:P 0:\n", crc);
    feed(l); out(); n_ev = 0;
    rx_feed(&S, d, sizeof d);
    int prog = 0; for (int i = 0; i < n_ev; i++) if (last_ev[i].kind == RX_EV_PROGRESS) prog++;
    CHECK_EQ_INT(prog, 2);
    CHECK(strstr(out(), "OK p1 1:P\n") != NULL, "ok");
}
int main(void) {
    RUN(hello_and_ping); RUN(list_items); RUN(list_split_across_feeds_and_bad_line_skipped); RUN(one_file);
    RUN(line_and_data_in_one_feed_then_next_line); RUN(collision); RUN(subfolder_made); RUN(bad_crc);
    RUN(refusals); RUN(write_failure_consumes_data); RUN(zero_length); RUN(meta_and_comment);
    RUN(disconnect_mid_file); RUN(garbage_ignored_overflow_closes); RUN(progress_every_16k);
    return REPORT();
}
```

(`fakefs` holds 64 KB per entry, so `progress_every_16k` fits; the static `F` is about 2 MB, which is fine on a host.)

- [ ] **Step 3: Run the tests to watch them fail**

Run: `tools/receive/test/run.sh`
Expected: compile errors, `rx_proto.h: No such file or directory`.

- [ ] **Step 4: Implement `rx_proto.h`** with exactly the declarations in the Interfaces block above, wrapped in
  `#ifndef RX_PROTO_H` / `#define RX_PROTO_H` / `#endif`, after `#include "rx_names.h"`.

- [ ] **Step 5: Implement `rx_proto.c`**

```c
#include <string.h>
#include "rx_crc.h"
#include "rx_names.h"
#include "rx_proto.h"

#define PROGRESS_STEP 16384UL

static void emit(rx_session *s, int kind, const char *id, const char *path, unsigned long size,
                 unsigned long bytes, const char *text) {
    rx_event e;
    if (!s->on_event) return;
    e.kind = kind; e.id = id; e.path = path; e.size = size; e.bytes = bytes; e.text = text;
    s->on_event(s->uctx, &e);
}

static void put(rx_session *s, const char *p, unsigned n) {
    if (s->out_n + n > RX_OUT_MAX) return; /* replies are short; a full buffer means the peer stopped reading */
    memcpy(s->out + s->out_n, p, n);
    s->out_n += n;
}
static void puts_(rx_session *s, const char *p) { put(s, p, (unsigned)strlen(p)); }

static void reply_err(rx_session *s, const char *id, const char *code, const char *text) {
    puts_(s, "ERR "); puts_(s, id[0] ? id : "-"); puts_(s, " "); puts_(s, code); puts_(s, " ");
    puts_(s, text); puts_(s, "\n");
}

void rx_init(rx_session *s, const rx_fs *fs, rx_event_fn on_event, void *uctx) {
    memset(s, 0, sizeof *s);
    s->fs = fs; s->on_event = on_event; s->uctx = uctx;
}

int rx_busy(const rx_session *s) { return s->in_data; }

unsigned rx_take_output(rx_session *s, char *dst, unsigned cap) {
    unsigned n = s->out_n < cap ? s->out_n : cap;
    memcpy(dst, s->out, n);
    memmove(s->out, s->out + n, s->out_n - n);
    s->out_n -= n;
    return n;
}

/* --- line parsing --- */
typedef struct { const char *p, *end; } cur;

static int tok(cur *c, const char **t, unsigned *n) {
    if (c->p >= c->end) return 0;
    *t = c->p;
    while (c->p < c->end && *c->p != ' ') c->p++;
    *n = (unsigned)(c->p - *t);
    if (c->p < c->end) c->p++;
    return *n > 0;
}
static int num(const char *t, unsigned n, int base, unsigned long *v) {
    unsigned long x = 0;
    unsigned i;
    if (n == 0 || n > (base == 16 ? 8u : 10u)) return 0;
    for (i = 0; i < n; i++) {
        int d;
        char ch = t[i];
        if (ch >= '0' && ch <= '9') d = ch - '0';
        else if (base == 16 && ch >= 'a' && ch <= 'f') d = ch - 'a' + 10;
        else if (base == 16 && ch >= 'A' && ch <= 'F') d = ch - 'A' + 10;
        else return 0;
        x = x * (unsigned long)base + (unsigned long)d;
    }
    *v = x & 0xFFFFFFFFUL;
    return 1;
}
/* "<len>:<bytes>" into dst (cap includes the NUL); cut to cap-1 when cut != 0, else refused when longer. */
static int lenstr(cur *c, char *dst, unsigned cap, int cut) {
    unsigned long len = 0;
    const char *q = c->p;
    while (q < c->end && *q >= '0' && *q <= '9') q++;
    if (q == c->p || q >= c->end || *q != ':' || !num(c->p, (unsigned)(q - c->p), 10, &len)) return 0;
    q++;
    if ((unsigned long)(c->end - q) < len) return 0;
    if (memchr(q, 0, len)) return 0;
    if (len > cap - 1) { if (!cut) return 0; memcpy(dst, q, cap - 1); dst[cap - 1] = 0; }
    else { memcpy(dst, q, len); dst[len] = 0; }
    c->p = q + len;
    if (c->p < c->end) { if (*c->p != ' ') return 0; c->p++; }
    return 1;
}
static int id_ok(const char *t, unsigned n) {
    unsigned i;
    if (n < 1 || n > RX_ID_MAX) return 0;
    for (i = 0; i < n; i++) {
        char ch = t[i];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_'))
            return 0;
    }
    return 1;
}
static int is(const char *t, unsigned n, const char *word) { return n == strlen(word) && memcmp(t, word, n) == 0; }

/* --- files --- */
static void parent_of(const char *path, char *dst) {
    const char *last = strrchr(path, '/');
    size_t n = last ? (size_t)(last - path + 1) : 0;
    memcpy(dst, path, n);
    dst[n] = 0;
}
static int make_parents(rx_session *s, const char *path) {
    char buf[RX_PATH_MAX + 1];
    const char *q;
    for (q = strchr(path, '/'); q; q = strchr(q + 1, '/')) {
        size_t n = (size_t)(q - path);
        memcpy(buf, path, n); buf[n] = 0;
        if (!s->fs->exists(s->fs->ctx, buf) && s->fs->make_dir(s->fs->ctx, buf) != 0) return -1;
    }
    return 0;
}
static void fail_file(rx_session *s, const char *code, const char *text) {
    if (s->cur_open) { s->fs->close_w(s->fs->ctx); s->cur_open = 0; }
    s->fs->remove(s->fs->ctx, s->cur_tmp);
    reply_err(s, s->cur_id, code, text);
    s->in_data = 0;
    emit(s, RX_EV_FAILED, s->cur_id, s->cur_path, s->cur_size, 0, text);
}
static void finish_file(rx_session *s) {
    char saved[RX_PATH_MAX + 1], digits[12];
    unsigned n;
    int closed = s->fs->close_w(s->fs->ctx);
    s->cur_open = 0;
    if (s->cur_write_failed || closed != 0) { fail_file(s, "write", "cannot write"); return; }
    if (s->cur_crc != s->cur_crc_want) { fail_file(s, "crc", "checksum mismatch"); return; }
    for (n = 1; n <= 99; n++) {
        if (rx_candidate(s->cur_path, n, saved) != 0) { n = 100; break; }
        if (!s->fs->exists(s->fs->ctx, saved)) break;
    }
    if (n > 99) { fail_file(s, "name", "no free name"); return; }
    if (s->fs->rename(s->fs->ctx, s->cur_tmp, saved) != 0) { fail_file(s, "write", "cannot write"); return; }
    s->fs->set_meta(s->fs->ctx, saved, s->cur_prot, s->cur_comment);
    puts_(s, "OK "); puts_(s, s->cur_id); puts_(s, " ");
    rx_utoa((unsigned long)strlen(saved), digits); puts_(s, digits); puts_(s, ":"); puts_(s, saved); puts_(s, "\n");
    s->in_data = 0;
    emit(s, RX_EV_DONE, s->cur_id, saved, s->cur_size, s->cur_size, 0);
}

static void on_file(rx_session *s, cur *c) {
    const char *t; unsigned n;
    unsigned long size, crc, prot;
    char id[RX_ID_MAX + 1];
    id[0] = 0;
    if (!tok(c, &t, &n) || !id_ok(t, n)) { reply_err(s, "", "name", "bad request"); return; }
    memcpy(id, t, n); id[n] = 0;
    if (!tok(c, &t, &n) || !num(t, n, 10, &size)) { reply_err(s, id, "name", "bad request"); return; }
    if (size > RX_FILE_MAX) { reply_err(s, id, "size", "file too large"); return; }
    if (!tok(c, &t, &n) || !num(t, n, 16, &crc)) { reply_err(s, id, "name", "bad request"); return; }
    if (!tok(c, &t, &n) || !num(t, n, 16, &prot)) { reply_err(s, id, "name", "bad request"); return; }
    if (!lenstr(c, s->cur_path, sizeof s->cur_path, 0) || !lenstr(c, s->cur_comment, sizeof s->cur_comment, 1)) {
        reply_err(s, id, "name", "bad request"); return;
    }
    if (!rx_path_ok(s->cur_path)) { reply_err(s, id, "name", "bad name"); return; }
    if (!s->fs->folder_ok(s->fs->ctx)) { reply_err(s, id, "folder", "folder not found"); return; }
    {
        unsigned long fr = s->fs->free_bytes(s->fs->ctx);
        if (fr < 8192UL || fr - 8192UL < size) { reply_err(s, id, "space", "not enough space"); return; }
    }
    if (make_parents(s, s->cur_path) != 0) { reply_err(s, id, "write", "cannot create folder"); return; }
    parent_of(s->cur_path, s->cur_tmp);
    strcat(s->cur_tmp, RX_TMP_NAME);
    if (s->fs->open_w(s->fs->ctx, s->cur_tmp) != 0) { reply_err(s, id, "write", "cannot write"); return; }
    strcpy(s->cur_id, id);
    s->cur_size = s->cur_left = size; s->cur_crc_want = crc; s->cur_crc = 0; s->cur_prot = prot;
    s->cur_mark = 0; s->cur_open = 1; s->cur_write_failed = 0; s->in_data = 1;
    puts_(s, "GO "); puts_(s, id); puts_(s, "\n");
    emit(s, RX_EV_BEGIN, s->cur_id, s->cur_path, size, 0, 0);
    if (size == 0) finish_file(s);
}

static void on_list_item(rx_session *s, cur *c) {
    const char *t; unsigned n;
    rx_item it;
    if (!tok(c, &t, &n) || !id_ok(t, n)) return;
    memcpy(it.id, t, n); it.id[n] = 0;
    if (!tok(c, &t, &n) || !num(t, n, 10, &it.size)) return;
    if (!lenstr(c, it.path, sizeof it.path, 0) || !rx_path_ok(it.path)) return;
    if (s->list_n < RX_LIST_MAX) s->list[s->list_n++] = it;
}

static void on_line(rx_session *s, const char *line, unsigned len) {
    cur c; const char *t; unsigned n;
    c.p = line; c.end = line + len;
    if (s->list_expect) {
        on_list_item(s, &c);
        if (--s->list_expect == 0) emit(s, RX_EV_LIST, 0, 0, 0, 0, 0);
        return;
    }
    if (!tok(&c, &t, &n)) return;
    if (is(t, n, "WEBADF")) { puts_(s, "READY 1\n"); emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0); }
    else if (is(t, n, "PING")) puts_(s, "PONG\n");
    else if (is(t, n, "LIST")) {
        unsigned long k;
        if (!tok(&c, &t, &n) || !num(t, n, 10, &k) || k > 1000) return;
        s->list_n = 0;
        s->list_expect = (unsigned)k;
        if (k == 0) emit(s, RX_EV_LIST, 0, 0, 0, 0, 0);
    }
    else if (is(t, n, "FILE")) on_file(s, &c);
    /* anything else: ignored, for newer boards and stray clients */
}

int rx_feed(rx_session *s, const unsigned char *data, unsigned long n) {
    while (n) {
        if (s->in_data) {
            unsigned long done0 = s->cur_size - s->cur_left;
            unsigned long room = PROGRESS_STEP - (done0 % PROGRESS_STEP);   /* cross one 16 KB mark per pass */
            unsigned long take = n < s->cur_left ? n : s->cur_left;
            if (take > room) take = room;
            if (!s->cur_write_failed && s->fs->write(s->fs->ctx, data, take) != 0) s->cur_write_failed = 1;
            s->cur_crc = rx_crc32_update(s->cur_crc, data, take);
            s->cur_left -= take; data += take; n -= take;
            {
                unsigned long done = s->cur_size - s->cur_left;
                if (s->cur_left && done / PROGRESS_STEP > s->cur_mark) {
                    s->cur_mark = done / PROGRESS_STEP;
                    emit(s, RX_EV_PROGRESS, s->cur_id, s->cur_path, s->cur_size, done, 0);
                }
            }
            if (s->cur_left == 0) finish_file(s);
            continue;
        }
        if (*data == '\n') {
            unsigned len = s->line_n;
            if (len && s->line[len - 1] == '\r') len--;
            s->line[len] = 0;
            s->line_n = 0;
            data++; n--;
            on_line(s, s->line, len);
            continue;
        }
        if (s->line_n >= RX_LINE_MAX) return -1;
        s->line[s->line_n++] = (char)*data++;
        n--;
    }
    return 0;
}

void rx_disconnected(rx_session *s) {
    if (s->in_data) {
        if (s->cur_open) { s->fs->close_w(s->fs->ctx); s->cur_open = 0; }
        s->fs->remove(s->fs->ctx, s->cur_tmp);
        s->in_data = 0;
        emit(s, RX_EV_FAILED, s->cur_id, s->cur_path, s->cur_size, 0, "connection lost");
    }
    s->line_n = 0; s->list_expect = 0; s->out_n = 0;
}
```

(The data branch takes at most up to the next 16 KB mark per pass, so 40,000 bytes give exactly two PROGRESS
events, at 16,384 and 32,768.)

- [ ] **Step 6: Run the tests to watch them pass**

Run: `tools/receive/test/run.sh`
Expected: all three binaries report `0 failed`, exit 0. If `progress_every_16k` reports `expected 2, got 1`, the
per-pass cap (`room`) is missing.

- [ ] **Step 7: Bring the spec in line with the rulings**

In the spec's §2:
- Change the temp-file sentence to name the file `.webadf-rx`, one per target folder, overwritten by the next file.
- Append `size` (a file over 4 MB) to the error codes line.

- [ ] **Step 8: Commit**

```bash
git add tools/receive/core tools/receive/test docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md
git commit -m "receive: the protocol state machine (hello, list, file, ping), never overwriting or leaving a temp file"
```

---

### Task 3: POSIX front end, the fake board and shared scenarios (integration on the Mac)

**Files:**
- Create: `tools/receive/posix/rx_posix.c`
- Create: `tools/receive/fake-board.ts`, `tools/receive/scenarios.ts`, `tools/receive/run-scenarios.ts`
- Create: `tools/receive/receive.int.test.ts`
- Modify: `vitest.config.*`: add `'tools/**/*.test.ts'` to `test.include`

**Interfaces:**
- Consumes: the `rx_*` API from Task 2.
- Produces:
  - `rx_posix <folder> <port>`. It prints `LISTEN <port>` once it is listening (port 0 means any), then one line per
    event: `HELLO`, `LIST <n>`, `BEGIN <id> <path>`, `DONE <id> <saved>`, `FAILED <id> <text>`, and `META <saved>
    <prot hex> <comment>`. It writes names as UTF-8 on the host (Latin-1 → UTF-8). With `RX_FREE_BYTES` set in the
    environment, that value replaces the real free space.
  - `fake-board.ts`:
    - `connect(port, host?) => Promise<Board>`;
    - `board.list(files)`;
    - `board.send(file, opts?) => Promise<Outcome>`;
    - `board.ping() => Promise<boolean>`;
    - `board.close()`;
    - `rawConnect(port, host?) => Promise<net.Socket>`.
  - `scenarios.ts`:
    - `export const SCENARIOS: Scenario[]`;
    - `export async function runScenarios(port, dir, opts) => Promise<{ name: string; ok: boolean; detail: string }[]>`.
  - `run-scenarios.ts`: the CLI `tsx tools/receive/run-scenarios.ts --port N --dir D [--only a,b] [--host H]`. It
    exits 0 when everything passes.

- [ ] **Step 1: Run `pnpm install --offline` in the worktree**, then add the vitest include. Locate the config with
  `ls vitest.config.*`. Change `include: ['src/**/*.test.ts', 'cli/**/*.test.ts']` to
  `include: ['src/**/*.test.ts', 'cli/**/*.test.ts', 'tools/**/*.test.ts']`.

- [ ] **Step 2: Write the fake board**

`tools/receive/fake-board.ts`:

```ts
// The board's side of the Receive protocol (spec 2026-10-16 §2), for tests: hello, LIST, FILE + bytes, PING.
import net from 'node:net';
import { crc32 } from 'node:zlib';

export interface SendFile {
  id: string; path: string; data: Buffer; protection?: number; comment?: string;
  badCrc?: boolean;      // send a wrong CRC
  dropAfter?: number;    // close the socket after this many data bytes
}
export type Outcome =
  | { id: string; ok: true; savedAs: string }
  | { id: string; ok: false; code: string; text: string };

const lp = (s: string) => `${Buffer.byteLength(s, 'latin1')}:${s}`;

export interface Board {
  list(files: SendFile[]): void;
  send(f: SendFile, opts?: { chunk?: number; delayMs?: number }): Promise<Outcome>;
  ping(): Promise<boolean>;
  close(): void;
}

function lineReader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  const waiting: ((l: string | null) => void)[] = [];
  const lines: string[] = [];
  let closed = false;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10)) {
      const l = buf.subarray(0, i).toString('latin1');
      buf = buf.subarray(i + 1);
      const w = waiting.shift();
      if (w) w(l); else lines.push(l);
    }
  });
  const end = () => { closed = true; while (waiting.length) waiting.shift()!(null); };
  sock.on('close', end); sock.on('error', end);
  return (timeoutMs = 15000) => new Promise<string | null>((resolve, reject) => {
    if (lines.length) return resolve(lines.shift()!);
    if (closed) return resolve(null);
    const t = setTimeout(() => reject(new Error('no reply within ' + timeoutMs + ' ms')), timeoutMs);
    waiting.push((l) => { clearTimeout(t); resolve(l); });
  });
}

export function rawConnect(port: number, host = '127.0.0.1'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(s));
    s.once('error', reject);
  });
}

export async function connect(port: number, host = '127.0.0.1'): Promise<Board> {
  const sock = await rawConnect(port, host);
  const next = lineReader(sock);
  sock.write('WEBADF 1\n');
  const hello = await next();
  if (hello !== 'READY 1') throw new Error(`expected READY 1, got ${JSON.stringify(hello)}`);
  return {
    list(files) {
      sock.write(Buffer.from(`LIST ${files.length}\n` + files.map((f) => `${f.id} ${f.data.length} ${lp(f.path)}\n`).join(''), 'latin1'));
    },
    async send(f, opts = {}) {
      const crc = (crc32(f.data) ^ (f.badCrc ? 1 : 0)) >>> 0;
      const line = `FILE ${f.id} ${f.data.length} ${crc.toString(16)} ${(f.protection ?? 0).toString(16)} ${lp(f.path)} ${lp(f.comment ?? '')}\n`;
      sock.write(Buffer.from(line, 'latin1'));
      const go = await next();
      if (go === null) throw new Error('closed before GO');
      if (go.startsWith('ERR ')) return parseErr(go);
      if (go !== `GO ${f.id}`) throw new Error(`expected GO ${f.id}, got ${go}`);
      const chunk = opts.chunk ?? 4096;
      const stop = f.dropAfter ?? f.data.length;
      for (let o = 0; o < stop; o += chunk) {
        sock.write(f.data.subarray(o, Math.min(o + chunk, stop)));
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (f.dropAfter !== undefined) {
        await new Promise((r) => setTimeout(r, 200));
        sock.destroy();
        return { id: f.id, ok: false, code: 'dropped', text: '' };
      }
      const r = await next(60000);
      if (r === null) throw new Error('closed before OK');
      if (r.startsWith('ERR ')) return parseErr(r);
      const m = /^OK (\S+) (\d+):(.*)$/.exec(r);
      if (!m || m[1] !== f.id) throw new Error(`bad reply ${r}`);
      return { id: f.id, ok: true, savedAs: m[3] };
    },
    async ping() { sock.write('PING\n'); return (await next()) === 'PONG'; },
    close() { sock.end(); },
  };
}

function parseErr(l: string): Outcome {
  const m = /^ERR (\S+) (\S+) (.*)$/.exec(l);
  if (!m) throw new Error(`bad ERR ${l}`);
  return { id: m[1], ok: false, code: m[2], text: m[3] };
}
```

- [ ] **Step 3: Write the shared scenarios**

`tools/receive/scenarios.ts`:

```ts
// Scenarios run against any listening Receive (POSIX build or FS-UAE), checked against the folder on the host.
import fs from 'node:fs';
import path from 'node:path';
import { connect, rawConnect, type SendFile, type Outcome } from './fake-board';

function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; }
  return b;
}
export interface Scenario { name: string; uaeOnly?: boolean; posixOnly?: boolean; run: (port: number, dir: string, host: string) => Promise<string | null> }

// Latin-1 on the wire, UTF-8 on the host (both front ends convert).
const hostName = (amigaName: string) => amigaName;
const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, hostName(rel)));
const same = (dir: string, rel: string, data: Buffer) =>
  exists(dir, rel) && Buffer.compare(fs.readFileSync(path.join(dir, hostName(rel))), data) === 0;
const noTemp = (dir: string, sub = '') => !exists(dir, path.join(sub, '.webadf-rx'));

async function one(port: number, host: string, f: SendFile): Promise<Outcome> {
  const b = await connect(port, host);
  try { b.list([f]); return await b.send(f); } finally { b.close(); }
}
const expectOk = (o: Outcome, saved: string) => (o.ok && o.savedAs === saved ? null : `got ${JSON.stringify(o)}, want OK ${saved}`);
const expectErr = (o: Outcome, code: string) => (!o.ok && o.code === code ? null : `got ${JSON.stringify(o)}, want ERR ${code}`);

const hello = Buffer.from('hello from webadf\n');
const mod = bytes(58000, 7);

export const SCENARIOS: Scenario[] = [
  { name: 'plain', run: async (p, d, h) => expectOk(await one(p, h, { id: 's1', path: 'Hello.txt', data: hello }), 'Hello.txt')
      ?? (same(d, 'Hello.txt', hello) ? null : 'content differs') },
  { name: 'folder', run: async (p, d, h) => expectOk(await one(p, h, { id: 's2', path: 'mods/axelf.mod', data: mod }), 'mods/axelf.mod')
      ?? (same(d, 'mods/axelf.mod', mod) && noTemp(d, 'mods') ? null : 'content differs or temp left') },
  { name: 'collision', run: async (p, d, h) => expectOk(await one(p, h, { id: 's3', path: 'Hello.txt', data: Buffer.from('2') }), 'Hello_2.txt')
      ?? (same(d, 'Hello.txt', hello) ? null : 'the first Hello.txt changed') },
  { name: 'case', uaeOnly: true, run: async (p, d, h) => expectOk(await one(p, h, { id: 's4', path: 'HELLO.TXT', data: Buffer.from('3') }), 'HELLO_3.TXT')
      ?? (same(d, 'Hello.txt', hello) ? null : 'Hello.txt was overwritten') },
  { name: 'latin1', run: async (p, d, h) => expectOk(await one(p, h, { id: 's5', path: 'Café.txt', data: hello }), 'Café.txt')
      ?? (exists(d, 'Café.txt') ? null : `no Café.txt on the host: ${fs.readdirSync(d).join(', ')}`) },
  { name: 'badcrc', run: async (p, d, h) => expectErr(await one(p, h, { id: 's6', path: 'Bad.bin', data: bytes(9000, 3), badCrc: true }), 'crc')
      ?? (!exists(d, 'Bad.bin') && noTemp(d) ? null : 'Bad.bin or temp left') },
  { name: 'badname', run: async (p, d, h) => expectErr(await one(p, h, { id: 's7', path: '../Escape', data: hello }), 'name')
      ?? (!fs.existsSync(path.join(d, '..', 'Escape')) ? null : 'escaped the folder') },
  { name: 'empty', run: async (p, d, h) => expectOk(await one(p, h, { id: 's8', path: 'Empty', data: Buffer.alloc(0) }), 'Empty')
      ?? (same(d, 'Empty', Buffer.alloc(0)) ? null : 'no empty file') },
  { name: 'meta', run: async (p, _d, h) => expectOk(await one(p, h, { id: 's9', path: 'Script', data: Buffer.from('echo hi\n'), protection: 0x40, comment: 'a comment' }), 'Script') },
  { name: 'big', run: async (p, d, h) => { const big = bytes(4194304, 11);
      return expectOk(await one(p, h, { id: 's10', path: 'Big.bin', data: big }), 'Big.bin') ?? (same(d, 'Big.bin', big) ? null : 'content differs'); } },
  { name: 'drop', run: async (p, d, h) => {
      const o = await one(p, h, { id: 's11', path: 'Dropped.bin', data: bytes(20000, 5), dropAfter: 1000 });
      if (o.ok || o.code !== 'dropped') return `got ${JSON.stringify(o)}`;
      await new Promise((r) => setTimeout(r, 500));
      if (!noTemp(d) || exists(d, 'Dropped.bin')) return 'temp or partial file left after a drop';
      return expectOk(await one(p, h, { id: 's12', path: 'After.txt', data: hello }), 'After.txt'); } },
  { name: 'garbage', run: async (p, _d, h) => {
      const s = await rawConnect(p, h); s.write('GET / HTTP/1.0\r\n\r\n' + 'x'.repeat(2000)); await new Promise((r) => setTimeout(r, 500)); s.destroy();
      return expectOk(await one(p, h, { id: 's13', path: 'AfterJunk.txt', data: hello }), 'AfterJunk.txt'); } },
  { name: 'busy', run: async (p, _d, h) => {
      const first = await connect(p, h);
      const second = await rawConnect(p, h);
      const reply = await new Promise<string>((r) => { let b = ''; second.on('data', (d) => { b += d.toString('latin1'); if (b.includes('\n')) r(b); }); setTimeout(() => r(b), 3000); });
      second.destroy();
      const f = { id: 's14', path: 'First.txt', data: hello };
      first.list([f]); const o = await first.send(f); first.close();
      return reply.startsWith('ERR - busy') ? expectOk(o, 'First.txt') : `second connection got ${JSON.stringify(reply)}`; } },
  { name: 'list', run: async (p, _d, h) => {
      const b = await connect(p, h);
      b.list([{ id: 'l1', path: 'a', data: hello }, { id: 'l2', path: 'b/c', data: hello }]);
      const ok = await b.ping(); b.close(); return ok ? null : 'no PONG after LIST'; } },
];

export async function runScenarios(port: number, dir: string, opts: { host?: string; only?: string[]; uae?: boolean } = {}) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const s of SCENARIOS) {
    if (opts.only && !opts.only.includes(s.name)) continue;
    if (s.uaeOnly && !opts.uae) continue;
    if (s.posixOnly && opts.uae) continue;
    try { const err = await s.run(port, dir, opts.host ?? '127.0.0.1'); out.push({ name: s.name, ok: err === null, detail: err ?? '' }); }
    catch (e) { out.push({ name: s.name, ok: false, detail: String(e) }); }
  }
  return out;
}
```

`tools/receive/run-scenarios.ts`:

```ts
// Usage: tsx tools/receive/run-scenarios.ts --port 6800 --dir <host folder> [--host 127.0.0.1] [--only a,b] [--uae]
import { runScenarios } from './scenarios';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const res = await runScenarios(Number(arg('--port') ?? 6800), arg('--dir')!, {
  host: arg('--host'), only: arg('--only')?.split(','), uae: process.argv.includes('--uae'),
});
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ': ' + r.detail : ''}`);
process.exit(res.every((r) => r.ok) ? 0 : 1);
```

- [ ] **Step 4: Write the failing integration test**

`tools/receive/receive.int.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScenarios } from './scenarios';
import { connect } from './fake-board';

const here = path.dirname(new URL(import.meta.url).pathname);
let bin: string; let tmp: string;

function start(dir: string, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; port: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [dir, '0'], { env: { ...process.env, ...env } });
    const lines: string[] = []; let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l);
        const m = /^LISTEN (\d+)$/.exec(l); if (m) resolve({ proc, port: Number(m[1]), lines }); }
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error('rx_posix did not listen')), 5000);
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'receive-'));
  bin = path.join(tmp, 'rx_posix');
  execFileSync('cc', ['-std=c99', '-O1', '-Wall', '-Wextra', '-Werror', '-I', path.join(here, 'core'), '-o', bin,
    path.join(here, 'core/rx_crc.c'), path.join(here, 'core/rx_names.c'), path.join(here, 'core/rx_proto.c'),
    path.join(here, 'posix/rx_posix.c')]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('Receive (POSIX build) against the fake board', () => {
  it('passes every shared scenario', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'out-'));
    const { proc, port, lines } = await start(dir);
    try {
      const res = await runScenarios(port, dir);
      expect(res.filter((r) => !r.ok)).toEqual([]);
      expect(lines).toContain('META Script 40 a comment');
    } finally { proc.kill(); }
  }, 60000);

  it('refuses a file larger than the free space', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'small-'));
    const { proc, port } = await start(dir, { RX_FREE_BYTES: '20000' });
    try {
      const b = await connect(port);
      const o = await b.send({ id: 'x1', path: 'Big', data: Buffer.alloc(30000) }); b.close();
      expect(o).toEqual({ id: 'x1', ok: false, code: 'space', text: 'not enough space' });
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { proc.kill(); }
  });

  it('answers ERR folder when the folder vanished', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'gone-'));
    const { proc, port } = await start(dir);
    try {
      fs.rmSync(dir, { recursive: true });
      const b = await connect(port);
      const o = await b.send({ id: 'y1', path: 'X', data: Buffer.from('x') }); b.close();
      expect(o).toMatchObject({ ok: false, code: 'folder' });
    } finally { proc.kill(); }
  });
});
```

- [ ] **Step 5: Run it to watch it fail**

Run: `pnpm vitest run tools/receive/receive.int.test.ts`
Expected: FAIL in `beforeAll`: `cc` reports `posix/rx_posix.c: No such file or directory`.

- [ ] **Step 6: Implement `rx_posix.c`**

```c
/* Receive's host front end: the core over BSD sockets and POSIX files. For tests and CI, not for users.
   Usage: rx_posix <folder> <port>   (port 0 = any; prints "LISTEN <port>") */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>
#include "rx_proto.h"

typedef struct { const char *root; FILE *fh; } pctx;

/* folder + "/" + rel, with Latin-1 bytes >= 0x80 as UTF-8 (a host name must be UTF-8 on macOS). */
static void join(pctx *c, const char *rel, char *out, size_t cap) {
    size_t n = (size_t)snprintf(out, cap, "%s/", c->root);
    for (const unsigned char *p = (const unsigned char *)rel; *p && n + 3 < cap; p++) {
        if (*p < 0x80) out[n++] = (char)*p;
        else { out[n++] = (char)(0xC0 | (*p >> 6)); out[n++] = (char)(0x80 | (*p & 0x3F)); }
    }
    out[n] = 0;
}
static int p_folder_ok(void *x) { struct stat st; return stat(((pctx *)x)->root, &st) == 0 && S_ISDIR(st.st_mode); }
static unsigned long p_free(void *x) {
    const char *e = getenv("RX_FREE_BYTES");
    struct statvfs v;
    if (e) return strtoul(e, NULL, 10);
    if (statvfs(((pctx *)x)->root, &v) != 0) return 0xFFFFFFFFUL;
    unsigned long long f = (unsigned long long)v.f_bavail * v.f_frsize;
    return f > 0xFFFFFFFFULL ? 0xFFFFFFFFUL : (unsigned long)f;
}
static int p_exists(void *x, const char *rel) { char p[1024]; struct stat st; join(x, rel, p, sizeof p); return lstat(p, &st) == 0; }
static int p_make_dir(void *x, const char *rel) {
    char p[1024]; struct stat st; join(x, rel, p, sizeof p);
    if (mkdir(p, 0755) == 0) return 0;
    return (errno == EEXIST && stat(p, &st) == 0 && S_ISDIR(st.st_mode)) ? 0 : -1;
}
static int p_open_w(void *x, const char *rel) { pctx *c = x; char p[1024]; join(c, rel, p, sizeof p); c->fh = fopen(p, "wb"); return c->fh ? 0 : -1; }
static int p_write(void *x, const unsigned char *b, unsigned long n) { return fwrite(b, 1, n, ((pctx *)x)->fh) == n ? 0 : -1; }
static int p_close_w(void *x) { pctx *c = x; int r = fclose(c->fh); c->fh = NULL; return r == 0 ? 0 : -1; }
static int p_rename(void *x, const char *from, const char *to) {
    char a[1024], b[1024]; join(x, from, a, sizeof a); join(x, to, b, sizeof b);
    if (access(b, F_OK) == 0) return -1;
    return rename(a, b) == 0 ? 0 : -1;
}
static int p_remove(void *x, const char *rel) { char p[1024]; join(x, rel, p, sizeof p); return unlink(p) == 0 ? 0 : -1; }
static int p_set_meta(void *x, const char *rel, unsigned long prot, const char *comment) {
    (void)x; printf("META %s %lx %s\n", rel, prot, comment); return 0;
}
static void on_event(void *u, const rx_event *e) {
    rx_session *s = u;
    switch (e->kind) {
    case RX_EV_HELLO: printf("HELLO\n"); break;
    case RX_EV_LIST: printf("LIST %u\n", s->list_n); break;
    case RX_EV_BEGIN: printf("BEGIN %s %s\n", e->id, e->path); break;
    case RX_EV_DONE: printf("DONE %s %s\n", e->id, e->path); break;
    case RX_EV_FAILED: printf("FAILED %s %s\n", e->id, e->text); break;
    default: break;
    }
}
static int send_all(int fd, const char *p, size_t n) {
    while (n) { ssize_t w = send(fd, p, n, 0); if (w <= 0) return -1; p += w; n -= (size_t)w; }
    return 0;
}

int main(int argc, char **argv) {
    static rx_session S;
    static unsigned char buf[8192];
    pctx ctx = { 0 };
    rx_fs fs = { &ctx, p_folder_ok, p_free, p_exists, p_make_dir, p_open_w, p_write, p_close_w, p_rename, p_remove, p_set_meta };
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    int one = 1, ls, cl = -1;
    if (argc != 3) { fprintf(stderr, "usage: rx_posix <folder> <port>\n"); return 2; }
    setvbuf(stdout, NULL, _IOLBF, 0);
    ctx.root = argv[1];
    ls = socket(AF_INET, SOCK_STREAM, 0);
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons((unsigned short)atoi(argv[2]));
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { perror("listen"); return 1; }
    getsockname(ls, (struct sockaddr *)&a, &al);
    printf("LISTEN %d\n", ntohs(a.sin_port));
    for (;;) {
        fd_set r;
        int maxfd = ls;
        FD_ZERO(&r); FD_SET(ls, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (cl > maxfd) maxfd = cl; }
        if (select(maxfd + 1, &r, NULL, NULL, NULL) < 0) { if (errno == EINTR) continue; return 1; }
        if (FD_ISSET(ls, &r)) {
            int ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); close(ns); }
                else { cl = ns; rx_init(&S, &fs, on_event, &S); }
            }
        }
        if (cl >= 0 && FD_ISSET(cl, &r)) {
            ssize_t n = recv(cl, buf, sizeof buf, 0);
            int bad = n <= 0 || rx_feed(&S, buf, (unsigned long)n) != 0;
            char o[RX_OUT_MAX];
            unsigned k;
            while ((k = rx_take_output(&S, o, sizeof o)) > 0) if (send_all(cl, o, k) != 0) bad = 1;
            if (bad) { rx_disconnected(&S); close(cl); cl = -1; }
        }
    }
}
```

- [ ] **Step 7: Run the integration test to watch it pass**

Run: `pnpm vitest run tools/receive/receive.int.test.ts`
Expected: 3 passed. A failing scenario prints its name and detail from `res.filter(...)`. Fix the cause; never weaken
a check.

- [ ] **Step 8: Run the whole host suite and vitest for regressions**

Run: `tools/receive/test/run.sh && pnpm test > /tmp/receive-vitest.log 2>&1; tail -5 /tmp/receive-vitest.log`
Expected: host tests 0 failed; vitest all passed (the count is the old total + 3).

- [ ] **Step 9: Commit**

```bash
git add tools/receive/posix tools/receive/fake-board.ts tools/receive/scenarios.ts tools/receive/run-scenarios.ts \
        tools/receive/receive.int.test.ts vitest.config.*
git commit -m "receive: POSIX front end and a fake board; shared scenarios pass (collision, Latin-1, CRC, drop, junk, busy, 4 MB)"
```

---

### Task 4: The Amiga build and the Shell form, proven in FS-UAE on Kickstart 2.04 and 3.1

**Files:**
- Create: `tools/receive/amiga/afs.h`, `afs.c`, `config.h`, `config.c`, `net.h`, `net.c`, `ui.h`, `shell.c`, `main.c`
- Create: `tools/receive/build.sh`, `tools/receive/uae/uae-test.sh`
- Modify: `package.json` (scripts `"receive:build": "tools/receive/build.sh"` and `"receive:uae": "tools/receive/uae/uae-test.sh"`)

**Interfaces:**
- Consumes: the `rx_*` API (Task 2); `runScenarios` through `run-scenarios.ts` (Task 3).
- Produces:
  - `afs.h`:
    - `typedef struct afs_ctx { char root[256]; BPTR fh; } afs_ctx;`
    - `void afs_init(afs_ctx *c, rx_fs *fs, const char *root);`
    - `void afs_set_root(afs_ctx *c, const char *root);`
  - `config.h`:
    - `void cfg_load(char *dir, unsigned cap);` reads ENV:, then ENVARC:, else `RAM:`;
    - `int cfg_save(const char *dir);` returns 0 if ENVARC: was written.
  - `net.h`:

    ```c
    extern struct Library *SocketBase;
    int net_open(void);                 /* 0 if bsdsocket.library opened */
    void net_close(void);
    typedef struct net_ui {             /* the front end's hooks */
        void *u;
        void (*on_event)(void *u, const rx_event *e, rx_session *s);
        void (*on_status)(void *u, const char *text);
        ULONG extra_sigs;               /* window port signal; 0 for the Shell */
        int (*on_signal)(void *u, ULONG sigs);  /* 1 = quit */
    } net_ui;
    int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s); /* returns when asked to quit; 0 ok, -1 no listen */
    ```
  - `ui.h`: `int shell_main(const char *dir);` and `int gui_main(const char *dir);` (the GUI is Task 5; in this task,
    `main.c` has no GUI branch).

- [ ] **Step 1: Write `build.sh`** (deterministic Docker cross-build, pinned)

```bash
#!/usr/bin/env bash
# Builds Receive (68000, Kickstart 2.04+) with the pinned amiga-gcc image. Deterministic: the same sources give the
# same bytes (checked 2026-10-16), pinned in receive.sha256.
# Usage: tools/receive/build.sh <out file> [--pin]   (--pin writes the pin; without it a mismatch fails)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"; pin="${2:-}"
img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
docker run --rm --platform linux/amd64 -v "$here:/src:ro" -v "$tmp:/o" -w /src "$img" \
  m68k-amigaos-gcc -m68000 -Os -noixemul -s -Wall -Werror -Icore \
    -o /o/Receive core/rx_crc.c core/rx_names.c core/rx_proto.c amiga/*.c
cp "$tmp/Receive" "$out"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
got="$(sha256 "$out")"
echo "$got  $out ($(wc -c < "$out" | tr -d ' ') bytes)"
if [ "$pin" = "--pin" ]; then echo "$got" > "$here/receive.sha256"; echo "pinned"; exit 0; fi
[ -f "$here/receive.sha256" ] || { echo "FAIL: no receive.sha256 -- run with --pin once the build is final"; exit 1; }
[ "$(cat "$here/receive.sha256")" = "$got" ] || { echo "FAIL: not the pinned binary ($(cat "$here/receive.sha256"))"; exit 1; }
echo "PASS pinned"
```

`chmod +x`. During Tasks 4-5, build with `--pin` each time (the pin is final in Task 6).

- [ ] **Step 2: Write the Amiga filesystem glue**

`tools/receive/amiga/afs.h`:

```c
#ifndef AFS_H
#define AFS_H
#include <dos/dos.h>
#include "rx_proto.h"
typedef struct afs_ctx { char root[256]; BPTR fh; } afs_ctx;
void afs_init(afs_ctx *c, rx_fs *fs, const char *root);
void afs_set_root(afs_ctx *c, const char *root);
#endif
```

`tools/receive/amiga/afs.c`:

```c
/* rx_fs over dos.library (V37). Paths are the folder joined with the core's '/'-separated relative path. */
#include <string.h>
#include <exec/memory.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "afs.h"

static void join(afs_ctx *c, const char *rel, char *out) {
    size_t n;
    strcpy(out, c->root);
    n = strlen(out);
    if (n && out[n - 1] != ':' && out[n - 1] != '/' && rel[0]) strcat(out, "/");
    strcat(out, rel);
}
static int a_folder_ok(void *x) {
    afs_ctx *c = x;
    BPTR l = Lock((STRPTR)c->root, SHARED_LOCK);
    struct FileInfoBlock *fib;
    int ok = 0;
    if (!l) return 0;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (fib) { if (Examine(l, fib)) ok = fib->fib_DirEntryType > 0; FreeDosObject(DOS_FIB, fib); }
    UnLock(l);
    return ok;
}
static unsigned long a_free(void *x) {
    afs_ctx *c = x;
    BPTR l = Lock((STRPTR)c->root, SHARED_LOCK);
    struct InfoData *id;
    unsigned long r = 0xFFFFFFFFUL;
    if (!l) return 0;
    id = AllocVec(sizeof *id, MEMF_PUBLIC | MEMF_CLEAR);
    if (id && Info(l, id)) {
        unsigned long blocks = (unsigned long)(id->id_NumBlocks - id->id_NumBlocksUsed);
        unsigned long bpb = (unsigned long)id->id_BytesPerBlock;
        r = (bpb && blocks > 0xFFFFFFFFUL / bpb) ? 0xFFFFFFFFUL : blocks * bpb;
    }
    if (id) FreeVec(id);
    UnLock(l);
    return r;
}
static int a_exists(void *x, const char *rel) {
    char p[512]; BPTR l;
    join(x, rel, p);
    l = Lock((STRPTR)p, SHARED_LOCK);
    if (!l) return 0;
    UnLock(l);
    return 1;
}
static int a_make_dir(void *x, const char *rel) {
    char p[512]; BPTR l;
    join(x, rel, p);
    l = CreateDir((STRPTR)p);
    if (l) { UnLock(l); return 0; }
    return a_exists(x, rel) ? 0 : -1;
}
static int a_open_w(void *x, const char *rel) {
    afs_ctx *c = x; char p[512];
    join(c, rel, p);
    c->fh = Open((STRPTR)p, MODE_NEWFILE);
    return c->fh ? 0 : -1;
}
static int a_write(void *x, const unsigned char *b, unsigned long n) {
    return Write(((afs_ctx *)x)->fh, (APTR)b, (LONG)n) == (LONG)n ? 0 : -1;
}
static int a_close_w(void *x) {
    afs_ctx *c = x; LONG ok = Close(c->fh);
    c->fh = 0;
    return ok ? 0 : -1;
}
static int a_rename(void *x, const char *from, const char *to) {
    char a[512], b[512];
    join(x, from, a); join(x, to, b);
    return Rename((STRPTR)a, (STRPTR)b) ? 0 : -1;
}
static int a_remove(void *x, const char *rel) { char p[512]; join(x, rel, p); return DeleteFile((STRPTR)p) ? 0 : -1; }
static int a_set_meta(void *x, const char *rel, unsigned long prot, const char *comment) {
    char p[512]; int ok;
    join(x, rel, p);
    ok = SetProtection((STRPTR)p, (LONG)prot) != 0;
    if (comment[0]) ok = SetComment((STRPTR)p, (STRPTR)comment) != 0 && ok;
    return ok ? 0 : -1;
}
void afs_set_root(afs_ctx *c, const char *root) { strncpy(c->root, root, sizeof c->root - 1); c->root[sizeof c->root - 1] = 0; }
void afs_init(afs_ctx *c, rx_fs *fs, const char *root) {
    memset(c, 0, sizeof *c);
    afs_set_root(c, root);
    fs->ctx = c; fs->folder_ok = a_folder_ok; fs->free_bytes = a_free; fs->exists = a_exists; fs->make_dir = a_make_dir;
    fs->open_w = a_open_w; fs->write = a_write; fs->close_w = a_close_w; fs->rename = a_rename; fs->remove = a_remove;
    fs->set_meta = a_set_meta;
}
```

- [ ] **Step 3: Write the setting** (`config.h` declares the two functions from Interfaces)

`tools/receive/amiga/config.c`:

```c
/* The folder setting: ENV:webadf/ReceiveDir (this boot), ENVARC:webadf/ReceiveDir (kept). Plain files, so it
   works on V37, where SetVar's GVF_SAVE_VAR does not exist. */
#include <string.h>
#include <proto/dos.h>
#include "config.h"

static int read_file(const char *name, char *dir, unsigned cap) {
    BPTR f = Open((STRPTR)name, MODE_OLDFILE);
    LONG n;
    if (!f) return 0;
    n = Read(f, dir, (LONG)cap - 1);
    Close(f);
    if (n <= 0) return 0;
    dir[n] = 0;
    while (n > 0 && (dir[n - 1] == '\n' || dir[n - 1] == '\r' || dir[n - 1] == ' ')) dir[--n] = 0;
    return n > 0;
}
void cfg_load(char *dir, unsigned cap) {
    if (read_file("ENV:webadf/ReceiveDir", dir, cap)) return;
    if (read_file("ENVARC:webadf/ReceiveDir", dir, cap)) return;
    strncpy(dir, "RAM:", cap);
}
static int write_one(const char *base, const char *dir) {
    char p[64]; BPTR l, f; LONG n = (LONG)strlen(dir), w;
    strcpy(p, base); strcat(p, "webadf");
    l = CreateDir((STRPTR)p);
    if (l) UnLock(l);
    strcat(p, "/ReceiveDir");
    f = Open((STRPTR)p, MODE_NEWFILE);
    if (!f) return -1;
    w = Write(f, (APTR)dir, n);
    Close(f);
    return w == n ? 0 : -1;
}
int cfg_save(const char *dir) {
    write_one("ENV:", dir);
    return write_one("ENVARC:", dir);
}
```

- [ ] **Step 4: Write the socket loop** (`net.h` as in Interfaces, plus `#include <exec/types.h>`, `"afs.h"` and
  `"rx_proto.h"`)

`tools/receive/amiga/net.c`:

```c
/* bsdsocket glue shared by both front ends: one listener on RX_PORT, one connection at a time, WaitSelect on the
   sockets plus the front end's signals (Ctrl-C always). */
#include <string.h>
#include <proto/exec.h>
#include <proto/socket.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <dos/dos.h>
#include "net.h"

struct Library *SocketBase;

int net_open(void) { SocketBase = OpenLibrary((STRPTR)"bsdsocket.library", 3); return SocketBase ? 0 : -1; }
void net_close(void) { if (SocketBase) { CloseLibrary(SocketBase); SocketBase = NULL; } }

static int send_all(LONG fd, const char *p, LONG n) {
    while (n > 0) { LONG w = send(fd, (APTR)p, n, 0); if (w <= 0) return -1; p += w; n -= w; }
    return 0;
}
static net_ui *cur_ui;
static rx_session *cur_s;
static void relay(void *u, const rx_event *e) { (void)u; cur_ui->on_event(cur_ui->u, e, cur_s); }

int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s) {
    static unsigned char buf[4096];
    struct sockaddr_in a;
    LONG one = 1, ls, cl = -1;
    (void)ctx;
    cur_ui = ui; cur_s = s;
    ls = socket(AF_INET, SOCK_STREAM, 0);
    if (ls < 0) return -1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(RX_PORT); a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { CloseSocket(ls); return -1; }
    ui->on_status(ui->u, "Listening on port 6800");
    for (;;) {
        fd_set r;
        ULONG sigs = SIGBREAKF_CTRL_C | ui->extra_sigs;
        struct timeval tv;
        LONG n, maxfd = ls;
        FD_ZERO(&r); FD_SET(ls, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (cl > maxfd) maxfd = cl; }
        tv.tv_secs = 1; tv.tv_micro = 0;
        n = WaitSelect(maxfd + 1, &r, NULL, NULL, &tv, &sigs);
        if (sigs & SIGBREAKF_CTRL_C) break;
        if ((sigs & ui->extra_sigs) && ui->on_signal(ui->u, sigs)) break;
        if (n <= 0) continue;
        if (FD_ISSET(ls, &r)) {
            LONG ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); CloseSocket(ns); }
                else { cl = ns; rx_init(s, fs, relay, NULL); }
            }
        }
        if (cl >= 0 && FD_ISSET(cl, &r)) {
            LONG got = recv(cl, buf, sizeof buf, 0);
            int bad = got <= 0 || rx_feed(s, buf, (unsigned long)got) != 0;
            char o[RX_OUT_MAX];
            unsigned k;
            while ((k = rx_take_output(s, o, sizeof o)) > 0) if (send_all(cl, o, (LONG)k) != 0) bad = 1;
            if (bad) { rx_disconnected(s); CloseSocket(cl); cl = -1; }
        }
    }
    if (cl >= 0) { rx_disconnected(s); CloseSocket(cl); }
    CloseSocket(ls);
    return 0;
}
```

(If the toolchain's `struct timeval` names its fields `tv_sec`/`tv_usec`, use those. The image's `sys/time.h`
decides; check it with `grep -n 'tv_sec\|tv_secs' $(m68k-amigaos-gcc -print-sysroot)/...` inside the container, or
simply let the build tell you. Use the names it accepts. The meaning is the same.)

- [ ] **Step 5: Write the Shell front end and `main.c`**

`tools/receive/amiga/ui.h`:

```c
#ifndef UI_H
#define UI_H
int shell_main(const char *dir);
int gui_main(const char *dir);
#endif
```

`tools/receive/amiga/shell.c`:

```c
/* Receive in a Shell: one line per file, Ctrl-C stops. */
#include <proto/dos.h>
#include "afs.h"
#include "net.h"
#include "ui.h"

static void sh_status(void *u, const char *t) { (void)u; PutStr((STRPTR)t); PutStr((STRPTR)"\n"); Flush(Output()); }
static void sh_event(void *u, const rx_event *e, rx_session *s) {
    LONG args[3];
    (void)u; (void)s;
    if (e->kind == RX_EV_DONE) {
        args[0] = (LONG)e->path; args[1] = (LONG)e->size;
        VPrintf((STRPTR)"%s  %lu bytes  OK\n", args);
    } else if (e->kind == RX_EV_FAILED) {
        args[0] = (LONG)e->path; args[1] = (LONG)e->text;
        VPrintf((STRPTR)"%s  ERR %s\n", args);
    } else if (e->kind == RX_EV_HELLO) {
        PutStr((STRPTR)"Board connected\n");
    }
    Flush(Output());
}
static int sh_signal(void *u, ULONG sigs) { (void)u; (void)sigs; return 0; }

int shell_main(const char *dir) {
    static afs_ctx ctx; static rx_fs fs; static rx_session s;
    net_ui ui = { NULL, sh_event, sh_status, 0, sh_signal };
    LONG args[1];
    if (net_open() != 0) { PutStr((STRPTR)"No TCP/IP stack running (bsdsocket.library)\n"); return RETURN_FAIL; }
    afs_init(&ctx, &fs, dir);
    if (!fs.folder_ok(&ctx)) { PutStr((STRPTR)"Folder not found\n"); net_close(); return RETURN_FAIL; }
    args[0] = (LONG)dir;
    VPrintf((STRPTR)"Receive: saving into %s. Ctrl-C to stop.\n", args);
    if (net_run(&ui, &ctx, &fs, &s) != 0) { PutStr((STRPTR)"Could not listen on port 6800\n"); net_close(); return RETURN_FAIL; }
    PutStr((STRPTR)"Stopped.\n");
    net_close();
    return RETURN_OK;
}
```

`tools/receive/amiga/main.c` (Task 4 form; Task 5 adds `GUI` and the Workbench start):

```c
/* Receive: files from webadf, through the board, into a folder (spec 2026-10-16 §5). Template TO/K,SAVE/S. */
#include <string.h>
#include <proto/dos.h>
#include "config.h"
#include "ui.h"

static const char version[] = "$VER: Receive 1.0 (16.10.2026) webadf";

int main(int argc, char **argv) {
    static char dir[256];
    LONG args[3] = { 0, 0, 0 };
    struct RDArgs *rd;
    int rc;
    (void)argv; (void)version;
    if (argc == 0) return RETURN_FAIL;   /* Workbench start: Task 5 */
    rd = ReadArgs((STRPTR)"TO/K,SAVE/S", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"Receive"); return RETURN_FAIL; }
    if (args[0]) { strncpy(dir, (const char *)args[0], sizeof dir - 1); } else cfg_load(dir, sizeof dir);
    if (args[1] && cfg_save(dir) != 0) PutStr((STRPTR)"Could not save the folder to ENVARC:\n");
    FreeArgs(rd);
    rc = shell_main(dir);
    return rc;
}
```

`tools/receive/amiga/config.h`:

```c
#ifndef CONFIG_H
#define CONFIG_H
void cfg_load(char *dir, unsigned cap);
int cfg_save(const char *dir);
#endif
```

`gui.c` does not exist yet, and `build.sh` compiles `amiga/*.c`, so `gui_main` is declared but never referenced in
this task: the link succeeds.

- [ ] **Step 6: Build**

Run: `tools/receive/build.sh /tmp/Receive --pin`
Expected: no warnings (the build uses `-Werror`), a size line under 20,000 bytes, and `pinned`. Run it a second time
without `--pin`; expected: `PASS pinned` (the build is deterministic).

- [ ] **Step 7: Write the FS-UAE harness**

`tools/receive/uae/uae-test.sh`:

```bash
#!/usr/bin/env bash
# Boots FS-UAE with Receive and runs the shared scenarios against it through bsdsocket emulation (the Amiga's
# listen on 6800 is the Mac's port 6800). Usage: uae-test.sh 204|31 [shell|gui|space]
# Never pattern-kills: stops only the FS-UAE PID it started.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../../.." && pwd)"
ks="$1"; mode="${2:-shell}"
case "$ks" in
  204) rom="${WEBADF_KS204:-$HOME/Documents/FS-UAE/Kickstarts/amiga-os-204.rom}"
       wb="${WEBADF_WB204:-$HOME/Downloads/WB204/Workbench v2.04 rev 37.67 (1991)(Commodore)(Disk 1 of 4)(Workbench).adf}";;
  31)  rom="${WEBADF_KS31:-$repo/docs/kickstart3.1.rom}"
       wb="${WEBADF_WB31:-$repo/adf-archive/Workbench31 - wbench31.adf}";;
  *) echo "usage: uae-test.sh 204|31 [shell|gui|space]"; exit 2;;
esac
[ -f "$rom" ] || { echo "FAIL: no Kickstart ROM at $rom"; exit 1; }
[ -f "$wb" ] || { echo "FAIL: no Workbench disk at $wb"; exit 1; }
md5="$(md5 -q "$rom" 2>/dev/null || md5sum "$rom" | cut -d' ' -f1)"
case "$md5" in
  dc10d7bdd1b6f450773dfb558477c230) model=A500+;;   # 2.04 37.175 (A500/A500+)
  e40a5dfb3d017ba8779faba30cbd1c8e) model=A500;;    # 3.1 40.63 (A500/A600/A2000)
  646773759326fbac3b2311fd8c8793ee) model=A1200;;   # 3.1 40.68 (A1200)
  *) echo "FAIL: unknown Kickstart (md5 $md5): set amiga_model by hand"; exit 1;;
esac
uae="${WEBADF_FSUAE:-/Applications/FS-UAE.app/Contents/MacOS/fs-uae}"
work="$(mktemp -d)"; mkdir -p "$work/hd/S" "$work/hd/Out" "$work/hd/EnvArc"
pid=""
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; }
trap cleanup EXIT
tools_out="$work/hd/Receive"; "$repo/tools/receive/build.sh" "$tools_out" >/dev/null
target='Work:Out'; df0=''
if [ "$mode" = space ]; then
  xdftool "$work/small.adf" create + format Small ofs >/dev/null; df0="$work/small.adf"; target='DF0:'
fi
case "$mode" in
  shell|space) run_line="Work:Receive TO $target SAVE >Work:receive.log";;
  gui) run_line="DF1:C/Assign >NIL: SYS: DF1:
DF1:C/LoadWB
Run >NIL: Work:Receive TO $target GUI";;
esac
cat > "$work/hd/S/startup-sequence" <<EOF
DF1:C/MakeDir >NIL: RAM:ENV RAM:T
DF1:C/Assign >NIL: ENV: RAM:ENV
DF1:C/Assign >NIL: T: RAM:T
DF1:C/Assign >NIL: LIBS: DF1:Libs ADD
DF1:C/Assign >NIL: C: DF1:C ADD
DF1:C/Assign >NIL: FONTS: DF1:Fonts
DF1:C/Assign >NIL: ENVARC: Work:EnvArc
$run_line
EOF
cat > "$work/receive.fs-uae" <<EOF
[fs-uae]
amiga_model = $model
kickstart_file = $rom
chip_memory = 1024
floppy_drive_count = 2
floppy_drive_0 = $df0
floppy_drive_1 = $wb
floppy_drive_1_write_protected = 1
hard_drive_0 = $work/hd
hard_drive_0_label = Work
bsdsocket_library = 1
automatic_input_grab = 0
initial_input_grab = 0
fullscreen = 0
EOF
"$uae" "$work/receive.fs-uae" >"$work/fs-uae.log" 2>&1 &
pid=$!
echo "fs-uae pid $pid, folder $work"
for _ in $(seq 1 90); do nc -z 127.0.0.1 6800 2>/dev/null && break; sleep 1; done
nc -z 127.0.0.1 6800 || { echo "FAIL: Receive never listened on 6800"; tail -20 "$work/fs-uae.log"; exit 1; }
rc=0
case "$mode" in
  shell) pnpm exec tsx "$repo/tools/receive/run-scenarios.ts" --port 6800 --dir "$work/hd/Out" --uae || rc=1
         [ "$(cat "$work/hd/EnvArc/webadf/ReceiveDir" 2>/dev/null)" = "Work:Out" ] && echo "PASS SAVE wrote ENVARC:webadf/ReceiveDir" \
           || { echo "FAIL ENVARC:webadf/ReceiveDir"; rc=1; }
         grep -q 's' "$work/hd/Out/Script.uaem" 2>/dev/null && grep -q 'a comment' "$work/hd/Out/Script.uaem" \
           && echo "PASS Script kept its s bit and comment" || { echo "FAIL Script metadata: $(cat "$work/hd/Out/Script.uaem" 2>/dev/null)"; rc=1; }
         sleep 2; echo "--- receive.log"; cat "$work/hd/receive.log" 2>/dev/null || true;;
  space) pnpm exec tsx -e '
           import { connect } from "'"$repo"'/tools/receive/fake-board";
           const b = await connect(6800);
           const o = await b.send({ id: "sp1", path: "TooBig.bin", data: Buffer.alloc(1000000) }); b.close();
           console.log(o.ok === false && o.code === "space" ? "PASS ERR space on a full floppy" : "FAIL " + JSON.stringify(o));
           process.exit(o.ok === false && o.code === "space" ? 0 : 1);' || rc=1;;
  gui) echo "GUI is up: run uae/screenshot steps (Task 5)"; read -r -t 600 -p "Press Return to stop FS-UAE " _ || true;;
esac
exit $rc
```

`chmod +x`. FS-UAE's directory hard drive keeps AmigaDOS protection bits and comments in `<name>.uaem` sidecar files,
which is why the `meta` check reads `Script.uaem`.

- [ ] **Step 8: Run on Kickstart 2.04, then 3.1**

Run: `tools/receive/uae/uae-test.sh 204 shell`
Expected: an FS-UAE window opens and boots. If macOS asks whether FS-UAE may accept incoming connections, allow it
(the operator may need to click this). Then `PASS` for plain, folder, collision, case, latin1, badcrc, badname, empty,
meta, big, drop, garbage, busy and list, then `PASS SAVE wrote…` and `PASS Script kept…`, exit 0. The 4 MB `big`
scenario takes time under emulation: about a minute.

Run: `tools/receive/uae/uae-test.sh 31 shell`. Expected: the same.

Run: `tools/receive/uae/uae-test.sh 204 space`. Expected: `PASS ERR space on a full floppy`.

If `latin1` fails, FS-UAE's host name for `Café.txt` differs. The detail line lists the folder. Record what FS-UAE
did. The check must accept the name FS-UAE produces for the Amiga's `Caf\xe9.txt` and nothing else; write the
mapping into `hostName()` in `scenarios.ts` with a comment naming the evidence.

- [ ] **Step 9: Commit**

```bash
git add tools/receive/amiga tools/receive/build.sh tools/receive/receive.sha256 tools/receive/uae package.json
git commit -m "receive: Amiga build (68000, V37) and the Shell form; all scenarios pass in FS-UAE on Kickstart 2.04 and 3.1"
```

---

### Task 5: The window (gadtools), with the receiving queue

**Files:**
- Create: `tools/receive/amiga/gui.c`, `tools/receive/uae/window-id.swift`
- Modify: `tools/receive/amiga/main.c` (template `TO/K,SAVE/S,GUI/S`, Workbench start)

**Interfaces:**
- Consumes:
  - `net_open`, `net_close` and `net_run` with `net_ui`;
  - `afs_init` and `afs_set_root`;
  - `cfg_load` and `cfg_save`;
  - `rx_busy`, plus `rx_session.list` and `list_n`.
- Produces: `int gui_main(const char *dir);`

**Behaviour:**
- **The window:**
  - Title `webadf Receive`, on the default public screen, in the screen's font.
  - Rows, top to bottom:
    1. `Save files to:` string gadget and `Choose…`;
    2. `Save` (right-aligned);
    3. the status text (a bordered TEXT_KIND);
    4. a read-only listview of 8 rows.
  - The inner width is 56 × the font's `M` width, capped so the window fits the screen.
- **The listview rows:** up to 48. Each is `<name, at most 22 chars, padded> <size> KB  <state>`, with these states:
  - `waiting` (from LIST);
  - `receiving NN%` (BEGIN/PROGRESS);
  - `done` (DONE; the name shown is the saved one);
  - `failed: <text>` (FAILED).

  A LIST removes `waiting` rows whose id is no longer listed, and adds new ids as `waiting`. When there are more than
  48 rows, the oldest done or failed rows go first.
- **Choose…** opens an asl file requester (`ASLFR_DrawersOnly` is ignored on V37) titled `Save files to`. On OK it puts
  `fr_Drawer` into the string gadget.
- **Save** reads the string gadget:
  - If `cfg_save` fails, the status reads `Could not save to ENVARC:`.
  - Otherwise the folder takes effect at once, unless a file is in progress; then it takes effect when that file ends.
    The status reads `Saved. Listening on port 6800`, or `Folder not found` if the folder doesn't exist.
- **The close gadget** quits.
- **No stack:** the window opens anyway with the status `No TCP/IP stack running (bsdsocket.library)` and waits only for
  the close gadget.

- [ ] **Step 1: Implement `gui.c`**

```c
/* Receive's window: folder setting and the receiving queue. gadtools + asl only (V37). */
#include <stdio.h>
#include <string.h>
#include <exec/memory.h>
#include <intuition/intuition.h>
#include <libraries/gadtools.h>
#include <libraries/asl.h>
#include <proto/exec.h>
#include <proto/intuition.h>
#include <proto/gadtools.h>
#include <proto/graphics.h>
#include <proto/asl.h>
#include <proto/dos.h>
#include "afs.h"
#include "config.h"
#include "net.h"
#include "ui.h"

struct Library *GadToolsBase, *AslBase;
struct IntuitionBase *IntuitionBase;
struct GfxBase *GfxBase;

enum { G_DIR, G_CHOOSE, G_SAVE, G_STATUS, G_LIST, G_N };
#define ROWS_MAX 48
enum { ST_WAITING, ST_RECEIVING, ST_DONE, ST_FAILED };
typedef struct { struct Node node; char id[RX_ID_MAX + 1]; char name[RX_PATH_MAX + 1]; unsigned long size;
                 int state; unsigned pct; char why[40]; char text[80]; } row;

typedef struct {
    struct Window *win; struct Gadget *g[G_N]; APTR vi; struct Screen *scr;
    struct List list; row rows[ROWS_MAX]; int n;
    afs_ctx *ctx; rx_fs *fs; rx_session *s;
    char status[80]; char pending[256]; int has_pending; int quit;
    struct Gadget *gl;   /* CreateContext's list: freed after CloseWindow (FirstGadget includes system gadgets) */
} gui;

static void set_status(gui *G, const char *t) {
    strncpy(G->status, t, sizeof G->status - 1);
    if (G->win) GT_SetGadgetAttrs(G->g[G_STATUS], G->win, NULL, GTTX_Text, (ULONG)G->status, TAG_END);
}
static void row_text(row *r) {
    char nm[23]; const char *base = strrchr(r->name, '/'); size_t l;
    base = base ? base + 1 : r->name;
    strncpy(nm, base, 22); nm[22] = 0;
    l = strlen(nm); while (l < 22) nm[l++] = ' '; nm[22] = 0;
    switch (r->state) {
    case ST_WAITING: sprintf(r->text, "%s %5lu KB  waiting", nm, (r->size + 1023) / 1024); break;
    case ST_RECEIVING: sprintf(r->text, "%s %5lu KB  receiving %u%%", nm, (r->size + 1023) / 1024, r->pct); break;
    case ST_DONE: sprintf(r->text, "%s %5lu KB  done", nm, (r->size + 1023) / 1024); break;
    default: sprintf(r->text, "%s %5lu KB  failed: %.30s", nm, (r->size + 1023) / 1024, r->why); break;
    }
    r->node.ln_Name = r->text;
}
static void relist(gui *G) {
    int i;
    if (G->win) GT_SetGadgetAttrs(G->g[G_LIST], G->win, NULL, GTLV_Labels, ~0UL, TAG_END);
    NewList(&G->list);
    for (i = 0; i < G->n; i++) { row_text(&G->rows[i]); AddTail(&G->list, &G->rows[i].node); }
    if (G->win) GT_SetGadgetAttrs(G->g[G_LIST], G->win, NULL, GTLV_Labels, (ULONG)&G->list, TAG_END);
}
static row *find(gui *G, const char *id) { int i; for (i = 0; i < G->n; i++) if (!strcmp(G->rows[i].id, id)) return &G->rows[i]; return NULL; }
static void drop_at(gui *G, int i) { memmove(&G->rows[i], &G->rows[i + 1], (size_t)(G->n - i - 1) * sizeof(row)); G->n--; }
static row *add(gui *G, const char *id) {
    int i;
    if (G->n == ROWS_MAX) {
        for (i = 0; i < G->n && (G->rows[i].state == ST_WAITING || G->rows[i].state == ST_RECEIVING); i++) ;
        if (i == G->n) return NULL;
        drop_at(G, i);
    }
    memset(&G->rows[G->n], 0, sizeof(row));
    strcpy(G->rows[G->n].id, id);
    return &G->rows[G->n++];
}
static void on_event(void *u, const rx_event *e, rx_session *s) {
    gui *G = u; row *r; unsigned i; int k;
    switch (e->kind) {
    case RX_EV_LIST:
        for (k = G->n - 1; k >= 0; k--) {
            int listed = 0;
            for (i = 0; i < s->list_n; i++) if (!strcmp(s->list[i].id, G->rows[k].id)) listed = 1;
            if (G->rows[k].state == ST_WAITING && !listed) drop_at(G, k);
        }
        for (i = 0; i < s->list_n; i++) if (!find(G, s->list[i].id) && (r = add(G, s->list[i].id)) != NULL) {
            strcpy(r->name, s->list[i].path); r->size = s->list[i].size; r->state = ST_WAITING;
        }
        break;
    case RX_EV_BEGIN:
        if (!(r = find(G, e->id))) r = add(G, e->id);
        if (r) { strcpy(r->name, e->path); r->size = e->size; r->state = ST_RECEIVING; r->pct = 0; }
        break;
    case RX_EV_PROGRESS:
        if ((r = find(G, e->id)) != NULL) r->pct = e->size ? (unsigned)(e->bytes / (e->size / 100 + 1)) : 0;
        if (r && r->pct > 99) r->pct = 99;
        break;
    case RX_EV_DONE:
        if ((r = find(G, e->id)) != NULL) { strcpy(r->name, e->path); r->state = ST_DONE; }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    case RX_EV_FAILED:
        if ((r = find(G, e->id)) != NULL) { r->state = ST_FAILED; strncpy(r->why, e->text ? e->text : "", sizeof r->why - 1); }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    default: return;
    }
    relist(G);
}
/* net_run reports "Listening on port 6800"; a missing folder says so instead, from the first draw. */
static void on_status(void *u, const char *t) { gui *G = u; set_status(G, G->fs->folder_ok(G->ctx) ? t : "Folder not found"); }
static const char *dir_text(gui *G) { return (const char *)((struct StringInfo *)G->g[G_DIR]->SpecialInfo)->Buffer; }
static void choose(gui *G) {
    struct FileRequester *fr = AllocAslRequestTags(ASL_FileRequest,
        ASLFR_Window, (ULONG)G->win, ASLFR_TitleText, (ULONG)"Save files to",
        ASLFR_InitialDrawer, (ULONG)dir_text(G), ASLFR_DrawersOnly, TRUE, TAG_END);
    if (!fr) return;
    if (AslRequest(fr, NULL))
        GT_SetGadgetAttrs(G->g[G_DIR], G->win, NULL, GTST_String, (ULONG)fr->fr_Drawer, TAG_END);
    FreeAslRequest(fr);
}
static void save(gui *G) {
    strncpy(G->pending, dir_text(G), sizeof G->pending - 1);
    if (cfg_save(G->pending) != 0) { set_status(G, "Could not save to ENVARC:"); return; }
    if (G->s && rx_busy(G->s)) G->has_pending = 1; else afs_set_root(G->ctx, G->pending);
    set_status(G, G->fs->folder_ok(G->ctx) || G->has_pending ? "Saved. Listening on port 6800" : "Folder not found");
}
static int on_signal(void *u, ULONG sigs) {
    gui *G = u; struct IntuiMessage *m;
    (void)sigs;
    while ((m = GT_GetIMsg(G->win->UserPort)) != NULL) {
        ULONG cls = m->Class; struct Gadget *gad = (struct Gadget *)m->IAddress;
        GT_ReplyIMsg(m);
        if (cls == IDCMP_CLOSEWINDOW) G->quit = 1;
        else if (cls == IDCMP_REFRESHWINDOW) { GT_BeginRefresh(G->win); GT_EndRefresh(G->win, TRUE); }
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_CHOOSE) choose(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_SAVE) save(G);
    }
    return G->quit;
}

static int build(gui *G, const char *dir) {
    struct NewGadget ng; struct Gadget *gl = NULL, *g;
    struct TextAttr *ta = G->scr->Font;
    struct TextFont *tf = OpenFont(ta);
    struct RastPort rp;
    UWORD fh = ta->ta_YSize, mw, lw, w, x0, y, gh, iw;
    InitRastPort(&rp);
    if (tf) SetFont(&rp, tf);
    mw = (UWORD)TextLength(&rp, (STRPTR)"M", 1);
    lw = (UWORD)TextLength(&rp, (STRPTR)"Save files to:", 14) + 8;
    w = (UWORD)TextLength(&rp, (STRPTR)"Choose...", 9) + 16;
    if (tf) CloseFont(tf);
    iw = (UWORD)(56 * mw);
    if (iw > G->scr->Width - 24) iw = (UWORD)(G->scr->Width - 24);
    x0 = (UWORD)(G->scr->WBorLeft + 6); y = (UWORD)(G->scr->WBorTop + fh + 1 + 4); gh = (UWORD)(fh + 6);
    g = CreateContext(&gl);
    memset(&ng, 0, sizeof ng);
    ng.ng_VisualInfo = G->vi; ng.ng_TextAttr = ta;
    ng.ng_LeftEdge = (WORD)(x0 + lw); ng.ng_TopEdge = (WORD)y; ng.ng_Width = (WORD)(iw - lw - w - 18); ng.ng_Height = (WORD)gh;
    ng.ng_GadgetText = (UBYTE *)"Save files to:"; ng.ng_GadgetID = G_DIR; ng.ng_Flags = PLACETEXT_LEFT;
    G->g[G_DIR] = g = CreateGadget(STRING_KIND, g, &ng, GTST_String, (ULONG)dir, GTST_MaxChars, 255, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + iw - w - 6); ng.ng_Width = (WORD)w; ng.ng_GadgetText = (UBYTE *)"Choose...";
    ng.ng_GadgetID = G_CHOOSE; ng.ng_Flags = PLACETEXT_IN;
    G->g[G_CHOOSE] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    y = (UWORD)(y + gh + 4);
    ng.ng_TopEdge = (WORD)y; ng.ng_GadgetText = (UBYTE *)"Save"; ng.ng_GadgetID = G_SAVE;
    G->g[G_SAVE] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    y = (UWORD)(y + gh + 4);
    ng.ng_LeftEdge = (WORD)x0; ng.ng_TopEdge = (WORD)y; ng.ng_Width = (WORD)(iw - 12); ng.ng_GadgetText = NULL; ng.ng_GadgetID = G_STATUS;
    G->g[G_STATUS] = g = CreateGadget(TEXT_KIND, g, &ng, GTTX_Text, (ULONG)G->status, GTTX_Border, TRUE, TAG_END);
    y = (UWORD)(y + gh + 4);
    ng.ng_TopEdge = (WORD)y; ng.ng_Height = (WORD)(8 * (fh + 1) + 4); ng.ng_GadgetID = G_LIST;
    G->g[G_LIST] = g = CreateGadget(LISTVIEW_KIND, g, &ng, GTLV_Labels, (ULONG)&G->list, GTLV_ReadOnly, TRUE, TAG_END);
    G->gl = gl;
    if (!g) { FreeGadgets(gl); G->gl = NULL; return -1; }
    G->win = OpenWindowTags(NULL,
        WA_Title, (ULONG)"webadf Receive", WA_PubScreen, (ULONG)G->scr, WA_Gadgets, (ULONG)gl,
        WA_InnerWidth, iw, WA_InnerHeight, (ULONG)(y + ng.ng_Height + 6 - (G->scr->WBorTop + fh + 1)),
        WA_DragBar, TRUE, WA_DepthGadget, TRUE, WA_CloseGadget, TRUE, WA_Activate, TRUE, WA_SimpleRefresh, TRUE,
        WA_IDCMP, IDCMP_CLOSEWINDOW | IDCMP_REFRESHWINDOW | BUTTONIDCMP | STRINGIDCMP | LISTVIEWIDCMP, TAG_END);
    if (!G->win) { FreeGadgets(gl); G->gl = NULL; return -1; }
    GT_RefreshWindow(G->win, NULL);
    return 0;
}

int gui_main(const char *dir) {
    static gui G; static afs_ctx ctx; static rx_fs fs; static rx_session s;
    int rc = RETURN_FAIL;
    IntuitionBase = (struct IntuitionBase *)OpenLibrary((STRPTR)"intuition.library", 37);
    GfxBase = (struct GfxBase *)OpenLibrary((STRPTR)"graphics.library", 37);
    GadToolsBase = OpenLibrary((STRPTR)"gadtools.library", 37);
    AslBase = OpenLibrary((STRPTR)"asl.library", 37);
    if (!IntuitionBase || !GfxBase || !GadToolsBase || !AslBase) goto out;
    memset(&G, 0, sizeof G); NewList(&G.list);
    G.ctx = &ctx; G.fs = &fs; G.s = &s;
    afs_init(&ctx, &fs, dir);
    strcpy(G.status, "Starting...");
    if (!(G.scr = LockPubScreen(NULL)) || !(G.vi = GetVisualInfo(G.scr, TAG_END))) goto out;
    if (build(&G, dir) != 0) goto out;
    if (net_open() != 0) {
        set_status(&G, "No TCP/IP stack running (bsdsocket.library)");
        while (!G.quit) {
            if (Wait(1UL << G.win->UserPort->mp_SigBit | SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) break;
            on_signal(&G, 0);
        }
    } else {
        net_ui ui;
        ui.u = &G; ui.on_event = on_event; ui.on_status = on_status;
        ui.extra_sigs = 1UL << G.win->UserPort->mp_SigBit; ui.on_signal = on_signal;
        if (net_run(&ui, &ctx, &fs, &s) != 0) set_status(&G, "Could not listen on port 6800");
        net_close();
    }
    rc = RETURN_OK;
out:
    if (G.win) CloseWindow(G.win);
    if (G.gl) FreeGadgets(G.gl);
    if (G.vi) FreeVisualInfo(G.vi);
    if (G.scr) UnlockPubScreen(NULL, G.scr);
    if (AslBase) CloseLibrary(AslBase);
    if (GadToolsBase) CloseLibrary(GadToolsBase);
    if (GfxBase) CloseLibrary((struct Library *)GfxBase);
    if (IntuitionBase) CloseLibrary((struct Library *)IntuitionBase);
    return rc;
}
```

Layout note: the layout's `y` starts below the title bar, so `WA_InnerHeight` is `(y + list height + 6) - (WBorTop +
fh + 1)`. With topaz 8 that is about 150 pixels, which fits 640×200 with the screen title.

- [ ] **Step 2: Wire `main.c`**

Change the template to `TO/K,SAVE/S,GUI/S` (`LONG args[3]`). After the folder is resolved and saved:
`rc = args[2] ? gui_main(dir) : shell_main(dir);`. For `argc == 0` (Workbench start; libnix passes 0): call
`cfg_load(dir, sizeof dir)` and `return gui_main(dir);`. Remove the `/* Workbench start: Task 5 */` line.

- [ ] **Step 3: Build**

Run: `tools/receive/build.sh /tmp/Receive --pin`
Expected: no warnings, under 30,000 bytes, `pinned`.

- [ ] **Step 4: Window id helper for a screenshot**

`tools/receive/uae/window-id.swift`:

```swift
// Prints the CGWindowID of the first on-screen window owned by the named app (default FS-UAE).
import CoreGraphics
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "FS-UAE"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
if let w = list.first(where: { ($0[kCGWindowOwnerName as String] as? String)?.hasPrefix(owner) == true }) {
  print(w[kCGWindowNumber as String] as! Int)
} else { exit(1) }
```

- [ ] **Step 5: Run the GUI in FS-UAE and capture it**

Terminal A: `tools/receive/uae/uae-test.sh 204 gui` (the harness leaves FS-UAE up for 10 minutes).
Terminal B, once `Receive` listens (the script prints the folder):

```bash
pnpm exec tsx -e '
import { connect } from "./tools/receive/fake-board";
const files = [
  { id: "w1", path: "Turrican2.lha", data: Buffer.alloc(420000, 1) },
  { id: "w2", path: "mods/axelf.mod", data: Buffer.alloc(58000, 2) },
  { id: "w3", path: "Lemmings.adf", data: Buffer.alloc(901120, 3) },
  { id: "w4", path: "Readme.txt", data: Buffer.from("hi") },
];
const b = await connect(6800);
b.list(files);
console.log(await b.send(files[3]));
b.list(files.slice(0, 3));
const p = b.send(files[0], { chunk: 2048, delayMs: 40 });
await new Promise((r) => setTimeout(r, 6000));
console.log("capture now");
console.log(await p);
b.close();'
```

When it prints `capture now`:

```bash
screencapture -x -o -l"$(swift tools/receive/uae/window-id.swift FS-UAE)" /tmp/receive-gui-204.png
```

Expected:
- **The screenshot** shows the window with:
  - `Save files to:` set to `Work:Out`;
  - the status `Listening on port 6800`;
  - the rows `Readme.txt … done`, `Turrican2.lha … receiving NN%`, `axelf.mod … waiting` and
    `Lemmings.adf … waiting`.
- **The window fits** inside the Workbench screen at 640×200 (2.04's default screen is 640×200 NTSC or 640×256 PAL;
  set `ntsc_mode = 1` in the config to check 200 lines).

If `screencapture` is refused (no Screen Recording permission for the terminal), say so to the operator and ask them
to look at the FS-UAE window. Do not grant permissions yourself.

Then click **Choose…** and **Save** in the FS-UAE window yourself, if input works with grab off. Otherwise list them
for the operator's bench. Confirm that `Work:EnvArc/webadf/ReceiveDir` on the host changes after Save.

Repeat for `31 gui`. Save both PNGs in the scratchpad and show them to the operator.

- [ ] **Step 6: Re-run the Shell scenarios** (the binary changed)

Run: `tools/receive/uae/uae-test.sh 204 shell && tools/receive/uae/uae-test.sh 31 shell`
Expected: all PASS, as in Task 4.

- [ ] **Step 7: Commit**

```bash
git add tools/receive/amiga tools/receive/receive.sha256 tools/receive/uae/window-id.swift
git commit -m "receive: the window -- folder setting with an asl requester, saved to ENVARC:, and the receiving queue"
```

---

### Task 6: CI, the final pin, docs and the HANDOFF note

**Files:**
- Create: `.github/workflows/receive.yml`, `tools/receive/README.md`
- Modify: `HANDOFF.md` (a new section after the newest one, `3bt`)

- [ ] **Step 1: CI workflow**

`.github/workflows/receive.yml`:

```yaml
name: receive
on:
  push:
    paths: ['tools/receive/**', '.github/workflows/receive.yml']
  pull_request:
    paths: ['tools/receive/**', '.github/workflows/receive.yml']
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Host tests (core)
        run: tools/receive/test/run.sh
      - name: POSIX integration against the fake board
        run: pnpm vitest run tools/receive/receive.int.test.ts
      - name: Cross-build matches the pin
        run: tools/receive/build.sh "$RUNNER_TEMP/Receive"
```

Check the `actions/*` versions against `.github/workflows/firmware.yml` and use the same ones it uses.

- [ ] **Step 2: README**

`tools/receive/README.md` explains:
- what `Receive` is (spec link);
- the Shell template and the window;
- the folder setting's two files;
- `pnpm receive:test`, `pnpm receive:build` and `pnpm receive:uae 204|31 [shell|gui|space]`, with the ROM and
  Workbench paths it expects and the env overrides;
- that ROMs and ADFs are never committed;
- that the binary is pinned in `receive.sha256` and goes onto the PaulaNET disk in increment 3.

- [ ] **Step 3: Final pin and full check**

Run:

```bash
tools/receive/build.sh /tmp/Receive && tools/receive/test/run.sh && pnpm vitest run tools/receive/receive.int.test.ts
```

Expected: `PASS pinned`, host tests 0 failed, 3 passed.

- [ ] **Step 4: HANDOFF note**

Add `### 3bt. PaulaNET Phase 4 increment 1: Receive (the Amiga side) -- branch feat/receive` with:
- the size of the binary and its sha;
- each FS-UAE result per Kickstart, with the screenshot paths;
- the `latin1` finding (FS-UAE's host naming);
- the three rulings from this plan;
- what is owed: increment 2 (firmware 1.14.0 + server queue) and increment 3 (web, card, disk + Install, and the
  disk-sha rollout).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/receive.yml tools/receive/README.md HANDOFF.md
git commit -m "receive: CI (host tests, POSIX integration, build pin), README, HANDOFF 3bt"
```

Do not merge or push. The operator decides (it touches only `tools/`, CI, `vitest.config` and docs, so nothing
deploys behaviour; ask anyway).
