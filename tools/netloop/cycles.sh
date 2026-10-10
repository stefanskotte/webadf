#!/usr/bin/env bash
# PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
# Used with the author's permission (2026-10-09).
# The codec stages' 68000 cycle counts, C against asm, from vamos (Musashi's 68000 timings; no
# chip-RAM wait states, no interrupts). Run tools/netloop/build.sh first. For each stage, input and
# size: vamos' total cycles for test_netloop_asm CYCLES with REPS calls, minus the same with 0
# calls, divided by REPS. Prints cycles per call, cycles per payload byte and the ms that makes on
# a 7.09 MHz A500. Usage: cycles.sh [reps] (default 2).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/build"
reps="${1:-2}"
py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
mkdir -p "$out/vamos-vols"
cyc() {   # stage impl input n reps -> total cycles
  "$py" - "$out/vamos-vols" "$out/test_netloop_asm" "$@" <<'PY' 2>&1 | sed -n 's/.*total cycles: //p'
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
sys.argv = ['vamos', '--vols-base-dir', sys.argv[1], '-m', '8192', '-l', 'main:info', sys.argv[2],
            'CYCLES'] + sys.argv[3:]
sys.exit(main())
PY
}
names=("rle enc" "mfm enc" "checksum" "build" "sync" "align" "mfm dec" "rle dec" "parse" "compare")
inputs=("random" "mixed" "zero")
for n in 1500 8000; do
  for k in 0 1 2; do
    base=$(cyc 0 0 "$k" "$n" 0)
    printf '\nN=%s %s: cycles per call (and per byte), ms at 7.09 MHz\n' "$n" "${inputs[$k]}"
    printf '%-9s %10s %6s %8s  %9s %6s %7s  %6s\n' stage "C" "c/B" "ms" "asm" "c/B" "ms" "x"
    for s in 0 1 2 3 4 5 6 7 8 9; do
      c=$(( ($(cyc "$s" 0 "$k" "$n" "$reps") - base) / reps ))
      a=$(( ($(cyc "$s" 1 "$k" "$n" "$reps") - base) / reps ))
      awk -v nm="${names[$s]}" -v c="$c" -v a="$a" -v n="$n" 'BEGIN {
        printf "%-9s %10d %6.1f %8.2f  %9d %6.1f %7.2f  %6.1f\n", nm, c, c / n, c / 7093.79,
               a, a / n, a / 7093.79, (a > 0 ? c / a : 0) }'
    done
  done
done
