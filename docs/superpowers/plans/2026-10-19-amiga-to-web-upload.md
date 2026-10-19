# Upload from the Amiga to the web app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A file on the Amiga goes into the org's *From the Amiga* area in the web app, through the board, over
PaulaNET: dropped on Receive's window, chosen with **Send…**, or sent with `Receive SEND <files>`.

**Architecture:** Receive 2 (the same Amiga program) speaks protocol 2 on the TCP 6800 connection the board already
holds: it announces a file with `PUT`, sends raw bytes only within the board's credit (`TAKE`/`MORE`), and ends with
`END <crc>`; the board answers `DONE` or `NO`. The board (firmware 1.19.0) lands the bytes from its lwIP receive
callback straight into a 32 KB PSRAM ring (two 16 KB chunks), posts each full chunk to the server with one HTTPS
request per `as_step()`, and closes the upload. The server stages chunks in Postgres (`amiga_upload_chunks`, as
write-back stages tracks), checks size and CRC-32 at close, stores the bytes content-addressed through `diskStore`,
and lists them in `amiga_uploads`, which the Upload page shows as a full-width *From the Amiga* card.

**Tech Stack:** C89-ish 68000 C (Receive: amiga-gcc 6.5 in the pinned image, Kickstart 2.04+, gadtools/asl/workbench/
bsdsocket), C11 RP2350 firmware (pico-sdk 2.3.0, lwIP raw API, host tests with `cc`), TypeScript/Next.js route handlers,
drizzle + node-postgres (migration 0047), vitest (+ `test:db`), Playwright (e2e), FS-UAE (Kickstart 2.04/3.1/3.2),
Docker (self-host smoke).

**Spec:** `docs/superpowers/specs/2026-10-18-amiga-to-web-upload-design.md` (approved 2026-10-19; §12 rulings all as
recommended). Background: `docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md`, HANDOFF
3bt-3bw, 3ca, 3cb.

## Global Constraints

- **Migration number 0047** (`drizzle/0047_amiga_uploads.sql`, generated with `pnpm db:generate --name amiga_uploads`).
  It is additive only. **Never migrate production from a task**: never run `pnpm db:migrate` (its `.env.local` is the
  production database). Task 15 asks the operator to apply 0047.
- **Firmware 1.19.0** (`FIRMWARE_SEMVER` in `wifi-floppy/firmware/CMakeLists.txt`; the server's `UPLOAD_FW = '1.19.0'`).
  Tasks publish **TEST builds only**: notes start exactly `TEST build`, read back from the DB (HANDOFF 3bu incident).
  Releasing 1.19.0 is the operator's decision.
- **Receive protocol 2**: the board says `WEBADF 2 <key>`, Receive 2 answers `READY 2`. Every protocol 1 line stays
  valid. Receive 1 answers `READY 1` to any `WEBADF` line (rx_proto.c:198), and the board then never offers uploads;
  Receive 2 hearing `WEBADF 1` answers `READY 1` and disables uploads ("update the board").
- **SRAM `.bss` must not grow beyond 432,532 B** (1.18.2, measured with
  `arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | awk '$1==".bss"{print $2}'`), and **the heap
  low-water must stay ≥ 20,480 B** (the `heap: free low-water` and `pnet: l2 amiga ... heap` log lines). New firmware
  buffers and upload state are `__uninitialized_psram`.
- **Sizes and limits (spec U3-U5):** 16 KB chunks (16,384 B), a two-chunk credit window (32 KB), 4 MB per file
  (4,194,304 B = `SEND_FILE_MAX`), 500 files / 256 MB per org, stored files kept 30 days, a partial upload resumable
  for 24 h, one upload in flight per board.
- **Self-host parity:** the same routes, tables and cron on both deployments; bytes go through `diskStore` (local
  folder or Vercel Blob alike); no our-deployment-only dependency; `pnpm docker:smoke` gains an upload round trip.
- **e2e on `PORT=3100`, one run at a time** (never two on this machine), each run under 9 minutes, only the specs for
  the touched areas. The dev server on 3100 reads the production database, so the new e2e spec runs only after the
  operator has applied 0047 (Task 15).
- **Help text changes with behaviour:** `src/lib/help/topics.tsx` and `src/lib/help/topics.test.ts` in the same
  commit as the behaviour they describe.
- **The new blob column joins `runBlobGc`:** `amiga_uploads.blob_sha256` is a reference while the row's status is not
  `deleted` (the weekly blob GC rule).
- **No raw bytes toward the Amiga** (MFM only, HANDOFF 3bu): nothing here touches the board → Amiga framing. Board →
  Receive traffic stays lines only.
- **Trust on first use:** Receive saves the first board key it sees in `ENVARC:webadf/BoardKey` (32 hex digits, copied
  to `ENV:webadf/BoardKey`), uploads only to that key, and `TRUST` / **Trust this board** replaces it.
- **3bv lessons:** count non-expired rows only; the count and the insert run in one transaction, serialised per org
  (`pg_advisory_xact_lock`: READ COMMITTED alone lets two counts pass together); `as_has_work()` is true while an
  upload is open (outside a backoff, exactly as for sends today).
- **Kickstart 2.04 floor, 68000, no FPU** for Receive: intuition, gadtools, asl, dos, icon, workbench and bsdsocket
  only. Receive is built by `tools/receive/build.sh`; after source changes `build.sh tools/receive/dist/Receive --pin`
  and commit both.
- **Next.js:** this repo's Next.js differs from training data. Before writing a route handler or page, read the matching
  guide under `node_modules/next/dist/docs/` (route handlers: `params` is a Promise, as in every route here).
- **Numbers from the measurement (Task 1, increment 0):** `AS_UP_WINDOW_CHUNKS` (default **2**, spec §3) and
  `AS_UP_OOSEQ_BYTES` (default **2,920**, two segments). Until the Task 1 bench has run, tasks use the defaults; Task 11
  Step 1 says how a measured value replaces them.
- **Process:** never `git add -A` (other sessions change this tree; re-check `git status --short` before staging);
  master is the Vercel production branch (merge + push is a listed step); manual hardware steps (power, typing on the
  Amiga) are asked for as the last thing in a turn; a firmware install ejects the disk (switch the Amiga off first if
  in use, or Ctrl+Alt+Del it through the PiKVM when idle); never pattern-kill processes.
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk
  ```

## Review Focus

- **A file sent again after a reset whose server row already holds every byte but was never closed.** The open
  answers offset = size; Receive must read the whole file once for the CRC, send no raw bytes, then `END`; the board
  must go straight to the close. A reasonable person expects it to finish, not hang on a chunk that never comes.
  Tests: Task 3 `resume_at_the_end_sends_no_bytes_then_end`, Task 10 `resume_at_size_goes_straight_to_close`,
  Task 12 `a full but unclosed upload resumes at its size and closes`.
- **An empty file** (`Receive SEND RAM:empty`). PUT size 0, `TAKE <tag> 0 0`, `END <tag> 0`, and an empty blob stored.
  Tests: Task 3 `empty_file_goes_up`, Task 10 `zero_byte_upload`, Task 12 `an empty file is stored`.
- **Latin-1 names** (`Café.txt`, a 30-byte part, a 255-byte path): Latin-1 on the wire, `\u00XX` in the board's JSON,
  UTF-8 on the server, Latin-1 again in `DONE`. Expected: the name reads the same everywhere. Tests: Task 9
  `put_parses_and_json_escapes_latin1`, Task 10 `done_name_is_latin1`, Task 12 `a Latin-1 path is stored as UTF-8`.
- **A chunk whose answer was lost** (the board's HTTPS request reached the server, the reply did not). The retry of the
  same offset must be answered with the same `received` and store nothing twice. Tests: Task 10
  `a_lost_chunk_answer_is_retried`, Task 12 `a repeated chunk is not stored twice`.
- **Clear all while a file arrives.** Clear all with `before` = the newest row the user saw must spare a row created
  after it and every row still `receiving`. Tests: Task 12 `clear spares a newer row and a receiving row`, Task 16 `clear passes the newest time the person saw`.

---

## Rulings this plan makes (spec points that do not match the code, or cannot work as written)

| # | Spec says | The code says | This plan |
|---|---|---|---|
| P1 | §5: the upload state lives "in the struct main.c already places" in PSRAM | `main.c:2203` `static amiga_send_t g_send` is SRAM `.bss`; only the queue and chunk buffers are PSRAM | a new PSRAM struct `as_up_t` (state, PUT line, key, JSON); `amiga_send_t` gains a pointer and two bytes |
| P2 | §5: the key is "kept in `config_store`. It survives re-pairing" | `config_store_erase()` runs on every re-pair (`provisioning.c:44`) and server change (`main.c:5387`) | its own flash sector, `key_store.c` at sector −8 (−7 is the boot trail) |
| P3 | §5: 16 KB chunk POSTs | `dc_post` copies the body into a static SRAM buffer of `DC_POST_HEAD_BYTES + DC_POST_BODY_MAX` (11,264) | `dc_post` sends its head and the caller's body as two writes; `DC_POST_BODY_MAX` 16,384; `.bss` drops by 11,264 |
| P4 | U9: the cap rises to "1,514 = `PNET_RING_MTU`" | `PNET_RING_MTU` is 1518 (`pnet_ring.h:22`) | the cap becomes `PNET_RING_MTU`, i.e. any frame the ring can hold |
| P5 | §4: bytes under `uploads/<sha256>` through `diskStore` | `diskStore` keys only `adf/<sha256>`; Phase 4's transfers already store there (R2), and the GC lists only `adf/` | `adf/<sha256>` (`storeSendBytes`); **Add to library** then needs no copy |
| P6 | §4: Add to library "calls `registerUploads`" | `registerUploads` takes ADF/HFE bytes only, and its `releaseRefused` deletes refused bytes no disk/blob/history names | `prepareImages` (URL ingest's normaliser: ADZ/DMS/DMZ → ADF) first; `releaseRefused` also counts `amiga_uploads` and `transfers` as references |
| P7 | §3 Stops: "The Amiga stops a file with `ABORT <tag>`" | after `TAKE` every byte from the Amiga is raw file data, so a line cannot be told apart from data | `ABORT` only between `PUT` and `TAKE`; once data flows, a stop (Receive's, or a board-side failure after its `NO`) closes the connection; the server keeps the partial for resume |
| P8 | §4: count and insert "in one transaction, so two concurrent opens cannot both pass" | Postgres READ COMMITTED lets two transactions count the same rows | `pg_advisory_xact_lock` on the org inside that transaction |
| P9 | §5: "backs off ... while the long poll runs" and "`as_has_work()` is true while an upload is open" | `as_has_work()` returns false during a backoff (send path, today) | both: true while open, false in a backoff (the long poll runs; the credit does not move) |
| P10 | §2: `rx_fs` gains `seek` | the CRC pre-read of the resumed part leaves the file at `<offset>` | no `seek` callback |
| P11 | §10: "the board is then proven against FS-UAE" | the board connects only to the address its PaulaNET sorter learned; FS-UAE's bsdsocket is the Mac's | the board is proven on the A500 bench; FS-UAE proves Receive against the fake board |
| P12 | §9: docker-smoke "against the fake board" | the smoke has no Amiga side | the smoke plays the board over the device routes with curl |
| P13 | §5: the status report carries `upKey` | the status body has 6 bytes to spare (`device_client.h:181`) | `upKey` rides until a report carrying it is heard, like `lastBoot`, and is left out (still owed) when it does not fit |
| P14 | (not in spec) | Receive drops a connection silent for 75 s; a stalled upload is silent both ways | Receive allows 180 s while an upload is open, past the board's 120 s give-up |
| P15 | (not in spec) | the web must show the board key's 4 digits | `devices.up_key` joins migration 0047 |
| P16 | §6: "There is one open upload per board" | the server cannot tell a stale partial from a live one | the board enforces it (a second PUT drops the connection); the server keeps every partial for its resume |
| P17 | §5: "A factory reset makes a new one" | the firmware has no factory reset | nothing to hook now; erasing `key_store` belongs to a future reset |

---

## File Structure

Created:

| Path | Responsibility |
|---|---|
| `wifi-floppy/firmware/src/a2b_discard.c/.h` | increment 0 only (`WF_A2B_DISCARD`, OFF in releases): a TCP discard service on port 6801 that counts bytes and measures the out-of-order queue |
| `tools/a2b-bench/a2bsend.c`, `tools/a2b-bench/build.sh` | the Amiga bench sender for increment 0 and the ADF that carries it |
| `wifi-floppy/firmware/src/key_store.c/.h`, `wifi-floppy/firmware/test/test_key_store.c` | the board key's flash record (sector −8) and its hex form |
| `tools/receive/amiga/ipc.c/.h` | the public port `webadf.Receive`: a Shell `SEND` hands files to a running Receive |
| `tools/receive/uae/send-scenarios.ts` | the board's side of the FS-UAE upload runs (`uae-test.sh <ks> send`) |
| `src/db/schema/amiga-uploads.ts`, `drizzle/0047_amiga_uploads.sql` (+ journal, snapshot) | `amiga_uploads`, `amiga_upload_chunks`, `devices.up_key` |
| `src/lib/amiga-upload-limits.ts` | client-safe constants (`UPLOAD_FW`, sizes, retention) |
| `src/lib/amiga-uploads.ts`, `src/lib/amiga-uploads.db.test.ts` | open / chunk / close, the area's list, delete, clear, housekeeping, card counts |
| `src/app/api/device/upload/route.ts`, `[id]/route.ts`, `[id]/close/route.ts`, `routes.test.ts` | the board's three upload routes |
| `src/app/api/uploads/route.ts`, `clear/route.ts`, `[id]/route.ts`, `[id]/file/route.ts`, `[id]/library/route.ts`, `[id]/send/route.ts`, `routes.test.ts` | the person's routes for the area |
| `src/lib/from-amiga-ui.ts`, `src/lib/from-amiga-ui.test.ts` | every word and rule the card and the device card use (pure, client-safe) |
| `src/components/uploads/from-amiga-card.tsx` | the *From the Amiga* card on the Upload page |
| `e2e/from-amiga.spec.ts` | the area driven by a simulated board |

Modified:

| Path | Change |
|---|---|
| `tools/receive/core/rx_proto.h/.c` | protocol 2 hello, trust on first use, the upload queue and state machine, the drawer walk |
| `tools/receive/test/fakefs.h`, `tools/receive/test/test_proto.c` | the read side of the fake file system; upload tests |
| `tools/receive/posix/rx_posix.c`, `fake-board.ts`, `scenarios.ts`, `receive.int.test.ts`, `README.md` | uploads on the host build; the board's upload side; shared upload scenarios |
| `tools/receive/amiga/{afs,config,net,shell,gui,main}.c/.h`, `ui.h` | read side, BoardKey, the output loop, `SEND`/`TRUST`, the window |
| `tools/receive/uae/uae-test.sh`, `tools/receive/build.sh` (unchanged command), `receive.sha256`, `dist/Receive` | the `send` mode; new pin |
| `wifi-floppy/firmware/src/amiga_send.h/.c`, `test/test_amiga_send.c` | protocol 2, PUT arbitration, the raw window, the upload phases |
| `wifi-floppy/firmware/src/amiga_tcp.c`, `pnet_bridge.c`, `pnet_lwip_hooks.h`, `main.c`, `CMakeLists.txt`, `test/run.sh` | raw bytes into PSRAM, the out-of-order limit, the frame cap, wiring, 1.19.0 |
| `wifi-floppy/firmware/src/device_client.h/.c`, `test/test_device_client.c`, `test/transport_fake.c` | two-part POST, upload calls, `upKey` |
| `src/db/schema/devices.ts`, `src/db/index.ts` | `upKey`; the new schema module |
| `src/app/api/device/status/route.ts`, `src/lib/mount.ts` | `upKey` stored |
| `src/app/api/cron/transfers/route.ts` (+ test), `src/lib/blob-gc-run.ts` (+ test), `src/lib/admin-delete.ts`, `src/lib/ingest-complete.ts` | housekeeping, GC reference, org deletion, refused-bytes release |
| `src/lib/firmware-manifest.ts` (+ test) | the increment 0 build's marker is bench-only |
| `src/app/(app)/ingest/page.tsx`, `src/app/(app)/devices/page.tsx`, `src/components/devices/device-card.tsx`, `device-list.tsx` | the card on the Upload page; the device card's line |
| `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts` | the `from-amiga` topic |
| `tools/paulanet-disk/ReadMe`, `paulanet-disk.sha256`, `src/lib/paulanet-disk.ts` (+ test), `scripts/docker-smoke.sh` | Receive 2 on the driver disk; the upload smoke |
| `HANDOFF.md` | section 3cc |

---

## Increment 0: measure first (TEST build, no product code)

### Task 1: Worktree, baselines, and the A2B measurement TEST build

The deliverable is a TEST firmware with a debug discard service, the Amiga bench sender on an ADF, and a written
bench procedure (**Bench B0** at the end of this plan). **A human runs the bench**: the operator powers the A500 and
types; this task only builds, publishes and installs. Every later number marked "from Task 1" has a default that is
used until B0 has run.

**Files:**
- Create: `wifi-floppy/firmware/src/a2b_discard.c`, `wifi-floppy/firmware/src/a2b_discard.h`
- Create: `tools/a2b-bench/a2bsend.c`, `tools/a2b-bench/build.sh`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (after the `WF_PNET_L2` block, line ~127), `wifi-floppy/firmware/src/pnet_bridge.c:97`,
  `wifi-floppy/firmware/src/main.c` (after `pnet_bridge_start();` line ~1847, and core1's loop beside `as_tick(&g_send);` line ~2422),
  `wifi-floppy/firmware/test/run.sh` (the exclusion regex)
- Modify: `src/lib/firmware-manifest.ts`, `src/lib/firmware-manifest.test.ts`, `src/lib/firmware-verify.test.ts:105`

**Interfaces:**
- Consumes: nothing.
- Produces: branch `feat/amiga-upload` in worktree `.claude/worktrees/upload`; `wifi-floppy/firmware/build/size-before-upload.txt`
  (the `.bss` baseline, 432,532); CMake option `WF_A2B_DISCARD` (OFF); `a2b_discard_start(void)`,
  `a2b_discard_stats(a2b_stats_t *)`; the image marker `wf-a2b-discard-test` (refused unless notes start `TEST build`);
  a TEST firmware row; `A2BBench.adf`.

- [ ] **Step 1: Create the worktree.** From `/Users/sfs/Devel/webadf`:

```bash
git status --short          # expect only untracked .fw-notes.mts .fw-target.mts .hd-mount.mts .lz4-bench.mts .nfcck.mts docs/*.pdf docs/schematic/
git worktree add .claude/worktrees/upload -b feat/amiga-upload master
cd .claude/worktrees/upload
pnpm install --offline
cp ../../../.env.local .env.local
pnpm exec next typegen
ln -s ../../../adf-archive adf-archive
```

Expected: `Preparing worktree (new branch 'feat/amiga-upload')`; install and typegen finish without errors. Every later
command runs from `/Users/sfs/Devel/webadf/.claude/worktrees/upload` unless a step says otherwise.

- [ ] **Step 2: Record the `.bss` baseline.**

```bash
pnpm firmware:build
arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | awk '$1==".bss"{print $2}' | tee wifi-floppy/firmware/build/size-before-upload.txt
```

Expected: `432532`. Any other number: stop and tell the operator (the spec's budget is measured against 1.18.2).

- [ ] **Step 3: Write the failing marker test.** In `src/lib/firmware-manifest.test.ts`, after the test
`'refuses a PaulaNET loopback build unless the notes say TEST build'`, add:

```ts
  it('refuses the increment 0 discard build unless the notes say TEST build (plan 2026-10-19 Task 1)', () => {
    const a2b = Buffer.from('xx wf-a2b-discard-test xx');
    expect(refuseReleaseImage(realInfo, 533624, a2b)).toMatch(/discard/);
    expect(refuseReleaseImage(realInfo, 533624, a2b, 'a release')).toMatch(/discard/);
    expect(refuseReleaseImage(realInfo, 533624, a2b, 'TEST build -- A2B measurement')).toBeNull();
  });
```

In `src/lib/firmware-verify.test.ts:105`, the marker list becomes
`[['wf-df1-default-on', /DF1/], ['wf-pnet-loop-test', /PaulaNET loopback/], ['wf-a2b-discard-test', /discard/], ['fwdbg', /WF_FW_DEBUG/]]`.

Run: `pnpm vitest run src/lib/firmware-manifest.test.ts src/lib/firmware-verify.test.ts`
Expected: FAIL (the new marker is accepted).

- [ ] **Step 4: Refuse the marker.** In `src/lib/firmware-manifest.ts` `refuseImageMarkers`, before `return null;`:

```ts
  // The increment 0 measurement build (WF_A2B_DISCARD, plan 2026-10-19 Task 1): a discard service on TCP 6801 and
  // full-size frames from the Amiga. Bench only, like the loopback build.
  if (bytes.includes(Buffer.from('wf-a2b-discard-test', 'ascii')) && !(notes ?? '').startsWith('TEST build')) {
    return 'image is the A2B discard measurement build (WF_A2B_DISCARD); publish it only as a bench build, with --notes starting "TEST build"';
  }
```

Run: `pnpm vitest run src/lib/firmware-manifest.test.ts src/lib/firmware-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: The discard service.** Create `wifi-floppy/firmware/src/a2b_discard.h`:

```c
#ifndef A2B_DISCARD_H
#define A2B_DISCARD_H
// Increment 0 of plan 2026-10-19 (spec 2026-10-18 §10 step 0), WF_A2B_DISCARD TEST builds only: a TCP discard service
// the Amiga copies a file to, so the Amiga -> board bulk rate and the lwIP heap with full-size frames are measured
// before any upload code exists. Device-only (lwIP); test/run.sh excludes it.
#include <stdbool.h>
#include <stdint.h>

#define A2B_DISCARD_PORT 6801

typedef struct {
    uint32_t bytes;      // this connection's bytes so far
    uint32_t ms;         // from its first byte to its last
    uint32_t ooseq_max;  // the deepest out-of-order queue seen on it, bytes
    uint32_t conns;      // connections accepted since boot
    uint32_t mem_max;    // lwIP heap (MEM_SIZE 16 KB): the most ever in use
    uint32_t mem_err;    // ...and allocations it refused
    bool open;
} a2b_stats_t;

void a2b_discard_start(void);             // core1, after pnet_bridge_start()
void a2b_discard_stats(a2b_stats_t *out); // core1, any time (takes the lwIP lock)
#endif
```

Create `wifi-floppy/firmware/src/a2b_discard.c`:

```c
// See a2b_discard.h. Every pbuf is freed in the receive callback with tcp_recved at once (spec U9): the frame's lwIP
// heap is released before the next frame is input, which is the property increment 0 measures.
#include "a2b_discard.h"
#include "net_radio.h"
#include "wf_log.h"
#include "pico/time.h"
#include "lwip/tcp.h"
#include "lwip/priv/tcp_priv.h"   // struct tcp_seg: the out-of-order queue is walked to measure it
#include "lwip/stats.h"

// The image marker: scripts/firmware-release.ts (src/lib/firmware-manifest.ts) refuses an image carrying it unless
// the notes start "TEST build". Read by the start log line, which keeps it in the image.
const char wf_a2b_discard_marker[] = "wf-a2b-discard-test";

static struct { struct tcp_pcb *listen, *conn; uint32_t bytes, t0_ms, t_last_ms, ooseq_max, conns; } D;

static uint32_t ooseq_bytes(const struct tcp_pcb *pcb) {
    uint32_t n = 0;
#if TCP_QUEUE_OOSEQ
    for (const struct tcp_seg *s = pcb->ooseq; s; s = s->next) n += s->p->tot_len;
#endif
    return n;
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    (void)arg; (void)err;
    if (!p) {                                   // the Amiga closed: the totals stay for the log
        tcp_recv(pcb, NULL); tcp_err(pcb, NULL);
        if (tcp_close(pcb) != ERR_OK) tcp_abort(pcb);
        D.conn = NULL;
        return ERR_OK;
    }
    const uint32_t now = to_ms_since_boot(get_absolute_time());
    if (D.bytes == 0) D.t0_ms = now;
    D.bytes += p->tot_len;
    D.t_last_ms = now;
    const uint32_t oo = ooseq_bytes(pcb);
    if (oo > D.ooseq_max) D.ooseq_max = oo;
    tcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static void on_err(void *arg, err_t err) { (void)arg; (void)err; D.conn = NULL; }   // lwIP freed the pcb

static err_t on_accept(void *arg, struct tcp_pcb *pcb, err_t err) {
    (void)arg;
    if (err != ERR_OK || !pcb) return ERR_VAL;
    if (D.conn) { tcp_abort(pcb); return ERR_ABRT; }   // one copy at a time
    D.conn = pcb;
    D.bytes = 0; D.ooseq_max = 0; D.conns++;
    tcp_recv(pcb, on_recv);
    tcp_err(pcb, on_err);
    return ERR_OK;
}

void a2b_discard_start(void) {
    net_radio_lock();
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    if (pcb && tcp_bind(pcb, IP_ANY_TYPE, A2B_DISCARD_PORT) == ERR_OK) {
        D.listen = tcp_listen(pcb);
        if (D.listen) tcp_accept(D.listen, on_accept);
    } else if (pcb) {
        tcp_close(pcb);
    }
    net_radio_unlock();
    if (D.listen) wf_logf(WF_WARN, "a2b: %s -- discard service on port %u", wf_a2b_discard_marker, A2B_DISCARD_PORT);
    else wf_logf(WF_ERR, "a2b: no discard service on port %u", A2B_DISCARD_PORT);
}

void a2b_discard_stats(a2b_stats_t *o) {
    net_radio_lock();
    o->bytes = D.bytes;
    o->ms = D.t_last_ms - D.t0_ms;
    o->ooseq_max = D.ooseq_max;
    o->conns = D.conns;
    o->open = D.conn != NULL;
#if MEM_STATS
    o->mem_max = (uint32_t)lwip_stats.mem.max;
    o->mem_err = (uint32_t)lwip_stats.mem.err;
#else
    o->mem_max = 0; o->mem_err = 0;
#endif
    net_radio_unlock();
}
```

- [ ] **Step 6: Wire it, only when `WF_A2B_DISCARD` is on.** In `wifi-floppy/firmware/CMakeLists.txt`, after the
`endif ()` that closes `if (WF_PNET_L2)`:

```cmake
# Increment 0 of plan 2026-10-19 (spec 2026-10-18 §10 step 0): a TCP discard service on 6801 and full-size frames from
# the Amiga, to measure the A2B rate and the lwIP heap before uploads exist. TEST builds only (image marker).
option(WF_A2B_DISCARD "Bench-only: a TCP discard service on 6801 and full-size Amiga frames (plan 2026-10-19 Task 1)" OFF)
list(APPEND WFMF_COMMON_DEFS WF_A2B_DISCARD=$<IF:$<BOOL:${WF_A2B_DISCARD}>,1,0>)
if (WF_A2B_DISCARD)
  if (NOT WF_PNET_L2)
    message(FATAL_ERROR "WF_A2B_DISCARD needs WF_PNET_L2: the Amiga reaches the board over the local path")
  endif ()
  list(APPEND WFMF_FIRMWARE_SOURCES src/a2b_discard.c)
  message(WARNING "WF_A2B_DISCARD is ON: a TEST build. Publish it only with --notes starting \"TEST build\".")
endif ()
```

In `wifi-floppy/firmware/src/pnet_bridge.c` replace `#define PNET_LOCAL_A2B_MAX 768u` with:

```c
#if WF_A2B_DISCARD
#define PNET_LOCAL_A2B_MAX PNET_RING_MTU   // increment 0 (plan 2026-10-19 Task 1): full frames, measured first (spec U9)
#else
#define PNET_LOCAL_A2B_MAX 768u
#endif
```

In `wifi-floppy/firmware/src/main.c`, near the other PaulaNET includes at the top (beside `#include "amiga_tcp.h"`):

```c
#if WF_A2B_DISCARD
#include "a2b_discard.h"     // increment 0 of plan 2026-10-19: TEST builds only
#endif
```

After `pnet_bridge_start();          // the input hook and the send worker (plan 2026-10-11)`:

```c
#if WF_A2B_DISCARD
    a2b_discard_start();          // increment 0 (plan 2026-10-19 Task 1): the bench copies to <board>:6801
#endif
```

In core1's loop, directly after `dc_set_send(&c, as_acked_version(&g_send), as_rx(&g_send));`:

```c
#if WF_A2B_DISCARD
            {   // Increment 0: one line every 2 s while a copy runs, and the totals once it ends.
                static uint32_t a2b_log_ms, a2b_logged;
                if (clock_ms() - a2b_log_ms >= 2000u) {
                    a2b_log_ms = clock_ms();
                    a2b_stats_t a;
                    a2b_discard_stats(&a);
                    if (a.bytes != a2b_logged || a.open) {
                        a2b_logged = a.bytes;
                        wf_logf(WF_INFO, "a2b: %lu B in %lu ms = %lu B/s ooseq max %lu mem max %lu err %lu conns %lu%s",
                                (unsigned long)a.bytes, (unsigned long)a.ms,
                                (unsigned long)(a.ms ? (uint32_t)((uint64_t)a.bytes * 1000u / a.ms) : 0u),
                                (unsigned long)a.ooseq_max, (unsigned long)a.mem_max, (unsigned long)a.mem_err,
                                (unsigned long)a.conns, a.open ? "" : " (closed)");
                    }
                }
            }
#endif
```

In `wifi-floppy/firmware/test/run.sh`, add `|a2b_discard\.c` to the `grep -vE` list (after `boot_trail_hw\.c`), and to
the comment block above it: `#   a2b_discard.c     - increment 0's lwIP discard service (TEST builds); it decides nothing`.

- [ ] **Step 7: The host tests and the release build are unchanged.**

```bash
wifi-floppy/firmware/test/run.sh 2>&1 | tail -3
pnpm firmware:build
arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | awk '$1==".bss"{print $2}'
```

Expected: no `FAIL`/`CRASHED`; `.bss` prints `432532` (the option is OFF).

- [ ] **Step 8: The bench sender.** Create `tools/a2b-bench/a2bsend.c`:

```c
/* a2bsend: the Amiga side of plan 2026-10-19 Task 1 (spec 2026-10-18 §10 step 0). Sends BYTES of a pattern (default
   1 MB), or a FILE, to HOST:PORT over bsdsocket and prints the time. Kickstart 2.04+, 68000. Bench only.
   Template: HOST/A,PORT/N/A,BYTES/N,FILE/K */
#include <string.h>
#include <exec/types.h>
#include <dos/dos.h>
#include <dos/dosextens.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/socket.h>
#include <sys/socket.h>
#include <netinet/in.h>

struct Library *SocketBase;
static unsigned char buf[8192];
static const char version[] = "$VER: a2bsend 1.0 (19.10.2026) webadf bench";

/* Ticks (1/50 s) since 1978: a run lasts minutes, so this never wraps in one. */
static ULONG ticks(void) {
    struct DateStamp d;
    DateStamp(&d);
    return ((ULONG)d.ds_Days * 1440UL + (ULONG)d.ds_Minute) * 3000UL + (ULONG)d.ds_Tick;
}

int main(void) {
    LONG args[4] = { 0, 0, 0, 0 }, out[4], rc = RETURN_FAIL, s = -1;
    struct RDArgs *rd;
    struct sockaddr_in a;
    BPTR fh = 0;
    ULONG total, sent = 0, t0, dt, i;
    (void)version;
    rd = ReadArgs((STRPTR)"HOST/A,PORT/N/A,BYTES/N,FILE/K", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"a2bsend"); return RETURN_FAIL; }
    total = args[2] ? *(ULONG *)args[2] : 1048576UL;
    if (args[3]) {
        struct FileInfoBlock *fib = AllocDosObject(DOS_FIB, NULL);
        fh = Open((STRPTR)args[3], MODE_OLDFILE);
        if (fib && fh && ExamineFH(fh, fib)) total = (ULONG)fib->fib_Size;
        else { PutStr((STRPTR)"a2bsend: cannot read FILE\n"); if (fib) FreeDosObject(DOS_FIB, fib); goto out; }
        FreeDosObject(DOS_FIB, fib);
    }
    for (i = 0; i < sizeof buf; i++) buf[i] = (unsigned char)(i * 31 + 7);
    SocketBase = OpenLibrary((STRPTR)"bsdsocket.library", 3);
    if (!SocketBase) { PutStr((STRPTR)"a2bsend: no TCP/IP stack running (bsdsocket.library)\n"); goto out; }
    s = socket(AF_INET, SOCK_STREAM, 0);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((UWORD)*(LONG *)args[1]);
    a.sin_addr.s_addr = inet_addr((STRPTR)args[0]);
    if (s < 0 || connect(s, (struct sockaddr *)&a, sizeof a) != 0) { PutStr((STRPTR)"a2bsend: cannot connect\n"); goto out; }
    t0 = ticks();
    while (sent < total) {
        LONG n = total - sent > sizeof buf ? (LONG)sizeof buf : (LONG)(total - sent), k = 0;
        if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { PutStr((STRPTR)"a2bsend: stopped\n"); break; }
        if (fh && Read(fh, buf, n) != n) { PutStr((STRPTR)"a2bsend: read failed\n"); break; }
        while (k < n) { LONG w = send(s, buf + k, n - k, 0); if (w <= 0) break; k += w; }
        if (k < n) { PutStr((STRPTR)"a2bsend: send failed\n"); break; }
        sent += (ULONG)n;
    }
    dt = ticks() - t0;
    if (dt == 0) dt = 1;
    out[0] = (LONG)sent; out[1] = (LONG)(dt / 50); out[2] = (LONG)((dt % 50) * 2); out[3] = (LONG)(sent * 50UL / dt);
    VPrintf((STRPTR)"a2bsend: %lu bytes in %lu.%02lu s = %lu B/s\n", out);
    rc = sent == total ? RETURN_OK : RETURN_WARN;
out:
    if (s >= 0) CloseSocket(s);
    if (SocketBase) CloseLibrary(SocketBase);
    if (fh) Close(fh);
    FreeArgs(rd);
    return rc;
}
```

Create `tools/a2b-bench/build.sh` (mode 755):

```bash
#!/usr/bin/env bash
# Builds the increment 0 bench sender (plan 2026-10-19 Task 1) with Receive's pinned amiga-gcc image, and an OFS disk,
# A2BBench.adf, holding it. Bench only, never on a user's disk. Usage: tools/a2b-bench/build.sh <out folder>
# Needs Docker and xdftool (amitools).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; out="$1"; mkdir -p "$out"; out="$(cd "$out" && pwd)"
img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
docker run --rm --platform linux/amd64 -v "$here:/src:ro" -v "$out:/o" -w /src "$img" \
  m68k-amigaos-gcc -m68000 -Os -noixemul -s -Wall -Werror -o /o/a2bsend a2bsend.c
rm -f "$out/A2BBench.adf"
xdftool "$out/A2BBench.adf" create + format A2BBench ofs + write "$out/a2bsend" a2bsend + protect a2bsend rwed
xdftool "$out/A2BBench.adf" list
```

Run: `chmod +x tools/a2b-bench/build.sh && tools/a2b-bench/build.sh /tmp/a2b`
Expected: the compile prints nothing; the listing shows `a2bsend` with protection `----rwed`.

- [ ] **Step 9: Commit.**

```bash
git status --short
git add wifi-floppy/firmware/src/a2b_discard.c wifi-floppy/firmware/src/a2b_discard.h wifi-floppy/firmware/CMakeLists.txt \
        wifi-floppy/firmware/src/pnet_bridge.c wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/run.sh \
        tools/a2b-bench/a2bsend.c tools/a2b-bench/build.sh src/lib/firmware-manifest.ts src/lib/firmware-manifest.test.ts \
        src/lib/firmware-verify.test.ts
git commit -m "upload increment 0: the A2B discard service (WF_A2B_DISCARD, TEST builds only) and the bench sender

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

- [ ] **Step 10: Build and publish the measurement TEST build.** `firmware:publish` reads `wifi-floppy/firmware/build`,
so that folder is configured with the option for this one publish, then put back:

```bash
(cd wifi-floppy/firmware && cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_A2B_DISCARD=ON && cmake --build build)
strings wifi-floppy/firmware/build/wifi_floppy.bin | grep -c wf-a2b-discard-test
arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | awk '$1==".bss"{print $2}'
pnpm firmware:publish --no-github --notes "TEST build -- A2B measurement (plan 2026-10-19 Task 1), bench only"
(cd wifi-floppy/firmware && cmake -B build -DWF_A2B_DISCARD=OFF && cmake --build build)
```

Expected: the marker count is `1`; `.bss` within a few dozen bytes of 432,532 (record the number); the publish prints
`1.18.2+g<sha>` and its sequence. CMake caches options, so the last line is what puts the release configuration back.

- [ ] **Step 11: Read the notes back.** From `/Users/sfs/Devel/webadf`: `pnpm exec dotenv -e .env.local -- tsx .fw-notes.mts`
Expected: `{"seq":<n>,"version":"1.18.2+g<sha>","notes":"TEST build -- A2B measurement ..."}` and exit 0. Exit 1 means
every org is offered it: fix the notes in the DB at once and say so.

- [ ] **Step 12: Install it on the bench board.** Start the serial log first (the reader is
`/private/tmp/claude-501/-Users-sfs-Devel-webadf/675c185f-947c-4752-b904-7630c037fa06/scratchpad/serstream.py`; if it is
gone, the LZ4 plan's Task 7 Step 5 has its 12 lines): `pgrep -fl serstream.py` must print nothing, then
`python3 <that path> 14400 <scratchpad>/serial-a2b.log` in the background. The install ejects the disk: if the Amiga
is in use, ask the operator to switch it off and end the turn; if it is idle, Ctrl+Alt+Del it through the PiKVM. Then
from `/Users/sfs/Devel/webadf`: `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts 1.18.2+g<sha>`
Expected: within ~90 s the log shows the version confirmed and `a2b: wf-a2b-discard-test -- discard service on port 6801`.

- [ ] **Step 13: Hand the bench to the operator.** Upload `/tmp/a2b/A2BBench.adf` to the operator's library only if
they say yes (it writes production); otherwise send them the file. Post Bench B0 (end of this plan) as the turn's last
message and end the turn. Record the operator's numbers, then **apply the decision rules of Task 11 Step 1** and
write the two values (and the raw measurements) into the ledger and HANDOFF. Then reinstall the latest released
firmware (1.18.2) the same way as Step 12.

---

## Increment 1: Receive 2 and the protocol

### Task 2: Receive core: the protocol 2 hello, trust on first use, the upload queue and the drawer walk

**Files:**
- Modify: `tools/receive/core/rx_proto.h` (replaced whole), `tools/receive/core/rx_proto.c`
- Modify: `tools/receive/test/fakefs.h`, `tools/receive/test/test_proto.c`

**Interfaces:**
- Consumes: `rx_path_ok`, `rx_utoa` (rx_names.h); the session's `tok`, `num`, `lenstr`, `puts_` (rx_proto.c statics).
- Produces (all in `rx_proto.h`): `RX_KEY_HEX` 32, `RX_UP_MAX` 64, `RX_LOCAL_MAX` 255, `RX_UP_BLOCK` 8192,
  `RX_UP_IDLE_SECS` 180, `RX_TREE_DEPTH` 16; `rx_finfo`; `rx_list_fn`; `rx_fs` gains `is_dir`, `list`, `open_r`,
  `read`, `close_r`; events `RX_EV_TRUST`, `RX_EV_UP_BEGIN`, `RX_EV_UP_PROGRESS`, `RX_EV_UP_DONE`, `RX_EV_UP_FAILED`;
  `rx_event` gains `unsigned tag; const char *code; const char *key;`; `rx_up_item`; `rx_upq`; `RX_TRUST_*`;
  `RX_UP_*` phases; `void rx_upq_init(rx_upq *q, const char *trusted)`;
  `unsigned rx_up_add(rx_upq *q, const char *local, const char *name)` (tag 1..999,999,999, or 0);
  `int rx_upq_remove(rx_upq *q, unsigned tag)`; `typedef void (*rx_added_fn)(void *u, const rx_up_item *it)`;
  `int rx_up_add_tree(rx_upq *q, const rx_fs *fs, const char *local, const char *name, rx_added_fn added, void *u)`
  (files added, or -1); `void rx_attach(rx_session *s, rx_upq *q)`; `int rx_uploads_on(const rx_session *s)`;
  `int rx_trust_now(rx_session *s)`; `void rx_key4(const char *key, char out[5])`.

- [ ] **Step 1: The fake file system gets a read side.** In `tools/receive/test/fakefs.h`: `#define FF_MAX 32` becomes
`#define FF_MAX 80`; the `fakefs` struct gains, after `int fail_make_dir;`:

```c
    /* protocol 2: the file being read (an entry named by its local path) */
    int read_idx; unsigned long read_pos, bytes_read; long fail_read_at; /* -1 never */
    int opens_r, closes_r; unsigned long days, mins, ticks;
```

and add before `ff_init`:

```c
static int ff_put(fakefs *f, const char *name, const void *data, unsigned long len, unsigned long prot, const char *comment) {
    int i = ff_add(f, name, 0);
    memcpy(f->e[i].data, data, len); f->e[i].len = len; f->e[i].prot = prot;
    snprintf(f->e[i].comment, sizeof f->e[i].comment, "%s", comment);
    return i;
}
static int ff_is_dir(void *c, const char *local) { int i = ff_find(c, local); return i < 0 ? -1 : ((fakefs *)c)->e[i].is_dir; }
/* The children of a drawer: "DH0:D/x" under "DH0:D", and "RAM:x" under the volume root "RAM:". */
static int ff_list(void *c, const char *local, rx_list_fn each, void *u) {
    fakefs *f = c; size_t n = strlen(local); int i = ff_find(f, local);
    int root = n > 0 && local[n - 1] == ':';
    if (i < 0 || !f->e[i].is_dir) return -1;
    for (int k = 0; k < f->n; k++) {
        const char *nm = f->e[k].name;
        if (strncmp(nm, local, n) != 0 || !nm[n]) continue;
        const char *rest = root ? nm + n : (nm[n] == '/' ? nm + n + 1 : NULL);
        if (rest && rest[0] && !strchr(rest, '/')) each(u, rest, f->e[k].is_dir);
    }
    return 0;
}
static int ff_open_r(void *c, const char *local, rx_finfo *info) {
    fakefs *f = c; int i = ff_find(f, local);
    if (i < 0 || f->e[i].is_dir) return -1;
    f->read_idx = i; f->read_pos = 0; f->opens_r++;
    info->size = f->e[i].len; info->prot = f->e[i].prot; snprintf(info->comment, sizeof info->comment, "%s", f->e[i].comment);
    info->days = f->days; info->mins = f->mins; info->ticks = f->ticks;
    return 0;
}
static long ff_read(void *c, unsigned char *b, unsigned long n) {
    fakefs *f = c; ff_entry *e = &f->e[f->read_idx];
    if (f->fail_read_at >= 0 && (long)(f->read_pos + n) > f->fail_read_at) return -1;
    if (n > e->len - f->read_pos) n = e->len - f->read_pos;
    memcpy(b, e->data + f->read_pos, n); f->read_pos += n; f->bytes_read += n;
    return (long)n;
}
static void ff_close_r(void *c) { fakefs *f = c; f->read_idx = -1; f->closes_r++; }
```

In `ff_init`, after `f->open_idx = -1;` add `f->read_idx = -1; f->fail_read_at = -1;`, and after
`fs->set_meta = ff_set_meta;` add
`fs->is_dir = ff_is_dir; fs->list = ff_list; fs->open_r = ff_open_r; fs->read = ff_read; fs->close_r = ff_close_r;`.
Add `#include <stdio.h>` at the top of `fakefs.h`.

- [ ] **Step 2: Write the failing tests.** In `tools/receive/test/test_proto.c`, the event recorder copies what it is
handed (event strings may live on the core's stack). Replace `static rx_event last_ev[64]; ...` through the end of
`on_ev` with:

```c
static rx_event last_ev[64]; static int n_ev; static char ev_text[64][300], ev_code[64][20], ev_key[64][40], ev_path[64][300];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    if (n_ev >= 64) return;
    last_ev[n_ev] = *e;
    snprintf(ev_text[n_ev], 300, "%s", e->kind == RX_EV_DONE || e->kind == RX_EV_FAILED ? (e->path ? e->path : "") : "");
    snprintf(ev_code[n_ev], 20, "%s", e->code ? e->code : "");
    snprintf(ev_key[n_ev], 40, "%s", e->key ? e->key : "");
    snprintf(ev_path[n_ev], 300, "%s|%s", e->path ? e->path : "", e->text ? e->text : "");
    last_ev[n_ev].text = NULL; last_ev[n_ev].code = NULL; last_ev[n_ev].key = NULL; last_ev[n_ev].path = NULL;
    n_ev++;
}
```

Existing checks that read `last_ev[i].text` (in `disconnect_mid_file` and `refusals_are_events`) change to read
`ev_path[i]` after its `|`: replace `strcmp(last_ev[n_ev - 1].text, "connection lost") == 0` with
`strstr(ev_path[n_ev - 1], "|connection lost") != NULL`, `last_ev[0].text && strcmp(last_ev[0].text, "folder not found") == 0`
with `strstr(ev_path[0], "|folder not found") != NULL`, and
`last_ev[0].text && strcmp(last_ev[0].text, "not enough space") == 0` with `strstr(ev_path[0], "|not enough space") != NULL`.

Then add, before `int main(void)`:

```c
/* --- protocol 2 (spec 2026-10-18 §3, §6) --- */
static rx_upq Q;
static const char *KEY = "0123456789abcdef0123456789abcdef";
static const char *KEY2 = "fedcba9876543210fedcba9876543210";
static void setup2(const char *trusted) { setup(); rx_upq_init(&Q, trusted); rx_attach(&S, &Q); }
static int last_kind(int k) { for (int i = n_ev - 1; i >= 0; i--) if (last_ev[i].kind == k) return i; return -1; }
static void hello2(const char *key) { char l[80]; snprintf(l, sizeof l, "WEBADF 2 %s\n", key); feed(l); }
static const char *trust_code(void) { int i = last_kind(RX_EV_TRUST); return i < 0 ? "" : ev_code[i]; }
static unsigned added_n; static char added_names[80][300];
static void on_added(void *u, const rx_up_item *it) { (void)u; snprintf(added_names[added_n++ % 80], 300, "%s=%s", it->name, it->local); }

static void v2_hello_answers_ready_2_and_trusts_the_first_key(void) {
    setup2("");
    hello2(KEY);
    CHECK(strcmp(out(), "READY 2\n") == 0, "READY 2");
    CHECK(strcmp(trust_code(), "new") == 0, "a new key");
    CHECK(strcmp(ev_key[last_kind(RX_EV_TRUST)], KEY) == 0, "the key in the event");
    CHECK(strcmp(Q.trusted, KEY) == 0, "saved");
    CHECK(rx_uploads_on(&S), "uploads on");
    CHECK(last_kind(RX_EV_HELLO) >= 0 && last_kind(RX_EV_HELLO) < last_kind(RX_EV_TRUST), "HELLO, then TRUST");
}
static void the_same_key_again_is_ok_and_another_is_refused(void) {
    setup2(KEY); hello2(KEY); out();
    CHECK(strcmp(trust_code(), "ok") == 0, "ok"); CHECK(rx_uploads_on(&S), "on");
    setup2(KEY); hello2(KEY2); out();
    CHECK(strcmp(trust_code(), "other") == 0, "other");
    CHECK(!rx_uploads_on(&S), "uploads off"); CHECK(strcmp(Q.trusted, KEY) == 0, "the saved key is unchanged");
    setup2(KEY); hello2("0123456789ABCDEF0123456789ABCDEF"); out();
    CHECK(strcmp(trust_code(), "ok") == 0, "upper-case hex is the same key");
}
static void a_malformed_key_is_never_saved(void) {
    setup2(""); feed("WEBADF 2 xyz\n");
    CHECK(strcmp(out(), "READY 2\n") == 0, "still READY 2: downloads keep working");
    CHECK(strcmp(trust_code(), "other") == 0, "not trusted"); CHECK(Q.trusted[0] == 0, "nothing saved");
    setup2(""); feed("WEBADF 2\n"); out();
    CHECK(strcmp(trust_code(), "other") == 0, "no key at all");
}
static void a_protocol_1_board_is_old_and_uploads_stay_off(void) {
    setup2(""); feed("WEBADF 1\n");
    CHECK(strcmp(out(), "READY 1\n") == 0, "READY 1");
    CHECK(strcmp(trust_code(), "old") == 0, "old"); CHECK(!rx_uploads_on(&S), "off"); CHECK(Q.trusted[0] == 0, "nothing saved");
    setup(); feed("WEBADF 2 "); feed(KEY); feed("\n");
    CHECK(strcmp(out(), "READY 2\n") == 0, "no queue attached: READY 2, no trust event");
    CHECK_EQ_INT(last_kind(RX_EV_TRUST), -1);
}
static void trust_now_and_trust_next_replace_the_saved_key(void) {
    char k4[5];
    setup2(KEY); hello2(KEY2); out();
    CHECK_EQ_INT(rx_trust_now(&S), 0);
    CHECK(strcmp(Q.trusted, KEY2) == 0, "replaced"); CHECK(rx_uploads_on(&S), "on"); CHECK(strcmp(trust_code(), "new") == 0, "saved again");
    setup2(KEY); CHECK_EQ_INT(rx_trust_now(&S), -1);   /* no board yet */
    Q.trust_next = 1; hello2(KEY2); out();
    CHECK(strcmp(Q.trusted, KEY2) == 0, "the next board's key"); CHECK_EQ_INT(Q.trust_next, 0);
    rx_key4(KEY2, k4); CHECK(strcmp(k4, "FEDC") == 0, "four digits, upper case");
}
static void the_queue_takes_64_good_names(void) {
    char nm[20];
    rx_upq_init(&Q, "");
    for (int i = 0; i < RX_UP_MAX; i++) { snprintf(nm, sizeof nm, "F%d", i); CHECK_EQ_INT(rx_up_add(&Q, "DH0:f", nm), i + 1); }
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:f", "one-more"), 0);
    CHECK_EQ_INT(rx_upq_remove(&Q, 3), 1); CHECK_EQ_INT(Q.n, RX_UP_MAX - 1); CHECK_EQ_INT(rx_upq_remove(&Q, 3), 0);
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:x", "../x"), 0); CHECK_EQ_INT(rx_up_add(&Q, "DH0:x", "a:b"), 0);
    CHECK_EQ_INT(rx_up_add(&Q, "", "x"), 0);
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:x", "x"), RX_UP_MAX + 1);   /* tags keep counting */
}
static void a_dropped_drawer_is_walked_and_icons_skipped(void) {
    setup2(""); added_n = 0;
    ff_add(&F, "DH0:Mods", 1); ff_add(&F, "DH0:Mods/sub", 1);
    ff_put(&F, "DH0:Mods/a.mod", "a", 1, 0, ""); ff_put(&F, "DH0:Mods/a.mod.info", "i", 1, 0, "");
    ff_put(&F, "DH0:Mods/sub/b.mod", "b", 1, 0, "");
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "DH0:Mods", "Mods", on_added, NULL), 2);
    CHECK_EQ_INT(Q.n, 2);
    CHECK((strcmp(added_names[0], "Mods/a.mod=DH0:Mods/a.mod") == 0 && strcmp(added_names[1], "Mods/sub/b.mod=DH0:Mods/sub/b.mod") == 0) ||
          (strcmp(added_names[1], "Mods/a.mod=DH0:Mods/a.mod") == 0 && strcmp(added_names[0], "Mods/sub/b.mod=DH0:Mods/sub/b.mod") == 0),
          "both files, with their sub-paths; the icon file skipped");
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "DH0:Mods/a.mod.info", "a.mod.info", NULL, NULL), 1);   /* an icon dropped itself goes */
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "DH0:Nothing", "Nothing", NULL, NULL), -1);
}
static void a_volume_root_joins_without_a_slash_and_a_walk_stops_at_64(void) {
    char nm[40];
    setup2(""); ff_add(&F, "RAM:", 1);
    for (int i = 0; i < 70; i++) { snprintf(nm, sizeof nm, "RAM:f%02d", i); ff_put(&F, nm, "x", 1, 0, ""); }
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "RAM:", "Ram Disk", NULL, NULL), RX_UP_MAX);
    CHECK(strncmp(Q.q[0].local, "RAM:f", 5) == 0 && strncmp(Q.q[0].name, "Ram Disk/f", 10) == 0, "RAM:fNN, Ram Disk/fNN");
}
```

And in `main`, before `return REPORT();`:

```c
    RUN(v2_hello_answers_ready_2_and_trusts_the_first_key); RUN(the_same_key_again_is_ok_and_another_is_refused);
    RUN(a_malformed_key_is_never_saved); RUN(a_protocol_1_board_is_old_and_uploads_stay_off);
    RUN(trust_now_and_trust_next_replace_the_saved_key); RUN(the_queue_takes_64_good_names);
    RUN(a_dropped_drawer_is_walked_and_icons_skipped); RUN(a_volume_root_joins_without_a_slash_and_a_walk_stops_at_64);
```

Run: `tools/receive/test/run.sh`
Expected: COMPILE errors (`rx_upq` unknown, `rx_fs` has no member `is_dir`).

- [ ] **Step 3: The header.** Replace `tools/receive/core/rx_proto.h` with:

```c
#ifndef RX_PROTO_H
#define RX_PROTO_H
#include "rx_names.h"

#define RX_PORT 6800
#define RX_ID_MAX 40
#define RX_LIST_MAX 32
#define RX_LINE_MAX 640
#define RX_OUT_MAX 1024
#define RX_FILE_MAX 4194304UL
#define RX_COMMENT_MAX 79
#define RX_TMP_NAME ".webadf-rx"
#define RX_IDLE_SECS 75   /* a connection silent this long is dropped: the board pings every 30 s */
/* Protocol 2 (spec 2026-10-18 §3): files go up to the web app over the same connection. */
#define RX_KEY_HEX 32            /* the board key in the hello: 32 hex digits (spec §6) */
#define RX_UP_MAX 64             /* files waiting to go up; a drop adds at most this many (spec §2) */
#define RX_LOCAL_MAX 255         /* an Amiga path to read, such as DH0:Work/foo.lha */
#define RX_UP_BLOCK 8192UL       /* files are read in 8 KB blocks (spec §2) */
#define RX_UP_IDLE_SECS 180      /* the silence allowed while a file goes up: past the board's 120 s give-up (plan P14) */
#define RX_TREE_DEPTH 16         /* drawers inside a dropped drawer, at most */

typedef struct rx_finfo {        /* what Examine says about a file that goes up */
    unsigned long size, prot, days, mins, ticks;
    char comment[RX_COMMENT_MAX + 1];
} rx_finfo;
typedef void (*rx_list_fn)(void *u, const char *name, int is_dir);

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
    /* Protocol 2: files that go up. These paths are the Amiga's own (DH0:x/y), not under the folder. */
    int (*is_dir)(void *ctx, const char *local);                         /* 1 a drawer, 0 a file, -1 neither */
    int (*list)(void *ctx, const char *local, rx_list_fn each, void *u); /* 0: each entry of the drawer */
    int (*open_r)(void *ctx, const char *local, rx_finfo *info);         /* 0: open (shared) for reading, info filled */
    long (*read)(void *ctx, unsigned char *b, unsigned long n);          /* bytes read (< n only at the end), -1 failed */
    void (*close_r)(void *ctx);
} rx_fs;

enum { RX_EV_HELLO, RX_EV_LIST, RX_EV_BEGIN, RX_EV_PROGRESS, RX_EV_DONE, RX_EV_FAILED,
       RX_EV_TRUST,          /* after HELLO, with a queue attached: code "new" (store key now), "ok", "other", "old" */
       RX_EV_UP_BEGIN,       /* the board took the file: bytes = where it resumes */
       RX_EV_UP_PROGRESS,    /* bytes = stored on the web app */
       RX_EV_UP_DONE,        /* path = the name as stored */
       RX_EV_UP_FAILED };    /* text = why; code = the board's NO code, or "local" */
typedef struct rx_event {
    int kind;
    const char *id;       /* BEGIN, PROGRESS, DONE, FAILED */
    const char *path;     /* BEGIN, FAILED: as sent; DONE: as saved; UP_*: the name sent (UP_DONE: as stored) */
    unsigned long size;   /* BEGIN, PROGRESS, DONE, UP_* */
    unsigned long bytes;  /* PROGRESS, UP_BEGIN, UP_PROGRESS */
    const char *text;     /* FAILED, UP_FAILED: the reason, e.g. "checksum mismatch" */
    unsigned tag;         /* UP_*: the item */
    const char *code;     /* TRUST, UP_FAILED */
    const char *key;      /* TRUST: the board's key ("" when it sent none) */
} rx_event;
typedef void (*rx_event_fn)(void *uctx, const rx_event *ev);

typedef struct rx_item { char id[RX_ID_MAX + 1]; unsigned long size; char path[RX_PATH_MAX + 1]; } rx_item;

typedef struct rx_up_item { unsigned tag; char local[RX_LOCAL_MAX + 1]; char name[RX_PATH_MAX + 1]; } rx_up_item;
/* The files waiting to go up, and the trusted board key: the front end's, outliving every connection. */
typedef struct rx_upq {
    rx_up_item q[RX_UP_MAX]; unsigned n, next_tag;
    char trusted[RX_KEY_HEX + 1];   /* "" until the first board: trust on first use */
    int trust_next;                 /* TRUST before the board connected: its key replaces the saved one */
} rx_upq;
enum { RX_TRUST_NONE, RX_TRUST_OK, RX_TRUST_OTHER, RX_TRUST_OLD };
enum { RX_UP_IDLE, RX_UP_ASKED, RX_UP_SKIP, RX_UP_DATA, RX_UP_ENDED };   /* PUT out; CRC over the resumed part; bytes; END out */

typedef struct rx_session { /* fields private to rx_proto.c except list/list_n */
    const rx_fs *fs; rx_event_fn on_event; void *uctx;
    int in_data;
    char line[RX_LINE_MAX + 1]; unsigned line_n;
    rx_item list[RX_LIST_MAX]; unsigned list_n, list_expect, list_seen;
    char cur_id[RX_ID_MAX + 1], cur_path[RX_PATH_MAX + 1], cur_comment[RX_COMMENT_MAX + 1];
    char cur_tmp[RX_PATH_MAX + sizeof RX_TMP_NAME];   /* the path's folder (< 255 bytes) + the temp name */
    unsigned long cur_size, cur_left, cur_crc_want, cur_crc, cur_prot, cur_mark;
    int cur_open, cur_write_failed;
    char out[RX_OUT_MAX]; unsigned out_n;
    /* protocol 2 */
    rx_upq *upq; int peer_v, trust, proto_err; char peer_key[RX_KEY_HEX + 1];
    int up_phase, up_closing, up_cancel; rx_up_item up_cur; rx_finfo up_info;
    unsigned long up_off, up_credit, up_window, up_sent, up_skip, up_crc;
} rx_session;

void rx_init(rx_session *s, const rx_fs *fs, rx_event_fn on_event, void *uctx);
int rx_feed(rx_session *s, const unsigned char *data, unsigned long n); /* 0, or -1: close the connection */
unsigned rx_take_output(rx_session *s, char *dst, unsigned cap);       /* moves pending reply bytes out */
void rx_disconnected(rx_session *s);   /* the peer went away: drop a half-written file */
int rx_busy(const rx_session *s);      /* 1 while a file is being received */

/* Protocol 2 (spec 2026-10-18). */
void rx_upq_init(rx_upq *q, const char *trusted);              /* trusted: ENVARC:webadf/BoardKey, or "" */
unsigned rx_up_add(rx_upq *q, const char *local, const char *name);  /* tag, or 0: full, or a bad name */
int rx_upq_remove(rx_upq *q, unsigned tag);                    /* 1 removed */
typedef void (*rx_added_fn)(void *u, const rx_up_item *it);
/* A file, or a drawer walked (64 files at most, .info files skipped, sub-paths kept); files added, or -1. */
int rx_up_add_tree(rx_upq *q, const rx_fs *fs, const char *local, const char *name, rx_added_fn added, void *u);
void rx_attach(rx_session *s, rx_upq *q);   /* after rx_init: this connection may upload from q */
int rx_uploads_on(const rx_session *s);     /* 1: a protocol 2 board with the trusted key */
int rx_trust_now(rx_session *s);            /* TRUST: the connected board's key becomes the saved one; -1 none */
void rx_key4(const char *key, char out[5]); /* its first 4 digits, upper case, as the window and the web app show */
#endif
```

- [ ] **Step 4: The code.** In `tools/receive/core/rx_proto.c`:

Replace the `emit` function with:

```c
static void emit_full(rx_session *s, int kind, const char *id, const char *path, unsigned long size,
                      unsigned long bytes, const char *text, unsigned tag, const char *code, const char *key) {
    rx_event e;
    if (!s->on_event) return;
    e.kind = kind; e.id = id; e.path = path; e.size = size; e.bytes = bytes; e.text = text;
    e.tag = tag; e.code = code; e.key = key;
    s->on_event(s->uctx, &e);
}
static void emit(rx_session *s, int kind, const char *id, const char *path, unsigned long size,
                 unsigned long bytes, const char *text) {
    emit_full(s, kind, id, path, size, bytes, text, 0, 0, 0);
}
```

After `static int is(...)` add:

```c
/* --- protocol 2: the hello and the board key (spec 2026-10-18 §3, §6) --- */
static int hex_key(const char *t, unsigned n, char *out) {
    unsigned i;
    if (n != RX_KEY_HEX) return 0;
    for (i = 0; i < n; i++) {
        char ch = t[i];
        if (ch >= 'A' && ch <= 'F') ch = (char)(ch - 'A' + 'a');
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return 0;
        out[i] = ch;
    }
    out[n] = 0;
    return 1;
}
static void emit_trust(rx_session *s, const char *code) { emit_full(s, RX_EV_TRUST, 0, 0, 0, 0, 0, 0, code, s->peer_key); }
/* "WEBADF <v> [<key>]": READY 1 to a protocol 1 board (or a stray WEBADF), READY 2 to a protocol 2 one; then the key
   decides whether this connection may upload. Downloads work either way. */
static void on_hello(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v = 1;
    if (tok(c, &t, &n) && !num(t, n, 10, &v)) v = 1;
    s->peer_key[0] = 0;
    if (v < 2) {
        s->peer_v = 1; s->trust = RX_TRUST_OLD;
        puts_(s, "READY 1\n");
        emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
        if (s->upq) emit_trust(s, "old");
        return;
    }
    s->peer_v = 2;
    puts_(s, "READY 2\n");
    if (!tok(c, &t, &n) || !hex_key(t, n, s->peer_key)) s->peer_key[0] = 0;
    emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
    if (!s->upq) { s->trust = RX_TRUST_NONE; return; }
    if (!s->peer_key[0]) { s->trust = RX_TRUST_OTHER; emit_trust(s, "other"); }
    else if (!s->upq->trusted[0] || s->upq->trust_next) {
        strcpy(s->upq->trusted, s->peer_key); s->upq->trust_next = 0;
        s->trust = RX_TRUST_OK; emit_trust(s, "new");
    } else if (strcmp(s->upq->trusted, s->peer_key) == 0) { s->trust = RX_TRUST_OK; emit_trust(s, "ok"); }
    else { s->trust = RX_TRUST_OTHER; emit_trust(s, "other"); }
}

void rx_attach(rx_session *s, rx_upq *q) { s->upq = q; }
int rx_uploads_on(const rx_session *s) { return s->upq && s->peer_v >= 2 && s->trust == RX_TRUST_OK; }
int rx_trust_now(rx_session *s) {
    if (!s->upq || s->peer_v < 2 || !s->peer_key[0]) return -1;
    strcpy(s->upq->trusted, s->peer_key);
    s->trust = RX_TRUST_OK;
    emit_trust(s, "new");
    return 0;
}
void rx_key4(const char *key, char out[5]) {
    unsigned i;
    for (i = 0; i < 4 && key && key[i]; i++) out[i] = (char)(key[i] >= 'a' && key[i] <= 'f' ? key[i] - 'a' + 'A' : key[i]);
    out[i] = 0;
}

/* --- protocol 2: the queue (in memory only: spec §2) --- */
void rx_upq_init(rx_upq *q, const char *trusted) {
    memset(q, 0, sizeof *q);
    if (trusted && !hex_key(trusted, (unsigned)strlen(trusted), q->trusted)) q->trusted[0] = 0;
}
unsigned rx_up_add(rx_upq *q, const char *local, const char *name) {
    rx_up_item *it;
    if (q->n >= RX_UP_MAX || !local[0] || strlen(local) > RX_LOCAL_MAX || !rx_path_ok(name)) return 0;
    it = &q->q[q->n++];
    if (++q->next_tag > 999999999U) q->next_tag = 1;   /* the board reads 1-9 digits */
    it->tag = q->next_tag;
    strcpy(it->local, local);
    strcpy(it->name, name);
    return it->tag;
}
int rx_upq_remove(rx_upq *q, unsigned tag) {
    unsigned i;
    for (i = 0; i < q->n; i++) if (q->q[i].tag == tag) {
        memmove(&q->q[i], &q->q[i + 1], (q->n - i - 1) * sizeof q->q[0]);
        q->n--;
        return 1;
    }
    return 0;
}

/* A dropped drawer (spec §2): each file joins with its path under the drawer ("Drawer/sub/file"), 64 at most; an .info
   file only when the icon itself was dropped. */
typedef struct { rx_upq *q; const rx_fs *fs; rx_added_fn added; void *u;
                 char local[RX_LOCAL_MAX + 1]; char name[RX_PATH_MAX + 1]; int n, depth; } rx_walk;
static int ends_info(const char *nm) {
    size_t k = strlen(nm);
    return k >= 5 && nm[k - 5] == '.' && (nm[k - 4] | 0x20) == 'i' && (nm[k - 3] | 0x20) == 'n' &&
           (nm[k - 2] | 0x20) == 'f' && (nm[k - 1] | 0x20) == 'o';
}
static void walk_each(void *u, const char *nm, int is_dir) {
    rx_walk *w = u;
    size_t ll = strlen(w->local), nl = strlen(w->name), k = strlen(nm);
    size_t sep = (ll && w->local[ll - 1] != ':' && w->local[ll - 1] != '/') ? 1 : 0;
    if (w->n >= RX_UP_MAX || (!is_dir && ends_info(nm))) return;
    if (ll + sep + k > RX_LOCAL_MAX || nl + 1 + k > RX_PATH_MAX) return;
    if (sep) w->local[ll] = '/';
    memcpy(w->local + ll + sep, nm, k + 1);
    w->name[nl] = '/';
    memcpy(w->name + nl + 1, nm, k + 1);
    if (is_dir) {
        if (w->depth < RX_TREE_DEPTH) { w->depth++; w->fs->list(w->fs->ctx, w->local, walk_each, w); w->depth--; }
    } else if (rx_up_add(w->q, w->local, w->name)) {
        w->n++;
        if (w->added) w->added(w->u, &w->q->q[w->q->n - 1]);
    }
    w->local[ll] = 0;
    w->name[nl] = 0;
}
int rx_up_add_tree(rx_upq *q, const rx_fs *fs, const char *local, const char *name, rx_added_fn added, void *u) {
    static rx_walk w;   /* static: the Amiga's stack is small, and a walk is never nested */
    int d;
    if (strlen(local) > RX_LOCAL_MAX || strlen(name) > RX_PATH_MAX) return -1;
    d = fs->is_dir(fs->ctx, local);
    if (d < 0) return -1;
    if (d == 0) {
        if (!rx_up_add(q, local, name)) return 0;
        if (added) added(u, &q->q[q->n - 1]);
        return 1;
    }
    memset(&w, 0, sizeof w);
    w.q = q; w.fs = fs; w.added = added; w.u = u;
    strcpy(w.local, local); strcpy(w.name, name);
    if (fs->list(fs->ctx, local, walk_each, &w) != 0) return -1;
    return w.n;
}
```

In `on_line` replace
`if (is(t, n, "WEBADF")) { puts_(s, "READY 1\n"); emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0); }` with
`if (is(t, n, "WEBADF")) on_hello(s, &c);`.

In `rx_disconnected`, before `s->line_n = 0; ...` add `s->peer_v = 0; s->trust = RX_TRUST_NONE;`.

- [ ] **Step 5: Run the tests.**

Run: `tools/receive/test/run.sh`
Expected: every file prints `0 failed`; the run exits 0.

- [ ] **Step 6: The POSIX build and the Amiga build still compile.**

```bash
pnpm vitest run tools/receive/receive.int.test.ts
tools/receive/build.sh /tmp/Receive || true
```

Expected: the int test passes (protocol 1 boards are unchanged); the cross-build compiles and then prints
`FAIL: not the pinned binary` (the pin moves in Task 6).

- [ ] **Step 7: Commit.**

```bash
git add tools/receive/core/rx_proto.h tools/receive/core/rx_proto.c tools/receive/test/fakefs.h tools/receive/test/test_proto.c
git commit -m "receive: protocol 2 hello, trust on first use, the upload queue and the drawer walk

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 3: Receive core: the upload state machine (PUT, TAKE/NO, the credit, END, DONE, resume, ABORT)

The wire, as both sides implement it (spec §3 with ruling P7):

```
Amiga -> board   PUT <tag> <size> <days>.<mins>.<ticks> <prot hex> <len>:<name> <len>:<comment>
board -> Amiga   TAKE <tag> <offset> <credit>        or  NO <tag> <code> <len>:<text>
Amiga -> board   (raw bytes offset..credit, then more after each MORE)   ABORT <tag> is legal only before TAKE
board -> Amiga   MORE <tag> <credit>                  (after each 16 KB chunk is stored; also the progress)
Amiga -> board   END <tag> <crc32 hex of the whole file>
board -> Amiga   DONE <tag> <len>:<name as stored>    or  NO <tag> <code> <len>:<text>
```

Once raw bytes flow, a stop on either side closes the connection; the server keeps the partial upload, and the same
file sent again resumes. While a file goes up, every line Receive produces is held until its last byte is out.

**Files:**
- Modify: `tools/receive/core/rx_proto.h`, `tools/receive/core/rx_proto.c`, `tools/receive/test/test_proto.c`
- Modify (signature only): `tools/receive/posix/rx_posix.c`, `tools/receive/amiga/net.c`

**Interfaces:**
- Consumes: Task 2's queue, trust and `rx_fs` read side.
- Produces: `int rx_take_output(rx_session *s, char *dst, unsigned cap)` (was `unsigned`; **-1 = close the connection
  now**); `int rx_want_output(const rx_session *s)`; `int rx_up_cancel(rx_session *s, rx_upq *q, unsigned tag)`
  (0 handled, 1 the connection must close, -1 unknown); `int rx_idle_secs(const rx_session *s)` (75, or 180 while a
  file goes up). Events `RX_EV_UP_BEGIN`/`UP_PROGRESS`/`UP_DONE`/`UP_FAILED` with `tag`, `path` (the name), `size`,
  `bytes`, `text`, `code`.

- [ ] **Step 1: Write the failing tests.** In `tools/receive/test/test_proto.c`, `out()` becomes:

```c
static const char *out(void) { int n = rx_take_output(&S, outbuf, sizeof outbuf - 1); outbuf[n > 0 ? n : 0] = 0; return outbuf; }
```

and add, before `int main(void)`:

```c
/* --- protocol 2: a file going up --- */
static unsigned char DATA[65536];
static unsigned char obig[200000]; static unsigned long ob_n; static int ob_closed;
static void fill_data(void) { for (unsigned i = 0; i < sizeof DATA; i++) DATA[i] = (unsigned char)(i * 7 + 3); }
/* Everything Receive has to send now, in 4 KB takes, as a front end does. */
static void drain(void) {
    ob_n = 0; ob_closed = 0;
    for (int i = 0; i < 5000 && rx_want_output(&S); i++) {
        int k = rx_take_output(&S, (char *)obig + ob_n, 4096);
        if (k < 0) { ob_closed = 1; break; }
        ob_n += (unsigned long)k;
    }
    obig[ob_n] = 0;
}
static void up_ready(const char *local, const char *name, unsigned long len, unsigned long prot, const char *comment) {
    setup2(""); fill_data(); F.days = 1; F.mins = 2; F.ticks = 3;
    ff_put(&F, local, DATA, len, prot, comment);
    rx_up_add(&Q, local, name);
    hello2(KEY); out();          /* READY 2 (the PUT is not out yet: out() takes lines only once) */
}
static unsigned long crc_of(unsigned long n) { return rx_crc32_update(0, DATA, n); }

static void put_goes_out_once_the_board_is_trusted(void) {
    setup2(""); fill_data(); F.days = 1; F.mins = 2; F.ticks = 3;
    ff_put(&F, "DH0:Hello.txt", "hello", 5, 0x40, "note");
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:Hello.txt", "Hello.txt"), 1);
    drain(); CHECK_EQ_INT(ob_n, 0);                       /* no board yet */
    hello2(KEY); drain();
    CHECK(strcmp((char *)obig, "READY 2\nPUT 1 5 1.2.3 40 9:Hello.txt 4:note\n") == 0, "READY, then the PUT");
    CHECK_EQ_INT(Q.n, 0); CHECK_EQ_INT(F.opens_r, 1);
    CHECK_EQ_INT(rx_idle_secs(&S), RX_UP_IDLE_SECS);
}
static void no_put_while_a_file_comes_down(void) {
    char l[600];
    setup2(""); ff_put(&F, "DH0:a", "a", 1, 0, ""); hello2(KEY); out();
    file_line(l, "d1", "hello", 5, 0, "Down.txt", "", 0); feed(l);
    rx_up_add(&Q, "DH0:a", "a");
    drain(); CHECK(strstr((char *)obig, "GO d1\n") && !strstr((char *)obig, "PUT"), "no PUT while receiving");
    feed("hello"); drain();
    CHECK(strstr((char *)obig, "OK d1 8:Down.txt\nPUT 1 1 ") != NULL, "the OK, then the PUT");
}
static void no_put_to_a_protocol_1_board_or_another_key(void) {
    setup2(""); ff_put(&F, "DH0:a", "a", 1, 0, ""); rx_up_add(&Q, "DH0:a", "a");
    feed("WEBADF 1\n"); drain(); CHECK(strstr((char *)obig, "PUT") == NULL, "protocol 1: no PUT");
    setup2(KEY); ff_put(&F, "DH0:a", "a", 1, 0, ""); rx_up_add(&Q, "DH0:a", "a");
    hello2(KEY2); drain(); CHECK(strstr((char *)obig, "PUT") == NULL, "another key: no PUT");
    CHECK_EQ_INT(Q.n, 1);                                 /* it waits for the trusted board */
}
static void bytes_never_pass_the_credit_then_end(void) {
    char want[40];
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();   /* the PUT */
    feed("TAKE 1 0 32768\n"); drain();
    CHECK_EQ_INT(ob_n, 32768); CHECK(memcmp(obig, DATA, 32768) == 0, "the first 32 KB");
    CHECK(!rx_want_output(&S), "nothing past the credit");
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_BEGIN)].bytes, 0);
    feed("MORE 1 40000\n"); drain();
    snprintf(want, sizeof want, "END 1 %lx\n", crc_of(40000));
    CHECK_EQ_INT(ob_n, 7232 + strlen(want));
    CHECK(memcmp(obig, DATA + 32768, 7232) == 0, "the rest");
    CHECK(strcmp((char *)obig + 7232, want) == 0, "END with the CRC of the whole file");
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_PROGRESS)].bytes, 7232);   /* credit 40000 - window 32768 */
}
static void resume_crc_covers_the_skipped_part(void) {
    char want[40];
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    feed("TAKE 1 16384 40000\n"); drain();
    snprintf(want, sizeof want, "END 1 %lx\n", crc_of(40000));
    CHECK_EQ_INT(ob_n, 40000 - 16384 + strlen(want));
    CHECK(memcmp(obig, DATA + 16384, 40000 - 16384) == 0, "only the part the web app lacks is sent");
    CHECK(strcmp((char *)obig + 40000 - 16384, want) == 0, "the CRC still covers the whole file");
    CHECK_EQ_INT(F.bytes_read, 40000);                    /* the skipped part is read once, never sent */
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_BEGIN)].bytes, 16384);
}
static void resume_at_the_end_sends_no_bytes_then_end(void) {   /* Review Focus 1 */
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    feed("TAKE 1 5 5\n"); drain();
    char want[40]; snprintf(want, sizeof want, "END 1 %lx\n", crc_of(5));
    CHECK(strcmp((char *)obig, want) == 0, "END at once");
    CHECK_EQ_INT(F.bytes_read, 5);
}
static void empty_file_goes_up(void) {                          /* Review Focus 2 */
    up_ready("RAM:Empty", "Empty", 0, 0, ""); drain();
    CHECK(strcmp((char *)obig, "PUT 1 0 1.2.3 0 5:Empty 0:\n") == 0, "PUT size 0");
    feed("TAKE 1 0 0\n"); drain();
    CHECK(strcmp((char *)obig, "END 1 0\n") == 0, "END 1 0");
}
static void done_and_no_are_events_and_the_next_file_follows(void) {
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, "");
    ff_put(&F, "DH0:Two", "two", 3, 0, ""); rx_up_add(&Q, "DH0:Two", "Two");
    drain(); feed("TAKE 1 0 5\n"); drain();
    feed("DONE 1 9:Hello.txt\n");
    int i = last_kind(RX_EV_UP_DONE);
    CHECK(i >= 0 && last_ev[i].tag == 1 && strncmp(ev_path[i], "Hello.txt|", 10) == 0, "done, with the stored name");
    CHECK_EQ_INT(F.closes_r, 1);
    drain(); CHECK(strncmp((char *)obig, "PUT 2 3 ", 8) == 0, "the next file");
    feed("NO 2 full 23:the area on the web app\n");
    i = last_kind(RX_EV_UP_FAILED);
    CHECK(i >= 0 && strcmp(ev_code[i], "full") == 0 && strstr(ev_path[i], "|the area on the web app"), "refused, with the board's words");
    CHECK_EQ_INT(F.closes_r, 2);
}
static void abort_before_take_and_cancel_mid_file(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 1), 0);
    drain(); CHECK(strcmp((char *)obig, "ABORT 1\n") == 0, "ABORT before TAKE");
    feed("NO 1 busy 9:cancelled\n");
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|cancelled") != NULL, "cancelled");
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n");
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 1), 1);             /* mid-file: only closing stops it (ruling P7) */
    drain(); CHECK(ob_closed, "the connection closes");
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    feed("TAKE 1 0 32768\n");
    rx_up_add(&Q, "DH0:Big", "Big");
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 2), 0); CHECK_EQ_INT(Q.n, 0);   /* a waiting one just leaves the list */
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 99), -1);
}
static void take_after_abort_closes(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    rx_up_cancel(&S, &Q, 1); drain();                      /* ABORT out, but TAKE was already on its way */
    feed("TAKE 1 0 32768\n"); drain();
    CHECK(ob_closed, "closed: the board already treats every byte as data");
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|cancelled") != NULL, "cancelled");
}
static void a_read_failure_mid_file_closes(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    F.fail_read_at = 10000;
    feed("TAKE 1 0 32768\n"); drain();
    CHECK(ob_closed, "closed");
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|cannot read the file") != NULL, "why");
}
static void a_dropped_connection_fails_the_file(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n"); drain();
    rx_disconnected(&S);
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|connection lost") != NULL, "connection lost");
    CHECK_EQ_INT(F.closes_r, 1); CHECK_EQ_INT(rx_idle_secs(&S), RX_IDLE_SECS);
}
static void answers_out_of_range_and_a_file_mid_upload_close(void) {
    char l[600];
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    CHECK_EQ_INT(feed("TAKE 1 6 5\n"), -1);
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    CHECK_EQ_INT(feed("TAKE 1 0 9\n"), -1);                /* a credit past the size */
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n");
    file_line(l, "d9", "x", 1, 0, "X", "", 0);
    CHECK_EQ_INT(feed(l), -1);
}
static void no_after_data_started_closes_too(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n");
    feed("NO 1 offline 29:the web app cannot be reached\n");
    CHECK(strcmp(ev_code[last_kind(RX_EV_UP_FAILED)], "offline") == 0, "offline");
    drain(); CHECK(ob_closed, "closed: the place in the stream is lost");
}
static void stale_lines_for_another_tag_are_ignored(void) {
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    feed("TAKE 7 0 5\nMORE 7 5\nDONE 7 1:x\nNO 7 full 1:x\n");
    CHECK_EQ_INT(last_kind(RX_EV_UP_BEGIN), -1); CHECK_EQ_INT(last_kind(RX_EV_UP_FAILED), -1);
}
```

and in `main`, before `return REPORT();`:

```c
    RUN(put_goes_out_once_the_board_is_trusted); RUN(no_put_while_a_file_comes_down);
    RUN(no_put_to_a_protocol_1_board_or_another_key); RUN(bytes_never_pass_the_credit_then_end);
    RUN(resume_crc_covers_the_skipped_part); RUN(resume_at_the_end_sends_no_bytes_then_end); RUN(empty_file_goes_up);
    RUN(done_and_no_are_events_and_the_next_file_follows); RUN(abort_before_take_and_cancel_mid_file);
    RUN(take_after_abort_closes); RUN(a_read_failure_mid_file_closes); RUN(a_dropped_connection_fails_the_file);
    RUN(answers_out_of_range_and_a_file_mid_upload_close); RUN(no_after_data_started_closes_too);
    RUN(stale_lines_for_another_tag_are_ignored);
```

Run: `tools/receive/test/run.sh`
Expected: COMPILE errors (`rx_want_output`, `rx_up_cancel`, `rx_idle_secs` undeclared).

- [ ] **Step 2: The header.** In `tools/receive/core/rx_proto.h` replace
`unsigned rx_take_output(rx_session *s, char *dst, unsigned cap);       /* moves pending reply bytes out */` with:

```c
/* Moves what is to be sent now into dst: reply lines, a PUT, or file bytes within the board's credit (one 8 KB block
   at most). 0: nothing this time (perhaps a block read only for the CRC: ask rx_want_output). -1: close the
   connection now (an upload stopped mid-file, or the board broke the protocol). */
int rx_take_output(rx_session *s, char *dst, unsigned cap);
int rx_want_output(const rx_session *s);   /* 1 while rx_take_output has work now */
/* Stop an upload: a waiting file leaves the list (0); the file going up sends ABORT before TAKE (0), or -- once bytes
   flow -- needs the connection closed (1; rx_take_output then returns -1). -1: no such tag. */
int rx_up_cancel(rx_session *s, rx_upq *q, unsigned tag);
int rx_idle_secs(const rx_session *s);     /* the silence allowed: RX_IDLE_SECS, RX_UP_IDLE_SECS while a file goes up */
```

- [ ] **Step 3: The code.** In `tools/receive/core/rx_proto.c`:

Replace `rx_take_output` with:

```c
static unsigned take_lines(rx_session *s, char *dst, unsigned cap) {
    unsigned n = s->out_n < cap ? s->out_n : cap;
    memcpy(dst, s->out, n);
    memmove(s->out, s->out + n, s->out_n - n);
    s->out_n -= n;
    return n;
}
```

After `emit()` add:

```c
static void emit_up(rx_session *s, int kind, const rx_up_item *it, const char *path, unsigned long size,
                    unsigned long bytes, const char *text, const char *code) {
    emit_full(s, kind, 0, path ? path : it->name, size, bytes, text, it->tag, code, 0);
}
static void put_dec(rx_session *s, unsigned long v) { char b[12]; rx_utoa(v, b); puts_(s, b); }
static void put_hex(rx_session *s, unsigned long v) {
    char b[9]; int i = 8;
    b[8] = 0;
    do { b[--i] = "0123456789abcdef"[v & 15UL]; v >>= 4; } while (v && i > 0);
    puts_(s, b + i);
}
static void put_lenstr(rx_session *s, const char *str) { put_dec(s, (unsigned long)strlen(str)); puts_(s, ":"); puts_(s, str); }
```

After the drawer walk (Task 2) add:

```c
/* --- protocol 2: the file going up (spec §3; plan ruling P7) --- */
static int put_due(const rx_session *s) {
    return s->upq && s->upq->n > 0 && s->up_phase == RX_UP_IDLE && !s->in_data && !s->up_closing && rx_uploads_on(s);
}
/* Ends the file going up: closed, and the front end told. */
static void up_finish(rx_session *s, int kind, const char *text, const char *code, const char *stored) {
    rx_up_item it = s->up_cur;
    unsigned long size = s->up_info.size, sent = s->up_sent;
    s->fs->close_r(s->fs->ctx);
    s->up_phase = RX_UP_IDLE;
    s->up_cancel = 0;
    if (kind == RX_EV_UP_DONE) emit_up(s, kind, &it, stored, size, size, 0, 0);
    else emit_up(s, kind, &it, 0, size, sent, text, code);
}
static void protocol_error(rx_session *s, const char *why) {
    if (s->up_phase != RX_UP_IDLE) up_finish(s, RX_EV_UP_FAILED, why, "local", 0);
    s->proto_err = 1;
}
static void up_put(rx_session *s) {
    while (put_due(s)) {
        rx_up_item it = s->upq->q[0];
        rx_upq_remove(s->upq, it.tag);
        memset(&s->up_info, 0, sizeof s->up_info);
        if (s->fs->open_r(s->fs->ctx, it.local, &s->up_info) != 0) {
            emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "cannot read the file", "local");
            continue;
        }
        if (s->up_info.size > RX_FILE_MAX) {
            s->fs->close_r(s->fs->ctx);
            emit_up(s, RX_EV_UP_FAILED, &it, 0, s->up_info.size, 0, "file too large (4 MB at most)", "local");
            continue;
        }
        s->up_cur = it; s->up_phase = RX_UP_ASKED; s->up_cancel = 0; s->up_sent = 0;
        puts_(s, "PUT "); put_dec(s, it.tag); puts_(s, " "); put_dec(s, s->up_info.size); puts_(s, " ");
        put_dec(s, s->up_info.days); puts_(s, "."); put_dec(s, s->up_info.mins); puts_(s, "."); put_dec(s, s->up_info.ticks);
        puts_(s, " "); put_hex(s, s->up_info.prot); puts_(s, " "); put_lenstr(s, it.name); puts_(s, " ");
        put_lenstr(s, s->up_info.comment); puts_(s, "\n");
        return;
    }
}
static void up_end(rx_session *s) {
    s->up_phase = RX_UP_ENDED;
    puts_(s, "END "); put_dec(s, s->up_cur.tag); puts_(s, " "); put_hex(s, s->up_crc); puts_(s, "\n");
}
static void up_data_begins(rx_session *s) {
    s->up_phase = RX_UP_DATA;
    if (s->up_sent == s->up_info.size) up_end(s);
}
/* Mid-file nothing can stop the raw section but closing (ruling P7). */
static int up_read_failed(rx_session *s) {
    up_finish(s, RX_EV_UP_FAILED, "cannot read the file", "local", 0);
    s->up_closing = 1;
    return -1;
}
/* One block: the resumed part's CRC (nothing to send), or bytes within the credit. */
static int up_bytes(rx_session *s, unsigned char *dst, unsigned cap) {
    unsigned long want;
    if (cap > RX_UP_BLOCK) cap = (unsigned)RX_UP_BLOCK;
    if (s->up_phase == RX_UP_SKIP) {
        want = s->up_skip < cap ? s->up_skip : cap;
        if (s->fs->read(s->fs->ctx, dst, want) != (long)want) return up_read_failed(s);
        s->up_crc = rx_crc32_update(s->up_crc, dst, want);
        s->up_skip -= want;
        if (s->up_skip == 0) up_data_begins(s);
        return 0;
    }
    want = s->up_credit - s->up_sent;
    if (want > cap) want = cap;
    if (want == 0) return 0;
    if (s->fs->read(s->fs->ctx, dst, want) != (long)want) return up_read_failed(s);
    s->up_crc = rx_crc32_update(s->up_crc, dst, want);
    s->up_sent += want;
    if (s->up_sent == s->up_info.size) up_end(s);   /* END goes out with the next take */
    return (int)want;
}
static int tag_is(const rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v;
    return s->up_phase != RX_UP_IDLE && tok(c, &t, &n) && num(t, n, 10, &v) && v == s->up_cur.tag;
}
static void on_take(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long off, credit;
    if (s->up_phase != RX_UP_ASKED || !tag_is(s, c)) return;
    if (!tok(c, &t, &n) || !num(t, n, 10, &off) || !tok(c, &t, &n) || !num(t, n, 10, &credit) ||
        off > s->up_info.size || credit < off || credit > s->up_info.size) {
        protocol_error(s, "the board answered out of range");
        return;
    }
    if (s->up_cancel) {   /* our ABORT crossed this TAKE: the board treats every byte as data now */
        up_finish(s, RX_EV_UP_FAILED, "cancelled", "local", 0);
        s->up_closing = 1;
        return;
    }
    s->up_off = s->up_sent = off; s->up_credit = credit; s->up_window = credit - off; s->up_crc = 0; s->up_skip = off;
    emit_up(s, RX_EV_UP_BEGIN, &s->up_cur, 0, s->up_info.size, off, 0, 0);
    if (off) s->up_phase = RX_UP_SKIP; else up_data_begins(s);
}
static void on_more(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v;
    if ((s->up_phase != RX_UP_SKIP && s->up_phase != RX_UP_DATA && s->up_phase != RX_UP_ENDED) || !tag_is(s, c)) return;
    if (!tok(c, &t, &n) || !num(t, n, 10, &v) || v > s->up_info.size) { protocol_error(s, "the board answered out of range"); return; }
    if (v > s->up_credit) s->up_credit = v;
    emit_up(s, RX_EV_UP_PROGRESS, &s->up_cur, 0, s->up_info.size, s->up_credit - s->up_window, 0, 0);
}
static void on_done(rx_session *s, cur *c) {
    char name[RX_PATH_MAX + 1];
    if (s->up_phase != RX_UP_ENDED || !tag_is(s, c)) return;
    if (!lenstr(c, name, sizeof name, 1)) strcpy(name, s->up_cur.name);
    up_finish(s, RX_EV_UP_DONE, 0, 0, name);
}
static void on_no(rx_session *s, cur *c) {
    const char *t; unsigned n; char code[17], text[80];
    int raw = s->up_phase == RX_UP_SKIP || s->up_phase == RX_UP_DATA;
    if (!tag_is(s, c)) return;
    if (!tok(c, &t, &n) || n > 16) { t = "server"; n = 6; }
    memcpy(code, t, n); code[n] = 0;
    if (!lenstr(c, text, sizeof text, 1)) strcpy(text, "refused");
    up_finish(s, RX_EV_UP_FAILED, (s->up_cancel && strcmp(code, "busy") == 0) ? "cancelled" : text, code, 0);
    if (raw) s->up_closing = 1;   /* the stream's place is lost: the board closes too */
}

int rx_take_output(rx_session *s, char *dst, unsigned cap) {
    if (s->up_closing) return -1;
    if (s->up_phase == RX_UP_SKIP || s->up_phase == RX_UP_DATA) return up_bytes(s, (unsigned char *)dst, cap);
    if (s->out_n == 0) up_put(s);
    return (int)take_lines(s, dst, cap);
}
int rx_want_output(const rx_session *s) {
    if (s->up_closing || s->up_phase == RX_UP_SKIP) return 1;
    if (s->up_phase == RX_UP_DATA) return s->up_sent < s->up_credit;
    return s->out_n > 0 || put_due(s);
}
int rx_up_cancel(rx_session *s, rx_upq *q, unsigned tag) {
    unsigned i;
    for (i = 0; q && i < q->n; i++) if (q->q[i].tag == tag) {
        rx_up_item it = q->q[i];
        rx_upq_remove(q, tag);
        emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "cancelled", "local");
        return 0;
    }
    if (s->up_phase == RX_UP_IDLE || s->up_cur.tag != tag) return -1;
    if (s->up_phase == RX_UP_ASKED) {
        if (!s->up_cancel) { puts_(s, "ABORT "); put_dec(s, tag); puts_(s, "\n"); s->up_cancel = 1; }
        return 0;
    }
    if (s->up_phase == RX_UP_ENDED) return 0;   /* the last byte is out: the web app has it in a moment */
    up_finish(s, RX_EV_UP_FAILED, "cancelled", "local", 0);
    s->up_closing = 1;
    return 1;
}
int rx_idle_secs(const rx_session *s) { return s->up_phase != RX_UP_IDLE ? RX_UP_IDLE_SECS : RX_IDLE_SECS; }
```

In `on_line`, replace `else if (is(t, n, "FILE")) on_file(s, &c);` with:

```c
    else if (is(t, n, "FILE")) {
        if (s->up_phase == RX_UP_SKIP || s->up_phase == RX_UP_DATA) protocol_error(s, "the board sent a file mid-upload");
        else on_file(s, &c);
    }
    else if (is(t, n, "TAKE")) on_take(s, &c);
    else if (is(t, n, "MORE")) on_more(s, &c);
    else if (is(t, n, "DONE")) on_done(s, &c);
    else if (is(t, n, "NO")) on_no(s, &c);
```

In `rx_feed`, after `on_line(s, s->line, len);` add `if (s->proto_err) return -1;`.

In `rx_disconnected`, before `s->peer_v = 0;` add:

```c
    if (s->up_phase != RX_UP_IDLE) up_finish(s, RX_EV_UP_FAILED, s->up_cancel ? "cancelled" : "connection lost", "local", 0);
    s->up_closing = 0; s->proto_err = 0;
```

- [ ] **Step 4: The two front ends call the new signature.** In `tools/receive/posix/rx_posix.c` the loop
`while ((k = rx_take_output(&S, o, sizeof o)) > 0) if (send_all(cl, o, k) != 0) bad = 1;` becomes:

```c
            while (!bad && rx_want_output(&S)) {
                int k = rx_take_output(&S, o, sizeof o);
                if (k < 0) bad = 1;
                else if (k > 0 && send_all(cl, o, (size_t)k) != 0) bad = 1;
            }
```

(and delete the now-unused `unsigned k;` there). In `tools/receive/amiga/net.c` the same loop becomes:

```c
            while (!bad && rx_want_output(s)) {
                int k = rx_take_output(s, o, sizeof o);
                if (k < 0) bad = 1;
                else if (k > 0 && send_all(cl, o, (LONG)k) != 0) bad = 1;
            }
```

(and delete `unsigned k;`).

- [ ] **Step 5: Run the tests.**

```bash
tools/receive/test/run.sh
pnpm vitest run tools/receive/receive.int.test.ts
```

Expected: `0 failed` in every file; the int test passes.

- [ ] **Step 6: Commit.**

```bash
git add tools/receive/core/rx_proto.h tools/receive/core/rx_proto.c tools/receive/test/test_proto.c \
        tools/receive/posix/rx_posix.c tools/receive/amiga/net.c
git commit -m "receive: the upload state machine -- PUT, the credit, END, resume CRC, ABORT before TAKE, close mid-file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 4: Uploads on the POSIX build, the fake board's upload side, and the shared scenarios

**Files:**
- Modify: `tools/receive/posix/rx_posix.c` (replaced whole), `tools/receive/fake-board.ts` (replaced whole),
  `tools/receive/scenarios.ts`, `tools/receive/receive.int.test.ts`, `tools/receive/README.md`

**Interfaces:**
- Consumes: Tasks 2-3 (`rx_upq`, `rx_up_add_tree`, `rx_attach`, `rx_take_output`/`rx_want_output`, `rx_up_cancel`,
  `rx_trust_now`, `rx_idle_secs`, the `RX_EV_UP_*` and `RX_EV_TRUST` events).
- Produces: `rx_posix <folder> <port> [<key file>]`, reading commands on stdin (`SEND <host path>`, `TRUST`,
  `CANCEL <tag>`) and printing `QUEUED <tag> <name>`, `TRUST <code> <KEY4>`, `UP_BEGIN <tag> <name> <offset>`,
  `UP_DONE <tag> <name>`, `UP_FAILED <tag> <code> <text>`. In `fake-board.ts`: `connect(port, host?, opts?: { v?: 1 | 2; key?: string })`,
  `Board.takeUpload(o?: UploadOpts): Promise<UploadResult>`, `class UploadStore`, `export const BOARD_KEY`, `BOARD_KEY2`.
  In `scenarios.ts`: `UP_SCENARIOS`, `runUploadScenarios(port, ctl, opts)`, `type UpCtl`.

- [ ] **Step 1: The fake board.** Replace `tools/receive/fake-board.ts` with:

```ts
// The board's side of the Receive protocol, for tests: protocol 1 (spec 2026-10-16 §2: hello, LIST, FILE + bytes, PING)
// and protocol 2 (spec 2026-10-18 §3: the key in the hello, and PUT/TAKE/MORE/END/DONE/NO for files going up).
import net from 'node:net';
import { crc32 } from 'node:zlib';

export const BOARD_KEY = '0123456789abcdef0123456789abcdef';
export const BOARD_KEY2 = 'fedcba9876543210fedcba9876543210';
const CHUNK = 16_384;

export interface SendFile {
  id: string; path: string; data: Buffer; protection?: number; comment?: string;
  badCrc?: boolean;      // send a wrong CRC
  dropAfter?: number;    // close the socket after this many data bytes
}
export type Outcome =
  | { id: string; ok: true; savedAs: string }
  | { id: string; ok: false; code: string; text: string };

/** What the server keeps between connections: the whole chunks of each partial upload (spec U4). */
export class UploadStore {
  parts = new Map<string, Buffer>();
  key(path: string, size: number, date: string) { return `${path}|${size}|${date}`; }
}
export interface UploadOpts {
  window?: number;                          // the credit window, bytes (default 32 KB)
  refuse?: { code: string; text: string };  // answer the PUT with NO
  crcFault?: boolean;                       // answer the END with NO crc, whatever the CRC
  dropAfterChunks?: number;                 // close the socket after this many stored chunks
  store?: UploadStore;
  timeoutMs?: number;
}
export type UploadResult = {
  tag: string; path: string; size: number; date: string; protection: number; comment: string; offset: number;
} & ({ ok: true; data: Buffer } | { ok: false; code: string });

const lp = (s: string) => `${Buffer.byteLength(s, 'latin1')}:${s}`;

export interface Board {
  list(files: SendFile[]): void;
  send(f: SendFile, opts?: { chunk?: number; delayMs?: number }): Promise<Outcome>;
  ping(): Promise<boolean>;
  /** Waits for a PUT and plays the board for that one file (resume, credit, chunks, END, DONE or NO). */
  takeUpload(o?: UploadOpts): Promise<UploadResult>;
  /** Waits up to ms for a line; null if none came. */
  maybeLine(ms: number): Promise<string | null>;
  close(): Promise<void>;   // resolves once the receiver has closed its side (or after 3 s)
}

/** Lines and raw bytes off one socket, in order. */
function byteReader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  let closed = false;
  let wake: (() => void) | null = null;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); wake?.(); });
  const end = () => { closed = true; wake?.(); };
  sock.on('close', end); sock.on('error', end);
  const until = async (ready: () => boolean, ms: number) => {
    const t0 = Date.now();
    while (!ready()) {
      if (closed) return false;
      const left = ms - (Date.now() - t0);
      if (left <= 0) throw new Error('no reply within ' + ms + ' ms');
      await new Promise<void>((r) => { const t = setTimeout(r, left); wake = () => { clearTimeout(t); r(); }; });
      wake = null;
    }
    return true;
  };
  return {
    buffered: () => buf.length,
    async line(ms = 15000): Promise<string | null> {
      if (!(await until(() => buf.indexOf(10) >= 0, ms))) return null;
      const i = buf.indexOf(10);
      const l = buf.subarray(0, i).toString('latin1');
      buf = buf.subarray(i + 1);
      return l;
    },
    async bytes(n: number, ms = 15000): Promise<Buffer | null> {
      if (!(await until(() => buf.length >= n, ms))) return null;
      const b = buf.subarray(0, n);
      buf = buf.subarray(n);
      return Buffer.from(b);
    },
  };
}

/** "<len>:<bytes>" fields of a Latin-1 line, from position at. */
function lenField(l: string, at: number): { v: string; next: number } | null {
  const m = /^(\d+):/.exec(l.slice(at));
  if (!m) return null;
  const start = at + m[0].length;
  const v = l.slice(start, start + Number(m[1]));
  if (v.length !== Number(m[1])) return null;
  return { v, next: start + v.length + 1 };
}

export function rawConnect(port: number, host = '127.0.0.1'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(s));
    s.once('error', reject);
  });
}

export async function connect(port: number, host = '127.0.0.1', opts: { v?: 1 | 2; key?: string } = {}): Promise<Board> {
  const v = opts.v ?? 1;
  const sock = await rawConnect(port, host);
  const rd = byteReader(sock);
  sock.write(v >= 2 ? `WEBADF 2 ${opts.key ?? BOARD_KEY}\n` : 'WEBADF 1\n');
  const hello = await rd.line();
  if (hello !== `READY ${v}`) throw new Error(`expected READY ${v}, got ${JSON.stringify(hello)}`);
  return {
    list(files) {
      sock.write(Buffer.from(`LIST ${files.length}\n` + files.map((f) => `${f.id} ${f.data.length} ${lp(f.path)}\n`).join(''), 'latin1'));
    },
    async send(f, o = {}) {
      const crc = (crc32(f.data) ^ (f.badCrc ? 1 : 0)) >>> 0;
      const line = `FILE ${f.id} ${f.data.length} ${crc.toString(16)} ${(f.protection ?? 0).toString(16)} ${lp(f.path)} ${lp(f.comment ?? '')}\n`;
      sock.write(Buffer.from(line, 'latin1'));
      const go = await rd.line();
      if (go === null) throw new Error('closed before GO');
      if (go.startsWith('ERR ')) return parseErr(go);
      if (go !== `GO ${f.id}`) throw new Error(`expected GO ${f.id}, got ${go}`);
      const chunk = o.chunk ?? 4096;
      const stop = f.dropAfter ?? f.data.length;
      for (let at = 0; at < stop; at += chunk) {
        sock.write(f.data.subarray(at, Math.min(at + chunk, stop)));
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      }
      if (f.dropAfter !== undefined) {
        await new Promise((r) => setTimeout(r, 200));
        sock.destroy();
        return { id: f.id, ok: false, code: 'dropped', text: '' };
      }
      // The receiver answers after the last byte is written: allow 60 s plus 4 KB/s (an emulated or real A500
      // writes a 4 MB file in minutes, not seconds).
      const r = await rd.line(60000 + Math.ceil(f.data.length / 4));
      if (r === null) throw new Error('closed before OK');
      if (r.startsWith('ERR ')) return parseErr(r);
      const m = /^OK (\S+) (\d+):(.*)$/.exec(r);
      if (!m || m[1] !== f.id) throw new Error(`bad reply ${r}`);
      return { id: f.id, ok: true, savedAs: m[3] };
    },
    async ping() { sock.write('PING\n'); return (await rd.line()) === 'PONG'; },
    async maybeLine(ms) { try { return await rd.line(ms); } catch { return null; } },
    async takeUpload(o = {}) {
      const ms = o.timeoutMs ?? 15000;
      const put = await rd.line(ms);
      if (put === null) throw new Error('closed before PUT');
      const m = /^PUT (\d{1,9}) (\d+) (\d+\.\d+\.\d+) ([0-9a-f]{1,8}) /.exec(put);
      if (!m) throw new Error(`bad PUT ${JSON.stringify(put)}`);
      const pathF = lenField(put, m[0].length);
      const comF = pathF && lenField(put, pathF.next);
      if (!pathF || !comF) throw new Error(`bad PUT fields ${JSON.stringify(put)}`);
      const head = { tag: m[1], size: Number(m[2]), date: m[3], protection: parseInt(m[4], 16), path: pathF.v, comment: comF.v };
      if (o.refuse) {
        sock.write(Buffer.from(`NO ${head.tag} ${o.refuse.code} ${lp(o.refuse.text)}\n`, 'latin1'));
        return { ...head, offset: 0, ok: false, code: o.refuse.code };
      }
      const store = o.store ?? new UploadStore();
      const key = store.key(head.path, head.size, head.date);
      const have = store.parts.get(key) ?? Buffer.alloc(0);
      const offset = have.length;   // whole chunks only (below), so a chunk boundary or the size
      const W = o.window ?? 32_768;
      let credit = Math.min(head.size, offset + W);
      sock.write(`TAKE ${head.tag} ${offset} ${credit}\n`);
      let got = have;
      let chunks = 0;
      while (got.length < head.size) {
        // The credit is never exceeded: what has arrived beyond the stored bytes is at most credit - stored.
        // (Once the credit reaches the size, END may already be buffered behind the last bytes, so only before that.)
        if (credit < head.size && got.length + rd.buffered() > credit) throw new Error(`past the credit: ${got.length + rd.buffered()} > ${credit}`);
        const n = Math.min(CHUNK, head.size - got.length);
        const piece = await rd.bytes(n, Math.max(ms, 60000 + n));
        if (piece === null) return { ...head, offset, ok: false, code: 'closed' };
        got = Buffer.concat([got, piece]);
        store.parts.set(key, got);
        chunks++;
        if (o.dropAfterChunks !== undefined && chunks >= o.dropAfterChunks) {
          sock.destroy();
          return { ...head, offset, ok: false, code: 'dropped' };
        }
        credit = Math.min(head.size, got.length + W);
        sock.write(`MORE ${head.tag} ${credit}\n`);
      }
      const end = await rd.line(Math.max(ms, 60000));
      const e = end && /^END (\d+) ([0-9a-f]{1,8})$/.exec(end);
      if (!e || e[1] !== head.tag) throw new Error(`expected END ${head.tag}, got ${JSON.stringify(end)}`);
      store.parts.delete(key);
      if (o.crcFault || parseInt(e[2], 16) !== crc32(got) >>> 0) {
        sock.write(`NO ${head.tag} crc 18:damaged on the way\n`);
        return { ...head, offset, ok: false, code: 'crc' };
      }
      sock.write(Buffer.from(`DONE ${head.tag} ${lp(head.path)}\n`, 'latin1'));
      return { ...head, offset, ok: true, data: got };
    },
    close() {
      // A board waits for the receiver to close before reconnecting; a new connection sent while the old one is
      // still open is answered "busy".
      return new Promise<void>((r) => { if (sock.destroyed) return r(); const t = setTimeout(() => { sock.destroy(); r(); }, 3000);
        sock.once('close', () => { clearTimeout(t); r(); }); sock.end(); });
    },
  };
}

function parseErr(l: string): Outcome {
  const m = /^ERR (\S+) (\S+) (.*)$/.exec(l);
  if (!m) throw new Error(`bad ERR ${l}`);
  return { id: m[1], ok: false, code: m[2], text: m[3] };
}
```

`"damaged on the way"` is 18 Latin-1 bytes.

- [ ] **Step 2: The shared upload scenarios.** Append to `tools/receive/scenarios.ts`:

```ts
// --- Uploads (spec 2026-10-18 §3, §10 increment 1): the board's side against a Receive that was told to send. ---
import { BOARD_KEY2, UploadStore } from './fake-board';

/** How a scenario asks Receive to send: the POSIX build reads stdin; FS-UAE runs a fixed startup-sequence. */
export interface UpCtl {
  send(hostPath: string): void;
  trust(): void;
  cancel(tag: string): void;
  lines(): string[];          // what Receive has printed so far (POSIX: stdout)
  dir: string;                // a host folder the scenarios may write their files into
}
export interface UpScenario { name: string; run: (port: number, host: string, ctl: UpCtl) => Promise<string | null> }

const upFile = (ctl: UpCtl, name: string, data: Buffer) => { const p = path.join(ctl.dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const waitFor = async (ctl: UpCtl, re: RegExp, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (ctl.lines().some((l) => re.test(l))) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const sameBytes = (r: { ok: boolean } & Partial<{ data: Buffer }>, want: Buffer) => (r.ok && r.data && Buffer.compare(r.data, want) === 0 ? null : `got ${JSON.stringify({ ...r, data: r.data?.length })}`);

export const UP_SCENARIOS: UpScenario[] = [
  { name: 'up-small', run: async (p, h, ctl) => {
      const data = Buffer.from('hello from the Amiga\n');
      ctl.send(upFile(ctl, 'Hello.txt', data));
      const b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload(); return sameBytes(r, data) ?? (r.path === 'Hello.txt' ? null : `path ${r.path}`); }
      finally { await b.close(); } } },
  { name: 'up-latin1', run: async (p, h, ctl) => {
      const data = Buffer.from('é');
      ctl.send(upFile(ctl, 'Café.txt', data));
      const b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload(); return sameBytes(r, data) ?? (r.path === 'Café.txt' ? null : `path ${JSON.stringify(r.path)}`); }
      finally { await b.close(); } } },
  { name: 'up-big', run: async (p, h, ctl) => {
      const data = bytes(4194304, 21); const t0 = Date.now();
      ctl.send(upFile(ctl, 'Big.bin', data));
      const b = await connect(p, h, { v: 2 });
      try { return sameBytes(await b.takeUpload({ timeoutMs: 300000 }), data); }
      finally { console.log(`  up-big: 4 MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`); await b.close(); } } },
  { name: 'up-drawer', run: async (p, h, ctl) => {
      upFile(ctl, 'Mods/a.mod', Buffer.from('a')); upFile(ctl, 'Mods/a.mod.info', Buffer.from('i')); upFile(ctl, 'Mods/sub/b.mod', Buffer.from('b'));
      ctl.send(path.join(ctl.dir, 'Mods'));
      const b = await connect(p, h, { v: 2 });
      try {
        const got = [(await b.takeUpload()).path, (await b.takeUpload()).path].sort();
        const extra = await b.maybeLine(1500);
        return JSON.stringify(got) === JSON.stringify(['Mods/a.mod', 'Mods/sub/b.mod']) && extra === null ? null : `got ${got} then ${extra}`;
      } finally { await b.close(); } } },
  { name: 'up-resume', run: async (p, h, ctl) => {
      const data = bytes(100000, 23); const store = new UploadStore();
      const f = upFile(ctl, 'Resume.bin', data);
      ctl.send(f);
      let b = await connect(p, h, { v: 2 });
      const first = await b.takeUpload({ store, dropAfterChunks: 2 });
      if (first.ok || first.code !== 'dropped') return `first try: ${JSON.stringify(first)}`;
      if (!(await waitFor(ctl, /UP_FAILED \d+ local connection lost/))) return 'Receive did not report the dropped connection';
      ctl.send(f);                                               // Retry: a new PUT, resumed from the stored chunks
      b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload({ store }); return r.offset === 32768 ? sameBytes(r, data) : `resumed at ${r.offset}`; }
      finally { await b.close(); } } },
  { name: 'up-crc', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Crc.bin', bytes(20000, 25)));
      const b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload({ crcFault: true }); if (r.ok || r.code !== 'crc') return `got ${JSON.stringify(r)}`;
            return (await waitFor(ctl, /UP_FAILED \d+ crc /)) ? null : 'no crc failure printed'; }
      finally { await b.close(); } } },
  { name: 'up-refused', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Refused.bin', Buffer.from('x')));
      const b = await connect(p, h, { v: 2 });
      try { await b.takeUpload({ refuse: { code: 'full', text: "the web app's area is full" } });
            return (await waitFor(ctl, /UP_FAILED \d+ full the web app's area is full/)) ? null : 'no refusal printed'; }
      finally { await b.close(); } } },
  { name: 'up-v1-board', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Old.txt', Buffer.from('x')));
      const b = await connect(p, h, { v: 1 });
      try { const l = await b.maybeLine(2000); return l === null ? null : `a protocol 1 board got ${JSON.stringify(l)}`; }
      finally { await b.close(); } } },
  { name: 'up-other-key-then-trust', run: async (p, h, ctl) => {
      const b = await connect(p, h, { v: 2, key: BOARD_KEY2 });   // Old.txt still waits from up-v1-board
      try {
        const l = await b.maybeLine(2000);
        if (l !== null) return `another key got ${JSON.stringify(l)}`;
        ctl.trust();
        const r = await b.takeUpload();
        return r.ok && r.path === 'Old.txt' ? null : `after TRUST: ${JSON.stringify(r)}`;
      } finally { await b.close(); } } },
  { name: 'up-cancel-mid-file', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Stop.bin', bytes(200000, 27)));
      const b = await connect(p, h, { v: 2, key: BOARD_KEY2 });   // trusted since the scenario before
      try {
        const put = await b.maybeLine(10000);
        const tag = put && /^PUT (\d+) /.exec(put)?.[1];
        if (!tag) return `no PUT: ${put}`;
        ctl.cancel(tag);                                          // before TAKE: an ABORT, answered NO busy
        const abort = await b.maybeLine(5000);
        return abort === `ABORT ${tag}` ? null : `expected ABORT ${tag}, got ${abort}`;
      } finally { await b.close(); } } },
];

export async function runUploadScenarios(port: number, ctl: UpCtl, opts: { host?: string; only?: string[] } = {}) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const s of UP_SCENARIOS) {
    if (opts.only && !opts.only.includes(s.name)) continue;
    try { const err = await s.run(port, opts.host ?? '127.0.0.1', ctl); out.push({ name: s.name, ok: err === null, detail: err ?? '' }); }
    catch (e) { out.push({ name: s.name, ok: false, detail: String(e) }); }
  }
  return out;
}
```

Move the new `import` line to the top of `scenarios.ts`, beside the existing `import { connect, rawConnect, ... } from './fake-board';`
(merge them: `import { BOARD_KEY2, UploadStore, connect, rawConnect, type SendFile, type Outcome } from './fake-board';`).

- [ ] **Step 3: Write the failing integration test.** In `tools/receive/receive.int.test.ts`:
`start` gains a key-file argument and an stdin pipe:

```ts
function start(dir: string, env: Record<string, string> = {}, keyFile?: string): Promise<{ proc: ChildProcess; port: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [dir, '0', ...(keyFile ? [keyFile] : [])], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
```

(the rest of `start` unchanged), and add inside the `describe`:

```ts
  it('sends files up: small, Latin-1, 4 MB, a drawer, a resume, a CRC fault, a refusal, a v1 board, a key change, a cancel', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'up-'));
    const src = fs.mkdtempSync(path.join(tmp, 'src-'));
    const keyFile = path.join(tmp, 'BoardKey');
    const { proc, port, lines } = await start(dir, {}, keyFile);
    const ctl = {
      dir: src, lines: () => lines,
      send: (p: string) => proc.stdin!.write(`SEND ${p}\n`),
      trust: () => proc.stdin!.write('TRUST\n'),
      cancel: (t: string) => proc.stdin!.write(`CANCEL ${t}\n`),
    };
    try {
      const res = await runUploadScenarios(port, ctl);
      expect(res.filter((r) => !r.ok)).toEqual([]);
      expect(res).toHaveLength(10);
      expect(fs.readFileSync(keyFile, 'utf8').trim()).toBe('fedcba9876543210fedcba9876543210');   // TRUST saved the second key
      expect(lines).toContain('TRUST new 0123');                                                    // first contact
    } finally { proc.kill(); }
  }, 300000);
```

and import `runUploadScenarios` beside `runScenarios`.

Run: `pnpm vitest run tools/receive/receive.int.test.ts`
Expected: the new test FAILS (`rx_posix` takes no key file and ignores stdin).

- [ ] **Step 4: The POSIX build.** Replace `tools/receive/posix/rx_posix.c` with:

```c
/* Receive's host front end: the core over BSD sockets and POSIX files. For tests and CI, not for users.
   Usage: rx_posix <folder> <port> [<key file>]   (port 0 = any; prints "LISTEN <port>")
   stdin: "SEND <host path>" (a file or a folder, as a drop), "TRUST", "CANCEL <tag>" (protocol 2, spec 2026-10-18). */
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
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
#include <time.h>
#include <unistd.h>
#include "rx_proto.h"

typedef struct { const char *root; FILE *fh; FILE *rh; } pctx;

/* folder + "/" + rel, with Latin-1 bytes >= 0x80 as UTF-8 (a host name must be UTF-8 on macOS). */
static void join(pctx *c, const char *rel, char *out, size_t cap) {
    size_t n = (size_t)snprintf(out, cap, "%s/", c->root);
    for (const unsigned char *p = (const unsigned char *)rel; *p && n + 3 < cap; p++) {
        if (*p < 0x80) out[n++] = (char)*p;
        else { out[n++] = (char)(0xC0 | (*p >> 6)); out[n++] = (char)(0x80 | (*p & 0x3F)); }
    }
    out[n] = 0;
}
/* A host name (UTF-8) as the Amiga would name it (Latin-1): two-byte sequences up to U+00FF, anything else '_'. */
static void to_latin1(const char *in, char *out, size_t cap) {
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)in; *p && n + 1 < cap; ) {
        if (*p < 0x80) out[n++] = (char)*p++;
        else if ((*p == 0xC2 || *p == 0xC3) && (p[1] & 0xC0) == 0x80) { out[n++] = (char)(((*p & 3) << 6) | (p[1] & 0x3F)); p += 2; }
        else { out[n++] = '_'; p++; while ((*p & 0xC0) == 0x80) p++; }
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
/* Protocol 2: host paths are given as they are (absolute or from the working folder). */
static int p_is_dir(void *x, const char *local) { struct stat st; (void)x; if (stat(local, &st) != 0) return -1; return S_ISDIR(st.st_mode) ? 1 : 0; }
static int p_list(void *x, const char *local, rx_list_fn each, void *u) {
    DIR *d = opendir(local); struct dirent *e; char p[1024]; struct stat st;
    (void)x;
    if (!d) return -1;
    while ((e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        snprintf(p, sizeof p, "%s/%s", local, e->d_name);
        if (stat(p, &st) != 0) continue;
        each(u, e->d_name, S_ISDIR(st.st_mode));   /* host names as they are: the scenarios' drawers are ASCII */
    }
    closedir(d);
    return 0;
}
static int p_open_r(void *x, const char *local, rx_finfo *info) {
    pctx *c = x; struct stat st;
    if (stat(local, &st) != 0 || S_ISDIR(st.st_mode)) return -1;
    c->rh = fopen(local, "rb");
    if (!c->rh) return -1;
    long t = (long)st.st_mtime - 252460800L;   /* AmigaDOS counts from 1978-01-01 */
    if (t < 0) t = 0;
    info->size = (unsigned long)st.st_size; info->prot = 0;
    info->days = (unsigned long)(t / 86400); info->mins = (unsigned long)(t % 86400 / 60); info->ticks = (unsigned long)(t % 60 * 50);
    info->comment[0] = 0;
    return 0;
}
static long p_read(void *x, unsigned char *b, unsigned long n) { size_t k = fread(b, 1, n, ((pctx *)x)->rh); return ferror(((pctx *)x)->rh) ? -1 : (long)k; }
static void p_close_r(void *x) { pctx *c = x; if (c->rh) { fclose(c->rh); c->rh = NULL; } }

static const char *g_keyfile;
static void on_event(void *u, const rx_event *e) {
    rx_session *s = u;
    char k4[5];
    switch (e->kind) {
    case RX_EV_HELLO: printf("HELLO\n"); break;
    case RX_EV_LIST: printf("LIST %u\n", s->list_n); break;
    case RX_EV_BEGIN: printf("BEGIN %s %s\n", e->id, e->path); break;
    case RX_EV_DONE: printf("DONE %s %s\n", e->id, e->path); break;
    case RX_EV_FAILED: printf("FAILED %s %s\n", e->id, e->text); break;
    case RX_EV_TRUST:
        rx_key4(e->key, k4);
        printf("TRUST %s %s\n", e->code, k4);
        if (!strcmp(e->code, "new") && g_keyfile) { FILE *f = fopen(g_keyfile, "w"); if (f) { fprintf(f, "%s\n", e->key); fclose(f); } }
        break;
    case RX_EV_UP_BEGIN: printf("UP_BEGIN %u %s %lu\n", e->tag, e->path, e->bytes); break;
    case RX_EV_UP_DONE: printf("UP_DONE %u %s\n", e->tag, e->path); break;
    case RX_EV_UP_FAILED: printf("UP_FAILED %u %s %s\n", e->tag, e->code ? e->code : "-", e->text ? e->text : ""); break;
    default: break;
    }
}
static int send_all(int fd, const char *p, size_t n) {
    while (n) { ssize_t w = send(fd, p, n, 0); if (w <= 0) return -1; p += w; n -= (size_t)w; }
    return 0;
}
static void on_added(void *u, const rx_up_item *it) { (void)u; printf("QUEUED %u %s\n", it->tag, it->name); }

/* One stdin command. */
static void command(char *l, rx_upq *q, rx_fs *fs, rx_session *s, int connected) {
    size_t n = strlen(l);
    while (n && (l[n - 1] == '\n' || l[n - 1] == '\r')) l[--n] = 0;
    if (!strncmp(l, "SEND ", 5)) {
        const char *p = l + 5, *base = strrchr(p, '/');
        char name[256];
        to_latin1(base ? base + 1 : p, name, sizeof name);
        if (rx_up_add_tree(q, fs, p, name, on_added, NULL) <= 0) printf("UP_FAILED 0 local cannot read %s\n", p);
    } else if (!strcmp(l, "TRUST")) {
        if (!connected || rx_trust_now(s) != 0) q->trust_next = 1;
    } else if (!strncmp(l, "CANCEL ", 7)) {
        rx_up_cancel(s, q, (unsigned)strtoul(l + 7, NULL, 10));
    }
}

int main(int argc, char **argv) {
    static rx_session S;
    static rx_upq Q;
    static unsigned char buf[8192];
    static char o[8192], in[1024];
    static unsigned in_n;
    pctx ctx = { 0 };
    rx_fs fs = { &ctx, p_folder_ok, p_free, p_exists, p_make_dir, p_open_w, p_write, p_close_w, p_rename, p_remove, p_set_meta,
                 p_is_dir, p_list, p_open_r, p_read, p_close_r };
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    int one = 1, ls, cl = -1, stdin_open = 1;
    time_t last = 0;
    long idle_env = getenv("RX_IDLE_SECS") ? atol(getenv("RX_IDLE_SECS")) : 0;
    char key[80] = "";
    if (argc != 3 && argc != 4) { fprintf(stderr, "usage: rx_posix <folder> <port> [<key file>]\n"); return 2; }
    setvbuf(stdout, NULL, _IOLBF, 0);
    ctx.root = argv[1];
    if (argc == 4) {
        FILE *f = fopen(argv[3], "r");
        g_keyfile = argv[3];
        if (f) { if (fgets(key, sizeof key, f)) key[strcspn(key, "\r\n")] = 0; fclose(f); }
    }
    rx_upq_init(&Q, key);
    rx_init(&S, &fs, on_event, &S);
    ls = socket(AF_INET, SOCK_STREAM, 0);
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(0x7F000001UL) /* 127.0.0.1; INADDR_LOOPBACK is hidden by _POSIX_C_SOURCE on macOS */; a.sin_port = htons((unsigned short)atoi(argv[2]));
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { perror("listen"); return 1; }
    getsockname(ls, (struct sockaddr *)&a, &al);
    printf("LISTEN %d\n", ntohs(a.sin_port));
    for (;;) {
        fd_set r;
        int maxfd = ls, bad = 0;
        FD_ZERO(&r); FD_SET(ls, &r);
        if (stdin_open) FD_SET(0, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (cl > maxfd) maxfd = cl; }
        struct timeval tv = { (cl >= 0 && rx_want_output(&S)) ? 0 : 1, 0 };
        if (select(maxfd + 1, &r, NULL, NULL, &tv) < 0) { if (errno == EINTR) continue; return 1; }
        if (stdin_open && FD_ISSET(0, &r)) {
            ssize_t k = read(0, in + in_n, sizeof in - 1 - in_n);
            if (k <= 0) stdin_open = 0;
            else {
                char *nl;
                in_n += (unsigned)k; in[in_n] = 0;
                while ((nl = strchr(in, '\n')) != NULL) {
                    *nl = 0; command(in, &Q, &fs, &S, cl >= 0);
                    memmove(in, nl + 1, strlen(nl + 1) + 1); in_n = (unsigned)strlen(in);
                }
            }
        }
        /* A peer that went silent (a rebooted board sends no FIN; a scanner just waits) must not hold the slot. */
        if (cl >= 0 && !FD_ISSET(cl, &r) && time(NULL) - last > (idle_env ? idle_env : rx_idle_secs(&S))) {
            rx_disconnected(&S); close(cl); cl = -1; continue;
        }
        /* The connection first: a board's close (EOF) is handled before its reconnect is accepted. */
        if (cl >= 0 && FD_ISSET(cl, &r)) {
            ssize_t n = recv(cl, buf, sizeof buf, 0);
            bad = n <= 0 || rx_feed(&S, buf, (unsigned long)n) != 0;
            last = time(NULL);
        }
        if (cl >= 0 && !bad) {
            while (!bad && rx_want_output(&S)) {
                int k = rx_take_output(&S, o, sizeof o);
                if (k < 0) bad = 1;
                else if (k > 0 && send_all(cl, o, (size_t)k) != 0) bad = 1;
            }
        }
        if (cl >= 0 && bad) { rx_disconnected(&S); close(cl); cl = -1; }
        if (FD_ISSET(ls, &r)) {
            int ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); close(ns); }
                else { cl = ns; last = time(NULL); rx_init(&S, &fs, on_event, &S); rx_attach(&S, &Q); }
            }
        }
    }
}
```

- [ ] **Step 5: Run it.**

```bash
pnpm vitest run tools/receive/receive.int.test.ts
tools/receive/test/run.sh
```

Expected: every test passes, the new one printing `up-big: 4 MB in <n> s`.

- [ ] **Step 6: The README.** In `tools/receive/README.md`, under "Using it", add after the folder-setting bullet:

```markdown
- **Sending to the web app (protocol 2, spec 2026-10-18):** drop icons on the window, press **Send…**, or type
  `Receive SEND DH0:a.lha DH0:Drawer`. A drawer sends its files with their paths under it (64 at most; `.info` files
  only when the icon itself is dropped). Files go only to the board whose key Receive trusts: the first board it hears
  (saved in `ENVARC:webadf/BoardKey`); `TRUST` (or **Trust this board**) accepts another one.
```

and in the Layout table, `posix/rx_posix.c`'s row becomes
`a host build of the receiver, for tests and CI (stdin: SEND <path>, TRUST, CANCEL <tag>)`.

- [ ] **Step 7: Commit.**

```bash
git add tools/receive/posix/rx_posix.c tools/receive/fake-board.ts tools/receive/scenarios.ts tools/receive/receive.int.test.ts tools/receive/README.md
git commit -m "receive: uploads on the POSIX build; the fake board's upload side; ten shared upload scenarios

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 5: Receive on the Amiga: the read side, BoardKey, the output loop, `SEND`/`TRUST` and the hand-off; FS-UAE

**Files:**
- Modify: `tools/receive/amiga/afs.h`, `afs.c`, `config.h`, `config.c`, `net.h`, `net.c` (replaced whole), `shell.c`
  (replaced whole), `main.c` (replaced whole), `ui.h` (replaced whole), `gui.c` (signature only; Task 6 does the window)
- Create: `tools/receive/amiga/ipc.h`, `tools/receive/amiga/ipc.c`, `tools/receive/uae/send-scenarios.ts`
- Modify: `tools/receive/uae/uae-test.sh`

**Interfaces:**
- Consumes: Tasks 2-4 (the core API; `fake-board.ts`'s `connect(..., { v, key })`, `takeUpload`, `UploadStore`, `BOARD_KEY2`).
- Produces: `afs_ctx.rh`; `void afs_base_name(const char *path, char *out)` (RX_PART_MAX + 1); `void cfg_key_load(char *key, unsigned cap)`,
  `int cfg_key_save(const char *key)`; `net_ui` gains `int (*on_pass)(void *u, rx_session *s, int connected)` and
  `void (*on_link)(void *u, int connected)`; `int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s, rx_upq *q)`;
  `int shell_main(const char *dir, STRPTR *send, int trust)`; `int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send)`;
  ipc: `RX_PORT_NAME "webadf.Receive"`, `ipc_running`, `ipc_hand_off`, `ipc_open`, `ipc_sigmask`, `ipc_take`, `ipc_done`, `ipc_close`;
  `uae-test.sh <ks> send`.

- [ ] **Step 1: The read side.** In `tools/receive/amiga/afs.h`, the struct becomes
`typedef struct afs_ctx { char root[256]; BPTR fh; BPTR rh; } afs_ctx;` and add
`void afs_base_name(const char *path, char *out);   /* the last part of an Amiga path, or a volume's name; RX_PART_MAX at most */`.
In `afs.c`, before `afs_set_root`, add:

```c
/* Protocol 2 (spec 2026-10-18 §2): the Amiga's own paths, read with a shared lock in 8 KB blocks. */
static int a_is_dir(void *x, const char *local) {
    BPTR l = Lock((STRPTR)local, SHARED_LOCK); struct FileInfoBlock *fib; int r = -1;
    (void)x;
    if (!l) return -1;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (fib) { if (Examine(l, fib)) r = fib->fib_DirEntryType > 0 ? 1 : 0; FreeDosObject(DOS_FIB, fib); }
    UnLock(l);
    return r;
}
static int a_list(void *x, const char *local, rx_list_fn each, void *u) {
    BPTR l = Lock((STRPTR)local, SHARED_LOCK); struct FileInfoBlock *fib; int r = -1;
    (void)x;
    if (!l) return -1;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (fib && Examine(l, fib) && fib->fib_DirEntryType > 0) {
        r = 0;
        while (ExNext(l, fib)) each(u, (const char *)fib->fib_FileName, fib->fib_DirEntryType > 0);
    }
    if (fib) FreeDosObject(DOS_FIB, fib);
    UnLock(l);
    return r;
}
static int a_open_r(void *x, const char *local, rx_finfo *info) {
    afs_ctx *c = x; struct FileInfoBlock *fib;
    c->rh = Open((STRPTR)local, MODE_OLDFILE);   /* MODE_OLDFILE takes a shared lock */
    if (!c->rh) return -1;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (!fib || !ExamineFH(c->rh, fib) || fib->fib_DirEntryType > 0) {
        if (fib) FreeDosObject(DOS_FIB, fib);
        Close(c->rh); c->rh = 0;
        return -1;
    }
    info->size = (unsigned long)fib->fib_Size; info->prot = (unsigned long)fib->fib_Protection;
    info->days = (unsigned long)fib->fib_Date.ds_Days; info->mins = (unsigned long)fib->fib_Date.ds_Minute;
    info->ticks = (unsigned long)fib->fib_Date.ds_Tick;
    strncpy(info->comment, (const char *)fib->fib_Comment, RX_COMMENT_MAX); info->comment[RX_COMMENT_MAX] = 0;
    FreeDosObject(DOS_FIB, fib);
    return 0;
}
static long a_read(void *x, unsigned char *b, unsigned long n) { LONG got = Read(((afs_ctx *)x)->rh, b, (LONG)n); return got < 0 ? -1 : (long)got; }
static void a_close_r(void *x) { afs_ctx *c = x; if (c->rh) { Close(c->rh); c->rh = 0; } }
void afs_base_name(const char *path, char *out) {
    const char *p = (const char *)FilePart((STRPTR)path), *colon;
    size_t n = strlen(p);
    if (n == 0) {   /* "RAM:" or "DH0:Drawer/": the volume's name */
        colon = strchr(path, ':');
        p = path; n = colon ? (size_t)(colon - path) : strlen(path);
    }
    if (n > RX_PART_MAX) n = RX_PART_MAX;
    memcpy(out, p, n); out[n] = 0;
}
```

and at the end of `afs_init` add
`fs->is_dir = a_is_dir; fs->list = a_list; fs->open_r = a_open_r; fs->read = a_read; fs->close_r = a_close_r;`.

- [ ] **Step 2: The key setting.** In `tools/receive/amiga/config.c`, `write_one` takes the file's name:

```c
static int write_one(const char *base, const char *file, const char *text) {
    char p[64]; BPTR l, f; LONG n = (LONG)strlen(text), w;
    strcpy(p, base); strcat(p, "webadf");
    l = CreateDir((STRPTR)p);
    if (l) UnLock(l);
    strcat(p, "/"); strcat(p, file);
    f = Open((STRPTR)p, MODE_NEWFILE);
    if (!f) return -1;
    w = Write(f, (APTR)text, n);
    Close(f);
    return w == n ? 0 : -1;
}
int cfg_save(const char *dir) {
    write_one("ENV:", "ReceiveDir", dir);
    return write_one("ENVARC:", "ReceiveDir", dir);
}
/* The trusted board's key (spec 2026-10-18 §6): ENVARC:webadf/BoardKey, copied to ENV:. */
void cfg_key_load(char *key, unsigned cap) {
    if (read_file("ENV:webadf/BoardKey", key, cap)) return;
    if (read_file("ENVARC:webadf/BoardKey", key, cap)) return;
    key[0] = 0;
}
int cfg_key_save(const char *key) {
    write_one("ENV:", "BoardKey", key);
    return write_one("ENVARC:", "BoardKey", key);
}
```

and declare both in `config.h`: `void cfg_key_load(char *key, unsigned cap);` and `int cfg_key_save(const char *key);`.

- [ ] **Step 3: The hand-off port.** Create `tools/receive/amiga/ipc.h`:

```c
#ifndef IPC_H
#define IPC_H
/* The public port webadf.Receive (spec 2026-10-18 §2): `Receive SEND <files>` in another Shell hands each file to the
   Receive already running and waits for each one's result, sent back when the file has gone up or failed. */
#include <exec/types.h>
#include "rx_proto.h"
#define RX_PORT_NAME "webadf.Receive"
int ipc_running(void);                                         /* a Receive owns the port */
int ipc_hand_off(const rx_upq *items, int trust, int *ok);     /* client: prints a line per file; 0 when handed over */
int ipc_open(void);                                            /* server: 0 when the port is ours */
ULONG ipc_sigmask(void);
void ipc_take(rx_upq *q, rx_added_fn added, int (*trust)(void *u), void *u);   /* drains the port into q */
void ipc_done(unsigned tag, int ok, unsigned long size, const char *text);    /* a file finished: answer its sender */
void ipc_close(void);                                          /* answers "Receive stopped" to all still waiting */
#endif
```

Create `tools/receive/amiga/ipc.c`:

```c
/* See ipc.h. One message per file; the server holds it until the file is done. Ctrl-C in the waiting Shell sends LETGO:
   the server answers that Shell's messages at once, and the files stay in its list. */
#include <string.h>
#include <exec/memory.h>
#include <exec/ports.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "ipc.h"

enum { RXM_FILE, RXM_TRUST, RXM_LETGO };
typedef struct rx_msg {
    struct Message m;
    int kind;
    char local[RX_LOCAL_MAX + 1], name[RX_PATH_MAX + 1];
    LONG ok; ULONG size; char text[80];
} rx_msg;

static struct MsgPort *port;
static struct { unsigned tag; rx_msg *m; } held[RX_UP_MAX];
static int nheld;

int ipc_running(void) { struct MsgPort *p; Forbid(); p = FindPort((STRPTR)RX_PORT_NAME); Permit(); return p != NULL; }
static int put_msg(rx_msg *m) {
    struct MsgPort *p;
    Forbid(); p = FindPort((STRPTR)RX_PORT_NAME); if (p) PutMsg(p, &m->m); Permit();
    return p ? 0 : -1;
}
static void init_msg(rx_msg *m, struct MsgPort *reply, int kind) {
    memset(m, 0, sizeof *m);
    m->m.mn_ReplyPort = reply; m->m.mn_Length = (UWORD)sizeof *m; m->kind = kind;
}

int ipc_hand_off(const rx_upq *items, int trust, int *ok) {
    static rx_msg ctl;
    struct MsgPort *reply = CreateMsgPort();
    rx_msg *m;
    unsigned i, sent = 0, got = 0;
    int letgo = 0, ctl_out = 0;
    LONG a[2];
    *ok = 0;
    if (!reply) return -1;
    m = AllocVec(sizeof(rx_msg) * (items->n ? items->n : 1), MEMF_PUBLIC | MEMF_CLEAR);
    if (!m) { DeleteMsgPort(reply); return -1; }
    if (trust) { init_msg(&ctl, reply, RXM_TRUST); if (put_msg(&ctl) == 0) { WaitPort(reply); GetMsg(reply); } }
    for (i = 0; i < items->n; i++) {
        init_msg(&m[i], reply, RXM_FILE);
        strcpy(m[i].local, items->q[i].local); strcpy(m[i].name, items->q[i].name);
        if (put_msg(&m[i]) != 0) break;
        sent++;
    }
    for (i = sent; i < items->n; i++) { a[0] = (LONG)items->q[i].name; VPrintf((STRPTR)"%s  ERR Receive stopped\n", a); }
    while (got < sent || ctl_out) {
        ULONG sig = Wait(1UL << reply->mp_SigBit | SIGBREAKF_CTRL_C);
        struct Message *r;
        if ((sig & SIGBREAKF_CTRL_C) && !letgo) {
            init_msg(&ctl, reply, RXM_LETGO);
            if (put_msg(&ctl) == 0) ctl_out = 1;
            letgo = 1;
            PutStr((STRPTR)"Stopped waiting; Receive keeps the files in its list\n");
        }
        while ((r = GetMsg(reply)) != NULL) {
            rx_msg *x = (rx_msg *)r;
            if (x == &ctl) { ctl_out = 0; continue; }
            got++;
            a[0] = (LONG)x->name;
            if (x->ok) { a[1] = (LONG)x->size; VPrintf((STRPTR)"%s  %lu bytes  OK\n", a); (*ok)++; }
            else { a[1] = (LONG)x->text; VPrintf((STRPTR)"%s  ERR %s\n", a); }
            Flush(Output());
        }
    }
    FreeVec(m);
    DeleteMsgPort(reply);
    return sent > 0 ? 0 : -1;
}

int ipc_open(void) {
    struct MsgPort *p;
    if (port) return 0;
    port = CreateMsgPort();
    if (!port) return -1;
    port->mp_Node.ln_Name = (char *)RX_PORT_NAME;
    port->mp_Node.ln_Pri = 0;
    Forbid(); p = FindPort((STRPTR)RX_PORT_NAME); if (!p) AddPort(port); Permit();
    if (p) { DeleteMsgPort(port); port = NULL; return -1; }   /* another Receive owns it */
    return 0;
}
ULONG ipc_sigmask(void) { return port ? 1UL << port->mp_SigBit : 0; }
static void answer(rx_msg *m, int ok, unsigned long size, const char *text) {
    m->ok = ok; m->size = size;
    strncpy(m->text, text ? text : "", sizeof m->text - 1); m->text[sizeof m->text - 1] = 0;
    ReplyMsg(&m->m);
}
void ipc_take(rx_upq *q, rx_added_fn added, int (*trust)(void *u), void *u) {
    rx_msg *m;
    int i;
    if (!port) return;
    while ((m = (rx_msg *)GetMsg(port)) != NULL) {
        if (m->kind == RXM_TRUST) { m->ok = trust && trust(u) == 0; ReplyMsg(&m->m); continue; }
        if (m->kind == RXM_LETGO) {
            for (i = nheld - 1; i >= 0; i--) if (held[i].m->m.mn_ReplyPort == m->m.mn_ReplyPort) {
                answer(held[i].m, 0, 0, "not waited for (still in Receive's list)");
                held[i] = held[--nheld];
            }
            ReplyMsg(&m->m);
            continue;
        }
        {
            unsigned tag = nheld < RX_UP_MAX ? rx_up_add(q, m->local, m->name) : 0;
            if (!tag) { answer(m, 0, 0, "Receive's list is full, or the name is not allowed"); continue; }
            held[nheld].tag = tag; held[nheld].m = m; nheld++;
            if (added) added(u, &q->q[q->n - 1]);
        }
    }
}
void ipc_done(unsigned tag, int ok, unsigned long size, const char *text) {
    int i;
    for (i = 0; i < nheld; i++) if (held[i].tag == tag) { answer(held[i].m, ok, size, text); held[i] = held[--nheld]; return; }
}
void ipc_close(void) {
    rx_msg *m;
    if (!port) return;
    Forbid(); RemPort(port); Permit();
    while (nheld > 0) { nheld--; answer(held[nheld].m, 0, 0, "Receive stopped"); }
    while ((m = (rx_msg *)GetMsg(port)) != NULL) answer(m, 0, 0, "Receive stopped");
    DeleteMsgPort(port);
    port = NULL;
}
```

- [ ] **Step 4: The network loop.** Replace `tools/receive/amiga/net.h`'s `net_ui` and `net_run` with:

```c
typedef struct net_ui {             /* the front end's hooks */
    void *u;
    void (*on_event)(void *u, const rx_event *e, rx_session *s);
    void (*on_status)(void *u, const char *text);
    ULONG extra_sigs;               /* window, AppWindow and port signals; 0 for a plain Shell */
    int (*on_signal)(void *u, ULONG sigs);            /* 1 = quit */
    int (*on_pass)(void *u, rx_session *s, int connected);   /* each pass; 1 = quit; NULL: never */
    void (*on_link)(void *u, int connected);          /* the board connected (1) or went (0); NULL: nothing */
} net_ui;
int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s, rx_upq *q); /* returns when asked to quit; 0 ok, -1 no listen */
```

Replace `tools/receive/amiga/net.c` with:

```c
/* bsdsocket glue shared by both front ends: one listener on RX_PORT, one connection at a time, WaitSelect on the
   sockets plus the front end's signals (Ctrl-C always). The connection is non-blocking, and what the core gives to
   send -- lines, a PUT, one 8 KB block of a file going up -- goes out as the socket takes it, so a slow link never
   freezes the window or Ctrl-C (spec 2026-10-18 §2). */
#include <string.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/socket.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <sys/errno.h>
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
/* Seconds since 1978 from the system clock: enough to tell a connection that went silent. */
static ULONG now_secs(void) {
    struct DateStamp ds;
    DateStamp(&ds);
    return (ULONG)ds.ds_Days * 86400UL + (ULONG)ds.ds_Minute * 60UL + (ULONG)ds.ds_Tick / TICKS_PER_SECOND;
}

static net_ui *cur_ui;
static rx_session *cur_s;
static void relay(void *u, const rx_event *e) { (void)u; cur_ui->on_event(cur_ui->u, e, cur_s); }

static char o[RX_UP_BLOCK];      /* the block going out */
static LONG o_len, o_off;

static void drop(net_ui *ui, rx_session *s, LONG *cl) {
    rx_disconnected(s);
    CloseSocket(*cl);
    *cl = -1;
    o_len = o_off = 0;
    if (ui->on_link) ui->on_link(ui->u, 0);
}

int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s, rx_upq *q) {
    static unsigned char buf[4096];
    struct sockaddr_in a;
    LONG one = 1, ls, cl = -1;
    ULONG last = 0;
    (void)ctx;
    cur_ui = ui; cur_s = s;
    o_len = o_off = 0;
    rx_init(s, fs, relay, NULL);   /* idle until the board connects */
    ls = socket(AF_INET, SOCK_STREAM, 0);
    if (ls < 0) return -1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(RX_PORT); a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { CloseSocket(ls); return -1; }
    ui->on_status(ui->u, "Listening on port 6800");
    for (;;) {
        fd_set r, w;
        ULONG sigs = SIGBREAKF_CTRL_C | ui->extra_sigs;
        struct timeval tv;
        LONG n, maxfd = ls;
        int bad = 0, round;
        FD_ZERO(&r); FD_ZERO(&w); FD_SET(ls, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (o_off < o_len) FD_SET(cl, &w); if (cl > maxfd) maxfd = cl; }
        tv.tv_secs = (cl >= 0 && o_off == o_len && rx_want_output(s)) ? 0 : 1; tv.tv_micro = 0;
        n = WaitSelect(maxfd + 1, &r, &w, NULL, &tv, &sigs);
        if (sigs & SIGBREAKF_CTRL_C) break;
        if ((sigs & ui->extra_sigs) && ui->on_signal(ui->u, sigs)) break;
        if (ui->on_pass && ui->on_pass(ui->u, s, cl >= 0)) break;
        /* A peer that went silent (a rebooted board sends no FIN; a scanner just waits) must not hold the slot. */
        if (cl >= 0 && (n <= 0 || !FD_ISSET(cl, &r)) && now_secs() - last > (ULONG)rx_idle_secs(s)) { drop(ui, s, &cl); continue; }
        /* The connection first: a board's close (EOF) is handled before its reconnect is accepted. */
        if (cl >= 0 && n > 0 && FD_ISSET(cl, &r)) {
            LONG got = recv(cl, buf, sizeof buf, 0);
            if (got > 0) bad = rx_feed(s, buf, (unsigned long)got) != 0;
            else if (got == 0 || Errno() != EWOULDBLOCK) bad = 1;
            last = now_secs();
        }
        for (round = 0; cl >= 0 && !bad && round < 4; round++) {
            if (o_off == o_len) {
                int k;
                if (!rx_want_output(s)) break;
                k = rx_take_output(s, o, sizeof o);
                if (k < 0) { bad = 1; break; }
                o_len = k; o_off = 0;
                if (k == 0) continue;   /* a block read only for the CRC */
            }
            {
                LONG sent = send(cl, (APTR)(o + o_off), o_len - o_off, 0);
                if (sent > 0) o_off += sent;
                else { if (sent < 0 && Errno() != EWOULDBLOCK) bad = 1; break; }
            }
        }
        if (cl >= 0 && bad) drop(ui, s, &cl);
        if (n > 0 && FD_ISSET(ls, &r)) {
            LONG ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); CloseSocket(ns); }
                else {
                    LONG nb = 1;
                    IoctlSocket(ns, FIONBIO, (char *)&nb);
                    cl = ns; last = now_secs(); o_len = o_off = 0;
                    rx_init(s, fs, relay, NULL); rx_attach(s, q);
                    if (ui->on_link) ui->on_link(ui->u, 1);
                }
            }
        }
    }
    if (cl >= 0) drop(ui, s, &cl);
    CloseSocket(ls);
    return 0;
}
```

- [ ] **Step 5: The Shell.** Replace `tools/receive/amiga/shell.c` with:

```c
/* Receive in a Shell (spec 2026-10-16 §5, 2026-10-18 §2): one line per file; Ctrl-C stops. With SEND the files go to
   the web app: handed to a Receive already running (port webadf.Receive), or sent by this run, which listens on 6800
   itself, waits up to 60 s for the board, and returns 0 (all sent), 5 (some) or 10 (none). */
#include <string.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "afs.h"
#include "config.h"
#include "ipc.h"
#include "net.h"
#include "ui.h"

static struct { int send_mode, asked, ok, done, heard, quit; ULONG t0; } sh;
static rx_upq q;
static rx_session sess;

static ULONG secs(void) {
    struct DateStamp d;
    DateStamp(&d);
    return (ULONG)d.ds_Days * 86400UL + (ULONG)d.ds_Minute * 60UL + (ULONG)d.ds_Tick / TICKS_PER_SECOND;
}
static void sh_status(void *u, const char *t) { (void)u; PutStr((STRPTR)t); PutStr((STRPTR)"\n"); Flush(Output()); }
static void sh_event(void *u, const rx_event *e, rx_session *s) {
    LONG a[3]; char k4[5];
    (void)u; (void)s;
    switch (e->kind) {
    case RX_EV_DONE: a[0] = (LONG)e->path; a[1] = (LONG)e->size; VPrintf((STRPTR)"%s  %lu bytes  OK\n", a); break;
    case RX_EV_FAILED: a[0] = (LONG)e->path; a[1] = (LONG)e->text; VPrintf((STRPTR)"%s  ERR %s\n", a); break;
    case RX_EV_HELLO: PutStr((STRPTR)"Board connected\n"); break;
    case RX_EV_TRUST:
        sh.heard = 1;
        rx_key4(e->key, k4); a[0] = (LONG)k4;
        if (!strcmp(e->code, "new")) {
            if (cfg_key_save(e->key) != 0) PutStr((STRPTR)"Could not save the board key to ENVARC:\n");
            VPrintf((STRPTR)"Trusted board %s\n", a);
        } else if (!strcmp(e->code, "ok")) VPrintf((STRPTR)"Board key %s\n", a);
        else if (!strcmp(e->code, "other")) { PutStr((STRPTR)"Another board or computer connected -- not sending\n"); if (sh.send_mode) sh.quit = 1; }
        else { PutStr((STRPTR)"This board's firmware cannot receive files (update to 1.19.0)\n"); if (sh.send_mode) sh.quit = 1; }
        break;
    case RX_EV_UP_DONE:
        a[0] = (LONG)e->path; a[1] = (LONG)e->size; VPrintf((STRPTR)"%s  %lu bytes  OK\n", a);
        sh.ok++; sh.done++; ipc_done(e->tag, 1, e->size, "");
        break;
    case RX_EV_UP_FAILED:
        a[0] = (LONG)e->path; a[1] = (LONG)e->text; VPrintf((STRPTR)"%s  ERR %s\n", a);
        sh.done++; ipc_done(e->tag, 0, 0, e->text);
        break;
    default: break;
    }
    Flush(Output());
}
static int sh_trust(void *u) { (void)u; if (rx_trust_now(&sess) == 0) return 0; q.trust_next = 1; return 0; }
static int sh_signal(void *u, ULONG sigs) { (void)u; if (sigs & ipc_sigmask()) ipc_take(&q, NULL, sh_trust, NULL); return 0; }
static int sh_pass(void *u, rx_session *s, int connected) {
    (void)u; (void)s; (void)connected;
    if (!sh.send_mode) return 0;
    if (sh.quit || sh.done >= sh.asked) return 1;
    if (!sh.heard && secs() - sh.t0 > 60) { PutStr((STRPTR)"No board connected within 60 s\n"); return 1; }
    return 0;
}
static int send_rc(void) { return sh.ok == sh.asked ? RETURN_OK : sh.ok ? RETURN_WARN : RETURN_ERROR; }

int shell_main(const char *dir, STRPTR *send, int trust) {
    static afs_ctx ctx; static rx_fs fs;
    net_ui ui = { NULL, sh_event, sh_status, 0, sh_signal, sh_pass, NULL };
    char key[RX_KEY_HEX + 8];
    LONG args[1];
    int i, rc;
    afs_init(&ctx, &fs, dir);
    cfg_key_load(key, sizeof key);
    rx_upq_init(&q, key);
    if (trust) q.trust_next = 1;
    if (send && send[0]) {
        sh.send_mode = 1;
        for (i = 0; send[i]; i++) {
            char name[RX_PART_MAX + 1];
            int k;
            afs_base_name((const char *)send[i], name);
            k = rx_up_add_tree(&q, &fs, (const char *)send[i], name, NULL, NULL);
            if (k <= 0) { args[0] = (LONG)send[i]; VPrintf((STRPTR)"%s  ERR cannot read it\n", args); sh.asked++; sh.done++; }
            else sh.asked += k;
        }
        if (q.n == 0) return RETURN_ERROR;
        if (ipc_running()) {
            int ok = 0, n = (int)q.n;
            if (ipc_hand_off(&q, trust, &ok) == 0) { sh.ok += ok; sh.done += n; return send_rc(); }
        }
        if (net_open() != 0) { PutStr((STRPTR)"No TCP/IP stack running (bsdsocket.library)\n"); return RETURN_ERROR; }
        PutStr((STRPTR)"Waiting for the board\n"); Flush(Output());
        sh.t0 = secs();
        rc = net_run(&ui, &ctx, &fs, &sess, &q);
        net_close();
        if (rc != 0) { PutStr((STRPTR)"Could not listen on port 6800\n"); return RETURN_ERROR; }
        return send_rc();
    }
    if (net_open() != 0) { PutStr((STRPTR)"No TCP/IP stack running (bsdsocket.library)\n"); return RETURN_FAIL; }
    if (!fs.folder_ok(&ctx)) { PutStr((STRPTR)"Folder not found\n"); net_close(); return RETURN_FAIL; }
    if (ipc_open() == 0) ui.extra_sigs = ipc_sigmask();
    args[0] = (LONG)dir;
    VPrintf((STRPTR)"Receive: saving into %s. Ctrl-C to stop.\n", args);
    rc = net_run(&ui, &ctx, &fs, &sess, &q);
    ipc_close();
    if (rc != 0) { PutStr((STRPTR)"Could not listen on port 6800\n"); net_close(); return RETURN_FAIL; }
    PutStr((STRPTR)"Stopped.\n");
    net_close();
    return RETURN_OK;
}
```

- [ ] **Step 6: The entry point.** Replace `tools/receive/amiga/ui.h` with:

```c
#ifndef UI_H
#define UI_H
#include <exec/types.h>
#include <workbench/startup.h>
int shell_main(const char *dir, STRPTR *send, int trust);
int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send);
#endif
```

Replace `tools/receive/amiga/main.c` with:

```c
/* Receive: files from webadf, through the board, into a folder (spec 2026-10-16 §5), and files from the Amiga to the
   web app (spec 2026-10-18 §2). Template TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S. Started from Workbench it opens the
   window, with any shift-clicked project icons queued to send; GUI with SEND does the same from a Shell. */
#include <string.h>
#include <exec/memory.h>
#include <exec/tasks.h>
#include <workbench/startup.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "config.h"
#include "ui.h"

static const char version[] = "$VER: Receive 2.0 (19.10.2026) webadf";

/* Shell and Workbench starts often give 4 KB of stack; the window, asl and dos calls nest deeper than that. Below
   RX_STACK, run on a stack of our own (exec StackSwap, V37). Everything used across the swap is file-static. */
#define RX_STACK 32768UL
static char dir[256];
static int want_gui, want_trust, rc_swapped;
static STRPTR *send_files;
static struct WBArg *wb_args;
static long wb_n;
static APTR stack_mem;
static struct StackSwapStruct sss;

static int run(void) { return want_gui ? gui_main(dir, wb_args, wb_n, send_files) : shell_main(dir, send_files, want_trust); }

static int run_with_stack(void) {
    struct Task *me = FindTask(NULL);
    if ((ULONG)me->tc_SPUpper - (ULONG)me->tc_SPLower >= RX_STACK) return run();
    stack_mem = AllocVec(RX_STACK, MEMF_ANY);
    if (!stack_mem) return run();
    sss.stk_Lower = stack_mem;
    sss.stk_Upper = (ULONG)stack_mem + RX_STACK;
    sss.stk_Pointer = (APTR)sss.stk_Upper;
    StackSwap(&sss);
    rc_swapped = run();
    StackSwap(&sss);
    FreeVec(stack_mem);
    return rc_swapped;
}

int main(int argc, char **argv) {
    LONG args[5] = { 0, 0, 0, 0, 0 };
    struct RDArgs *rd;
    int rc;
    (void)version;
    if (argc == 0) {   /* Workbench start: libnix passes the WBStartup message as argv */
        struct WBStartup *wb = (struct WBStartup *)argv;
        cfg_load(dir, sizeof dir); want_gui = 1;
        if (wb && wb->sm_NumArgs > 1) { wb_args = wb->sm_ArgList + 1; wb_n = wb->sm_NumArgs - 1; }   /* [0] is Receive */
        return run_with_stack();
    }
    rd = ReadArgs((STRPTR)"TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"Receive"); return RETURN_FAIL; }
    if (args[0]) { strncpy(dir, (const char *)args[0], sizeof dir - 1); } else cfg_load(dir, sizeof dir);
    if (args[1] && cfg_save(dir) != 0) PutStr((STRPTR)"Could not save the folder to ENVARC:\n");
    want_gui = args[2] != 0;
    send_files = (STRPTR *)args[3];
    want_trust = args[4] != 0;
    rc = run_with_stack();
    FreeArgs(rd);   /* after the run: SEND's names live in rd */
    return rc;
}
```

In `tools/receive/amiga/gui.c` (the window itself is Task 6), only make it build: `int gui_main(const char *dir)` becomes
`int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send)` with `(void)wbargs; (void)nwb; (void)send;`
first; add `static rx_upq q;` beside `static rx_session s;` and `rx_upq_init(&q, "");` after `afs_init(&ctx, &fs, dir);`;
`net_ui ui;` gains `ui.on_pass = NULL; ui.on_link = NULL;`; and `net_run(&ui, &ctx, &fs, &s)` becomes
`net_run(&ui, &ctx, &fs, &s, &q)`.

- [ ] **Step 7: Build it.**

Run: `tools/receive/build.sh /tmp/Receive || true`
Expected: no compiler output, then `FAIL: not the pinned binary` (the pin moves in Task 6). A compile error here is
fixed before going on (`-Wall -Werror`).

- [ ] **Step 8: The FS-UAE send mode.** Create `tools/receive/uae/send-scenarios.ts`:

```ts
// The board's side of uae-test.sh's send mode: one step per `Receive SEND` line of the startup-sequence it wrote, in
// the same order. Each step waits for that run to listen on 6800, plays the board, and closes; then the logs (one per
// run, with its return code) and ENVARC:webadf/BoardKey are checked.
// Usage: tsx tools/receive/uae/send-scenarios.ts --hd <the emulated Work: folder>
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_KEY, BOARD_KEY2, UploadStore, connect, rawConnect, type UploadResult } from '../fake-board';

const hd = process.argv[process.argv.indexOf('--hd') + 1];
const up = (n: string) => fs.readFileSync(path.join(hd, 'Up', n));
async function listening(ms = 180000) {
  const t0 = Date.now();
  for (;;) {
    try { const s = await rawConnect(6800); s.destroy(); return; }
    catch { if (Date.now() - t0 > ms) throw new Error('Receive never listened'); await new Promise((r) => setTimeout(r, 500)); }
  }
}
// The run before may still hold the port for a moment as it quits: retry until a READY comes back.
async function board(key = BOARD_KEY, v: 1 | 2 = 2) {
  const t0 = Date.now();
  for (;;) {
    await listening();
    try { return await connect(6800, '127.0.0.1', { v, key }); }
    catch (e) { if (Date.now() - t0 > 180000) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
}
const same = (r: UploadResult, want: Buffer) => (r.ok && Buffer.compare(r.data, want) === 0 ? null : `got ${JSON.stringify({ ...r, data: r.ok ? r.data.length : undefined })}`);
const store = new UploadStore();

const steps: { name: string; run: () => Promise<string | null> }[] = [
  { name: 's01 small (first contact: key saved)', run: async () => { const b = await board(); try { return same(await b.takeUpload({ timeoutMs: 60000 }), up('Hello.txt')); } finally { await b.close(); } } },
  { name: 's02 4 MB', run: async () => { const b = await board(); const t0 = Date.now();
      try { return same(await b.takeUpload({ timeoutMs: 900000 }), up('Big.bin')); } finally { console.log(`  4 MB up in ${((Date.now() - t0) / 1000).toFixed(0)} s`); await b.close(); } } },
  { name: 's03 drawer', run: async () => { const b = await board();
      try { const got = [(await b.takeUpload({ timeoutMs: 60000 })).path, (await b.takeUpload({ timeoutMs: 60000 })).path].sort();
            return JSON.stringify(got) === JSON.stringify(['Mods/a.mod', 'Mods/sub/b.mod']) ? null : `got ${got}`; } finally { await b.close(); } } },
  { name: 's04 resume: the first try is cut', run: async () => { const b = await board();
      const r = await b.takeUpload({ store, dropAfterChunks: 2, timeoutMs: 60000 }); return !r.ok && r.code === 'dropped' ? null : JSON.stringify(r); } },
  { name: 's05 resume: the rest', run: async () => { const b = await board();
      try { const r = await b.takeUpload({ store, timeoutMs: 120000 }); return r.offset === 32768 ? same(r, up('Resume.bin')) : `resumed at ${r.offset}`; } finally { await b.close(); } } },
  { name: 's06 CRC fault', run: async () => { const b = await board(); try { const r = await b.takeUpload({ crcFault: true, timeoutMs: 60000 }); return !r.ok && r.code === 'crc' ? null : JSON.stringify(r); } finally { await b.close(); } } },
  { name: 's07 refused', run: async () => { const b = await board(); try { await b.takeUpload({ refuse: { code: 'full', text: "the web app's area is full" } }); return null; } finally { await b.close(); } } },
  { name: 's08 Latin-1 name', run: async () => { const b = await board();
      try { const r = await b.takeUpload({ timeoutMs: 60000 }); return r.path === 'Café.txt' ? same(r, up('Café.txt')) : `path ${JSON.stringify(r.path)}`; } finally { await b.close(); } } },
  { name: 's09 a protocol 1 board', run: async () => { const b = await board(BOARD_KEY, 1); try { const l = await b.maybeLine(5000); return l === null ? null : `got ${l}`; } finally { await b.close(); } } },
  { name: 's10 another key', run: async () => { const b = await board(BOARD_KEY2); try { const l = await b.maybeLine(5000); return l === null ? null : `got ${l}`; } finally { await b.close(); } } },
  { name: 's11 SEND TRUST', run: async () => { const b = await board(BOARD_KEY2); try { return same(await b.takeUpload({ timeoutMs: 60000 }), up('Hello.txt')); } finally { await b.close(); } } },
  { name: 's12 hand-off to a running Receive', run: async () => { const b = await board(BOARD_KEY2); try { return same(await b.takeUpload({ timeoutMs: 120000 }), up('Hello.txt')); } finally { await b.close(); } } },
];

const logs: [string, RegExp[]][] = [
  ['s01', [/Hello\.txt {2}21 bytes {2}OK/, /rc=0/]], ['s02', [/Big\.bin {2}4194304 bytes {2}OK/, /rc=0/]],
  ['s03', [/Mods\/a\.mod {2}1 bytes {2}OK/, /Mods\/sub\/b\.mod {2}1 bytes {2}OK/, /rc=0/]], ['s04', [/ERR connection lost/, /rc=10/]],
  ['s05', [/Resume\.bin {2}100000 bytes {2}OK/, /rc=0/]], ['s06', [/ERR damaged on the way/, /rc=10/]],
  ['s07', [/ERR the web app's area is full/, /rc=10/]], ['s08', [/bytes {2}OK/, /rc=0/]],
  ['s09', [/cannot receive files \(update to 1\.19\.0\)/, /rc=10/]], ['s10', [/Another board or computer connected -- not sending/, /rc=10/]],
  ['s11', [/Trusted board FEDC/, /rc=0/]], ['s12', [/Hello\.txt {2}21 bytes {2}OK/, /rc=0/]],
];

let fail = 0;
for (const s of steps) {
  let err: string | null;
  try { err = await s.run(); } catch (e) { err = String(e); }
  console.log(`${err === null ? 'PASS' : 'FAIL'} ${s.name}${err ? ': ' + err : ''}`);
  if (err !== null) fail++;
}
for (let i = 0; i < 120 && !fs.existsSync(path.join(hd, 'done')); i++) await new Promise((r) => setTimeout(r, 1000));
for (const [log, want] of logs) {
  const text = fs.existsSync(path.join(hd, `${log}.log`)) ? fs.readFileSync(path.join(hd, `${log}.log`), 'latin1') : '';
  const missing = want.filter((re) => !re.test(text));
  console.log(`${missing.length ? 'FAIL' : 'PASS'} ${log}.log${missing.length ? `: lacks ${missing.join(', ')} -- ${JSON.stringify(text)}` : ''}`);
  if (missing.length) fail++;
}
const key = fs.existsSync(path.join(hd, 'EnvArc/webadf/BoardKey')) ? fs.readFileSync(path.join(hd, 'EnvArc/webadf/BoardKey'), 'latin1').trim() : '';
console.log(`${key === BOARD_KEY2 ? 'PASS' : 'FAIL'} ENVARC:webadf/BoardKey is the key TRUST accepted (${key})`);
if (key !== BOARD_KEY2) fail++;
process.exit(fail ? 1 : 0);
```

In `tools/receive/uae/uae-test.sh`:
- the usage lines (two places) become `uae-test.sh 204|31|32 [shell|gui|space|ram|send]`;
- after `if [ "$mode" = space ]; then ... fi` add:

```bash
if [ "$mode" = send ]; then
  # Uploads (spec 2026-10-18 §10 increment 1): files on Work:Up for twelve `Receive SEND` runs, played by send-scenarios.ts.
  mkdir -p "$work/hd/Up/Mods/sub"
  printf 'hello from the Amiga\n' > "$work/hd/Up/Hello.txt"
  head -c 4194304 /dev/urandom > "$work/hd/Up/Big.bin"
  printf 'a' > "$work/hd/Up/Mods/a.mod"; printf 'i' > "$work/hd/Up/Mods/a.mod.info"; printf 'b' > "$work/hd/Up/Mods/sub/b.mod"
  head -c 100000 /dev/urandom > "$work/hd/Up/Resume.bin"
  head -c 20000 /dev/urandom > "$work/hd/Up/Crc.bin"
  printf 'x' > "$work/hd/Up/Refused.bin"
  printf 'e' > "$work/hd/Up/Café.txt"
fi
```

- in the `case "$mode" in` that sets `run_line`, add (the `$RC` stays literal: `run_line` is substituted once, not re-expanded):

```bash
  send) e9=$(printf '\351')   # é in Latin-1: the Amiga reads the script byte by byte
        run_line=""
        n=0
        for f in Hello.txt Big.bin Mods Resume.bin Resume.bin Crc.bin Refused.bin "Caf${e9}.txt" Hello.txt Hello.txt; do
          n=$((n + 1)); log=$(printf 's%02d' "$n")
          run_line="${run_line}Work:Receive SEND Work:Up/$f >Work:$log.log
Echo >>Work:$log.log "'"rc=$RC"'"
"
        done
        run_line="${run_line}Work:Receive SEND TRUST Work:Up/Hello.txt >Work:s11.log
Echo >>Work:s11.log "'"rc=$RC"'"
Run >NIL: Work:Receive TO Work:Out
Wait 3
Work:Receive SEND Work:Up/Hello.txt >Work:s12.log
Echo >>Work:s12.log "'"rc=$RC"'"
Echo >Work:done done";;
```

- in the last `case "$mode" in`, add:

```bash
  send) pnpm exec tsx "$repo/tools/receive/uae/send-scenarios.ts" --hd "$work/hd" || rc=1;;
```

- [ ] **Step 9: Run the emulator on all three Kickstarts.** One at a time (each boots its own FS-UAE):

```bash
pnpm receive:uae 204 send
pnpm receive:uae 31 send
pnpm receive:uae 32 send
pnpm receive:uae 32 shell
```

Expected: every line `PASS` on all three (`4 MB up in <n> s` printed: record the three times for HANDOFF), and the
protocol 1 regression `uae-test.sh 32 shell` still 16/16. If macOS asks whether FS-UAE may accept incoming
connections, the operator clicks Allow (ask, end the turn).

- [ ] **Step 10: Commit.**

```bash
git add tools/receive/amiga/afs.h tools/receive/amiga/afs.c tools/receive/amiga/config.h tools/receive/amiga/config.c \
        tools/receive/amiga/net.h tools/receive/amiga/net.c tools/receive/amiga/shell.c tools/receive/amiga/main.c \
        tools/receive/amiga/ui.h tools/receive/amiga/gui.c tools/receive/amiga/ipc.h tools/receive/amiga/ipc.c \
        tools/receive/uae/send-scenarios.ts tools/receive/uae/uae-test.sh
git commit -m "receive: SEND and TRUST in the Shell, the hand-off port, BoardKey, a non-blocking output loop; FS-UAE send runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 6: Receive's window: AppWindow drops, Send…, Retry, Trust this board, both directions in the list; the pin

The AppWindow drop and the multi-select requester cannot be driven in FS-UAE from here (as **Choose…** was not in
3bt): they are bench items (Bench B1-B2). This task proves the window builds, opens on 2.04 and 3.1 at 640×200, and
shows an upload and a download together.

**Files:**
- Modify: `tools/receive/amiga/gui.c` (replaced whole), `tools/receive/fake-board.ts` (`delayMoreMs`),
  `tools/receive/uae/gui-demo.ts` (replaced whole), `tools/receive/uae/uae-test.sh` (the `gui` mode's files)
- Modify: `tools/receive/receive.sha256`, `tools/receive/dist/Receive` (the new pinned build)

**Interfaces:**
- Consumes: Task 5 (`net_run` with `on_link`, `ipc_*`, `cfg_key_*`, `afs_base_name`), Task 2-3 core API.
- Produces: `gui_main(dir, wbargs, nwb, send)`: an AppWindow titled "webadf Receive & Send"; buttons Choose…, Send…,
  Retry failed, Trust this board, Save; list states `to web: waiting`, `to web: NN %`, `to web: done`,
  `to web: failed: <reason>`; status lines "Trusted board AB12", "Board connected (key AB12)", "Waiting for the board",
  "Another board or computer connected -- not sending", "This board's firmware cannot receive files (update to 1.19.0)",
  and "Waiting for the web app" while the credit has been stalled 15 s (spec §8). `UploadOpts.delayMoreMs` in `fake-board.ts`. The pinned Receive 2.0 binary.

- [ ] **Step 1: The window.** Replace `tools/receive/amiga/gui.c` with:

```c
/* Receive's window (spec 2026-10-16 §5, 2026-10-18 §2): the folder, the board, and both directions in one list. It is
   an AppWindow: icons dropped on it go to the web app (a drawer walked, 64 files at most); Send... opens an asl
   requester (several files on V38+, one on V37). gadtools, asl and workbench only (V37). */
#include <stdio.h>
#include <string.h>
#include <exec/memory.h>
#include <intuition/intuition.h>
#include <libraries/gadtools.h>
#include <libraries/asl.h>
#include <workbench/workbench.h>
#include <workbench/startup.h>
#include <proto/exec.h>
#include <proto/intuition.h>
#include <proto/gadtools.h>
#include <proto/graphics.h>
#include <proto/asl.h>
#include <proto/dos.h>
#include <proto/wb.h>
#include "afs.h"
#include "config.h"
#include "ipc.h"
#include "net.h"
#include "ui.h"

struct Library *GadToolsBase, *AslBase, *WorkbenchBase;
struct IntuitionBase *IntuitionBase;
struct GfxBase *GfxBase;

enum { G_DIR, G_CHOOSE, G_SEND, G_RETRY, G_TRUST, G_SAVE, G_STATUS, G_LIST, G_N };
#define ROWS_MAX 96
enum { ST_WAITING, ST_RECEIVING, ST_DONE, ST_FAILED, ST_UP_WAITING, ST_UP_MOVING, ST_UP_DONE, ST_UP_FAILED };
typedef struct { struct Node node; char id[RX_ID_MAX + 1]; unsigned tag; char name[RX_PATH_MAX + 1];
                 char local[RX_LOCAL_MAX + 1]; unsigned long size; int state; unsigned pct; char why[40]; char text[80]; } row;

typedef struct {
    struct Window *win; struct Gadget *g[G_N]; APTR vi; struct Screen *scr;
    struct List list; row rows[ROWS_MAX]; int n;
    afs_ctx *ctx; rx_fs *fs; rx_session *s; rx_upq *q;
    struct MsgPort *app_port; struct AppWindow *app_win;
    char status[80]; char pending[256]; int has_pending; int quit; int connected;
    char okstatus[80]; int stalled; ULONG t_wait;   /* spec §8: "waiting for the web app" while the credit is stalled */
    struct Gadget *gl;   /* CreateContext's list: freed after CloseWindow (FirstGadget includes system gadgets) */
} gui;

/* amiga.lib's NewList, without linking amiga.lib. */
static void new_list(struct List *l) { l->lh_Head = (struct Node *)&l->lh_Tail; l->lh_Tail = NULL; l->lh_TailPred = (struct Node *)&l->lh_Head; }

static void set_status(gui *G, const char *t) {
    strncpy(G->status, t, sizeof G->status - 1);
    if (G->win) GT_SetGadgetAttrs(G->g[G_STATUS], G->win, NULL, GTTX_Text, (ULONG)G->status, TAG_END);
}
static void set_trust_button(gui *G, int on) {
    if (G->win) GT_SetGadgetAttrs(G->g[G_TRUST], G->win, NULL, GA_Disabled, (ULONG)(on ? FALSE : TRUE), TAG_END);
}
static unsigned pct_of(unsigned long bytes, unsigned long size) {
    unsigned p = size ? (unsigned)(bytes / (size / 100 + 1)) : 0;
    return p > 99 ? 99 : p;
}
static void row_text(row *r) {
    char nm[23]; const char *base = strrchr(r->name, '/'); size_t l;
    unsigned long kb = (r->size + 1023) / 1024;
    base = base ? base + 1 : r->name;
    strncpy(nm, base, 22); nm[22] = 0;
    l = strlen(nm); while (l < 22) nm[l++] = ' '; nm[22] = 0;
    switch (r->state) {
    case ST_WAITING: sprintf(r->text, "%s %5lu KB  waiting", nm, kb); break;
    case ST_RECEIVING: sprintf(r->text, "%s %5lu KB  receiving %u%%", nm, kb, r->pct); break;
    case ST_DONE: sprintf(r->text, "%s %5lu KB  done", nm, kb); break;
    case ST_FAILED: sprintf(r->text, "%s %5lu KB  failed: %.30s", nm, kb, r->why); break;
    case ST_UP_WAITING: sprintf(r->text, "%s %5lu KB  to web: waiting", nm, kb); break;
    case ST_UP_MOVING: sprintf(r->text, "%s %5lu KB  to web: %u %%", nm, kb, r->pct); break;
    case ST_UP_DONE: sprintf(r->text, "%s %5lu KB  to web: done", nm, kb); break;
    default: sprintf(r->text, "%s %5lu KB  to web: failed: %.20s", nm, kb, r->why); break;
    }
    r->node.ln_Name = r->text;
}
static void relist(gui *G) {
    int i;
    if (G->win) GT_SetGadgetAttrs(G->g[G_LIST], G->win, NULL, GTLV_Labels, ~0UL, TAG_END);
    new_list(&G->list);
    for (i = 0; i < G->n; i++) { row_text(&G->rows[i]); AddTail(&G->list, &G->rows[i].node); }
    if (G->win) GT_SetGadgetAttrs(G->g[G_LIST], G->win, NULL, GTLV_Labels, (ULONG)&G->list, TAG_END);
}
static int active(const row *r) {
    return r->state == ST_WAITING || r->state == ST_RECEIVING || r->state == ST_UP_WAITING || r->state == ST_UP_MOVING;
}
static row *find(gui *G, const char *id) { int i; for (i = 0; i < G->n; i++) if (G->rows[i].id[0] && !strcmp(G->rows[i].id, id)) return &G->rows[i]; return NULL; }
static row *find_tag(gui *G, unsigned tag) { int i; for (i = 0; i < G->n; i++) if (G->rows[i].tag == tag) return &G->rows[i]; return NULL; }
static void drop_at(gui *G, int i) { memmove(&G->rows[i], &G->rows[i + 1], (size_t)(G->n - i - 1) * sizeof(row)); G->n--; }
static row *add(gui *G, const char *id) {
    int i;
    if (G->n == ROWS_MAX) {
        for (i = 0; i < G->n && active(&G->rows[i]); i++) ;
        if (i == G->n) return NULL;
        drop_at(G, i);
    }
    memset(&G->rows[G->n], 0, sizeof(row));
    strcpy(G->rows[G->n].id, id);
    return &G->rows[G->n++];
}

/* --- files going up --- */
static void on_added(void *u, const rx_up_item *it) {
    gui *G = u; row *r = add(G, "");
    if (!r) return;
    r->tag = it->tag; strcpy(r->name, it->name); strcpy(r->local, it->local); r->state = ST_UP_WAITING;
}
static void add_path(gui *G, const char *path) {
    char name[RX_PART_MAX + 1];
    afs_base_name(path, name);
    if (rx_up_add_tree(G->q, G->fs, path, name, on_added, G) <= 0) {
        row *r = add(G, "");
        if (r) { strcpy(r->name, name); strncpy(r->local, path, RX_LOCAL_MAX); r->state = ST_UP_FAILED; strcpy(r->why, "cannot read it"); }
    }
    relist(G);
    if (!G->connected && G->q->n) set_status(G, "Waiting for the board");
}
static void add_wbarg(gui *G, const struct WBArg *a) {
    char p[RX_LOCAL_MAX + 1];
    if (!a->wa_Lock || !NameFromLock(a->wa_Lock, (STRPTR)p, sizeof p)) return;
    if (a->wa_Name && a->wa_Name[0] && !AddPart((STRPTR)p, a->wa_Name, sizeof p)) return;
    add_path(G, p);
}
static void send_files(gui *G) {
    int multi = AslBase->lib_Version >= 38;
    struct FileRequester *fr = AllocAslRequestTags(ASL_FileRequest,
        ASLFR_Window, (ULONG)G->win, ASLFR_TitleText, (ULONG)"Send to the web app",
        multi ? ASLFR_DoMultiSelect : TAG_IGNORE, TRUE, TAG_END);
    char p[RX_LOCAL_MAX + 1];
    LONG i;
    if (!fr) return;
    if (AslRequest(fr, NULL)) {
        if (multi && fr->fr_NumArgs > 0) {
            for (i = 0; i < fr->fr_NumArgs; i++) {
                strncpy(p, (const char *)fr->fr_Drawer, sizeof p - 1); p[sizeof p - 1] = 0;
                if (AddPart((STRPTR)p, fr->fr_ArgList[i].wa_Name, sizeof p)) add_path(G, p);
            }
        } else if (fr->fr_File && fr->fr_File[0]) {
            strncpy(p, (const char *)fr->fr_Drawer, sizeof p - 1); p[sizeof p - 1] = 0;
            if (AddPart((STRPTR)p, fr->fr_File, sizeof p)) add_path(G, p);
        }
    }
    FreeAslRequest(fr);
}
/* Retry (spec §8): every failed upload goes again with a new PUT; the web app resumes what it already has. */
static void retry_failed(gui *G) {
    int i;
    for (i = 0; i < G->n; i++) {
        row *r = &G->rows[i];
        unsigned tag;
        if (r->state != ST_UP_FAILED || !r->local[0]) continue;
        tag = rx_up_add(G->q, r->local, r->name);
        if (tag) { r->tag = tag; r->state = ST_UP_WAITING; r->pct = 0; r->why[0] = 0; }
    }
    relist(G);
}
static int gui_trust(void *u) { gui *G = u; return rx_trust_now(G->s); }

static void on_event(void *u, const rx_event *e, rx_session *s) {
    gui *G = u; row *r; unsigned i; int k;
    char k4[5], t[80];
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
        if ((r = find(G, e->id)) != NULL) r->pct = pct_of(e->bytes, e->size);
        break;
    case RX_EV_DONE:
        if ((r = find(G, e->id)) != NULL) { strcpy(r->name, e->path); r->state = ST_DONE; }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    case RX_EV_FAILED:
        if ((r = find(G, e->id)) != NULL) { r->state = ST_FAILED; strncpy(r->why, e->text ? e->text : "", sizeof r->why - 1); }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    case RX_EV_TRUST:
        rx_key4(e->key, k4);
        if (!strcmp(e->code, "new")) {
            sprintf(t, cfg_key_save(e->key) == 0 ? "Trusted board %s" : "Trusted board %s (not saved: ENVARC:)", k4);
            set_status(G, t); strcpy(G->okstatus, t); set_trust_button(G, 0);
        } else if (!strcmp(e->code, "ok")) {
            sprintf(t, "Board connected (key %s)", k4); set_status(G, t); strcpy(G->okstatus, t); set_trust_button(G, 0);
        }
        else if (!strcmp(e->code, "other")) { set_status(G, "Another board or computer connected -- not sending"); set_trust_button(G, 1); }
        else { set_status(G, "This board's firmware cannot receive files (update to 1.19.0)"); set_trust_button(G, 0); }
        return;
    case RX_EV_UP_BEGIN:
        if (!(r = find_tag(G, e->tag)) && (r = add(G, "")) != NULL) { r->tag = e->tag; strcpy(r->name, e->path); }
        if (r) { r->size = e->size; r->state = ST_UP_MOVING; r->pct = pct_of(e->bytes, e->size); }
        break;
    case RX_EV_UP_PROGRESS:
        if ((r = find_tag(G, e->tag)) != NULL) r->pct = pct_of(e->bytes, e->size);
        break;
    case RX_EV_UP_DONE:
        if ((r = find_tag(G, e->tag)) != NULL) { r->state = ST_UP_DONE; r->size = e->size; }
        ipc_done(e->tag, 1, e->size, "");
        break;
    case RX_EV_UP_FAILED:
        if ((r = find_tag(G, e->tag)) != NULL) { r->state = ST_UP_FAILED; strncpy(r->why, e->text ? e->text : "", sizeof r->why - 1); }
        ipc_done(e->tag, 0, 0, e->text);
        break;
    default: return;
    }
    relist(G);
}
/* net_run reports "Listening on port 6800"; a missing folder says so instead, from the first draw. */
static void on_status(void *u, const char *t) { gui *G = u; set_status(G, G->fs->folder_ok(G->ctx) ? t : "Folder not found"); }
static void on_link(void *u, int connected) {
    gui *G = u;
    G->connected = connected;
    G->stalled = 0; G->t_wait = 0;
    if (!connected) { set_trust_button(G, 0); set_status(G, G->q->n ? "Waiting for the board" : "Listening on port 6800"); }
}
static ULONG secs_now(void) {
    struct DateStamp d;
    DateStamp(&d);
    return (ULONG)d.ds_Days * 86400UL + (ULONG)d.ds_Minute * 60UL + (ULONG)d.ds_Tick / TICKS_PER_SECOND;
}
/* Spec §8: while the board holds the credit (or the last answer) for over 15 s, the web app is what the file waits for. */
static int gui_pass(void *u, rx_session *s, int connected) {
    gui *G = u;
    int waiting = connected && (s->up_phase == RX_UP_ENDED || (s->up_phase == RX_UP_DATA && s->up_sent >= s->up_credit));
    if (!waiting) {
        G->t_wait = 0;
        if (G->stalled) { G->stalled = 0; set_status(G, G->okstatus); }
        return 0;
    }
    if (!G->t_wait) G->t_wait = secs_now();
    else if (!G->stalled && secs_now() - G->t_wait > 15) { G->stalled = 1; set_status(G, "Waiting for the web app"); }
    return 0;
}
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
    int saved;
    strncpy(G->pending, dir_text(G), sizeof G->pending - 1);
    /* Applied for this session even when ENVARC: is read-only (a write-protected boot floppy). */
    if (G->s && rx_busy(G->s)) G->has_pending = 1; else afs_set_root(G->ctx, G->pending);
    saved = cfg_save(G->pending) == 0;
    if (G->has_pending) set_status(G, saved ? "Saved; used after this file" : "Not saved (ENVARC:); used after this file");
    else if (!G->fs->folder_ok(G->ctx)) set_status(G, "Folder not found");
    else set_status(G, saved ? "Saved. Listening on port 6800" : "Not saved (ENVARC:). Listening on port 6800");
}
static int on_signal(void *u, ULONG sigs) {
    gui *G = u; struct IntuiMessage *m; struct AppMessage *am; LONG i;
    (void)sigs;
    while ((m = GT_GetIMsg(G->win->UserPort)) != NULL) {
        ULONG cls = m->Class; struct Gadget *gad = (struct Gadget *)m->IAddress;
        GT_ReplyIMsg(m);
        if (cls == IDCMP_CLOSEWINDOW) G->quit = 1;
        else if (cls == IDCMP_REFRESHWINDOW) { GT_BeginRefresh(G->win); GT_EndRefresh(G->win, TRUE); }
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_CHOOSE) choose(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_SAVE) save(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_SEND) send_files(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_RETRY) retry_failed(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_TRUST && rx_trust_now(G->s) != 0) set_status(G, "No board to trust yet");
    }
    if (G->app_port) while ((am = (struct AppMessage *)GetMsg(G->app_port)) != NULL) {
        for (i = 0; i < am->am_NumArgs; i++) add_wbarg(G, &am->am_ArgList[i]);
        ReplyMsg((struct Message *)am);
    }
    ipc_take(G->q, on_added, gui_trust, G);
    relist(G);
    return G->quit;
}

static UWORD text_w(struct RastPort *rp, const char *s) { return (UWORD)(TextLength(rp, (STRPTR)s, (UWORD)strlen(s)) + 16); }

static int build(gui *G, const char *dir) {
    struct NewGadget ng; struct Gadget *gl = NULL, *g;
    struct TextAttr *ta = G->scr->Font;
    struct TextFont *tf = OpenFont(ta);
    struct RastPort rp;
    UWORD fh = ta->ta_YSize, mw, lw, w, wsend, wretry, wtrust, x0, y, gh, iw, row2;
    InitRastPort(&rp);
    if (tf) SetFont(&rp, tf);
    mw = (UWORD)TextLength(&rp, (STRPTR)"M", 1);
    lw = (UWORD)TextLength(&rp, (STRPTR)"Save files to:", 14) + 8;
    w = text_w(&rp, "Choose...");
    wsend = text_w(&rp, "Send..."); wretry = text_w(&rp, "Retry failed"); wtrust = text_w(&rp, "Trust this board");
    if (tf) CloseFont(tf);
    iw = (UWORD)(56 * mw);
    row2 = (UWORD)(wsend + wretry + wtrust + w + 3 * 6 + 12);   /* the second row's buttons, side by side */
    if (iw < row2) iw = row2;
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
    ng.ng_TopEdge = (WORD)y;
    ng.ng_LeftEdge = (WORD)x0; ng.ng_Width = (WORD)wsend; ng.ng_GadgetText = (UBYTE *)"Send..."; ng.ng_GadgetID = G_SEND;
    G->g[G_SEND] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + wsend + 6); ng.ng_Width = (WORD)wretry; ng.ng_GadgetText = (UBYTE *)"Retry failed"; ng.ng_GadgetID = G_RETRY;
    G->g[G_RETRY] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + wsend + wretry + 12); ng.ng_Width = (WORD)wtrust; ng.ng_GadgetText = (UBYTE *)"Trust this board"; ng.ng_GadgetID = G_TRUST;
    G->g[G_TRUST] = g = CreateGadget(BUTTON_KIND, g, &ng, GA_Disabled, TRUE, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + iw - w - 6); ng.ng_Width = (WORD)w; ng.ng_GadgetText = (UBYTE *)"Save"; ng.ng_GadgetID = G_SAVE;
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
        WA_Title, (ULONG)"webadf Receive & Send", WA_PubScreen, (ULONG)G->scr, WA_Gadgets, (ULONG)gl,
        WA_InnerWidth, iw, WA_InnerHeight, (ULONG)(y + ng.ng_Height + 6 - (G->scr->WBorTop + fh + 1)),
        WA_DragBar, TRUE, WA_DepthGadget, TRUE, WA_CloseGadget, TRUE, WA_Activate, TRUE, WA_SimpleRefresh, TRUE,
        WA_IDCMP, IDCMP_CLOSEWINDOW | IDCMP_REFRESHWINDOW | BUTTONIDCMP | STRINGIDCMP | LISTVIEWIDCMP, TAG_END);
    if (!G->win) { FreeGadgets(gl); G->gl = NULL; return -1; }
    GT_RefreshWindow(G->win, NULL);
    return 0;
}

int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send) {
    static gui G; static afs_ctx ctx; static rx_fs fs; static rx_session s; static rx_upq q;
    char key[RX_KEY_HEX + 8];
    long i;
    int rc = RETURN_FAIL;
    IntuitionBase = (struct IntuitionBase *)OpenLibrary((STRPTR)"intuition.library", 37);
    GfxBase = (struct GfxBase *)OpenLibrary((STRPTR)"graphics.library", 37);
    GadToolsBase = OpenLibrary((STRPTR)"gadtools.library", 37);
    AslBase = OpenLibrary((STRPTR)"asl.library", 37);
    WorkbenchBase = OpenLibrary((STRPTR)"workbench.library", 37);   /* none (no Workbench): no drops, the rest works */
    if (!IntuitionBase || !GfxBase || !GadToolsBase || !AslBase) goto out;
    memset(&G, 0, sizeof G); new_list(&G.list);
    G.ctx = &ctx; G.fs = &fs; G.s = &s; G.q = &q;
    afs_init(&ctx, &fs, dir);
    cfg_key_load(key, sizeof key);
    rx_upq_init(&q, key);
    strcpy(G.status, "Starting...");
    strcpy(G.okstatus, "Listening on port 6800");
    if (!(G.scr = LockPubScreen(NULL)) || !(G.vi = GetVisualInfo(G.scr, TAG_END))) goto out;
    if (build(&G, dir) != 0) goto out;
    if (WorkbenchBase && (G.app_port = CreateMsgPort()) != NULL)
        G.app_win = AddAppWindowA(0, 0, G.win, G.app_port, NULL);
    ipc_open();
    for (i = 0; i < nwb; i++) add_wbarg(&G, &wbargs[i]);           /* shift-clicked project icons */
    for (i = 0; send && send[i]; i++) add_path(&G, (const char *)send[i]);   /* Receive GUI SEND ... */
    if (net_open() != 0) {
        set_status(&G, "No TCP/IP stack running (bsdsocket.library)");
        while (!G.quit) {
            if (Wait(1UL << G.win->UserPort->mp_SigBit | SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) break;
            on_signal(&G, 0);
        }
    } else {
        net_ui ui;
        ui.u = &G; ui.on_event = on_event; ui.on_status = on_status;
        ui.extra_sigs = 1UL << G.win->UserPort->mp_SigBit | (G.app_port ? 1UL << G.app_port->mp_SigBit : 0) | ipc_sigmask();
        ui.on_signal = on_signal; ui.on_pass = gui_pass; ui.on_link = on_link;
        if (net_run(&ui, &ctx, &fs, &s, &q) != 0) {
            /* e.g. Receive is already running: say so and wait for the close gadget, as without a stack. */
            set_status(&G, "Could not listen on port 6800");
            while (!G.quit) {
                if (Wait(1UL << G.win->UserPort->mp_SigBit | SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) break;
                on_signal(&G, 0);
            }
        }
        net_close();
    }
    rc = RETURN_OK;
out:
    ipc_close();
    if (G.app_win) RemoveAppWindow(G.app_win);
    if (G.app_port) { struct Message *m; while ((m = GetMsg(G.app_port)) != NULL) ReplyMsg(m); DeleteMsgPort(G.app_port); }
    if (G.win) CloseWindow(G.win);
    if (G.gl) FreeGadgets(G.gl);
    if (G.vi) FreeVisualInfo(G.vi);
    if (G.scr) UnlockPubScreen(NULL, G.scr);
    if (WorkbenchBase) CloseLibrary(WorkbenchBase);
    if (AslBase) CloseLibrary(AslBase);
    if (GadToolsBase) CloseLibrary(GadToolsBase);
    if (GfxBase) CloseLibrary((struct Library *)GfxBase);
    if (IntuitionBase) CloseLibrary((struct Library *)IntuitionBase);
    return rc;
}
```

- [ ] **Step 2: Build it.** Run: `tools/receive/build.sh /tmp/Receive || true`
Expected: no compiler output (`-Wall -Werror`), then the pin mismatch.

- [ ] **Step 3: A slow board for the screenshot.** In `tools/receive/fake-board.ts`, `UploadOpts` gains
`delayMoreMs?: number;   // wait this long before each MORE (to show progress)`, and in `takeUpload` the line
`sock.write(\`MORE ${head.tag} ${credit}\n\`);` is preceded by
`if (o.delayMoreMs) await new Promise((r) => setTimeout(r, o.delayMoreMs));`.

Replace `tools/receive/uae/gui-demo.ts` with:

```ts
// Fills Receive's window for a screenshot: an upload moving "to web", another waiting, and three downloads waiting
// beside them (a download never moves during an upload: spec §3 arbitration). uae-test.sh's gui mode starts Receive
// with Work:Up/Lemmings.adf and Work:Up/Notes.txt queued.
// Usage: tsx tools/receive/uae/gui-demo.ts   (prints "capture now" while Lemmings.adf goes up)
import { connect } from '../fake-board';

const files = [
  { id: 'w1', path: 'Turrican2.lha', data: Buffer.alloc(420000, 1) },
  { id: 'w2', path: 'mods/axelf.mod', data: Buffer.alloc(58000, 2) },
  { id: 'w4', path: 'Readme.txt', data: Buffer.from('hi') },
];
const b = await connect(6800, '127.0.0.1', { v: 2 });
const up = b.takeUpload({ delayMoreMs: 4000, timeoutMs: 120000 });   // Lemmings.adf goes up slowly
await new Promise((r) => setTimeout(r, 1000));
b.list(files);                                                       // LIST needs no reply, so it may cross the upload
await new Promise((r) => setTimeout(r, 8000));
console.log('capture now');
console.log(JSON.stringify({ ...(await up), data: undefined }));
await b.close();
```

In `tools/receive/uae/uae-test.sh` the `gui)` `run_line` ends with
`Run >NIL: Work:Receive TO $target GUI SEND Work:Up/Lemmings.adf Work:Up/Notes.txt"` instead of
`Run >NIL: Work:Receive TO $target GUI"`, and before that `case` add:

```bash
if [ "$mode" = gui ]; then
  mkdir -p "$work/hd/Up"; head -c 901120 /dev/zero > "$work/hd/Up/Lemmings.adf"; printf 'notes\n' > "$work/hd/Up/Notes.txt"
fi
```

- [ ] **Step 4: Look at it on 2.04 and 3.1.** For each of `204` and `31`: start `pnpm receive:uae <ks> gui` in the
background; when it prints `GUI is up`, run `pnpm exec tsx tools/receive/uae/gui-demo.ts`; at `capture now` take
`screencapture -x -l "$(swift tools/receive/uae/window-id.swift FS-UAE)" <scratchpad>/receive2-<ks>.png`; then
`touch <its work folder>/stop`. Read both PNGs.
Expected: title "webadf Receive & Send"; the second row reads Send… / Retry failed / Trust this board (dimmed) / Save,
inside 640 px; the list shows `Lemmings.adf ... to web: NN %`, `Notes.txt ... to web: waiting` and the three downloads `waiting`;
the status reads "Trusted board 0123". Show the operator both images.

- [ ] **Step 5: Pin the build, and prove the protocol 1 runs still pass.**

```bash
tools/receive/build.sh tools/receive/dist/Receive --pin
tools/receive/build.sh /tmp/Receive
cmp /tmp/Receive tools/receive/dist/Receive && echo SAME
pnpm receive:uae 204 shell
pnpm receive:uae 31 shell
```

Expected: `pinned`, `PASS pinned`, `SAME`, and 16/16 on both Kickstarts.

- [ ] **Step 6: Commit.**

```bash
git add tools/receive/amiga/gui.c tools/receive/fake-board.ts tools/receive/uae/gui-demo.ts tools/receive/uae/uae-test.sh \
        tools/receive/receive.sha256 tools/receive/dist/Receive
git commit -m "receive 2.0: the window -- AppWindow drops, Send..., Retry failed, Trust this board, both directions; new pin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

## Increment 2: firmware 1.19.0 and the server

### Task 7: Firmware: a two-part POST (16 KB bodies, no SRAM copy), the three upload calls, and `upKey`

`dc_post` builds its head into a 640-byte static and sends the caller's body straight from the caller's memory (ruling
P3): the 16 KB chunk goes out of the PSRAM ring with no copy, `DC_POST_BODY_MAX` rises to 16,384, and `.bss` falls by
11,264. Write-back (`uploader.c`) and the NFC calls keep their API.

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h`, `wifi-floppy/firmware/src/device_client.c`
- Modify: `wifi-floppy/firmware/test/test_device_client.c`, `wifi-floppy/firmware/test/transport_fake.c:20`

**Interfaces:**
- Consumes: `http_build_head`, `dc_exchange_i`, `dc_attempt`, `dc_body_sink`, `json` helpers (existing).
- Produces: `#define DC_POST_BODY_MAX 16384`;
  `int dc_upload_open(device_client_t *c, const char *json, char *resp, int resp_cap)` (POST `/api/device/upload`);
  `int dc_upload_chunk(device_client_t *c, const char *id, uint32_t offset, const uint8_t *b, int n, char *resp, int resp_cap)`
  (POST `/api/device/upload/<id>?offset=<o>`, octet-stream); `int dc_upload_close(device_client_t *c, const char *id, const char *json, char *resp, int resp_cap)`
  (POST `/api/device/upload/<id>/close`). Each returns the HTTP status, or -1. `void dc_set_up_key(device_client_t *c, const char *key_hex)`
  (the first 4 hex digits go out as `"upKey"` until a report carrying them is heard); `bool dc_up_key_owed(const device_client_t *c)`.

- [ ] **Step 1: Write the failing tests.** In `wifi-floppy/firmware/test/transport_fake.c:20` raise
`#define FAKE_MAX_REQUEST_BYTES 16384` to `#define FAKE_MAX_REQUEST_BYTES 20480` (a 16 KB body plus its head). In
`wifi-floppy/firmware/test/test_device_client.c`, after `post_sends_a_binary_body_whole`:

```c
// Uploads from the Amiga (plan 2026-10-19 Task 7): a 16 KB chunk goes out as the head, then the caller's bytes.
static void post_sends_a_16k_body_from_the_callers_memory(void) {
    boot();
    static uint8_t body[16384];
    for (int i = 0; i < 16384; i++) body[i] = (uint8_t)(i * 29 + 1);
    push_ok_json("{\"received\":16384}");
    char resp[64];
    CHECK_EQ_INT(dc_upload_chunk(&c, "11111111-2222-4333-8444-555555555555", 0, body, 16384, resp, sizeof resp), 200);
    CHECK(strcmp(resp, "{\"received\":16384}") == 0, "the answer");
    CHECK(strstr(fake_last_request(), "POST /api/device/upload/11111111-2222-4333-8444-555555555555?offset=0 HTTP/1.1") != NULL, "line");
    CHECK(strstr(fake_last_request(), "Content-Type: application/octet-stream") != NULL, "type");
    CHECK(strstr(fake_last_request(), "Content-Length: 16384\r\n") != NULL, "length");
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - 16384, body, 16384) == 0, "the body byte for byte, after the head");
    CHECK_EQ_INT(dc_upload_chunk(&c, "x", 0, body, 16385, resp, sizeof resp), -1);   // over DC_POST_BODY_MAX
    CHECK_EQ_INT(dc_upload_chunk(&c, "x", 0, body, 0, resp, sizeof resp), -1);       // a chunk is never empty
}
static void upload_open_and_close_post_json(void) {
    boot();
    char resp[128];
    push_ok_json("{\"id\":\"u1\",\"offset\":16384}");
    CHECK_EQ_INT(dc_upload_open(&c, "{\"size\":5,\"date\":\"1.2.3\",\"protection\":0,\"path\":\"a\",\"comment\":\"\"}", resp, sizeof resp), 200);
    CHECK(strstr(fake_last_request(), "POST /api/device/upload HTTP/1.1") != NULL, "open line");
    CHECK(strstr(fake_last_request(), "Content-Type: application/json") != NULL, "json");
    CHECK(strstr(resp, "\"offset\":16384") != NULL, "answer");
    push_status_json("HTTP/1.1 409 Conflict", "{\"code\":\"crc\"}");
    CHECK_EQ_INT(dc_upload_close(&c, "u1", "{\"crc32\":907060870}", resp, sizeof resp), 409);
    CHECK(strstr(fake_last_request(), "POST /api/device/upload/u1/close HTTP/1.1") != NULL, "close line");
    CHECK(strstr(fake_last_request(), "\r\n\r\n{\"crc32\":907060870}") != NULL, "close body");
    CHECK(strcmp(resp, "{\"code\":\"crc\"}") == 0, "the refusal's body");
}
// The board key's 4 digits (fw 1.19.0): ride the status reports until one is heard, like lastBoot (plan ruling P13).
static void status_carries_the_up_key_until_heard(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.19.0+gt");
    CHECK(strstr(fake_last_request(), "upKey") == NULL, "not set: no key");
    dc_set_up_key(&c, "ab12cd34ef56ab12cd34ef56ab12cd34");
    CHECK(dc_up_key_owed(&c), "owed");
    fake_push_response("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.19.0+gt");
    CHECK(strstr(fake_last_request(), ",\"upKey\":\"ab12\"") != NULL, "the first 4 digits");
    CHECK(dc_up_key_owed(&c), "a 500 was not heard");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.19.0+gt");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.19.0+gt");
    CHECK(strstr(fake_last_request(), "upKey") == NULL, "heard: not again");
    dc_set_up_key(&c, NULL);
    CHECK(!dc_up_key_owed(&c), "NULL: nothing owed");
}
```

In `test_status_body_fits_at_maximum` (the test with `worst_boot`), after `dc_set_nfc_fail(&c, "bad data:0xFF@FF");` add
`dc_set_up_key(&c, "ab12cd34ef56ab12cd34ef56ab12cd34");`, and after its last `CHECK` on `nfcFail` add:

```c
    // upKey does not fit beside every other tail at its maximum: left out, still owed, never the report (ruling P13).
    CHECK(strstr(r, "\"upKey\"") == NULL, "upKey waits when the body is full");
    CHECK(dc_up_key_owed(&c), "and stays owed for the next report");
```

Register the three new tests in `main` beside `post_sends_a_binary_body_whole`.

Run: `wifi-floppy/firmware/test/run.sh test_device_client.c`
Expected: COMPILE FAIL (`dc_upload_chunk` undeclared).

- [ ] **Step 2: The header.** In `wifi-floppy/firmware/src/device_client.h`:
- replace the `DC_POST_BODY_MAX` comment and value with:

```c
// Largest body dc_post sends in one call: one upload chunk from the Amiga (spec 2026-10-18 §4: 16 KB), more than
// an HD track's sector data (11,264, HD writes spec §4.4). Only the head is built into a static buffer
// (DC_POST_HEAD_BYTES); the body goes out from the caller's memory -- a PSRAM ring, a track in PSRAM -- so the size
// costs no SRAM (plan 2026-10-19 ruling P3; until 1.19.0 the static was head + 11,264).
#define DC_POST_BODY_MAX 16384
```

- after `bool     _nfc_fail_owed;` add:

```c
    // dc_set_up_key (fw 1.19.0): the board key, whose first 4 digits go out as "upKey" until a report is heard.
    const char *_up_key;
    bool     _up_key_owed;
```

- after the `dc_set_nfc_fail` declaration add:

```c
// The board key (32 hex digits, key_store.c), whose first 4 digits are sent as "upKey" until a status report carrying
// them is heard, so the web app can show them beside Receive's "Trusted board AB12" (spec 2026-10-18 §6). A pointer:
// the string must outlive the client. NULL sends nothing.
void dc_set_up_key(device_client_t *c, const char *key_hex);
bool dc_up_key_owed(const device_client_t *c);
```

- after `void dc_set_send(device_client_t *c, uint32_t acked_version, char rx);` add:

```c
// --- Uploads from the Amiga (spec 2026-10-18 §4; amiga_send.c drives these). HTTP status, or -1. resp gets the body.
// POST /api/device/upload with {size, date, protection, path, comment}: 200 {id, offset}, or 4xx {code}.
int dc_upload_open(device_client_t *c, const char *json, char *resp, int resp_cap);
// POST /api/device/upload/<id>?offset=<o> with 1..DC_POST_BODY_MAX raw bytes: 200 {received}, 409 {received}.
int dc_upload_chunk(device_client_t *c, const char *id, uint32_t offset, const uint8_t *b, int n, char *resp, int resp_cap);
// POST /api/device/upload/<id>/close with {crc32}: 200 {name}, or 409 {code}.
int dc_upload_close(device_client_t *c, const char *id, const char *json, char *resp, int resp_cap);
```

- [ ] **Step 3: The two-part exchange.** In `wifi-floppy/firmware/src/device_client.c`:
- `dc_attempt`'s signature gains `const uint8_t *body, int body_len,` after `int req_len,`, and its write loop
  (`int sent = 0; while (sent < req_len) { ... }`) becomes:

```c
    // The request in up to two parts: the head (with any C-string body) from `req`, then a binary `body` straight from
    // the caller's memory (dc_post; plan 2026-10-19 ruling P3: an upload chunk in the PSRAM ring is never copied).
    const uint8_t *part[2] = { (const uint8_t *)req, body };
    const int part_len[2] = { req_len, body ? body_len : 0 };
    for (int k = 0; k < 2; k++) {
        int sent = 0;
        while (sent < part_len[k]) {
            int w = c->t->write(c->t, part[k] + sent, part_len[k] - sent);
            if (w <= 0) {
                dc_abandon(c);
                dc_xfer_end(c, r, DC_XFER_WRITE, w, t0, 0);
                return false;
            }
            sent += w;
        }
    }
```

- `dc_exchange_i`'s signature gains `const uint8_t *body, int body_len,` after `int req_len,`; both of its
  `dc_attempt(c, req, req_len, ...)` calls pass `body, body_len` after `req_len`;
- `dc_exchange` passes `NULL, 0` after `req_len`; the two other `dc_exchange_i(c, req, req_len, ...)` calls (the image
  fetch, ~line 668, and the poll, ~line 2135) pass `NULL, 0` after `req_len`;
- after `dc_exchange` add:

```c
// dc_post's exchange: a head, then a binary body from the caller's memory.
static bool dc_exchange_body(device_client_t *c, const char *head, int head_len, const uint8_t *body, int body_len,
                             void (*sink)(void *ctx, const uint8_t *b, int n), void *sink_ctx, http_resp_t *r) {
    return dc_exchange_i(c, head, head_len, body, body_len, sink, sink_ctx, r, /*retryable=*/true, NULL);
}
```

- replace the body of `dc_post` with:

```c
int dc_post(device_client_t *c, const char *path, const char *content_type,
            const uint8_t *body, int body_len, char *resp, int resp_cap) {
    if (body_len < 0 || body_len > DC_POST_BODY_MAX || (body_len > 0 && !body)) return -1;
    // static: see the STACK note above. The head only: the body is sent from the caller's memory.
    static char head[DC_POST_HEAD_BYTES];
    int n = http_build_head(head, sizeof head, "POST", path, c->host_header, c->token, content_type, body_len);
    if (n < 0) return -1;
    static dc_body_buf_t out;
    out.len = 0; out.truncated = false; out.buf[0] = '\0';
    static http_resp_t r;
    bool ok = dc_exchange_body(c, head, n, body_len ? body : NULL, body_len, dc_body_sink, &out, &r);
    if (resp && resp_cap > 0) snprintf(resp, (size_t)resp_cap, "%s", out.buf);
    if (!ok || !r.body_complete) return -1;
    if (r.status == 401) c->state = DC_HALTED;    // 401 anywhere halts
    return r.status;
}
```

  and in the comment above it, "plus a raw memcpy of `body` rather than http_build_request's C-string body" becomes
  "plus the body sent as a second write from the caller's memory (no copy)".

- after `dc_post_send_done` add:

```c
// --- Uploads from the Amiga (spec 2026-10-18 §4) --------------------------------------------------------------------
// One path buffer for the three: they never nest (amiga_send.c makes one request per as_step). static: see the STACK
// note. The longest is "/api/device/upload/<40-char id>?offset=4294967295" = 77.
static char s_up_path[96];

int dc_upload_open(device_client_t *c, const char *json, char *resp, int resp_cap) {
    return dc_post(c, "/api/device/upload", "application/json", (const uint8_t *)json, (int)strlen(json), resp, resp_cap);
}
int dc_upload_chunk(device_client_t *c, const char *id, uint32_t offset, const uint8_t *b, int n, char *resp, int resp_cap) {
    int pn = snprintf(s_up_path, sizeof s_up_path, "/api/device/upload/%s?offset=%lu", id, (unsigned long)offset);
    if (pn < 0 || pn >= (int)sizeof s_up_path || n <= 0) return -1;
    return dc_post(c, s_up_path, "application/octet-stream", b, n, resp, resp_cap);
}
int dc_upload_close(device_client_t *c, const char *id, const char *json, char *resp, int resp_cap) {
    int pn = snprintf(s_up_path, sizeof s_up_path, "/api/device/upload/%s/close", id);
    if (pn < 0 || pn >= (int)sizeof s_up_path) return -1;
    return dc_post(c, s_up_path, "application/json", (const uint8_t *)json, (int)strlen(json), resp, resp_cap);
}
```

- after `dc_last_boot_owed` add:

```c
void dc_set_up_key(device_client_t *c, const char *key_hex) {
    c->_up_key = key_hex;
    c->_up_key_owed = key_hex != NULL && strlen(key_hex) >= 4;
}
bool dc_up_key_owed(const device_client_t *c) { return c->_up_key_owed; }
```

- in `dc_report_status`, after the `if (c->_nfc_fail_owed) { ... }` block:

```c
    // The board key's first 4 digits (1.19.0), likewise straight into the body, until heard (ruling P13).
    bool key_sent = false;
    if (c->_up_key_owed) {
        int k = snprintf(body + body_len, sizeof body - (size_t)body_len, ",\"upKey\":\"%.4s\"", c->_up_key);
        if (k > 0 && body_len + k + 1 < (int)sizeof body) { body_len += k; key_sent = true; }
        else body[body_len] = '\0';
    }
```

  and after `if (accepted && fail_sent) c->_nfc_fail_owed = false;` add `if (accepted && key_sent) c->_up_key_owed = false;`.

- in the `DC_STATUS_BODY_BYTES` header note (device_client.h), append:
  `upKey (1.19.0) adds ,"upKey":"abcd" -- 15 bytes -- that does not fit beside every other tail at its maximum, so it
  rides like lastBoot: until heard, left out (still owed) when the body is full. The budget is not raised.`

- [ ] **Step 4: Run the tests.**

```bash
wifi-floppy/firmware/test/run.sh test_device_client.c test_uploader.c test_transport_fake.c
wifi-floppy/firmware/test/run.sh
```

Expected: `0 failed` everywhere (write-back's posts are unchanged on the wire).

- [ ] **Step 5: The SRAM it frees.**

```bash
pnpm firmware:build
arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | awk '$1==".bss"{print $2}'
```

Expected: about 421,300 (432,532 - 11,264 + the 96-byte path and a few bytes). Record it in the commit message.

- [ ] **Step 6: Commit.**

```bash
git add wifi-floppy/firmware/src/device_client.h wifi-floppy/firmware/src/device_client.c \
        wifi-floppy/firmware/test/test_device_client.c wifi-floppy/firmware/test/transport_fake.c
git commit -m "fw: dc_post sends head and body as two writes (16 KB bodies, -11,264 B .bss); upload calls; upKey until heard

.bss <measured> (was 432,532).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 8: Firmware: the board key's own flash record

**Files:**
- Create: `wifi-floppy/firmware/src/key_store.h`, `wifi-floppy/firmware/src/key_store.c`, `wifi-floppy/firmware/test/test_key_store.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (the `WF_PNET_L2` source list), `wifi-floppy/firmware/src/drive_store.c` (the top-of-flash map comment)

**Interfaces:**
- Consumes: nothing.
- Produces: `#define KEY_STORE_BYTES 16`; `bool key_store_load(uint8_t out[KEY_STORE_BYTES])`;
  `bool key_store_save(const uint8_t k[KEY_STORE_BYTES])`; `void key_store_hex(const uint8_t k[KEY_STORE_BYTES], char out[2 * KEY_STORE_BYTES + 1])`;
  host-only `key_store_erase_for_test(void)`, `key_store_corrupt_for_test(void)`.

- [ ] **Step 1: Write the failing test.** Create `wifi-floppy/firmware/test/test_key_store.c`:

```c
// key_store.c (plan 2026-10-19 Task 8, ruling P2): the board key survives everything config_store loses.
#include <string.h>
#include "harness.h"
#include "../src/key_store.h"
#include "../src/config_store.h"

static const uint8_t K[KEY_STORE_BYTES] = { 0xab, 0x12, 0xcd, 0x34, 0xef, 0x56, 0xab, 0x12, 0xcd, 0x34, 0xef, 0x56, 0xab, 0x12, 0xcd, 0x34 };

static void nothing_stored_loads_false(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test();
    CHECK(!key_store_load(k), "erased: no key");
}
static void a_saved_key_loads_back(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test();
    CHECK(key_store_save(K), "saved");
    CHECK(key_store_load(k), "loaded");
    CHECK(memcmp(k, K, sizeof k) == 0, "the same bytes");
}
static void a_damaged_record_is_no_key(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test(); key_store_save(K); key_store_corrupt_for_test();
    CHECK(!key_store_load(k), "a flipped byte fails the CRC");
}
static void re_pairing_keeps_the_key(void) {
    uint8_t k[KEY_STORE_BYTES];
    key_store_erase_for_test(); key_store_save(K);
    config_store_erase();                       // what a re-pair and a server change do
    CHECK(key_store_load(k) && memcmp(k, K, sizeof k) == 0, "still there");
}
static void hex_is_lower_case_32_digits(void) {
    char h[2 * KEY_STORE_BYTES + 1];
    key_store_hex(K, h);
    CHECK(strcmp(h, "ab12cd34ef56ab12cd34ef56ab12cd34") == 0, "hex");
}
int main(void) {
    RUN(nothing_stored_loads_false); RUN(a_saved_key_loads_back); RUN(a_damaged_record_is_no_key);
    RUN(re_pairing_keeps_the_key); RUN(hex_is_lower_case_32_digits);
    return REPORT();
}
```

Run: `wifi-floppy/firmware/test/run.sh test_key_store.c`
Expected: COMPILE FAIL (`key_store.h` not found).

- [ ] **Step 2: The store.** Create `wifi-floppy/firmware/src/key_store.h`:

```c
#ifndef KEY_STORE_H
#define KEY_STORE_H
// The board key (spec 2026-10-18 §5-6): 16 random bytes made once (pico_rand, seeded by the RP2350's TRNG), in a
// flash sector of their own (sector -8), so re-pairing and a server change -- which erase config_store -- keep it,
// and an OTA never touches it (plan 2026-10-19 ruling P2). Receive trusts the board by it. Same two backings and
// record shape as drive_store.c. When to write is the caller's decision (drive_store_should_write's rule).
#include <stdbool.h>
#include <stdint.h>
#define KEY_STORE_BYTES 16
bool key_store_load(uint8_t out[KEY_STORE_BYTES]);        // false: nothing valid stored
bool key_store_save(const uint8_t k[KEY_STORE_BYTES]);    // false on a flash error
void key_store_hex(const uint8_t k[KEY_STORE_BYTES], char out[2 * KEY_STORE_BYTES + 1]);   // lower-case hex
#ifdef WFMF_HOST_TEST
void key_store_erase_for_test(void);
void key_store_corrupt_for_test(void);
#endif
#endif
```

Create `wifi-floppy/firmware/src/key_store.c`:

```c
// See key_store.h. Record layout, one program page: magic(4) . key(16) . crc32(4); the CRC covers the key.
#include "key_store.h"
#include <string.h>

#define KEY_MAGIC 0x4B424657u   // "WFBK" in memory order
#define KEY_RECORD_LEN (4 + KEY_STORE_BYTES + 4)

static void write_u32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }
static uint32_t read_u32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint32_t crc32_bitwise(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) { uint32_t mask = -(crc & 1u); crc = (crc >> 1) ^ (0xEDB88320u & mask); }
    }
    return ~crc;
}
static bool page_load(const uint8_t *page, size_t len, uint8_t out[KEY_STORE_BYTES]) {
    if (len < KEY_RECORD_LEN || read_u32(page) != KEY_MAGIC) return false;
    if (crc32_bitwise(page + 4, KEY_STORE_BYTES) != read_u32(page + 4 + KEY_STORE_BYTES)) return false;
    memcpy(out, page + 4, KEY_STORE_BYTES);
    return true;
}
static bool page_build(uint8_t *out, size_t len, const uint8_t k[KEY_STORE_BYTES]) {
    if (len < KEY_RECORD_LEN) return false;
    memset(out, 0xFF, len);
    write_u32(out, KEY_MAGIC);
    memcpy(out + 4, k, KEY_STORE_BYTES);
    write_u32(out + 4 + KEY_STORE_BYTES, crc32_bitwise(k, KEY_STORE_BYTES));
    return true;
}
void key_store_hex(const uint8_t k[KEY_STORE_BYTES], char out[2 * KEY_STORE_BYTES + 1]) {
    static const char d[] = "0123456789abcdef";
    for (int i = 0; i < KEY_STORE_BYTES; i++) { out[2 * i] = d[k[i] >> 4]; out[2 * i + 1] = d[k[i] & 15]; }
    out[2 * KEY_STORE_BYTES] = 0;
}

#ifndef WFMF_HOST_TEST
#include "hardware/flash.h"
#include "hardware/address_mapped.h"   // XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE
#include "pico/flash.h"                // flash_safe_execute

// Sector -8: -1..-6 are the stores (drive_store.c's map), -7 the boot trail's update trail (boot_trail_hw.c).
#define KEY_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - 8 * FLASH_SECTOR_SIZE)
#define KEY_STORE_CAP    FLASH_PAGE_SIZE

typedef struct { const uint8_t *data; size_t len; } program_args_t;
static void do_program(void *param) {
    program_args_t *a = param;
    flash_range_erase(KEY_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(KEY_FLASH_OFFSET, a->data, a->len);
}
bool key_store_load(uint8_t out[KEY_STORE_BYTES]) {
    // NOTRANSLATE: see config_store_load() (partitioned boots fault on XIP_BASE).
    const uint8_t *p = (const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE + KEY_FLASH_OFFSET);
    return page_load(p, KEY_STORE_CAP, out);
}
bool key_store_save(const uint8_t k[KEY_STORE_BYTES]) {
    static uint8_t page[KEY_STORE_CAP];   // static: see config_store_save()
    if (!page_build(page, sizeof page, k)) return false;
    program_args_t args = { page, sizeof page };
    return flash_safe_execute(do_program, &args, 1000) == PICO_OK;
}
#else   // WFMF_HOST_TEST
static uint8_t g_page[KEY_RECORD_LEN];
static bool g_init;
static void ensure_init(void) { if (!g_init) { memset(g_page, 0xFF, sizeof g_page); g_init = true; } }
bool key_store_load(uint8_t out[KEY_STORE_BYTES]) { ensure_init(); return page_load(g_page, sizeof g_page, out); }
bool key_store_save(const uint8_t k[KEY_STORE_BYTES]) { ensure_init(); return page_build(g_page, sizeof g_page, k); }
void key_store_erase_for_test(void) { memset(g_page, 0xFF, sizeof g_page); g_init = true; }
void key_store_corrupt_for_test(void) { ensure_init(); g_page[5] ^= 0xFF; }
#endif
```

In `wifi-floppy/firmware/CMakeLists.txt`, the line `list(APPEND WFMF_FIRMWARE_SOURCES src/amiga_send.c src/amiga_tcp.c)`
becomes `list(APPEND WFMF_FIRMWARE_SOURCES src/amiga_send.c src/amiga_tcp.c src/key_store.c)`, and its comment line
gains `; uploads (fw 1.19.0) and the board key`. In `drive_store.c`'s map comment, after `//   -6 override_store.c` add
`//   -7 boot_trail_hw.c (update trail)   -8 key_store.c (the board key, fw 1.19.0)` and change "all six" to "all eight".

- [ ] **Step 3: Run the tests.** Run: `wifi-floppy/firmware/test/run.sh test_key_store.c test_config_store.c`
Expected: `0 failed` in both.

- [ ] **Step 4: Commit.**

```bash
git add wifi-floppy/firmware/src/key_store.h wifi-floppy/firmware/src/key_store.c wifi-floppy/firmware/test/test_key_store.c \
        wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/src/drive_store.c
git commit -m "fw: the board key's own flash record (sector -8): survives re-pairing, a server change and OTA

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 9: Firmware: amiga_send protocol 2 -- the key in the hello, READY 2, the raw window, PUT parsing

**Files:**
- Modify: `wifi-floppy/firmware/src/amiga_send.h` (replaced whole), `wifi-floppy/firmware/src/amiga_send.c`
- Modify: `wifi-floppy/firmware/test/test_amiga_send.c`

**Interfaces:**
- Consumes: `as_json_escape` (existing), `json_str`/`json_u32_strict` (json_scan.h).
- Produces (amiga_send.h): `AS_KEY_HEX` 32, `AS_TAG_MAX` 9, `AS_UP_FILE_MAX` 4,194,304, `AS_UP_WINDOW_CHUNKS` (default 2,
  from Task 1), `AS_UP_RING_BYTES`, `AS_UP_OOSEQ_BYTES` (default 2,920, from Task 1), `AS_UP_OPEN_GIVEUP_MS` 60,000,
  `AS_UP_STALL_MS` 120,000, `AS_UP_JSON_MAX` 2,200, `AS_UP_RESP_MAX` 768; `as_raw_t`; `as_put_t`; `as_up_t`;
  `as_ops_t` gains `upload_open`, `upload_chunk`, `upload_close`, `raw_arm`; phases `AS_UP_OPEN`, `AS_UP_DATA`,
  `AS_UP_CLOSE`; `amiga_send_t` gains `as_up_t *up; uint8_t peer_v; bool up_last;`;
  `void as_init(amiga_send_t *s, const as_ops_t *ops, char *queue_buf, uint8_t *chunk_buf, as_up_t *up)` (chunk_buf is
  now `AS_UP_RING_BYTES`); `void as_set_key(amiga_send_t *s, const char *hex32)`;
  `int as_raw_feed(as_raw_t *w, const uint8_t *b, int n)`; `int as_utf8_to_latin1(const char *in, char *out, int cap)`;
  `bool as_put_parse(const char *line, as_put_t *out)`; `int as_put_json(const as_put_t *p, char *json, int cap)`.

- [ ] **Step 1: The header.** Replace `wifi-floppy/firmware/src/amiga_send.h` with:

```c
#ifndef AMIGA_SEND_H
#define AMIGA_SEND_H
// PaulaNET Phase 4 (spec docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md §2-3): files
// queued on the server for this board go to Receive on the Amiga. The board connects to the Amiga's TCP 6800 over
// the PaulaNET local path, says hello, forwards the server's LIST block, then for the queue's NEXT file sends FILE,
// waits for GO, streams the file chunk by chunk from the server, and posts Receive's OK or ERR back to the server.
// Protocol 2 (spec 2026-10-18-amiga-to-web-upload-design.md §3, §5; fw 1.19.0): Receive 2 offers files with PUT; the
// board opens an upload on the server, lands Receive's raw bytes in a PSRAM ring within a credit (TAKE/MORE), posts
// each 16 KB chunk, and closes the upload at END (DONE or NO).
//
// Pure: every socket and HTTPS call goes through as_ops_t (amiga_tcp.c on the board, a scripted fake in
// test/test_amiga_send.c). RULE: no pico-sdk or lwIP header here -- it is compiled into every host test.
//
// ONE HTTPS REQUEST PER as_step(), and none from as_tick(): the board has one HTTPS connection, shared with the poll
// and the uploader. core1 calls as_tick() every pass and, while as_has_work(), as_step() instead of the long poll.
#include <stdbool.h>
#include <stdint.h>

#define AS_PORT 6800
#define AS_QUEUE_BYTES 6144          // = the server's SEND_QUEUE_BYTES
#define AS_CHUNK_BYTES 16384         // = the server's SEND_CHUNK_MAX and UPLOAD_CHUNK
#define AS_LINE_MAX 640              // = Receive's RX_LINE_MAX: the longest legal FILE line is 398
#define AS_ID_MAX 40
#define AS_RETRY_WAITING_MS 5000u    // reconnect cadence while a file waits
#define AS_RETRY_IDLE_MS 30000u      // ... and while nothing does (so the card can say whether Receive runs)
#define AS_CONNECT_MS 10000u
#define AS_HELLO_MS 10000u
#define AS_GO_MS 30000u
#define AS_PING_MS 30000u
#define AS_PONG_MS 10000u
#define AS_BACKOFF_MIN_MS 1000u      // a failed HTTPS call waits this long, doubling
#define AS_BACKOFF_MAX_MS 30000u     //   to this; the board long-polls meanwhile

// Uploads (protocol 2, spec 2026-10-18 §3, §5).
#define AS_KEY_HEX 32                // the board key in the hello
#define AS_TAG_MAX 9                 // Receive's tag: 1-9 decimal digits
#define AS_UP_FILE_MAX 4194304u      // = Receive's RX_FILE_MAX and the server's UPLOAD_FILE_MAX
#ifndef AS_UP_WINDOW_CHUNKS
#define AS_UP_WINDOW_CHUNKS 2u       // the credit window in chunks (spec §3: 32 KB). From plan 2026-10-19 Task 1's measurement.
#endif
#define AS_UP_RING_BYTES (AS_UP_WINDOW_CHUNKS * AS_CHUNK_BYTES)   // the caller's chunk buffer is this big
#ifndef AS_UP_OOSEQ_BYTES
#define AS_UP_OOSEQ_BYTES 2920u      // out-of-order bytes lwIP may hold for the Amiga's pcb (two segments). From Task 1.
#endif
#define AS_UP_OPEN_GIVEUP_MS 60000u  // the server never answered the open: NO offline (spec §8, about 60 s)
#define AS_UP_STALL_MS 120000u       // no progress this long: NO offline (spec §5)
#define AS_UP_JSON_MAX 2200          // the open body at its worst: 255 path and 79 comment bytes, each \u00XX
#define AS_UP_RESP_MAX 768           // the server's answer (the stored name, UTF-8, escaped)

enum { AS_SOCK_CLOSED, AS_SOCK_CONNECTING, AS_SOCK_OPEN, AS_SOCK_REFUSED };

// An upload's raw section: Receive's bytes land in the ring from the TCP receive callback (amiga_tcp.c calls
// as_raw_feed in lwIP's context), never past the credit. got is written only by as_raw_feed, limit only by the engine.
typedef struct as_raw {
    uint8_t *ring;               // AS_UP_RING_BYTES: chunk k is at (k % AS_UP_WINDOW_CHUNKS) * AS_CHUNK_BYTES
    uint32_t total;              // bytes in the raw section (size - the resume offset)
    volatile uint32_t limit;     // the credit, relative to the section's start
    volatile uint32_t got;       // bytes landed
    volatile bool broken;        // a byte past the credit came: Receive broke the protocol
} as_raw_t;

// "PUT <tag> <size> <days>.<mins>.<ticks> <prot hex> <len>:<path> <len>:<comment>", parsed. path and comment point
// into the line (Latin-1, not NUL-terminated).
typedef struct as_put {
    char tag[AS_TAG_MAX + 1];
    uint32_t size, prot;
    char date[24];
    const char *path; int path_n;
    const char *comment; int comment_n;
} as_put_t;

// The upload's state: the caller's, in PSRAM on the board (plan ruling P1).
typedef struct as_up {
    as_raw_t raw;
    char key[AS_KEY_HEX + 1];        // the board key for the hello; "" = protocol 1 only
    bool pending;                    // a PUT waits for its turn
    bool aborted;                    // Receive sent ABORT for it
    char put[AS_LINE_MAX + 1];       // that PUT as Receive sent it
    char tag[AS_TAG_MAX + 1];
    char id[AS_ID_MAX + 1];          // the server's upload id
    uint32_t size, start, posted, crc, last_got, t_open, t_progress;   // start: the server's offset at open; posted: absolute
    bool end_seen;
    char json[AS_UP_JSON_MAX];       // the open body, then the close body; after the close, scratch
    char resp[AS_UP_RESP_MAX];       // the server's answer
    char line[AS_LINE_MAX + 8];      // the hello, TAKE, MORE, DONE or NO going out
} as_up_t;

typedef struct as_ops {
    void *ctx;
    int  (*connect)(void *ctx, uint32_t ip_host_order, uint16_t port);   // 0 = started, <0 = could not start
    int  (*sock_state)(void *ctx);                                        // AS_SOCK_*
    int  (*send)(void *ctx, const uint8_t *b, int n);    // bytes accepted now (0..n), <0 = broken
    int  (*recv_line)(void *ctx, char *out, int cap);    // 1 = a line (no LF), 0 = none yet, <0 = closed
    void (*close)(void *ctx);
    int  (*fetch_queue)(void *ctx, char *buf, int cap);  // body length, <0 = failed
    int  (*fetch_chunk)(void *ctx, const char *id, uint32_t off, uint32_t len, uint8_t *buf); // bytes, or -status/-1
    int  (*post_done)(void *ctx, const char *id, const char *json);      // http status, <0 = failed
    uint32_t (*now_ms)(void *ctx);
    // Protocol 2. Each is one HTTPS request: http status, <0 failed; resp gets the body.
    int  (*upload_open)(void *ctx, const char *json, char *resp, int cap);
    int  (*upload_chunk)(void *ctx, const char *id, uint32_t off, const uint8_t *b, uint32_t n, char *resp, int cap);
    int  (*upload_close)(void *ctx, const char *id, const char *json, char *resp, int cap);
    // The raw section starts with the next byte from the Amiga (NULL: none). Armed before the TAKE goes out.
    void (*raw_arm)(void *ctx, as_raw_t *w);
} as_ops_t;

typedef enum { AS_IDLE, AS_CONNECTING, AS_HELLO, AS_READY, AS_FILE_SENT, AS_DATA, AS_AWAIT_OK,
               AS_UP_OPEN, AS_UP_DATA, AS_UP_CLOSE } as_phase_t;

// One instance. Fields are private to amiga_send.c. The big buffers are the caller's: on the board they live in PSRAM
// (main.c), because SRAM would come straight out of the heap TLS allocates from.
typedef struct amiga_send {
    const as_ops_t *ops;
    bool net_on;
    uint32_t ip;
    uint32_t want_version, have_version;
    bool fetched_once, force_fetch;
    as_phase_t phase;
    char rx;
    uint32_t t_phase, t_retry, t_ping;
    bool ping_out;
    char *queue;                     // AS_QUEUE_BYTES + 1, the caller's
    int queue_len;
    bool list_owed;
    const uint8_t *out_p;            // bytes still to push (a line, the LIST block, a chunk)
    int out_n;
    char out_line[AS_LINE_MAX + 8];
    char id[AS_ID_MAX + 1];
    uint32_t size, off, chunk_len;
    uint8_t *chunk;                  // AS_UP_RING_BYTES, the caller's (sends use the first AS_CHUNK_BYTES)
    char done_id[AS_ID_MAX + 1];
    char done_json[480];
    bool done_owed;
    uint32_t backoff_ms, t_backoff;  // after a failed HTTPS call: no work until t_backoff
    char line[AS_LINE_MAX + 1];
    as_up_t *up;                     // the caller's (PSRAM); NULL: no uploads
    uint8_t peer_v;                  // Receive's READY: 1 or 2 (0 before)
    bool up_last;                    // the last file to finish went up: a waiting download goes next (spec §3)
} amiga_send_t;

// queue_buf: AS_QUEUE_BYTES + 1 bytes; chunk_buf: AS_UP_RING_BYTES. Either NULL disables sending (no PSRAM).
// up: NULL disables uploads (the hello stays protocol 1).
void as_init(amiga_send_t *s, const as_ops_t *ops, char *queue_buf, uint8_t *chunk_buf, as_up_t *up);
// The board key (32 lower-case hex digits); anything else keeps the hello at protocol 1.
void as_set_key(amiga_send_t *s, const char *hex32);
// From core1 each pass: Network mode on, the Amiga's address (0 = none yet), the poll's xfer.v.
void as_set_inputs(amiga_send_t *s, bool net_on, uint32_t amiga_ip, uint32_t queue_version);
// Cheap, every pass, never an HTTPS request: connect retries, the handshake, pings, Receive's replies, pushing bytes.
void as_tick(amiga_send_t *s);
// True while a file is moving either way, a reply is awaited, the queue must be fetched, an outcome posted, or a PUT
// waits: skip the long poll. False during a backoff (the long poll runs; plan ruling P9).
bool as_has_work(const amiga_send_t *s);
// One bounded unit of work: at most one HTTPS request. Returns whether anything moved (false: core1 may pause).
bool as_step(amiga_send_t *s);
char as_rx(const amiga_send_t *s);               // 'c' connected, 'r' refused, 'u' unreachable, '-' unknown/off
uint32_t as_acked_version(const amiga_send_t *s);// the queue version last fetched: the poll's xferAck
// JSON string body: '"' and '\\' escaped, control and non-ASCII bytes as \u00XX. Cut to fit (whole escapes only):
// returns the length written.
int as_json_escape(char *dst, int cap, const char *src, int n);
// lwIP's context: n bytes from the Amiga. Returns how many belong to the raw section (0..n; the rest are lines),
// or -1 when one would pass the credit (w->broken is set).
int as_raw_feed(as_raw_t *w, const uint8_t *b, int n);
// The server's UTF-8 (every character <= U+00FF) as Latin-1; anything else '?'. Returns the length.
int as_utf8_to_latin1(const char *in, char *out, int cap);
bool as_put_parse(const char *line, as_put_t *out);
// The open's JSON: {"size":..,"date":"..","protection":..,"path":"..","comment":".."}; length, or -1 if it cannot fit.
int as_put_json(const as_put_t *p, char *json, int cap);

#endif
```

- [ ] **Step 2: Write the failing tests.** In `wifi-floppy/firmware/test/test_amiga_send.c`:

The fake gains upload state. In the `static struct { ... } F;` add before `uint32_t now;`:

```c
    as_raw_t *raw; int arms;                           // the armed raw section (amiga_tcp.c's role)
    char partial[AS_LINE_MAX + 1]; int partial_n;      // a line from the Amiga being built
    int opens, open_status; char open_json[AS_UP_JSON_MAX]; char open_resp[256];
    int chunks, chunk_status; uint32_t chunk_offs[300], chunk_lens[300]; uint8_t stored[200000]; uint32_t stored_len;
    int lose_answer;                                   // the next chunk is stored but answered -1 (a lost answer)
    int closes, close_status; char close_json[128]; char close_resp[512];
```

Add the fake ops after `f_now`:

```c
static int f_up_open(void *c, const char *json, char *resp, int cap) {
    (void)c; F.opens++; snprintf(F.open_json, sizeof F.open_json, "%s", json);
    snprintf(resp, (size_t)cap, "%s", F.open_resp[0] ? F.open_resp : "{\"id\":\"u1\",\"offset\":0}");
    return F.open_status ? F.open_status : 200;
}
static int f_up_chunk(void *c, const char *id, uint32_t off, const uint8_t *b, uint32_t n, char *resp, int cap) {
    (void)c; (void)id;
    if (F.chunks < 300) { F.chunk_offs[F.chunks] = off; F.chunk_lens[F.chunks] = n; }
    F.chunks++;
    if (F.chunk_status) { snprintf(resp, (size_t)cap, "{\"received\":%lu}", (unsigned long)F.stored_len); return F.chunk_status; }
    if (off == F.stored_len) { memcpy(F.stored + off, b, n); F.stored_len += n; }   // a retry of a stored chunk adds nothing
    else if (off > F.stored_len) { snprintf(resp, (size_t)cap, "{\"received\":%lu}", (unsigned long)F.stored_len); return 409; }
    snprintf(resp, (size_t)cap, "{\"received\":%lu}", (unsigned long)F.stored_len);
    if (F.lose_answer) { F.lose_answer = 0; return -1; }
    return 200;
}
static int f_up_close(void *c, const char *id, const char *json, char *resp, int cap) {
    (void)c; (void)id; F.closes++; snprintf(F.close_json, sizeof F.close_json, "%s", json);
    snprintf(resp, (size_t)cap, "%s", F.close_resp[0] ? F.close_resp : "{\"name\":\"Hello.txt\"}");
    return F.close_status ? F.close_status : 200;
}
static void f_raw_arm(void *c, as_raw_t *w) { (void)c; F.raw = (w && w->got < w->total) ? w : NULL; F.arms++; }
```

`OPS` becomes
`static const as_ops_t OPS = { NULL, f_connect, f_state, f_send, f_recv, f_close, f_queue, f_chunk, f_post, f_now, f_up_open, f_up_chunk, f_up_close, f_raw_arm };`,
`CBUF` becomes `static uint8_t CBUF[AS_UP_RING_BYTES];`, add `static as_up_t UP;`, and `fresh()` becomes
`static void fresh(void) { memset(&F, 0, sizeof F); F.now = 1000; as_init(&S, &OPS, QBUF, CBUF, &UP); }`.
`without_buffers_it_never_runs`'s `as_init(&S, &OPS, NULL, ...)` calls gain a trailing `, NULL`.

The Amiga's bytes as amiga_tcp.c routes them, after `reply()`:

```c
// What amiga_tcp.c's receive callback does: the armed raw section first (as_raw_feed), the rest as lines.
static void amiga_sends(const void *data, int n) {
    const uint8_t *b = data; int i = 0;
    if (F.raw) {
        int k = as_raw_feed(F.raw, b, n);
        if (k < 0) { F.recv_closed = true; return; }
        i = k;
        if (F.raw->got == F.raw->total) F.raw = NULL;
    }
    for (; i < n; i++) {
        if (b[i] == '\n') { F.partial[F.partial_n] = 0; reply(F.partial); F.partial_n = 0; }
        else if (F.partial_n < AS_LINE_MAX) F.partial[F.partial_n++] = (char)b[i];
    }
}
static const char *KEY = "ab12cd34ef56ab12cd34ef56ab12cd34";
// Connected to a Receive 2 that trusts us: the state every upload test starts from.
static void ready2(void) {
    fresh();
    as_set_key(&S, KEY);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 2"); run(2);
    clear_out();
}
```

Tests (before `int main`):

```c
// --- protocol 2 (spec 2026-10-18 §3) ---
static void the_hello_carries_the_key(void) {
    fresh(); as_set_key(&S, KEY); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    char want[64]; snprintf(want, sizeof want, "WEBADF 2 %s\n", KEY);
    CHECK(strcmp(F.out, want) == 0, "WEBADF 2 <key>");
}
static void without_a_key_or_state_the_hello_stays_protocol_1(void) {
    fresh(); as_set_key(&S, "not-hex"); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, "a bad key: protocol 1");
    memset(&F, 0, sizeof F); F.now = 1000; as_init(&S, &OPS, QBUF, CBUF, NULL); as_set_key(&S, KEY);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, "no upload state: protocol 1");
}
static void raw_bytes_land_in_the_ring_and_the_rest_are_lines(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    as_raw_t w = { ring, 10, 10, 0, false };
    CHECK_EQ_INT(as_raw_feed(&w, (const uint8_t *)"0123456789END 1 0\n", 18), 10);
    CHECK(memcmp(ring, "0123456789", 10) == 0, "ten raw bytes");
    CHECK_EQ_INT(w.got, 10);
    CHECK_EQ_INT(as_raw_feed(&w, (const uint8_t *)"x", 1), 0);    // the section is over: lines
}
static void a_byte_past_the_credit_breaks_it(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    as_raw_t w = { ring, 100, 5, 0, false };
    CHECK_EQ_INT(as_raw_feed(&w, (const uint8_t *)"123456", 6), -1);
    CHECK(w.broken, "broken"); CHECK_EQ_INT(w.got, 0);
}
static void the_ring_wraps_at_its_size(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    static uint8_t big[AS_UP_RING_BYTES + 10];
    for (unsigned i = 0; i < sizeof big; i++) big[i] = (uint8_t)i;
    as_raw_t w = { ring, AS_UP_RING_BYTES + 10, AS_UP_RING_BYTES + 10, AS_UP_RING_BYTES - 4, false };
    CHECK_EQ_INT(as_raw_feed(&w, big + AS_UP_RING_BYTES - 4, 14), 14);
    CHECK(memcmp(ring + AS_UP_RING_BYTES - 4, big + AS_UP_RING_BYTES - 4, 4) == 0, "the end of the ring");
    CHECK(memcmp(ring, big + AS_UP_RING_BYTES, 10) == 0, "then its start");
}
static void put_parses_and_json_escapes_latin1(void) {   /* Review Focus 3 */
    as_put_t p; char json[AS_UP_JSON_MAX];
    CHECK(as_put_parse("PUT 7 5 1.2.3 40 8:Caf\xe9.txt 4:note", &p), "parsed");
    CHECK(strcmp(p.tag, "7") == 0 && p.size == 5 && p.prot == 0x40 && strcmp(p.date, "1.2.3") == 0, "fields");
    CHECK(p.path_n == 8 && memcmp(p.path, "Caf\xe9.txt", 8) == 0 && p.comment_n == 4, "path and comment");
    CHECK(as_put_json(&p, json, sizeof json) > 0, "json");
    CHECK(strcmp(json, "{\"size\":5,\"date\":\"1.2.3\",\"protection\":64,\"path\":\"Caf\\u00e9.txt\",\"comment\":\"note\"}") == 0, json);
    CHECK(!as_put_parse("PUT x 5 1.2.3 0 1:a 0:", &p), "a tag is digits");
    CHECK(!as_put_parse("PUT 1 5 1.2 0 1:a 0:", &p), "a date has three parts");
    CHECK(!as_put_parse("PUT 1 5 1.2.3 0 9:a 0:", &p), "a length past the line");
    CHECK(!as_put_parse("PUT 1 5 1.2.3 0 0: 0:", &p), "an empty path");
    CHECK(!as_put_parse("PUT 1 99999999999 1.2.3 0 1:a 0:", &p), "a size over 32 bits");
}
static void the_worst_put_json_fits(void) {
    char line[700], name[256], json[AS_UP_JSON_MAX]; as_put_t p;
    memset(name, 0xe9, 255); name[255] = 0;
    char com[80]; memset(com, '"', 79); com[79] = 0;
    snprintf(line, sizeof line, "PUT 999999999 4194304 99999.1439.2999 ffffffff 255:%s 79:%s", name, com);
    CHECK(as_put_parse(line, &p), "the longest legal PUT");
    CHECK(as_put_json(&p, json, sizeof json) > 0, "its JSON fits AS_UP_JSON_MAX, never cut");
}
static void utf8_comes_back_as_latin1(void) {
    char out[32];
    CHECK_EQ_INT(as_utf8_to_latin1("Caf\xc3\xa9.txt", out, sizeof out), 8);
    CHECK(strcmp(out, "Caf\xe9.txt") == 0, "é");
    as_utf8_to_latin1("a\xe2\x82\xac" "b", out, sizeof out);
    CHECK(strcmp(out, "a?b") == 0, "beyond Latin-1: ?");
}
```

Register in `main`: `RUN(the_hello_carries_the_key); RUN(without_a_key_or_state_the_hello_stays_protocol_1);
RUN(raw_bytes_land_in_the_ring_and_the_rest_are_lines); RUN(a_byte_past_the_credit_breaks_it); RUN(the_ring_wraps_at_its_size);
RUN(put_parses_and_json_escapes_latin1); RUN(the_worst_put_json_fits); RUN(utf8_comes_back_as_latin1);`.
(`amiga_sends` and `ready2` are used from Task 10 on; mark them `__attribute__((unused))` until then if `-Werror`
complains.)

Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c`
Expected: COMPILE FAIL (`as_raw_feed`, `as_put_parse` undefined).

- [ ] **Step 3: The protocol 2 pieces.** In `wifi-floppy/firmware/src/amiga_send.c`:
- add `#include "json_scan.h"` after `#include "amiga_send.h"`;
- `as_init` becomes:

```c
void as_init(amiga_send_t *s, const as_ops_t *ops, char *queue_buf, uint8_t *chunk_buf, as_up_t *up) {
    memset(s, 0, sizeof *s);
    s->ops = ops;
    s->rx = '-';
    s->queue = queue_buf;
    s->chunk = chunk_buf;
    s->up = (queue_buf && chunk_buf) ? up : NULL;
    if (s->up) memset(s->up, 0, sizeof *s->up);
}
void as_set_key(amiga_send_t *s, const char *hex) {
    if (!s->up) return;
    bool ok = hex && strlen(hex) == AS_KEY_HEX;
    for (int i = 0; ok && i < AS_KEY_HEX; i++) ok = (hex[i] >= '0' && hex[i] <= '9') || (hex[i] >= 'a' && hex[i] <= 'f');
    if (ok) memcpy(s->up->key, hex, AS_KEY_HEX + 1); else s->up->key[0] = 0;
}
```

- after `as_json_escape` add:

```c
int as_raw_feed(as_raw_t *w, const uint8_t *b, int n) {
    const uint32_t got = w->got;                                   // this is the only writer
    const uint32_t lim = __atomic_load_n(&w->limit, __ATOMIC_ACQUIRE);
    uint32_t take = w->total - got;
    if (n <= 0 || take == 0) return 0;
    if ((uint32_t)n < take) take = (uint32_t)n;
    if (got + take > lim) { w->broken = true; return -1; }        // past the credit
    const uint32_t at = got % AS_UP_RING_BYTES;
    uint32_t first = AS_UP_RING_BYTES - at;
    if (first > take) first = take;
    memcpy(w->ring + at, b, first);
    if (take > first) memcpy(w->ring, b + first, take - first);
    __atomic_store_n(&w->got, got + take, __ATOMIC_RELEASE);       // the bytes, then the count
    return (int)take;
}

int as_utf8_to_latin1(const char *in, char *out, int cap) {
    int o = 0;
    const unsigned char *p = (const unsigned char *)in;
    while (*p && o < cap - 1) {
        if (*p < 0x80) { out[o++] = (char)*p++; }
        else if ((*p == 0xC2 || *p == 0xC3) && (p[1] & 0xC0) == 0x80) { out[o++] = (char)(((*p & 0x03u) << 6) | (p[1] & 0x3Fu)); p += 2; }
        else { out[o++] = '?'; p++; while ((*p & 0xC0) == 0x80) p++; }
    }
    out[o] = 0;
    return o;
}

static const char *word(const char **p, int *n) {
    const char *t = *p;
    while (**p && **p != ' ') (*p)++;
    *n = (int)(*p - t);
    if (**p == ' ') (*p)++;
    return t;
}
static bool dec32(const char *t, int n, uint32_t *v) {
    uint64_t x = 0;
    if (n < 1 || n > 10) return false;
    for (int i = 0; i < n; i++) { if (t[i] < '0' || t[i] > '9') return false; x = x * 10u + (uint64_t)(t[i] - '0'); }
    if (x > 0xFFFFFFFFu) return false;
    *v = (uint32_t)x;
    return true;
}
static bool hex32(const char *t, int n, uint32_t *v) {
    uint32_t x = 0;
    if (n < 1 || n > 8) return false;
    for (int i = 0; i < n; i++) {
        char c = t[i];
        int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
        if (d < 0) return false;
        x = (x << 4) | (uint32_t)d;
    }
    *v = x;
    return true;
}
// "<len>:<bytes>" then a space or the end of the line.
static bool lenfield(const char **p, const char **s, int *n) {
    const char *q = *p;
    uint32_t len = 0;
    int d = 0;
    while (*q >= '0' && *q <= '9' && d < 4) { len = len * 10u + (uint32_t)(*q - '0'); q++; d++; }
    if (d == 0 || *q != ':') return false;
    q++;
    if (strnlen(q, len) < len) return false;
    *s = q; *n = (int)len; q += len;
    if (*q == ' ') q++; else if (*q) return false;
    *p = q;
    return true;
}
bool as_put_parse(const char *line, as_put_t *o) {
    const char *p = line, *t;
    int n, dots = 0;
    if (strncmp(p, "PUT ", 4) != 0) return false;
    p += 4;
    t = word(&p, &n);
    if (n < 1 || n > AS_TAG_MAX) return false;
    for (int i = 0; i < n; i++) if (t[i] < '0' || t[i] > '9') return false;
    memcpy(o->tag, t, (size_t)n); o->tag[n] = 0;
    t = word(&p, &n); if (!dec32(t, n, &o->size)) return false;
    t = word(&p, &n);
    if (n < 5 || n >= (int)sizeof o->date) return false;
    for (int i = 0; i < n; i++) {
        if (t[i] == '.') { if (i == 0 || i == n - 1 || t[i - 1] == '.') return false; dots++; }
        else if (t[i] < '0' || t[i] > '9') return false;
    }
    if (dots != 2) return false;
    memcpy(o->date, t, (size_t)n); o->date[n] = 0;
    t = word(&p, &n); if (!hex32(t, n, &o->prot)) return false;
    if (!lenfield(&p, &o->path, &o->path_n) || o->path_n < 1 || o->path_n > 255) return false;
    if (!lenfield(&p, &o->comment, &o->comment_n) || o->comment_n > 79) return false;
    return *p == 0;
}
int as_put_json(const as_put_t *p, char *json, int cap) {
    int o = snprintf(json, (size_t)cap, "{\"size\":%lu,\"date\":\"%s\",\"protection\":%lu,\"path\":\"",
                     (unsigned long)p->size, p->date, (unsigned long)p->prot);
    if (o < 0 || o >= cap) return -1;
    if (p->path_n * 6 + p->comment_n * 6 + o + 20 > cap) return -1;   // never cut a name
    o += as_json_escape(json + o, cap - o, p->path, p->path_n);
    int k = snprintf(json + o, (size_t)(cap - o), "\",\"comment\":\"");
    if (k < 0 || o + k >= cap) return -1;
    o += k;
    o += as_json_escape(json + o, cap - o, p->comment, p->comment_n);
    k = snprintf(json + o, (size_t)(cap - o), "\"}");
    if (k < 0 || o + k >= cap) return -1;
    return o + k;
}
```

- in `run()`'s `case AS_CONNECTING:` the hello push `push(s, (const uint8_t *)"WEBADF 1\n", 9);` becomes:

```c
            if (s->up && s->up->key[0]) {   // protocol 2 (fw 1.19.0): uploads, to a Receive that trusts this key
                int n = snprintf(s->up->line, sizeof s->up->line, "WEBADF 2 %s\n", s->up->key);
                push(s, (const uint8_t *)s->up->line, n);
            } else {
                push(s, (const uint8_t *)"WEBADF 1\n", 9);
            }
```

- in the line loop's `case AS_HELLO:`, inside `if (strncmp(s->line, "READY ", 6) == 0) {`, add as its first line:
  `s->peer_v = (s->line[6] == '2' && s->line[7] == 0) ? 2 : 1;   // Receive 1 says READY 1 to anything`;
- in `drop()`, after `s->ping_out = false;` add `s->peer_v = 0;`.

- [ ] **Step 4: Run the tests.** Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c`
Expected: `0 failed` (every Phase 4 test still passes: the default hello without a key is unchanged).

- [ ] **Step 5: Commit.**

```bash
git add wifi-floppy/firmware/src/amiga_send.h wifi-floppy/firmware/src/amiga_send.c wifi-floppy/firmware/test/test_amiga_send.c
git commit -m "fw: amiga_send protocol 2 pieces -- the key in the hello, READY 2, the raw window, PUT parsing and JSON

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 10: Firmware: amiga_send upload phases -- open, data, close, arbitration, failures

**Files:**
- Modify: `wifi-floppy/firmware/src/amiga_send.c`, `wifi-floppy/firmware/test/test_amiga_send.c`

**Interfaces:**
- Consumes: Task 9 (types, `as_raw_feed`, `as_put_parse`, `as_put_json`, `as_utf8_to_latin1`); `json_str`,
  `json_u32_strict`; the existing `push`, `flush`, `drop`, `http_failed`, `in_backoff`, `fetch_owed`, `next_present`, `start_file`.
- Produces: the board side of §3: `TAKE`/`MORE`/`DONE`/`NO` lines; log lines `up: <tag> open <path> <size> at <offset>`,
  `up: <tag> stored <bytes> -> <name>`, `up: <tag> NO <code>`, `up: <tag> aborted (<why>)`; `as_has_work()` true while
  a PUT waits or an upload is open (outside a backoff).

Rules this task implements (spec §3, §5, §8; rulings P7, P9):
- A PUT that arrives while a file goes down waits; between files a waiting PUT goes first, except right after an
  upload, when a waiting (or not yet fetched) download goes first.
- Before `TAKE` and after the last raw byte, a refusal is `NO` and the connection stays. With raw bytes possibly in
  flight, a failure is `NO` and the connection closes.
- The open gives up after 60 s from the PUT (`NO offline`); an upload with no progress for 120 s ends `NO offline` when
  the server was failing, else `NO busy` (the Amiga stopped sending).
- No PING during an upload.

- [ ] **Step 1: Write the failing tests.** In `wifi-floppy/firmware/test/test_amiga_send.c` replace Task 9's `ready2` with:

```c
static void ready2_with(const char *queue) {
    fresh();
    as_set_key(&S, KEY);
    snprintf(F.queue, sizeof F.queue, "%s", queue);
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 2"); run(2);
    clear_out();
}
static void ready2(void) { ready2_with("NEXT -\nLIST 0\n"); }
static unsigned long crc32_of(const uint8_t *p, size_t n) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (uint32_t)-(int32_t)(c & 1u)); }
    return (unsigned long)~c;
}
static void end_line(const char *tag, const uint8_t *p, size_t n) {
    char e[40]; int k = snprintf(e, sizeof e, "END %s %lx\n", tag, crc32_of(p, n)); amiga_sends(e, k);
}
static const char *PUT5 = "PUT 1 5 1.2.3 0 9:Hello.txt 0:";
static uint8_t BIG[200000];
static void fill_big(void) { for (unsigned i = 0; i < sizeof BIG; i++) BIG[i] = (uint8_t)(i * 13 + 5); }
```

and add:

```c
static void ready_2_lets_a_put_in_and_ready_1_does_not(void) {
    ready2(); reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 1);
    fresh(); as_set_key(&S, KEY); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 1"); run(2);
    reply(PUT5); run(3);
    CHECK_EQ_INT(F.opens, 0);                     // Receive 1 never PUTs; a stray PUT is ignored
}
static void a_small_upload_end_to_end(void) {
    ready2(); reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 1);
    CHECK(strstr(F.open_json, "\"size\":5") && strstr(F.open_json, "\"path\":\"Hello.txt\""), F.open_json);
    CHECK(strcmp(F.out, "TAKE 1 0 5\n") == 0, F.out);
    CHECK(as_has_work(&S), "work while an upload is open");
    clear_out();
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5);
    run(4);
    CHECK_EQ_INT(F.chunks, 1); CHECK(F.chunk_offs[0] == 0 && F.chunk_lens[0] == 5, "one chunk");
    CHECK(memcmp(F.stored, "hello", 5) == 0, "the bytes");
    CHECK_EQ_INT(F.closes, 1); CHECK(strcmp(F.close_json, "{\"crc32\":907060870}") == 0, F.close_json);
    CHECK(strstr(F.out, "DONE 1 9:Hello.txt\n") != NULL, F.out);
    CHECK(!as_has_work(&S), "idle after");
}
static void a_big_upload_moves_in_16k_chunks_and_the_credit_follows(void) {
    fill_big(); ready2();
    reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1);
    CHECK(strcmp(F.out, "TAKE 1 0 32768\n") == 0, F.out);
    clear_out();
    amiga_sends(BIG, 32768); run(3);
    CHECK_EQ_INT(F.chunks, 2);
    CHECK(strstr(F.out, "MORE 1 40000\n") != NULL, F.out);
    amiga_sends(BIG + 32768, 40000 - 32768); end_line("1", BIG, 40000);
    run(4);
    CHECK_EQ_INT(F.chunks, 3); CHECK(F.chunk_offs[2] == 32768 && F.chunk_lens[2] == 7232, "the last chunk");
    CHECK(memcmp(F.stored, BIG, 40000) == 0, "every byte, in order");
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void bytes_past_the_credit_drop_the_connection(void) {
    fill_big(); ready2(); reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1);
    amiga_sends(BIG, 32769); run(2);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped");
    CHECK(F.raw == NULL && F.arms >= 2, "the raw section disarmed");
}
static void the_servers_offset_resumes_the_file(void) {
    fill_big(); ready2();
    memcpy(F.stored, BIG, 16384); F.stored_len = 16384;
    snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"u1\",\"offset\":16384}");
    reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1);
    CHECK(strcmp(F.out, "TAKE 1 16384 40000\n") == 0, F.out);
    amiga_sends(BIG + 16384, 40000 - 16384); end_line("1", BIG, 40000);
    run(6);
    CHECK_EQ_INT(F.chunks, 2); CHECK(F.chunk_offs[0] == 16384 && F.chunk_offs[1] == 32768, "from the offset");
    CHECK(memcmp(F.stored, BIG, 40000) == 0, "whole");
}
static void resume_at_size_goes_straight_to_close(void) {       /* Review Focus 1 */
    ready2(); memcpy(F.stored, "hello", 5); F.stored_len = 5;
    snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"u1\",\"offset\":5}");
    reply(PUT5); run(1);
    CHECK(strcmp(F.out, "TAKE 1 5 5\n") == 0, F.out);
    CHECK(F.raw == NULL, "an empty raw section is never armed");
    end_line("1", (const uint8_t *)"hello", 5); run(3);
    CHECK_EQ_INT(F.chunks, 0); CHECK_EQ_INT(F.closes, 1); CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void zero_byte_upload(void) {                            /* Review Focus 2 */
    ready2(); reply("PUT 1 0 1.2.3 0 5:Empty 0:"); run(1);
    CHECK(strcmp(F.out, "TAKE 1 0 0\n") == 0, F.out);
    amiga_sends("END 1 0\n", 8); run(3);
    CHECK_EQ_INT(F.chunks, 0); CHECK(strcmp(F.close_json, "{\"crc32\":0}") == 0, F.close_json);
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void refusals_at_open_become_no_and_keep_the_connection(void) {
    ready2(); F.open_status = 409; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"full\"}");
    reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 full ") != NULL, F.out); CHECK(F.sock == AS_SOCK_OPEN, "kept");
    ready2(); F.open_status = 413; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"size\"}"); reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 size ") != NULL, F.out);
    ready2(); F.open_status = 401; reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 auth ") != NULL, F.out);
    ready2(); F.open_status = 400; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"weird\"}"); reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 server ") != NULL, "an unknown code is server");
    ready2(); reply("PUT 1 4194305 1.2.3 0 1:a 0:"); run(1);
    CHECK(strstr(F.out, "NO 1 size ") != NULL && F.opens == 0, "over 4 MB: refused without asking");
    ready2(); snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"../x\",\"offset\":0}"); reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 server ") != NULL, "an id that is not a uuid never reaches a path");
}
static void an_open_that_never_answers_gives_up_after_60_s(void) {
    ready2(); F.open_status = -1;
    reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 1); CHECK(F.out[0] == 0, "nothing yet");
    F.now += 1100; run(1); CHECK_EQ_INT(F.opens, 2);           // the backoff, then again
    F.now += 61000; run(2);
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_OPEN, "kept: no byte was in flight");
}
static void a_409_on_a_chunk_ends_the_file_and_the_connection(void) {
    fill_big(); ready2(); reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1);
    F.chunk_status = 409; amiga_sends(BIG, 16384); run(2);
    CHECK(strstr(F.out, "NO 1 server ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped: bytes may be in flight (ruling P7)");
}
static void a_failing_chunk_waits_then_gives_up_after_120_s(void) {
    fill_big(); ready2(); reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1);
    clear_out();
    F.chunk_status = -1; amiga_sends(BIG, 32768); run(2);
    CHECK(F.chunks >= 1 && strstr(F.out, "MORE") == NULL, "the credit does not move");
    CHECK(!as_has_work(&S), "in the backoff the long poll runs (ruling P9)");
    F.now += 121000; run(2);
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped");
}
static void an_amiga_that_stops_sending_is_given_up_too(void) {
    fill_big(); ready2(); reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1);
    amiga_sends(BIG, 1000); run(1);
    F.now += 121000; run(2);
    CHECK(strstr(F.out, "NO 1 busy ") != NULL, F.out);
}
static void a_crc_refused_at_close_is_no_crc(void) {
    ready2(); F.close_status = 409; snprintf(F.close_resp, sizeof F.close_resp, "{\"code\":\"crc\"}");
    reply(PUT5); run(1); amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(strstr(F.out, "NO 1 crc ") != NULL, F.out); CHECK(F.sock == AS_SOCK_OPEN, "kept: the stream is lines again");
}
static void done_name_is_latin1(void) {                         /* Review Focus 3 */
    ready2(); snprintf(F.close_resp, sizeof F.close_resp, "{\"name\":\"Caf\xc3\xa9.txt\"}");
    reply("PUT 1 1 1.2.3 0 8:Caf\xe9.txt 0:"); run(1);
    CHECK(strstr(F.open_json, "\"path\":\"Caf\\u00e9.txt\"") != NULL, F.open_json);
    amiga_sends("e", 1); end_line("1", (const uint8_t *)"e", 1); run(4);
    CHECK(strstr(F.out, "DONE 1 8:Caf\xe9.txt\n") != NULL, F.out);
}
static void a_lost_chunk_answer_is_retried(void) {             /* Review Focus 4 */
    ready2(); reply(PUT5); run(1);
    F.lose_answer = 1; amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5);
    run(2);
    CHECK_EQ_INT(F.chunks, 1); CHECK_EQ_INT(F.stored_len, 5);
    F.now += 1100; run(4);
    CHECK_EQ_INT(F.chunks, 2); CHECK_EQ_INT(F.stored_len, 5);   // the retry stored nothing twice
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void no_ping_while_a_file_goes_up(void) {
    ready2(); reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1); clear_out();
    F.now += 31000; run(2);
    CHECK(strstr(F.out, "PING") == NULL, "no ping in an upload (spec §3)");
}
static void abort_before_the_open_is_answered_no_busy(void) {
    ready2(); F.open_status = -1;
    reply(PUT5); run(1); clear_out();
    reply("ABORT 1"); F.now += 1100; run(2);
    CHECK(strstr(F.out, "NO 1 busy 9:cancelled\n") != NULL, F.out); CHECK(F.sock == AS_SOCK_OPEN, "kept");
}
static void a_second_put_while_one_is_open_drops(void) {
    ready2(); reply(PUT5); run(1);
    reply("PUT 2 5 1.2.3 0 1:x 0:"); run(1);
    CHECK(F.sock == AS_SOCK_CLOSED, "Receive sends one at a time");
}
static void a_dropped_connection_mid_upload_disarms(void) {
    fill_big(); ready2(); reply("PUT 1 40000 1.2.3 0 3:Big 0:"); run(1);
    amiga_sends(BIG, 1000); F.sock = AS_SOCK_CLOSED; run(1);
    CHECK(F.raw == NULL, "disarmed");
}
static void a_put_during_a_download_waits_then_goes_first(void) {
    char q[600], go[80], ok[120];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    ready2_with(q);
    CHECK(S.phase == AS_FILE_SENT, "the download started");
    reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 0);                                      // it waits for the file going down
    memcpy(F.file, "hello", 5); F.file_len = 5;
    snprintf(go, sizeof go, "GO %s", ID); reply(go); run(3);
    snprintf(ok, sizeof ok, "OK %s 5:Hello", ID); reply(ok);
    run(6);
    CHECK_EQ_INT(F.posts, 1);                                      // the download's outcome first
    CHECK_EQ_INT(F.opens, 1);                                      // then the PUT, before the next download
}
static void after_an_upload_a_waiting_download_goes_first(void) {
    char q[600];
    ready2(); reply(PUT5); run(1);
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    snprintf(F.queue, sizeof F.queue, "%s", q); as_set_inputs(&S, true, 0xAC100AEDu, 2);   // a download arrives meanwhile
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5);
    run(2);                                                        // the chunk, then the close: DONE; the queue not refetched yet
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
    reply("PUT 2 5 1.2.3 0 9:Hello.txt 0:");                       // Receive offers its next file at once
    run(6);
    CHECK_EQ_INT(F.opens, 1);                                      // the second PUT waits its turn
    CHECK(strstr(F.out, "FILE ") != NULL, "the download goes first");
}
```

Register all twenty-one in `main`.

Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c`
Expected: FAIL (`F.opens` stays 0: PUT is not handled yet).

- [ ] **Step 2: The engine.** In `wifi-floppy/firmware/src/amiga_send.c`:

- after `static void http_failed(amiga_send_t *s, const char *what, int st);` (the forward declaration at the top) add
  `static void up_reset(amiga_send_t *s);`;
- in `drop()`, after its first line add:

```c
    if (s->up && s->phase >= AS_UP_OPEN && s->phase <= AS_UP_CLOSE) wf_logf(WF_WARN, "up: %s aborted (%s)", s->up->tag, why);
    if (s->up) {   // the server keeps the partial upload: the same file sent again resumes (spec U4)
        if (s->ops->raw_arm) s->ops->raw_arm(s->ops->ctx, NULL);
        up_reset(s);
    }
```

- `file_moving` becomes `static bool file_moving(const amiga_send_t *s) { return s->phase >= AS_FILE_SENT && s->phase <= AS_UP_CLOSE; }`
  (a file moving either way: no queue fetch, no long poll);
- in `as_has_work`, the last clause becomes
  `|| (s->phase == AS_READY && (s->list_owed || s->out_n > 0 || next_present(s) || (s->up && s->up->pending)));`;
- before `// The shared engine:` add:

```c
// --- Uploads (protocol 2, spec 2026-10-18 §3, §5) -------------------------------------------------------------------
static bool up_moving(const amiga_send_t *s) { return s->phase >= AS_UP_OPEN && s->phase <= AS_UP_CLOSE; }
static void up_reset(amiga_send_t *s) {
    as_up_t *u = s->up;
    u->pending = false; u->aborted = false; u->end_seen = false;
    u->tag[0] = 0; u->id[0] = 0;
    u->size = u->start = u->posted = u->crc = u->last_got = 0;
    u->raw.total = 0; u->raw.got = 0; u->raw.limit = 0; u->raw.broken = false;
}
static const char *no_text(const char *code) {
    if (!strcmp(code, "size")) return "file too large (4 MB at most)";
    if (!strcmp(code, "full")) return "the From the Amiga area on the web app is full";
    if (!strcmp(code, "name")) return "the web app refused the name";
    if (!strcmp(code, "offline")) return "the web app cannot be reached";
    if (!strcmp(code, "auth")) return "this board is not paired";
    if (!strcmp(code, "busy")) return "cancelled";
    if (!strcmp(code, "crc")) return "damaged on the way";
    return "the web app refused it";
}
static bool code_known(const char *c) {
    static const char *const k[] = { "size", "full", "name", "offline", "auth", "busy", "server", "crc" };
    for (unsigned i = 0; i < sizeof k / sizeof k[0]; i++) if (!strcmp(c, k[i])) return true;
    return false;
}
// The server's upload id goes into a request path: lower-case hex and '-' only.
static bool id_ok(const char *id) {
    size_t n = strlen(id);
    if (n < 1 || n > AS_ID_MAX) return false;
    for (size_t i = 0; i < n; i++) if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f') || id[i] == '-')) return false;
    return true;
}
// "NO <tag> <code> <len>:<text>".
static void up_no(amiga_send_t *s, const char *code, const char *text) {
    as_up_t *u = s->up;
    int n = snprintf(u->line, sizeof u->line, "NO %s %s %u:%s\n", u->tag, code, (unsigned)strlen(text), text);
    push(s, (const uint8_t *)u->line, n);
    wf_logf(WF_INFO, "up: %s NO %s", u->tag, code);
}
// Before TAKE, or after the last raw byte: the stream is lines, so the connection stays.
static void up_refuse(amiga_send_t *s, const char *code, const char *text) {
    up_no(s, code, text);
    up_reset(s);
    s->phase = AS_READY;
    s->up_last = true;
    s->t_ping = now(s);
    if (!flush(s)) drop(s, 'u', "send");
}
// Raw bytes may be in flight: the stream's place is lost, so after the NO the connection goes (plan ruling P7).
static void up_fail_drop(amiga_send_t *s, const char *code, const char *text) {
    char why[24];
    up_no(s, code, text);
    (void)flush(s);
    snprintf(why, sizeof why, "upload %s", code);
    drop(s, s->rx, why);
}
static void on_put(amiga_send_t *s) {
    as_put_t p;
    if (!s->up || s->peer_v < 2) return;                    // only a protocol 2 Receive offers files
    if (s->up->pending || up_moving(s)) { drop(s, 'u', "a second PUT"); return; }   // Receive sends one at a time
    if (!as_put_parse(s->line, &p)) { drop(s, 'u', "bad PUT"); return; }
    memcpy(s->up->put, s->line, strlen(s->line) + 1);
    memcpy(s->up->tag, p.tag, sizeof s->up->tag);
    s->up->pending = true;
    s->up->aborted = false;
    s->up->t_open = now(s);
}
static void on_abort(amiga_send_t *s) {
    if (s->up && (s->up->pending || up_moving(s)) && strcmp(s->line + 6, s->up->tag) == 0) s->up->aborted = true;
}
static void on_end(amiga_send_t *s) {
    as_up_t *u = s->up;
    const char *p = s->line + 4, *t;
    int n;
    if (!u || s->phase != AS_UP_DATA) { drop(s, 'u', "stray END"); return; }
    t = word(&p, &n);
    if ((int)strlen(u->tag) != n || strncmp(t, u->tag, (size_t)n) != 0) { drop(s, 'u', "END for another file"); return; }
    t = word(&p, &n);
    if (!hex32(t, n, &u->crc) || __atomic_load_n(&u->raw.got, __ATOMIC_ACQUIRE) != u->raw.total) { drop(s, 'u', "bad END"); return; }
    u->end_seen = true;
}
static bool up_open(amiga_send_t *s, uint32_t t, bool http) {
    as_up_t *u = s->up;
    as_put_t p;
    uint32_t off;
    if (s->out_n > 0) return false;
    if (u->aborted) { up_refuse(s, "busy", "cancelled"); return true; }
    if ((int32_t)(t - u->t_open) > (int32_t)AS_UP_OPEN_GIVEUP_MS) { up_refuse(s, "offline", no_text("offline")); return true; }
    if (!http || in_backoff(s)) return false;
    if (!as_put_parse(u->put, &p)) { drop(s, 'u', "bad PUT"); return true; }
    if (p.size > AS_UP_FILE_MAX) { up_refuse(s, "size", no_text("size")); return true; }
    if (as_put_json(&p, u->json, sizeof u->json) < 0) { up_refuse(s, "name", no_text("name")); return true; }
    int st = s->ops->upload_open(s->ops->ctx, u->json, u->resp, sizeof u->resp);
    if (st == 200 || st == 201) {
        if (!json_str(u->resp, "id", u->id, sizeof u->id) || !id_ok(u->id) ||
            !json_u32_strict(u->resp, "offset", &off) || off > p.size) {
            up_refuse(s, "server", "the web app gave an answer the board cannot read");
            return true;
        }
        s->backoff_ms = 0;
        u->size = p.size; u->start = u->posted = off; u->end_seen = false; u->last_got = 0;
        u->raw.ring = s->chunk; u->raw.total = p.size - off; u->raw.got = 0; u->raw.broken = false;
        const uint32_t lim = u->raw.total < AS_UP_RING_BYTES ? u->raw.total : AS_UP_RING_BYTES;
        __atomic_store_n(&u->raw.limit, lim, __ATOMIC_RELEASE);
        if (s->ops->raw_arm) s->ops->raw_arm(s->ops->ctx, &u->raw);   // BEFORE the TAKE: every later byte is file data
        int n = snprintf(u->line, sizeof u->line, "TAKE %s %lu %lu\n", u->tag, (unsigned long)off, (unsigned long)(off + lim));
        push(s, (const uint8_t *)u->line, n);
        s->phase = AS_UP_DATA;
        u->t_progress = t;
        wf_logf(WF_INFO, "up: %s open %.*s %lu at %lu", u->tag, p.path_n < 40 ? p.path_n : 40, p.path,
                (unsigned long)p.size, (unsigned long)off);
        if (!flush(s)) drop(s, 'u', "send");
        return true;
    }
    if (st == 401) { up_refuse(s, "auth", no_text("auth")); return true; }
    if (st >= 400 && st < 500 && st != 408 && st != 429) {
        char code[17];
        if (!json_str(u->resp, "code", code, sizeof code) || !code_known(code)) snprintf(code, sizeof code, "server");
        up_refuse(s, code, no_text(code));
        return true;
    }
    http_failed(s, "upload open", st);
    return true;
}
static bool up_data(amiga_send_t *s, uint32_t t, bool http) {
    as_up_t *u = s->up;
    if (u->raw.broken) { drop(s, 'u', "upload past the credit"); return true; }
    const uint32_t got = __atomic_load_n(&u->raw.got, __ATOMIC_ACQUIRE);
    if (got != u->last_got) { u->last_got = got; u->t_progress = t; }
    if ((int32_t)(t - u->t_progress) > (int32_t)AS_UP_STALL_MS) {
        if (s->backoff_ms) up_fail_drop(s, "offline", no_text("offline"));
        else up_fail_drop(s, "busy", "the Amiga stopped sending");
        return true;
    }
    if (s->out_n > 0) return false;
    const uint32_t done = u->posted - u->start, total = u->raw.total;
    if (done == total) {
        if (u->aborted) { up_refuse(s, "busy", "cancelled"); return true; }   // every byte is in: lines again
        if (u->end_seen) { s->phase = AS_UP_CLOSE; return true; }
        return false;                                                       // waiting for END
    }
    const uint32_t hi = total - done > AS_CHUNK_BYTES ? done + AS_CHUNK_BYTES : total;
    if (got < hi || !http || in_backoff(s)) return false;                   // the chunk is still filling
    int st = s->ops->upload_chunk(s->ops->ctx, u->id, u->posted, s->chunk + (done % AS_UP_RING_BYTES), hi - done,
                                  u->resp, sizeof u->resp);
    if (st == 200) {
        uint32_t rec;
        if (!json_u32_strict(u->resp, "received", &rec) || rec != u->start + hi) {
            up_fail_drop(s, "server", "the web app lost its place in the file");
            return true;
        }
        u->posted = rec; s->backoff_ms = 0; u->t_progress = t;
        const uint32_t lim = total - hi > AS_UP_RING_BYTES ? hi + AS_UP_RING_BYTES : total;
        __atomic_store_n(&u->raw.limit, lim, __ATOMIC_RELEASE);
        int n = snprintf(u->line, sizeof u->line, "MORE %s %lu\n", u->tag, (unsigned long)(u->start + lim));
        push(s, (const uint8_t *)u->line, n);
        if (!flush(s)) drop(s, 'u', "send");
        return true;
    }
    if (st == 401) { up_fail_drop(s, "auth", no_text("auth")); return true; }
    if (st >= 400 && st < 500 && st != 408 && st != 429) { up_fail_drop(s, "server", "the web app refused part of the file"); return true; }
    http_failed(s, "upload chunk", st);
    return true;
}
static bool up_close(amiga_send_t *s, uint32_t t, bool http) {
    as_up_t *u = s->up;
    if (s->out_n > 0) return false;
    if ((int32_t)(t - u->t_progress) > (int32_t)AS_UP_STALL_MS) { up_refuse(s, "offline", no_text("offline")); return true; }
    if (!http || in_backoff(s)) return false;
    snprintf(u->json, sizeof u->json, "{\"crc32\":%lu}", (unsigned long)u->crc);
    int st = s->ops->upload_close(s->ops->ctx, u->id, u->json, u->resp, sizeof u->resp);
    if (st == 200) {
        // The name as stored: UTF-8 from the server, Latin-1 on the wire. u->json and u->resp are scratch now.
        int nlen;
        if (json_str(u->resp, "name", u->json, sizeof u->json) && u->json[0]) nlen = as_utf8_to_latin1(u->json, u->resp, 256);
        else {
            as_put_t p;
            nlen = as_put_parse(u->put, &p) ? p.path_n : 0;
            if (nlen) memcpy(u->resp, p.path, (size_t)nlen);
            u->resp[nlen] = 0;
        }
        int n = snprintf(u->line, sizeof u->line, "DONE %s %d:%s\n", u->tag, nlen, u->resp);
        push(s, (const uint8_t *)u->line, n);
        wf_logf(WF_INFO, "up: %s stored %lu -> %s", u->tag, (unsigned long)u->size, u->resp);
        up_reset(s);
        s->phase = AS_READY; s->up_last = true; s->backoff_ms = 0; s->t_ping = t;
        if (!flush(s)) drop(s, 'u', "send");
        return true;
    }
    if (st == 401) { up_refuse(s, "auth", no_text("auth")); return true; }
    if (st >= 400 && st < 500 && st != 408 && st != 429) {
        char code[17];
        if (!json_str(u->resp, "code", code, sizeof code) || strcmp(code, "crc") != 0) snprintf(code, sizeof code, "server");
        up_refuse(s, code, no_text(code));
        return true;
    }
    http_failed(s, "upload close", st);
    return true;
}
```

- in `run()`'s line loop, after `if (strcmp(s->line, "PONG") == 0) { s->ping_out = false; continue; }` add:

```c
        // Protocol 2 lines from Receive 2, in any phase (spec 2026-10-18 §3).
        if (strncmp(s->line, "PUT ", 4) == 0) { on_put(s); if (s->phase == AS_IDLE) return true; continue; }
        if (strncmp(s->line, "ABORT ", 6) == 0) { on_abort(s); continue; }
        if (strncmp(s->line, "END ", 4) == 0) { on_end(s); if (s->phase == AS_IDLE) return true; continue; }
```

- in the post-loop `case AS_READY:`, replace
  `if (!s->done_owed && !fetch_owed(s) && next_present(s)) { start_file(s); if (!flush(s)) drop(s, 'u', "send"); return true; }`
  with:

```c
        if (s->up && s->up->pending && s->up->aborted) { up_refuse(s, "busy", "cancelled"); return true; }
        {
            // Spec §3 arbitration: a waiting PUT goes before the next download -- except right after an upload, when
            // a waiting download (or one the queue may hold: an outcome or a fetch is owed) goes first. Turns.
            const bool down = !s->done_owed && !fetch_owed(s) && next_present(s);
            const bool unsure = s->done_owed || fetch_owed(s);
            if (s->up && s->up->pending && !(s->up_last && (down || unsure))) {
                s->up->pending = false;
                s->phase = AS_UP_OPEN;
                s->t_phase = t;
                return true;
            }
            if (down) { s->up_last = false; start_file(s); if (!flush(s)) drop(s, 'u', "send"); return true; }
        }
```

- in the same `switch`, after `case AS_AWAIT_OK: ... break;` add:

```c
    case AS_UP_OPEN: return up_open(s, t, http) || moved;
    case AS_UP_DATA: return up_data(s, t, http) || moved;
    case AS_UP_CLOSE: return up_close(s, t, http) || moved;
```

`word` and `hex32` (Task 9) are defined above `as_put_parse`; keep this block below them.

- [ ] **Step 3: Run the tests.** Run: `wifi-floppy/firmware/test/run.sh test_amiga_send.c` and then `wifi-floppy/firmware/test/run.sh`
Expected: `0 failed`; every Phase 4 test still passes.

- [ ] **Step 4: Commit.**

```bash
git add wifi-floppy/firmware/src/amiga_send.c wifi-floppy/firmware/test/test_amiga_send.c
git commit -m "fw: uploads in amiga_send -- open, 16 KB chunks within the credit, close; turns with downloads; failures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 11: Firmware: raw bytes into PSRAM, the out-of-order limit, full-size frames, the wiring, 1.19.0

**Files:**
- Modify: `wifi-floppy/firmware/src/amiga_tcp.c`, `wifi-floppy/firmware/src/pnet_bridge.c:90-97`,
  `wifi-floppy/firmware/src/pnet_lwip_hooks.h`, `wifi-floppy/firmware/src/main.c`, `wifi-floppy/firmware/CMakeLists.txt:262`,
  `wifi-floppy/firmware/src/amiga_send.h` (only if Task 1 measured other values)

**Interfaces:**
- Consumes: Task 7 (`dc_upload_*`, `dc_set_up_key`), Task 8 (`key_store_*`), Tasks 9-10 (`as_init(..., up)`,
  `as_set_key`, `as_raw_feed`, `AS_UP_RING_BYTES`, `AS_UP_OOSEQ_BYTES`).
- Produces: `uint32_t amiga_tcp_ooseq_limit(const struct tcp_pcb *pcb)`; `PNET_LOCAL_A2B_MAX` = `PNET_RING_MTU`;
  firmware `1.19.0` with `.bss` ≤ 432,532.

- [ ] **Step 1: The measured numbers.** Read the Task 1 / Bench B0 results in the ledger. If B0 has not run, keep the
defaults (`AS_UP_WINDOW_CHUNKS 2u`, `AS_UP_OOSEQ_BYTES 2920u`) and write "defaults, B0 not run" in the commit message.
If it has run, with R = the pattern run's B/s, O = its `ooseq max`, H = the lowest heap low-water seen, E = `mem err`:
  - `AS_UP_WINDOW_CHUNKS` = max(2, ceil(R × 1.0 s / 16,384) + 1), at most 4 (the Amiga must keep sending while one
    16 KB chunk is posted; 1.0 s is the planning figure for a chunk POST, re-measured from the `up:` log times at B2);
  - `AS_UP_OOSEQ_BYTES` = max(2,920, O rounded up to a multiple of 1,460), at most 5,840;
  - if E > 0 or H < 20,480: keep 2 and 2,920 whatever R and O say, and tell the operator (the heap is the limit).

Edit the two `#define` defaults in `amiga_send.h` accordingly (their comments keep "From plan 2026-10-19 Task 1").

- [ ] **Step 2: amiga_tcp routes the raw section and limits out-of-order data.** In `wifi-floppy/firmware/src/amiga_tcp.c`:
- the `RING` comment becomes `// Receive's lines (replies, PUT, END); an upload's raw bytes go to the PSRAM ring instead`;
- the state struct becomes:

```c
static struct {
    struct tcp_pcb *pcb;
    volatile int state;          // AS_SOCK_*
    uint8_t ring[RING];
    volatile int head, tail;     // bytes [tail, head) are unread
    as_raw_t *volatile raw;      // an upload's raw section (fw 1.19.0): its bytes go to the PSRAM ring first
} T;
```

- `on_recv`'s `for (struct pbuf *q = p; q; q = q->next) { ... }` loop becomes:

```c
    for (struct pbuf *q = p; q; q = q->next) {
        const uint8_t *b = q->payload;
        u16_t i = 0;
        as_raw_t *w = T.raw;
        if (w) {   // spec 2026-10-18 §5: into PSRAM, and the pbuf is freed below before the next frame is input
            const int k = as_raw_feed(w, b, q->len);
            if (k < 0) { T.state = AS_SOCK_CLOSED; break; }   // past the credit: amiga_send drops the connection
            i = (u16_t)k;
            if (w->got == w->total) T.raw = NULL;              // the raw section is over: lines again
        }
        for (; i < q->len; i++) {
            if (ring_used() == RING - 1) { T.state = AS_SOCK_CLOSED; break; }   // a peer that floods: give up
            T.ring[T.head] = b[i];
            T.head = (T.head + 1) % RING;
        }
    }
```

- in `t_close`, after `T.head = T.tail = 0;` add `T.raw = NULL;`;
- before `static int h_queue(...)` add:

```c
static void t_raw_arm(void *ctx, as_raw_t *w) {
    (void)ctx;
    net_radio_lock();
    T.raw = (w && w->got < w->total) ? w : NULL;   // an empty section (a resume at the end) is never armed
    net_radio_unlock();
}
// lwIP's TCP_OOSEQ_BYTES_LIMIT hook (pnet_lwip_hooks.h), in lwIP's context: the Amiga's connection may queue
// AS_UP_OOSEQ_BYTES of out-of-order data in the 16 KB heap; every other pcb (TLS) keeps lwIP's default, no limit.
uint32_t amiga_tcp_ooseq_limit(const struct tcp_pcb *pcb) { return pcb == T.pcb ? AS_UP_OOSEQ_BYTES : 0xFFFFFFFFu; }
static int h_up_open(void *ctx, const char *json, char *resp, int cap) { (void)ctx; return dc_upload_open(g_dc, json, resp, cap); }
static int h_up_chunk(void *ctx, const char *id, uint32_t off, const uint8_t *b, uint32_t n, char *resp, int cap) {
    (void)ctx; return dc_upload_chunk(g_dc, id, off, b, (int)n, resp, cap);
}
static int h_up_close(void *ctx, const char *id, const char *json, char *resp, int cap) { (void)ctx; return dc_upload_close(g_dc, id, json, resp, cap); }
```

- in `amiga_tcp_ops`, after `ops->now_ms = h_now;` add
  `ops->upload_open = h_up_open; ops->upload_chunk = h_up_chunk; ops->upload_close = h_up_close; ops->raw_arm = t_raw_arm;`.

In `wifi-floppy/firmware/src/pnet_lwip_hooks.h`, before the final `#endif` add:

```c
// Uploads from the Amiga (fw 1.19.0, spec 2026-10-18 §5; plan 2026-10-19 Task 11): the Amiga's frames are PBUF_RAM in
// lwIP's 16 KB heap (pnet_bridge.c), so out-of-order segments queued for its connection could hold the heap. That pcb
// may queue AS_UP_OOSEQ_BYTES; every other keeps lwIP's default (no limit). tcp_in.c reads the hook; amiga_tcp.c
// defines the function.
#include <stdint.h>
struct tcp_pcb;
uint32_t amiga_tcp_ooseq_limit(const struct tcp_pcb *pcb);
#define TCP_OOSEQ_BYTES_LIMIT(pcb) amiga_tcp_ooseq_limit(pcb)
```

and in its header comment, "only dhcp.c uses the hook" becomes "dhcp.c and tcp_in.c use its hooks".

- [ ] **Step 3: Full-size frames from the Amiga.** In `wifi-floppy/firmware/src/pnet_bridge.c`, replace the
`#if WF_A2B_DISCARD ... #else #define PNET_LOCAL_A2B_MAX 768u #endif` block from Task 1 with
`#define PNET_LOCAL_A2B_MAX PNET_RING_MTU`, and the last two sentences of the comment above it ("768 covers ... bulk
data from the Amiga.") with:

```c
// Uploads (fw 1.19.0, spec 2026-10-18 U9): any frame the ring holds (PNET_RING_MTU; the spec's "1,514" is this cap,
// plan ruling P4). The frame's pbuf lives only until amiga_tcp.c's receive callback copies it into PSRAM and frees
// it, before the next frame is input, so lwIP heap use stays at about one frame (measured in plan Task 1).
```

- [ ] **Step 4: Wire it in main.c.** In `wifi-floppy/firmware/src/main.c`:
- in the `#if WF_PNET_L2` include block beside `#include "amiga_send.h"`, add `#include "key_store.h"     // the board key (fw 1.19.0)`;
- replace the two PSRAM buffer lines (line ~91-92) with:

```c
static __uninitialized_psram("sendq") char g_send_queue_buf[AS_QUEUE_BYTES + 1];
// Sends use the first 16 KB; an upload from the Amiga uses all of it as its ring (fw 1.19.0, spec 2026-10-18 §5).
static __uninitialized_psram("sendc") uint8_t g_send_chunk_buf[AS_UP_RING_BYTES];
// The upload's state, its PUT line and JSON (plan 2026-10-19 ruling P1): PSRAM, SRAM .bss +0.
static __uninitialized_psram("sendup") as_up_t g_send_up;
// The board key (spec 2026-10-18 §5-6): core0 loads or makes it at boot, before core1 starts; core1 only reads it.
static __uninitialized_psram("bkey") struct { uint8_t raw[KEY_STORE_BYTES]; char hex[2 * KEY_STORE_BYTES + 1]; bool ok, unsaved; } g_board_key;
```

- in `main()`, directly after the DF1 boot block (`wf_logf(WF_INFO, "df1: %s at boot (%s)", ...); }`), add:

```c
#if WF_PNET_L2
    // The board key (spec 2026-10-18 §5-6, plan ruling P2): loaded, or made now from pico_rand (TRNG-seeded) and
    // stored by the deferred-write rule below, the drive record's. Usable at once: a reboot before it is stored would
    // make another, and Receive would need TRUST once.
    const bool board_key_backed = psram_check_address((uint8_t *)&g_board_key + sizeof g_board_key - 1);
    if (board_key_backed) {
        g_board_key.ok = true;
        g_board_key.unsaved = !key_store_load(g_board_key.raw);
        if (g_board_key.unsaved) { rng_128_t r; get_rand_128(&r); memcpy(g_board_key.raw, &r, KEY_STORE_BYTES); }
        key_store_hex(g_board_key.raw, g_board_key.hex);
        wf_logf(WF_INFO, "up: board key %.4s%s", g_board_key.hex, g_board_key.unsaved ? " (new, not stored yet)" : "");
    }
#endif
```

- beside `uint32_t drive_save_retry_at = 0;` add `uint32_t key_save_retry_at = 0;   // the board key's store (fw 1.19.0)`;
- in the `#if DF1_CAPABLE` store block, replace the head of the drive record's `if (drive_store_should_write(...` with
  two named values and use them (the expressions are the ones already there):

```c
        const bool store_empty = !disk_mounted && psram_active_slot() == SLOT_NONE && !df1_mounted;
        const bool store_idle = drive_store_idle(clock_ms(), dskchg_motor_on_d(0) || dskchg_motor_on_d(1), !gpio_get(PIN_WGATE),
                                                 // motor_on=true only folds the third time in
                                                 swap_gate_last_activity(g_write_last_ms, g_wgate_last_ms, true, drive_motor_seen_ms),
                                                 g_up_holds);
        if (drive_store_should_write(drive_store_pending, store_empty, store_idle) &&
            (int32_t)(clock_ms() - drive_save_retry_at) >= 0) {
```

  and after that `if`'s closing brace add:

```c
#if WF_PNET_L2
        // The board key made at this boot: the same rule, never in the same pass as the drive record.
        else if (board_key_backed && g_board_key.unsaved && drive_store_should_write(true, store_empty, store_idle) &&
                 (int32_t)(clock_ms() - key_save_retry_at) >= 0) {
            if (key_store_save(g_board_key.raw)) { g_board_key.unsaved = false; wf_logf(WF_INFO, "up: board key stored"); }
            else { key_save_retry_at = clock_ms() + 5000u; wf_logf(WF_WARN, "up: storing the board key failed -- retry in 5 s"); }
        }
#endif
```

- in core1 (line ~2203), the PSRAM check and `as_init` become:

```c
            const bool psram_ok = psram_check_address(&g_send_queue_buf[sizeof g_send_queue_buf - 1]) &&
                                  psram_check_address(&g_send_chunk_buf[sizeof g_send_chunk_buf - 1]) &&
                                  psram_check_address((uint8_t *)&g_send_up + sizeof g_send_up - 1) &&
                                  psram_check_address((uint8_t *)&g_board_key + sizeof g_board_key - 1);
            if (!psram_ok) wf_logf(WF_ERR, "send: buffers are not backed by PSRAM -- sending to the Amiga is off");
            as_init(&g_send, &g_send_ops, psram_ok ? g_send_queue_buf : NULL, psram_ok ? g_send_chunk_buf : NULL,
                    psram_ok ? &g_send_up : NULL);
            // Protocol 2 (fw 1.19.0): the key in the hello, and its 4 digits in the status report (spec §6).
            if (psram_ok && g_board_key.ok) { as_set_key(&g_send, g_board_key.hex); dc_set_up_key(&c, g_board_key.hex); }
```

  and the comment above `static amiga_send_t g_send;` gains "Uploads from the Amiga (1.19.0) use the same engine."

- [ ] **Step 5: The version.** In `wifi-floppy/firmware/CMakeLists.txt:262`, `set(FIRMWARE_SEMVER "1.18.2")` becomes
`set(FIRMWARE_SEMVER "1.19.0")`.

- [ ] **Step 6: Host tests, the build, and the SRAM budget.**

```bash
wifi-floppy/firmware/test/run.sh 2>&1 | tail -3
pnpm firmware:build 2>&1 | tail -3
arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | awk '$1==".bss"{print $2}'
grep -c 'version.*1.19.0' wifi-floppy/firmware/build/generated/wifi_floppy_version.h
```

Expected: no `FAIL`; the build links with no warning about `TCP_OOSEQ_BYTES_LIMIT`; `.bss` **≤ 432,532** (about
421,500 with Task 7's saving; any number above 432,532 stops the task: find the new SRAM static and move it to PSRAM);
the version header names 1.19.0. Record `.bss` for HANDOFF. The heap low-water is a bench reading (B9).

- [ ] **Step 7: Commit.**

```bash
git add wifi-floppy/firmware/src/amiga_tcp.c wifi-floppy/firmware/src/pnet_bridge.c wifi-floppy/firmware/src/pnet_lwip_hooks.h \
        wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/src/amiga_send.h
git commit -m "fw 1.19.0: uploads wired -- raw bytes into the PSRAM ring, full-size Amiga frames, an out-of-order limit, the board key

Window <n> chunks, out-of-order <n> B (<from Task 1 | defaults, B0 not run>). .bss <measured> (budget 432,532).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 12: Server: the tables (migration 0047) and the upload library

**Files:**
- Create: `src/db/schema/amiga-uploads.ts`, `src/lib/amiga-upload-limits.ts`, `src/lib/amiga-uploads.ts`,
  `src/lib/amiga-uploads.db.test.ts`, `drizzle/0047_amiga_uploads.sql` (+ `drizzle/meta/_journal.json`, `drizzle/meta/0047_snapshot.json`, generated)
- Modify: `src/db/schema/devices.ts` (beside `sendRxAt`, line ~243), `src/db/index.ts`, `src/lib/mount.ts` (`recordStatus`)

**Interfaces:**
- Consumes: `cleanAmigaPath` (`src/lib/transfers.ts`), `storeSendBytes` (`src/lib/send-http.ts`), `bytea` and `devices`
  (`src/db/schema/devices.ts`), `disks` (`src/db/schema/catalog.ts`), `firmwareAtLeast` (`src/lib/firmware-version.ts`).
- Produces: tables `amiga_uploads`, `amiga_upload_chunks`, column `devices.up_key`; `src/lib/amiga-upload-limits.ts`:
  `UPLOAD_FW = '1.19.0'`, `UPLOAD_FILE_MAX = 4_194_304`, `UPLOAD_CHUNK = 16_384`, `UPLOAD_AREA_MAX_FILES = 500`,
  `UPLOAD_AREA_MAX_BYTES = 268_435_456`, `UPLOAD_KEEP_MS` (30 d), `UPLOAD_RESUME_MS` (24 h);
  `src/lib/amiga-uploads.ts`: `openUpload(db, dev: {deviceId, orgId}, a: OpenInput, now?) → OpenResult`,
  `storeChunk(db, deviceId, id, offset, data: Uint8Array) → ChunkResult`, `closeUpload(db, deviceId, id, crc, now?) → CloseResult`,
  `listUploads(db, orgId, board: string | null, now?) → UploadView[]`, `getUpload(db, orgId, id) → UploadRow | null`,
  `deleteUpload(db, orgId, id) → boolean`, `clearUploads(db, orgId, before: Date) → number`,
  `setLibraryDisk(db, orgId, id, diskId) → void`, `uploadSummaries(db, orgId, now?) → Record<string, number>`,
  `uploadBoards(db, orgId) → UploadBoard[]`, `expireUploads(db, now?) → { failed: number; deleted: number }`,
  `blobRefsElsewhere(db, shas: string[]) → string[]`; types `OpenInput`, `OpenResult`, `ChunkResult`, `CloseResult`,
  `UploadRow`, `UploadView`, `UploadBoard`. `recordStatus(..., { upKey?: string })`.

- [ ] **Step 1: The schema.** Create `src/db/schema/amiga-uploads.ts`:

```ts
import { bigint, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { bytea, devices } from './devices';

/**
 * The org's "From the Amiga" area (spec 2026-10-18 §4, U6): files a board's Receive sent up. `receiving` while its
 * chunks stage in amiga_upload_chunks (as write-back stages tracks: functions are stateless and blob stores cannot
 * append), `stored` once the close checked size and CRC-32 and put the bytes in the disk store under blob_sha256 (blob
 * GC keeps them while the row is not deleted), `failed` (crc, expired) or `deleted`.
 */
export const amigaUploads = pgTable('amiga_uploads', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
  /** The board's name when the upload opened: the row still names it after the board is unpaired or renamed. */
  deviceName: text('device_name').notNull(),
  /** UTF-8, decoded from Latin-1 and cleaned (cleanAmigaPath). Data only: never a storage key. */
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** Set at the close: the CRC-32 Receive sent, which the bytes matched. */
  crc32: bigint('crc32', { mode: 'number' }),
  protection: bigint('protection', { mode: 'number' }).notNull().default(0),
  comment: text('comment').notNull().default(''),
  /** The Amiga's DateStamp, days.mins.ticks: it identifies the file for resume, nothing else. */
  amigaDate: text('amiga_date').notNull(),
  /** receiving | stored | failed | deleted */
  status: text('status').notNull().default('receiving'),
  receivedBytes: integer('received_bytes').notNull().default(0),
  errorCode: text('error_code'),
  blobSha256: text('blob_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  storedAt: timestamp('stored_at', { withTimezone: true }),
  /** receiving: the 24 h resume window; stored: the 30 days it is kept. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Set by Add to library. */
  libraryDiskId: text('library_disk_id'),
}, (t) => [
  index('amiga_uploads_org_idx').on(t.orgId, t.createdAt),
  index('amiga_uploads_device_idx').on(t.deviceId, t.status),
]);

/** One staged 16 KB chunk (the last may be shorter), deleted at the close. */
export const amigaUploadChunks = pgTable('amiga_upload_chunks', {
  uploadId: text('upload_id').notNull().references(() => amigaUploads.id, { onDelete: 'cascade' }),
  offset: integer('offset').notNull(),
  data: bytea('data').notNull(),
}, (t) => [primaryKey({ columns: [t.uploadId, t.offset] })]);
```

In `src/db/schema/devices.ts`, after `sendRxAt: timestamp('send_rx_at', { withTimezone: true }),` add:

```ts
  // fw 1.19.0 (spec 2026-10-18 §6): the board key's first 4 hex digits (status upKey), shown beside Receive's
  // "Trusted board AB12" so the person can compare them. null until a 1.19.0 board reports it.
  upKey: text('up_key'),
```

In `src/db/index.ts`, add `import * as amigaUploads from './schema/amiga-uploads';` beside the transfers import and
`...amigaUploads,` to the `schema` object after `...transfers,`.

Create `src/lib/amiga-upload-limits.ts`:

```ts
/**
 * Uploads from the Amiga (spec 2026-10-18 U5, §4, §5): the limits the server, the board and the browser share. No
 * imports, so client components can use it.
 */
export const UPLOAD_FW = '1.19.0';
export const UPLOAD_FILE_MAX = 4_194_304;                 // = SEND_FILE_MAX and Receive's RX_FILE_MAX
export const UPLOAD_CHUNK = 16_384;                        // = the board's AS_CHUNK_BYTES
export const UPLOAD_AREA_MAX_FILES = 500;                  // per org
export const UPLOAD_AREA_MAX_BYTES = 256 * 1024 * 1024;    // per org
export const UPLOAD_KEEP_MS = 30 * 24 * 3600_000;          // a stored file is kept 30 days
export const UPLOAD_RESUME_MS = 24 * 3600_000;             // a partial upload resumes for 24 h
```

- [ ] **Step 2: Generate the migration.** Run: `pnpm db:generate --name amiga_uploads`
Expected: `drizzle/0047_amiga_uploads.sql` with `CREATE TABLE "amiga_uploads"`, `CREATE TABLE "amiga_upload_chunks"`,
`ALTER TABLE "devices" ADD COLUMN "up_key" text`, the two foreign keys (`ON DELETE set null`, `ON DELETE cascade`) and
the two indexes. Read it: additive only (no `DROP`, no `ALTER ... TYPE`). If drizzle names it otherwise, rename the
file and its journal tag to `0047_amiga_uploads`. Never run `pnpm db:migrate`.

- [ ] **Step 3: Write the failing db tests.** Create `src/lib/amiga-uploads.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { eq } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_amiga_uploads_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();
const storageDir = mkdtempSync(join(tmpdir(), 'webadf-amiga-uploads-'));
process.env.STORAGE_DIR = storageDir;
process.env.BLOB_READ_WRITE_TOKEN = '';

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { amigaUploads, amigaUploadChunks } = await import('@/db/schema/amiga-uploads');
const { diskStore } = await import('@/lib/storage');
const { recordStatus } = await import('@/lib/mount');
const U = await import('./amiga-uploads');

const db = () => getDb();
let n = 0;
async function device(orgId = 'org-a', name = 'Bench', firmwareVersion: string | null = null) {
  const id = `dev-${++n}`;
  await db().insert(devices).values({ id, orgId, name, tokenHash: `hash-${id}`, firmwareVersion });
  return { deviceId: id, orgId };
}
type Dev = { deviceId: string; orgId: string };
const open = (d: Dev, extra: Partial<Parameters<typeof U.openUpload>[2]> = {}, now?: Date) =>
  U.openUpload(db(), d, { size: 5, date: '1.2.3', protection: 0, path: 'Hello.txt', comment: '', ...extra }, now);
const opened = async (d: Dev, extra: Partial<Parameters<typeof U.openUpload>[2]> = {}) => {
  const r = await open(d, extra);
  if (!r.ok) throw new Error(`open refused: ${r.code}`);
  return r;
};
const row = async (id: string) => (await db().select().from(amigaUploads).where(eq(amigaUploads.id, id)))[0];
const chunkRows = async (id: string) => (await db().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id))).length;
const bytes = (len: number, seed = 1) => { const b = new Uint8Array(len); let x = seed; for (let i = 0; i < len; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const crc = (b: Uint8Array) => crc32(b) >>> 0;
async function upload(d: Dev, data: Uint8Array, path = 'File.bin') {
  const o = await opened(d, { size: data.byteLength, path });
  for (let at = o.offset; at < data.byteLength; at += 16384) {
    expect((await U.storeChunk(db(), d.deviceId, o.id, at, data.subarray(at, Math.min(at + 16384, data.byteLength)))).ok).toBe(true);
  }
  return o.id;
}
async function stored(d: Dev, data: Uint8Array, path = 'File.bin') {
  const id = await upload(d, data, path);
  expect((await U.closeUpload(db(), d.deviceId, id, crc(data))).ok).toBe(true);
  return id;
}
const later = () => new Date(Date.now() + 3600_000);
const filler = (orgId: string, deviceId: string, k: number) => Array.from({ length: k }, (_, i) => ({
  id: `${orgId}-fill-${i}`, orgId, deviceId, deviceName: 'B', path: `f${i}`, sizeBytes: 1, amigaDate: '1.1.1', status: 'stored', expiresAt: later(),
}));

describe('amiga uploads', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("opens at 0 with the board's name, a cleaned path and a 24 h window", async () => {
    const d = await device('org-a', 'Bench A500');
    const now = new Date('2026-10-20T10:00:00Z');
    const r = await U.openUpload(db(), d, { size: 5, date: '1.2.3', protection: 0x40, path: '../Up/Hello.txt', comment: 'a\u0007b' }, now);
    expect(r).toMatchObject({ ok: true, offset: 0 });
    const t = await row((r as { id: string }).id);
    expect(t).toMatchObject({ deviceName: 'Bench A500', path: 'Up/Hello.txt', status: 'receiving', protection: 0x40, comment: 'ab', amigaDate: '1.2.3' });
    expect(t.expiresAt.getTime() - now.getTime()).toBe(24 * 3600_000);
  });

  it('a Latin-1 path is stored as UTF-8', async () => {
    const t = await row((await opened(await device(), { path: 'Café.txt' })).id);
    expect(t.path).toBe('Café.txt');
    expect(Buffer.byteLength(t.path, 'utf8')).toBe(9);
  });

  it('refuses a file over 4 MB and a name that cleans to nothing', async () => {
    const d = await device();
    expect(await open(d, { size: 4_194_305 })).toEqual({ ok: false, code: 'size' });
    expect(await open(d, { path: '../..' })).toEqual({ ok: false, code: 'name' });
  });

  it('resumes the same file from the same board within 24 h, and only that', async () => {
    const d = await device(); const data = bytes(40000);
    const o = await opened(d, { size: 40000 });
    await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384));
    expect(await open(d, { size: 40000 })).toEqual({ ok: true, id: o.id, offset: 16384 });
    expect((await opened(d, { size: 40000, date: '1.2.4' })).id).not.toBe(o.id);
    expect((await opened(await device(), { size: 40000 })).id).not.toBe(o.id);
    const r = await open(d, { size: 40000 }, new Date(Date.now() + 25 * 3600_000));
    expect(r.ok && r.id).not.toBe(o.id);
  });

  it('stores chunks in order: a repeated chunk is not stored twice, a gap is 409, a short chunk mid-file is 400', async () => {
    const d = await device(); const data = bytes(40000);
    const o = await opened(d, { size: 40000 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384))).toEqual({ ok: true, received: 16384 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384))).toEqual({ ok: true, received: 16384 });
    expect(await chunkRows(o.id)).toBe(1);
    expect(await U.storeChunk(db(), d.deviceId, o.id, 32768, data.subarray(32768))).toEqual({ ok: false, status: 409, received: 16384 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 16384, data.subarray(16384, 20000))).toEqual({ ok: false, status: 400 });
    expect(await U.storeChunk(db(), d.deviceId, o.id, 16384, new Uint8Array(16385))).toEqual({ ok: false, status: 400 });
    expect(await U.storeChunk(db(), 'dev-nobody', o.id, 16384, data.subarray(16384, 32768))).toEqual({ ok: false, status: 404 });
  });

  it('closes: size and CRC checked, the bytes in the store, the chunks gone, kept 30 days; a repeat answers the same name', async () => {
    const d = await device(); const data = bytes(40000);
    const id = await upload(d, data);
    const now = new Date();
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data), now)).toEqual({ ok: true, name: 'File.bin' });
    const t = await row(id);
    expect(t).toMatchObject({ status: 'stored', crc32: crc(data), receivedBytes: 40000 });
    expect(Buffer.compare(Buffer.from(await diskStore.read(t.blobSha256!)), Buffer.from(data))).toBe(0);
    expect(await chunkRows(id)).toBe(0);
    expect(t.expiresAt.getTime() - now.getTime()).toBe(30 * 24 * 3600_000);
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data))).toEqual({ ok: true, name: 'File.bin' });
  });

  it('a CRC mismatch is final: failed crc, the chunks gone, and the next send starts at 0', async () => {
    const d = await device(); const data = bytes(20000);
    const id = await upload(d, data, 'Bad.bin');
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data) ^ 1)).toEqual({ ok: false, status: 409, code: 'crc' });
    expect(await row(id)).toMatchObject({ status: 'failed', errorCode: 'crc' });
    expect(await chunkRows(id)).toBe(0);
    const again = await opened(d, { size: 20000, path: 'Bad.bin' });
    expect(again.id).not.toBe(id); expect(again.offset).toBe(0);
  });

  it('a close before every chunk is in is refused, and the upload stays resumable', async () => {
    const d = await device(); const data = bytes(40000);
    const o = await opened(d, { size: 40000, path: 'Half.bin' });
    await U.storeChunk(db(), d.deviceId, o.id, 0, data.subarray(0, 16384));
    expect(await U.closeUpload(db(), d.deviceId, o.id, crc(data))).toEqual({ ok: false, status: 409, code: 'size' });
    expect(await open(d, { size: 40000, path: 'Half.bin' })).toEqual({ ok: true, id: o.id, offset: 16384 });
  });

  it('an empty file is stored', async () => {
    const d = await device();
    const o = await opened(d, { size: 0, path: 'Empty' });
    expect(await U.closeUpload(db(), d.deviceId, o.id, 0)).toEqual({ ok: true, name: 'Empty' });
    expect((await row(o.id)).blobSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('a full but unclosed upload resumes at its size and closes', async () => {
    const d = await device(); const data = bytes(20000);
    const id = await upload(d, data, 'Full.bin');
    expect(await open(d, { size: 20000, path: 'Full.bin' })).toEqual({ ok: true, id, offset: 20000 });
    expect(await U.closeUpload(db(), d.deviceId, id, crc(data))).toEqual({ ok: true, name: 'Full.bin' });
  });

  it('the area counts only rows that still count: 500 files and 256 MB per org', async () => {
    const d = await device('org-limits');
    await db().insert(amigaUploads).values(filler('org-limits', d.deviceId, 499));
    await db().insert(amigaUploads).values([
      { id: 'lim-old', orgId: 'org-limits', deviceId: d.deviceId, deviceName: 'B', path: 'old', sizeBytes: 1, amigaDate: '1.1.1', status: 'stored', expiresAt: new Date(Date.now() - 1000) },
      { id: 'lim-gone', orgId: 'org-limits', deviceId: d.deviceId, deviceName: 'B', path: 'gone', sizeBytes: 1, amigaDate: '1.1.1', status: 'deleted', expiresAt: later() },
      { id: 'lim-bad', orgId: 'org-limits', deviceId: d.deviceId, deviceName: 'B', path: 'bad', sizeBytes: 1, amigaDate: '1.1.1', status: 'failed', expiresAt: later() },
    ]);
    expect((await open(d, { path: 'n500' })).ok).toBe(true);
    expect(await open(d, { path: 'n501' })).toEqual({ ok: false, code: 'full' });
    const e = await device('org-bytes');
    await db().insert(amigaUploads).values({ id: 'huge', orgId: 'org-bytes', deviceId: e.deviceId, deviceName: 'B', path: 'h',
      sizeBytes: 256 * 1024 * 1024 - 10, amigaDate: '1.1.1', status: 'stored', expiresAt: later() });
    expect(await open(e, { size: 11, path: 'one-too-many' })).toEqual({ ok: false, code: 'full' });
    expect((await open(e, { size: 10, path: 'fits' })).ok).toBe(true);
  });

  it('two opens at once with room for one: exactly one passes', async () => {
    const d = await device('org-race');
    await db().insert(amigaUploads).values(filler('org-race', d.deviceId, 499));
    const [a, b] = await Promise.all([open(d, { path: 'race-a' }), open(d, { path: 'race-b' })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('a 4 MB close stays well inside the 60 s function limit', async () => {
    const d = await device(); const data = bytes(4_194_304, 9);
    const id = await upload(d, data, 'Big.bin');
    const t0 = Date.now();
    const r = await U.closeUpload(db(), d.deviceId, id, crc(data));
    const ms = Date.now() - t0;
    console.log(`  4 MB close: ${ms} ms (256 chunk rows)`);
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(20_000);
  }, 120_000);

  it('org scoping: another org never sees, deletes or clears a row', async () => {
    const d = await device('org-own');
    const id = await stored(d, bytes(10), 'Mine.txt');
    expect(await U.getUpload(db(), 'org-other', id)).toBeNull();
    expect(await U.deleteUpload(db(), 'org-other', id)).toBe(false);
    expect(await U.clearUploads(db(), 'org-other', new Date(Date.now() + 1000))).toBe(0);
    expect((await U.listUploads(db(), 'org-other', null)).some((r) => r.id === id)).toBe(false);
    expect((await U.getUpload(db(), 'org-own', id))?.status).toBe('stored');
  });

  it('clear spares a newer row and a receiving row; delete drops a row and its chunks', async () => {
    const d = await device('org-clear');
    const s1 = await stored(d, bytes(10, 2), 'One.txt');
    const recv = await opened(d, { size: 40000, path: 'Moving.bin' });
    await U.storeChunk(db(), d.deviceId, recv.id, 0, bytes(16384, 3));
    const seen = (await row(recv.id)).createdAt;                 // the newest row the person saw
    await new Promise((r) => setTimeout(r, 20));
    const s2 = await stored(d, bytes(10, 4), 'Two.txt');          // arrived while the confirm was open
    expect(await U.clearUploads(db(), 'org-clear', seen)).toBe(1);
    expect((await row(s1)).status).toBe('deleted');
    expect((await row(s2)).status).toBe('stored');
    expect((await row(recv.id)).status).toBe('receiving');
    expect(await U.deleteUpload(db(), 'org-clear', recv.id)).toBe(true);
    expect((await row(recv.id)).status).toBe('deleted');
    expect(await chunkRows(recv.id)).toBe(0);
    expect((await U.listUploads(db(), 'org-clear', null)).map((r) => r.id)).toEqual([s2]);
  });

  it('lists newest first, filtered by board, with the board on each row; a lapsed partial reads failed', async () => {
    const a = await device('org-list', 'Bench'); const b = await device('org-list', 'Den');
    await stored(a, bytes(5, 5), 'A.txt');
    const o = await opened(b, { path: 'B.txt' });
    const all = await U.listUploads(db(), 'org-list', null);
    expect(all.map((r) => r.path)).toEqual(['B.txt', 'A.txt']);
    expect(all.map((r) => r.deviceName)).toEqual(['Den', 'Bench']);
    expect((await U.listUploads(db(), 'org-list', a.deviceId)).map((r) => r.path)).toEqual(['A.txt']);
    const lapsed = await U.listUploads(db(), 'org-list', b.deviceId, new Date(Date.now() + 25 * 3600_000));
    expect(lapsed[0]).toMatchObject({ id: o.id, status: 'failed', errorCode: 'expired' });
  });

  it('the boards for the filter, with their key digits and whether they can upload', async () => {
    const a = await device('org-boards', 'Bench', '1.19.0+gabc');
    await device('org-boards', 'Old', '1.18.2+gdef');
    await recordStatus(a.deviceId, { mountedSha256: null, upKey: 'ab12' });
    expect(await U.uploadBoards(db(), 'org-boards')).toEqual([
      { id: a.deviceId, name: 'Bench', key: 'AB12', canUpload: true },
      { id: expect.any(String), name: 'Old', key: null, canUpload: false },
    ]);
  });

  it('counts files stored within 24 h per board, for the card', async () => {
    const d = await device('org-card');
    await stored(d, bytes(5, 6), 'C1'); await stored(d, bytes(5, 7), 'C2');
    expect(await U.uploadSummaries(db(), 'org-card')).toEqual({ [d.deviceId]: 2 });
    expect(await U.uploadSummaries(db(), 'org-card', new Date(Date.now() + 25 * 3600_000))).toEqual({});
  });

  it('names the blobs an upload or a transfer still holds', async () => {
    const d = await device('org-refs');
    const id = await stored(d, bytes(7, 8), 'Ref.bin');
    const sha = (await row(id)).blobSha256!;
    await db().insert(transfers).values({ id: 't-ref', orgId: 'org-refs', deviceId: d.deviceId, createdByUserId: 'u', path: 'x',
      sizeBytes: 1, crc32: 0, blobSha256: 'f'.repeat(64), expiresAt: later() });
    expect((await U.blobRefsElsewhere(db(), [sha, 'f'.repeat(64), 'e'.repeat(64)])).sort()).toEqual([sha, 'f'.repeat(64)].sort());
    await U.deleteUpload(db(), 'org-refs', id);
    expect(await U.blobRefsElsewhere(db(), [sha])).toEqual([]);
  });

  // Last: it moves the clock for every row in this database.
  it('housekeeping: a partial over 24 h fails expired; stored rows past 30 days and old deleted rows go', async () => {
    const d = await device('org-cron');
    const part = await opened(d, { size: 40000, path: 'Part.bin' });
    await U.storeChunk(db(), d.deviceId, part.id, 0, bytes(16384, 10));
    const keep = await stored(d, bytes(5, 11), 'Keep.txt');
    const gone = await stored(d, bytes(5, 12), 'Gone.txt');
    await U.deleteUpload(db(), 'org-cron', gone);
    const r1 = await U.expireUploads(db(), new Date(Date.now() + 25 * 3600_000));
    expect(r1.failed).toBeGreaterThanOrEqual(1);
    expect(await row(part.id)).toMatchObject({ status: 'failed', errorCode: 'expired' });
    expect(await chunkRows(part.id)).toBe(0);
    expect((await row(keep)).status).toBe('stored');
    const r2 = await U.expireUploads(db(), new Date(Date.now() + 31 * 24 * 3600_000));
    expect(r2.deleted).toBeGreaterThanOrEqual(3);
    expect(await row(keep)).toBeUndefined();
    expect(await row(gone)).toBeUndefined();
    expect(await row(part.id)).toBeUndefined();
  });

  it('recordStatus stores the key digits', async () => {
    const d = await device();
    await recordStatus(d.deviceId, { mountedSha256: null, upKey: 'cd34' });
    expect((await db().select({ k: devices.upKey }).from(devices).where(eq(devices.id, d.deviceId)))[0].k).toBe('cd34');
  });
});
```

Run: `pnpm db:dev start` (once; it prints the URL), then
`TEST_DATABASE_URL=<that URL> pnpm test:db src/lib/amiga-uploads.db.test.ts`
Expected: FAIL (`./amiga-uploads` cannot be resolved).

- [ ] **Step 4: The library.** Create `src/lib/amiga-uploads.ts`:

```ts
import { crc32 } from 'node:zlib';
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { transfers } from '@/db/schema/transfers';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { cleanAmigaPath } from '@/lib/transfers';
import { storeSendBytes } from '@/lib/send-http';
import { firmwareAtLeast } from '@/lib/firmware-version';
import {
  UPLOAD_AREA_MAX_BYTES, UPLOAD_AREA_MAX_FILES, UPLOAD_CHUNK, UPLOAD_FILE_MAX, UPLOAD_FW, UPLOAD_KEEP_MS, UPLOAD_RESUME_MS,
} from '@/lib/amiga-upload-limits';

// Uploads from the Amiga (spec 2026-10-18 §4): the board's open / chunk / close, and the person's area.

export type UploadRow = typeof amigaUploads.$inferSelect;
const LIVE = ['receiving', 'stored'];

export type OpenInput = { size: number; date: string; protection: number; path: string; comment: string };
export type OpenResult = { ok: true; id: string; offset: number } | { ok: false; code: 'size' | 'full' | 'name' };

/** Resumes the same file from the same board (path, size, date) within 24 h, or opens a new one within the org's limits. */
export async function openUpload(db: Db, dev: { deviceId: string; orgId: string }, a: OpenInput, now = new Date()): Promise<OpenResult> {
  if (!Number.isSafeInteger(a.size) || a.size < 0 || a.size > UPLOAD_FILE_MAX) return { ok: false, code: 'size' };
  const path = cleanAmigaPath(a.path);
  if (!path) return { ok: false, code: 'name' };
  const comment = a.comment.replace(/[^\x20-\x7e\xa0-\xff]/g, '').slice(0, 79);
  return db.transaction(async (tx) => {
    // The count and the insert under one lock per org: READ COMMITTED alone lets two opens count the same rows (ruling P8).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`amiga_uploads:${dev.orgId}`}))`);
    const [same] = await tx.select({ id: amigaUploads.id, received: amigaUploads.receivedBytes }).from(amigaUploads)
      .where(and(eq(amigaUploads.deviceId, dev.deviceId), eq(amigaUploads.status, 'receiving'), eq(amigaUploads.path, path),
        eq(amigaUploads.sizeBytes, a.size), eq(amigaUploads.amigaDate, a.date), gt(amigaUploads.expiresAt, now)))
      .orderBy(desc(amigaUploads.createdAt)).limit(1);
    if (same) return { ok: true as const, id: same.id, offset: same.received };
    // Only rows that still count (3bv I1): receiving within its 24 h, stored within its 30 days.
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<string>`coalesce(sum(${amigaUploads.sizeBytes}),0)::bigint` })
      .from(amigaUploads)
      .where(and(eq(amigaUploads.orgId, dev.orgId), inArray(amigaUploads.status, LIVE), gt(amigaUploads.expiresAt, now)));
    if (load.n + 1 > UPLOAD_AREA_MAX_FILES || Number(load.b) + a.size > UPLOAD_AREA_MAX_BYTES) {
      return { ok: false as const, code: 'full' as const };
    }
    const [d] = await tx.select({ name: devices.name }).from(devices).where(eq(devices.id, dev.deviceId));
    const id = crypto.randomUUID();
    await tx.insert(amigaUploads).values({ id, orgId: dev.orgId, deviceId: dev.deviceId, deviceName: d?.name ?? 'Board',
      path, sizeBytes: a.size, protection: a.protection >>> 0, comment, amigaDate: a.date,
      expiresAt: new Date(now.getTime() + UPLOAD_RESUME_MS) });
    return { ok: true as const, id, offset: 0 };
  });
}

export type ChunkResult = { ok: true; received: number } | { ok: false; status: 400 | 404 | 409; received?: number };

/** One chunk at `offset`: stored when it is the next one; a retry of a stored one changes nothing; a gap is 409. */
export async function storeChunk(db: Db, deviceId: string, id: string, offset: number, data: Uint8Array): Promise<ChunkResult> {
  if (data.byteLength < 1 || data.byteLength > UPLOAD_CHUNK) return { ok: false, status: 400 };
  return db.transaction(async (tx) => {
    const [r] = await tx.select({ size: amigaUploads.sizeBytes, received: amigaUploads.receivedBytes, status: amigaUploads.status })
      .from(amigaUploads).where(and(eq(amigaUploads.id, id), eq(amigaUploads.deviceId, deviceId))).for('update');
    if (!r || r.status !== 'receiving') return { ok: false as const, status: 404 as const };
    if (offset < r.received) return { ok: true as const, received: r.received };   // a retry after a lost answer
    if (offset > r.received) return { ok: false as const, status: 409 as const, received: r.received };
    const end = offset + data.byteLength;
    // Every chunk is 16 KB but the last, so a resume offset is always a chunk boundary.
    if (end > r.size || (data.byteLength !== UPLOAD_CHUNK && end !== r.size)) return { ok: false as const, status: 400 as const };
    await tx.insert(amigaUploadChunks).values({ uploadId: id, offset, data });
    await tx.update(amigaUploads).set({ receivedBytes: end }).where(eq(amigaUploads.id, id));
    return { ok: true as const, received: end };
  });
}

export type CloseResult = { ok: true; name: string } | { ok: false; status: 404 | 409; code: 'crc' | 'size' | 'gone' };

/** The close (spec §4): every byte in order, the size and the CRC-32, then the bytes into the disk store. */
export async function closeUpload(db: Db, deviceId: string, id: string, crc: number, now = new Date()): Promise<CloseResult> {
  const [r] = await db.select().from(amigaUploads).where(and(eq(amigaUploads.id, id), eq(amigaUploads.deviceId, deviceId)));
  if (!r) return { ok: false, status: 404, code: 'gone' };
  if (r.status === 'stored') return { ok: true, name: r.path };   // a repeat after a lost answer
  if (r.status !== 'receiving') return { ok: false, status: 409, code: 'gone' };
  const parts = await db.select({ offset: amigaUploadChunks.offset, data: amigaUploadChunks.data }).from(amigaUploadChunks)
    .where(eq(amigaUploadChunks.uploadId, id)).orderBy(asc(amigaUploadChunks.offset));
  const bytes = new Uint8Array(r.sizeBytes);
  let at = 0;
  for (const p of parts) {
    if (p.offset !== at || at + p.data.byteLength > r.sizeBytes) return { ok: false, status: 409, code: 'size' };
    bytes.set(p.data, at);
    at += p.data.byteLength;
  }
  if (at !== r.sizeBytes) return { ok: false, status: 409, code: 'size' };   // not every chunk is in: the board resumes
  if ((crc32(bytes) >>> 0) !== crc >>> 0) {
    // Final (spec §4): the chunks go, so the next send of this file starts at 0.
    await db.transaction(async (tx) => {
      await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id));
      await tx.update(amigaUploads).set({ status: 'failed', errorCode: 'crc' }).where(eq(amigaUploads.id, id));
    });
    return { ok: false, status: 409, code: 'crc' };
  }
  const sha = await storeSendBytes(bytes);   // adf/<sha256> through diskStore: local folder or Vercel Blob (ruling P5)
  await db.transaction(async (tx) => {
    await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id));
    await tx.update(amigaUploads).set({ status: 'stored', crc32: crc >>> 0, blobSha256: sha, storedAt: now, receivedBytes: r.sizeBytes,
      expiresAt: new Date(now.getTime() + UPLOAD_KEEP_MS) })
      .where(and(eq(amigaUploads.id, id), eq(amigaUploads.status, 'receiving')));
  });
  return { ok: true, name: r.path };
}

export type UploadView = {
  id: string; path: string; sizeBytes: number; status: 'receiving' | 'stored' | 'failed'; receivedBytes: number;
  errorCode: string | null; deviceId: string | null; deviceName: string; createdAt: number; storedAt: number | null;
  expiresAt: number; libraryDiskId: string | null; libraryGameId: string | null;
};
export function toUploadView(r: UploadRow & { libraryGameId?: string | null }, now: number): UploadView {
  // A partial past its 24 h never moves again: it reads failed at once, as the daily cron will mark it.
  const lapsed = r.status === 'receiving' && r.expiresAt.getTime() <= now;
  return {
    id: r.id, path: r.path, sizeBytes: r.sizeBytes, status: lapsed ? 'failed' : (r.status as UploadView['status']),
    receivedBytes: r.receivedBytes, errorCode: lapsed ? 'expired' : r.errorCode, deviceId: r.deviceId, deviceName: r.deviceName,
    createdAt: r.createdAt.getTime(), storedAt: r.storedAt?.getTime() ?? null, expiresAt: r.expiresAt.getTime(),
    libraryDiskId: r.libraryDiskId, libraryGameId: r.libraryGameId ?? null,
  };
}

/** The org's area, newest first; `board` filters it. A stored row past its 30 days is gone already for the person. */
export async function listUploads(db: Db, orgId: string, board: string | null, now = new Date()): Promise<UploadView[]> {
  const rows = await db.select({ u: amigaUploads, gameId: disks.gameId }).from(amigaUploads)
    .leftJoin(disks, and(eq(disks.id, amigaUploads.libraryDiskId), eq(disks.orgId, orgId)))
    .where(and(eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted'),
      or(ne(amigaUploads.status, 'stored'), gt(amigaUploads.expiresAt, now)),
      board ? eq(amigaUploads.deviceId, board) : undefined))
    .orderBy(desc(amigaUploads.createdAt), desc(amigaUploads.id)).limit(UPLOAD_AREA_MAX_FILES);
  return rows.map((r) => toUploadView({ ...r.u, libraryGameId: r.gameId }, now.getTime()));
}

export async function getUpload(db: Db, orgId: string, id: string): Promise<UploadRow | null> {
  const [r] = await db.select().from(amigaUploads)
    .where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')));
  return r ?? null;
}

/** Delete one file: the row reads deleted and its chunks go now; the blob goes at the next weekly GC if nothing else holds it. */
export async function deleteUpload(db: Db, orgId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(amigaUploads).set({ status: 'deleted' })
      .where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')))
      .returning({ id: amigaUploads.id });
    if (done.length === 0) return false;
    await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id));
    return true;
  });
}

/** Clear all (spec §4): every stored or failed row up to `before` (the newest the person saw); a receiving row stays. */
export async function clearUploads(db: Db, orgId: string, before: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const done = await tx.update(amigaUploads).set({ status: 'deleted' })
      .where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.status, ['stored', 'failed']), lte(amigaUploads.createdAt, before)))
      .returning({ id: amigaUploads.id });
    if (done.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, done.map((d) => d.id)));
    return done.length;
  });
}

export async function setLibraryDisk(db: Db, orgId: string, id: string, diskId: string): Promise<void> {
  await db.update(amigaUploads).set({ libraryDiskId: diskId }).where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId)));
}

/** Per board, for the card's line (spec §4): files stored within the last 24 h. */
export async function uploadSummaries(db: Db, orgId: string, now = new Date()): Promise<Record<string, number>> {
  const rows = await db.select({ deviceId: amigaUploads.deviceId, n: sql<number>`count(*)::int` }).from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), eq(amigaUploads.status, 'stored'), gt(amigaUploads.storedAt, new Date(now.getTime() - 24 * 3600_000))))
    .groupBy(amigaUploads.deviceId);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.deviceId) out[r.deviceId] = r.n;
  return out;
}

export type UploadBoard = { id: string; name: string; key: string | null; canUpload: boolean };
/** The org's boards for the filter, with the key digits Receive shows ("Trusted board AB12", spec §6). */
export async function uploadBoards(db: Db, orgId: string): Promise<UploadBoard[]> {
  const rows = await db.select({ id: devices.id, name: devices.name, upKey: devices.upKey, fw: devices.firmwareVersion })
    .from(devices).where(eq(devices.orgId, orgId)).orderBy(asc(devices.name), asc(devices.id));
  return rows.map((r) => ({ id: r.id, name: r.name, key: r.upKey ? r.upKey.toUpperCase() : null, canUpload: firmwareAtLeast(r.fw, UPLOAD_FW) }));
}

/**
 * The daily /api/cron/transfers pass (spec §4 housekeeping): a partial past its 24 h fails (expired) and drops its
 * chunks; a stored row past its 30 days goes, as do failed and deleted rows older than 30 days (plan addition: the
 * table does not grow for ever). The blobs go at the next weekly GC once nothing names them.
 */
export async function expireUploads(db: Db, now = new Date()): Promise<{ failed: number; deleted: number }> {
  return db.transaction(async (tx) => {
    const failed = await tx.update(amigaUploads).set({ status: 'failed', errorCode: 'expired' })
      .where(and(eq(amigaUploads.status, 'receiving'), lte(amigaUploads.expiresAt, now)))
      .returning({ id: amigaUploads.id });
    if (failed.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, failed.map((f) => f.id)));
    const old = new Date(now.getTime() - UPLOAD_KEEP_MS);
    const deleted = await tx.delete(amigaUploads)
      .where(or(and(eq(amigaUploads.status, 'stored'), lte(amigaUploads.expiresAt, now)),
        and(inArray(amigaUploads.status, ['failed', 'deleted']), lt(amigaUploads.createdAt, old))))
      .returning({ id: amigaUploads.id });
    return { failed: failed.length, deleted: deleted.length };
  });
}

/** Of `shas`, those a live upload or any transfer still names: never released by ingest (plan ruling P6). */
export async function blobRefsElsewhere(db: Db, shas: string[]): Promise<string[]> {
  if (shas.length === 0) return [];
  const [u, t] = await Promise.all([
    db.selectDistinct({ s: amigaUploads.blobSha256 }).from(amigaUploads)
      .where(and(inArray(amigaUploads.blobSha256, shas), ne(amigaUploads.status, 'deleted'))),
    db.selectDistinct({ s: transfers.blobSha256 }).from(transfers).where(inArray(transfers.blobSha256, shas)),
  ]);
  return [...new Set([...u, ...t].flatMap((r) => (r.s ? [r.s] : [])))];
}
```

In `src/lib/mount.ts`, `recordStatus`'s parameter type gains (after `nfcFail?: string;`)
`/** The board key's first 4 hex digits (fw 1.19.0), until a report carrying them is heard. */ upKey?: string;`, and
after the `nfcFail` block add:

```ts
  // fw 1.19.0 (spec 2026-10-18 §6): stored when sent, never cleared by a report without it (it rides until heard).
  if (s.upKey !== undefined && /^[0-9a-f]{4}$/.test(s.upKey)) patch.upKey = s.upKey;
```

- [ ] **Step 5: Run the tests.**

```bash
TEST_DATABASE_URL=<the db:dev URL> pnpm test:db src/lib/amiga-uploads.db.test.ts src/lib/transfers.db.test.ts
pnpm exec tsc --noEmit
```

Expected: every test passes; `4 MB close: <n> ms` printed (record it for HANDOFF); tsc prints nothing.

- [ ] **Step 6: Commit.**

```bash
git add src/db/schema/amiga-uploads.ts src/db/schema/devices.ts src/db/index.ts src/lib/amiga-upload-limits.ts \
        src/lib/amiga-uploads.ts src/lib/amiga-uploads.db.test.ts src/lib/mount.ts drizzle/0047_amiga_uploads.sql \
        drizzle/meta/_journal.json drizzle/meta/0047_snapshot.json
git commit -m "uploads: amiga_uploads + chunks (migration 0047), open/chunk/close with per-org limits under a lock, the area

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 13: Server: the board's upload routes and `upKey` on the status route

**Files:**
- Create: `src/lib/read-capped.ts`, `src/app/api/device/upload/route.ts`, `src/app/api/device/upload/[id]/route.ts`,
  `src/app/api/device/upload/[id]/close/route.ts`, `src/app/api/device/upload/routes.test.ts`
- Modify: `src/app/api/transfers/route.ts` (uses `readCapped` from the new module), `src/app/api/device/status/route.ts`,
  `src/app/api/device/status/route.test.ts`

**Interfaces:**
- Consumes: Task 12 (`openUpload`, `storeChunk`, `closeUpload`, `UPLOAD_CHUNK`); `requireDevice`/`deviceAuthResponse`;
  `recordSendRx` (`src/lib/transfers.ts`).
- Produces: `POST /api/device/upload` → 200 `{id, offset}` | 400 `{code:'name'|'server'}` | 409 `{code:'full'}` | 413 `{code:'size'}`;
  `POST /api/device/upload/<id>?offset=<o>` → 200 `{received}` | 409 `{received}` | 404 `{code:'gone'}` | 400 `{code:'server'}`;
  `POST /api/device/upload/<id>/close` → 200 `{name}` | 409 `{code:'crc'|'size'|'gone'}` | 404 `{code:'gone'}`;
  `export async function readCapped(request: Request, max: number): Promise<Uint8Array | null>`; status body `upKey`.

- [ ] **Step 1: Read the route-handler guide.** `ls node_modules/next/dist/docs/` and read the route handlers page
(dynamic `params` are a Promise; `request.json()`; `maxDuration`). The repo's routes already follow it.

- [ ] **Step 2: Write the failing tests.** Create `src/app/api/device/upload/routes.test.ts`:

```ts
// The board's upload routes (spec 2026-10-18 §4): open, chunk, close. The library is mocked; its db tests are Task 12's.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/device-auth', () => ({
  requireDevice: async () => ({ deviceId: 'd1', orgId: 'o1' }),
  deviceAuthResponse: () => null,
}));
vi.mock('@/db', () => ({ getDb: () => ({}) }));
const openUpload = vi.fn();
const storeChunk = vi.fn();
const closeUpload = vi.fn();
vi.mock('@/lib/amiga-uploads', () => ({
  openUpload: (...a: unknown[]) => openUpload(...a), storeChunk: (...a: unknown[]) => storeChunk(...a),
  closeUpload: (...a: unknown[]) => closeUpload(...a),
}));
const recordSendRx = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/transfers', () => ({ recordSendRx: (...a: unknown[]) => recordSendRx(...a) }));

const { POST: openPOST } = await import('./route');
const { POST: chunkPOST } = await import('./[id]/route');
const { POST: closePOST } = await import('./[id]/close/route');
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (path: string, body: unknown) => new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const OPEN = { size: 5, date: '1.2.3', protection: 0, path: 'Café.txt', comment: '' };

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/device/upload', () => {
  it('opens for the token\'s board and org, never the body\'s, and answers id and offset', async () => {
    openUpload.mockResolvedValue({ ok: true, id: 'u1', offset: 16384 });
    const r = await openPOST(json('/api/device/upload', { ...OPEN, orgId: 'evil' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 'u1', offset: 16384 });
    expect(openUpload).toHaveBeenCalledWith(expect.anything(), { deviceId: 'd1', orgId: 'o1' },
      { size: 5, date: '1.2.3', protection: 0, path: 'Café.txt', comment: '' });
  });
  it('maps refusals to their codes and statuses', async () => {
    for (const [code, status] of [['size', 413], ['full', 409], ['name', 400]] as const) {
      openUpload.mockResolvedValueOnce({ ok: false, code });
      const r = await openPOST(json('/api/device/upload', OPEN));
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ code });
    }
  });
  it('refuses a malformed body with code server, before the library', async () => {
    for (const b of [{ ...OPEN, size: -1 }, { ...OPEN, date: 'yesterday' }, { ...OPEN, path: '' }, 'not json']) {
      const r = await openPOST(typeof b === 'string'
        ? new Request('http://x/api/device/upload', { method: 'POST', body: b }) : json('/api/device/upload', b));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ code: 'server' });
    }
    expect(openUpload).not.toHaveBeenCalled();
  });
});

describe('POST /api/device/upload/<id>', () => {
  const post = (qs: string, body: Uint8Array) => chunkPOST(new Request(`http://x/api/device/upload/u1?${qs}`,
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body }), params('u1'));
  it('stores the chunk at the offset, answers received, and keeps the receiver reading as running', async () => {
    storeChunk.mockResolvedValue({ ok: true, received: 16384 });
    const r = await post('offset=0', new Uint8Array(16384).fill(7));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: 16384 });
    const [, dev, id, off, data] = storeChunk.mock.calls[0];
    expect([dev, id, off, (data as Uint8Array).byteLength]).toEqual(['d1', 'u1', 0, 16384]);
    expect(recordSendRx).toHaveBeenCalledWith(expect.anything(), 'd1', 'c');
  });
  it('answers a gap with 409 and the stored count, a gone upload with 404, a bad request with 400', async () => {
    storeChunk.mockResolvedValueOnce({ ok: false, status: 409, received: 16384 });
    let r = await post('offset=32768', new Uint8Array(10));
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ received: 16384 });
    storeChunk.mockResolvedValueOnce({ ok: false, status: 404 });
    r = await post('offset=0', new Uint8Array(10));
    expect(r.status).toBe(404); expect(await r.json()).toEqual({ code: 'gone' });
    r = await post('offset=x', new Uint8Array(10));
    expect(r.status).toBe(400);
    r = await post('offset=0', new Uint8Array(16385));
    expect(r.status).toBe(400);                                  // over 16 KB: refused before the library
    r = await post('offset=0', new Uint8Array(0));
    expect(r.status).toBe(400);
    expect(storeChunk).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/device/upload/<id>/close', () => {
  it('answers the stored name, or the refusal', async () => {
    closeUpload.mockResolvedValueOnce({ ok: true, name: 'Café.txt' });
    let r = await closePOST(json('/api/device/upload/u1/close', { crc32: 907060870 }), params('u1'));
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ name: 'Café.txt' });
    expect(closeUpload).toHaveBeenCalledWith(expect.anything(), 'd1', 'u1', 907060870);
    closeUpload.mockResolvedValueOnce({ ok: false, status: 409, code: 'crc' });
    r = await closePOST(json('/api/device/upload/u1/close', { crc32: 1 }), params('u1'));
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ code: 'crc' });
    r = await closePOST(json('/api/device/upload/u1/close', { crc32: -1 }), params('u1'));
    expect(r.status).toBe(400);
  });
});
```

In `src/app/api/device/status/route.test.ts`: `RecordStatusArg` gains `upKey?: string;`, and add:

```ts
describe('POST /api/device/status -- upKey (fw 1.19.0)', () => {
  it('passes 4 lower-case hex digits through, and drops anything else without a 400', async () => {
    const { POST } = await import('./route');
    expect((await POST(post({ mountedSha256: null, upKey: 'ab12' }))).status).toBe(204);
    expect(recordStatus.mock.calls[0]![1].upKey).toBe('ab12');
    for (const upKey of ['AB12', 'ab1', 'ab123', 'zz12', 12]) {
      recordStatus.mockClear();
      expect((await POST(post({ mountedSha256: null, upKey }))).status).toBe(204);
      expect(recordStatus.mock.calls[0]![1].upKey).toBeUndefined();
    }
  });
});
```

Run: `pnpm vitest run src/app/api/device/upload/routes.test.ts src/app/api/device/status/route.test.ts`
Expected: FAIL (the routes do not exist; upKey is dropped).

- [ ] **Step 3: The routes.** Create `src/lib/read-capped.ts` (moved out of `src/app/api/transfers/route.ts`, unchanged):

```ts
/** The request body, or null as soon as it passes `max` bytes (the rest is cancelled unread). */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(seen);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
```

In `src/app/api/transfers/route.ts` delete the local `readCapped` and add `import { readCapped } from '@/lib/read-capped';`.

Create `src/app/api/device/upload/route.ts`:

```ts
// Opens an upload from the Amiga (spec 2026-10-18 §4): the board relays Receive's PUT as JSON. The org and the board
// come from the device token, never from the body.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { openUpload } from '@/lib/amiga-uploads';

const body = z.object({
  size: z.number().int().min(0).max(0xFFFFFFFF),
  date: z.string().regex(/^\d{1,6}\.\d{1,5}\.\d{1,5}$/),
  protection: z.number().int().min(0).max(0xFFFFFFFF),
  path: z.string().min(1).max(1024),
  comment: z.string().max(400).default(''),
});
const STATUS = { size: 413, full: 409, name: 400 } as const;

export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ code: 'server' }, { status: 400 });
  }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ code: 'server' }, { status: 400 });
  const r = await openUpload(getDb(), device, p.data);
  if (!r.ok) return Response.json({ code: r.code }, { status: STATUS[r.code] });
  return Response.json({ id: r.id, offset: r.offset }, { headers: { 'cache-control': 'no-store' } });
}
```

Create `src/app/api/device/upload/[id]/route.ts`:

```ts
// One chunk of an upload from the Amiga (spec 2026-10-18 §4): ?offset=, a raw body of 1..16,384 bytes. Equal to what
// the server has: stored. Below it: a retry, answered with what it has. Above it: 409 -- the board cannot fill a gap,
// so it ends the file and the next PUT resumes.
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { storeChunk } from '@/lib/amiga-uploads';
import { recordSendRx } from '@/lib/transfers';
import { readCapped } from '@/lib/read-capped';
import { UPLOAD_CHUNK } from '@/lib/amiga-upload-limits';

export const maxDuration = 60;

const int = (v: string | null) => (v !== null && /^\d{1,10}$/.test(v) ? Number(v) : null);

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  const { id } = await ctx.params;
  const offset = int(new URL(request.url).searchParams.get('offset'));
  if (offset === null) return Response.json({ code: 'server' }, { status: 400 });
  const data = await readCapped(request, UPLOAD_CHUNK);
  if (!data || data.byteLength === 0) return Response.json({ code: 'server' }, { status: 400 });
  const db = getDb();
  const r = await storeChunk(db, device.deviceId, id, offset, data);
  // A board posting chunks is talking to Receive and skips its polls meanwhile: keep "Receive is running" fresh, as
  // the send chunk route does (recordSendRx writes on a change or after 30 s).
  await recordSendRx(db, device.deviceId, 'c');
  if (r.ok) return Response.json({ received: r.received }, { headers: { 'cache-control': 'no-store' } });
  if (r.status === 409) return Response.json({ received: r.received }, { status: 409 });
  if (r.status === 404) return Response.json({ code: 'gone' }, { status: 404 });
  return Response.json({ code: 'server' }, { status: 400 });
}
```

Create `src/app/api/device/upload/[id]/close/route.ts`:

```ts
// Closes an upload from the Amiga (spec 2026-10-18 §4): the size and the CRC-32 Receive computed over the whole file.
// A 4 MB close reads 256 chunk rows (Task 12 timed it).
import { z } from 'zod';
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { closeUpload } from '@/lib/amiga-uploads';

export const maxDuration = 60;

const body = z.object({ crc32: z.number().int().min(0).max(0xFFFFFFFF) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  const { id } = await ctx.params;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ code: 'server' }, { status: 400 });
  }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ code: 'server' }, { status: 400 });
  const r = await closeUpload(getDb(), device.deviceId, id, p.data.crc32);
  if (r.ok) return Response.json({ name: r.name }, { headers: { 'cache-control': 'no-store' } });
  return Response.json({ code: r.code }, { status: r.status });
}
```

In `src/app/api/device/status/route.ts`, in `statusBody` after the `nfcFail` line add
`upKey: z.string().regex(/^[0-9a-f]{4}$/).optional().catch(undefined),   // fw 1.19.0: the board key's first 4 digits`,
and in the `recordStatus(...)` call after `nfcFail: parsed.data.nfcFail,` add `upKey: parsed.data.upKey,`.

- [ ] **Step 4: Run the tests.**

```bash
pnpm vitest run src/app/api/device/upload/routes.test.ts src/app/api/device/status/route.test.ts src/app/api/transfers/routes.test.ts
pnpm exec tsc --noEmit
```

Expected: all pass; tsc prints nothing.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/read-capped.ts src/app/api/device/upload src/app/api/transfers/route.ts \
        src/app/api/device/status/route.ts src/app/api/device/status/route.test.ts
git commit -m "uploads: the board's open/chunk/close routes; upKey on the status route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 14: Server: housekeeping -- the daily cron, the weekly GC, org deletion, refused-bytes release

**Files:**
- Modify: `src/app/api/cron/transfers/route.ts`, `src/app/api/cron/transfers/route.test.ts`
- Modify: `src/lib/blob-gc-run.ts`, `src/lib/blob-gc-run.test.ts`
- Modify: `src/lib/admin-delete.ts`, `src/lib/ingest-complete.ts`

**Interfaces:**
- Consumes: Task 12 (`expireUploads`, `blobRefsElsewhere`, `amigaUploads`).
- Produces: `GET /api/cron/transfers` answers `{ expired, deleted, uploadsFailed, uploadsDeleted }`; `runBlobGc` keeps
  every `amiga_uploads.blob_sha256` whose row is not deleted; `deleteUserCascade` deletes the org's `amiga_uploads`;
  `registerUploads`' release never deletes bytes an upload or a transfer names.

- [ ] **Step 1: Write the failing tests.** In `src/app/api/cron/transfers/route.test.ts`, mock the uploads library and
change the counts test:

```ts
const expireUploads = vi.fn(async () => ({ failed: 1, deleted: 3 }));
vi.mock('@/lib/amiga-uploads', () => ({ expireUploads: () => expireUploads() }));
```

(beside the existing `vi.mock('@/lib/transfers', ...)`), and in `'expires and deletes, and reports the counts'`:

```ts
    expect(await r.json()).toEqual({ expired: 2, deleted: 5, uploadsFailed: 1, uploadsDeleted: 3 });
    expect(expireUploads).toHaveBeenCalledTimes(1);
```

and in the refusal test add `expect(expireUploads).not.toHaveBeenCalled();`.

In `src/lib/blob-gc-run.test.ts`: add `import { amigaUploads } from '@/db/schema/amiga-uploads';` and
`const UPLOADED = 'd'.repeat(64);   // a file from the Amiga: only amiga_uploads names it (spec 2026-10-18 §4)`; the
fake `rows` becomes:

```ts
const rows = (table?: unknown) => {
  const found = table === transfers ? [{ s: QUEUED }] : [];
  const p = Promise.resolve(found as unknown[]);
  // .where(): the cover pass (games) and the uploads reference (amiga_uploads, status <> deleted).
  return Object.assign(p, { where: () => Promise.resolve((table === amigaUploads ? [{ s: UPLOADED }] : []) as unknown[]) });
};
```

`listAll` gains `{ sha256: UPLOADED, uploadedAt: OLD }`, the first test's `expect(result.objects).toBe(1)` stays (only
ORPHAN goes), and add:

```ts
  it('keeps a file an amiga_uploads row names (from the Amiga), however old', async () => {
    const { runBlobGc } = await import('./blob-gc-run');
    await runBlobGc({ dryRun: false });
    expect(remove).not.toHaveBeenCalledWith(UPLOADED);
  });
```

Run: `pnpm vitest run src/app/api/cron/transfers/route.test.ts src/lib/blob-gc-run.test.ts`
Expected: FAIL (no upload counts; UPLOADED deleted).

- [ ] **Step 2: The cron.** `src/app/api/cron/transfers/route.ts` becomes:

```ts
import { getDb } from '@/db';
import { expireTransfers } from '@/lib/transfers';
import { expireUploads } from '@/lib/amiga-uploads';

/**
 * Daily (vercel.ts; the self-host scheduler runs the same list): files waiting for an Amiga longer than 24 h are
 * marked expired, and rows finished more than 7 days ago are deleted (PaulaNET Phase 4, spec 2026-10-16 §4). Uploads
 * from the Amiga (spec 2026-10-18 §4): a partial upload older than 24 h fails and drops its chunks; a stored file
 * past its 30 days goes. Guarded like every cron: the shared CRON_SECRET, failing CLOSED when unset.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const db = getDb();
  const result = await expireTransfers(db);
  const up = await expireUploads(db);
  console.log(`transfers: expired ${result.expired}, deleted ${result.deleted}; uploads: failed ${up.failed}, deleted ${up.deleted}`);
  return Response.json({ ...result, uploadsFailed: up.failed, uploadsDeleted: up.deleted });
}
```

- [ ] **Step 3: The GC reference.** In `src/lib/blob-gc-run.ts`: import `ne` from `drizzle-orm` (beside `inArray, isNotNull`)
and `import { amigaUploads } from '@/db/schema/amiga-uploads';`; the `Promise.all` destructuring gains `uploadRefs`
after `sendRefs`, with this element after the transfers one:

```ts
    // Files from the Amiga (spec 2026-10-18 §4): kept while their row is not deleted. A deleted row's bytes go at the
    // next GC after a week's grace, unless a library disk or a transfer names them too.
    db.selectDistinct({ s: amigaUploads.blobSha256 }).from(amigaUploads).where(ne(amigaUploads.status, 'deleted')),
```

and the loop `for (const list of [diskRefs, entRefs, histBlob, histImage, sessionRefs, derived, sendRefs])` gains `uploadRefs`.

- [ ] **Step 4: Org deletion and refused bytes.** In `src/lib/admin-delete.ts` import `amigaUploads` from
`@/db/schema/amiga-uploads` and, inside `for (const orgId of orgIds)`, before the `devicesIdx.push(...)` statement add:

```ts
    // The org's From the Amiga area (spec 2026-10-18): its device_id is set null when a board goes, so the org's
    // own delete is what removes it (chunks follow by cascade). Blobs are left to the weekly GC, as everywhere here.
    stmts.push(tx.delete(amigaUploads).where(eq(amigaUploads.orgId, orgId)));
```

In `src/lib/ingest-complete.ts` import `blobRefsElsewhere` from `@/lib/amiga-uploads`; in `releaseRefused`, the
`Promise.all` gains a fifth element `blobRefsElsewhere(db, shas)` destructured as `elsewhere`, and the call becomes:

```ts
  const releasable = selectReleasableUploads(
    shas,
    rowed.map((r) => r.sha256),
    diskRefs.map((r) => r.sha256),
    entRefs.map((r) => r.sha256),
    // History, plus bytes a file from the Amiga or a queued transfer names: Add to library hands registerUploads bytes
    // the From the Amiga area still shows (plan 2026-10-19 ruling P6), and a refusal must not delete them.
    [...history.flatMap((h) => [h.blob, h.image]), ...elsewhere],
  );
```

Task 12's `names the blobs an upload or a transfer still holds` test covers `blobRefsElsewhere`; the release path is
exercised end to end by Task 18's refused-ADF e2e.

- [ ] **Step 5: Run the tests.**

```bash
pnpm vitest run src/app/api/cron/transfers/route.test.ts src/lib/blob-gc-run.test.ts src/lib/blob-gc.test.ts
pnpm vitest run
pnpm exec tsc --noEmit
```

Expected: all pass (the whole unit suite too); tsc prints nothing.

- [ ] **Step 6: Commit.**

```bash
git add src/app/api/cron/transfers/route.ts src/app/api/cron/transfers/route.test.ts src/lib/blob-gc-run.ts \
        src/lib/blob-gc-run.test.ts src/lib/admin-delete.ts src/lib/ingest-complete.ts
git commit -m "uploads: housekeeping in the daily cron, the GC keeps live uploads, org deletion, refused bytes never released

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 15: Increment 2 checkpoint: review, migration 0047 on production (the operator), merge, the TEST firmware

**Files:**
- Create (untracked, main checkout root, beside `.fw-target.mts`): `.up-cols.mts`

**Interfaces:**
- Consumes: Tasks 1-14.
- Produces: master with Receive 2 (not yet on the driver disk), the server's device routes live (inert until a 1.19.0
  board), migration 0047 on production, a TEST firmware row `1.19.0+g<sha>` (notes `TEST build -- ...`) installed on
  the bench board `28:cd:c1:19:6a:38`.

- [ ] **Step 1: Review increments 1 and 2.** Use superpowers:requesting-code-review on `master...feat/amiga-upload`,
with this plan's Global Constraints, Rulings and Review Focus as the brief. Fix every Critical and Important finding
with a test first, then review the fixes themselves (they have been worse than the findings here before). Record every
finding, ruling and deviation for the operator and for HANDOFF (Task 20).

- [ ] **Step 2: Every automated check.**

```bash
tools/receive/test/run.sh
pnpm vitest run
pnpm exec tsc --noEmit
TEST_DATABASE_URL=<the db:dev URL> pnpm test:db
wifi-floppy/firmware/test/run.sh
tools/receive/build.sh /tmp/Receive
pnpm firmware:build && arm-none-eabi-size -A wifi-floppy/firmware/build/wifi_floppy.elf | awk '$1==".bss"{print $2}'
pnpm build
pnpm lint 2>&1 | tail -3
```

Expected: no failures; `PASS pinned`; `.bss` ≤ 432,532; the Next build succeeds; lint reports no error beyond master's
known 7 (HANDOFF 3bv) -- if unsure, compare with the count `pnpm lint` gives on master in the main checkout.

- [ ] **Step 3: Ask the operator to apply migration 0047 on production.** It is additive: two new tables
(`amiga_uploads`, `amiga_upload_chunks`) and one nullable column (`devices.up_key`); no existing row changes. Show
them `drizzle/0047_amiga_uploads.sql` and end the turn. They run it (`pnpm db:migrate` from the main checkout, or their
own way). Never run it from here.

- [ ] **Step 4: Check it landed (read-only).** In `/Users/sfs/Devel/webadf` create `.up-cols.mts`:

```ts
// Read-only: the migration 0047 objects exist on the database .env.local names (plan 2026-10-19 Task 15).
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
const r = await getDb().execute(sql`select table_name, column_name from information_schema.columns
  where (table_name in ('amiga_uploads', 'amiga_upload_chunks')) or (table_name = 'devices' and column_name = 'up_key')
  order by table_name, column_name`);
console.log(JSON.stringify(r.rows.map((x) => `${x.table_name}.${x.column_name}`)));
process.exit(r.rows.some((x) => x.column_name === 'up_key') && r.rows.some((x) => x.table_name === 'amiga_upload_chunks') ? 0 : 1);
```

Run: `pnpm exec dotenv -e .env.local -- tsx .up-cols.mts`
Expected: a list including `amiga_uploads.blob_sha256`, `amiga_upload_chunks.data` and `devices.up_key`; exit 0.

- [ ] **Step 5: e2e for the touched areas** (PORT 3100, one at a time, each under 9 minutes; a failure is first checked
against a clean environment -- no orphaned dev server on 3100 -- before it is called a regression):

```bash
PORT=3100 pnpm exec playwright test e2e/send-to-amiga.spec.ts
PORT=3100 pnpm exec playwright test e2e/device-send.spec.ts e2e/device-status.spec.ts
PORT=3100 pnpm exec playwright test e2e/ingest-ui.spec.ts e2e/url-upload.spec.ts
PORT=3100 pnpm exec playwright test e2e/admin-delete.spec.ts
```

Expected: all pass.

- [ ] **Step 6: Merge and push** (master is production; the new device routes do nothing until a 1.19.0 board calls
them, and Receive 2 reaches users only with the driver disk in Task 19). From `/Users/sfs/Devel/webadf`:

```bash
git status --short                     # only the known untracked files
git checkout master && git pull --ff-only
git merge --no-ff feat/amiga-upload -m "Merge feat/amiga-upload (increments 0-2): Receive 2, the upload engine in fw 1.19.0 TEST, the server side (migration 0047)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
git push origin master
```

The worktree keeps `feat/amiga-upload` for increment 3; the main checkout stays on master.

Expected: the push succeeds; `gh run list --limit 6` shows the `receive`, `firmware` and image workflows green.

- [ ] **Step 7: Build, publish and read back the TEST firmware** (from the worktree, with its `.env.local`):

```bash
pnpm firmware:build
pnpm firmware:publish --no-github --notes "TEST build -- uploads from the Amiga (spec 2026-10-18; plan 2026-10-19), bench only"
```

Then from `/Users/sfs/Devel/webadf`: `pnpm exec dotenv -e .env.local -- tsx .fw-notes.mts`
Expected: `{"seq":<n>,"version":"1.19.0+g<sha>","notes":"TEST build -- uploads from the Amiga ..."}`, exit 0. Exit 1:
fix the notes in the DB at once (every org would be offered it) and say so.

- [ ] **Step 8: Install it on the bench board.** Start the serial log (Task 1 Step 12's reader, a new file
`<scratchpad>/serial-upload.log`). The install ejects the disk: if the Amiga is in use, ask the operator to switch it
off and end the turn; if idle, Ctrl+Alt+Del it through the PiKVM (memory: PaulaNET holds the OTA otherwise). Then:
`pnpm exec dotenv -e .env.local -- tsx .fw-target.mts 1.19.0+g<sha>`
Expected: within ~90 s the log shows the version confirmed, `up: board key <4 hex> (new, not stored yet)` and later
`up: board key stored`; `grep -c 'records dropped' <log>` prints 0 before any absence is believed; the card shows the
board on 1.19.0. Hand Bench B1 (prepared after Task 19's driver disk, or with the disk built at Task 6 copied over by
hand -- ask the operator which) to the operator only after Task 19, unless they ask sooner.

---

## Increment 3: the web

### Task 16: The person's routes for the From the Amiga area

**Files:**
- Create: `src/app/api/uploads/route.ts`, `src/app/api/uploads/clear/route.ts`, `src/app/api/uploads/[id]/route.ts`,
  `src/app/api/uploads/[id]/file/route.ts`, `src/app/api/uploads/[id]/library/route.ts`, `src/app/api/uploads/[id]/send/route.ts`,
  `src/app/api/uploads/routes.test.ts`

**Interfaces:**
- Consumes: Task 12 (`listUploads`, `uploadBoards`, `getUpload`, `deleteUpload`, `clearUploads`, `setLibraryDisk`);
  `requireOrg` (`src/lib/session.ts`); `diskStore` (`src/lib/storage`); `prepareImages` (`src/lib/url-ingest.ts`);
  `contentHashes` (`src/lib/content-hashes.ts`); `registerUploads` (`src/lib/ingest-complete.ts`); `disks`
  (`src/db/schema/catalog.ts`); `findSendTarget` (`src/lib/send-targets.ts`); `queueTransferFromBlob` (`src/lib/transfers.ts`);
  `queueResponse` (`src/lib/send-http.ts`); `libraryEligible` (Task 17's `src/lib/from-amiga-ui.ts` -- this task
  creates that file with just this function; Task 17 adds the rest).
- Produces: `GET /api/uploads?board=` → `{ rows: UploadView[], boards: UploadBoard[], now }`;
  `GET /api/uploads/<id>/file` → the bytes (attachment, nosniff, octet-stream); `POST /api/uploads/<id>/library` →
  `{ diskId, gameId }` | 404 `{error:'not_found'}` | 422 `{error:'not_a_disk_image'|'refused', reason?}`;
  `POST /api/uploads/<id>/send` with `{deviceId}` → `queueResponse`; `DELETE /api/uploads/<id>` → 204 | 404;
  `POST /api/uploads/clear` with `{before}` (ms) → `{ deleted }`; `export function libraryEligible(path: string, size: number): boolean`.

- [ ] **Step 1: Write the failing tests.** Create `src/lib/from-amiga-ui.ts` with only:

```ts
// Every word and rule the From the Amiga card and the device card use (spec 2026-10-18 §4, U6). Pure, client-safe.
import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { UPLOAD_FILE_MAX } from '@/lib/amiga-upload-limits';

/** The library's extensions (= archive/disk-image.ts's DISK_IMAGE_PATTERN, which the client must not import). */
export const LIBRARY_EXT = /\.(adf|dsk|adz|dms|dmz|hfe)$/i;

/** Add to library is offered for the library's disk images only, at the sizes the library takes (spec §4). */
export function libraryEligible(path: string, size: number): boolean {
  const m = LIBRARY_EXT.exec(path.split('/').pop() ?? '');
  if (!m || size <= 0) return false;
  const ext = m[1].toLowerCase();
  return ext === 'adz' || ext === 'dms' || ext === 'dmz' ? size <= UPLOAD_FILE_MAX : size <= MAX_DISK_BYTES;
}
```

Create `src/app/api/uploads/routes.test.ts`:

```ts
// The person's routes for the From the Amiga area (spec 2026-10-18 §4). The library is mocked; its db tests are Task 12's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
const diskRow = { id: 'disk-9', gameId: 'game-9' };
vi.mock('@/db', () => ({ getDb: () => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [diskRow] }) }) }),
}) }));
const store = new Map<string, Uint8Array>();
vi.mock('@/lib/storage', () => ({ diskStore: {
  stat: async (s: string) => (store.has(s) ? { sizeBytes: store.get(s)!.byteLength } : null),
  put: async (s: string, b: Uint8Array) => { store.set(s, b); return { key: `adf/${s}` }; },
  read: async (s: string) => { const b = store.get(s); if (!b) throw new Error('missing'); return b; },
} }));
const U = { listUploads: vi.fn(), uploadBoards: vi.fn(), getUpload: vi.fn(), deleteUpload: vi.fn(), clearUploads: vi.fn(), setLibraryDisk: vi.fn() };
vi.mock('@/lib/amiga-uploads', () => ({
  listUploads: (...a: unknown[]) => U.listUploads(...a), uploadBoards: (...a: unknown[]) => U.uploadBoards(...a),
  getUpload: (...a: unknown[]) => U.getUpload(...a), deleteUpload: (...a: unknown[]) => U.deleteUpload(...a),
  clearUploads: (...a: unknown[]) => U.clearUploads(...a), setLibraryDisk: (...a: unknown[]) => U.setLibraryDisk(...a),
}));
const registerUploads = vi.fn();
vi.mock('@/lib/ingest-complete', () => ({ registerUploads: (...a: unknown[]) => registerUploads(...a) }));
const findSendTarget = vi.fn();
vi.mock('@/lib/send-targets', () => ({ findSendTarget: (...a: unknown[]) => findSendTarget(...a) }));
const queueTransferFromBlob = vi.fn();
vi.mock('@/lib/transfers', () => ({ queueTransferFromBlob: (...a: unknown[]) => queueTransferFromBlob(...a) }));

const { GET: listGET } = await import('./route');
const { POST: clearPOST } = await import('./clear/route');
const { DELETE: oneDELETE } = await import('./[id]/route');
const { GET: fileGET } = await import('./[id]/file/route');
const { POST: libraryPOST } = await import('./[id]/library/route');
const { POST: sendPOST } = await import('./[id]/send/route');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ADF = new Uint8Array(901_120).fill(0x44);
const stored = (over: Record<string, unknown> = {}) => ({
  id: 'up-1', orgId: 'org-1', deviceId: 'dev-1', deviceName: 'Bench', path: 'Games/Lemmings.adf', sizeBytes: ADF.byteLength,
  status: 'stored', blobSha256: sha(ADF), protection: 0x40, comment: 'note', libraryDiskId: null, ...over,
});

beforeEach(() => { vi.clearAllMocks(); store.clear(); store.set(sha(ADF), ADF); });

describe('GET /api/uploads', () => {
  it("lists the session org's area, filtered by ?board=, with the boards and the server's time", async () => {
    U.listUploads.mockResolvedValue([{ id: 'up-1' }]);
    U.uploadBoards.mockResolvedValue([{ id: 'dev-1', name: 'Bench', key: 'AB12', canUpload: true }]);
    const r = await listGET(new Request('http://x/api/uploads?board=dev-1'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await r.json();
    expect(b.rows).toEqual([{ id: 'up-1' }]); expect(b.boards[0].key).toBe('AB12'); expect(typeof b.now).toBe('number');
    expect(U.listUploads).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-1', expect.any(Date));
  });
});

describe('GET /api/uploads/<id>/file', () => {
  it('streams a stored file as an attachment that is never rendered', async () => {
    U.getUpload.mockResolvedValue(stored({ path: 'Web/évil page.html', sizeBytes: 3, blobSha256: sha(new Uint8Array([60, 104, 62])) }));
    store.set(sha(new Uint8Array([60, 104, 62])), new Uint8Array([60, 104, 62]));
    const r = await fileGET(new Request('http://x/api/uploads/up-1/file'), ctx('up-1'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''%C3%A9vil%20page.html");
    expect(r.headers.get('content-length')).toBe('3');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([60, 104, 62]));
    expect(U.getUpload).toHaveBeenCalledWith(expect.anything(), 'org-1', 'up-1');
  });
  it('is 404 for another org, a deleted, failed or receiving row', async () => {
    for (const row of [null, stored({ status: 'receiving', blobSha256: null }), stored({ status: 'failed', blobSha256: null })]) {
      U.getUpload.mockResolvedValueOnce(row);
      expect((await fileGET(new Request('http://x/api/uploads/up-1/file'), ctx('up-1'))).status).toBe(404);
    }
  });
});

describe('POST /api/uploads/<id>/library', () => {
  it('normalises the image, stores it under its own sha, registers it as an upload would, and records the disk', async () => {
    U.getUpload.mockResolvedValue(stored());
    registerUploads.mockResolvedValue(Response.json({ created: 1, disks: 1, rejected: 0, rejectedReasons: {} }));
    const r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ diskId: 'disk-9', gameId: 'game-9' });
    expect(registerUploads).toHaveBeenCalledWith('org-1', [{ sha256: sha(ADF), sizeBytes: 901_120, filename: 'Lemmings.adf' }]);
    expect(U.setLibraryDisk).toHaveBeenCalledWith(expect.anything(), 'org-1', 'up-1', 'disk-9');
  });
  it('answers the disk already added without registering again', async () => {
    U.getUpload.mockResolvedValue(stored({ libraryDiskId: 'disk-9' }));
    const r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(await r.json()).toEqual({ diskId: 'disk-9', gameId: 'game-9' });
    expect(registerUploads).not.toHaveBeenCalled();
  });
  it('refuses what is not a library disk image, and says why a refused one was refused', async () => {
    U.getUpload.mockResolvedValueOnce(stored({ path: 'Archive.lha' }));
    let r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(r.status).toBe(422); expect((await r.json()).error).toBe('not_a_disk_image');
    U.getUpload.mockResolvedValueOnce(stored());
    registerUploads.mockResolvedValueOnce(Response.json({ created: 0, rejected: 1, rejectedReasons: { [sha(ADF)]: 'not a disk' } }, { status: 409 }));
    r = await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'));
    expect(r.status).toBe(422); expect(await r.json()).toEqual({ error: 'refused', reason: 'not a disk' });
    U.getUpload.mockResolvedValueOnce(null);
    expect((await libraryPOST(new Request('http://x', { method: 'POST' }), ctx('up-1'))).status).toBe(404);
  });
});

describe('POST /api/uploads/<id>/send', () => {
  it("queues the stored bytes to one of the org's boards with the Amiga's name, protection and comment", async () => {
    U.getUpload.mockResolvedValue(stored());
    findSendTarget.mockResolvedValue({ id: 'dev-2' });
    queueTransferFromBlob.mockResolvedValue({ ok: true, id: 't1' });
    const r = await sendPOST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-2' }) }), ctx('up-1'));
    expect(r.status).toBe(201);
    expect(queueTransferFromBlob).toHaveBeenCalledWith(expect.anything(), { orgId: 'org-1', deviceId: 'dev-2', userId: 'user-1',
      path: 'Games/Lemmings.adf', sha256: sha(ADF), protection: 0x40, comment: 'note' });
  });
  it('is 404 for a board that cannot take files', async () => {
    U.getUpload.mockResolvedValue(stored());
    findSendTarget.mockResolvedValue(null);
    const r = await sendPOST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-x' }) }), ctx('up-1'));
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/uploads/<id> and POST /api/uploads/clear', () => {
  it('deletes one file of the org, 404 otherwise', async () => {
    U.deleteUpload.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await oneDELETE(new Request('http://x', { method: 'DELETE' }), ctx('up-1'))).status).toBe(204);
    expect((await oneDELETE(new Request('http://x', { method: 'DELETE' }), ctx('up-1'))).status).toBe(404);
    expect(U.deleteUpload).toHaveBeenCalledWith(expect.anything(), 'org-1', 'up-1');
  });
  it('clear passes the newest time the person saw and answers the count', async () => {
    U.clearUploads.mockResolvedValue(4);
    const r = await clearPOST(new Request('http://x', { method: 'POST', body: JSON.stringify({ before: 1_760_000_000_000 }) }));
    expect(await r.json()).toEqual({ deleted: 4 });
    expect(U.clearUploads).toHaveBeenCalledWith(expect.anything(), 'org-1', new Date(1_760_000_000_000));
    expect((await clearPOST(new Request('http://x', { method: 'POST', body: '{}' }))).status).toBe(400);
  });
});
```

Run: `pnpm vitest run src/app/api/uploads/routes.test.ts`
Expected: FAIL (the routes do not exist).

- [ ] **Step 2: The routes.** Create `src/app/api/uploads/route.ts`:

```ts
// The From the Amiga area (spec 2026-10-18 §4, U6): every board's uploads for the session's org, newest first, with
// the org's boards for the filter and their key digits (spec §6).
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listUploads, uploadBoards } from '@/lib/amiga-uploads';

export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const board = new URL(request.url).searchParams.get('board');
  const db = getDb();
  const now = new Date();
  const [rows, boards] = await Promise.all([listUploads(db, orgId, board || null, now), uploadBoards(db, orgId)]);
  return Response.json({ rows, boards, now: now.getTime() }, { headers: { 'cache-control': 'no-store' } });
}
```

Create `src/app/api/uploads/clear/route.ts`:

```ts
// Clear all (spec 2026-10-18 §4): every stored or failed file of the org up to `before`, the newest created_at the
// person saw -- a file that arrives while the confirm is open is not cleared unseen. A file still arriving stays.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { clearUploads } from '@/lib/amiga-uploads';

const body = z.object({ before: z.number().int().positive() });

export async function POST(request: Request) {
  const { orgId } = await requireOrg();
  const p = body.safeParse(await request.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const deleted = await clearUploads(getDb(), orgId, new Date(p.data.before));
  return Response.json({ deleted }, { headers: { 'cache-control': 'no-store' } });
}
```

Create `src/app/api/uploads/[id]/route.ts`:

```ts
// Delete one file from the From the Amiga area (spec 2026-10-18 §4). Only the session org's rows.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { deleteUpload } from '@/lib/amiga-uploads';

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  return new Response(null, { status: (await deleteUpload(getDb(), orgId, id)) ? 204 : 404 });
}
```

Create `src/app/api/uploads/[id]/file/route.ts`:

```ts
// Download a file from the Amiga (spec 2026-10-18 §4, §6): always an attachment, never rendered -- an uploaded .html
// must not become stored XSS -- under the name the Amiga gave it.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { getUpload } from '@/lib/amiga-uploads';
import { diskStore } from '@/lib/storage';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const row = await getUpload(getDb(), orgId, id);
  if (!row || row.status !== 'stored' || !row.blobSha256) return new Response('not found', { status: 404 });
  const bytes = new Uint8Array(await diskStore.read(row.blobSha256));
  const base = row.path.split('/').pop() || 'file';
  return new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
    },
  });
}
```

Create `src/app/api/uploads/[id]/library/route.ts`:

```ts
// Add to library (spec 2026-10-18 §4, U6): never automatic. The bytes go through URL ingest's normaliser (ADZ, DMS
// and DMZ become an ADF; an HFE stays as it is) and then registerUploads -- the one code path a browser upload and a
// URL fetch take, so dedupe, the TOSEC sweep and history behave the same (plan ruling P6).
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { getUpload, setLibraryDisk } from '@/lib/amiga-uploads';
import { libraryEligible } from '@/lib/from-amiga-ui';
import { diskStore } from '@/lib/storage';
import { prepareImages } from '@/lib/url-ingest';
import { contentHashes } from '@/lib/content-hashes';
import { registerUploads } from '@/lib/ingest-complete';

export const maxDuration = 60;

async function diskFor(orgId: string, where: ReturnType<typeof eq>) {
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks).where(and(eq(disks.orgId, orgId), where)).limit(1);
  return d ?? null;
}

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const db = getDb();
  const row = await getUpload(db, orgId, id);
  if (!row || row.status !== 'stored' || !row.blobSha256) return Response.json({ error: 'not_found' }, { status: 404 });
  if (row.libraryDiskId) {
    const d = await diskFor(orgId, eq(disks.id, row.libraryDiskId));
    if (d) return Response.json({ diskId: d.id, gameId: d.gameId });
  }
  if (!libraryEligible(row.path, row.sizeBytes)) return Response.json({ error: 'not_a_disk_image' }, { status: 422 });
  const prepared = await prepareImages(await diskStore.read(row.blobSha256), row.path.split('/').pop() || 'disk.adf');
  if ('code' in prepared || prepared.images.length === 0) {
    const reason = 'code' in prepared ? undefined : prepared.refused[0]?.note;
    return Response.json({ error: 'not_a_disk_image', ...(reason ? { reason } : {}) }, { status: 422 });
  }
  const img = prepared.images[0];
  const sha256 = contentHashes(img.bytes).sha256;
  if (!(await diskStore.stat(sha256))) await diskStore.put(sha256, img.bytes);
  const res = await registerUploads(orgId, [{ sha256, sizeBytes: img.bytes.byteLength, filename: img.filename }]);
  if (res.status !== 200 && res.status !== 409) return Response.json({ error: 'ingest_failed' }, { status: 502 });
  const body = (await res.json()) as { rejectedReasons?: Record<string, string> };
  const refused = body.rejectedReasons?.[sha256];
  if (refused) return Response.json({ error: 'refused', reason: refused }, { status: 422 });
  const d = await diskFor(orgId, eq(disks.sha256, sha256));
  if (!d) return Response.json({ error: 'ingest_failed' }, { status: 502 });
  await setLibraryDisk(db, orgId, id, d.id);
  return Response.json({ diskId: d.id, gameId: d.gameId });
}
```

(The route test's mocked `getDb().select().from().where().limit()` answers `[{ id: 'disk-9', gameId: 'game-9' }]`;
`prepareImages` runs for real on the 901,120-byte test ADF: a DD ADF passes through `toAdf` unchanged.)

Create `src/app/api/uploads/[id]/send/route.ts`:

```ts
// Send a file from the Amiga on to an Amiga (spec 2026-10-18 §4): the same queue as Send to Amiga, the same bytes.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { getUpload } from '@/lib/amiga-uploads';
import { findSendTarget } from '@/lib/send-targets';
import { queueTransferFromBlob } from '@/lib/transfers';
import { queueResponse } from '@/lib/send-http';

const body = z.object({ deviceId: z.string().min(1).max(100) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId, userId } = await requireOrg();
  const { id } = await ctx.params;
  const p = body.safeParse(await request.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const db = getDb();
  const row = await getUpload(db, orgId, id);
  if (!row || row.status !== 'stored' || !row.blobSha256) return Response.json({ error: 'not_found' }, { status: 404 });
  if (!(await findSendTarget(db, orgId, p.data.deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });
  return queueResponse(await queueTransferFromBlob(db, { orgId, deviceId: p.data.deviceId, userId, path: row.path,
    sha256: row.blobSha256, protection: row.protection, comment: row.comment }));
}
```

- [ ] **Step 3: Run the tests.**

```bash
pnpm vitest run src/app/api/uploads/routes.test.ts
pnpm exec tsc --noEmit
```

Expected: all pass; tsc prints nothing.

- [ ] **Step 4: Commit.**

```bash
git add src/app/api/uploads src/lib/from-amiga-ui.ts
git commit -m "uploads: the area's routes -- list, download as an attachment, add to library, send on, delete, clear all

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 17: The From the Amiga card, the device card's line, and the help topic

**Files:**
- Modify: `src/lib/from-amiga-ui.ts` (Task 16 created it), create `src/lib/from-amiga-ui.test.ts`
- Create: `src/components/uploads/from-amiga-card.tsx`
- Modify: `src/app/(app)/ingest/page.tsx`, `src/app/(app)/devices/page.tsx`, `src/components/devices/device-list.tsx`,
  `src/components/devices/device-card.tsx`
- Modify: `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`

**Interfaces:**
- Consumes: Task 16's routes; Task 12's `UploadView`, `UploadBoard`, `uploadSummaries`; `SendTarget`, `formatSize`
  (`src/lib/send-ui.ts`); `UploadCard`, `ListFrame` (`src/components/ingest/upload-card.tsx`); `HelpTip`; `StatusChip`; `Link`.
- Produces: `src/lib/from-amiga-ui.ts`: `LIBRARY_EXT`, `libraryEligible`, `uploadChip(r: UploadView): { kind; label; note }`,
  `cardUploadLine(count: number | undefined, fw: string | null, network: boolean): { text: string; href: boolean } | null`,
  `clearConfirm(n: number): string`, `clearable(rows): number`, `newestSeen(rows): number`, `anyArriving(rows): boolean`,
  `uploadErrorText(code: string | undefined, status: number): string`; `<FromAmigaCard targets initialBoard />` (section
  `#from-amiga`, test ids `from-amiga`, `from-amiga-board`, `from-amiga-key`, `from-amiga-list`, `from-amiga-row-<id>`,
  `from-amiga-state-<id>`, `from-amiga-download-<id>`, `from-amiga-library-<id>`, `from-amiga-in-library-<id>`,
  `from-amiga-send-<id>`, `from-amiga-delete-<id>`, `from-amiga-clear`, `from-amiga-confirm`, `from-amiga-confirm-yes`,
  `from-amiga-empty`); the device card's `device-upload-<id>` line; help topic `from-amiga`.

- [ ] **Step 1: Write the failing tests.** Create `src/lib/from-amiga-ui.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DISK_IMAGE_PATTERN } from '@/lib/archive/disk-image';
import type { UploadView } from '@/lib/amiga-uploads';
import {
  LIBRARY_EXT, anyArriving, cardUploadLine, clearConfirm, clearable, libraryEligible, newestSeen, uploadChip, uploadErrorText,
} from './from-amiga-ui';

const row = (over: Partial<UploadView> = {}): UploadView => ({
  id: 'u', path: 'Lemmings.adf', sizeBytes: 901_120, status: 'stored', receivedBytes: 901_120, errorCode: null, deviceId: 'd',
  deviceName: 'Bench', createdAt: 1000, storedAt: 2000, expiresAt: 3000, libraryDiskId: null, libraryGameId: null, ...over,
});

describe('from the Amiga: the rules the card shows', () => {
  it("offers Add to library for the library's extensions and sizes only", () => {
    expect(LIBRARY_EXT.source).toBe(DISK_IMAGE_PATTERN.source);
    expect(libraryEligible('Games/Lemmings.ADF', 901_120)).toBe(true);
    expect(libraryEligible('x.hfe', 2_000_000)).toBe(true);
    expect(libraryEligible('x.adf', 2_621_441)).toBe(false);        // over MAX_DISK_BYTES
    expect(libraryEligible('x.dms', 4_000_000)).toBe(true);         // compressed: up to the file cap
    expect(libraryEligible('x.lha', 1000)).toBe(false);
    expect(libraryEligible('adf', 1000)).toBe(false);
    expect(libraryEligible('x.adf', 0)).toBe(false);
  });
  it('says how each row stands', () => {
    expect(uploadChip(row({ status: 'receiving', receivedBytes: 450_560 }))).toEqual({ kind: 'blue', label: 'Arriving 50 %', note: null });
    expect(uploadChip(row())).toEqual({ kind: 'green', label: 'Stored', note: null });
    expect(uploadChip(row({ status: 'failed', errorCode: 'crc' })).note).toMatch(/damaged on the way/);
    expect(uploadChip(row({ status: 'failed', errorCode: 'expired' })).note).toMatch(/24 hours/);
    expect(uploadChip(row({ status: 'receiving', sizeBytes: 0, receivedBytes: 0 })).label).toBe('Arriving 0 %');
  });
  it("the device card's line: files from the Amiga, or the update a Network board needs", () => {
    expect(cardUploadLine(2, '1.19.0+gabc', true)).toEqual({ text: '2 files from the Amiga', href: true });
    expect(cardUploadLine(1, '1.19.0', false)).toEqual({ text: '1 file from the Amiga', href: true });
    expect(cardUploadLine(undefined, '1.18.2', true)).toEqual({ text: 'Update to 1.19.0 to send files from the Amiga', href: false });
    expect(cardUploadLine(undefined, '1.18.2', false)).toBeNull();
    expect(cardUploadLine(0, '1.19.0', true)).toBeNull();
  });
  it('Clear all: the count it names, and the newest row the person saw', () => {
    const rows = [row({ id: 'a', createdAt: 5 }), row({ id: 'b', status: 'receiving', createdAt: 9 }), row({ id: 'c', status: 'failed', createdAt: 7 })];
    expect(clearable(rows)).toBe(2);
    expect(newestSeen(rows)).toBe(9);
    expect(anyArriving(rows)).toBe(true);
    expect(clearConfirm(1)).toBe('Clear 1 file from the Amiga?');
    expect(clearConfirm(3)).toBe('Clear 3 files from the Amiga?');
  });
  it('words for refusals', () => {
    expect(uploadErrorText('not_a_disk_image', 422)).toMatch(/not a disk image/i);
    expect(uploadErrorText('queue_full', 409)).toMatch(/queue/);
    expect(uploadErrorText(undefined, 500)).toBe('The server answered 500.');
  });
});
```

In `src/lib/help/topics.test.ts`: add `'from-amiga'` to `IDS`, and in `describe('help topics say what the app really does'`:

```ts
  it('from-amiga names the firmware, the three ways to send, the key digits and the limits (spec 2026-10-18)', () => {
    const b = HELP_TOPICS['from-amiga'].short + bodyText('from-amiga');
    for (const w of ['1.19.0', 'Install', 'Send…', 'Receive SEND', 'Trusted board AB12', 'Trust this board', 'TRUST',
      '4 MB', '500 files', '256 MB', '30 days', '24 hours', 'Clear all', 'Add to library']) expect(b).toContain(w);
  });
```

Run: `pnpm vitest run src/lib/from-amiga-ui.test.ts src/lib/help/topics.test.ts`
Expected: FAIL (the functions and the topic do not exist).

- [ ] **Step 2: The words.** Append to `src/lib/from-amiga-ui.ts`:

```ts
import type { UploadView } from '@/lib/amiga-uploads';
import { UPLOAD_FW } from '@/lib/amiga-upload-limits';
import { firmwareAtLeast } from '@/lib/firmware-version';

export type UploadChip = { kind: 'amber' | 'blue' | 'green' | 'red' | 'neutral'; label: string; note: string | null };
const FAILED: Record<string, string> = {
  crc: 'damaged on the way: send it again',
  expired: 'not finished within 24 hours: send it again',
};
export function uploadChip(r: UploadView): UploadChip {
  if (r.status === 'receiving') {
    const pct = r.sizeBytes ? Math.min(99, Math.floor((r.receivedBytes * 100) / r.sizeBytes)) : 0;
    return { kind: 'blue', label: `Arriving ${pct} %`, note: null };
  }
  if (r.status === 'failed') return { kind: 'red', label: 'Failed', note: FAILED[r.errorCode ?? ''] ?? 'it did not arrive whole' };
  return { kind: 'green', label: 'Stored', note: null };
}
/** The device card (spec §4, §8): files stored within 24 h, or, on a Network board too old to send, the update. */
export function cardUploadLine(count: number | undefined, fw: string | null, network: boolean): { text: string; href: boolean } | null {
  if (count && count > 0) return { text: `${count} ${count === 1 ? 'file' : 'files'} from the Amiga`, href: true };
  if (network && !firmwareAtLeast(fw, UPLOAD_FW)) return { text: `Update to ${UPLOAD_FW} to send files from the Amiga`, href: false };
  return null;
}
export const clearConfirm = (n: number) => (n === 1 ? 'Clear 1 file from the Amiga?' : `Clear ${n} files from the Amiga?`);
export const clearable = (rows: UploadView[]) => rows.filter((r) => r.status !== 'receiving').length;
export const newestSeen = (rows: UploadView[]) => rows.reduce((m, r) => Math.max(m, r.createdAt), 0);
export const anyArriving = (rows: UploadView[]) => rows.some((r) => r.status === 'receiving');
export function uploadErrorText(code: string | undefined, status: number): string {
  switch (code) {
    case 'not_a_disk_image': return 'Not a disk image the library takes.';
    case 'ingest_failed': return 'The library could not take it just now. Try again.';
    case 'not_found': return 'That file is no longer here.';
    case 'no_device': return 'That board cannot receive files.';
    case 'queue_full': return 'The queue for that board is full (32 files or 16 MB). Wait for some to arrive.';
    case 'too_large': return 'Over 4 MB: too large to send.';
    case 'bad_name': return 'That name cannot be used on the Amiga.';
    default: return `The server answered ${status}.`;
  }
}
```

(Move the three new imports to the top of the file, beside the existing two.)

- [ ] **Step 3: The card.** Create `src/components/uploads/from-amiga-card.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { HelpTip } from '@/components/help/help-tip';
import { StatusChip } from '@/components/ui/status-chip';
import { ListFrame, UploadCard } from '@/components/ingest/upload-card';
import { formatSize, type SendTarget } from '@/lib/send-ui';
import type { UploadBoard, UploadView } from '@/lib/amiga-uploads';
import {
  anyArriving, clearConfirm, clearable, libraryEligible, newestSeen, uploadChip, uploadErrorText,
} from '@/lib/from-amiga-ui';

type Snapshot = { rows: UploadView[]; boards: UploadBoard[]; now: number };
// While a file arrives the list is read every 3 s (progress moves per 16 KB chunk); otherwise every 10 s.
const ACTIVE_MS = 3_000;
const IDLE_MS = 10_000;
const btn = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50';
const quiet = { background: 'var(--glass-strong)', color: 'var(--ink)', border: '1px solid var(--hairline-strong)' } as const;

/**
 * The From the Amiga area (spec 2026-10-18 §4, U6; ruling 8: a full-width card on the Upload page): what every board
 * of the org sent up, newest first, the board on each row, and Download, Add to library, Send to an Amiga, Delete and
 * Clear all. Reads its own route, like the Send to Amiga card.
 */
export function FromAmigaCard({ targets, initialBoard }: { targets: SendTarget[]; initialBoard: string | null }) {
  const [board, setBoard] = useState<string | null>(initialBoard);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [confirming, setConfirming] = useState<{ n: number; before: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // a row's id, or 'clear', while its request runs
  const active = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const q = board ? `?board=${encodeURIComponent(board)}` : '';
      const res = await fetch(`/api/uploads${q}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (res.ok) setSnap((await res.json()) as Snapshot);
    } catch { /* offline, signed out or a deploy: the next tick tries again */ }
  }, [board]);

  useEffect(() => { active.current = snap ? anyArriving(snap.rows) : false; }, [snap]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') await refresh();
      if (!stopped) timer = setTimeout(tick, active.current ? ACTIVE_MS : IDLE_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [refresh]);

  async function run(id: string, what: string, request: () => Promise<Response>, done: (res: Response) => Promise<void>) {
    setBusy(id);
    try {
      const res = await request();
      if (res.ok) await done(res);
      else {
        const b = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
        toast.error(what, { description: b?.reason ?? uploadErrorText(b?.error, res.status) });
      }
      await refresh();
    } catch {
      toast.error(what, { description: 'Check the connection and try again.' });
    } finally {
      setBusy(null);
    }
  }
  const addToLibrary = (r: UploadView) => run(r.id, 'Not added to the library',
    () => fetch(`/api/uploads/${encodeURIComponent(r.id)}/library`, { method: 'POST' }),
    async () => { toast.success('Added to the library', { description: r.path }); });
  const sendTo = (r: UploadView, t: SendTarget) => run(r.id, 'Not sent',
    () => fetch(`/api/uploads/${encodeURIComponent(r.id)}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: t.id }) }),
    async () => { toast.success(`Queued for ${t.name}`, { description: 'It shows under Send to Amiga.' }); });
  const remove = (r: UploadView) => run(r.id, 'Not deleted',
    () => fetch(`/api/uploads/${encodeURIComponent(r.id)}`, { method: 'DELETE' }), async () => undefined);
  const clearAll = (before: number) => run('clear', 'Not cleared',
    () => fetch('/api/uploads/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ before }) }),
    async (res) => {
      const { deleted } = (await res.json()) as { deleted: number };
      toast.success(deleted === 1 ? '1 file cleared' : `${deleted} files cleared`);
      setConfirming(null);
    });

  const rows = snap?.rows ?? [];
  const boards = snap?.boards ?? [];
  const n = clearable(rows);
  const shown = board ? boards.find((b) => b.id === board) : boards.length === 1 ? boards[0] : undefined;
  const meta = (
    <>
      {boards.length > 1 && (
        <select aria-label="Board" data-testid="from-amiga-board" value={board ?? ''} onChange={(e) => setBoard(e.target.value || null)}
                className="rounded-lg px-2 py-1 text-[12px]" style={quiet}>
          <option value="">All boards</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}{b.key ? ` (key ${b.key})` : ''}</option>)}
        </select>
      )}
      {shown?.key && (
        <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid="from-amiga-key">
          {shown.name}: board key <strong style={{ color: 'var(--ink)' }}>{shown.key}</strong>
        </span>
      )}
    </>
  );

  return (
    <section id="from-amiga" aria-labelledby="from-amiga-heading" className="mx-4 pb-10 sm:mx-7">
      <UploadCard id="from-amiga-heading" title="From the Amiga" help={<HelpTip topic="from-amiga" />} meta={meta} testId="from-amiga">
        <ListFrame
          title="Files"
          counts={rows.length ? `${rows.length} ${rows.length === 1 ? 'file' : 'files'}` : undefined}
          action={n > 0 && (
            <button type="button" data-testid="from-amiga-clear" disabled={busy === 'clear'} className={btn} style={quiet}
                    onClick={() => setConfirming({ n, before: newestSeen(rows) })}>
              Clear all ({n})
            </button>
          )}
        >
          <ul aria-label="Files from the Amiga" data-testid="from-amiga-list" tabIndex={0}
              className="flex max-h-[30rem] min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset">
            {rows.map((r) => {
              const c = uploadChip(r);
              const stored = r.status === 'stored';
              return (
                <li key={r.id} data-testid={`from-amiga-row-${r.id}`} data-status={r.status}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5" style={{ borderBottom: '1px solid var(--hairline)' }}>
                  <span className="min-w-0 flex-1 font-mono text-[12px]" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{r.path}</span>
                  <span className="shrink-0 font-mono text-[11.5px]" style={{ color: 'var(--muted)' }}>{formatSize(r.sizeBytes)}</span>
                  <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--muted)' }}>from {r.deviceName}</span>
                  <span className="flex min-w-0 basis-full flex-wrap items-center gap-2">
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" data-testid={`from-amiga-state-${r.id}`}>
                      <StatusChip kind={c.kind}>{c.label}</StatusChip>
                      {c.note && <><span className="sr-only"> · </span><span style={{ color: 'var(--muted)' }}>{c.note}</span></>}
                    </span>
                    {stored && (
                      <a href={`/api/uploads/${encodeURIComponent(r.id)}/file`} download data-testid={`from-amiga-download-${r.id}`}
                         className={btn} style={quiet} aria-label={`Download ${r.path}`}>Download</a>
                    )}
                    {stored && r.libraryGameId && (
                      <Link href={`/games/${encodeURIComponent(r.libraryGameId)}`} data-testid={`from-amiga-in-library-${r.id}`}
                            className="text-[12px] font-semibold underline underline-offset-2" style={{ color: 'var(--ink)' }}>In library</Link>
                    )}
                    {stored && !r.libraryDiskId && libraryEligible(r.path, r.sizeBytes) && (
                      <button type="button" data-testid={`from-amiga-library-${r.id}`} disabled={busy === r.id} className={btn} style={quiet}
                              aria-label={`Add ${r.path} to the library`} onClick={() => void addToLibrary(r)}>Add to library</button>
                    )}
                    {stored && targets.length > 0 && (
                      <select aria-label={`Send ${r.path} to an Amiga`} data-testid={`from-amiga-send-${r.id}`} value="" disabled={busy === r.id}
                              className="rounded-lg px-2 py-1 text-[12px]" style={quiet}
                              onChange={(e) => { const t = targets.find((x) => x.id === e.target.value); if (t) void sendTo(r, t); }}>
                        <option value="">Send to an Amiga…</option>
                        {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    )}
                    {r.status !== 'receiving' && (
                      <button type="button" data-testid={`from-amiga-delete-${r.id}`} disabled={busy === r.id} className={btn} style={quiet}
                              aria-label={`Delete ${r.path}`} onClick={() => void remove(r)}>Delete</button>
                    )}
                  </span>
                </li>
              );
            })}
            {snap === null && <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>Reading the list…</li>}
            {snap !== null && rows.length === 0 && (
              <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }} data-testid="from-amiga-empty">
                Nothing from the Amiga yet. Drop files on Receive&apos;s window, or type Receive SEND in a Shell.
              </li>
            )}
          </ul>
        </ListFrame>
      </UploadCard>
      {confirming && createPortal((
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgb(11 18 28 / 0.55)' }}>
          <div role="dialog" aria-modal="true" aria-label="Clear all" data-testid="from-amiga-confirm" className="glass-card w-full max-w-[440px] p-6 text-left">
            <h2 className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>{clearConfirm(confirming.n)}</h2>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
              They go from this list for everyone in your organization. A file still arriving stays, and a disk you added to
              the library stays there.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" disabled={busy === 'clear'} onClick={() => setConfirming(null)}
                      className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50" style={{ color: 'var(--muted)' }}>Cancel</button>
              <button type="button" data-testid="from-amiga-confirm-yes" disabled={busy === 'clear'} onClick={() => void clearAll(confirming.before)}
                      className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--danger-fg)' }}>
                {busy === 'clear' ? 'Clearing…' : 'Clear all'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </section>
  );
}
```

In `src/app/(app)/ingest/page.tsx`: import `FromAmigaCard` from `@/components/uploads/from-amiga-card`; after the
`const board = ...` line add
`// ?from= comes from a device card's "N files from the Amiga" line (it filters the area to that board).`
`const from = typeof sp.from === 'string' ? sp.from : null;`; and after the grid `</div>` add
`<FromAmigaCard targets={targets} initialBoard={from} />` (still inside the fragment).

- [ ] **Step 4: The device card's line.** In `src/app/(app)/devices/page.tsx`: import `uploadSummaries` from
`@/lib/amiga-uploads` and `cardUploadLine` from `@/lib/from-amiga-ui`; after `sendLineById` add:

```ts
  // Uploads from the Amiga (spec 2026-10-18 §4, §8): files stored within 24 h, or the update a Network board needs.
  const uploads = await uploadSummaries(getDb(), orgId, new Date(now));
  const uploadLineById = Object.fromEntries(devices.map((d) => [d.id,
    cardUploadLine(uploads[d.id], d.firmwareVersion, d.secondDriveReported === 'net')]));
```

and pass `uploadLineById={uploadLineById}` to `DeviceList` beside `sendLineById`. In `device-list.tsx`: the props gain
`uploadLineById: Record<string, { text: string; href: boolean } | null>;` (destructured beside `sendLineById`), and
`<DeviceCard ... sendLine={sendLineById[d.id] ?? null}` gains `uploadLine={uploadLineById[d.id] ?? null}`. In
`device-card.tsx`: the props gain `uploadLine?: { text: string; href: boolean } | null;` (beside `sendLine`), and after
the `{sendLine && ( ... )}` block add:

```tsx
      {uploadLine && (uploadLine.href ? (
        <Link href={`/ingest?from=${encodeURIComponent(device.id)}#from-amiga`} data-testid={`device-upload-${device.id}`}
              className="w-fit text-[11px] font-semibold underline underline-offset-2" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
          {uploadLine.text}
        </Link>
      ) : (
        <span data-testid={`device-upload-${device.id}`} className="text-[11px]" style={{ color: 'var(--muted)' }}>{uploadLine.text}</span>
      ))}
```

(`devices` is the page's `listDevices(orgId)` result, the rows `DeviceList` renders; `device-card.tsx` already reads
their `firmwareVersion` and `secondDriveReported`.)

- [ ] **Step 5: The help topic.** In `src/lib/help/topics.tsx`, after the `send` topic:

```tsx
  // Sources: spec docs/superpowers/specs/2026-10-18-amiga-to-web-upload-design.md §1 (U2 the ways to send, U4 resume,
  // U5 limits, U6 the area, U7 trust), §2 (Receive), §4 (Add to library, Clear all, attachments), §6 (the key digits);
  // src/lib/amiga-upload-limits.ts (UPLOAD_FW, limits), src/lib/from-amiga-ui.ts (the words), tools/receive/amiga/gui.c.
  'from-amiga': {
    title: 'Files from the Amiga',
    short:
      'Send files from your Amiga to the web app with Receive. They land in From the Amiga on the Upload page, where you can download them, add disk images to your library or send them on.',
    body: (
      <>
        <p>
          Your board needs firmware 1.19.0 or newer, in <em>Network (PaulaNET)</em> mode. Run <em>Install</em> from the
          driver disk again to get the new <em>Receive</em>, and start it. Then drop files or drawers on its window, press{' '}
          <em>Send…</em>, or type <em>Receive SEND DH0:file</em> in a Shell.
        </p>
        <p>
          <strong>Your board, and only yours.</strong> The first time Receive meets your board it saves the board&apos;s
          key and shows four of its digits, such as <em>Trusted board AB12</em>. The same four digits appear here. Receive
          sends only to that board; if another one connects it stops, and <em>Trust this board</em> (or <em>TRUST</em> in
          the Shell) accepts the new one.
        </p>
        <GoodToKnow items={[
          'Up to 4 MB a file. The area holds up to 500 files or 256 MB for your organization, and keeps each file 30 days.',
          'A file cut off by a reset or a lost connection continues where it stopped when you send it again within 24 hours.',
          'Add to library is offered for ADF, ADZ, DMS, DMZ and HFE files; nothing is added on its own.',
          'Clear all removes every finished file you can see; a file still arriving stays.',
          'Download always saves the file: a web page sent from the Amiga is never opened in the browser.',
        ]} />
      </>
    ),
  },
```

and in `HELP_ORDER` insert `'from-amiga'` after `'send'`.

- [ ] **Step 6: Run the tests and look at it.**

```bash
pnpm vitest run src/lib/from-amiga-ui.test.ts src/lib/help/topics.test.ts
pnpm vitest run
pnpm exec tsc --noEmit
pnpm lint 2>&1 | tail -3
```

Expected: all pass; tsc prints nothing; no new lint error. Then `PORT=3100 pnpm dev` (stop it afterwards by its PID,
never by pattern) and open `/ingest` signed in: the card sits full width below the two cards, reads "Nothing from the
Amiga yet." at 390 px and at 1440 px with no horizontal scroll.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/from-amiga-ui.ts src/lib/from-amiga-ui.test.ts src/components/uploads/from-amiga-card.tsx \
        "src/app/(app)/ingest/page.tsx" "src/app/(app)/devices/page.tsx" src/components/devices/device-list.tsx \
        src/components/devices/device-card.tsx src/lib/help/topics.tsx src/lib/help/topics.test.ts
git commit -m "uploads: the From the Amiga card on the Upload page, the device card's line, the help topic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 18: e2e: the area driven by a simulated board

Runs only after Task 15 Step 3-4 (migration 0047 on the database the dev server reads).

**Files:**
- Create: `e2e/from-amiga.spec.ts`

**Interfaces:**
- Consumes: Tasks 12-17; `signUpFresh` (`e2e/helpers.ts`); `pairDevice`, `authHeader`, `cleanupSeeded` (`e2e/device-helpers.ts`);
  `formatVolume` (`src/lib/adffs/format.ts`).
- Produces: five e2e tests; the touched specs re-run.

- [ ] **Step 1: Write the spec.** Create `e2e/from-amiga.spec.ts`:

```ts
// Uploads from the Amiga (spec 2026-10-18 §10 increment 3): the From the Amiga area, driven by a simulated board over
// its own routes (status, open, chunk, close), as e2e/send-to-amiga.spec.ts drives sending.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { crc32 } from 'node:zlib';
import { signUpFresh } from './helpers';
import { formatVolume } from '@/lib/adffs/format';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

/** The board reports its firmware, Network mode and its key digits. */
async function boardSays(request: APIRequestContext, token: string, firmware = '1.19.0+gabc1234', upKey = 'ab12') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: firmware, secondDrive: 'net', driveVersion: 0, upKey } })).status()).toBe(204);
}
/** What a 1.19.0 board does for one PUT: open, 16 KB chunks, close. */
async function boardUploads(request: APIRequestContext, token: string, path: string, data: Buffer, date = '17000.600.0') {
  const open = await request.post('/api/device/upload', { headers: authHeader(token), data: { size: data.length, date, protection: 0, path, comment: '' } });
  expect(open.status()).toBe(200);
  const { id, offset } = (await open.json()) as { id: string; offset: number };
  for (let at = offset; at < data.length; at += 16_384) {
    const r = await request.post(`/api/device/upload/${id}?offset=${at}`, {
      headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: data.subarray(at, Math.min(at + 16_384, data.length)),
    });
    expect(r.status()).toBe(200);
  }
  expect((await request.post(`/api/device/upload/${id}/close`, { headers: authHeader(token), data: { crc32: crc32(data) >>> 0 } })).status()).toBe(200);
  return id;
}

test('a file from the Amiga appears with its board, downloads as an attachment, and Delete removes it', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  await page.goto('/ingest');
  await expect(page.getByTestId('from-amiga-empty')).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('from-amiga-key')).toContainText('AB12');            // the digits Receive shows
  const id = await boardUploads(request, token, 'Docs/Café.txt', Buffer.from('hello from the Amiga\n'));
  const row = page.getByTestId(`from-amiga-row-${id}`);
  await expect(row).toHaveAttribute('data-status', 'stored', { timeout: LIVE });
  await expect(row).toContainText('Docs/Café.txt');
  await expect(row).toContainText('from Bench');
  const dl = await page.request.get(`/api/uploads/${id}/file`);
  expect(dl.headers()['content-disposition']).toBe("attachment; filename*=UTF-8''Caf%C3%A9.txt");
  expect(dl.headers()['x-content-type-options']).toBe('nosniff');
  expect(dl.headers()['content-type']).toBe('application/octet-stream');
  expect((await dl.body()).toString()).toBe('hello from the Amiga\n');
  await expect(page.getByTestId(`from-amiga-library-${id}`)).toHaveCount(0);       // not a disk image
  await page.getByTestId(`from-amiga-delete-${id}`).click();
  await expect(row).toHaveCount(0, { timeout: LIVE });
});

test('an ADF goes to the library with one click, and the row says In library', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const adf = Buffer.from(formatVolume({ filesystem: 'FFS', volumeName: 'FromAmiga' }));
  const id = await boardUploads(request, token, 'Disks/FromAmiga.adf', adf);
  await page.goto('/ingest');
  await page.getByTestId(`from-amiga-library-${id}`).click();
  await expect(page.getByTestId(`from-amiga-in-library-${id}`)).toBeVisible({ timeout: LIVE });
  await page.getByTestId(`from-amiga-in-library-${id}`).click();
  await expect(page).toHaveURL(/\/games\//);
});

test('Clear all names the count, spares a file still arriving and one that arrived during the confirm', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  await boardSays(request, token);
  const a = await boardUploads(request, token, 'A.txt', Buffer.from('a'));
  const b = await boardUploads(request, token, 'B.txt', Buffer.from('b'));
  const open = await request.post('/api/device/upload', { headers: authHeader(token), data: { size: 20000, date: '1.2.3', protection: 0, path: 'Moving.bin', comment: '' } });
  const { id: moving } = (await open.json()) as { id: string };
  expect((await request.post(`/api/device/upload/${moving}?offset=0`, {
    headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.alloc(16_384, 1) })).status()).toBe(200);
  await page.goto('/ingest');
  await expect(page.getByTestId(`from-amiga-state-${moving}`)).toContainText('Arriving 81 %', { timeout: LIVE });
  await page.getByTestId('from-amiga-clear').click();
  await expect(page.getByTestId('from-amiga-confirm')).toContainText('Clear 2 files from the Amiga?');
  const late = await boardUploads(request, token, 'Late.txt', Buffer.from('late'));   // arrives while the confirm is open
  await page.getByTestId('from-amiga-confirm-yes').click();
  await expect(page.getByTestId(`from-amiga-row-${a}`)).toHaveCount(0, { timeout: LIVE });
  await expect(page.getByTestId(`from-amiga-row-${b}`)).toHaveCount(0);
  await expect(page.getByTestId(`from-amiga-row-${moving}`)).toBeVisible();
  await expect(page.getByTestId(`from-amiga-row-${late}`)).toBeVisible({ timeout: LIVE });
});

test('Send to an Amiga queues the file for another board', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');
  const { token: den } = await pairDevice(page, request, 'Den');
  await boardSays(request, token); await boardSays(request, den, '1.19.0+gabc1234', 'cd34');
  const id = await boardUploads(request, token, 'Docs/Note.txt', Buffer.from('note'));
  await page.goto('/ingest');
  await page.getByTestId(`from-amiga-send-${id}`).selectOption({ label: 'Den' });
  await expect(page.getByText('Queued for Den')).toBeVisible({ timeout: LIVE });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(den) })).body()).toString('latin1');
  expect(q).toMatch(/^NEXT \S+ 4 [0-9a-f]+ 0 13:Docs\/Note\.txt /);
});

test("the board filter, the device card's line, and the update an older Network board needs", async ({ page, request }) => {
  await signUpFresh(page);
  const bench = await pairDevice(page, request, 'Bench');
  const den = await pairDevice(page, request, 'Den');
  const old = await pairDevice(page, request, 'Old');
  await boardSays(request, bench.token); await boardSays(request, den.token, '1.19.0+gabc1234', 'cd34');
  await boardSays(request, old.token, '1.18.2+gabc1234', 'ef56');
  const fromBench = await boardUploads(request, bench.token, 'Bench.txt', Buffer.from('b'));
  const fromDen = await boardUploads(request, den.token, 'Den.txt', Buffer.from('d'));
  await page.goto('/ingest');
  await page.getByTestId('from-amiga-board').selectOption({ label: 'Den (key CD34)' });
  await expect(page.getByTestId(`from-amiga-row-${fromBench}`)).toHaveCount(0, { timeout: LIVE });
  await expect(page.getByTestId(`from-amiga-row-${fromDen}`)).toBeVisible();
  await page.goto('/devices');
  await expect(page.getByTestId(`device-upload-${bench.deviceId}`)).toHaveText('1 file from the Amiga');
  await expect(page.getByTestId(`device-upload-${old.deviceId}`)).toHaveText('Update to 1.19.0 to send files from the Amiga');
  await page.getByTestId(`device-upload-${bench.deviceId}`).click();
  await expect(page).toHaveURL(new RegExp(`/ingest\\?from=${bench.deviceId}#from-amiga`));
  await expect(page.getByTestId(`from-amiga-row-${fromBench}`)).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId(`from-amiga-row-${fromDen}`)).toHaveCount(0);
});
```

- [ ] **Step 2: Run it, then the touched specs** (PORT 3100, one at a time, each under 9 minutes; a failure is first
checked against a clean environment before it is called a regression):

```bash
PORT=3100 pnpm exec playwright test e2e/from-amiga.spec.ts
PORT=3100 pnpm exec playwright test e2e/send-to-amiga.spec.ts e2e/ingest-ui.spec.ts
PORT=3100 pnpm exec playwright test e2e/devices-page.spec.ts e2e/help.spec.ts
```

Expected: all pass. A failure in `from-amiga.spec.ts` is fixed in the code it names (with a unit test first where one
can pin it), not in the spec.

- [ ] **Step 3: Commit.**

```bash
git add e2e/from-amiga.spec.ts
git commit -m "uploads: e2e for the From the Amiga area against a simulated board

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 19: Receive 2 on the driver disk; the upload in the self-host smoke

**Files:**
- Modify: `tools/paulanet-disk/ReadMe`, `tools/paulanet-disk/paulanet-disk.sha256`
- Modify: `src/lib/paulanet-disk.ts`, `src/lib/paulanet-disk.test.ts`, `src/lib/network-checklist.test.ts`
- Modify: `scripts/docker-smoke.sh`

**Interfaces:**
- Consumes: Task 6's pinned `tools/receive/dist/Receive`; Tasks 12-13 (the device routes).
- Produces: a new `PAULANET_DISK_SHA256`; `PAULANET_DISK_PREVIOUS = '1ca4f4cb402042e9c842bcf7af91fb86cf5587125ba64134b26f4d25d35a352d'`;
  `PAULANET_DISK_OLDER = [PAULANET_DISK_PREVIOUS, 'fb363d45…aa287', '05170a83…8c9e']`; `smoke: upload from the Amiga OK`.

The rollout rule is unchanged (3bv R16): a board whose Amiga's driver was heard within 10 minutes keeps its older disk,
so a disk never changes under a running driver; every older disk stays served and GC-safe.

- [ ] **Step 1: Write the failing tests.** In `src/lib/paulanet-disk.test.ts`, the test
`'serves and keeps the current disk and every older one, and nothing else (plan 2026-10-18)'` begins:

```ts
  it('serves and keeps the current disk and every older one, and nothing else (plan 2026-10-19)', () => {
    expect(PAULANET_DISK_OLDER).toEqual([PAULANET_DISK_PREVIOUS,
      'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287', '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e']);
    expect(PAULANET_DISK_PREVIOUS).toBe('1ca4f4cb402042e9c842bcf7af91fb86cf5587125ba64134b26f4d25d35a352d');
```

(the rest of that test unchanged), and in `'leaves any older disk in DF1 while the Amiga runs, the disk before Receive too'`
`const before = PAULANET_DISK_OLDER[1];` becomes `for (const before of PAULANET_DISK_OLDER.slice(1)) {` with the two
`expect` lines inside the loop and a closing `}`. In `src/lib/network-checklist.test.ts` add, in
`'names the older driver disk as in DF1, ...'`:
`expect(driverDiskLine({ df1Sha256: 'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287' }).ok).toBe(true);`.

Run: `pnpm vitest run src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts`
Expected: FAIL (`PAULANET_DISK_PREVIOUS` is still `fb363d45…`).

- [ ] **Step 2: The ReadMe tells how to send.** In `tools/paulanet-disk/ReadMe`, replace the two paragraphs from
`In a Shell:  Receive [TO <folder>] [SAVE] [GUI]` to the end of the file with:

```
In a Shell:  Receive [TO <folder>] [SAVE] [GUI] [SEND <files>] [TRUST]
TO uses a folder for this run, SAVE also stores it, GUI opens
the window. Ctrl-C stops it.

Receive also sends files from the Amiga to the web app (board
firmware 1.19.0 or newer): drop icons or drawers on its window,
press Send..., or type  Receive SEND DH0:file  in a Shell. They
appear under From the Amiga on the web app's Upload page.
Receive sends only to the board it trusts: the first one it
meets ("Trusted board AB12"; the web app shows the same four
digits). If another one connects, press Trust this board (or
use TRUST) to accept it. A file cut off part way continues when
you send it again within 24 hours.

Nothing is overwritten: a second Foo.lha arrives as Foo_2.lha,
and nothing is written outside the folder. While Receive runs,
it listens on TCP port 6800, and any computer on your network
can drop a file into the folder -- but files go out only to
the trusted board.
```

- [ ] **Step 3: Build the disk and pin it.**

```bash
tools/paulanet-disk/build.sh /tmp/PaulaNET.adf || true
```

Expected: `PASS Receive is the pinned binary`, every check line `PASS`, then `FAIL: not the pinned disk (1ca4f4cb…)`
and the new digest on the line before it. Write that digest into `tools/paulanet-disk/paulanet-disk.sha256` and run
the build again. Expected: no `FAIL`. (If `check.py` fails on the ReadMe's size, its entry is `None` already; on
another file, stop and say which.)

- [ ] **Step 4: The server's pin.** In `src/lib/paulanet-disk.ts`:
- `PAULANET_DISK_SHA256` becomes the new digest from Step 3;
- the `PAULANET_DISK_PREVIOUS` doc comment and constant become:

```ts
/**
 * The driver disk before Receive 2 (plan 2026-10-19): the LZ4 driver and Receive 1 (plan 2026-10-18).
 */
export const PAULANET_DISK_PREVIOUS = '1ca4f4cb402042e9c842bcf7af91fb86cf5587125ba64134b26f4d25d35a352d';
```

- `PAULANET_DISK_OLDER` becomes
  `[PAULANET_DISK_PREVIOUS, 'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287', '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e']`
  and its doc's "then the disk before Receive (Phase 3)" becomes "then the disk before the LZ4 driver (Receive 1), then
  the disk before Receive (Phase 3)".

- [ ] **Step 5: The self-host smoke uploads a file.** In `scripts/docker-smoke.sh`, after `echo "smoke: PaulaNET disk OK"`:

```bash
# Uploads from the Amiga (spec 2026-10-18 §9): the board's three routes, played with curl against a device row with a
# known token; the bytes must land in blobs/adf/<sha256> (the local backend), as on Vercel Blob.
tok="wadf_smoke_upload"
tok_hash=$(printf '%s' "$tok" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)
dc exec -T db psql -U webadf -d webadf -v ON_ERROR_STOP=1 -q -c \
  "insert into devices (id, org_id, name, token_hash) values ('smoke-dev', 'smoke-org', 'Smoke board', '$tok_hash')" \
  || fail "could not seed a device row"
up="https://localhost:$PORT/api/device/upload"
open=$(curl -skf -H "authorization: Bearer $tok" -H 'content-type: application/json' \
  -d '{"size":11,"date":"1.2.3","protection":0,"path":"Smoke.txt","comment":""}' "$up") || fail "upload open"
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$open")
[ -n "$id" ] || fail "upload open answered no id: $open"
got=$(curl -skf -H "authorization: Bearer $tok" -H 'content-type: application/octet-stream' --data-binary 'hello amiga' "$up/$id?offset=0") \
  || fail "upload chunk"
has '"received":11' "$got" || fail "upload chunk answered $got"
crc=$(dc exec -T app node -e 'process.stdout.write(String(require("zlib").crc32(Buffer.from("hello amiga")) >>> 0))')
got=$(curl -skf -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "{\"crc32\":$crc}" "$up/$id/close") \
  || fail "upload close"
has '"name":"Smoke.txt"' "$got" || fail "upload close answered $got"
up_sha=$(printf 'hello amiga' | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)
got=$(docker run --rm -v "$W/data/blobs:/b:ro" alpine sh -c "cat /b/adf/$up_sha" 2>&1) || true
[ "$got" = "hello amiga" ] || fail "the upload is not stored under its sha in blobs/adf (got: $got)"
echo "smoke: upload from the Amiga OK"
```

(`compose.yaml`'s `db` service sets `POSTGRES_USER: webadf` and `POSTGRES_DB: webadf`; the postgres image trusts its
local socket.)

- [ ] **Step 6: Run everything this touches.**

```bash
pnpm vitest run src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts src/lib/help/topics.test.ts
pnpm vitest run
pnpm exec tsc --noEmit
pnpm docker:smoke
PORT=3100 pnpm exec playwright test e2e/second-drive.spec.ts
PORT=3100 pnpm exec playwright test e2e/device-image.spec.ts
```

Expected: all pass; the smoke prints `smoke: PaulaNET disk OK` (the new digest) and `smoke: upload from the Amiga OK`.

- [ ] **Step 7: Commit.**

```bash
git add tools/paulanet-disk/ReadMe tools/paulanet-disk/paulanet-disk.sha256 src/lib/paulanet-disk.ts \
        src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts scripts/docker-smoke.sh
git commit -m "paulanet-disk: Receive 2 on the driver disk (new pin; every older disk keeps the rollout rule); the smoke uploads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

- [ ] **Step 8: Put the disk in the store before any server names it** (production blob store; additive; ask the
operator first and end the turn): from the worktree,
`pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts /tmp/PaulaNET.adf`
Expected: `stored <key>, read back and verified` (or `already stored: ...`).

---

### Task 20: Final review, merge, HANDOFF

**Files:**
- Modify: `HANDOFF.md` (a new section `3cc`, above `3cb`)

**Interfaces:**
- Consumes: everything above.
- Produces: master with the whole feature; HANDOFF 3cc; the bench handed to the operator.

- [ ] **Step 1: Whole-branch review.** superpowers:requesting-code-review on `master...feat/amiga-upload` (increment 3
plus any fixes since Task 15), the brief again this plan's Global Constraints, Rulings and Review Focus. Fix Critical
and Important findings test-first; review the fixes.

- [ ] **Step 2: Every automated check** (as Task 15 Step 2), plus `pnpm docker:smoke` and the e2e runs of Task 18 Step 2.

- [ ] **Step 3: HANDOFF.** Add `### 3cc. Upload from the Amiga to the web app: Receive 2, fw 1.19.0 TEST, the From
the Amiga area (master <sha>) -- <date>` above `### 3cb.`, written like 3bv/3bw: spec and plan paths; what shipped
(Receive 2.0 and its pin, firmware 1.19.0 TEST seq and version, migration 0047 applied, the new disk digest and
`PAULANET_DISK_OLDER`); the measured numbers (Task 1's B0 or "defaults, B0 not run"; `.bss`; the 4 MB close time; the
FS-UAE 4 MB upload times); every ruling of this plan (P1-P15) and every ruling made during execution with its cost if
wrong; deviations; deferred minors; the bench owed (the Bench section below, by number).

- [ ] **Step 4: Merge and push** (master is production). From `/Users/sfs/Devel/webadf`:

```bash
git status --short                     # only the known untracked files
git checkout master && git pull --ff-only
git merge --no-ff feat/amiga-upload -m "Merge feat/amiga-upload: uploads from the Amiga -- the From the Amiga area, Receive 2 on the driver disk

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
git push origin master
```

Expected: the push succeeds; the workflows go green (`gh run list --limit 6`). After the deploy, the Upload page shows
the From the Amiga card, and the bench board's card reads "Driver disk: in DF1" with the new digest once its Amiga has
been quiet 10 minutes.

- [ ] **Step 5: Hand the bench to the operator** (the Bench section below), as the turn's last message, and end the turn.

---

## Bench (the operator runs these; not tasks)

The operator powers the Amiga and types (through the PiKVM when remote); ask as the last thing in a turn and end it.
Batch the steps. The board runs the 1.19.0 TEST build (Task 15 Step 8). Notes for any build published for the bench
start "TEST build" (HANDOFF 3bu). Record every number in HANDOFF 3cc.

**B0. The A2B measurement (increment 0, Task 1's build: 1.18.2 + `WF_A2B_DISCARD`).** Board in DF1 Network mode, the
A500 on PaulaNET with the stock-or-LZ4 driver as installed, `A2BBench.adf` mounted in DF0, the serial log running.
1. Read the board's address from the card or the serial log (`board <ip>` in the `pnet: l2 amiga` line).
2. In a Shell: `DF0:a2bsend <board ip> 6801 BYTES 1048576`. Note its line (`... bytes in ... s = ... B/s`).
3. At the same time, in a second Shell: `ping -c 20 <router ip>`; note min/avg/max.
4. From the serial log during the copy: the `a2b:` lines (`B/s`, `ooseq max`, `mem max`, `err`), `pnet: l2 local ...
   drop`, and the lowest `heap: free low-water` / `pnet: l2 amiga ... heap`.
5. Again with a file: `DF0:a2bsend <board ip> 6801 FILE SYS:Downloads/amiga-wb31_storage.adf` (880 KB, read from the
   hard disk: the rate with the Amiga's disk reads in it).
6. On the A4000D when it is available: steps 2-5 with the LZ4 driver (68030), plus the `pnet: l2 lz4 in` counter.
Then the agent applies Task 11 Step 1's rules and reinstalls 1.18.2.

**B1. Reinstall Receive.** Open DF1 (the new driver disk), double-click Install. `SYS:Tools/Receive` and `C:Receive`
are Receive 2.0 (`version C:Receive` says `Receive 2.0`). Start it from its icon: the title reads "webadf Receive &
Send" and, within 30 s, the status reads "Trusted board AB12" (first contact); the From the Amiga card on the Upload
page shows the same four digits.

**B2. Drop three files** on the window: an LHA, a text file and the 880 KB ADF. All three read "to web: done"; each
appears in From the Amiga from the bench board. Download each and compare its sha256 on the Mac with the Amiga's copy
(or Receive's CRC in the board log `up: <tag> stored`). Record the time of each (the `up: <tag> open` and `stored`
log lines) and work out bytes per second up on the 68000.

**B3. Add the ADF to the library** and mount it in DF0 from its title page: it boots or lists as the original. Delete
the text file, then Clear all: the area is empty, and the ADF is still in the library.

**B4. The Shell.** `Receive SEND RAM:x.txt` with the window open (a hand-off: the Shell prints the file's line when it
has gone up) and with it closed (a run of its own: "Waiting for the board", then the line, RC 0 -- check with
`echo $RC`).

**B5. Resume.** Reset the Amiga at about 40 % of the ADF (Ctrl+Alt+Del), start Receive, send the ADF again. The log
shows `up: <tag> open ... at <offset>` with offset > 0, and the file on the web is whole (sha256).

**B6. The web app unreachable mid-file.** Block the board's way to the server (unplug the router's uplink, or the
operator's choice) during an ADF: the window shows the percentage stop; after about 120 s Receive shows "failed: the
web app cannot be reached"; restore, press Retry failed: it resumes.

**B7. Both directions at once.** Send a file down from the Upload page while dropping a file on the window: both
arrive (the directions take turns).

**B8. An impostor.** With Receive running and no board yet (DF1 Off, or the board unplugged), point a Mac at the
Amiga's 6800 (`printf 'WEBADF 2 00000000000000000000000000000000\n' | nc <amiga ip> 6800`) and drop a file on the
window: the status reads "Another board or computer connected -- not sending", and nothing goes up (no `PUT` arrives
at the Mac). Then reconnect the board: Receive goes on with the trusted key.

**B9. Ping and heap.** Ping the router during an upload (note min/avg/max against B0), and read the heap low-water from
the log during B2-B7: at or above 20,480.

**B10. The A4000D** (68030, LZ4 driver), when available: B2 again, with the `pnet: l2 lz4 in` counter > 0 and the time
of each file against the A500's.
