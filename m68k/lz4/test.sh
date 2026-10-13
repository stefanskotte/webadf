#!/usr/bin/env bash
# lz4_68k tests: the C model against liblz4 on the host, then the asm under vamos (an emulated
# 68000), then the cycle bench. Copyright (c) 2026 Stefan Skotte and contributors. MIT licence.
#
#   m68k/lz4/test.sh [STEP...]     no STEP: all of them, in this order
#     host    C model round trips with liblz4 (corpus, every length 1..1518, edge cases, linked)
#             and writes the decoder vectors
#     build   assembles lz4_68k.asm (-Faout and -Fhunk), checked and LZ4_68K_UNCHECKED_READS=1,
#             and links test/vtest and test/vtest_u (bebbo gcc)
#     dec     decoder, both builds: every liblz4 block of the corpus (fast, HC 9, linked fast,
#             linked HC 9) at every src/dst parity, guards, short dst; again with a low window
#     fuzz    decoder, both builds: random frames at every parity, truncated / corrupted /
#             random blocks (also with a window below $10000); the unchecked build is held to
#             write safety and the result's range only
#     big     decoder, both builds: runs of 65,535..65,540 bytes, truncated; entry checks
#     enc     encoder: asm == C model on the corpus (per frame and linked; 1K and 4K tables)
#     encr    encoder: asm == C model on every length 1..1518 at every parity, caps
#     encbig  encoder: asm == C model for n up to 65,535, windows reaching 65,536
#     tail    both builds: no read past the end of the input (memory trace of a guard region)
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
[ ${#steps[@]} = 0 ] && steps=(host build dec fuzz big enc encr encbig tail odd bench)

ext="$lm/build/ext"
"$lm/fetch.sh" "$ext"                      # the reference liblz4 v1.10.0 (BSD-2), pinned

py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
vam() {   # [-t] args... : run $VT (default vtest) under vamos (8 MB, 64 KB stack)
  local tr=()
  [ "${1:-}" = -t ] && { tr=(-t); shift; }
  (cd "$out/vols" && "$py" - "$out/vols" "$out/${VT:-vtest}" "${tr[@]+"${tr[@]}"}" "$@" <<'PY'
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
      # the LZ4_68K_UNCHECKED_READS=1 build, and vtest_u that knows it
      vasmm68k_mot -quiet -m68000 -Fhunk -DLZ4_68K_UNCHECKED_READS=1 -o $o/lz4_68k_u.hunk $m/lz4_68k.asm
      vasmm68k_mot -quiet -m68000 -Faout -DLZ4_68K_UNCHECKED_READS=1 -o $o/lz4_68k_u.o $m/lz4_68k.asm
      m68k-amigaos-gcc $F -DUNCHECKED -c -o $o/vtest_u.o $m/test/vtest.c
      m68k-amigaos-gcc -noixemul -m68000 -s -o $m/build/vtest_u $o/vtest_u.o $o/lz4_68k_u.o $o/lz4_68k_c.o $o/lz4.o
    '
    echo "PASS: build (lz4_68k.asm, checked and LZ4_68K_UNCHECKED_READS=1, each -Faout and -Fhunk; $(wc -c < "$out/obj/lz4_68k.hunk" | tr -d ' ') bytes of hunk object)"
    ;;
  dec)
    for VT in vtest vtest_u; do
      for v in fast hc9 linkf link9; do
        vam DEC "dec-$v.vec" > "$out/$VT-dec-$v.txt" 2>&1 || true; pass "$VT dec $v" "$out/$VT-dec-$v.txt"
      done
      vam LOWWIN dec-linkf.vec > "$out/$VT-dec-lowwin.txt" 2>&1 || true; pass "$VT dec lowwin" "$out/$VT-dec-lowwin.txt"
    done
    ;;
  fuzz)
    for VT in vtest vtest_u; do
      for seed in 1 2 3 4; do
        vam FUZZ "$seed" 400 > "$out/$VT-fuzz-$seed.txt" 2>&1 || true; pass "$VT fuzz seed $seed" "$out/$VT-fuzz-$seed.txt"
      done
      vam FUZZLOW 5 400 > "$out/$VT-fuzz-low.txt" 2>&1 || true; pass "$VT fuzz, window below \$10000" "$out/$VT-fuzz-low.txt"
    done
    ;;
  big)
    for VT in vtest vtest_u; do
      vam BIG > "$out/$VT-big.txt" 2>&1 || true; pass "$VT big (runs of 65535..65540, entry checks)" "$out/$VT-big.txt"
    done
    ;;
  encbig)
    vam ENCBIG > "$out/encbig.txt" 2>&1 || true; pass "encbig (n up to 65535)" "$out/encbig.txt"
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
   for VT in vtest vtest_u; do
    # The guard region's address comes from an untraced run (vamos loads the program at the same
    # addresses every time); the traced run's memory trace goes straight through a filter (it is
    # large), which reports every access inside the guard region after the input.
    vam TAIL > "$out/tail0.txt" 2>&1 || true
    read -r lo hi < <(sed -n 's/^GUARD \([0-9a-f]*\) \([0-9a-f]*\)/\1 \2/p' "$out/tail0.txt")
    vam -t TAIL 2>&1 >"$out/tail.txt" | python3 "$here/test/tracecheck.py" guard "$lo" "$hi" > "$out/tail.err" || true
    pass "tail run" "$out/tail.txt"
    grep -q "^GUARD $lo $hi" "$out/tail.txt" || { echo "FAIL: tail: the guard moved between runs"; exit 1; }
    if grep -q '^BAD' "$out/tail.err"; then echo "FAIL: a read past the end of the input"; head -5 "$out/tail.err"; exit 1; fi
    echo "PASS: $VT tail (no access in the guard region after the input; $(tail -1 "$out/tail.err"))"
   done
    ;;
  odd)
    vam -t ODD 2>&1 >"$out/odd.txt" | python3 "$here/test/tracecheck.py" odd > "$out/odd.err" || true
    pass "odd run" "$out/odd.txt"
    if grep -q '^BAD' "$out/odd.err"; then echo "FAIL: a word or long access at an odd address"; head -5 "$out/odd.err"; exit 1; fi
    echo "PASS: odd (no word or long access at an odd address; $(tail -1 "$out/odd.err"))"
    ;;
  bench)
    [ -d "$lm/build/frames" ] || { echo "no frames dump: run tools/lz4-measure/build.sh"; exit 1; }
    # One type per run (each a few minutes); BENCH_TYPES="..." picks some, BENCH_APPEND=1 adds
    # to the earlier rows instead of starting over.
    [ -n "${BENCH_APPEND:-}" ] || : > "$out/cycles-68k.txt"
    for t in ${BENCH_TYPES:-dl-ftp-text dl-ftp-source dl-http dl-ftp-adf dl-ftp-random ul-acks ul-ftp-text}; do
      BENCH68K=1 TYPES="$t" "$lm/m68k/build.sh" "$lm/build/frames" "${REPS:-2}" | grep -E '^(verify|VERIFY)'
      grep -E "^$t " "$lm/build/m68k/cycles-68k.txt" >> "$out/cycles-68k.txt"
    done
    python3 "$here/test/bench_table.py" "$out/cycles-68k.txt" | tee "$out/bench-table.md"
    ;;
  *) echo "unknown step $s"; exit 2 ;;
  esac
done
echo "test.sh: all steps passed: ${steps[*]}"
