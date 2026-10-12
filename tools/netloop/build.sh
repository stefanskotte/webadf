#!/usr/bin/env bash
# PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
# Used with the author's permission (2026-10-09).
# NetLoop: the PaulaNET loopback probe for the A500 (plan
# docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md). Builds, in order:
#   1. the host test of the pure helpers (this machine's cc), and runs it;
#   2. tools/netloop/build/NetLoop and test_netloop_asm with bebbo's m68k-amigaos-gcc 6.5, from a
#      Docker image pinned by digest (the same toolchain AmiTCP_NG builds with);
#   3. tools/netloop/build/NetLoop.adf with xdftool (amitools), to upload to the webadf library;
#   4. under vamos: test_netloop_asm (asm codec == C reference), then NetLoop SELFTEST.
# `build.sh test` stops after 1. The C codec is the board's own: wifi-floppy/firmware/src/
# pnet_mfm.c and pnet_frame.c, compiled unchanged for the 68000; the hot routines run from
# tools/netloop/pnet_asm.S unless NETLOOP_CODEC=c.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/build"
# amigadev/crosstools:m68k-amigaos, the multi-arch index as of 2026-10-09 (linux/amd64 and
# linux/arm64). A tag can move; a digest cannot.
IMG='amigadev/crosstools@sha256:bf5c0e37d2b60cf2aca93225558a7b6357e4598f8c82d04cdcb6a8268c9035d1'
mkdir -p "$out"

cc -std=c11 -Wall -Wextra -Werror -O1 -I"$here" -o "$out/test_netloop_stats" \
   "$here/test_netloop_stats.c" "$here/netloop_stats.c"
"$out/test_netloop_stats"
fw="$root/wifi-floppy/firmware/src"
cc -std=c11 -Wall -Wextra -Werror -O1 -I"$here" -I"$fw" -o "$out/test_netloop_eth" \
   "$here/test_netloop_eth.c" "$here/netloop_eth.c" "$fw/pnet_sort.c" "$fw/pnet_status.c" "$fw/pnet_frame.c" "$fw/pnet_mfm.c"
"$out/test_netloop_eth"
[ "${1:-}" = test ] && exit 0

# NETLOOP_CODEC=asm (default) or c: which codec the plain pnet_* names are (pnet_asm.S). Both
# builds also carry the C reference (renamed X_c, plus an all-C frame pipeline X_allc) for the
# equivalence test and BENCH. pnet_mfm.c and pnet_frame.c themselves are not edited.
case "${NETLOOP_CODEC:-asm}" in asm) asm=1 ;; c) asm=0 ;; *) echo "NETLOOP_CODEC=asm|c"; exit 2 ;; esac
docker run --rm -v "$root":/work -w /work "$IMG" m68k-amigaos-gcc --version | head -1
docker run --rm -v "$root":/work -w /work "$IMG" sh -euc '
  asm="$1"; o=tools/netloop/build/obj; s=wifi-floppy/firmware/src; t=tools/netloop
  mkdir -p "$o"
  F="-noixemul -m68000 -O2 -std=gnu11 -Wall -Werror -I $s -I $t -DNETLOOP_ASM=$asm"
  C="-Dpnet_mfm_encode=pnet_mfm_encode_c -Dpnet_mfm_decode=pnet_mfm_decode_c
     -Dpnet_checksum=pnet_checksum_c -Dpnet_rle_encode=pnet_rle_encode_c
     -Dpnet_rle_decode=pnet_rle_decode_c"
  A="-Dpnet_find_sync=pnet_find_sync_allc -Dpnet_shift_left=pnet_shift_left_allc
     -Dpnet_err_text=pnet_err_text_allc -Dpnet_payload_bound=pnet_payload_bound_allc
     -Dpnet_to_amiga_bound=pnet_to_amiga_bound_allc -Dpnet_build_to_board=pnet_build_to_board_allc
     -Dpnet_build_to_amiga=pnet_build_to_amiga_allc
     -Dpnet_parse_hdr_from_amiga=pnet_parse_hdr_from_amiga_allc
     -Dpnet_parse_hdr_to_amiga=pnet_parse_hdr_to_amiga_allc
     -Dpnet_put_hdr_to_amiga=pnet_put_hdr_to_amiga_allc -Dpnet_parse_hdr_to_amiga_as=pnet_parse_hdr_to_amiga_as_allc
     -Dpnet_parse_frames=pnet_parse_frames_allc
     -Dpnet_frame_iter_init=pnet_frame_iter_init_allc -Dpnet_frame_iter_next=pnet_frame_iter_next_allc"
  m68k-amigaos-gcc $F $C -c -o $o/pnet_mfm_c.o $s/pnet_mfm.c
  m68k-amigaos-gcc $F -Dpnet_find_sync=pnet_find_sync_c -Dpnet_shift_left=pnet_shift_left_c \
    -c -o $o/pnet_frame.o $s/pnet_frame.c
  m68k-amigaos-gcc $F $C $A -c -o $o/pnet_frame_allc.o $s/pnet_frame.c
  m68k-amigaos-gcc $F -c -o $o/pnet_asm.o $t/pnet_asm.S
  for f in pnet_asm_tables netloop_stats netloop_eth netloop_equiv netloop_bench netloop test_netloop_asm; do
    m68k-amigaos-gcc $F -c -o $o/$f.o $t/$f.c
  done
  L="$o/pnet_mfm_c.o $o/pnet_frame.o $o/pnet_frame_allc.o $o/pnet_asm.o $o/pnet_asm_tables.o
     $o/netloop_stats.o $o/netloop_eth.o $o/netloop_equiv.o $o/netloop_bench.o"
  m68k-amigaos-gcc -noixemul -m68000 -s -o $t/build/NetLoop $o/netloop.o $L
  m68k-amigaos-gcc -noixemul -m68000 -s -o $t/build/test_netloop_asm $o/test_netloop_asm.o $L
' sh "$asm"

rm -f "$out/NetLoop.adf"
xdftool "$out/NetLoop.adf" create + format NetLoop ffs + write "$out/NetLoop" NetLoop
xdftool "$out/NetLoop.adf" list
# The executable is reproducible (same digest, same sources -> same bytes). The ADF is not:
# xdftool stamps the volume and file dates with the time of the build.
shasum -a 256 "$out/NetLoop" "$out/NetLoop.adf"

# The emulated 68000 (amitools' vamos, on this machine): first the asm codec against the C
# reference (test_netloop_asm; it must pass before anything else counts), then NetLoop SELFTEST.
# Both run big-endian, the way the A500 will. vamos 0.4.0 calls time.clock, which Python 3.9
# removed; the shim puts it back for these runs only. vamos has no E-clock, so the selftest's
# times print as 0.0 here. Its volumes live under build/, so a vamos run elsewhere cannot collide.
vamos_run() {
  "$py" - "$out/vamos-vols" "$@" <<'PY'
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
sys.argv = ['vamos', '--vols-base-dir', sys.argv[1], '-m', '8192'] + sys.argv[2:]
sys.exit(main())
PY
}
if command -v vamos >/dev/null; then
  py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
  mkdir -p "$out/vamos-vols"
  vamos_run "$out/test_netloop_asm" 2>"$out/equiv.err" > "$out/equiv.txt" || true
  cat "$out/equiv.txt"
  if ! grep -q '^RESULT: PASS' "$out/equiv.txt"; then
    echo "FAIL: test_netloop_asm under vamos"; cat "$out/equiv.err"; exit 1
  fi
  # The 68000 faults on a word or long access at an odd address; vamos does not. Its memory
  # trace (-t) logs every access as "R(2): 00a849: ...", so look for one.
  vamos_run -t "$out/test_netloop_asm" ODD 2>&1 >"$out/odd.txt" | grep -E ' [RW]\((2|4)\): [0-9a-f]*[13579bdf]: ' \
    > "$out/odd.err" || true
  cat "$out/odd.txt"
  if ! grep -q '^RESULT: PASS' "$out/odd.txt" || [ -s "$out/odd.err" ]; then
    echo "FAIL: a word or long access at an odd address"; head -5 "$out/odd.err"; exit 1
  fi
  vamos_run "$out/NetLoop" SELFTEST 2>"$out/selftest.err" > "$out/selftest.txt" || true
  cat "$out/selftest.txt"
  if ! grep -q '^RESULT: PASS' "$out/selftest.txt"; then
    echo "FAIL: NetLoop SELFTEST under vamos"; cat "$out/selftest.err"; exit 1
  fi
else
  echo "equivalence test and selftest skipped: vamos not found"
fi
