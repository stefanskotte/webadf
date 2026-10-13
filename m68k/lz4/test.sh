#!/usr/bin/env bash
# lz4_68k tests: the C model against liblz4 on the host, then the asm under vamos (an emulated
# 68000), then the cycle bench. Copyright (c) 2026 Stefan Skotte and contributors. MIT licence.
#
#   m68k/lz4/test.sh [STEP...]     no STEP: all of them, in this order
#     host    C model round trips with liblz4 (corpus, every length 1..1518, edge cases, linked)
#             and writes the decoder vectors
#     build   assembles lz4_68k.asm (-Faout and -Fhunk) and links test/vtest (bebbo gcc)
#     dec     decoder: every liblz4 block of the corpus (fast, HC 9, linked fast, linked HC 9)
#             at every src/dst parity, guards, short dst; the same with a window below $10000
#     fuzz    decoder: random frames at every parity, truncated / corrupted / random blocks
#     enc     encoder: asm == C model on the corpus (per frame and linked; 1K and 4K tables)
#     encr    encoder: asm == C model on every length 1..1518 at every parity, caps
#     tail    no read past the end of the input (memory trace of a guard region)
#     odd     no word or long access at an odd address (memory trace)
#     bench   cycles per byte (tools/lz4-measure/m68k/build.sh BENCH68K=1); prints the table
#
# Needs: Docker (the amigadev/crosstools m68k-amigaos image, pinned below), amitools' vamos,
# a host cc, curl. The corpus: tools/lz4-measure/build/corpus.bin (made by
# tools/lz4-measure/build.sh; CORPUS=path overrides); the bench also needs its frames dump.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/build"
lm="$root/tools/lz4-measure"
corpus="${CORPUS:-$lm/build/corpus.bin}"
IMG='amigadev/crosstools@sha256:bf5c0e37d2b60cf2aca93225558a7b6357e4598f8c82d04cdcb6a8268c9035d1'
mkdir -p "$out/vols"
steps=("$@")
[ ${#steps[@]} = 0 ] && steps=(host build dec fuzz enc encr tail odd bench)

ext="$lm/build/ext"
"$lm/fetch.sh" "$ext"                      # the reference liblz4 v1.10.0 (BSD-2), pinned

py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
vam() {   # [-t] args... : run test/vtest under vamos (8 MB, 64 KB stack)
  local tr=()
  [ "${1:-}" = -t ] && { tr=(-t); shift; }
  (cd "$out/vols" && "$py" - "$out/vols" "$out/vtest" "${tr[@]+"${tr[@]}"}" "$@" <<'PY'
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
vols, prog = sys.argv[1], sys.argv[2]
rest = sys.argv[3:]
tr = []
if rest and rest[0] == '-t':
    tr = ['-t']; rest = rest[1:]
sys.argv = ['vamos', '--vols-base-dir', vols, '-m', '8192', '-s', '64'] + tr + [prog] + rest
sys.exit(main())
PY
  )
}
pass() {  # name output-file
  if grep -q '^RESULT: PASS' "$2"; then echo "PASS: $1 ($(grep -E '^vtest .*checks' "$2" | tail -1))"
  else echo "FAIL: $1"; tail -25 "$2"; exit 1; fi
}

for s in "${steps[@]}"; do
  case "$s" in
  host)
    [ -s "$corpus" ] || { echo "no corpus at $corpus: run tools/lz4-measure/build.sh (NO_LIVE=1 works)"; exit 1; }
    cc -std=c11 -O2 -Wall -Wextra -Werror -I"$ext/lz4" -o "$out/host_test" "$here/test/host_test.c" \
       "$here/lz4_68k.c" "$ext/lz4/lz4.c" "$ext/lz4/lz4hc.c"
    "$out/host_test" "$corpus" "$out/vols" | tee "$out/host.txt"
    grep -q '^RESULT: PASS' "$out/host.txt" || { echo "FAIL: host"; exit 1; }
    echo "PASS: host"
    ;;
  build)
    docker run --rm -v "$root":/work -w /work "$IMG" sh -euc '
      m=m68k/lz4; o=$m/build/obj; e=tools/lz4-measure/build/ext/lz4
      mkdir -p $o
      vasmm68k_mot -quiet -m68000 -Fhunk -o $o/lz4_68k.hunk $m/lz4_68k.asm
      vasmm68k_mot -quiet -m68000 -Faout -o $o/lz4_68k.o $m/lz4_68k.asm
      F="-noixemul -m68000 -O2 -std=gnu11 -Wall -Werror -I $e"
      m68k-amigaos-gcc $F -c -o $o/lz4.o $e/lz4.c
      m68k-amigaos-gcc $F -c -o $o/lz4_68k_c.o $m/lz4_68k.c
      m68k-amigaos-gcc $F -c -o $o/vtest.o $m/test/vtest.c
      m68k-amigaos-gcc -noixemul -m68000 -s -o $m/build/vtest $o/vtest.o $o/lz4_68k.o $o/lz4_68k_c.o $o/lz4.o
    '
    echo "PASS: build (lz4_68k.asm: -Faout and -Fhunk; $(wc -c < "$out/obj/lz4_68k.hunk" | tr -d ' ') bytes of hunk object)"
    ;;
  dec)
    for v in fast hc9 linkf link9; do
      vam DEC "dec-$v.vec" > "$out/dec-$v.txt" 2>&1 || true; pass "dec $v" "$out/dec-$v.txt"
    done
    vam LOWWIN dec-linkf.vec > "$out/dec-lowwin.txt" 2>&1 || true; pass "dec lowwin" "$out/dec-lowwin.txt"
    ;;
  fuzz)
    for seed in 1 2 3 4; do
      vam FUZZ "$seed" 400 > "$out/fuzz-$seed.txt" 2>&1 || true; pass "fuzz seed $seed" "$out/fuzz-$seed.txt"
    done
    ;;
  enc)
    for e in 1024 4096; do
      for v in fast linkf; do
        vam ENC "dec-$v.vec" "$e" > "$out/enc-$v-$e.txt" 2>&1 || true; pass "enc $v $e" "$out/enc-$v-$e.txt"
      done
    done
    ;;
  encr)
    for r in "1 380" "381 760" "761 1140" "1141 1518"; do
      set -- $r
      vam ENCR "$1" "$2" > "$out/encr-$1.txt" 2>&1 || true; pass "encr $1..$2" "$out/encr-$1.txt"
    done
    ;;
  tail)
    vam -t TAIL > "$out/tail.txt" 2> "$out/tail.trace" || true
    pass "tail run" "$out/tail.txt"
    read -r lo hi < <(sed -n 's/^GUARD \([0-9a-f]*\) \([0-9a-f]*\)/\1 \2/p' "$out/tail.txt")
    # every access the program made inside the guard region (it never touches it itself)
    python3 - "$lo" "$hi" "$out/tail.trace" > "$out/tail.err" <<'PY' || { echo "FAIL: a read past the end of the input"; head -5 "$out/tail.err"; exit 1; }
import re, sys
lo, hi = int(sys.argv[1], 16), int(sys.argv[2], 16)
bad = 0
for line in open(sys.argv[3], errors='replace'):
    m = re.search(r' ([RW])\((\d)\): ([0-9a-f]+): ', line)
    if m:
        a = int(m.group(3), 16)
        if a + int(m.group(2)) > lo and a < hi:
            print(line.rstrip()); bad += 1
sys.exit(1 if bad else 0)
PY
    echo "PASS: tail (no read in the guard region after the input; $(grep -c ' R(' "$out/tail.trace") reads traced)"
    ;;
  odd)
    vam -t ODD > "$out/odd.txt" 2> "$out/odd.trace" || true
    pass "odd run" "$out/odd.txt"
    if grep -E ' [RW]\((2|4)\): [0-9a-f]*[13579bdf]: ' "$out/odd.trace" > "$out/odd.err"; then
      echo "FAIL: a word or long access at an odd address"; head -5 "$out/odd.err"; exit 1
    fi
    echo "PASS: odd (no word or long access at an odd address; $(grep -cE ' [RW]\(' "$out/odd.trace") accesses traced)"
    ;;
  bench)
    BENCH68K=1 "$lm/m68k/build.sh" "$lm/build/frames" "${REPS:-2}"
    ;;
  *) echo "unknown step $s"; exit 2 ;;
  esac
done
echo "test.sh: all steps passed: ${steps[*]}"
