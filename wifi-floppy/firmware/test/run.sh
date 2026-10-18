#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
fail=0
# Device-only files are excluded by name:
#   main.c            - entry point, defines its own main()
#   transport_tls.c    } device-only network stack (lwIP/mbedTLS/cyw43);
#   sntp_time.c        } no host-portable logic to test
#   portal_net.c      - device-only network stack (lwIP raw UDP/TCP,
#                       cyw43_arch AP mode); no host-portable logic of its
#                       own -- everything it calls (dhcp_handle/dns_handle/
#                       portal_request) is already covered by its own
#                       host-tested source file
#   net_radio_cyw43.c - the CYW43 driver behind net_radio.h (spec 2026-10-04 §8);
#                       each function is one SDK call, nothing to judge on a host
#   dskchg.c          - pulls in pico/stdlib.h (gpio_put, absolute_time_t);
#                       genuinely device-only, no host-portable logic to test
#   activity_led.c    } bring-up aids on hand-wired pins: a GPIO write plus an
#   i2c_probe.c       } alarm, and an SDK i2c_read_timeout_us scan. Both are
#                       device-only by construction and hold no logic a host
#                       test could judge -- what they assert is about wiring,
#                       which only a board can answer.
#   nfc_bus_i2c.c     - the Si512's two i2c1 transfers (a register write, and
#                       an address-then-read). Device-only for the same reason
#                       as i2c_probe.c; the reader that drives them,
#                       nfc_reader.c, IS tested, against si512_fake.c.
#   bus_out.c         - the status gate's PIO state machine and the spinlock
#                       around its word. What that word MEANS -- which pins,
#                       which bits, what a step or sniffer sample decodes to --
#                       is in bus_gate.c, which is pure and IS tested.
#   flux_capture.c    - the PIO state machine and DMA ring that carry WDATA off
#                       the bus. Only a floppy bus can exercise those. Every
#                       DECISION the capture makes lives in flux_bits.c and
#                       mfm.c instead, which are pure and ARE tested -- the
#                       split is deliberate, so that "we could not test it"
#                       covers register writes and nothing else.
#   fw_rom.c - boot ROM, flash, watchdog; every decision it acts on
#                       lives in fw_trial.c / fw_apply.c / fw_update.c, which are tested
#   pnet_bridge.c     - PaulaNET Phase 1's lwIP/radio glue; its decisions are pnet_sort.c and pnet_ring.c
#   amiga_tcp.c       - PaulaNET Phase 4's lwIP TCP to Receive; its decisions are amiga_send.c
# image_loader.c used to be excluded here too: it called http_get_stream(),
# which only existed in http_fetch.c/.h (device-only, lwIP-backed), so
# including it would fail to link. Task 3 removed that dependency
# (image_load() and its http_fetch.h include are gone; the incremental
# image_parse_begin/feed/end parser is the host-testable replacement), so it
# now compiles into the host build like everything else. http_fetch.c/.h
# themselves were deleted in task 10, once device_client.c/main.c gave the
# real device-side network path (TLS + the §10 poll loop) a replacement for
# what they used to do.
#
# transport_fake.c (this directory) is test infrastructure -- a scriptable
# transport_t used by task 6+'s protocol-state-machine tests -- so it is
# compiled into every test binary alongside src/*.c, not excluded from it.
# si512_fake.c is the same kind of thing for nfc_reader.c: a register model
# of the Si512 with a scripted tag, linked into every test binary likewise.
# Vendored Monocypher 4.0.2 (src/vendor/monocypher/VENDORED.md): compiled once,
# warnings off -- it is not our code and is not edited -- and linked into every
# test binary. It lives under src/vendor/, so the ../src/*.c glob never sees it.
cc -std=c11 -O1 -w -c ../src/vendor/monocypher/monocypher.c -o .build/monocypher.o
cc -std=c11 -O1 -w -I../src/vendor/monocypher -c ../src/vendor/monocypher/monocypher-ed25519.c -o .build/monocypher-ed25519.o

# -pthread: test_pnet_ring.c runs a real producer thread against its consumer (Linux needs the flag).
# run.sh [test_x.c ...]: only those C tests (the source checks below always run); no arguments: all of them.
if [ $# -gt 0 ]; then tests=("$@"); else tests=(test_*.c); fi
for t in "${tests[@]}"; do
  out=".build/${t%.c}"
  # liblz4 (BSD-2) referees the board's LZ4 codec (spec 2026-10-18 §6); only test_pnet_lz4.c links it.
  # It also runs under ASan + UBSan: the decoder fuzz reads each block from a heap copy of exactly its length,
  # so a read past the block's end is an ASan report (an exit != 0), not a silent read of the next bytes.
  extra=""
  if [ "$t" = test_pnet_lz4.c ]; then
    extra="$(pkg-config --cflags --libs liblz4)" ||
      { echo "COMPILE FAIL: $t needs liblz4 (macOS: brew install lz4; Debian/Ubuntu: apt install liblz4-dev pkg-config)"; fail=1; continue; }
    extra="$extra -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer"
  fi
  # test_pnet_link.c too (no liblz4): the board decodes the Amiga's LZ4 frames into its window and scratch there,
  # and its tests put both on the heap at exactly their sizes, so a write past either is an ASan report.
  if [ "$t" = test_pnet_link.c ]; then
    extra="-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer"
  fi
  # -D_DEFAULT_SOURCE: strnlen (config_store.c) is POSIX.1-2008, not C11, and
  # glibc declares it only when a feature-test macro asks. macOS declares it
  # anyway, so this build passed there for months and failed the first time it
  # ran on Linux in CI. The device build is unaffected -- newlib declares it --
  # which is exactly why nothing caught it until a second toolchain did.
  cc -std=c11 -D_DEFAULT_SOURCE -g -O1 -pthread -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 -DWF_DF1_DEFAULT=0 \
     -o "$out" "$t" transport_fake.c si512_fake.c \
     $(ls ../src/*.c | grep -vE 'net_radio_cyw43\.c|main\.c|transport_tls\.c|sntp_time\.c|portal_net\.c|dskchg\.c|activity_led\.c|i2c_probe\.c|nfc_bus_i2c\.c|ssd1306\.c|flux_capture\.c|bus_out\.c|pnet_bridge\.c|fw_rom\.c|amiga_tcp\.c') \
     .build/monocypher.o .build/monocypher-ed25519.o -I../src/vendor/monocypher $extra \
     || { echo "COMPILE FAIL: $t"; fail=1; continue; }
  if ! "$out"; then
    rc=$?
    # 128+n means a signal: a segfault or an abort, not an assertion. Say so --
    # the difference between "a test failed" and "a test crashed" is the
    # difference between reading the report and reaching for a debugger.
    if [ "$rc" -gt 128 ]; then
      echo "CRASHED (signal $((rc - 128))): $t -- see the last test name printed above"
    fi
    fail=1
  fi
done

# The status outputs belong to the status_gate PIO (bus_out.h). Once PIO owns a
# pad, gpio_put() on it does NOTHING -- no error, no warning, just a line that
# never moves -- so a single call that slipped back in would be invisible on
# the bench. bus_out_set() is the only way to set one.
if grep -nE 'gpio_put\(PIN_(INDEX|CHNG|WPROT|RDY|TRK0|RDATA)\b' ../src/*.c; then
  echo "FAIL: gpio_put on a PIO-owned bus output (use bus_out_set)"
  fail=1
fi

# pico-sdk 2.3.0 release builds: pio_encode_mov with dest pio_osr or pio_exec
# is broken -- pio_osr == pio_exec (7) is remapped to pio_exec_mov (4) ==
# pio_pindirs, then to pio_pindirs_mov (3), so both emit `mov pindirs, x`
# (HANDOFF §3an). It switched RDY's output off on every HD drive-ID reload in
# 1.4.0 and looked like nothing at all. pio_encode_mov_not/_reverse do not
# remap and are correct, so they are not flagged. Every call is checked, not
# every line; // comments (and .pio `;` comment lines) are stripped first, so
# the comments that name the bug do not trip it.
pio_mov_bad=$(for f in ../src/*.c ../src/*.h ../src/*.pio; do
  sed -E -e 's#//.*##' -e 's#^[[:space:]]*;.*##' "$f" |
    { grep -noE 'pio_encode_mov[[:space:]]*\([[:space:]]*pio_(osr|exec)\b' || true; } | sed "s#^#$f:#"
done)   # no match is grep's exit 1: under set -e -o pipefail it would end the script
if [ -n "$pio_mov_bad" ]; then
  echo "$pio_mov_bad"
  echo "FAIL: pio_encode_mov(pio_osr|pio_exec, ...) encodes mov pindirs in pico-sdk 2.3.0 (build the word from the fields, as drive_id_load does)"
  fail=1
fi

# drive_id is shared by one state machine per drive (DF1, Task 8): a load
# rewritten in instr_mem would change EVERY drive's answer. Each SM's ID lives
# in its own Y (drive_id_y_sequence, drive_id.h).
if grep -n 'instr_mem\[' ../src/bus_out.c; then
  echo "FAIL: drive_id is shared by two SMs -- an ID lives in each SM's Y, never in instr_mem"; fail=1
fi

# M3 (spec 2026-09-22-firmware-update-device-design.md): once the board boots
# from a partition, the boot ROM's address translation maps only the booted
# slot at XIP_BASE. Reading anything else through XIP_BASE -- the config and
# token sectors at the top of flash -- HARD-FAULTS, measured on the bench.
# XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE reads physical flash in every layout.
if grep -nE 'XIP_BASE[[:space:]]*\+' ../src/*.c; then
  echo "FAIL: flash read through XIP_BASE (use XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE)"
  fail=1
fi

# Not a C binary: the firmware version header is produced by a CMake script
# (cmake/gen_version_header.cmake), so its test drives that script directly
# rather than linking anything.
if ! ./test_version_header.sh; then fail=1; fi

# Not C either: the single drag-and-drop first-install UF2 is packed by a
# python3 (stdlib) tool, so its test is a python unittest. It also checks the
# real build/wifi-floppy-install.uf2 when a build has produced one.
if ! python3 ../tools/test_make_install_uf2.py; then
  echo "FAIL: tools/test_make_install_uf2.py"
  fail=1
fi

# Spec 2026-10-04 §8: the WiFi chip sits behind net_radio.h. Only
# net_radio_cyw43.c may name it. Scope: ../src/*.c, ../src/*.h and
# ../lwipopts.h. // and single-line /* */ comments are stripped first:
# comments all over the tree explain the chip's behaviour, and that is
# welcome. The match is the bare chip name, case-insensitive, with no
# underscore or word boundary required, so every spelling counts: cyw43_state,
# CYW43_ITF_STA, PICO_CYW43_ARCH_POLL, #include "cyw43.h", pico/cyw43_arch.h.
radio_leak=$(for f in ../src/*.c ../src/*.h ../lwipopts.h; do
  case "$f" in */net_radio_cyw43.c) continue ;; esac
  sed -E -e 's#//.*##' -e 's#/\*.*\*/##g' "$f" |
    { grep -inE 'cyw43' || true; } | sed "s#^#$f:#"
done || true)
if [ -n "$radio_leak" ]; then
  echo "$radio_leak"
  echo "FAIL: the WiFi chip is named outside net_radio_cyw43.c (use net_radio.h)"
  fail=1
fi

# Spec 2026-10-04-oled-layouts §7: the editor's preview IS this renderer. A
# changed display source without a rebuilt module would preview pixels the
# board does not draw. The hash comes from the build script itself (--hash).
want=$(bash ../../../scripts/display-wasm.sh --hash)
have=$(cat ../../../src/lib/display-wasm.version 2>/dev/null || echo missing)
if [ "$want" != "$have" ]; then
  echo "FAIL: public/display.wasm is stale -- run pnpm display:wasm"
  fail=1
fi

# pio2's CTRL holds the enable bit of every state machine on the block, the radio's included, and
# the radio's SDK driver read-modify-writes it from core1 with no lock (cyw43_bus_pio_spi.c). Any
# enable or disable of ours racing one of those undoes the other (HANDOFF backlog, "pio2 CTRL";
# plan 2026-10-11 Task 1). So flux_in is enabled ONCE, in flux_capture_init, before core1 starts,
# and a capture is gated by its DMA channel. Comments are stripped first.
pio2_toggles=$(sed -E -e 's#//.*##' -e 's#/\*.*\*/##g' ../src/flux_capture.c |
  { grep -cE 'pio_sm_set_enabled|pio_set_sm_mask_enabled|pio_enable_sm_mask_in_sync|pio_enable_sm_multi_mask_in_sync' || true; })
if [ "$pio2_toggles" != 1 ]; then
  echo "FAIL: flux_capture.c writes flux_in's enable bit $pio2_toggles times (exactly 1, in flux_capture_init)"
  fail=1
fi

exit $fail
