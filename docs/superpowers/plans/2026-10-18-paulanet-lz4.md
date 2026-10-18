# PaulaNET LZ4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send compressible PaulaNET traffic as linked LZ4 blocks -- board -> Amiga on every 68k, Amiga -> board on
68020+ -- in webadf's own build of Rob Smith's PaulaNET.device and in board firmware 1.16.0, without changing a byte
of what Rob's stock driver sees.

**Architecture:** The board gets a C LZ4 block codec (`pnet_lz4.c`, the same algorithm as the 68000 encoder's C model
in `m68k/lz4/lz4_68k.c`), a packer that chooses per frame between LZ4 and today's MFM and packs a batch by real sizes
(`pnet_pack.c`), and a linked decoder for the Amiga's batches (`pnet_lz4_iter_next`, used by `pnet_link_take_lz4`).
The driver variant is Rob's NetDevice source (imported unchanged) plus `tools/paulanet-driver/webadf-lz4.patch`, a
pure LZ4 half of our own (`webadf_lz4.c`) and the MIT 68000 codec (`m68k/lz4/lz4_68k.asm`), built reproducibly with
his Makefile and vbcc from the pinned amiga-gcc image. Capability exchange: status byte 155 (board) and bit `0x10` of
`DataHeader.compressed` (driver). The driver disk then carries the variant.

**Tech Stack:** C11 (RP2350 firmware, pico-sdk 2.3.0; host tests with cc + liblz4 as referee), vbcc + vasm + vlink
from `stefanreinauer/amiga-gcc@sha256:cafc64bc…` (driver), m68k-amigaos-gcc 6.5 + amitools vamos (driver tests on an
emulated 68000/68020/68040), AmigaOS 3.2 NDK R4 headers (downloaded, pinned), TypeScript/Next.js (server pin),
xdftool (driver disk), Docker.

**Spec:** `docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md`

## Global Constraints

- Wire: bit 14 (`0x4000`) of a frame's size word = LZ4 block; bits 0-13 = the block's length in bytes (max 16,383).
- Board -> Amiga an LZ4 frame is `0xC000 | lz4_len`, its bytes MFM-encoded (2 x lz4_len on the wire). Never raw.
- Amiga -> board an LZ4 frame is `0x4000 | lz4_len`, raw, padded to even; the board also accepts `0xC000 | lz4_len`
  (MFM-wrapped) from day one.
- Standard LZ4 block format (lz4 1.9 `LZ4_compress_default` compatible, little-endian offsets); no LZ4 frame header,
  no content checksum.
- Linked within a batch only: every frame of a batch is laid back to back (the window); a frame's matches reach only
  into the earlier frames of the same batch. Never across batches.
- Choice per frame: LZ4 only when the block is strictly shorter than the current encoding (board -> Amiga: the
  frame's raw length; Amiga -> board: its RLE length). Otherwise the frame goes exactly as today.
- Status byte 155 (`LiveStatus.reserved`): bit 0 = the board sends LZ4 to a driver that asks, bit 1 = the board
  accepts LZ4 frames. Firmware 1.16.0 sets both (0 when its LZ4 buffers are not backed by PSRAM).
- The driver sets `0x10` in `DataHeader.compressed` on every Ethernet batch it writes. The board sends LZ4 only while
  the latest batch from the Amiga (a resend included) carried `0x10`.
- Per CPU, read from `SysBase->AttnFlags` at open: 68000/68010 down LZ4, up RLE; 68020/68030 both LZ4, table 1,024
  entries; 68040/68060 both LZ4, table 4,096; Rob's stock driver (any CPU) MFM down, RLE up.
- Window: 16,128 bytes in both directions (`PNET_LZ4_WINDOW` = `WL_WINDOW`); a batch toward the Amiga holds at most
  20 frames, 16,128 decoded bytes, 16,128 payload bytes, and fits DF1's buffer on the wire.
- Board hash table: 4,096 x 16-bit entries in PSRAM. New SRAM `.bss` at most 16 bytes (the heap low-water already
  sits at its 20,480 B floor, HANDOFF 3bv): every other new firmware static is `__uninitialized_psram`.
- A raw LZ4 block toward the board carries no run of more than 5 zero bytes (`WL_ZERO_RUN_MAX`): 6 or more is a gap
  past the board's `PNET_RX_MAX_CELLS` (64), the batch is refused and the driver resends it forever. Such a frame
  goes RLE.
- Code built for the Amiga (and the firmware C the driver tests build for it) uses byte access only: no word or long
  access at an odd address.
- Version string `PaulaNET.device 1.1-webadf-lz4` (Rob's 1.1 plus `DEVICEEXTRA -webadf-lz4`).
- Rob's files stay unchanged under `third-party/paulanet/src/`; every change to them is in
  `tools/paulanet-driver/webadf-lz4.patch`. The variant is pinned by our own sha256 (`driver.sha256`): Rob's
  shipped binary (13,872 B) is not what his source builds to (12,808 B, `7d14d9d1…`).
- Licences: `m68k/lz4/` and `tools/paulanet-driver/src/` are MIT (ours); Rob's code by his permission
  (2026-10-12); liblz4 (BSD-2) is a test-only referee; the NDK is downloaded at build time and never committed.
- Firmware stays `FIRMWARE_SEMVER 1.16.0`; only TEST builds (`--no-github`, notes starting exactly `TEST build`,
  read back from the DB). Releasing 1.16.0 is a separate operator decision.
- Process: never `git add -A` (other sessions change this tree; re-check `git status`); e2e only on `PORT=3100`, one
  run at a time, each under 9 minutes, only the specs for touched areas; master is the Vercel production branch
  (merge + push is the approved pattern, still a listed step); the Amiga goes off when not needed; a manual hardware
  step (power, typing, moving the board) is asked for as the last thing in a turn.
- Every commit message ends with the executing session's attribution trailers (this plan's session used
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk`).

## Review Focus

- **A batch where only some frames are LZ4.** MFM/RLE frames still occupy the window on both sides, so an LZ4 frame
  after a random-bytes MFM frame must decode exactly; a reviewer should expect mixed batches to round-trip in both
  directions (tests: Task 3 `an_lz4_batch_is_decoded_linked_into_the_ring`, Task 4 `a_batch_mixes_lz4_and_mfm`,
  Task 5 `down`/`up`).
- **A driver that stops sending `0x10` mid-session** (Rob's driver loaded while our LZ4 batch is out). The batch out
  must be re-packed MFM before the stock driver reads it, may hold fewer frames (the rest stay queued), and nothing
  LZ4 may reach a stock driver (tests: Task 3 `the_drivers_word_follows_the_latest_header`, Task 4
  `the_driver_stops_asking_mid_session`).
- **A raw LZ4 block toward the board with a long run of zero bytes** (text ending in zeros, an ARP request's
  target MAC). Gaps over 64 cells make the board refuse the whole batch and the driver resend it forever -- an
  upload stall. Such frames must go RLE (tests: Task 5 `zerorun` and the zero-tail frame in `up`).
- **Sizes at the edges.** A frame whose LZ4 block is exactly as long as its alternative goes as the alternative; a
  16,128 B incompressible batch is 1.15.0's byte for byte; a batch decoding to exactly 16,128 B links and one byte
  more stops it, in both directions (tests: Task 2 `a_block_as_long_as_its_frame_is_not_used`, Task 4
  `a_full_incompressible_batch_is_1_15_0s`, `packing_stops_at_16128_decoded_bytes`, Task 3
  `the_window_ends_at_16128_bytes`, Task 5 `equal`).
- **Malformed LZ4 from the Amiga** (a corrupt block whose checksum still matched, a driver bug, garbage size words).
  It must never write past the window, the scratch or a ring slot, and must be counted, not crash (tests: Task 2
  `malformed_blocks_never_write_out_of_bounds`, Task 3 `malformed_lz4_never_overruns_the_board`).

---

## File Structure

Created:

| Path | Responsibility |
|---|---|
| `third-party/paulanet/src/readme.md`, `third-party/paulanet/src/NetDevice/**` | Rob's driver source at `0afd5fa081fad008f331d413410dea76e037f30e`, unchanged (`git archive`) |
| `m68k/lz4/**`, `tools/lz4-measure/**` | merged from `feat/lz4-68k`: the 68000 LZ4 codec (MIT), its C model and tests |
| `wifi-floppy/firmware/src/pnet_lz4.c/.h` | the board's LZ4 block codec and the linked frame iterator |
| `wifi-floppy/firmware/src/pnet_pack.c/.h` | board -> Amiga: which frames make a batch, LZ4 or MFM per frame, and the track builder |
| `wifi-floppy/firmware/test/lz4_corpus.h` | deterministic text / HTML / random / zero frames for every LZ4 test (host and 68k) |
| `wifi-floppy/firmware/test/test_pnet_lz4.c` | codec vs liblz4 and vs the 68k C model |
| `wifi-floppy/firmware/test/test_pnet_pack.c` | packing, the choice rule, 1.15.0 equivalence, the driver swap |
| `tools/paulanet-driver/src/webadf_lz4.c/.h` | the driver's LZ4 half: per-CPU gate, linked decode and encode, zero-run guard (MIT, pure) |
| `tools/paulanet-driver/webadf-lz4.patch` | the only change to Rob's files: `Makefile`, `paulanetio.c`, `version.h` |
| `tools/paulanet-driver/build.sh` | reproducible build (vbcc in the pinned image, NDK 3.2 R4 pinned), `--pin`, `STOCK=1` toolchain check |
| `tools/paulanet-driver/driver.sha256`, `tools/paulanet-driver/dist/PaulaNET.device` | the pin and the committed binary the disk uses |
| `tools/paulanet-driver/test.sh`, `tools/paulanet-driver/test/drvtest.c` | the LZ4 half against the board's C under vamos (68000/68020/68040) |
| `.github/workflows/paulanet-driver.yml` | CI: stock rebuild check, variant pin, committed binary |
| `tools/paulanet-driver/pr/*` | the two Rob PR drafts (patches + bodies), shown to the operator, not opened |

Modified:

| Path | Change |
|---|---|
| `wifi-floppy/firmware/src/pnet_frame.h/.c` | `PNET_DRIVER_LZ4`, `PNET_SIZE_LZ4`, `PNET_E_LZ4` and its text |
| `wifi-floppy/firmware/src/pnet_link.h/.c` | `pnet_link_take_lz4`, `pnet_link_shrink`, `amiga_lz4`, `lz4_in`, `lz4_bad` |
| `wifi-floppy/firmware/src/pnet_status.h/.c` | status byte 155 |
| `wifi-floppy/firmware/src/main.c` | PSRAM buffers and state, packing, the linked take, status bits, two `pnet: l2 lz4` lines |
| `wifi-floppy/firmware/CMakeLists.txt` | `pnet_lz4.c`, `pnet_pack.c` in L2 builds |
| `wifi-floppy/firmware/test/run.sh` | optional test-name arguments; liblz4 for `test_pnet_lz4.c` |
| `wifi-floppy/firmware/test/test_pnet_link.c`, `test_pnet_status.c`, `test_pnet_frame.c` | new cases |
| `.github/workflows/firmware.yml` | `liblz4-dev pkg-config`; `m68k/lz4/**` path |
| `tools/paulanet-disk/build.sh`, `check.py`, `ReadMe`, `paulanet-disk.sha256` | the variant on the disk; new pin |
| `docker/Dockerfile` | copies the variant and its pin into the `paulanet` stage |
| `src/lib/paulanet-disk.ts` (+ test), `src/lib/network-checklist.ts` (+ test), `src/lib/help/topics.tsx` (+ test), `src/app/api/paulanet-disk/route.ts` | new digest; every older disk keeps the rollout rule |
| `third-party/paulanet/README.md`, `THIRD-PARTY-NOTICES.md`, `.gitignore`, `HANDOFF.md` | provenance, licence notice, ignores, section 3bw |

---

### Task 1: Branch, Rob's driver source, the 68000 LZ4 codec

**Files:**
- Create: `third-party/paulanet/src/readme.md`, `third-party/paulanet/src/NetDevice/` (25 files, Rob's, unchanged)
- Merge: `feat/lz4-68k` (brings `m68k/lz4/**`, `tools/lz4-measure/**`)
- Modify: `third-party/paulanet/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: branch `feat/paulanet-lz4` in worktree `.claude/worktrees/lz4`; `m68k/lz4/lz4_68k.{asm,c,h}` with
  `lz4_decode(src, srclen, dst, dst_end, window) -> long` and
  `lz4_encode_linked(src, n, dst, cap, uint16_t *table, entries, window) -> unsigned long` (asm, C stack entries) and
  `lz4_encode_linked_ref(...)` (portable C model, same signature); `third-party/paulanet/src/NetDevice/` (Rob's tree);
  `wifi-floppy/firmware/build/size-before-lz4.txt` (the `.bss` baseline).

- [ ] **Step 1: Create the worktree.** From `/Users/sfs/Devel/webadf`:

```bash
git status --short          # expect only the untracked .fw-target.mts .hd-mount.mts docs/*.pdf docs/schematic/
git worktree add .claude/worktrees/lz4 -b feat/paulanet-lz4 master
cd .claude/worktrees/lz4
pnpm install --offline
cp ../../../.env.local .env.local
pnpm exec next typegen
ln -s ../../../adf-archive adf-archive
```

Expected: `Preparing worktree (new branch 'feat/paulanet-lz4')`; install and typegen finish without errors. All later
commands run from `/Users/sfs/Devel/webadf/.claude/worktrees/lz4` unless a step says otherwise.

- [ ] **Step 2: Merge the 68000 codec.**

```bash
git merge --no-ff feat/lz4-68k -m "Merge feat/lz4-68k: the 68000 LZ4 codec (MIT, ours) for the PaulaNET driver variant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
git diff --stat HEAD^1 HEAD | tail -1
```

Expected: a clean merge; `22 files changed, 4012 insertions(+)`.

- [ ] **Step 3: Prove the merged codec still passes here.**

```bash
NO_LIVE=1 tools/lz4-measure/build.sh
m68k/lz4/test.sh host build dec enc
```

Expected: the last line `test.sh: all steps passed: host build dec enc`.

- [ ] **Step 4: Import Rob's driver source, unchanged.**

```bash
tmp="$(mktemp -d)"
git clone --quiet https://github.com/RobSmithDev/PaulaNET "$tmp/PaulaNET"
git -C "$tmp/PaulaNET" checkout --quiet 0afd5fa081fad008f331d413410dea76e037f30e
mkdir -p third-party/paulanet/src
git -C "$tmp/PaulaNET" archive 0afd5fa081fad008f331d413410dea76e037f30e readme.md NetDevice | tar -x -C third-party/paulanet/src
diff -r "$tmp/PaulaNET/NetDevice" third-party/paulanet/src/NetDevice && echo SAME
find third-party/paulanet/src -type f | wc -l
```

Expected: `SAME`, `26` (25 NetDevice files plus `readme.md`). If GitHub is unreachable, the 2026-10-17 session's clone
at `/private/tmp/claude-501/-Users-sfs-Devel-webadf/675c185f-947c-4752-b904-7630c037fa06/scratchpad/robfw/PaulaNET`
is the same commit (`git -C <it> rev-parse HEAD` must print `0afd5fa081fad008f331d413410dea76e037f30e` and
`git -C <it> status --short` nothing) and serves as `$tmp/PaulaNET`.

Only the driver's tree is imported: `AmigaConfig/`, `Gerber/`, `MakeDiskImage/` and `Pico/` (13 MB, 7 MB of it
AmigaConfig's third-party library headers) are not built from here; they stay at the pinned commit upstream.

- [ ] **Step 5: Record the provenance.** In `third-party/paulanet/README.md`, replace the table and the paragraph
after it with:

```markdown
| File | sha256 | What |
|---|---|---|
| `PaulaNET-0afd5fa.adf` | d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0 | His disk image, decoded from `Pico/PaulaNET/DiskImage.cpp` (FFS, volume "PaulaNET", 12.06.2026; cylinders 75-79 allocated) |
| `PaulaNET.device` | 205a4f68dbbb7c58526cfb6c2ead65bf7ba05ad0c59484660574025b31e668cc | His driver, 13,872 bytes, read out of that image |
| `src/readme.md`, `src/NetDevice/` | (git tree of 0afd5fa081fad008f331d413410dea76e037f30e) | His driver's source, `git archive` of that commit, unchanged |

`tools/paulanet-driver/` builds webadf's LZ4 variant of the driver from `src/NetDevice/` plus a patch of ours
(spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §4); the PaulaNET driver disk carries that build.
His source builds to 12,808 bytes (sha256 7d14d9d1ecc3dc986b47120781bf091928c228c04c1cc3f5b9b8c24c1466a29b), not to
the 13,872-byte binary above, so the variant is pinned by its own digest. Nothing in this directory is ever modified.
```

- [ ] **Step 6: Record the firmware's `.bss` before any LZ4 change.**

```bash
pnpm firmware:build
arm-none-eabi-size wifi-floppy/firmware/build/wifi_floppy.elf | tee wifi-floppy/firmware/build/size-before-lz4.txt
```

Expected: a line `text data bss dec hex filename` and one with numbers (keep it; Task 4 compares `bss`).

- [ ] **Step 7: Commit.**

```bash
git add third-party/paulanet/src third-party/paulanet/README.md
git commit -m "third-party/paulanet: Rob's driver source at 0afd5fa, unchanged (for the LZ4 variant)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 2: The board's LZ4 block codec

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_lz4.h`, `wifi-floppy/firmware/src/pnet_lz4.c`
- Create: `wifi-floppy/firmware/test/lz4_corpus.h`, `wifi-floppy/firmware/test/test_pnet_lz4.c`
- Modify: `wifi-floppy/firmware/test/run.sh:64` (the test loop), `.github/workflows/firmware.yml` (apt line, paths)

**Interfaces:**
- Consumes: `lz4_encode_linked_ref` from `m68k/lz4/lz4_68k.c` (test only); `PNET_ETH_MTU` from `pnet_frame.h`.
- Produces:
  - `#define PNET_LZ4_WINDOW 16128u`, `PNET_LZ4_TABLE_ENTRIES 4096u`, `PNET_LZ4_BLOCK_MAX 1540u`
  - `size_t pnet_lz4_encode_linked(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *table, unsigned entries, const uint8_t *window);`
    -- the block's size (1..cap) or 0 if it would exceed `cap` (or `n > 65535`, `window > src`, `(src - window) + n > 65536`); nothing written at or past `dst + cap`.
  - `long pnet_lz4_decode(const uint8_t *src, size_t n, uint8_t *dst, uint8_t *dst_end, const uint8_t *window);`
    -- the decoded length, or -1; never writes outside `[dst, dst_end)`, never reads outside `[src, src + n)`, never copies a match from before `window`.
  - `test/lz4_corpus.h`: `enum { LC_TEXT, LC_RANDOM, LC_ZEROS, LC_TEXT_ZERO_TAIL, LC_HTML };` and
    `static void lc_frame(uint8_t *f, size_t len, int kind, uint32_t seed);`
  - `test/run.sh [test_x.c ...]` runs only the named C tests (the source checks always run).

- [ ] **Step 1: Let run.sh run one test, and link liblz4 where it is the referee.** In
`wifi-floppy/firmware/test/run.sh` replace

```bash
for t in test_*.c; do
  out=".build/${t%.c}"
```

with

```bash
# run.sh [test_x.c ...]: only those C tests (the source checks below always run); no arguments: all of them.
if [ $# -gt 0 ]; then tests=("$@"); else tests=(test_*.c); fi
for t in "${tests[@]}"; do
  out=".build/${t%.c}"
  # liblz4 (BSD-2) referees the board's LZ4 codec (spec 2026-10-18 §6); only test_pnet_lz4.c links it.
  extra=""
  if [ "$t" = test_pnet_lz4.c ]; then
    extra="$(pkg-config --cflags --libs liblz4)" ||
      { echo "COMPILE FAIL: $t needs liblz4 (macOS: brew install lz4; Debian/Ubuntu: apt install liblz4-dev pkg-config)"; fail=1; continue; }
  fi
```

and in the `cc` command of that loop replace `.build/monocypher.o .build/monocypher-ed25519.o -I../src/vendor/monocypher \`
with `.build/monocypher.o .build/monocypher-ed25519.o -I../src/vendor/monocypher $extra \`.

In `.github/workflows/firmware.yml`: the install line becomes
`sudo apt-get install -y gcc-arm-none-eabi ninja-build cmake liblz4-dev pkg-config`, and both `paths:` lists gain
`- 'm68k/lz4/**'                      # test_pnet_lz4.c checks the encoder against its C model`.

- [ ] **Step 2: Write the shared corpus.** Create `wifi-floppy/firmware/test/lz4_corpus.h`:

```c
#ifndef LZ4_CORPUS_H
#define LZ4_CORPUS_H
/*
 * Frames for the LZ4 tests (spec 2026-10-18 §6, "check binaries and text files"): text and HTML that compress, random
 * bytes that do not, zeros, and text whose last 11 bytes are zeros (a raw block toward the board must not carry such a
 * run). Deterministic per seed. Header-only and byte access only: tools/paulanet-driver/test.sh builds it for the
 * 68000 too. Ours (MIT).
 */
#include <stdint.h>
#include <stddef.h>
#include <string.h>

enum { LC_TEXT, LC_RANDOM, LC_ZEROS, LC_TEXT_ZERO_TAIL, LC_HTML };

static uint32_t lc_next(uint32_t *s) {
    uint32_t x = *s;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return *s = x;
}

static const char *const LC_WORDS[] = {
    "the ", "amiga ", "floppy ", "network ", "packet ", "board ", "driver ", "paula ", "reads ", "writes ",
    "track ", "workbench ", "disk ", "file ", "and ", "of ", "to ", "a ", "is ", "with ", ". ", ",\n",
};
static const char *const LC_TAGS[] = {
    "<p>", "</p>\n", "<a href=\"/disk/", "\">", "</a>", "<li class=\"row\">", "</li>\n", "<div id=\"main\">", "</div>",
};

static void lc_frame(uint8_t *f, size_t len, int kind, uint32_t seed) {
    uint32_t s = seed * 2654435761u + 0x9E3779B9u;
    size_t i = 0;
    if (kind == LC_RANDOM) { for (; i < len; i++) f[i] = (uint8_t)lc_next(&s); return; }
    if (kind == LC_ZEROS) { memset(f, 0, len); return; }
    while (i < len) {
        const char *w = kind == LC_HTML && (lc_next(&s) & 3u) == 0u
            ? LC_TAGS[lc_next(&s) % (sizeof LC_TAGS / sizeof LC_TAGS[0])]
            : LC_WORDS[lc_next(&s) % (sizeof LC_WORDS / sizeof LC_WORDS[0])];
        while (*w && i < len) f[i++] = (uint8_t)*w++;
    }
    if (kind == LC_TEXT_ZERO_TAIL && len >= 11u) memset(f + len - 11u, 0, 11u);
}
#endif
```

- [ ] **Step 3: Write the failing tests.** Create `wifi-floppy/firmware/test/test_pnet_lz4.c`:

```c
/*
 * PaulaNET LZ4 (spec 2026-10-18 §5-§6): the board's LZ4 block codec against the reference liblz4 (BSD-2, the
 * referee) and against m68k/lz4/lz4_68k.c, the C model the driver's 68000 encoder matches bit for bit.
 */
#include "harness.h"
#include "lz4_corpus.h"
#include "../src/pnet_lz4.h"
#include <lz4.h>
#include <stdint.h>
#include <string.h>
#include "../../../m68k/lz4/lz4_68k.c"

static uint8_t g_src[PNET_LZ4_WINDOW], g_blk[PNET_LZ4_WINDOW + 64], g_out[PNET_LZ4_WINDOW + 64];
static uint16_t g_tab[PNET_LZ4_TABLE_ENTRIES], g_tab2[PNET_LZ4_TABLE_ENTRIES];
static const int KINDS[] = { LC_TEXT, LC_HTML, LC_RANDOM, LC_ZEROS, LC_TEXT_ZERO_TAIL };
#define NKINDS (sizeof KINDS / sizeof KINDS[0])
/* 20 bytes whose LZ4 block is exactly 20 bytes: 8 literals, a 4-byte match at offset 8, 8 literals. */
static const uint8_t SAME_SIZE[20] = { 'W', 'X', 'Y', 'Z', 1, 2, 3, 4, 'W', 'X', 'Y', 'Z', 5, 6, 7, 8, 9, 10, 11, 12 };

static void decodes_liblz4_blocks(void) {
    unsigned bad = 0, cases = 0;
    for (unsigned k = 0; k < NKINDS; k++)
        for (size_t n = 1; n <= PNET_ETH_MTU; n += (n < 64u ? 1u : 37u)) {
            lc_frame(g_src, n, KINDS[k], (uint32_t)n);
            const int z = LZ4_compress_default((const char *)g_src, (char *)g_blk, (int)n, (int)sizeof g_blk);
            memset(g_out, 0xEE, n + 16u);
            const long got = pnet_lz4_decode(g_blk, (size_t)z, g_out, g_out + n, g_out);
            if (got != (long)n || memcmp(g_out, g_src, n) != 0 || g_out[n] != 0xEE) bad++;
            cases++;
        }
    CHECK(cases > 500, "cases");
    CHECK_EQ_INT(bad, 0);
}

/* liblz4's streaming mode over one contiguous buffer is exactly the batch's linking: each block may refer back into
 * the frames before it. */
static void decodes_liblz4_linked_blocks(void) {
    LZ4_stream_t st;
    LZ4_initStream(&st, sizeof st);
    size_t pos = 0;
    unsigned frames = 0, bad = 0;
    memset(g_out, 0, sizeof g_out);
    while (pos + PNET_ETH_MTU <= PNET_LZ4_WINDOW) {
        const size_t n = 200u + (frames * 97u) % 1319u;
        lc_frame(g_src + pos, n, frames % 3u == 2u ? LC_HTML : LC_TEXT, frames);
        const int z = LZ4_compress_fast_continue(&st, (const char *)g_src + pos, (char *)g_blk, (int)n,
                                                 (int)sizeof g_blk, 1);
        const long got = pnet_lz4_decode(g_blk, (size_t)z, g_out + pos, g_out + pos + n, g_out);
        if (got != (long)n || memcmp(g_out + pos, g_src + pos, n) != 0) bad++;
        pos += n;
        frames++;
    }
    CHECK(frames >= 10, "a window's worth of frames");
    CHECK_EQ_INT(bad, 0);
}

static void its_blocks_decode_with_liblz4(void) {
    for (unsigned e = 0; e < 2; e++) {
        const unsigned entries = e ? 4096u : 1024u;
        memset(g_tab, 0, sizeof g_tab);
        size_t pos = 0, linked = 0, alone = 0;
        unsigned frames = 0, bad = 0;
        while (pos + PNET_ETH_MTU <= PNET_LZ4_WINDOW) {
            const size_t n = 64u + (frames * 131u) % 1455u;
            lc_frame(g_src + pos, n, KINDS[frames % NKINDS], frames + 100u * e);
            const size_t z = pnet_lz4_encode_linked(g_src + pos, n, g_blk, sizeof g_blk, g_tab, entries, g_src);
            const int got = LZ4_decompress_safe_usingDict((const char *)g_blk, (char *)g_out + pos, (int)z, (int)n,
                                                          (const char *)g_out, (int)pos);
            if (z == 0 || got != (int)n || memcmp(g_out + pos, g_src + pos, n) != 0) bad++;
            memset(g_tab2, 0, sizeof g_tab2);
            alone += pnet_lz4_encode_linked(g_src + pos, n, g_blk, sizeof g_blk, g_tab2, entries, g_src + pos);
            linked += z;
            pos += n;
            frames++;
        }
        CHECK_EQ_INT(bad, 0);
        CHECK(linked < alone, "linking to the batch's earlier frames makes it smaller");
    }
}

static void the_encoder_is_the_68k_model_byte_for_byte(void) {
    static uint8_t a[PNET_LZ4_WINDOW], b[PNET_LZ4_WINDOW];
    unsigned diff = 0, cases = 0;
    for (unsigned e = 0; e < 2; e++) {
        const unsigned entries = e ? 4096u : 1024u;
        memset(g_tab, 0, sizeof g_tab);
        memset(g_tab2, 0, sizeof g_tab2);
        size_t pos = 0;
        unsigned f = 0;
        while (pos + PNET_ETH_MTU <= PNET_LZ4_WINDOW) {
            const size_t n = 1u + (f * 211u) % PNET_ETH_MTU;
            lc_frame(g_src + pos, n, KINDS[f % NKINDS], f + 7u);
            const size_t cap = f % 4u == 3u ? n - 1u : sizeof a;     /* every 4th with the board's cap */
            const size_t za = pnet_lz4_encode_linked(g_src + pos, n, a, cap, g_tab, entries, g_src);
            const unsigned long zb = lz4_encode_linked_ref(g_src + pos, n, b, cap, g_tab2, entries, g_src);
            if (za != zb || memcmp(a, b, za) != 0 || memcmp(g_tab, g_tab2, sizeof g_tab) != 0) diff++;
            cases++;
            pos += n;
            f++;
        }
    }
    CHECK(cases > 20, "cases");
    CHECK_EQ_INT(diff, 0);
}

static void the_cap_is_exact(void) {
    unsigned bad = 0;
    for (unsigned k = 0; k < NKINDS; k++)
        for (size_t n = 1; n <= PNET_ETH_MTU; n += 89u) {
            lc_frame(g_src, n, KINDS[k], (uint32_t)(n + k));
            memset(g_tab, 0, sizeof g_tab);
            const size_t s = pnet_lz4_encode_linked(g_src, n, g_blk, sizeof g_blk, g_tab, 4096, g_src);
            memset(g_tab, 0, sizeof g_tab);
            memset(g_out, 0xEE, sizeof g_out);
            const size_t at = pnet_lz4_encode_linked(g_src, n, g_out, s, g_tab, 4096, g_src);
            memset(g_tab, 0, sizeof g_tab);
            const size_t under = pnet_lz4_encode_linked(g_src, n, g_out + 4096, s - 1u, g_tab, 4096, g_src);
            if (s == 0 || at != s || under != 0 || g_out[s] != 0xEE || g_out[4096u + s - 1u] != 0xEE) bad++;
        }
    CHECK_EQ_INT(bad, 0);
}

/* Review Focus, sizes at the edges: the board encodes with cap = len - 1, so a block as long as its frame is not used. */
static void a_block_as_long_as_its_frame_is_not_used(void) {
    memset(g_tab, 0, sizeof g_tab);
    CHECK_EQ_INT(pnet_lz4_encode_linked(SAME_SIZE, 20, g_blk, sizeof g_blk, g_tab, 4096, SAME_SIZE), 20);
    memset(g_tab, 0, sizeof g_tab);
    CHECK_EQ_INT(pnet_lz4_encode_linked(SAME_SIZE, 20, g_blk, 19, g_tab, 4096, SAME_SIZE), 0);
}

static void incompressible_frames_never_shrink(void) {
    lc_frame(g_src, PNET_ETH_MTU, LC_RANDOM, 99);
    memset(g_tab, 0, sizeof g_tab);
    CHECK_EQ_INT(pnet_lz4_encode_linked(g_src, PNET_ETH_MTU, g_blk, PNET_ETH_MTU - 1u, g_tab, 4096, g_src), 0);
    memset(g_tab, 0, sizeof g_tab);
    const size_t z = pnet_lz4_encode_linked(g_src, PNET_ETH_MTU, g_blk, sizeof g_blk, g_tab, 4096, g_src);
    CHECK(z > PNET_ETH_MTU && z <= PNET_LZ4_BLOCK_MAX, "an MTU of random bytes fits PNET_LZ4_BLOCK_MAX");
}

/* Review Focus, malformed LZ4: random and damaged blocks never write outside dst..dst_end (nor into the window
 * before it), and whatever both decoders accept decodes the same. */
static void malformed_blocks_never_write_out_of_bounds(void) {
    static uint8_t buf[2048 + PNET_ETH_MTU + 64], ref[2048 + PNET_ETH_MTU + 64];
    uint32_t s = 12345;
    unsigned outside = 0, disagree = 0, both = 0;
    for (unsigned t = 0; t < 20000; t++) {
        size_t n, cap = 1u + lc_next(&s) % PNET_ETH_MTU;
        if (t % 2u) {                                       /* a valid block, damaged */
            const size_t m = 1u + lc_next(&s) % PNET_ETH_MTU;
            lc_frame(g_src, m, KINDS[t % NKINDS], t);
            n = (size_t)LZ4_compress_default((const char *)g_src, (char *)g_blk, (int)m, (int)sizeof g_blk);
            switch (lc_next(&s) % 3u) {
            case 0: n = lc_next(&s) % n; break;                                              /* truncated */
            case 1: g_blk[lc_next(&s) % n] ^= (uint8_t)(1u << (lc_next(&s) % 8u)); break;    /* one bit */
            default: g_blk[lc_next(&s) % n] = (uint8_t)lc_next(&s); break;                   /* one byte */
            }
            cap = m;
        } else {                                            /* random bytes */
            n = 1u + lc_next(&s) % 64u;
            for (size_t i = 0; i < n; i++) g_blk[i] = (uint8_t)lc_next(&s);
        }
        memset(buf, 0x55, sizeof buf);
        uint8_t *dst = buf + 2048;
        const long got = pnet_lz4_decode(g_blk, n, dst, dst + cap, dst - 1024);
        for (size_t i = 0; i < 2048; i++) if (buf[i] != 0x55) outside++;            /* the window is read only */
        for (size_t i = 2048 + cap; i < sizeof buf; i++) if (buf[i] != 0x55) outside++;
        if (got > (long)cap || got < -1) outside++;
        memset(ref, 0x55, sizeof ref);
        const int r = LZ4_decompress_safe_usingDict((const char *)g_blk, (char *)ref + 2048, (int)n, (int)cap,
                                                    (const char *)ref + 1024, 1024);
        if (got >= 0 && r >= 0) {
            both++;
            if (r != got || memcmp(ref + 2048, dst, (size_t)got) != 0) disagree++;
        }
    }
    CHECK_EQ_INT(outside, 0);
    CHECK_EQ_INT(disagree, 0);
    CHECK(both > 0, "some damaged blocks still decode, and then as liblz4 decodes them");
}

static void a_match_below_the_window_or_at_offset_0_is_refused(void) {
    /* token 0x10: 1 literal, a 4-byte match at offset 2 (one byte before the frame), then 5 literals */
    static const uint8_t below[] = { 0x10, 'A', 0x02, 0x00, 0x50, 'b', 'c', 'd', 'e', 'f' };
    static const uint8_t zero[] = { 0x10, 'A', 0x00, 0x00, 0x50, 'b', 'c', 'd', 'e', 'f' };
    static const uint8_t empty[] = { 0x00 };
    uint8_t out[32];
    memset(out, 0, sizeof out);
    CHECK_EQ_INT(pnet_lz4_decode(below, sizeof below, out + 8, out + 32, out + 8), -1);
    CHECK_EQ_INT(pnet_lz4_decode(below, sizeof below, out + 8, out + 32, out + 7), 10);   /* one byte of window */
    CHECK_EQ_INT(pnet_lz4_decode(zero, sizeof zero, out + 8, out + 32, out), -1);
    CHECK_EQ_INT(pnet_lz4_decode(empty, 1, out, out + 32, out), 0);
    CHECK_EQ_INT(pnet_lz4_decode(empty, 0, out, out + 32, out), -1);
    CHECK_EQ_INT(pnet_lz4_decode(below, sizeof below, out + 8, out + 12, out + 7), -1);   /* past dst_end */
}

int main(void) {
    RUN(decodes_liblz4_blocks);
    RUN(decodes_liblz4_linked_blocks);
    RUN(its_blocks_decode_with_liblz4);
    RUN(the_encoder_is_the_68k_model_byte_for_byte);
    RUN(the_cap_is_exact);
    RUN(a_block_as_long_as_its_frame_is_not_used);
    RUN(incompressible_frames_never_shrink);
    RUN(malformed_blocks_never_write_out_of_bounds);
    RUN(a_match_below_the_window_or_at_offset_0_is_refused);
    return REPORT();
}
```

- [ ] **Step 4: Run it to see it fail.**

Run: `wifi-floppy/firmware/test/run.sh test_pnet_lz4.c`
Expected: compiler error `'../src/pnet_lz4.h' file not found`, then `COMPILE FAIL: test_pnet_lz4.c`, exit 1.

- [ ] **Step 5: Write the header.** Create `wifi-floppy/firmware/src/pnet_lz4.h`:

```c
#ifndef PNET_LZ4_H
#define PNET_LZ4_H
/*
 * PaulaNET LZ4 (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md): the LZ4 block codec the board uses in
 * both directions. Ours (MIT), written from the LZ4 block format description. The encoder is the algorithm of
 * m68k/lz4/lz4_68k.c (lz4_encode_linked_ref): the same bytes and table updates from the same arguments
 * (test/test_pnet_lz4.c), so the driver's 68000 encoder and the board's encode alike. Standard LZ4 block (liblz4
 * LZ4_compress_default compatible, little-endian offsets), no frame header, no checksum: the batch checksum covers it.
 *
 * LINKED: a frame's matches may reach back into the earlier frames of the same batch, which sit directly before it in
 * one buffer, `window` being that buffer's start. Never across batches.
 *
 * Pure C, byte access only: tools/paulanet-driver/test.sh also builds it for the 68000.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "pnet_frame.h"

#define PNET_LZ4_WINDOW        16128u  /* one batch's frames decoded back to back, either direction (spec §4-§5) */
#define PNET_LZ4_TABLE_ENTRIES 4096u   /* the board's hash table: 8 KB, in PSRAM (spec §5) */
#define PNET_LZ4_BLOCK_MAX     1540u   /* the longest block taken for one frame: >= 1518 + 1518/255 + 16 */

/* The block for src[0..n), its matches reaching back to `window` (window <= src; window == src for a frame alone).
 * The table holds `entries` 16-bit entries (a power of two, 256..16384); it needs no clearing and any contents are
 * valid -- clear it for bytes that do not depend on what came before. Returns the block's size (1..cap), or 0 if the
 * block would be longer than cap, or n > 65535, or window > src, or (src - window) + n > 65536. Nothing is written at
 * or past dst + cap. */
size_t pnet_lz4_encode_linked(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *table,
                              unsigned entries, const uint8_t *window);
/* Decodes the block src[0..n) to dst. Returns the decoded length, or -1: malformed, a match from before `window` or at
 * offset 0, or output past dst_end. Never writes outside [dst, dst_end), never reads outside [src, src + n), never
 * reads a match from outside [window, the output so far). src must not overlap [window, dst_end). The 1-byte block
 * 0x00 decodes to 0 bytes; an empty block is malformed. */
long pnet_lz4_decode(const uint8_t *src, size_t n, uint8_t *dst, uint8_t *dst_end, const uint8_t *window);
#endif
```

- [ ] **Step 6: Write the codec.** Create `wifi-floppy/firmware/src/pnet_lz4.c`:

```c
/* PaulaNET LZ4 (pnet_lz4.h). Ours, MIT: written from the LZ4 block format description; the encoder is
 * m68k/lz4/lz4_68k.c's algorithm, kept bit-exact with it (test/test_pnet_lz4.c):
 *   - positions count from `window`; the 4 bytes b0 b1 b2 b3 at one are X = b0:b2, Y = b1:b3 and the hash is bits 1..
 *     of 2X + Y, masked to the table;
 *   - the table holds positions XOR 0x8000 and is never trusted: an entry at or past the current position is ignored,
 *     any other is a candidate whose 4 bytes are compared;
 *   - skip strength 6 (the step grows every 64 misses); a match extends forwards to 5 bytes before the end and back
 *     into the pending literals; the LZ4 end rules (a match starts 12+ bytes before the end, the last 5 are literals).
 */
#include "pnet_lz4.h"
#include <string.h>

static size_t extlen(size_t x) { return x < 15u ? 0u : (x - 15u) / 255u + 1u; }

static size_t put_len(uint8_t *d, size_t o, size_t len) {    /* the 255-run after a nibble of 15 */
    while (len >= 255u) { d[o++] = 255u; len -= 255u; }
    d[o++] = (uint8_t)len;
    return o;
}

size_t pnet_lz4_encode_linked(const uint8_t *src, size_t n, uint8_t *dst, size_t cap, uint16_t *tab,
                              unsigned entries, const uint8_t *base) {
    if (n > 65535u || base > src || (size_t)(src - base) + n > 65536u) return 0;
    const size_t p0 = (size_t)(src - base), end = p0 + n;
    const unsigned mask = (entries - 1u) << 1;
    size_t pos = p0, anchor = p0, o = 0;
    unsigned long misses = 0;
    if (n >= 13u) {
        const size_t mflimit = end - 12u, mend = end - 5u;
        while (pos <= mflimit) {
            const uint8_t *p = base + pos;
            const unsigned X = (unsigned)p[0] << 8 | p[2], Y = (unsigned)p[1] << 8 | p[3];
            const unsigned h = ((2u * X + Y) & mask) >> 1;
            size_t ref = (size_t)(tab[h] ^ 0x8000u);
            tab[h] = (uint16_t)(pos ^ 0x8000u);
            if (ref >= pos || base[ref] != p[0] || base[ref + 1] != p[1] || base[ref + 2] != p[2] ||
                base[ref + 3] != p[3]) {
                pos += 1u + (misses++ >> 6);
                continue;
            }
            size_t len = 4;
            while (pos + len < mend && base[ref + len] == base[pos + len]) len++;
            while (pos > anchor && ref > 0 && base[pos - 1] == base[ref - 1]) { pos--; ref--; len++; }
            const size_t lit = pos - anchor, ml = len - 4u;
            if (3u + lit + extlen(lit) + extlen(ml) > cap - o) return 0;
            const size_t tok = o++;
            dst[tok] = (uint8_t)((lit >= 15u ? 15u : lit) << 4 | (ml >= 15u ? 15u : ml));
            if (lit >= 15u) o = put_len(dst, o, lit - 15u);
            for (size_t i = 0; i < lit; i++) dst[o++] = base[anchor + i];
            const size_t off = pos - ref;
            dst[o++] = (uint8_t)off;                       /* little-endian, as the format says */
            dst[o++] = (uint8_t)(off >> 8);
            if (ml >= 15u) o = put_len(dst, o, ml - 15u);
            pos += len;
            anchor = pos;
            misses = 0;
        }
    }
    const size_t lit = end - anchor;
    if (1u + lit + extlen(lit) > cap - o) return 0;
    dst[o++] = (uint8_t)((lit >= 15u ? 15u : lit) << 4);
    if (lit >= 15u) o = put_len(dst, o, lit - 15u);
    for (size_t i = 0; i < lit; i++) dst[o++] = base[anchor + i];
    return o;
}

long pnet_lz4_decode(const uint8_t *src, size_t n, uint8_t *dst, uint8_t *dst_end, const uint8_t *window) {
    if (n == 0 || dst_end < dst || window > dst) return -1;
    const uint8_t *ip = src;
    const uint8_t *const iend = src + n;
    uint8_t *op = dst;
    for (;;) {
        const unsigned token = *ip++;
        size_t lit = token >> 4;
        if (lit == 15u) {
            unsigned b;
            do {
                if (ip == iend) return -1;
                b = *ip++;
                lit += b;
            } while (b == 255u);
        }
        if (lit > (size_t)(iend - ip) || lit > (size_t)(dst_end - op)) return -1;
        memcpy(op, ip, lit);
        op += lit;
        ip += lit;
        if (ip == iend) return (long)(op - dst);           /* the last sequence: literals only */
        if (iend - ip < 2) return -1;
        const size_t off = (size_t)ip[0] | (size_t)ip[1] << 8;
        ip += 2;
        if (off == 0 || off > (size_t)(op - window)) return -1;
        size_t ml = (token & 15u) + 4u;
        if ((token & 15u) == 15u) {
            unsigned b;
            do {
                if (ip == iend) return -1;
                b = *ip++;
                ml += b;
            } while (b == 255u);
        }
        if (ml > (size_t)(dst_end - op)) return -1;
        const uint8_t *m = op - off;
        while (ml--) *op++ = *m++;                         /* may overlap its own output: byte by byte */
        if (ip == iend) return -1;                         /* a block never ends on a match */
    }
}
```

- [ ] **Step 7: Run the tests to see them pass.**

Run: `wifi-floppy/firmware/test/run.sh test_pnet_lz4.c`
Expected: the nine `- <name>` lines, then `test_pnet_lz4.c: <N> checks, 0 failed`; exit 0.

- [ ] **Step 8: Run the whole host suite.**

Run: `wifi-floppy/firmware/test/run.sh`
Expected: every `test_*.c: ... 0 failed`, no `FAIL`, exit 0.

- [ ] **Step 9: Commit.**

```bash
git add wifi-floppy/firmware/src/pnet_lz4.h wifi-floppy/firmware/src/pnet_lz4.c \
        wifi-floppy/firmware/test/lz4_corpus.h wifi-floppy/firmware/test/test_pnet_lz4.c \
        wifi-floppy/firmware/test/run.sh .github/workflows/firmware.yml
git commit -m "fw: pnet_lz4, the board's LZ4 block codec (linked; bit-exact with the 68k encoder's model)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 3: Amiga -> board: linked LZ4 frames, the driver's word, status byte 155

**Files:**
- Modify: `wifi-floppy/firmware/src/pnet_frame.h` (constants, `PNET_E_LZ4`), `wifi-floppy/firmware/src/pnet_frame.c` (`pnet_err_text`)
- Modify: `wifi-floppy/firmware/src/pnet_lz4.h`, `wifi-floppy/firmware/src/pnet_lz4.c` (the iterator)
- Modify: `wifi-floppy/firmware/src/pnet_link.h`, `wifi-floppy/firmware/src/pnet_link.c`
- Modify: `wifi-floppy/firmware/src/pnet_status.h`, `wifi-floppy/firmware/src/pnet_status.c`
- Test: `wifi-floppy/firmware/test/test_pnet_link.c`, `test_pnet_status.c`, `test_pnet_frame.c`

**Interfaces:**
- Consumes: `pnet_lz4_encode_linked`, `pnet_lz4_decode`, `PNET_LZ4_*` (Task 2); `lc_frame` (Task 2).
- Produces:
  - `pnet_frame.h`: `#define PNET_DRIVER_LZ4 0x10u`, `#define PNET_SIZE_LZ4 0x4000u`, `PNET_E_LZ4` (text `"lz4"`).
  - `pnet_lz4.h`: `typedef struct { uint8_t *win; size_t pos; uint8_t *scratch; } pnet_lz4_win_t;`,
    `#define PNET_LZ4_BROKEN SIZE_MAX`,
    `pnet_err_t pnet_lz4_iter_next(pnet_frame_iter_t *it, pnet_lz4_win_t *w, uint8_t *out, size_t cap, uint16_t *len, bool *was_lz4);`
  - `pnet_link.h`: fields `bool amiga_lz4; uint32_t lz4_in, lz4_bad;` in `pnet_link_t`;
    `pnet_take_t pnet_link_take_lz4(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx, uint8_t *win, uint8_t *scratch);`
    (`pnet_link_take` = it with `NULL, NULL`); `void pnet_link_shrink(pnet_link_t *s, unsigned n);`
  - `pnet_status.h`: `#define PNET_ST_RESERVED 155u`, `PNET_ST_LZ4_TO_AMIGA 1u`, `PNET_ST_LZ4_FROM_AMIGA 2u`;
    field `uint8_t lz4;` at the end of `pnet_status_t`.

- [ ] **Step 1: Write the failing link tests.** In `wifi-floppy/firmware/test/test_pnet_link.c`, add after
`#include <string.h>`:

```c
#include "lz4_corpus.h"
#include "../src/pnet_lz4.h"
```

and add the following just above `int main(void)` (it uses the file's `hdr`, `tx_ring` and `g_pay`):

```c
/* An Amiga -> board payload as webadf's driver variant writes it (spec 2026-10-18 §2): per frame RLE ('r', 0x8000|n),
 * raw LZ4 ('z', 0x4000|n, padded to even) or MFM-wrapped LZ4 ('w', 0xC000|n), every frame laid back to back in the
 * encoder's window so that the LZ4 ones link to the earlier frames. */
static size_t lz4_payload(uint8_t *out, uint8_t (*f)[PNET_ETH_MTU], const uint16_t *lens, const char *how, unsigned n) {
    static uint8_t win[65536], blk[2048];
    static uint16_t table[PNET_LZ4_TABLE_ENTRIES];
    memset(table, 0, sizeof table);
    const uint8_t ph[2] = { (uint8_t)n, 0 };
    uint16_t last = 0;
    size_t pos = pnet_mfm_encode(ph, 2, out, &last), at = 0;
    for (unsigned i = 0; i < n; i++) {
        memcpy(win + at, f[i], lens[i]);
        uint16_t field;
        size_t wire;
        if (how[i] == 'r') {
            wire = pnet_rle_encode(f[i], lens[i], out + pos + 8);
            field = (uint16_t)(0x8000u | wire);
        } else {
            const size_t z = pnet_lz4_encode_linked(win + at, lens[i], blk, sizeof blk, table, PNET_LZ4_TABLE_ENTRIES, win);
            if (how[i] == 'z') {
                memcpy(out + pos + 8, blk, z);
                if (z & 1u) out[pos + 8 + z] = 0;
                wire = z + (z & 1u);
                field = (uint16_t)(PNET_SIZE_LZ4 | z);
            } else {
                uint16_t l2 = 0;
                pnet_mfm_encode(blk, z, out + pos + 8, &l2);
                wire = 2u * z;
                field = (uint16_t)(0x8000u | PNET_SIZE_LZ4 | z);
            }
        }
        const uint8_t ch[4] = { (uint8_t)(field >> 8), (uint8_t)field, (uint8_t)(lens[i] >> 8), (uint8_t)lens[i] };
        last = 0;
        pnet_mfm_encode(ch, 4, out + pos, &last);
        pos += 8u + wire;
        at += lens[i];
    }
    return pos;
}

static uint8_t g_lf[16][PNET_ETH_MTU];
static uint8_t g_win[PNET_LZ4_WINDOW], g_scr[PNET_LZ4_BLOCK_MAX];

static pnet_hdr_t lz4_hdr(uint8_t amiga, bool word) {
    pnet_hdr_t h = hdr(amiga, 0x7F);
    h.compressed = (uint8_t)(PNET_COMPRESSED_MFM | PNET_FROM_DRIVER | (word ? PNET_DRIVER_LZ4 : 0u));
    return h;
}

/* Review Focus, mixed batches: RLE frames sit in the window too, so the LZ4 frames after them decode exactly. */
static void an_lz4_batch_is_decoded_linked_into_the_ring(void) {
    static const int kinds[5] = { LC_TEXT, LC_TEXT, LC_RANDOM, LC_HTML, LC_TEXT };
    static const uint16_t lens[5] = { 900, 1100, 700, 1300, 500 };
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    for (unsigned i = 0; i < 5; i++) lc_frame(g_lf[i], lens[i], kinds[i], 40u + i);
    pnet_hdr_t h = lz4_hdr(0x00, true);
    h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rzrwz", 5);
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
    CHECK_EQ_INT(pnet_ring_count(&tx), 5);
    for (unsigned i = 0; i < 5; i++) {
        uint16_t len = 0;
        const uint8_t *f = pnet_ring_peek(&tx, i, &len);
        CHECK(f != NULL && len == lens[i] && memcmp(f, g_lf[i], len) == 0, "the frame, whole");
    }
    CHECK_EQ_INT(s.lz4_in, 3);
    CHECK_EQ_INT(s.lz4_bad, 0);
    CHECK_EQ_INT(s.malformed, 0);
    CHECK(s.amiga_lz4, "the driver asked for LZ4");
}

static void lz4_frames_need_the_drivers_word_and_the_window(void) {
    static const uint16_t lens[3] = { 900, 1100, 700 };
    for (unsigned i = 0; i < 3; i++) lc_frame(g_lf[i], lens[i], LC_TEXT, 60u + i);
    for (unsigned k = 0; k < 2; k++) {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 32);
        pnet_hdr_t h = lz4_hdr(0x00, k == 1);           /* k 0: no 0x10; k 1: 0x10 but no window (pnet_link_take) */
        h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rzz", 3);
        if (k == 0) CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
        else CHECK_EQ_INT(pnet_link_take(&s, &h, g_pay, &tx), PNET_TAKE_NEW);
        CHECK_EQ_INT(pnet_ring_count(&tx), 1);          /* the RLE frame; the LZ4 ones are unreadable */
        CHECK_EQ_INT(s.malformed, 2);
        CHECK_EQ_INT(s.lz4_in, 0);
    }
}

/* Review Focus, the driver swap: the word follows the latest header, a resend's included. */
static void the_drivers_word_follows_the_latest_header(void) {
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    tx_ring(&tx, 32);
    CHECK(!s.amiga_lz4, "nothing heard yet: no LZ4");
    pnet_hdr_t h = lz4_hdr(0x00, true);
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
    CHECK(s.amiga_lz4, "our driver");
    h = lz4_hdr(0x00, false);                           /* the same counter: a resend, from Rob's driver now */
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_DUP);
    CHECK(!s.amiga_lz4, "Rob's driver: MFM from now on");
    h = lz4_hdr(0x01, true);
    CHECK_EQ_INT(pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr), PNET_TAKE_NEW);
    CHECK(s.amiga_lz4, "ours again");
}

/* Review Focus, sizes at the edges: frames fill the window to exactly 16,128 bytes and an LZ4 frame still links; one
 * frame past it is decoded straight into its slot, and an LZ4 frame after it is refused (and counted). */
static void the_window_ends_at_16128_bytes(void) {
    uint16_t lens[12];
    for (unsigned i = 0; i < 11; i++) { lens[i] = PNET_ETH_MTU; lc_frame(g_lf[i], PNET_ETH_MTU, LC_ZEROS, 0); }
    lens[10] = 948;                                     /* 10 x 1,518 + 948 = 16,128 */
    lc_frame(g_lf[10], 948, LC_ZEROS, 0);
    {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 32);
        pnet_hdr_t h = lz4_hdr(0x00, true);
        h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rrrrrrrrrrz", 11);
        pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr);
        CHECK_EQ_INT(pnet_ring_count(&tx), 11);
        CHECK_EQ_INT(s.lz4_in, 1);
        CHECK_EQ_INT(s.malformed, 0);
    }
    lens[10] = PNET_ETH_MTU;                            /* 11 x 1,518 = 16,698: the 11th does not fit */
    lc_frame(g_lf[10], PNET_ETH_MTU, LC_ZEROS, 0);
    lens[11] = 600;
    lc_frame(g_lf[11], 600, LC_TEXT, 5);
    {
        pnet_link_t s; pnet_ring_t tx;
        pnet_link_init(&s);
        tx_ring(&tx, 32);
        pnet_hdr_t h = lz4_hdr(0x00, true);
        h.compressed_size = (uint16_t)lz4_payload(g_pay, g_lf, lens, "rrrrrrrrrrrz", 12);
        pnet_link_take_lz4(&s, &h, g_pay, &tx, g_win, g_scr);
        CHECK_EQ_INT(pnet_ring_count(&tx), 11);
        CHECK_EQ_INT(s.lz4_bad, 1);
        CHECK_EQ_INT(s.malformed, 1);
    }
}

/* Review Focus, malformed LZ4: damaged batches (blocks and size words alike) never write past the window, the scratch
 * or a ring slot; every refusal is counted. */
static void malformed_lz4_never_overruns_the_board(void) {
    static struct {
        uint8_t win[PNET_LZ4_WINDOW]; uint8_t g1[256];
        uint8_t scr[PNET_LZ4_BLOCK_MAX]; uint8_t g2[256];
        uint8_t ring[8 * PNET_RING_SLOT]; uint8_t g3[256];
    } m;
    static const uint16_t lens[5] = { 900, 1100, 700, 1300, 500 };
    static const char *const hows[3] = { "zwzwz", "rzwrz", "wwwww" };
    memset(&m, 0xA5, sizeof m);
    pnet_link_t s; pnet_ring_t tx;
    pnet_link_init(&s);
    CHECK(pnet_ring_init(&tx, m.ring, 8), "ring");
    uint32_t r = 777;
    for (unsigned t = 0; t < 3000; t++) {
        for (unsigned i = 0; i < 5; i++) lc_frame(g_lf[i], lens[i], (int)(t + i) % 2 ? LC_HTML : LC_TEXT, t * 5u + i);
        pnet_hdr_t h = lz4_hdr((uint8_t)t, true);
        const size_t len = lz4_payload(g_pay, g_lf, lens, hows[t % 3u], 5);
        h.compressed_size = (uint16_t)len;
        const unsigned hits = 1u + lc_next(&r) % 4u;
        for (unsigned k = 0; k < hits; k++) g_pay[4u + lc_next(&r) % (len - 4u)] = (uint8_t)lc_next(&r);
        pnet_link_take_lz4(&s, &h, g_pay, &tx, m.win, m.scr);
        for (uint32_t i = 0; i < pnet_ring_count(&tx); i++) {
            uint16_t l = 0;
            (void)pnet_ring_peek(&tx, i, &l);
            CHECK(l >= 1 && l <= PNET_RING_MTU, "a committed frame is 1..MTU bytes");
        }
        pnet_ring_drop(&tx, pnet_ring_count(&tx));
    }
    unsigned touched = 0;
    for (unsigned i = 0; i < 256; i++) touched += (m.g1[i] != 0xA5) + (m.g2[i] != 0xA5) + (m.g3[i] != 0xA5);
    CHECK_EQ_INT(touched, 0);
    CHECK(s.lz4_bad + s.malformed > 0, "the damage was seen and counted");
    CHECK(s.queued > 0, "and undamaged frames still went through");
}
```

and in `main()` add, before `return REPORT();`:

```c
    RUN(an_lz4_batch_is_decoded_linked_into_the_ring);
    RUN(lz4_frames_need_the_drivers_word_and_the_window);
    RUN(the_drivers_word_follows_the_latest_header);
    RUN(the_window_ends_at_16128_bytes);
    RUN(malformed_lz4_never_overruns_the_board);
```

- [ ] **Step 2: Write the failing status and error-text tests.** In `wifi-floppy/firmware/test/test_pnet_status.c`
add before `int main(void)`:

```c
/* Spec 2026-10-18 §3: LiveStatus.reserved (byte 155) tells the driver the board speaks LZ4. */
static void byte_155_says_the_board_speaks_lz4(void) {
    pnet_status_t st = BENCH;
    uint8_t p[PNET_STATUS_BYTES];
    pnet_status_payload(&st, p);
    CHECK_EQ_INT(p[155], 0);                            /* 1.15.0's byte when nothing is set */
    st.lz4 = PNET_ST_LZ4_TO_AMIGA | PNET_ST_LZ4_FROM_AMIGA;
    pnet_status_payload(&st, p);
    CHECK_EQ_INT(p[PNET_ST_RESERVED], 3);
    CHECK_EQ_INT(PNET_ST_RESERVED, 155);
    static uint8_t loop[PNET_STATUS_LOOP_BYTES];
    CHECK_EQ_INT(pnet_build_status(loop, sizeof loop, 0, 0, &st), PNET_STATUS_LOOP_BYTES);   /* still fits its period */
}
```

and `RUN(byte_155_says_the_board_speaks_lz4);` in its `main()`. In `test_pnet_frame.c`'s
`every_error_has_its_own_text`, add `CHECK(strcmp(pnet_err_text(PNET_E_LZ4), "lz4") == 0, "lz4 text");`.

- [ ] **Step 3: Run them to see them fail.**

Run: `wifi-floppy/firmware/test/run.sh test_pnet_link.c test_pnet_status.c test_pnet_frame.c`
Expected: `COMPILE FAIL` for all three (`PNET_SIZE_LZ4`, `pnet_link_take_lz4`, `PNET_ST_RESERVED`, `PNET_E_LZ4` undeclared).

- [ ] **Step 4: The wire constants and the error code.** In `wifi-floppy/firmware/src/pnet_frame.h`, after
`#define PNET_COMPRESSED_MFM  2u` add:

```c
#define PNET_DRIVER_LZ4      0x10u   /* DataHeader.compressed from webadf's driver: "I decode LZ4" (spec 2026-10-18 §3) */
#define PNET_SIZE_LZ4        0x4000u /* a frame's size word: an LZ4 block of (size & 0x3FFF) bytes (spec §2); with bit
                                      * 15 its bytes are MFM-encoded (always toward the Amiga), without it raw */
```

replace `    PNET_E_RANGE,      /* board: the capture holds a gap over PNET_RX_MAX_CELLS (clamped cells) */` with

```c
    PNET_E_RANGE,      /* board: the capture holds a gap over PNET_RX_MAX_CELLS (clamped cells) */
    PNET_E_LZ4,        /* an LZ4 frame that does not decode, or that the batch may not carry (pnet_lz4_iter_next) */
```

and in `pnet_frame.c` replace `"frames", "frame size", "rle", "full", "no sync", "out of range",` with
`"frames", "frame size", "rle", "full", "no sync", "out of range", "lz4",`.

- [ ] **Step 5: The linked iterator.** In `wifi-floppy/firmware/src/pnet_lz4.h`, before the final `#endif`, add:

```c
/* The window of one batch, either direction: every frame is decoded into win + pos, back to back, whatever its
 * encoding, so the LZ4 frames may link to the earlier ones. pos past PNET_LZ4_WINDOW (PNET_LZ4_BROKEN) once a frame did
 * not fit: no later LZ4 frame of the batch can be decoded. scratch: PNET_LZ4_BLOCK_MAX bytes, an MFM-wrapped block. */
typedef struct { uint8_t *win; size_t pos; uint8_t *scratch; } pnet_lz4_win_t;
#define PNET_LZ4_BROKEN SIZE_MAX
/* As pnet_frame_iter_next, linked through w: the frame is decoded into the window and copied to out[0..cap). An LZ4
 * frame (size bit 14) decodes against the window -- raw or MFM-wrapped toward the board, MFM-wrapped only toward the
 * Amiga; *was_lz4 says it was one. PNET_E_LZ4: an LZ4 frame that does not decode to its original size, is over
 * PNET_LZ4_BLOCK_MAX, or does not fit the window. Any error leaves it->i where it was. */
pnet_err_t pnet_lz4_iter_next(pnet_frame_iter_t *it, pnet_lz4_win_t *w, uint8_t *out, size_t cap, uint16_t *len,
                              bool *was_lz4);
```

and append to `wifi-floppy/firmware/src/pnet_lz4.c` (with `#include "pnet_mfm.h"` added after `#include "pnet_lz4.h"`):

```c
pnet_err_t pnet_lz4_iter_next(pnet_frame_iter_t *it, pnet_lz4_win_t *w, uint8_t *out, size_t cap, uint16_t *len,
                              bool *was_lz4) {
    *was_lz4 = false;
    if (it->i >= it->count || 8u > it->len - it->pos) return PNET_E_FRAMES;
    uint8_t ch[4];
    pnet_mfm_decode(it->p + it->pos, 4, ch);
    const uint16_t field = (uint16_t)(ch[0] << 8 | ch[1]), os = (uint16_t)(ch[2] << 8 | ch[3]);
    const bool fits = w->pos <= PNET_LZ4_WINDOW && os <= PNET_LZ4_WINDOW - w->pos;
    if (!(field & PNET_SIZE_LZ4)) {                     /* RLE or MFM: the plain iterator, into the window */
        if (!fits || os > cap) {
            w->pos = PNET_LZ4_BROKEN;                   /* outside the window: nothing later may link to it */
            return pnet_frame_iter_next(it, out, cap, len);
        }
        uint8_t *at = w->win + w->pos;
        const pnet_err_t e = pnet_frame_iter_next(it, at, PNET_LZ4_WINDOW - w->pos, len);
        if (e != PNET_OK) return e;
        memcpy(out, at, *len);
        w->pos += *len;
        return PNET_OK;
    }
    const bool wrapped = (field & 0x8000u) != 0;
    if (it->dir == PNET_TO_AMIGA && !wrapped) return PNET_E_LZ4;   /* never raw toward the Amiga (HANDOFF 3bu) */
    const size_t at = it->pos + 8u, blk = field & 0x3FFFu, wire = wrapped ? 2u * blk : blk;
    if (wire > it->len - at) return PNET_E_FRAMES;
    if (os == 0 || os > PNET_ETH_MTU) return PNET_E_FRAME_SIZE;
    if (os > cap) return PNET_E_FULL;
    if (blk == 0 || blk > PNET_LZ4_BLOCK_MAX || !fits) return PNET_E_LZ4;
    const uint8_t *src = it->p + at;
    if (wrapped) {
        pnet_mfm_decode(src, blk, w->scratch);
        src = w->scratch;
    }
    uint8_t *dst = w->win + w->pos;
    if (pnet_lz4_decode(src, blk, dst, dst + os, w->win) != (long)os) return PNET_E_LZ4;
    memcpy(out, dst, os);
    w->pos += os;
    *len = os;
    *was_lz4 = true;
    const size_t next = at + wire + (wire & 1u);
    it->pos = next > it->len ? it->len : next;
    it->i++;
    return PNET_OK;
}
```

- [ ] **Step 6: The link takes linked batches and tracks the word.** In `wifi-floppy/firmware/src/pnet_link.h`, in
`pnet_link_t` after `uint32_t malformed;   /* ...dropped: a malformed frame, and every frame after it in its batch */`
add:

```c
    uint32_t lz4_in;      /* LZ4 (spec 2026-10-18): the Amiga's frames that came LZ4 */
    uint32_t lz4_bad;     /* ...refused (PNET_E_LZ4), counted in malformed too */
    bool     amiga_lz4;   /* the latest checked header from the Amiga carried PNET_DRIVER_LZ4 (a resend's counts) */
```

replace the `pnet_link_take` declaration and its comment with:

```c
/* The Amiga's batch, its header already checked (pnet_parse_hdr_from_amiga); `payload` is its
 * h->compressed_size bytes. DUP (counted, nothing queued) when its counter is the last taken;
 * otherwise NEW, always -- see above. Never claims a slot the ring does not have. Every header, a resend's too,
 * sets amiga_lz4 from its PNET_DRIVER_LZ4 bit (spec 2026-10-18 §3). pnet_link_take is pnet_link_take_lz4 with no
 * window: LZ4 frames are then unreadable. */
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx);
/* As pnet_link_take, LZ4-aware: a batch carrying PNET_DRIVER_LZ4 is decoded frame by frame into win
 * (PNET_LZ4_WINDOW bytes), back to back, its LZ4 frames linked to the earlier ones, and each frame copied into its
 * slot; scratch (PNET_LZ4_BLOCK_MAX bytes) takes an MFM-wrapped block. A batch without the bit decodes as before. */
pnet_take_t pnet_link_take_lz4(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx,
                               uint8_t *win, uint8_t *scratch);
/* The batch out holds n frames from now on, n below nframes only (never more, never 0): its rebuild without LZ4
 * (the driver stopped asking) fits fewer; the rest stay in the ring for the next batch. */
void pnet_link_shrink(pnet_link_t *s, unsigned n);
```

and in its `pnet_link_fit` comment append ` main.c packs with pnet_pack (LZ4, 1.16.0); without LZ4 that picks the
same count (test_pnet_pack.c).`

In `wifi-floppy/firmware/src/pnet_link.c`, add `#include "pnet_lz4.h"` after `#include "pnet_status.h"`, and replace
the whole `pnet_link_take` function with:

```c
pnet_take_t pnet_link_take(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx) {
    return pnet_link_take_lz4(s, h, payload, tx, NULL, NULL);
}

pnet_take_t pnet_link_take_lz4(pnet_link_t *s, const pnet_hdr_t *h, const uint8_t *payload, pnet_ring_t *tx,
                               uint8_t *win, uint8_t *scratch) {
    s->amiga_lz4 = (h->compressed & PNET_DRIVER_LZ4) != 0;
    if (!pnet_link_is_new(s, h)) { s->dup++; return PNET_TAKE_DUP; }
    s->last_amiga = h->amiga_ctr;
    s->fresh++;
    pnet_frame_iter_t it;
    if (pnet_frame_iter_init(&it, payload, h->compressed_size, PNET_TO_BOARD) != PNET_OK) {
        s->malformed++;                                 /* a 1..3-byte payload: one unreadable frame */
        return PNET_TAKE_NEW;
    }
    pnet_lz4_win_t w = { win, 0, scratch };
    const bool linked = s->amiga_lz4 && win != NULL && scratch != NULL;
    while (it.i < it.count) {
        if (pnet_ring_space(tx) == 0u) { s->over += it.count - it.i; break; }
        uint8_t *slot = pnet_ring_claim(tx);
        uint16_t len = 0;
        bool z = false;
        const pnet_err_t e = linked ? pnet_lz4_iter_next(&it, &w, slot, PNET_RING_MTU, &len, &z)
                                    : pnet_frame_iter_next(&it, slot, PNET_RING_MTU, &len);
        if (e != PNET_OK) {
            if (e == PNET_E_LZ4) s->lz4_bad++;
            s->malformed += it.count - it.i;            /* this frame and the rest: unreadable */
            break;
        }
        pnet_ring_commit(tx, len);
        s->queued++;
        if (z) s->lz4_in++;
    }
    return PNET_TAKE_NEW;
}

void pnet_link_shrink(pnet_link_t *s, unsigned n) {
    if (s->backup && n != 0u && n < s->nframes) s->nframes = (uint8_t)n;
}
```

- [ ] **Step 7: Status byte 155.** In `wifi-floppy/firmware/src/pnet_status.h`: in the layout comment replace
`| 154 link | 155 0` with `| 154 link | 155 LZ4 bits (fw 1.16.0; 0 before)`; after `#define PNET_ST_LINK            154u`
add

```c
#define PNET_ST_RESERVED        155u     /* LiveStatus.reserved: Rob's driver ignores it (spec 2026-10-18 §3) */
#define PNET_ST_LZ4_TO_AMIGA    1u       /* ...bit 0: the board sends LZ4 to a driver that asks (0x10) */
#define PNET_ST_LZ4_FROM_AMIGA  2u       /* ...bit 1: the board accepts LZ4 frames from the Amiga */
```

and in `pnet_status_t` after `uint8_t ver_major, ver_minor;` add
`    uint8_t lz4;                         /* PNET_ST_LZ4_* bits for byte 155; 0 = 1.15.0's byte */`.
In `pnet_status.c`'s `pnet_status_payload`, after `out[PNET_ST_LINK] = st->link;` add
`    out[PNET_ST_RESERVED] = st->lz4;`.

- [ ] **Step 8: Run the tests to see them pass.**

Run: `wifi-floppy/firmware/test/run.sh test_pnet_link.c test_pnet_status.c test_pnet_frame.c test_pnet_lz4.c`
Expected: four `...: <N> checks, 0 failed` lines; exit 0.

- [ ] **Step 9: Run the whole host suite and netloop's host tests** (netloop builds `pnet_frame.c` and
`pnet_status.c` for its own tests).

Run: `wifi-floppy/firmware/test/run.sh && tools/netloop/build.sh test`
Expected: no `FAIL`; both exit 0.

- [ ] **Step 10: Commit.**

```bash
git add wifi-floppy/firmware/src/pnet_frame.h wifi-floppy/firmware/src/pnet_frame.c \
        wifi-floppy/firmware/src/pnet_lz4.h wifi-floppy/firmware/src/pnet_lz4.c \
        wifi-floppy/firmware/src/pnet_link.h wifi-floppy/firmware/src/pnet_link.c \
        wifi-floppy/firmware/src/pnet_status.h wifi-floppy/firmware/src/pnet_status.c \
        wifi-floppy/firmware/test/test_pnet_link.c wifi-floppy/firmware/test/test_pnet_status.c \
        wifi-floppy/firmware/test/test_pnet_frame.c
git commit -m "fw: the Amiga's LZ4 frames decode linked; the driver's 0x10 word; status byte 155

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 4: Board -> Amiga: packing by real size, LZ4 per frame, the firmware wired up

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_pack.h`, `wifi-floppy/firmware/src/pnet_pack.c`
- Create: `wifi-floppy/firmware/test/test_pnet_pack.c`
- Modify: `wifi-floppy/firmware/src/main.c` (includes ~76, L2 statics ~3125, `pnet_take_capture` ~3224,
  `pnet_prepare_echo` ~3282-3310, `pnet_serve_status` ~3410, `pnet_l2_log` ~3540-3570, boot ~3857)
- Modify: `wifi-floppy/firmware/CMakeLists.txt:122`

**Interfaces:**
- Consumes: Task 2 codec; Task 3 `pnet_lz4_iter_next`, `pnet_link_take_lz4`, `pnet_link_shrink`, `amiga_lz4`,
  `lz4_in`, `lz4_bad`, `PNET_ST_LZ4_*`, `pnet_status_t.lz4`.
- Produces (`pnet_pack.h`):
  - `typedef struct { const uint8_t *data; uint16_t len; const uint8_t *lz4; uint16_t lz4_len; } pnet_out_t;`
  - `typedef struct { uint8_t *win; uint8_t *blk; uint16_t *table; unsigned entries; } pnet_pack_mem_t;`
  - `typedef struct { pnet_out_t f[PNET_MAX_FRAMES]; unsigned n; unsigned lz4; uint32_t wire; uint32_t saved; } pnet_pack_t;`
  - `unsigned pnet_pack(pnet_pack_t *pk, const pnet_pack_mem_t *m, bool lz4, const pnet_frame_ref_t *in, unsigned avail, size_t cap);`
  - `size_t pnet_out_payload_bytes(const pnet_out_t *f, unsigned n);`
  - `size_t pnet_build_to_amiga_out(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, uint8_t flags, const pnet_out_t *f, unsigned n);`
  - serial lines `pnet: l2 lz4 out lz4 N mfm N wire N saved N us max N avg N budget N unenc N` and `pnet: l2 lz4 in lz4 N bad N driver lz4|stock` (final-review fix: the pack time moved to the out line, M4; `budget`/`unenc` count batches that spent `PNET_PACK_LZ4_BUDGET_US` and their frames sent MFM unencoded, I1).

- [ ] **Step 1: Write the failing tests.** Create `wifi-floppy/firmware/test/test_pnet_pack.c`:

```c
/*
 * PaulaNET LZ4, board -> Amiga (spec 2026-10-18 §2, §5): which frames make a batch and how each goes. Without LZ4 the
 * batch is 1.15.0's to the byte, so Rob's stock driver sees nothing new.
 */
#include "harness.h"
#include "lz4_corpus.h"
#include "../src/pnet_pack.h"
#include "../src/pnet_link.h"
#include "../src/pnet_mfm.h"
#include <stdint.h>
#include <string.h>

#define CAP (25344u - 80u)       /* a WF_DF1_HD buffer less the extra lead-in, as test_pnet_link.c */
static uint8_t g_win[PNET_LZ4_WINDOW], g_blk[PNET_LZ4_WINDOW], g_track[25344], g_old[25344];
static uint8_t g_dec[PNET_LZ4_WINDOW], g_scr[PNET_LZ4_BLOCK_MAX];
static uint16_t g_tab[PNET_LZ4_TABLE_ENTRIES];
static uint8_t g_f[25][PNET_ETH_MTU];
static const pnet_pack_mem_t MEM = { g_win, g_blk, g_tab, PNET_LZ4_TABLE_ENTRIES };
static pnet_pack_t g_pk;
static const uint8_t SAME_SIZE[20] = { 'W', 'X', 'Y', 'Z', 1, 2, 3, 4, 'W', 'X', 'Y', 'Z', 5, 6, 7, 8, 9, 10, 11, 12 };

static void frames(pnet_frame_ref_t *in, unsigned n, const int *kinds, const uint16_t *lens) {
    for (unsigned i = 0; i < n; i++) {
        lc_frame(g_f[i], lens[i], kinds[i], i + 1u);
        in[i].data = g_f[i];
        in[i].len = lens[i];
    }
}

/* The track read as the variant reads it, frame by frame into a window: how many frames came back whole (*lz4: how
 * many of them were LZ4). */
static unsigned read_back(const uint8_t *track, size_t bytes, const pnet_frame_ref_t *in, unsigned *lz4) {
    static uint8_t out[PNET_ETH_MTU];
    *lz4 = 0;
    const long sync = pnet_find_sync(track, bytes, bytes);
    pnet_hdr_t h;
    if (sync <= 0 || sync % 8 != 0) return 0;
    const size_t at = (size_t)sync / 8u;
    if (pnet_parse_hdr_to_amiga(track + at, bytes - at, &h, true) != PNET_OK) return 0;
    pnet_frame_iter_t it;
    if (pnet_frame_iter_init(&it, track + at + PNET_HDR_MFM_BYTES, h.data_size, PNET_TO_AMIGA) != PNET_OK) return 0;
    pnet_lz4_win_t w = { g_dec, 0, g_scr };
    unsigned k = 0;
    while (it.i < it.count) {
        uint16_t len = 0;
        bool z = false;
        if (pnet_lz4_iter_next(&it, &w, out, sizeof out, &len, &z) != PNET_OK) break;
        if (len != in[k].len || memcmp(out, in[k].data, len) != 0) break;
        if (z) (*lz4)++;
        k++;
    }
    return k;
}

/* Rob's stock driver against 1.16.0 sees 1.15.0's bytes (spec §1): same count as pnet_link_fit, same track. */
static void without_lz4_a_batch_is_1_15_0s_byte_for_byte(void) {
    uint32_t s = 4242;
    unsigned bad = 0;
    for (unsigned t = 0; t < 200; t++) {
        pnet_frame_ref_t in[25];
        uint16_t lens[25];
        int kinds[25];
        const unsigned avail = 1u + lc_next(&s) % 25u;
        for (unsigned i = 0; i < avail; i++) {
            lens[i] = (uint16_t)(1u + lc_next(&s) % PNET_ETH_MTU);
            kinds[i] = (int)(lc_next(&s) % 5u);
        }
        frames(in, avail, kinds, lens);
        const unsigned n0 = pnet_link_fit(lens, avail, CAP);
        const unsigned n = pnet_pack(&g_pk, &MEM, false, in, avail, CAP);
        const size_t a = pnet_build_to_amiga_out(g_track, sizeof g_track, 3, 4, 1, g_pk.f, n);
        const size_t b = pnet_build_to_amiga(g_old, sizeof g_old, 3, 4, 1, in, n0);
        if (n != n0 || g_pk.lz4 != 0 || a == 0 || a != b || memcmp(g_track, g_old, a) != 0) bad++;
        if (g_pk.wire != pnet_out_payload_bytes(g_pk.f, n)) bad++;
    }
    CHECK_EQ_INT(bad, 0);
}

static void lz4_frames_go_0xc000_and_carry_more_frames(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = LC_TEXT; lens[i] = 1200; }
    frames(in, 12, kinds, lens);
    CHECK_EQ_INT(pnet_link_fit(lens, 12, CAP), 6);        /* MFM: 6 frames of 1,200 B */
    const unsigned n = pnet_pack(&g_pk, &MEM, true, in, 12, CAP);
    CHECK(n > 6 && n <= 12, "packing by the real size carries more frames");
    CHECK_EQ_INT(g_pk.lz4, n);
    CHECK(g_pk.saved > 0, "bytes saved");
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, 0, 0, g_pk.f, n);
    CHECK(bytes != 0, "built");
    unsigned z = 0;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), n);
    CHECK_EQ_INT(z, n);
    uint8_t ch[4];                                        /* the first frame's size word */
    const long sync = pnet_find_sync(g_track, bytes, bytes);
    pnet_mfm_decode(g_track + sync / 8 + PNET_HDR_MFM_BYTES + 4, 4, ch);
    CHECK_EQ_INT(ch[0] & 0xC0, 0xC0);
    CHECK_EQ_INT(((ch[0] & 0x3F) << 8 | ch[1]), g_pk.f[0].lz4_len);
}

/* Review Focus, mixed batches: random frames go MFM and still sit in the window the later LZ4 frames link to. */
static void a_batch_mixes_lz4_and_mfm(void) {
    static const int kinds[7] = { LC_TEXT, LC_RANDOM, LC_TEXT, LC_ZEROS, LC_HTML, LC_RANDOM, LC_TEXT };
    static const uint16_t lens[7] = { 800, 800, 800, 800, 800, 800, 800 };
    pnet_frame_ref_t in[7];
    frames(in, 7, kinds, lens);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 7, CAP), 7);
    CHECK_EQ_INT(g_pk.lz4, 5);
    CHECK(g_pk.f[1].lz4 == NULL && g_pk.f[5].lz4 == NULL, "random bytes go MFM");
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, 0, 0, g_pk.f, 7);
    unsigned z = 0;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), 7);
    CHECK_EQ_INT(z, 5);
}

/* Spec §2: never larger than today. Review Focus, sizes at the edges: a block as long as its frame goes MFM. */
static void the_choice_never_grows_a_frame(void) {
    static const int kinds[6] = { LC_TEXT, LC_RANDOM, LC_HTML, LC_ZEROS, LC_TEXT_ZERO_TAIL, LC_RANDOM };
    static const uint16_t lens[6] = { 1518, 1518, 20, 13, 1200, 64 };
    pnet_frame_ref_t in[6];
    frames(in, 6, kinds, lens);
    pnet_pack(&g_pk, &MEM, true, in, 6, CAP);
    unsigned bad = 0;
    for (unsigned i = 0; i < g_pk.n; i++)
        if (g_pk.f[i].lz4 && g_pk.f[i].lz4_len >= g_pk.f[i].len) bad++;
    CHECK_EQ_INT(bad, 0);
    pnet_frame_ref_t same = { SAME_SIZE, 20 };
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, &same, 1, CAP), 1);
    CHECK(g_pk.f[0].lz4 == NULL && g_pk.lz4 == 0, "a 20-byte block for a 20-byte frame: MFM");
}

/* Review Focus, sizes at the edges: a full incompressible batch is 1.15.0's, byte for byte. */
static void a_full_incompressible_batch_is_1_15_0s(void) {
    pnet_frame_ref_t in[25];
    int kinds[25];
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) { kinds[i] = LC_RANDOM; lens[i] = PNET_ETH_MTU; }
    frames(in, 25, kinds, lens);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 25, CAP), 5);
    CHECK_EQ_INT(g_pk.lz4, 0);
    const size_t a = pnet_build_to_amiga_out(g_track, sizeof g_track, 7, 8, 1, g_pk.f, 5);
    const size_t b = pnet_build_to_amiga(g_old, sizeof g_old, 7, 8, 1, in, 5);
    CHECK(a != 0 && a == b && memcmp(g_track, g_old, a) == 0, "the same track");
    CHECK(g_pk.wire <= PNET_TO_AMIGA_MAX_PAYLOAD, "inside the driver's read");
}

/* Review Focus, sizes at the edges: exactly 16,128 decoded bytes link; one more byte stops the batch. */
static void packing_stops_at_16128_decoded_bytes(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = LC_ZEROS; lens[i] = PNET_ETH_MTU; }
    lens[10] = 948;                                       /* 10 x 1,518 + 948 = 16,128 */
    lens[11] = 1;
    frames(in, 12, kinds, lens);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 12, CAP), 11);
    unsigned sum = 0;
    for (unsigned i = 0; i < g_pk.n; i++) sum += g_pk.f[i].len;
    CHECK_EQ_INT(sum, PNET_LZ4_WINDOW);
    CHECK_EQ_INT(g_pk.lz4, 11);
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, 0, 0, g_pk.f, 11);
    unsigned z = 0;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), 11);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, false, in, 12, CAP), 5);   /* MFM: the payload limit, as before */
}

/* The batch out is rebuilt unchanged until acknowledged (pnet_link.h): the same frames give the same bytes. */
static void rebuilds_are_byte_identical(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = i % 3u ? LC_TEXT : LC_HTML; lens[i] = (uint16_t)(700u + 61u * i); }
    frames(in, 12, kinds, lens);
    const unsigned n = pnet_pack(&g_pk, &MEM, true, in, 12, CAP);
    const size_t a = pnet_build_to_amiga_out(g_old, sizeof g_old, 1, 2, 0, g_pk.f, n);
    memset(g_tab, 0x5A, sizeof g_tab);                    /* whatever the table held */
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 12, CAP), n);
    const size_t b = pnet_build_to_amiga_out(g_track, sizeof g_track, 1, 2, 0, g_pk.f, n);
    CHECK(a != 0 && a == b && memcmp(g_old, g_track, a) == 0, "byte-identical");
}

/* Review Focus, the driver swap: an LZ4 batch is out, then Rob's driver writes (no 0x10). The rebuild is MFM, holds
 * the frames that fit, and the acknowledgement frees exactly those. */
static void the_driver_stops_asking_mid_session(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = LC_TEXT; lens[i] = 1200; }
    frames(in, 12, kinds, lens);
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, pnet_pack(&g_pk, &MEM, true, in, 12, CAP));
    const unsigned out = s.nframes;
    CHECK(out > 6, "an LZ4 batch is out");
    pnet_link_shrink(&s, pnet_pack(&g_pk, &MEM, false, in, s.nframes, CAP));
    CHECK_EQ_INT(s.nframes, 6);
    CHECK_EQ_INT(g_pk.lz4, 0);
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, s.pico, 0, g_pk.f, s.nframes);
    unsigned z = 9;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), 6);
    CHECK_EQ_INT(z, 0);                                   /* nothing LZ4 reaches Rob's driver */
    pnet_link_shrink(&s, 10);                             /* never grows */
    CHECK_EQ_INT(s.nframes, 6);
    pnet_link_shrink(&s, 0);                              /* never empties */
    CHECK_EQ_INT(s.nframes, 6);
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    h.pico_ctr = s.pico;
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 6);
}

int main(void) {
    RUN(without_lz4_a_batch_is_1_15_0s_byte_for_byte);
    RUN(lz4_frames_go_0xc000_and_carry_more_frames);
    RUN(a_batch_mixes_lz4_and_mfm);
    RUN(the_choice_never_grows_a_frame);
    RUN(a_full_incompressible_batch_is_1_15_0s);
    RUN(packing_stops_at_16128_decoded_bytes);
    RUN(rebuilds_are_byte_identical);
    RUN(the_driver_stops_asking_mid_session);
    return REPORT();
}
```

- [ ] **Step 2: Run it to see it fail.**

Run: `wifi-floppy/firmware/test/run.sh test_pnet_pack.c`
Expected: `'../src/pnet_pack.h' file not found`, `COMPILE FAIL: test_pnet_pack.c`, exit 1.

- [ ] **Step 3: Write the header.** Create `wifi-floppy/firmware/src/pnet_pack.h`:

```c
#ifndef PNET_PACK_H
#define PNET_PACK_H
/*
 * PaulaNET LZ4, board -> Amiga (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §2, §5): which waiting
 * frames make one batch toward the Amiga, how each goes, and the track. Ours.
 *
 * Without LZ4 (Rob's driver, or ours before its first batch) every frame goes MFM, 0x8000 | 2 len, and the batch is
 * 1.15.0's to the byte (test_pnet_pack.c). With it, a frame goes 0xC000 | lz4_len -- its block MFM-encoded -- when the
 * block is shorter than the frame, its matches linked to the batch's earlier frames laid back to back in m->win.
 *
 * Its own file, not pnet_frame.c: tools/netloop compiles pnet_frame.c twice into one 68k program (renamed copies),
 * and new names there would collide.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "pnet_frame.h"
#include "pnet_lz4.h"

typedef struct {
    const uint8_t *data;     /* the frame */
    uint16_t       len;
    const uint8_t *lz4;      /* its LZ4 block, or NULL: the frame goes MFM */
    uint16_t       lz4_len;
} pnet_out_t;

typedef struct {
    uint8_t  *win;           /* PNET_LZ4_WINDOW bytes: the batch's frames back to back (the blocks' window) */
    uint8_t  *blk;           /* PNET_LZ4_WINDOW bytes: the blocks back to back */
    uint16_t *table;         /* entries x 16 bits, cleared at every LZ4 pack so a rebuild is byte-identical */
    unsigned  entries;
} pnet_pack_mem_t;

typedef struct {
    pnet_out_t f[PNET_MAX_FRAMES];
    unsigned   n;            /* frames in the batch */
    unsigned   lz4;          /* ...of them sent LZ4 */
    uint32_t   wire;         /* the payload's bytes on the wire: pnet_out_payload_bytes(f, n) */
    uint32_t   saved;        /* bytes LZ4 saved on the wire against MFM: the sum of 2 x (len - lz4_len) */
} pnet_pack_t;

/* Packs the first of `avail` frames (in[]) into one batch: at most PNET_MAX_FRAMES, their bytes within
 * PNET_LZ4_WINDOW, the payload within PNET_TO_AMIGA_MAX_PAYLOAD and the track within `cap` (counted as
 * pnet_to_amiga_bound counts it) -- by the frames' real encoded sizes. With lz4, each frame is copied into m->win and
 * goes LZ4 when its block is shorter than the frame (cap len - 1); without, m is not touched and f[].data points into
 * in[]. Returns pk->n. */
unsigned pnet_pack(pnet_pack_t *pk, const pnet_pack_mem_t *m, bool lz4, const pnet_frame_ref_t *in, unsigned avail,
                   size_t cap);
/* The payload's bytes for these frames (0 for none). */
size_t pnet_out_payload_bytes(const pnet_out_t *f, unsigned n);
/* As pnet_build_to_amiga, from packed frames: the bytes written, or 0 when cap might not hold them, n is over
 * PNET_MAX_FRAMES, or a frame is empty, over PNET_ETH_MTU, or its block over 0x3FFF bytes. */
size_t pnet_build_to_amiga_out(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, uint8_t flags,
                               const pnet_out_t *f, unsigned n);
#endif
```

- [ ] **Step 4: Write the packer and the builder.** Create `wifi-floppy/firmware/src/pnet_pack.c`:

```c
/* PaulaNET LZ4, board -> Amiga (pnet_pack.h). Ours. The track's layout is pnet_frame.h's; this builder writes what
 * pnet_build_to_amiga writes, with an LZ4 frame's block in place of its MFM bytes. */
#include "pnet_pack.h"
#include "pnet_mfm.h"
#include <string.h>

#ifndef PNET_TX_LEAD_BYTES
#define PNET_TX_LEAD_BYTES PNET_LEAD_BYTES     /* as pnet_frame.c: CMake sets the board's */
#endif

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

static size_t wire_of(const pnet_out_t *f) { return 2u * (size_t)(f->lz4_len ? f->lz4_len : f->len); }

size_t pnet_out_payload_bytes(const pnet_out_t *f, unsigned n) {
    if (n == 0) return 0;
    size_t b = 4;
    for (unsigned i = 0; i < n; i++) b += 8u + wire_of(&f[i]);
    return b;
}

unsigned pnet_pack(pnet_pack_t *pk, const pnet_pack_mem_t *m, bool lz4, const pnet_frame_ref_t *in, unsigned avail,
                   size_t cap) {
    memset(pk, 0, sizeof *pk);
    if (lz4) memset(m->table, 0, (size_t)m->entries * sizeof m->table[0]);
    if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
    size_t dec = 0, blk = 0, payload = 4;
    for (unsigned i = 0; i < avail; i++) {
        const uint16_t len = in[i].len;
        if (len == 0 || len > PNET_ETH_MTU || len > PNET_LZ4_WINDOW - dec) break;
        const uint8_t *data = in[i].data;
        size_t z = 0;
        if (lz4) {
            memcpy(m->win + dec, data, len);
            data = m->win + dec;
            z = pnet_lz4_encode_linked(data, len, m->blk + blk, (size_t)len - 1u, m->table, m->entries, m->win);
        }
        const size_t wire = 2u * (z ? z : len);
        if (payload + 8u + wire > PNET_TO_AMIGA_MAX_PAYLOAD ||
            PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + payload + 8u + wire + PNET_TRAIL_BYTES + 3u > cap) break;
        pk->f[i].data = data;
        pk->f[i].len = len;
        pk->f[i].lz4 = z ? m->blk + blk : NULL;
        pk->f[i].lz4_len = (uint16_t)z;
        if (z) { pk->lz4++; pk->saved += 2u * (uint32_t)(len - z); }
        dec += len;
        blk += z;
        payload += 8u + wire;
        pk->n++;
    }
    pk->wire = pk->n ? (uint32_t)payload : 0u;
    return pk->n;
}

size_t pnet_build_to_amiga_out(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, uint8_t flags,
                               const pnet_out_t *f, unsigned n) {
    if (n > PNET_MAX_FRAMES) return 0;
    for (unsigned i = 0; i < n; i++)
        if (f[i].len == 0 || f[i].len > PNET_ETH_MTU || f[i].lz4_len > 0x3FFFu || (f[i].lz4_len && !f[i].lz4))
            return 0;
    const size_t pb = pnet_out_payload_bytes(f, n);
    if (PNET_TX_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + pb + PNET_TRAIL_BYTES + 3u > cap) return 0;
    memset(out, 0xAA, PNET_TX_LEAD_BYTES);
    uint8_t *s = out + PNET_TX_LEAD_BYTES;
    uint8_t *pay = s + 4 + PNET_HDR_MFM_BYTES;
    size_t plen = 0;
    if (n) {
        const uint8_t ph[2] = { (uint8_t)n, flags };
        uint16_t last = 0;
        plen = pnet_mfm_encode(ph, 2, pay, &last);
        for (unsigned i = 0; i < n; i++) {
            const bool z = f[i].lz4_len != 0;
            uint8_t ch[4];
            put16(ch, (uint16_t)(z ? (0x8000u | PNET_SIZE_LZ4 | f[i].lz4_len) : (0x8000u | 2u * f[i].len)));
            put16(ch + 2, f[i].len);
            last = 0;                                   /* each header from a clean start */
            pnet_mfm_encode(ch, 4, pay + plen, &last);
            pnet_mfm_encode(z ? f[i].lz4 : f[i].data, z ? f[i].lz4_len : f[i].len, pay + plen + 8, &last);
            plen += 8u + wire_of(&f[i]);
        }
    }
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(pay, plen), .data_size = (uint16_t)plen,
        .compressed_size = (uint16_t)plen, .mode = PNET_MODE_ETHERNET, .compressed = 0,
        .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    pnet_put_hdr_to_amiga(s, &h);
    const size_t pos = (size_t)(pay - out) + plen;
    const size_t end = (pos + PNET_TRAIL_BYTES + 3u) & ~(size_t)3u;
    memset(out + pos, 0xAA, end - pos);
    return end;
}
```

- [ ] **Step 5: Run the tests to see them pass.**

Run: `wifi-floppy/firmware/test/run.sh test_pnet_pack.c`
Expected: eight `- <name>` lines, `test_pnet_pack.c: <N> checks, 0 failed`; exit 0.

- [ ] **Step 6: Build the new files into L2 firmware.** In `wifi-floppy/firmware/CMakeLists.txt` replace
`list(APPEND WFMF_FIRMWARE_SOURCES src/pnet_sort.c src/pnet_ring.c src/pnet_link.c src/pnet_bridge.c src/pnet_status.c)`
with
`list(APPEND WFMF_FIRMWARE_SOURCES src/pnet_sort.c src/pnet_ring.c src/pnet_link.c src/pnet_bridge.c src/pnet_status.c src/pnet_lz4.c src/pnet_pack.c)`.

- [ ] **Step 7: Wire main.c -- includes and state.** In `wifi-floppy/firmware/src/main.c`, after
`#include "pnet_status.h"     //   Phase 2: cylinder 76's status track` add

```c
#include "pnet_lz4.h"        //   1.16.0: LZ4 both ways (spec 2026-10-18)
#include "pnet_pack.h"       //   ...board -> Amiga packing
```

and after `static uint32_t    g_pnet_heap_low = UINT32_MAX;` add:

```c
// PaulaNET LZ4 (spec 2026-10-18 §5). All of it is PSRAM -- the heap low-water already sits at its 20,480 B floor
// (HANDOFF 3bv) -- so g_lz4 is zeroed at boot, after its PSRAM check, never by crt0. Like the rings, it needs PSRAM.
static __uninitialized_psram("lz4txw") uint8_t  g_lz4_tx_win[PNET_LZ4_WINDOW];         // the batch out, back to back
static __uninitialized_psram("lz4txb") uint8_t  g_lz4_tx_blk[PNET_LZ4_WINDOW];         // ...its LZ4 blocks
static __uninitialized_psram("lz4tab") uint16_t g_lz4_table[PNET_LZ4_TABLE_ENTRIES];   // the 8 KB hash table
static __uninitialized_psram("lz4rxw") uint8_t  g_lz4_rx_win[PNET_LZ4_WINDOW];         // the Amiga's batch, decoded
static __uninitialized_psram("lz4rxs") uint8_t  g_lz4_rx_scratch[PNET_LZ4_BLOCK_MAX];  // an MFM-wrapped block
typedef struct {
    pnet_pack_t pack;                        // the batch out: its frames, and how each goes
    bool        pack_lz4;                    // ...packed with LZ4 on
    bool        ok;                          // every buffer above is backed by PSRAM (boot); else LZ4 is off both ways
    uint32_t    out_lz4, out_mfm, wire, saved; // new batches: frames by encoding, payload bytes, bytes LZ4 saved
    uint32_t    us_max, us_sum, us_n;          // pnet_pack per new batch, this 5 s window
} pnet_lz4_state_t;
static __uninitialized_psram("lz4st") pnet_lz4_state_t g_lz4;
static const pnet_pack_mem_t g_lz4_mem = { g_lz4_tx_win, g_lz4_tx_blk, g_lz4_table, PNET_LZ4_TABLE_ENTRIES };
```

- [ ] **Step 8: Wire main.c -- the Amiga's batch.** In `pnet_take_capture` replace

```c
    pnet_link_take(&g_link, &h, cap.bytes + PNET_HDR_BYTES, &g_pnet_tx);
```

with

```c
    // LZ4 (spec 2026-10-18 §5): a batch from our driver (0x10) is decoded through the RX window, linked.
    pnet_link_take_lz4(&g_link, &h, cap.bytes + PNET_HDR_BYTES, &g_pnet_tx,
                       g_lz4.ok ? g_lz4_rx_win : NULL, g_lz4_rx_scratch);
```

- [ ] **Step 9: Wire main.c -- our batch.** In `pnet_prepare_echo` replace the block from
`    pnet_frame_ref_t f[PNET_MAX_FRAMES];` through
`    const size_t bytes = pnet_build_to_amiga(out, sizeof track_words1, ack, pico, flags, f, nf);` (the whole
`#if WF_PNET_L2 ... #else ... #endif` and the build line after it) with:

```c
#if WF_PNET_L2
    // Phase 1: our batch out, or -- when none is out -- a new one from what is waiting. It stays out, rebuilt
    // unchanged here, until the Amiga acknowledges it (ruling 10; pnet_link.h). LZ4 (spec 2026-10-18 §3, §5): packed by
    // the frames' real sizes, LZ4 only while the Amiga's latest batch asked for it (0x10). The batch out is re-packed
    // only when that changed: without LZ4 it may hold fewer frames (pnet_link_shrink); the rest stay waiting.
    const bool lz4 = g_lz4.ok && g_link.amiga_lz4;
    if (!g_link.backup || g_lz4.pack.n != g_link.nframes || g_lz4.pack_lz4 != lz4) {
        pnet_frame_ref_t in[PNET_MAX_FRAMES];
        unsigned avail = g_link.backup ? g_link.nframes : pnet_ring_count(&g_pnet_rx);
        if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
        for (unsigned i = 0; i < avail; i++) in[i].data = pnet_ring_peek(&g_pnet_rx, i, &in[i].len);
        const uint64_t p0 = time_us_64();
        pnet_pack(&g_lz4.pack, &g_lz4_mem, lz4, in, avail, PNET_BATCH_CAP);
        const uint32_t pus = (uint32_t)(time_us_64() - p0);
        g_lz4.pack_lz4 = lz4;
        if (g_link.backup) {
            pnet_link_shrink(&g_link, g_lz4.pack.n);
        } else {
            pnet_link_start(&g_link, g_lz4.pack.n);
            if (g_lz4.pack.n) {
                g_lz4.out_lz4 += g_lz4.pack.lz4;
                g_lz4.out_mfm += g_lz4.pack.n - g_lz4.pack.lz4;
                g_lz4.wire += g_lz4.pack.wire;
                g_lz4.saved += g_lz4.pack.saved;
                if (pus > g_lz4.us_max) g_lz4.us_max = pus;
                g_lz4.us_sum += pus;
                g_lz4.us_n++;
            }
        }
    }
    const uint8_t flags = pnet_ring_count(&g_pnet_rx) > g_link.nframes ? PNET_CANRECEIVE : 0u;
    const unsigned nf = g_link.nframes;
    const uint8_t ack = g_link.last_amiga, pico = g_link.pico;
    // Built as bytes straight into the word buffer, then repacked in place (pnet_pack_words).
    uint8_t *out = (uint8_t *)track_words1;
    const size_t bytes = pnet_build_to_amiga_out(out, sizeof track_words1, ack, pico, flags, g_lz4.pack.f, nf);
#else
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
    const uint8_t *p = g_pnet_echo[g_pnet_half];
    for (unsigned i = 0; i < g_pnet.nframes; i++) {
        f[i].data = p;
        f[i].len = g_pnet.len[i];
        p += g_pnet.len[i];
    }
    const uint8_t flags = 0;
    const unsigned nf = g_pnet.nframes;
    const uint8_t ack = g_pnet.last_amiga, pico = g_pnet.pico;
    // Built as bytes straight into the word buffer, then repacked in place (pnet_pack_words).
    uint8_t *out = (uint8_t *)track_words1;
    const size_t bytes = pnet_build_to_amiga(out, sizeof track_words1, ack, pico, flags, f, nf);
#endif
```

- [ ] **Step 10: Wire main.c -- status byte 155.** In `pnet_serve_status`, after
`    pnet_version_bytes(WF_FIRMWARE_VERSION, &st.ver_major, &st.ver_minor);` add

```c
    st.lz4 = g_lz4.ok ? (uint8_t)(PNET_ST_LZ4_TO_AMIGA | PNET_ST_LZ4_FROM_AMIGA) : 0u;   // spec 2026-10-18 §3
```

- [ ] **Step 11: Wire main.c -- the counters.** In `pnet_l2_log`, append to the `sum` expression (after
`st.a2b + st.b2a + st.local_drops`): ` + g_lz4.out_lz4 + g_lz4.out_mfm + g_link.lz4_in + g_link.lz4_bad`. After the
statement that prints `"pnet: l2 from amiga new %lu dup %lu frames %lu over %lu bad %lu"` add:

```c
    // LZ4 (spec 2026-10-18 §5): new batches to the Amiga -- frames by encoding, payload bytes on the wire, bytes LZ4
    // saved against MFM; frames from the Amiga in LZ4 and refused LZ4; what the driver last asked for; pnet_pack's
    // time per new batch this window (us).
    wf_logf(WF_INFO, "pnet: l2 lz4 out lz4 %lu mfm %lu wire %lu saved %lu",
            S7(g_lz4.out_lz4), S7(g_lz4.out_mfm), S7(g_lz4.wire), S7(g_lz4.saved));
    wf_logf(g_link.lz4_bad ? WF_WARN : WF_INFO, "pnet: l2 lz4 in lz4 %lu bad %lu driver %s us max %lu avg %lu",
            S7(g_link.lz4_in), S7(g_link.lz4_bad), g_link.amiga_lz4 ? "lz4" : "stock", S7(g_lz4.us_max),
            S7(g_lz4.us_n ? g_lz4.us_sum / g_lz4.us_n : 0u));
    g_lz4.us_max = g_lz4.us_sum = g_lz4.us_n = 0;
```

- [ ] **Step 12: Wire main.c -- boot.** Replace

```c
#if WF_PNET_L2
    pnet_bridge_init();           // the PSRAM rings, before core1 (their other side) starts
#endif
```

with

```c
#if WF_PNET_L2
    pnet_bridge_init();           // the PSRAM rings, before core1 (their other side) starts
    // LZ4 (spec 2026-10-18 §5): its state and buffers, PSRAM like the rings; off both ways unless all are backed.
    if (psram_check_address((uint8_t *)&g_lz4 + sizeof g_lz4 - 1u)) {
        memset(&g_lz4, 0, sizeof g_lz4);
        g_lz4.ok = psram_check_address(&g_lz4_tx_win[PNET_LZ4_WINDOW - 1u]) &&
                   psram_check_address(&g_lz4_tx_blk[PNET_LZ4_WINDOW - 1u]) &&
                   psram_check_address(&g_lz4_table[PNET_LZ4_TABLE_ENTRIES - 1u]) &&
                   psram_check_address(&g_lz4_rx_win[PNET_LZ4_WINDOW - 1u]) &&
                   psram_check_address(&g_lz4_rx_scratch[PNET_LZ4_BLOCK_MAX - 1u]);
    }
    wf_logf(g_lz4.ok ? WF_INFO : WF_ERR, "pnet: lz4 %s",
            g_lz4.ok ? "on (table 4096, 57 KB of PSRAM)" : "OFF -- its buffers are not backed by PSRAM");
#endif
```

- [ ] **Step 13: Build the firmware and check SRAM.**

```bash
pnpm firmware:build
arm-none-eabi-size wifi-floppy/firmware/build/wifi_floppy.elf
cat wifi-floppy/firmware/build/size-before-lz4.txt
```

Expected: the build ends without errors or stack-frame failures; the new `bss` is at most 16 bytes above the one in
`size-before-lz4.txt` (12 from `pnet_link_t`). If it is more, a new static slipped into SRAM: move it into `g_lz4`.

- [ ] **Step 14: Run every host test and netloop's.**

Run: `wifi-floppy/firmware/test/run.sh && tools/netloop/build.sh test`
Expected: no `FAIL`; exit 0.

- [ ] **Step 15: Commit.**

```bash
git add wifi-floppy/firmware/src/pnet_pack.h wifi-floppy/firmware/src/pnet_pack.c \
        wifi-floppy/firmware/test/test_pnet_pack.c wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "fw: LZ4 to the Amiga -- packed by real size, LZ4 per frame while the driver asks; counters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 5: The driver's LZ4 half, tested on an emulated 68000, 68020 and 68040

The spec asks for the variant "in the emulator (`tools/receive/uae` harness) ... against a scripted board". That
harness boots FS-UAE and talks to a TCP program through bsdsocket emulation; FS-UAE cannot answer DF1's raw tracks
from a script, so it cannot play the board. This task proves the same thing with vamos instead: the driver's LZ4 half
(all of the variant's logic, kept pure for this) runs on an emulated 68000 / 68020 / 68040 against the board's own C
packer and decoder, built for the 68000. The glue in Rob's code (Task 6) is a dozen lines, checked by review and the
benches.

**Files:**
- Create: `tools/paulanet-driver/src/webadf_lz4.h`, `tools/paulanet-driver/src/webadf_lz4.c`
- Create: `tools/paulanet-driver/test/drvtest.c`, `tools/paulanet-driver/test.sh`

**Interfaces:**
- Consumes: `lz4_decode`, `lz4_encode_linked` (asm, Task 1); `pnet_pack`, `pnet_build_to_amiga_out` (Task 4);
  `pnet_lz4_iter_next`, `pnet_lz4_win_t` (Task 3); `lc_frame` (Task 2); `pnet_rle_encode`, `pnet_mfm_*`.
- Produces (`webadf_lz4.h`, used by Task 6's patch):
  - `#define WL_WINDOW 16128UL`, `WL_BLOCK_MAX 1540UL`, `WL_MTU 1518UL`, `WL_BROKEN 0xFFFFFFFFUL`, `WL_SIZE_LZ4 0x4000U`,
    `WL_DRIVER_LZ4 0x10U`, `WL_ST_LZ4_IN 2U`, `WL_ZERO_RUN_MAX 5UL`
  - `struct WlRx { UBYTE *win; ULONG pos; UBYTE *scratch; };`
  - `struct WlTx { UBYTE *win; ULONG pos; UBYTE *out; UWORD *table; ULONG entries; BOOL on; };`
  - `ULONG wl_table_entries(UWORD attnFlags);` `ULONG wl_mem_bytes(UWORD attnFlags);`
    `void wl_init(struct WlRx *rx, struct WlTx *tx, UBYTE *mem, UWORD attnFlags);` `UWORD wl_wire_bytes(UWORD field);`
    `void wl_rx_begin(struct WlRx *rx);` `void wl_rx_break(struct WlRx *rx);`
    `const UBYTE *wl_rx_frame(struct WlRx *rx, UWORD field, const UBYTE *wire, UWORD orig);`
    `void wl_tx_begin(struct WlTx *tx, UBYTE statusReserved);`
    `UWORD wl_tx_frame(struct WlTx *tx, const UBYTE *data, UWORD len, UBYTE *body, UWORD rleLen);`
    `ULONG wl_zero_run(const UBYTE *p, ULONG n);`

- [ ] **Step 1: Write the header.** Create `tools/paulanet-driver/src/webadf_lz4.h`:

```c
/*
 * webadf_lz4.h: the LZ4 half of webadf's PaulaNET.device variant (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-
 * design.md §2-§4). Copyright (c) 2026 Stefan Skotte and contributors. MIT licence. Not Rob Smith's code: his
 * paulanetio.c (third-party/paulanet/src, by his permission) calls it through tools/paulanet-driver/webadf-lz4.patch.
 *
 * Pure -- no exec or dos calls, no globals -- so tools/paulanet-driver/test.sh runs it under vamos against the board's
 * own C. Byte access only (68000).
 *
 * Wire, only between parties that both advertised LZ4:
 *   size word 0xC000 | n   an n-byte LZ4 block, MFM-encoded (2n bytes): toward the Amiga
 *   size word 0x4000 | n   an n-byte LZ4 block, raw, padded to even: toward the board
 * Every frame of a batch is laid back to back in a window; an LZ4 frame's matches reach into the earlier frames of the
 * same batch, never further. Per CPU, from AttnFlags at open:
 *                                    board -> Amiga   Amiga -> board
 *   68000 / 68010                    LZ4              RLE
 *   68020 / 68030 (table 1,024)      LZ4              LZ4
 *   68040 / 68060 (table 4,096)      LZ4              LZ4
 *   Rob's stock driver (any CPU)     MFM              RLE
 */
#ifndef WEBADF_LZ4_H
#define WEBADF_LZ4_H
#include <exec/types.h>

#define WL_WINDOW        16128UL     /* a batch's frames decoded back to back (the board's PNET_LZ4_WINDOW) */
#define WL_BLOCK_MAX     1540UL      /* the longest block of one frame (the board's PNET_LZ4_BLOCK_MAX) */
#define WL_MTU           1518UL
#define WL_BROKEN        0xFFFFFFFFUL /* a window past which nothing may link */
#define WL_SIZE_LZ4      0x4000U     /* CompressionHeader.compressedSize: an LZ4 block of (size & 0x3FFF) bytes */
#define WL_DRIVER_LZ4    0x10U       /* DataHeader.compressed: this driver decodes LZ4 */
#define WL_ST_LZ4_IN     2U          /* LiveStatus.reserved (byte 155): the board accepts LZ4 frames */
/* The longest run of 0x00 bytes a raw block may carry to the board. N zero bytes between two set bits are a gap of up
 * to 8N + 15 cells; the board refuses a gap over 64 (PNET_RX_MAX_CELLS) and the whole batch with it, which Rob's
 * resend-forever would turn into a stall. 5 keeps every gap at 55 cells or less. */
#define WL_ZERO_RUN_MAX  5UL

struct WlRx { UBYTE *win; ULONG pos; UBYTE *scratch; };
struct WlTx { UBYTE *win; ULONG pos; UBYTE *out; UWORD *table; ULONG entries; BOOL on; };

/* The upload hash table for this CPU: 0 (68000/68010: no LZ4 upload), 1,024 (68020/68030), 4,096 (68040 and up). */
ULONG wl_table_entries(UWORD attnFlags);
/* One allocation for both halves on this CPU (any memory, long aligned). */
ULONG wl_mem_bytes(UWORD attnFlags);
void  wl_init(struct WlRx *rx, struct WlTx *tx, UBYTE *mem, UWORD attnFlags);
/* A frame's bytes on the wire from its size word: 2n for 0xC000|n, else size & 0x7FFF (Rob's rule). */
UWORD wl_wire_bytes(UWORD field);
void  wl_rx_begin(struct WlRx *rx);   /* a new batch from the board: the window starts empty */
void  wl_rx_break(struct WlRx *rx);   /* a frame decoded outside the window (Rob's raw RLE): no LINK past it */
/* One frame of a board -> Amiga batch whose size word has bit 15 set: MFM, or (0xC000) an MFM-encoded LZ4 block.
 * Decoded into the window; returns the frame's orig bytes, or 0 (drop it) when it does not decode. */
const UBYTE *wl_rx_frame(struct WlRx *rx, UWORD field, const UBYTE *wire, UWORD orig);
/* A new batch toward the board: LZ4 on when this CPU has a table and status byte 155 has WL_ST_LZ4_IN. */
void  wl_tx_begin(struct WlTx *tx, UBYTE statusReserved);
/* After Rob's RLE of one frame (rleLen bytes at body): the frame joins the window; returns the length of an LZ4 block
 * now at body (shorter than rleLen, padded to even with a 0, no zero run over WL_ZERO_RUN_MAX), or 0: keep the RLE. */
UWORD wl_tx_frame(struct WlTx *tx, const UBYTE *data, UWORD len, UBYTE *body, UWORD rleLen);
ULONG wl_zero_run(const UBYTE *p, ULONG n);
#endif
```

- [ ] **Step 2: Write the failing test program.** Create `tools/paulanet-driver/test/drvtest.c`:

```c
/*
 * drvtest: the driver variant's LZ4 half (src/webadf_lz4.c, with m68k/lz4/lz4_68k.asm) against the board's own C
 * (wifi-floppy/firmware/src: pnet_pack.c, pnet_lz4.c, pnet_frame.c, pnet_mfm.c), on the CPU vamos emulates
 * (tools/paulanet-driver/test.sh: a 68000, a 68020, a 68040). Copyright (c) 2026 Stefan Skotte and contributors. MIT.
 */
#include <exec/types.h>
#include <exec/execbase.h>
#include <stdio.h>
#include <string.h>
#include "webadf_lz4.h"
#include "lz4_68k.h"
#include "pnet_pack.h"
#include "pnet_mfm.h"
#include "lz4_corpus.h"

extern struct ExecBase *SysBase;
static int checks, failed;
#define CHECK(c, m) do { checks++; if (!(c)) { failed++; printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, (m)); } } while (0)

#define ALL40 (AFF_68010 | AFF_68020 | AFF_68030 | AFF_68040)
static UBYTE g_frames[PNET_MAX_FRAMES][WL_MTU];
static UBYTE g_win[PNET_LZ4_WINDOW], g_blk[PNET_LZ4_WINDOW], g_track[26000], g_scr[PNET_LZ4_BLOCK_MAX];
static uint16_t g_tab[PNET_LZ4_TABLE_ENTRIES];
static UBYTE g_mem[2 * 4096 + 2 * (16128 + 1540)];
static pnet_pack_t g_pk;
static const UBYTE SAME_SIZE[20] = { 'W', 'X', 'Y', 'Z', 1, 2, 3, 4, 'W', 'X', 'Y', 'Z', 5, 6, 7, 8, 9, 10, 11, 12 };

static void gate(void) {
    struct WlRx rx; struct WlTx tx;
    CHECK(WL_WINDOW == PNET_LZ4_WINDOW && WL_BLOCK_MAX == PNET_LZ4_BLOCK_MAX, "the board's sizes");
    CHECK(wl_table_entries(0) == 0, "68000: no LZ4 upload");
    CHECK(wl_table_entries(AFF_68010) == 0, "68010: no LZ4 upload");
    CHECK(wl_table_entries(AFF_68010 | AFF_68020) == 1024, "68020: 1,024 entries");
    CHECK(wl_table_entries(AFF_68010 | AFF_68020 | AFF_68030) == 1024, "68030: 1,024 entries");
    CHECK(wl_table_entries(ALL40) == 4096, "68040: 4,096 entries");
    CHECK(wl_mem_bytes(0) == WL_WINDOW + WL_BLOCK_MAX, "68000: the download window only");
    CHECK(wl_mem_bytes(ALL40) <= sizeof g_mem, "the 68040 allocation");
    wl_init(&rx, &tx, g_mem, ALL40);
    wl_tx_begin(&tx, 0);
    CHECK(!tx.on, "a board without byte 155's bit 1 (1.15.0, Rob's): RLE, even on a 68040");
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(tx.on, "a board that takes LZ4");
    wl_init(&rx, &tx, g_mem, 0);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(!tx.on, "a 68000 never uploads LZ4");
    CHECK(wl_wire_bytes(0xC000 | 700) == 1400 && wl_wire_bytes(0x8000 | 2400) == 2400 && wl_wire_bytes(0x0123) == 0x123,
          "wire bytes");
}

/* Review Focus, sizes at the edges: a block as long as the RLE goes as the RLE. */
static void equal(void) {
    struct WlRx rx; struct WlTx tx;
    UBYTE body[32];
    wl_init(&rx, &tx, g_mem, AFF_68010 | AFF_68020);
    memset(tx.table, 0, 2 * tx.entries);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(wl_tx_frame(&tx, SAME_SIZE, 20, body, 20) == 0, "LZ4 20 B against RLE 20 B: RLE");
    memset(tx.table, 0, 2 * tx.entries);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(wl_tx_frame(&tx, SAME_SIZE, 20, body, 21) == 20, "against RLE 21 B: LZ4");
}

/* Review Focus, zero runs: text ending in 11 zero bytes compresses, but its block ends in a run the board cannot time. */
static void zerorun(void) {
    struct WlRx rx; struct WlTx tx;
    static UBYTE body[WL_MTU + 16];
    ULONG z;
    wl_init(&rx, &tx, g_mem, AFF_68010 | AFF_68020);
    lc_frame(g_frames[0], 1200, LC_TEXT_ZERO_TAIL, 7);
    memset(tx.table, 0, 2 * tx.entries);
    z = lz4_encode_linked(g_frames[0], 1200, g_blk, 1199, tx.table, tx.entries, g_frames[0]);
    CHECK(z != 0 && wl_zero_run(g_blk, z) > WL_ZERO_RUN_MAX, "the fixture's block carries 6+ zero bytes in a row");
    memset(tx.table, 0, 2 * tx.entries);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(wl_tx_frame(&tx, g_frames[0], 1200, body, 1210) == 0, "so the frame goes RLE");
}

/* Board -> Amiga: the board packs and builds; the driver reads the payload as paulaNetReceivePackets does
 * (wl_wire_bytes, wl_rx_frame) and gets every frame back. */
static void down(int lz4, const int *kinds, const UWORD *lens, unsigned n, unsigned *nlz4) {
    pnet_frame_ref_t in[PNET_MAX_FRAMES];
    const pnet_pack_mem_t m = { g_win, g_blk, g_tab, PNET_LZ4_TABLE_ENTRIES };
    struct WlRx rx; struct WlTx tx;
    const UBYTE *pay;
    UBYTE ph[2];
    size_t pos = 4;
    unsigned i;
    for (i = 0; i < n; i++) {
        lc_frame(g_frames[i], lens[i], kinds[i], i + 1u);
        in[i].data = g_frames[i];
        in[i].len = lens[i];
    }
    pnet_pack(&g_pk, &m, lz4 != 0, in, n, sizeof g_track);
    CHECK(g_pk.n == n, "the whole set is one batch");
    CHECK(pnet_build_to_amiga_out(g_track, sizeof g_track, 1, 2, 0, g_pk.f, g_pk.n) != 0, "built");
    pay = g_track + PNET_LEAD_BYTES + 4 + PNET_HDR_MFM_BYTES;   /* past the lead-in, the sync and the header */
    pnet_mfm_decode(pay, 2, ph);
    CHECK(ph[0] == g_pk.n, "frame count");
    wl_init(&rx, &tx, g_mem, SysBase->AttnFlags);
    wl_rx_begin(&rx);
    *nlz4 = 0;
    for (i = 0; i < g_pk.n; i++) {
        UBYTE ch[4];
        UWORD field, orig, wire;
        const UBYTE *got;
        pnet_mfm_decode(pay + pos, 4, ch);
        field = (UWORD)(ch[0] << 8 | ch[1]);
        orig = (UWORD)(ch[2] << 8 | ch[3]);
        wire = wl_wire_bytes(field);
        CHECK((field & 0x8000) != 0, "toward the Amiga every frame is MFM on the wire");
        if ((field & 0xC000) == 0xC000) (*nlz4)++;
        got = wl_rx_frame(&rx, field, pay + pos + 8, orig);
        CHECK(got != 0 && orig == in[i].len && memcmp(got, in[i].data, orig) == 0, "the frame back on the Amiga");
        pos += 8u + wire + (wire & 1u);
    }
}

/* Amiga -> board: the driver's half packs as paulaNetAddPacket does (RLE first -- pnet_rle_encode is Rob's format --
 * then wl_tx_frame) and the board's pnet_lz4_iter_next reads every frame back, linked. Returns frames sent LZ4. */
static unsigned up(UWORD attn, const int *kinds, const UWORD *lens, unsigned n) {
    struct WlRx rx; struct WlTx tx;
    pnet_frame_iter_t it;
    pnet_lz4_win_t w;
    const UBYTE ph[2] = { (UBYTE)n, 0 };
    uint16_t last = 0;
    size_t pos;
    unsigned i, nz = 0;
    wl_init(&rx, &tx, g_mem, attn);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    pos = pnet_mfm_encode(ph, 2, g_track, &last);
    for (i = 0; i < n; i++) {
        UBYTE *body = g_track + pos + 8;
        UWORD rle, z, field, wire;
        UBYTE ch[4];
        lc_frame(g_frames[i], lens[i], kinds[i], 100u + i);
        rle = (UWORD)pnet_rle_encode(g_frames[i], lens[i], body);
        z = wl_tx_frame(&tx, g_frames[i], lens[i], body, rle);
        field = z ? (UWORD)(WL_SIZE_LZ4 | z) : (UWORD)(0x8000 | rle);
        wire = z ? (UWORD)((z + 1) & ~1) : rle;
        ch[0] = (UBYTE)(field >> 8); ch[1] = (UBYTE)field; ch[2] = (UBYTE)(lens[i] >> 8); ch[3] = (UBYTE)lens[i];
        last = 0;
        pnet_mfm_encode(ch, 4, g_track + pos, &last);
        pos += 8u + wire;
        if (z) nz++;
        if (kinds[i] == LC_TEXT_ZERO_TAIL) CHECK(z == 0, "a block with a long zero run never goes raw");
    }
    w.win = g_win; w.pos = 0; w.scratch = g_scr;
    CHECK(pnet_frame_iter_init(&it, g_track, pos, PNET_TO_BOARD) == PNET_OK, "the board reads the batch");
    for (i = 0; i < n; i++) {
        static UBYTE out[WL_MTU];
        uint16_t l = 0;
        bool was = false;
        CHECK(pnet_lz4_iter_next(&it, &w, out, sizeof out, &l, &was) == PNET_OK, "a frame");
        CHECK(l == lens[i] && memcmp(out, g_frames[i], l) == 0, "the frame back on the board");
    }
    return nz;
}

int main(void) {
    const UWORD attn = SysBase->AttnFlags;
    const ULONG entries = wl_table_entries(attn);
    static const int mixed[6] = { LC_TEXT, LC_RANDOM, LC_HTML, LC_ZEROS, LC_TEXT, LC_RANDOM };
    static const UWORD mixed_len[6] = { 1200, 1400, 1300, 900, 1518, 600 };
    static const int upk[7] = { LC_TEXT, LC_RANDOM, LC_HTML, LC_TEXT_ZERO_TAIL, LC_ZEROS, LC_TEXT, LC_HTML };
    static const UWORD up_len[7] = { 1200, 900, 1400, 1100, 1518, 700, 1300 };
    unsigned nz;
    printf("drvtest: cpu attn %04x, upload table %lu\n", (unsigned)attn, (unsigned long)entries);
    gate();
    equal();
    zerorun();
    down(1, mixed, mixed_len, 6, &nz);
    printf("drvtest: down %u of 6 frames LZ4\n", nz);
    CHECK(nz == 4, "text, HTML and zeros go LZ4; random bytes MFM (Review Focus: a mixed batch)");
    down(0, mixed, mixed_len, 6, &nz);
    CHECK(nz == 0, "a board that sends no LZ4: all MFM, read as before");
    nz = up(attn, upk, up_len, 7);
    printf("drvtest: up %u of 7 frames LZ4\n", nz);
    CHECK(entries ? nz >= 4 : nz == 0, "LZ4 uploads on a 68020 or better only");
    printf("drvtest: %d checks, %d failed\nRESULT: %s\n", checks, failed, failed ? "FAIL" : "PASS");
    return failed ? 20 : 0;
}
```

- [ ] **Step 3: Write the test runner.** Create `tools/paulanet-driver/test.sh` (and `chmod +x` it):

```bash
#!/usr/bin/env bash
# The driver variant's LZ4 half (src/webadf_lz4.c + m68k/lz4/lz4_68k.asm) against the board's own C, built for the
# 68000 with the pinned amiga-gcc image and run under amitools' vamos as a 68000, a 68020 and a 68040 (AttnFlags picks
# the upload table, as the driver does at open). Copyright (c) 2026 Stefan Skotte and contributors. MIT licence.
# Usage: tools/paulanet-driver/test.sh        Needs Docker and vamos (as m68k/lz4/test.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
out="$here/build"
mkdir -p "$out"
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$repo:/w" -w /w "$img" sh -euc '
  o=tools/paulanet-driver/build; fw=wifi-floppy/firmware/src
  vasmm68k_mot -quiet -m68000 -Faout -o $o/lz4_68k.o m68k/lz4/lz4_68k.asm
  F="-noixemul -m68000 -O2 -std=gnu11 -Wall -Werror -I tools/paulanet-driver/src -I $fw -I m68k/lz4 -I wifi-floppy/firmware/test"
  for c in tools/paulanet-driver/test/drvtest.c tools/paulanet-driver/src/webadf_lz4.c \
           $fw/pnet_lz4.c $fw/pnet_pack.c $fw/pnet_frame.c $fw/pnet_mfm.c; do
    m68k-amigaos-gcc $F -c -o $o/$(basename $c .c).o $c
  done
  m68k-amigaos-gcc -noixemul -m68000 -s -o $o/drvtest $o/drvtest.o $o/webadf_lz4.o $o/pnet_lz4.o $o/pnet_pack.o \
    $o/pnet_frame.o $o/pnet_mfm.o $o/lz4_68k.o'
py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
fail=0
for cpu in 68000 68020 68040; do
  "$py" - "$cpu" "$out/drvtest" > "$out/drvtest-$cpu.txt" 2>&1 <<'PY' || true
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
cpu, prog = sys.argv[1], sys.argv[2]
sys.argv = ['vamos', '-C', cpu, '-m', '8192', '-s', '64', prog]
sys.exit(main())
PY
  if grep -q '^RESULT: PASS' "$out/drvtest-$cpu.txt"; then
    echo "PASS: $cpu -- $(grep '^drvtest: cpu' "$out/drvtest-$cpu.txt"); $(grep '^drvtest: up' "$out/drvtest-$cpu.txt")"
  else
    echo "FAIL: $cpu"; tail -25 "$out/drvtest-$cpu.txt"; fail=1
  fi
done
exit $fail
```

- [ ] **Step 4: Run it to see it fail.**

Run: `tools/paulanet-driver/test.sh`
Expected: `tools/paulanet-driver/src/webadf_lz4.c: No such file or directory` from the container, non-zero exit.

- [ ] **Step 5: Write the LZ4 half.** Create `tools/paulanet-driver/src/webadf_lz4.c`:

```c
/* webadf_lz4.c: the LZ4 half of webadf's PaulaNET.device variant (webadf_lz4.h). Copyright (c) 2026 Stefan Skotte and
 * contributors. MIT licence. Written for vbcc (the driver) and m68k-amigaos-gcc (the tests) alike. */
#include <exec/types.h>
#include <exec/execbase.h>
#include "webadf_lz4.h"
#include "lz4_68k.h"

static void wl_copy(UBYTE *d, const UBYTE *s, ULONG n) { while (n--) *d++ = *s++; }

/* n bytes from 2n MFM bytes: the data bits at the 0x5555 positions, PaulaNET's order (the board's pnet_mfm_decode). */
static void wl_mfm_decode(const UBYTE *src, ULONG n, UBYTE *dst) {
    ULONG i;
    for (i = 0; i < n; i++) {
        UWORD d = (UWORD)((((UWORD)src[2 * i] << 8) | src[2 * i + 1]) & 0x5555);
        dst[i] = (UBYTE)((d >> 7) | d);
    }
}

ULONG wl_table_entries(UWORD attnFlags) {
    if (attnFlags & AFF_68040) return 4096;
    if (attnFlags & AFF_68020) return 1024;
    return 0;
}

ULONG wl_mem_bytes(UWORD attnFlags) {
    ULONG e = wl_table_entries(attnFlags);
    return 2 * e + WL_WINDOW + WL_BLOCK_MAX + (e ? WL_WINDOW + WL_BLOCK_MAX : 0);
}

void wl_init(struct WlRx *rx, struct WlTx *tx, UBYTE *mem, UWORD attnFlags) {
    ULONG e = wl_table_entries(attnFlags);
    tx->table = (UWORD *)mem;            /* first: the block is long aligned, the encoder wants an even table */
    tx->entries = e;
    mem += 2 * e;
    rx->win = mem;
    mem += WL_WINDOW;
    rx->scratch = mem;
    mem += WL_BLOCK_MAX;
    rx->pos = 0;
    tx->win = e ? mem : (UBYTE *)0;
    tx->out = e ? mem + WL_WINDOW : (UBYTE *)0;
    tx->pos = 0;
    tx->on = FALSE;
}

UWORD wl_wire_bytes(UWORD field) {
    if ((field & 0xC000) == 0xC000) return (UWORD)(2 * (field & 0x3FFF));
    return (UWORD)(field & 0x7FFF);
}

void wl_rx_begin(struct WlRx *rx) { rx->pos = 0; }
void wl_rx_break(struct WlRx *rx) { rx->pos = WL_BROKEN; }

const UBYTE *wl_rx_frame(struct WlRx *rx, UWORD field, const UBYTE *wire, UWORD orig) {
    UBYTE *dst;
    BOOL fits;
    if (orig == 0 || orig > WL_MTU) { rx->pos = WL_BROKEN; return (const UBYTE *)0; }
    fits = rx->pos <= WL_WINDOW && orig <= WL_WINDOW - rx->pos;
    if ((field & 0xC000) == 0xC000) {                     /* LZ4, MFM-encoded, linked to the batch's earlier frames */
        ULONG z = field & 0x3FFF;
        if (z == 0 || z > WL_BLOCK_MAX || !fits) { rx->pos = WL_BROKEN; return (const UBYTE *)0; }
        wl_mfm_decode(wire, z, rx->scratch);
        dst = rx->win + rx->pos;
        if (lz4_decode(rx->scratch, z, dst, dst + orig, rx->win) != (long)orig) {
            rx->pos = WL_BROKEN;
            return (const UBYTE *)0;
        }
        rx->pos += orig;
        return dst;
    }
    if ((ULONG)(field & 0x7FFF) < 2UL * orig) { rx->pos = WL_BROKEN; return (const UBYTE *)0; }  /* MFM: 2 per byte */
    if (!fits) {                                           /* outside the window: nothing later may link to it */
        rx->pos = WL_BROKEN;
        wl_mfm_decode(wire, orig, rx->scratch);
        return rx->scratch;
    }
    dst = rx->win + rx->pos;
    wl_mfm_decode(wire, orig, dst);
    rx->pos += orig;
    return dst;
}

void wl_tx_begin(struct WlTx *tx, UBYTE statusReserved) {
    tx->pos = 0;
    tx->on = tx->entries != 0 && (statusReserved & WL_ST_LZ4_IN) != 0;
}

ULONG wl_zero_run(const UBYTE *p, ULONG n) {
    ULONG run = 0, best = 0;
    while (n--) {
        if (*p++ == 0) { if (++run > best) best = run; }
        else run = 0;
    }
    return best;
}

UWORD wl_tx_frame(struct WlTx *tx, const UBYTE *data, UWORD len, UBYTE *body, UWORD rleLen) {
    UBYTE *at;
    ULONG z;
    if (!tx->on || tx->pos > WL_WINDOW) return 0;
    if (len > WL_WINDOW - tx->pos) { tx->pos = WL_BROKEN; return 0; }   /* past the window: RLE to the batch's end */
    at = tx->win + tx->pos;
    wl_copy(at, data, len);                                /* every frame joins the window, RLE ones too */
    tx->pos += len;
    if (rleLen < 2) return 0;
    z = lz4_encode_linked(at, len, tx->out, (ULONG)rleLen - 1, tx->table, tx->entries, tx->win);
    if (z == 0 || wl_zero_run(tx->out, z) > WL_ZERO_RUN_MAX) return 0;
    wl_copy(body, tx->out, z);
    if (z & 1) body[z] = 0;                                /* the word pad; the size word keeps the block's length */
    return (UWORD)z;
}
```

- [ ] **Step 6: Run the tests to see them pass.**

Run: `tools/paulanet-driver/test.sh`
Expected:

```
PASS: 68000 -- drvtest: cpu attn 0000, upload table 0; drvtest: up 0 of 7 frames LZ4
PASS: 68020 -- drvtest: cpu attn 0003, upload table 1024; drvtest: up <4..6> of 7 frames LZ4
PASS: 68040 -- drvtest: cpu attn 007f, upload table 4096; drvtest: up <4..6> of 7 frames LZ4
```

exit 0.

- [ ] **Step 7: Commit.**

```bash
git add tools/paulanet-driver/src/webadf_lz4.h tools/paulanet-driver/src/webadf_lz4.c \
        tools/paulanet-driver/test/drvtest.c tools/paulanet-driver/test.sh
git commit -m "paulanet-driver: the LZ4 half (per-CPU gate, linked decode/encode, zero-run guard), vamos-tested

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 6: The variant: the patch to Rob's code and its reproducible build

The spec says "-m68000" with the amiga-gcc image. Rob's sources are vbcc code (`device.h` uses `__reg("a0")`, which
m68k-amigaos-gcc refuses), and that image also ships vbcc (`vc`, `vasmm68k_mot`, `vlink`). His Makefile with that vbcc
and the AmigaOS 3.2 NDK R4 headers rebuilds his 0afd5fa sources to the same 12,808 bytes every time (checked
2026-10-18), so the variant is built that way: `vc -cpu=68000`, one binary for every 68k.

**Files:**
- Create: `tools/paulanet-driver/webadf-lz4.patch`, `tools/paulanet-driver/build.sh`,
  `tools/paulanet-driver/driver.sha256`, `tools/paulanet-driver/dist/PaulaNET.device`,
  `.github/workflows/paulanet-driver.yml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `third-party/paulanet/src/NetDevice` (Task 1); `webadf_lz4.{c,h}` (Task 5); `m68k/lz4/lz4_68k.{asm,h}`.
- Produces: `tools/paulanet-driver/dist/PaulaNET.device` (the variant, version string
  `PaulaNET.device 1.1-webadf-lz4`), pinned in `tools/paulanet-driver/driver.sha256`;
  `tools/paulanet-driver/build.sh <out> [--pin]` and `STOCK=1 tools/paulanet-driver/build.sh <out>`.

- [ ] **Step 1: Write the build script.** Create `tools/paulanet-driver/build.sh` (and `chmod +x` it):

```bash
#!/usr/bin/env bash
# Builds webadf's PaulaNET.device variant (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §4): Rob
# Smith's NetDevice at 0afd5fa (third-party/paulanet/src/NetDevice, unchanged), webadf-lz4.patch, src/webadf_lz4.c/.h
# and m68k/lz4 (both MIT, ours), by his own Makefile with the vbcc in the pinned amiga-gcc image (vc -cpu=68000: one
# binary for every 68k, the 68020 upload path chosen at run time) and the AmigaOS 3.2 NDK R4 headers, downloaded from
# Aminet and pinned (never committed: Hyperion's licence). Deterministic. Rob's own binary (13,872 B) is not what his
# source builds to (12,808 B, below), so the pin is ours: driver.sha256.
# Usage: tools/paulanet-driver/build.sh <out file> [--pin]   (--pin writes the pin; without it a mismatch fails)
#        STOCK=1 tools/paulanet-driver/build.sh <out file>   his sources alone, must give stock_sha (the toolchain check)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$1"; pin="${2:-}"
img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
ndk_url=https://aminet.net/dev/misc/NDK3.2.lha
ndk_sha=96cabd4ad683dced632e147bf86dee0f50dcb1254386216c25c362916a6409bb
stock_sha=7d14d9d1ecc3dc986b47120781bf091928c228c04c1cc3f5b9b8c24c1466a29b
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
cache="${PAULANET_NDK_CACHE:-$here/.cache}"
mkdir -p "$cache"
if [ ! -f "$cache/NDK3.2.lha" ] || [ "$(sha256 "$cache/NDK3.2.lha")" != "$ndk_sha" ]; then
  curl -fsSL --retry 3 -o "$cache/NDK3.2.lha" "$ndk_url"
fi
[ "$(sha256 "$cache/NDK3.2.lha")" = "$ndk_sha" ] || { echo "FAIL: $ndk_url is not the pinned NDK 3.2 R4 ($ndk_sha)"; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$repo/third-party/paulanet/src/NetDevice" "$tmp/src"
if [ "${STOCK:-}" != 1 ]; then
  ( cd "$tmp/src" && patch -p1 -s < "$here/webadf-lz4.patch" )
  cp "$here/src/webadf_lz4.c" "$here/src/webadf_lz4.h" "$repo/m68k/lz4/lz4_68k.asm" "$repo/m68k/lz4/lz4_68k.h" "$tmp/src/"
fi
cp "$cache/NDK3.2.lha" "$tmp/NDK3.2.lha"
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$tmp:/w" -w /w "$img" sh -euc '
  mkdir ndk && cd ndk && lha xq ../NDK3.2.lha >/dev/null && cd ../src
  make VBCC=/opt/amiga/m68k-amigaos/vbcc IPATH=-I/w/ndk/Include_H >/w/make.log 2>&1 || { tail -40 /w/make.log; exit 1; }'
cp "$tmp/src/PaulaNET.device" "$out"
got="$(sha256 "$out")"
echo "$got  $out ($(wc -c < "$out" | tr -d ' ') bytes)"
if [ "${STOCK:-}" = 1 ]; then
  [ "$got" = "$stock_sha" ] || { echo "FAIL: Rob's sources did not build to $stock_sha -- the toolchain or the NDK moved"; exit 1; }
  echo "PASS stock build"; exit 0
fi
LC_ALL=C grep -q 'PaulaNET.device 1.1-webadf-lz4' "$out" || { echo "FAIL: no 'PaulaNET.device 1.1-webadf-lz4' version string"; exit 1; }
if [ "$pin" = "--pin" ]; then echo "$got" > "$here/driver.sha256"; echo "pinned"; exit 0; fi
[ -f "$here/driver.sha256" ] || { echo "FAIL: no driver.sha256 -- run with --pin once the build is final"; exit 1; }
[ "$(cat "$here/driver.sha256")" = "$got" ] || { echo "FAIL: not the pinned binary ($(cat "$here/driver.sha256"))"; exit 1; }
echo "PASS pinned"
```

In `.gitignore`, after the `!tools/receive/dist/Receive` line add:

```
# The pinned PaulaNET.device variant is committed (plan 2026-10-18 Task 6); its NDK download and work copies are not.
!tools/paulanet-driver/dist/
tools/paulanet-driver/dist/*
!tools/paulanet-driver/dist/PaulaNET.device
tools/paulanet-driver/.cache/
tools/paulanet-driver/work/
```

- [ ] **Step 2: Prove the toolchain on Rob's sources alone.**

Run: `STOCK=1 tools/paulanet-driver/build.sh /tmp/stock.device`
Expected: `7d14d9d1ecc3dc986b47120781bf091928c228c04c1cc3f5b9b8c24c1466a29b  /tmp/stock.device (12808 bytes)`, `PASS stock build`.

- [ ] **Step 3: Run the variant build to see it fail.**

Run: `tools/paulanet-driver/build.sh /tmp/PaulaNET.device`
Expected: `patch: ... No such file or directory` (no `webadf-lz4.patch` yet), non-zero exit.

- [ ] **Step 4: Make two work copies of Rob's tree.**

```bash
rm -rf tools/paulanet-driver/work && mkdir -p tools/paulanet-driver/work
cp -R third-party/paulanet/src/NetDevice tools/paulanet-driver/work/a
cp -R third-party/paulanet/src/NetDevice tools/paulanet-driver/work/b
```

All edits below go into `tools/paulanet-driver/work/b/` only. Several of Rob's lines end in spaces; each `old` text
below stops before them, so match it as a substring.

- [ ] **Step 5: Patch `work/b/version.h`.** Replace `#define DEVICEEXTRA` with `#define DEVICEEXTRA -webadf-lz4`.

- [ ] **Step 6: Patch `work/b/Makefile`.** Replace `CPU = 68000` with:

```make
CPU = 68000
# webadf LZ4 (spec 2026-10-18 §4): the LZ4 half (webadf_lz4.c) and the 68000 codec (m68k/lz4, MIT)
ASMOBJECTS = webadf_lz4.o lz4_68k.o
```

and replace `include Common.mk` with (the recipe line starts with a TAB):

```make
include Common.mk

lz4_68k.o : lz4_68k.asm
	$(VASM) $(VASMFORMAT) -o $@ $<
```

- [ ] **Step 7: Patch `work/b/paulanetio.c` -- the include, the state, open and close.**
  - Replace `#include "paulanetstruct.h"` with
    `#include "paulanetstruct.h"` + newline + `#include "webadf_lz4.h"           // webadf LZ4: the LZ4 half (MIT; spec 2026-10-18)`.
  - Replace `    BOOL                        ackLastPacketData;` with:

```c
    BOOL                        ackLastPacketData;
    struct WlRx                 wlRx;            // webadf LZ4: the batch from the board, decoded back to back
    struct WlTx                 wlTx;            // webadf LZ4: the batch to the board (68020+)
    UBYTE*                      wlMem;           // ...one allocation behind both, wlMemSize bytes
    ULONG                       wlMemSize;
    UWORD                       wlAttn;          // SysBase->AttnFlags at open
```

  - Replace `    if (dev->compressionSpace) FreeMem(dev->compressionSpace, CHIPBUFFER_SIZE);` with:

```c
    if (dev->compressionSpace) FreeMem(dev->compressionSpace, CHIPBUFFER_SIZE);
    if (dev->wlMem) FreeMem(dev->wlMem, dev->wlMemSize);   // webadf LZ4
```

  - Replace `    // One extra block to backup pacxkets to be sent` with:

```c
    // webadf LZ4 (spec 2026-10-18 §4): its own window and buffers, sized by the CPU -- never Rob's compressionSpace.
    tmp->wlAttn = Sysbase->AttnFlags;
    tmp->wlMemSize = wl_mem_bytes(tmp->wlAttn);
    tmp->wlMem = (UBYTE*)AllocMem(tmp->wlMemSize, MEMF_PUBLIC);
    if (!tmp->wlMem) {
        paulaNetClose(tmp);
        return NULL;
    }
    wl_init(&tmp->wlRx, &tmp->wlTx, tmp->wlMem, tmp->wlAttn);

    // One extra block to backup pacxkets to be sent
```

- [ ] **Step 8: Patch `work/b/paulanetio.c` -- receiving.**
  - Replace `    dev->lastPicoCounter = header.picoCounter;` with
    `    dev->lastPicoCounter = header.picoCounter;` + newline + `    wl_rx_begin(&dev->wlRx);                 // webadf LZ4: this batch's window starts empty`.
  - Replace `int dataLength = cHeader.compressedSize & 0x7FFF;` with
    `int dataLength = wl_wire_bytes(cHeader.compressedSize);   // webadf LZ4: 0xC000|n is 2n bytes on the wire`.
  - Replace the two lines (the second ends where Rob's trailing spaces begin)

```c
            // MFM encoded
            mfmDecode(pkt, dataLength, (UBYTE*)dev->compressionSpace, CHIPBUFFER_SIZE);
```

    with

```c
            // MFM, or (webadf LZ4) an MFM-encoded LZ4 block: decoded into this batch's window
            const UBYTE* wlFrame = wl_rx_frame(&dev->wlRx, cHeader.compressedSize, (const UBYTE*)pkt, cHeader.originalSize);
```

  - Replace

```c
            callback(userContext, (UBYTE*)dev->compressionSpace, cHeader.originalSize);
        } else {
            // Compressed
```

    with

```c
            if (wlFrame) callback(userContext, (UBYTE*)wlFrame, cHeader.originalSize);
        } else {
            wl_rx_break(&dev->wlRx);   // webadf LZ4: raw RLE decodes outside the window; nothing may link past it
            // Compressed
```

- [ ] **Step 9: Patch `work/b/paulanetio.c` -- sending.**
  - Replace `    dev->packetCounter = 0; // temp storage for packet counter` with
    `    dev->packetCounter = 0; // temp storage for packet counter` + newline +
    `    wl_tx_begin(&dev->wlTx, dev->status.reserved);   // webadf LZ4: LZ4 uploads on 68020+ when status byte 155 says the board takes them`.
  - Replace

```c
        hdr.compressedSize = rleCompress(dev, (UBYTE*)data, packetLength, (UBYTE*)&dev->writePosition[sizeof(struct CompressionHeader)], (UBYTE*)dev->compressionSpace) | 0x8000;
        UWORD lastBit=0;
        mfmEncode((UBYTE*)&hdr, sizeof(hdr), (UWORD*)dev->writePosition, &lastBit);
        hdr.compressedSize &= 0x7FFF;
```

    with

```c
        UBYTE* wlBody = (UBYTE*)&dev->writePosition[sizeof(struct CompressionHeader)];
        hdr.compressedSize = rleCompress(dev, (UBYTE*)data, packetLength, wlBody, (UBYTE*)dev->compressionSpace);
        // webadf LZ4 (68020+, a board that takes it): the linked block replaces the RLE when it is shorter
        UWORD wlZ = wl_tx_frame(&dev->wlTx, (const UBYTE*)data, packetLength, wlBody, hdr.compressedSize);
        hdr.compressedSize = wlZ ? (UWORD)(WL_SIZE_LZ4 | wlZ) : (UWORD)(hdr.compressedSize | 0x8000);
        UWORD lastBit=0;
        mfmEncode((UBYTE*)&hdr, sizeof(hdr), (UWORD*)dev->writePosition, &lastBit);
        hdr.compressedSize = wlZ ? (UWORD)((wlZ + 1) & ~1) : (UWORD)(hdr.compressedSize & 0x7FFF);
```

  - Replace `    header->compressed = 2;` with
    `    header->compressed = 2 | WL_DRIVER_LZ4;   // webadf LZ4: "I decode LZ4" (0x10)`.

- [ ] **Step 10: Write the patch and check what it touches.**

```bash
(cd tools/paulanet-driver/work && diff -ruN a b > ../webadf-lz4.patch) || true
grep '^+++ ' tools/paulanet-driver/webadf-lz4.patch
```

Expected exactly three lines: `+++ b/Makefile`, `+++ b/paulanetio.c`, `+++ b/version.h` (each followed by a date).
`device.c` is not among them: `AttnFlags` is read in `paulaNetOpen`, in `paulanetio.c`.

- [ ] **Step 11: Build and pin the variant.**

```bash
tools/paulanet-driver/build.sh /tmp/PaulaNET.device --pin
tools/paulanet-driver/build.sh /tmp/PaulaNET2.device
cmp /tmp/PaulaNET.device /tmp/PaulaNET2.device && echo SAME
mkdir -p tools/paulanet-driver/dist && cp /tmp/PaulaNET.device tools/paulanet-driver/dist/PaulaNET.device
```

Expected: `<sha>  /tmp/PaulaNET.device (<about 19,000-21,000> bytes)` then `pinned`; the second run `PASS pinned`;
`SAME`. vbcc warnings in the log are Rob's; an error stops the script with the log's tail.

- [ ] **Step 12: CI.** Create `.github/workflows/paulanet-driver.yml`:

```yaml
name: paulanet-driver

# webadf's PaulaNET.device variant (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §4): the pinned
# toolchain first rebuilds Rob's stock driver to its known bytes, then the variant to its pin, which must be the
# committed binary the driver disk and the self-host image use. The vamos tests (test.sh) run on the Mac.
on:
  push:
    paths: ['tools/paulanet-driver/**', 'third-party/paulanet/src/**', 'm68k/lz4/**', '.github/workflows/paulanet-driver.yml']
  pull_request:
    paths: ['tools/paulanet-driver/**', 'third-party/paulanet/src/**', 'm68k/lz4/**', '.github/workflows/paulanet-driver.yml']
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: The toolchain rebuilds Rob's stock driver byte for byte
        run: STOCK=1 tools/paulanet-driver/build.sh "$RUNNER_TEMP/stock.device"
      - name: The variant builds to its pin
        run: tools/paulanet-driver/build.sh "$RUNNER_TEMP/PaulaNET.device"
      - name: The committed binary is that build
        run: cmp "$RUNNER_TEMP/PaulaNET.device" tools/paulanet-driver/dist/PaulaNET.device
```

- [ ] **Step 13: Re-run the vamos tests** (the patch does not change them, but the asm is now linked into vbcc code
too, and both must hold): `tools/paulanet-driver/test.sh`
Expected: the three `PASS:` lines of Task 5 Step 6.

- [ ] **Step 14: Commit.**

```bash
git status --short
git add .gitignore tools/paulanet-driver/build.sh tools/paulanet-driver/webadf-lz4.patch \
        tools/paulanet-driver/driver.sha256 tools/paulanet-driver/dist/PaulaNET.device \
        .github/workflows/paulanet-driver.yml
git commit -m "paulanet-driver: webadf's LZ4 build of Rob's PaulaNET.device (patch, reproducible vbcc build, pin, CI)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

---

### Task 7: Whole-branch review and the TEST firmware

**Files:**
- Create (untracked, main checkout root, beside `.fw-target.mts`): `.fw-notes.mts`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: a TEST firmware row (seq 99 or the next free number), notes starting `TEST build`, installed on the bench
  board `28:cd:c1:19:6a:38`; review findings fixed or ruled on.

- [ ] **Step 1: Whole-branch review.** Use superpowers:requesting-code-review on `master...feat/paulanet-lz4`, with
this plan's Global Constraints and Review Focus as the brief. Fix every Critical and Important finding with a test
first; then review the fixes themselves (fixes have been worse than findings here before). Record every finding,
ruling and deviation for the operator and for HANDOFF (Task 11).

- [ ] **Step 2: Every automated check, once more.**

```bash
wifi-floppy/firmware/test/run.sh
tools/netloop/build.sh test
tools/paulanet-driver/test.sh
tools/paulanet-driver/build.sh /tmp/PaulaNET.device
m68k/lz4/test.sh host build dec enc
```

Expected: no `FAIL`; `PASS: 68000/68020/68040`; `PASS pinned`; `test.sh: all steps passed: host build dec enc`.

- [ ] **Step 3: Build and publish the TEST firmware** (from the worktree root, with its `.env.local`):

```bash
pnpm firmware:build
pnpm firmware:publish --no-github --notes "TEST build -- PaulaNET LZ4 (spec 2026-10-18; plan 2026-10-18-paulanet-lz4), bench only"
```

Expected: the publish prints the version (`1.16.0+g<short sha>`) and its sequence.

- [ ] **Step 4: Read the notes back from the DB.** In `/Users/sfs/Devel/webadf` create `.fw-notes.mts`:

```ts
// The newest firmware row: its notes must start "TEST build" (releaseVisibleToSql) or every org is offered it.
import { desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
const [r] = await getDb().select({ seq: firmwareReleases.sequence, version: firmwareReleases.version, notes: firmwareReleases.notes })
  .from(firmwareReleases).orderBy(desc(firmwareReleases.sequence)).limit(1);
console.log(JSON.stringify(r));
process.exit(r?.notes?.startsWith('TEST build') ? 0 : 1);
```

Run (from `/Users/sfs/Devel/webadf`): `pnpm exec dotenv -e .env.local -- tsx .fw-notes.mts`
Expected: `{"seq":<n>,"version":"1.16.0+g<sha>","notes":"TEST build -- PaulaNET LZ4 ..."}`, exit 0. Exit 1 means
the row is visible to every org: fix its notes in the DB at once (HANDOFF 3bu incident).

- [ ] **Step 5: Start the serial log, then install.** The serial reader from 2026-10-17 is
`/private/tmp/claude-501/-Users-sfs-Devel-webadf/675c185f-947c-4752-b904-7630c037fa06/scratchpad/serstream.py`; if it
is gone, write this to `<scratchpad>/serstream.py` (the port may differ: `ls /dev/cu.usbmodem*`):

```python
import os, sys, time, termios
fd = os.open('/dev/cu.usbmodem1101', os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
a = termios.tcgetattr(fd); a[3] &= ~(termios.ICANON | termios.ECHO); termios.tcsetattr(fd, termios.TCSANOW, a)
out = open(sys.argv[2], 'ab', buffering=0); end = time.time() + float(sys.argv[1])
while time.time() < end:
    try:
        d = os.read(fd, 4096)
        if d: out.write(d)
    except BlockingIOError: pass
    time.sleep(0.05)
```

Run `python3 <scratchpad>/serstream.py 14400 <scratchpad>/serial-lz4.log` in the background (check first with
`pgrep -fl serstream.py` that none runs already). The install EJECTS the disk and PaulaNET holds the OTA: if the Amiga
is in use, ask the operator to switch it off first (end the turn); if it is idle, Ctrl+Alt+Del it through the PiKVM.
Then, from `/Users/sfs/Devel/webadf`:

```bash
pnpm exec dotenv -e .env.local -- tsx .fw-target.mts 1.16.0+g<sha>
```

Expected: `running <the board's current version> eject -> ...` and a JSON with no refusals; within ~90 s the log shows the new
version confirmed, `pnet: lz4 on (table 4096, 57 KB of PSRAM)`, and `records dropped` stays 0
(`grep -c 'records dropped' serial-lz4.log` must print 0 before any absence in the log is believed).

---

### Task 8: A500 bench (68000): downloads in LZ4, the stock driver unchanged, the variant on 1.15.0

The operator powers and types; the Amiga is driven through the PiKVM (https://www2.enhance-it.dk/kvm/). Batch the
steps; say when the Amiga can go off. `.lz4-bench.mts` queues production transfers: ask the operator before its
first run.

**Files:**
- Create (untracked, main checkout root): `.lz4-bench.mts`

**Interfaces:**
- Consumes: Task 6's `dist/PaulaNET.device`, Task 7's TEST firmware; Receive on the A500 (`SYS:Tools/Receive`,
  folder `SYS:Downloads`).
- Produces: the A500 results table (for HANDOFF 3bw).

- [ ] **Step 1: The bench script.** In `/Users/sfs/Devel/webadf` create `.lz4-bench.mts`:

```ts
// LZ4 bench (plan 2026-10-18 Task 8): queue one file for the bench board, wait for it, print the seconds.
// Usage: pnpm exec dotenv -e .env.local -- tsx .lz4-bench.mts <file> [amigaPath]   (writes production: transfers)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { diskStore } from '@/lib/storage';
import { queueTransferFromBlob } from '@/lib/transfers';

const [file, amigaPath] = process.argv.slice(2);
const db = getDb();
const [d] = await db.select({ id: devices.id, orgId: devices.orgId }).from(devices).where(eq(devices.macAddress, '28:cd:c1:19:6a:38'));
const bytes = new Uint8Array(readFileSync(file));
const sha = createHash('sha256').update(bytes).digest('hex');
if (!(await diskStore.stat(sha))) await diskStore.put(sha, bytes);
const q = await queueTransferFromBlob(db, { orgId: d.orgId, deviceId: d.id, userId: 'bench', path: amigaPath ?? basename(file), sha256: sha });
if (!q.ok) { console.error(JSON.stringify(q)); process.exit(1); }
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  const [t] = await db.select().from(transfers).where(eq(transfers.id, q.id));
  if (t.finishedAt) {
    console.log(JSON.stringify({ file: basename(file), bytes: bytes.length, status: t.status, savedAs: t.savedAs,
      seconds: (t.finishedAt.getTime() - t.createdAt.getTime()) / 1000 }));
    process.exit(t.status === 'delivered' ? 0 : 1);
  }
}
```

- [ ] **Step 2: The corpus** (in a bench folder, e.g. `B=$HOME/lz4-bench`):

```bash
mkdir -p "$B"
cp "adf-archive/Workbench31 - wbench31.adf" "$B/wb31.adf"           # an ADF, 901,120 B
lha aq2 "$B/wb31.lha" "$B/wb31.adf"                                 # an LHA: already compressed
cp HANDOFF.md "$B/handoff.txt"                                      # plain text
curl -fsSL -o "$B/gpl-3.0.html" https://www.gnu.org/licenses/gpl-3.0.html   # HTML
shasum -a 256 "$B"/*
```

- [ ] **Step 3: Stock driver against 1.16.0 = the baseline** (the board sends 1.15.0's bytes to it, Task 4's first
test). The A500 runs the driver from the current disk (Rob's). Ask the operator: Amiga on, Receive started on
`SYS:Downloads`, nothing else waiting (end the turn). Then for each of the four files run
`pnpm exec dotenv -e .env.local -- tsx .lz4-bench.mts "$B/<file>"` one after another, and after each one note the last
`pnet: l2 lz4 out` and `pnet: l2 lz4 in` lines of the serial log.
Expected: each `"status":"delivered"`; `driver stock`; `out lz4 0`; the ADF in about 130 s (HANDOFF 3bv). Record
seconds and the `wire` delta per file: this is the stock regression and the baseline in one.

- [ ] **Step 4: Install the variant on the A500.** Send it with Receive:
`pnpm exec dotenv -e .env.local -- tsx .lz4-bench.mts tools/paulanet-driver/dist/PaulaNET.device` (from the worktree
path, or copy the file to `$B` first). Ask the operator (end the turn) to type in a Shell:
`Copy SYS:Downloads/PaulaNET.device DEVS:Networks/` then `Version DEVS:Networks/PaulaNET.device`, and reboot.
Expected: `PaulaNET.device 1.1-webadf-lz4`; after the reboot the network comes up (the card: "Driver: talking") and
the log reads `driver lz4`.

- [ ] **Step 5: The same four files with the variant.** Repeat Step 3's runs.
Expected per file: `"status":"delivered"` (Receive checks each file's CRC-32 before it answers OK, so delivered
means intact; Task 9's upload round trip compares sha256 as well); `out lz4` rising for the text and HTML (most frames LZ4, `saved` large); the ADF faster
than its Step 3 time; the LHA's time within a few percent of Step 3 (its frames go MFM: `out mfm` rises, `out lz4`
barely); `lz4 in lz4 0` (a 68000 uploads RLE); `us max`, `budget` and `unenc` (the `lz4 out` line) noted. Record the table: file, bytes, seconds stock, seconds
LZ4, wire stock, wire LZ4.

- [ ] **Step 6: Decide on the hash table's home.** If `us max` stays above 3,000 us during the text and HTML runs,
or the `pnet: prep` max rose well above Step 3's, PSRAM is too slow for the table (spec §5): in `main.c` move
`g_lz4_table` out of PSRAM as `static uint16_t g_lz4_table[1024];`, pass `1024` in `g_lz4_mem`, drop its
`psram_check_address(&g_lz4_table[...])` term from the boot check (SRAM would fail it and switch LZ4 off) and the
`table 4096` in the boot line becomes `table 1024`; rebuild, publish as a new TEST row (Task 7 Steps 3-5), repeat
Step 5 and record both ratios. This is the one sanctioned exception to the 16-byte `.bss` limit (2 KB): the
`heap` reading in `pnet: l2 amiga ... heap` must stay at or above 20,480 B; if it drops below, stop and report to the
operator instead of keeping it. Otherwise keep 4,096 in PSRAM and record
the numbers.

- [ ] **Step 7: The variant against fw 1.15.0** (the disk goes to every board, 1.15.0 ones included). In
`/Users/sfs/Devel/webadf` create `.fw-seq.mts`:

```ts
// One firmware row by sequence: its version string, for .fw-target.mts.
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
const [r] = await getDb().select({ version: firmwareReleases.version, notes: firmwareReleases.notes })
  .from(firmwareReleases).where(eq(firmwareReleases.sequence, Number(process.argv[2])));
console.log(JSON.stringify(r));
process.exit(r ? 0 : 1);
```

Run `pnpm exec dotenv -e .env.local -- tsx .fw-seq.mts 96` (the 1.15.0 release); install that version as in Task 7
Step 5; send `handoff.txt`; then reinstall the TEST build the same way.
Expected: on 1.15.0 the text arrives (`delivered`), the variant reading MFM frames as Rob's driver did; then the TEST
build is back (`pnet: lz4 on`). If the install JSON lists a refusal for the older version, record it and skip this
step.

- [ ] **Step 8: Hand back.** Tell the operator the A500 can go off; leave the variant in `DEVS:Networks` (the disk
will carry it). Write the results into the notes for HANDOFF 3bw.

---

### Task 9: A4000D bench (68030): both directions

**Files:** none (results go to HANDOFF 3bw).

**Interfaces:**
- Consumes: Task 8's corpus and scripts; the board moved to the A4000D as DF1 by the operator.
- Produces: the A4000D results table; proof that uploads go LZ4 and arrive byte-identical.

- [ ] **Step 1: Ask the operator** (end the turn) to move the board to the A4000D as DF1 (DF1 Network), install the
variant there as in Task 8 Step 4 (send it, `Copy`, `Version`, reboot), start Receive, and say which TCP/IP stack and
ftp client the A4000D has.

- [ ] **Step 2: Downloads.** Repeat Task 8 Step 5 on the A4000D.
Expected: as on the A500 (faster overall); `cpu` irrelevant here (downloads are LZ4 on every CPU).

- [ ] **Step 3: An FTP server on the Mac for uploads.**

```bash
python3 -m pip install --user pyftpdlib
mkdir -p "$B/up" && python3 -m pyftpdlib -p 2121 -w -d "$B/up"
ipconfig getifaddr en0
```

- [ ] **Step 4: Uploads.** The operator (end the turn) uploads from the A4000D the four files Receive just saved:
`ftp <mac-ip> 2121`, user `anonymous`, `binary`, `put SYS:Downloads/handoff.txt handoff.txt` and the same for
`gpl-3.0.html`, `wb31.adf`, `wb31.lha`.
Expected: `shasum -a 256 "$B"/up/*` equals Step 2 of Task 8 file by file (byte-identical round trip through both LZ4
directions); the log's `pnet: l2 lz4 in lz4` rises during the text/HTML uploads, `bad 0`; no
`pnet: refused ... out of range` lines (the zero-run guard). Record each upload's time (the ftp client prints it).

- [ ] **Step 5: If uploads stall or the log shows refused captures** (`pnet: refused`, `bad ... oor`) while frames
are LZ4: raw LZ4 misreads the way raw RLE did downstream (spec §2). Record the evidence (log lines, counts); the
switch to `0xC000` MFM-wrapped uploads is then a driver change for a follow-up (the board already accepts it, Task 3).
Stop the bench there and report to the operator.

- [ ] **Step 6: Hand back.** Stop the FTP server and the serial logger (only their PIDs), tell the operator the A4000D
can go off and the board can return to the A500.

---

### Task 10: The driver disk carries the variant; the server's pin; rollout

**Files:**
- Modify: `tools/paulanet-disk/build.sh`, `tools/paulanet-disk/check.py`, `tools/paulanet-disk/ReadMe`,
  `tools/paulanet-disk/paulanet-disk.sha256`, `docker/Dockerfile`
- Modify: `src/lib/paulanet-disk.ts`, `src/lib/paulanet-disk.test.ts`, `src/lib/network-checklist.ts`,
  `src/lib/network-checklist.test.ts`, `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`,
  `src/app/api/paulanet-disk/route.ts` (doc comment)
- Modify: `THIRD-PARTY-NOTICES.md`

**Interfaces:**
- Consumes: `tools/paulanet-driver/dist/PaulaNET.device`, `driver.sha256` (Task 6); the bench passes (Tasks 8-9).
- Produces: a new `PAULANET_DISK_SHA256`; `PAULANET_DISK_PREVIOUS = 'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287'`;
  `export const PAULANET_DISK_OLDER: readonly string[]` (`[PAULANET_DISK_PREVIOUS, '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e']`).

The spec says the current disk becomes `PAULANET_DISK_PREVIOUS` with the rollout rule unchanged. With one
"previous" slot, the disk before Receive (`05170a83…`) would drop out: a board still holding it would be swapped at
once under a running Amiga, and the blob GC would delete it. So every older disk keeps the rule (`PAULANET_DISK_OLDER`).

- [ ] **Step 1: Write the failing server tests.** In `src/lib/paulanet-disk.test.ts`: add `PAULANET_DISK_OLDER` to
the import, and in `describe('the driver disk rollout (plan 2026-10-17 R16)'` replace the test
`'serves and keeps both digests, and nothing else'` with:

```ts
  it('serves and keeps the current disk and every older one, and nothing else (plan 2026-10-18)', () => {
    expect(PAULANET_DISK_OLDER).toEqual([PAULANET_DISK_PREVIOUS, '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e']);
    expect(PAULANET_DISK_PREVIOUS).toBe('fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287');
    for (const sha of [PAULANET_DISK_SHA256, ...PAULANET_DISK_OLDER]) {
      expect(isDriverDisk(sha)).toBe(true);
      expect(servedWithoutEntitlement(sha)).toBe(true);
    }
    expect(isDriverDisk('a'.repeat(64)) || isDriverDisk(null)).toBe(false);
    expect([...ALWAYS_REFERENCED_BLOBS].sort()).toEqual([PAULANET_DISK_SHA256, ...PAULANET_DISK_OLDER].sort());
  });
  it('leaves any older disk in DF1 while the Amiga runs, the disk before Receive too', () => {
    const before = PAULANET_DISK_OLDER[1];
    expect(driverDiskFor({ df1Sha256: before, netDriverSeenAt: new Date(NOW - 10_000) }, NOW)).toBe(before);
    expect(driverDiskFor({ df1Sha256: before, netDriverSeenAt: new Date(NOW - 600_001) }, NOW)).toBe(PAULANET_DISK_SHA256);
  });
```

In `src/lib/network-checklist.test.ts` the expected text in
`'names the older driver disk as in DF1, and says when the new one goes in (R16)'` becomes
`'Driver disk: in DF1 (an older one; the new one goes in once the Amiga is off)'`, and add in the same test:
`expect(driverDiskLine({ df1Sha256: '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e' }).ok).toBe(true);`.
In `src/lib/help/topics.test.ts` replace `/keeps the older driver disk, without Receive, until the Amiga has been off/`
with `/keeps its older driver disk until the Amiga has been off/` and add
`expect(bodyText('network')).toMatch(/LZ4/);` to the `network` topic's tests (beside the `href="/api/paulanet-disk"` check).

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm vitest run src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts src/lib/help/topics.test.ts`
Expected: FAIL (`PAULANET_DISK_OLDER` is undefined; texts differ).

- [ ] **Step 3: The disk carries the variant.** In `tools/paulanet-disk/build.sh`:
  - after the Receive check (`|| { echo "FAIL: tools/receive/dist/Receive is not the binary pinned ..."; exit 1; }`)
    add:

```bash
# The driver (spec 2026-10-18 §4): webadf's LZ4 build of Rob's PaulaNET.device, the committed pinned binary.
cp "$repo/tools/paulanet-driver/dist/PaulaNET.device" "$tmp/PaulaNET.device"
[ "$(sha256 "$tmp/PaulaNET.device")" = "$(cat "$repo/tools/paulanet-driver/driver.sha256")" ] \
  || { echo "FAIL: tools/paulanet-driver/dist/PaulaNET.device is not the binary pinned in tools/paulanet-driver/driver.sha256"; exit 1; }
```

  - `( cd "$tmp" && xdf disk.adf write Install + ...` becomes
    `( cd "$tmp" && xdf disk.adf delete PaulaNET.device + write PaulaNET.device + write Install + write Install.info + write ReadMe + write ReadMe.info \`
    (the rest of that command unchanged);
  - the driver check becomes:

```bash
xdftool "$tmp/disk.adf" read PaulaNET.device "$tmp/driver"
cmp -s "$tmp/driver" "$repo/tools/paulanet-driver/dist/PaulaNET.device" \
  && echo "PASS PaulaNET.device is webadf's LZ4 build (tools/paulanet-driver/dist)" \
  || { echo "FAIL: PaulaNET.device differs from tools/paulanet-driver/dist/"; exit 1; }
```

  - the header comment's first line gains: `PaulaNET.device is webadf's LZ4 build of Rob's driver (tools/paulanet-driver/).`

  In `tools/paulanet-disk/check.py`, `'PaulaNET.device': 13872` becomes `'PaulaNET.device': None` (build.sh compares
  the bytes). In `docker/Dockerfile`, after `COPY tools/receive/receive.sha256 tools/receive/receive.sha256` add:

```dockerfile
# The PaulaNET.device variant (plan 2026-10-18): the committed pinned build; build.sh checks it against driver.sha256.
COPY tools/paulanet-driver/dist/PaulaNET.device tools/paulanet-driver/dist/PaulaNET.device
COPY tools/paulanet-driver/driver.sha256 tools/paulanet-driver/driver.sha256
```

- [ ] **Step 4: The ReadMe names the variant.** In `tools/paulanet-disk/ReadMe` replace the paragraph from
`PaulaNET and its driver, PaulaNET.device, are by Rob Smith` through `MIT licence.` with:

```
PaulaNET and its driver, PaulaNET.device, are by Rob Smith
(RobSmithDev): https://github.com/RobSmithDev/PaulaNET
Copyright (c) 2026 RobSmithDev. All rights reserved.
The PaulaNET.device on this disk is webadf's build of his
driver (his source, commit 0afd5fa) with LZ4 compression
added: with board firmware 1.16.0, data the Amiga receives
travels compressed on every Amiga, and data it sends on a
68020 or faster. PaulaNET Config is his, unmodified. Both
are on this disk with his permission, under his terms; they
are not covered by webadf's MIT licence.
```

- [ ] **Step 5: Build the disk and pin it.**

```bash
tools/paulanet-disk/build.sh /tmp/PaulaNET.adf || true
```

Expected: `PASS PaulaNET.device is webadf's LZ4 build (tools/paulanet-driver/dist)`, `PASS Receive is the pinned
binary`, every check.py line `PASS`, then `FAIL: not the pinned disk (fb363d45…)` and the new digest on the line
before it. Write that digest into `tools/paulanet-disk/paulanet-disk.sha256`, run the build again.
Expected: no `FAIL`.

- [ ] **Step 6: The server's pin and the rollout rule.** In `src/lib/paulanet-disk.ts`:
  - `PAULANET_DISK_SHA256` becomes the new digest from Step 5;
  - replace the `PAULANET_DISK_PREVIOUS` doc comment and constant, `ALWAYS_REFERENCED_BLOBS` and `isDriverDisk` with:

```ts
/**
 * The driver disk before the LZ4 driver (plan 2026-10-18): Rob's stock PaulaNET.device and Receive (plan 2026-10-17).
 */
export const PAULANET_DISK_PREVIOUS = 'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287';
/**
 * Every older driver disk, newest first: PAULANET_DISK_PREVIOUS, then the disk before Receive (Phase 3). Each is still
 * valid: a board whose Amiga is online keeps it until the Amiga is off (driverDiskFor, R16), so it is served
 * (isDriverDisk: the board's net route and the person's /api/paulanet-disk?sha256=), kept by the blob GC
 * (ALWAYS_REFERENCED_BLOBS) and named on the card (driverDiskLine).
 */
export const PAULANET_DISK_OLDER: readonly string[] = [
  PAULANET_DISK_PREVIOUS, '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e',
];
```

```ts
/** Digests the blob GC keeps although no row names them (blob-gc-run.ts): every driver disk (R16). */
export const ALWAYS_REFERENCED_BLOBS: readonly string[] = [PAULANET_DISK_SHA256, ...PAULANET_DISK_OLDER];

export const isDriverDisk = (sha: string | null): boolean =>
  sha === PAULANET_DISK_SHA256 || (sha !== null && PAULANET_DISK_OLDER.includes(sha));
```

  - in `driverDiskFor`, the return becomes
    `return t.df1Sha256 !== null && PAULANET_DISK_OLDER.includes(t.df1Sha256) && recent ? t.df1Sha256 : PAULANET_DISK_SHA256;`
    and its doc's first sentence `A board holding the older disk keeps it` becomes `A board holding an older disk keeps it`;
  - in `netNextRearmCandidate`'s doc, `A board holding PAULANET_DISK_PREVIOUS` becomes `A board holding an older disk`.

  In `src/lib/network-checklist.ts`: import `PAULANET_DISK_OLDER` instead of `PAULANET_DISK_PREVIOUS`; the check becomes
  `if (d.df1Sha256 !== null && PAULANET_DISK_OLDER.includes(d.df1Sha256)) {` returning
  `{ ok: true, text: 'Driver disk: in DF1 (an older one; the new one goes in once the Amiga is off)' }`; its doc says
  `an older disk counts as in DF1 too`. In `src/app/api/paulanet-disk/route.ts` line 19's comment, `the older one,
  without Receive, is still` becomes `an older one is still`.

- [ ] **Step 7: The help text follows the behaviour.** In `src/lib/help/topics.tsx`:
  - in `network`'s `GoodToKnow`, replace `'PaulaNET is by Rob Smith (RobSmithDev), used with his permission.',` with

```tsx
          'With board firmware 1.16.0, the driver from the driver disk compresses with LZ4: what the Amiga receives on every Amiga, and what it sends on a 68020 or faster. Already-compressed files travel as before.',
          'PaulaNET is by Rob Smith (RobSmithDev), used with his permission. The driver disk carries webadf’s build of his driver, with LZ4 added.',
```

  - in `send`'s `GoodToKnow`, the older-disk line becomes
    `'A board whose Amiga was running when a new driver disk came out keeps its older driver disk until the Amiga has been off a while; then it gets the new one.',`
  - in the `network` topic's source comment add `LZ4: spec 2026-10-18 (fw 1.16.0, the variant on the driver disk).`

- [ ] **Step 8: The licence notice.** In `THIRD-PARTY-NOTICES.md` replace the sentence from `His driver binary,` to
`See \`third-party/paulanet/\`.` with:

```markdown
  His driver's source (`NetDevice/` at commit 0afd5fa, `third-party/paulanet/src/`, unchanged) is built with a webadf
  patch adding LZ4 (`tools/paulanet-driver/`) into the `PaulaNET.device` on the PaulaNET driver disk that the board
  serves in Network mode; his `PaulaNET Config` is on that disk unmodified. Both by his permission (2026-10-12) and
  under his own terms ("Copyright © 2026 RobSmithDev. All rights reserved."); they are not covered by webadf's MIT
  licence. The patch's own files (`tools/paulanet-driver/src/`) and `m68k/lz4/` are webadf's, MIT. See
  `third-party/paulanet/`.
```

- [ ] **Step 9: Run the tests to see them pass, then the rest.**

```bash
pnpm vitest run src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts src/lib/help/topics.test.ts
pnpm vitest run
pnpm exec tsc --noEmit
pnpm docker:smoke
```

Expected: all vitest files pass; tsc prints nothing; the smoke test prints `smoke: PaulaNET disk OK` and finishes.

- [ ] **Step 10: e2e for the touched areas, one at a time on PORT=3100** (each run under 9 minutes; serial, never in
parallel with another run on this machine):

```bash
PORT=3100 pnpm exec playwright test e2e/second-drive.spec.ts
PORT=3100 pnpm exec playwright test e2e/device-image.spec.ts
PORT=3100 pnpm exec playwright test e2e/help.spec.ts
```

Expected: all pass. A failure is first checked against a clean environment (no orphaned dev server on 3100) before
it is called a regression.

- [ ] **Step 11: Commit.**

```bash
git status --short
git add tools/paulanet-disk/build.sh tools/paulanet-disk/check.py tools/paulanet-disk/ReadMe \
        tools/paulanet-disk/paulanet-disk.sha256 docker/Dockerfile src/lib/paulanet-disk.ts \
        src/lib/paulanet-disk.test.ts src/lib/network-checklist.ts src/lib/network-checklist.test.ts \
        src/lib/help/topics.tsx src/lib/help/topics.test.ts src/app/api/paulanet-disk/route.ts THIRD-PARTY-NOTICES.md
git commit -m "paulanet-disk: the LZ4 driver on the disk; new pin; every older disk keeps the rollout rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
```

- [ ] **Step 12: Put the disk in the store before any server names it** (production blob store; additive, ask the
operator first): from the worktree,
`pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts /tmp/PaulaNET.adf`
Expected: `stored <key>, read back and verified` (or `already stored: ...`).

- [ ] **Step 13: Merge and push** (master is production; the variant is safe on 1.15.0 boards -- Task 8 Step 7 --
and boards holding an older disk keep it while their Amiga runs). From `/Users/sfs/Devel/webadf`:

```bash
git status --short                     # only the known untracked files
git checkout master && git pull --ff-only
git merge --no-ff feat/paulanet-lz4 -m "Merge feat/paulanet-lz4: PaulaNET LZ4 (fw 1.16.0 TEST, the LZ4 driver on the disk)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
git push origin master
```

Expected: the push succeeds; the `firmware`, `paulanet-driver`, `receive` and `image` workflows go green (check with
`gh run list --limit 6`). After the deploy: the bench board's card reads "Driver disk: in DF1" with the new digest
once its Amiga has been quiet 10 minutes.

---

### Task 11: The two Rob PRs (drafts) and HANDOFF 3bw

**Files:**
- Create: `tools/paulanet-driver/pr/0001-rle-to-mfm.patch`, `tools/paulanet-driver/pr/0002-lz4.patch`,
  `tools/paulanet-driver/pr/1-rle-to-mfm.md`, `tools/paulanet-driver/pr/2-lz4.md`
- Modify: `HANDOFF.md` (new section `### 3bw.` directly above `### 3bv.`)

**Interfaces:**
- Consumes: everything above; HANDOFF 3bu (the RLE stall evidence); the bench tables.
- Produces: two branches in a clone of RobSmithDev/PaulaNET (not pushed), their patches and PR bodies; HANDOFF 3bw.

- [ ] **Step 1: A clone for the PRs, outside webadf.** Run this task from `/Users/sfs/Devel/webadf` on master
(after Task 10's merge).

```bash
P=$HOME/Devel/PaulaNET-pr
git clone https://github.com/RobSmithDev/PaulaNET "$P"
git -C "$P" log --oneline -1 origin/main
```

If `origin/main` is still `0afd5fa`, both branches start there; if Rob has moved on, start them from `origin/main`
and note in each PR body the commit the work was tested against (0afd5fa).

- [ ] **Step 2: PR 1, the RLE -> MFM fix alone** (his Pico firmware sends RLE frames raw toward the Amiga; HANDOFF
3bu). `git -C "$P" checkout -b webadf/rle-to-mfm origin/main`. In `Pico/PaulaNET/PaulaNET.cpp`, in the loop that
"Compress[es] one pending packet per loop iteration", replace the whole
`if (settings.flags & FLAGS_PICO_COMPRESSION) { ... } else { ... }` block (from
`                if (settings.flags & FLAGS_PICO_COMPRESSION) {` to the `}` closing its `else`) with:

```cpp
                // Always MFM toward the Amiga. RLE bytes sent raw carry zero-bit runs of up to ~30 cells (MFM has at
                // most 3), and Paula misreads them: with this driver on an A500, every full-length read of such a
                // batch failed its checksum (640 of 640) and the link stalled; MFM-encoded, 78 of 79 read first time
                // and none failed (webadf, 2026-10-17). The driver already decodes MFM (bit 15 of the size).
                compressedRxQueue.packets[compressedRxQueue.writeIndex].length = rxQueue.packets[rxQueue.readIndex].length << 1;
                hdr.compressedSize = SWAP16(compressedRxQueue.packets[compressedRxQueue.writeIndex].length | 0x8000);  // MFM
                // Encode the header
                uint16_t lastBit = 0;
                mfmEncode((uint8_t*)&hdr, sizeof(hdr), (uint16_t*)compressedRxQueue.packets[compressedRxQueue.writeIndex].data, &lastBit);
                mfmEncode(rxQueue.packets[rxQueue.readIndex].data, rxQueue.packets[rxQueue.readIndex].length, (uint16_t*)outputPosition, &lastBit);
```

Then try his build: `cmake -S "$P/Pico/PaulaNET" -B /tmp/pnpico -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk && cmake --build /tmp/pnpico`.
Expected: it builds; if his CMake needs another SDK or board, record that and say "not compiled here" in the PR body.
Commit with the operator as author (`git -C "$P" commit -am "Pico: always MFM toward the Amiga (raw RLE is misread
by Paula)"`), then `mkdir -p tools/paulanet-driver/pr && git -C "$P" format-patch -1 --stdout > tools/paulanet-driver/pr/0001-rle-to-mfm.patch`.

- [ ] **Step 3: PR 2, LZ4 with the per-CPU table.** `git -C "$P" checkout -b webadf/lz4 origin/main`; then:

```bash
cp tools/paulanet-driver/src/webadf_lz4.c tools/paulanet-driver/src/webadf_lz4.h m68k/lz4/lz4_68k.asm m68k/lz4/lz4_68k.h "$P/NetDevice/"
cp m68k/lz4/LICENSE "$P/NetDevice/LICENSE-lz4"
patch -d "$P/NetDevice" -p1 < tools/paulanet-driver/webadf-lz4.patch
git -C "$P" checkout -- NetDevice/version.h        # his version string, not ours
```

Write `$P/NetDevice/LZ4.md` with the spec's §2 (wire format), §3 (capability exchange: byte 155, `0x10`) and the
per-CPU table from `webadf_lz4.h`, plus: "Your Pico firmware leaves byte 155 at 0, so with it this driver behaves
exactly as today (MFM down, RLE up); the board half is in webadf's firmware (`pnet_lz4.c`, `pnet_pack.c`, MIT) for you
to port." Build his tree with his Makefile in the pinned image (the NDK from `tools/paulanet-driver/.cache`, which
Task 6 filled):
`docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$P/NetDevice:/src" -v "$(pwd)/tools/paulanet-driver/.cache:/c:ro" -w /src stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f sh -euc 'mkdir -p /tmp/ndk && cd /tmp/ndk && lha xq /c/NDK3.2.lha >/dev/null && cd /src && make VBCC=/opt/amiga/m68k-amigaos/vbcc IPATH=-I/tmp/ndk/Include_H'`
Expected: `PaulaNET.device` builds. Remove the build outputs (`git -C "$P" status --short` shows only the intended
files), commit (`git -C "$P" add -A NetDevice && git -C "$P" commit -m "NetDevice: LZ4 both ways, per CPU (68020+
uploads), linked within a batch"` -- in Rob's clone only, never in webadf), and
`git -C "$P" format-patch -1 --stdout > tools/paulanet-driver/pr/0002-lz4.patch`.

- [ ] **Step 4: The PR bodies.** Write `tools/paulanet-driver/pr/1-rle-to-mfm.md`:

```markdown
**Pico: always MFM toward the Amiga**

Frames sent RLE-compressed toward the Amiga go out as raw bytes. RLE output has zero-bit runs of up to ~30 cells
where MFM has at most 3, and Paula's data separator misreads them. Measured on an A500 with your driver (a debug
build counting outcomes): every full-length read of such a batch failed its checksum, 640 of 640, while the sync was
found where it should be -- the link stalled after the first large delivery. With the frames MFM-encoded (bit 15 of
the size, which your driver already decodes), 78 of 79 read first time and none failed; 8 of 8 and 4 of 4
back-to-back file sends completed.

This change makes the Ethernet frames toward the Amiga always MFM. Nothing changes toward the Pico, nor for the
config and access-point tracks. Tested against your commit 0afd5fa; <compiled here / not compiled here: reason>.
```

and `tools/paulanet-driver/pr/2-lz4.md`:

```markdown
**NetDevice: LZ4, both ways where the CPU allows it**

| CPU | board -> Amiga | Amiga -> board |
|---|---|---|
| 68000 / 68010 | LZ4 | RLE |
| 68020 / 68030 | LZ4 (table 1,024) | LZ4 |
| 68040 / 68060 | LZ4 (table 4,096) | LZ4 |
| a driver without this change | MFM | RLE |

- Wire: bit 14 of a frame's size word marks a standard LZ4 block (bits 0-13: its length); toward the Amiga it is
  MFM-encoded (`0xC000 | n`), toward the board raw (`0x4000 | n`). A frame's matches may reach into the earlier
  frames of the same batch, never across batches. LZ4 is used only when the block is shorter than today's encoding.
- Capabilities: the driver sets `0x10` in `DataHeader.compressed` ("I decode LZ4"); the board says what it does in
  `LiveStatus.reserved` (bit 0 sends LZ4, bit 1 accepts it). With your current Pico firmware (byte 155 = 0) the
  driver behaves exactly as today.
- The 68000 LZ4 code (`lz4_68k.asm`, MIT, ours) is checked against liblz4 and its own C model under vamos;
  `webadf_lz4.c` (MIT) holds the logic, the patch to your files is a few lines in `paulanetio.c` and `Makefile`.
- Measured with webadf's board firmware 1.16.0 (which implements the board half): <the A500 and A4000D tables from
  HANDOFF 3bw>.
- `LZ4.md` describes the format; webadf's `pnet_lz4.c` / `pnet_pack.c` (MIT) are the board half, for the Pico.
```

- [ ] **Step 5: Show the operator.** List the two branches, the patches and bodies, and the bench numbers; do not
open either PR (the operator decides, spec §1).

- [ ] **Step 6: HANDOFF 3bw.** Insert directly above `### 3bv.` a section
`### 3bw. PaulaNET LZ4: fw 1.16.0 TEST seq <n>, the LZ4 driver on the disk (master <sha>) -- 2026-10-<dd>` holding:
spec and plan paths; what shipped (firmware, driver variant and its build, disk digest and `PAULANET_DISK_OLDER`);
the TEST seq and its notes read back; the A500 table (file, bytes, seconds stock vs LZ4, wire stock vs LZ4, `us max`)
and the A4000D table (downloads, uploads, sha256 round trip); the hash-table decision (Task 8 Step 6); every review
finding, ruling and deviation (including: the vamos proof in place of the UAE harness, vbcc in place of gcc, the
zero-run guard, `PAULANET_DISK_OLDER`, the driver tree only imported, `device.c` unpatched); open items -- releasing
1.16.0 (operator decision), the two PRs (drafts in `tools/paulanet-driver/pr/`), `0xC000` uploads if Task 9 Step 5
fired. Then:

```bash
git add HANDOFF.md tools/paulanet-driver/pr
git commit -m "HANDOFF 3bw: PaulaNET LZ4 -- benches, the disk rollout, the two Rob PR drafts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DQ9az2GKKN2vwaP5M3jctk"
git push origin master
```

Expected: the push succeeds (a docs-only change; the image workflow rebuilds unchanged).
