#!/usr/bin/env bash
# The driver variant's LZ4 half (src/webadf_lz4.c + m68k/lz4/lz4_68k.asm) against the board's own C, built for the
# 68000 with the pinned m68k-amigaos image (the one m68k/lz4/test.sh uses) and run under amitools' vamos as a 68000, a
# 68020 and a 68040 (AttnFlags picks the upload table, as the driver does at open). vamos has no 68030: the 68020 run
# stands in for it (the same 1,024-entry table; the A4000D bench covers a real 68030). Then the 68000 and 68020 runs
# again under a memory trace: no word or long access at an odd address anywhere (vamos does not trap one; a real 68000
# does).
# Copyright (c) 2026 Stefan Skotte and contributors. MIT licence.
# Usage: tools/paulanet-driver/test.sh        Needs Docker and vamos (as m68k/lz4/test.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
img='amigadev/crosstools@sha256:bf5c0e37d2b60cf2aca93225558a7b6357e4598f8c82d04cdcb6a8268c9035d1'
out="$here/build"
mkdir -p "$out/vols"
docker run --rm -v "$repo:/w" -w /w "$img" sh -euc '
  o=tools/paulanet-driver/build; fw=wifi-floppy/firmware/src
  vasmm68k_mot -quiet -m68000 -Faout -o $o/lz4_68k.o m68k/lz4/lz4_68k.asm
  F="-noixemul -m68000 -O2 -std=gnu11 -Wall -Werror -I tools/paulanet-driver/src -I $fw -I m68k/lz4 -I wifi-floppy/firmware/test"
  for c in tools/paulanet-driver/test/drvtest.c tools/paulanet-driver/src/webadf_lz4.c \
           $fw/pnet_lz4.c $fw/pnet_pack.c $fw/pnet_frame.c $fw/pnet_mfm.c; do
    m68k-amigaos-gcc $F -c -o $o/$(basename $c .c).o $c
  done
  m68k-amigaos-gcc -noixemul -m68000 -s -o $o/drvtest $o/drvtest.o $o/webadf_lz4.o $o/pnet_lz4.o $o/pnet_pack.o \
    $o/pnet_frame.o $o/pnet_mfm.o $o/lz4_68k.o
  m68k-amigaos-objdump -d $o/webadf_lz4.o > $o/webadf_lz4.dis'
py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
vam() {   # cpu [-t] : run drvtest under vamos as that CPU (8 MB, 64 KB stack)
  (cd "$out/vols" && "$py" - "$out/vols" "$out/drvtest" "$@" <<'PY'
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
vols, prog, cpu = sys.argv[1], sys.argv[2], sys.argv[3]
tr = ['-t'] if sys.argv[4:5] == ['-t'] else []
sys.argv = ['vamos', '--vols-base-dir', vols, '-C', cpu, '-m', '8192', '-s', '64'] + tr + [prog]
sys.exit(main())
PY
  )
}
fail=0
for cpu in 68000 68020 68040; do
  case $cpu in 68000) table=0 ;; 68020) table=1024 ;; 68040) table=4096 ;; esac
  vam "$cpu" > "$out/drvtest-$cpu.txt" 2>&1 || true
  # The table this CPU must pick: a vamos CPU / AttnFlags change cannot silently skip (or force) the upload path.
  if grep -q '^RESULT: PASS' "$out/drvtest-$cpu.txt" && grep -q "upload table $table\$" "$out/drvtest-$cpu.txt"; then
    echo "PASS: $cpu -- $(grep '^drvtest: cpu' "$out/drvtest-$cpu.txt"); $(grep '^drvtest: up' "$out/drvtest-$cpu.txt")"
  else
    echo "FAIL: $cpu (want RESULT: PASS and upload table $table)"; tail -25 "$out/drvtest-$cpu.txt"; fail=1
  fi
done
[ -n "${NO_TRACE:-}" ] && exit $fail                     # NO_TRACE=1: the three runs only (mutation runs)
# The memory trace: the 68000 run (the download half, the board's packer and encoder) and the 68020 run (the upload
# half too, and the board's LZ4 decoder with its libnix memcpy literal copies at any address) -- one binary, so an odd
# access the 68020 forgives would be an address error on a 68000.
for cpu in 68000 68020; do
  vam "$cpu" -t 2>&1 >"$out/drvtest-odd-$cpu.txt" | python3 "$repo/m68k/lz4/test/tracecheck.py" odd \
    > "$out/drvtest-odd-$cpu.err" || true
  if grep -q '^RESULT: PASS' "$out/drvtest-odd-$cpu.txt" && ! grep -q '^BAD' "$out/drvtest-odd-$cpu.err" &&
     grep -q ' accesses traced, 0 bad$' "$out/drvtest-odd-$cpu.err" && ! grep -q '^0 accesses' "$out/drvtest-odd-$cpu.err"; then
    echo "PASS: $cpu odd (no word or long access at an odd address; $(tail -1 "$out/drvtest-odd-$cpu.err"))"
  else
    echo "FAIL: $cpu odd"; head -5 "$out/drvtest-odd-$cpu.err"; tail -5 "$out/drvtest-odd-$cpu.txt"; fail=1
  fi
done
exit $fail
