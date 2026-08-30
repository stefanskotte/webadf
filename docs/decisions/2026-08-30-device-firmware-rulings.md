# Plan 4a rulings — device firmware protocol plane

Decisions taken during implementation, preserved here because the SDD ledger lives in
gitignored `.superpowers/` and does not survive the session. Same purpose as
`2026-08-29-device-plane-rulings.md` and `2026-08-30-device-ui-rulings.md`.

Plan: `docs/superpowers/plans/2026-08-30-device-firmware-protocol.md`. Spec:
`docs/superpowers/specs/2026-08-30-device-firmware-protocol-design.md`. Branch
`feat/device-firmware`, base `50e957b`.

**Pattern across this plan, worth knowing before writing the next one:** essentially every
defect found was in plan text — hand-counted `Content-Length` fixture values wrong in
three separate briefs (Tasks 6, 6 again, 8), a headline test that could not fail before
its own fix (Task 3), a test suite green against behaviour that did not exist (Task 7's
jitter, Task 9's whole TLS link), and a wrong SDK version pin (2.1.1 instead of 2.3.0).
None were implementer error on correct instructions.

## Rulings

**Ruling 1 (Task 3).** `test/test_psram_image.c` must be updated in the same change that
renames `TRACK_SLOT_BYTES` to `TRACK_MAX_BYTES` — Task 2's test used the old name, and the
rename would otherwise break the build in a way that looked like a Task 3 regression
rather than a missed reference.

**Ruling 2 (Task 3).** The plan's `test_oversized_track_is_refused` (a 13,313-byte track)
asserts nothing: the pre-fix guard already rejects anything over 13,312, so it passes
identically before and after the fix. Replaced with
`test_read_does_not_overflow_a_track_cache_sized_buffer` (a 13,100-byte track plus a
64-byte canary past the SRAM buffer, which the pre-fix memcpy overruns) and
`test_staging_buffer_is_at_least_the_max_accepted_track` (the static size relationship
that *is* the invariant). The 13,313-byte case is kept as a boundary test but is not
described as the defect test.

**Ruling 3 (Task 3).** The fix is to grow the SRAM staging buffer to `TRACK_MAX_BYTES`
(13,312), not to lower the accepted maximum to 13,000. Costs 312 bytes of SRAM twice
(624 bytes total, on a 520 KB part) but keeps the accepted image format as wide as it
already was.

**Ruling 4 (Task 1–9 builds).** `pnpm firmware:build` does not carry WiFi credentials —
`CMakeLists.txt` reads `$ENV{WIFI_SSID}`/`$ENV{WIFI_PASS}` and the npm script does not set
them, so tasks that only build (1–9) link with empty strings. Correct for those tasks;
Task 10 is where a credential-bearing build starts to matter, and plan 4b is where real
provisioning lands.

**Ruling 5 (Task 1).** pico-sdk pinned at **2.3.0**, not the plan's originally-specified
2.1.1. `hardware_psram` (which `psram_image.c` requires) and the board header's
`PICO_PSRAM_CS_PIN`/`PICO_PSRAM_SIZE_BYTES` do not exist before 2.3.0 — on 2.1.1 the
existing code cannot link at all. Verified against a real cloned SDK by both the
implementer and the reviewer independently.

**Ruling 6 (Task 1, superseded by Ruling 9).** Every dispatch that builds firmware must
prepend the toolchain to `PATH`, because a non-login shell resolves `arm-none-eabi-gcc` to
homebrew's newlib-less formula otherwise. Not hardcoded into the repo's npm script because
the toolchain path is machine-specific; `wifi-floppy/README.md` documents the requirement
instead. Also: a stale `wifi-floppy/firmware/build` directory left by a failed run poisons
the next attempt — `rm -rf` it when in doubt.

**Ruling 7 (Task 3).** Task 3 decouples `image_loader.c` from `http_fetch.h` — removing
the `#include` and the network-driving `image_load()` entry point, keeping only the pure
incremental parser plus `image_parse_buffer()` — rather than stubbing the dependency to
keep it host-buildable. Not scope creep: Task 10 deletes `http_fetch.c` outright anyway,
so this brings forward a deletion the plan already mandated. Fetching moved to
`device_client` (Task 6+), which is where the plan always intended it.

**Ruling 8 (Task 5→6).** Task 6's client must loop on partial `write()` returns, and prove
it with `fake_set_max_write()`, rather than only fixing the transport fake to be a more
faithful (harsher) socket simulator. Fixing only the fake would leave the capability gap
in the real client undetected.

**Ruling 9 (Task 6, supersedes Ruling 6).** Once the operator installed the official
`gcc-arm-embedded` cask mid-session, the correct `PATH` prefix became
`export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"`
(verified: clean rebuild 213/213, differs from the hand-expanded toolchain only in `.uf2`
size because of a different GCC point release). Homebrew's `arm-none-eabi-gcc` still
shadows it in a bare `which`, so the prefix is still required.
`wifi-floppy/README.md`'s build-requirements section already prescribes this ahead of
homebrew, so it needed no further doc change.

## Judgment calls endorsed on review, not overturned

Recorded because a later reader might otherwise "fix" them back:

- **Task 8:** the implementer closed a gap beyond its brief — an explicit `desired: null`
  now calls `psram_publish_slot(SLOT_NONE)` so `track_cache` actually stops streaming
  rather than only updating bookkeeping. This is what exposed Task 8's Critical (stale
  SRAM track served across a disk change) — see below.
- **Task 10:** moving track service from core1 to core0 was judged correct — `dc_step`
  blocking up to 30 s would strand the flux DMA if it ran there. Cross-core accounting
  improved as a result: no field became newly shared.
- **Task 10:** the streaming `begin/feed/end` PSRAM-image API (rather than the plan's
  whole-buffer `image_parse_buffer(slot, data, len)`) was necessary — a 160-track image is
  ~2.03 MB and cannot be buffered whole in SRAM. The plan's original shape was wrong for
  the real use case.
- **Task 6:** `writeProtected` on a poll response defaults to **true** when absent or
  malformed, decided before parsing. Reasoning: presenting a read-only disk as writable
  risks an unsanctioned write; the reverse only costs a retryable one.

## Two "green suite/build proved nothing" incidents worth remembering as a class

- **Task 7:** the only thing Task 7 introduced — jitter — was exercised by nothing. The
  clock never advanced past 0 in any test, so `now() % 250` was always 0; three different
  mutations (zeroing jitter, deleting the cap re-check, adding a stray backoff reset) all
  left the suite green. Fixed with exact-value jitter assertions, purely additive
  (0 deletions).
- **Task 9:** the TLS stack did not link at all — the build was green only because
  `main.c` never called `tls_transport()`, so `--gc-sections` discarded all of
  `transport_tls.c` and `sntp_time.c` silently. The shipped ELF contained zero mbedTLS
  symbols. Fixed by adding `target_link_options(-Wl,-u,tls_transport
  -Wl,-u,sntp_sync_blocking)`, and the fix was proven load-bearing by removing just those
  two flags and confirming the build still exits 0 while the whole TLS chain vanishes from
  the artifact.

Both are instances of the same failure class this project keeps finding: a gate — test,
build, or link — needs its own proof that it is capable of failing, not just evidence that
it currently passes.

## Deferred minor findings

None of these block plan 4b or plan 5, but whoever next touches the named file should
know about them. Carried verbatim in substance from the SDD ledger (`progress.md`).

- **Task 3.** The TS mirror (`src/lib/adfmfm/firmware-parser.ts`) now agrees with
  `readWfmf` on every constructible input, so — now that the defect it was built to
  reproduce is fixed — it adds no behavioural coverage beyond drift protection between the
  two parsers. Honest and documented in its own header.
- **Task 3, closed within this same plan (Task 10).** `main.c` called
  `dskchg_image_inserted()` unconditionally while no image was ever loaded (current
  firmware would have told the Amiga a disk is present with PSRAM empty). Flagged
  must-not-ship-this-way and fixed by Task 10's `track_cache_check_swap()`. Listed here
  only so the record shows it was closed, not dropped.
- **Task 6.** No `json_scan` regression test for the string-skipping property specifically
  (behaviour correct and exercised elsewhere; this one property unprotected). Folded into
  fix round 1 in substance; kept here for completeness.
- **Task 6, carried to Task 8/10.** `dc_desired_t.present` is written and never read;
  `DC_SWAPPING` is never entered; `DC_VERIFYING` is set and cleared within 3 lines. All
  three are scaffolding for behaviour plan 4b/5 will use, not bugs.
- **Task 6, carried to Task 8/10.** `write_protected` is computed in `device_client.c` but
  consumed nowhere — there is no `mounted_write_protected` field yet. It must reach the
  WPROT line eventually (plan 5, or write-back design) or the field stays decorative.
- **Task 6.** A *truncated* 400/404/422 response does not block digest dispatch, while a
  complete one does. Conservative and arguably correct (a truncated response is not a
  definitive answer), but uncovered by tests.
- **Task 7.** No test covers `dc_report_status`'s 401-halts path, unlike the tested
  poll/image 401 paths.
- **Task 8.** `psram_publish_slot` does not validate its `slot` argument; a value
  ≥ `SLOT_COUNT` would silently pack as `slot & 1` rather than being rejected downstream.
  Unreachable today — every caller passes `psram_inactive_slot()` or `SLOT_NONE`.
- **Task 9.** `gen_roots.sh:93` truncates `roots.pem` before its verify loop, so a pin
  failure on certs 2–5 leaves a truncated `roots.pem` on disk. Not a bypass (`roots.h`,
  the compiled artifact, is written only after all five pins pass, and the failure is
  loud), but the script should build into a temp location and move into place only after
  the loop succeeds.
- **Task 10.** M-3's torn-write magic sits at offset 0 of the first program page, so it
  catches the common torn write but is not proof against one that corrupts only the token
  bytes. A trailing magic or CRC would be strictly stronger.
- **Task 10.** On a slot→slot swap, the flux DMA is deliberately not stopped — safe only
  because `psram_publish_slot`'s contract is "complete, verified image". That is an
  undocumented dependency of `main.c` on that contract.
- **Task 10.** `dskchg_image_inserted()` fires on every republish. Correct today (publish
  happens only on a real 200 fetch or an eject), but a future path that republishes an
  unchanged image would spuriously re-assert `/CHNG`.

## Notable defects fixed during review (not deferred — recorded for context)

Two Critical findings surfaced only under `opus` review and are worth knowing even though
both are fixed, because they explain why several files look more defensive than their
briefs alone would suggest:

- **Task 8 Critical:** a stale SRAM track from the OLD disk could be served for the NEW
  one, because the SRAM cache tagged buffers by slot INDEX and slot indices are reused
  across disk generations. Fixed by publishing a generation token `(gen << 2) | slot` in
  one atomic word and tagging cache buffers with the whole token, not the bare index.
- **Task 10 Critical:** a disk swap or eject was invisible to core 0 until the Amiga next
  sought a different track — `want_track` doesn't change on a republish, so
  `track_cache_get()` was never re-entered and the old disk kept streaming, INDEX still
  pulsing, after an eject. Fixed by `track_cache_check_swap()`, called unconditionally at
  the top of core0's loop, keyed off the same generation token from the Task 8 fix.
