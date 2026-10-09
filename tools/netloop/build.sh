#!/usr/bin/env bash
# PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
# Used with the author's permission (2026-10-09).
# NetLoop: the PaulaNET loopback probe for the A500 (plan
# docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md). Builds, in order:
#   1. the host test of the pure helpers (this machine's cc), and runs it;
#   2. tools/netloop/build/NetLoop with bebbo's m68k-amigaos-gcc 6.5, from a Docker image
#      pinned by digest (the same toolchain AmiTCP_NG builds with);
#   3. tools/netloop/build/NetLoop.adf with xdftool (amitools), to upload to the webadf library.
# `build.sh test` stops after 1. The codec is the board's own: wifi-floppy/firmware/src/
# pnet_mfm.c and pnet_frame.c, compiled unchanged for the 68000.
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
[ "${1:-}" = test ] && exit 0

docker run --rm -v "$root":/work -w /work "$IMG" m68k-amigaos-gcc --version | head -1
docker run --rm -v "$root":/work -w /work "$IMG" m68k-amigaos-gcc \
  -noixemul -m68000 -O2 -std=gnu11 -Wall -Werror -s \
  -I wifi-floppy/firmware/src -I tools/netloop \
  -o tools/netloop/build/NetLoop \
  tools/netloop/netloop.c tools/netloop/netloop_stats.c \
  wifi-floppy/firmware/src/pnet_mfm.c wifi-floppy/firmware/src/pnet_frame.c

rm -f "$out/NetLoop.adf"
xdftool "$out/NetLoop.adf" create + format NetLoop ffs + write "$out/NetLoop" NetLoop
xdftool "$out/NetLoop.adf" list
# The executable is reproducible (same digest, same sources -> same bytes). The ADF is not:
# xdftool stamps the volume and file dates with the time of the build.
shasum -a 256 "$out/NetLoop" "$out/NetLoop.adf"

# The selftest on an emulated 68000 (amitools' vamos, on this machine). It runs the shared codec
# big-endian, the way the A500 will. vamos 0.4.0 calls time.clock, which Python 3.9 removed; the
# shim puts it back for this run only. vamos has no E-clock, so the times print as 0.0 here.
if command -v vamos >/dev/null; then
  py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
  "$py" - "$out/NetLoop" 2>"$out/selftest.err" <<'PY' | tail -2 > "$out/selftest.txt" || true
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
sys.argv = ['vamos', sys.argv[1], 'SELFTEST']
sys.exit(main())
PY
  cat "$out/selftest.txt"
  if ! grep -q '^RESULT: PASS' "$out/selftest.txt"; then
    echo "FAIL: NetLoop SELFTEST under vamos"; cat "$out/selftest.err"; exit 1
  fi
else
  echo "selftest skipped: vamos not found"
fi
