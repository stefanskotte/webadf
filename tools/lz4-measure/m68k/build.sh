#!/usr/bin/env bash
# PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
# Used with the author's permission (2026-10-09).
# The 68000/68020 cycles of LZ4 and PaulaNET RLE on corpus frames, from vamos (amitools 0.4.0,
# Musashi's cycle tables: no chip-RAM wait states, no DMA contention, no interrupts; the 68020
# table assumes every instruction fetch hits the cache). The method is tools/netloop/cycles.sh's:
# vamos' total cycles for REPS passes of a codec, minus REPS passes of "none", divided by REPS
# and by the raw bytes one pass covers.
# Usage: m68k/build.sh FRAMES_DIR [reps]   (FRAMES_DIR: lz4measure's dump, build/frames)
# Toolchain: bebbo's m68k-amigaos-gcc 6.5 and vasm from the amigadev/crosstools image that
# tools/netloop/build.sh pins (by digest there; by tag here, as already pulled on this Mac).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
lm="$(cd "$here/.." && pwd)"
root="$(cd "$lm/../.." && pwd)"
frames="$(cd "$1" && pwd)"
reps="${2:-3}"
out="$lm/build/m68k"
ext="$lm/build/ext"
mkdir -p "$out/gen" "$out/obj" "$out/vamos-vols"
"$lm/fetch.sh" "$ext"

# Arnaud Carre's decoders, unmodified but for: the entry label renamed per variant, and
# lz4_normal's "repeat 15 { ... }" blocks (his own assembler's syntax) spelled as vasm's rept/endr.
# A wrapper gives each the gcc calling convention: f(src, dst, packed_size), all regs saved.
for v in fastest normal; do
  sed -e "s/lz4_depack/lz4_depack_$v/g" -e 's/^[[:space:]]*repeat[[:space:]]*\([0-9]*\)/	rept \1/' \
      -e 's/^[[:space:]]*{[[:space:]]*$//' -e 's/^[[:space:]]*}[[:space:]]*$/	endr/' \
      "$ext/lz4-68k/lz4_$v.asm" > "$out/gen/lz4_$v.asm"
  cat > "$out/gen/glue_$v.s" <<EOF
	section	code,code
	xdef	_lz4_$v
_lz4_$v:
	movem.l	d2-d7/a2-a6,-(sp)
	movem.l	48(sp),a0/a1
	move.l	56(sp),d0
	bsr	lz4_depack_$v
	movem.l	(sp)+,d2-d7/a2-a6
	rts
	include	"lz4_$v.asm"
EOF
done

docker run --rm -v "$root":/work -w /work amigadev/crosstools:m68k-amigaos sh -euc '
  lm=tools/lz4-measure; o=$lm/build/m68k/obj; g=$lm/build/m68k/gen; e=$lm/build/ext
  s=wifi-floppy/firmware/src; t=tools/netloop
  F="-noixemul -m68000 -O2 -std=gnu11 -Wall -I $s -I $t -I $e/lz4"
  for v in fastest normal; do vasmm68k_mot -quiet -Faout -m68000 -I $g -o $o/glue_$v.o $g/glue_$v.s; done
  vasmm68k_mot -quiet -Faout -m68000 -o $o/lz4p_asm.o $lm/m68k/lz4p.asm
  m68k-amigaos-gcc $F -I $lm -c -o $o/lz4p.o $lm/lz4p.c
  m68k-amigaos-gcc $F -DLZ4_MEMORY_USAGE=12 -c -o $o/lz4.o $e/lz4/lz4.c
  m68k-amigaos-gcc $F -Dpnet_mfm_encode=pnet_mfm_encode_c -Dpnet_mfm_decode=pnet_mfm_decode_c \
    -Dpnet_checksum=pnet_checksum_c -Dpnet_rle_encode=pnet_rle_encode_c -Dpnet_rle_decode=pnet_rle_decode_c \
    -c -o $o/pnet_mfm_c.o $s/pnet_mfm.c
  m68k-amigaos-gcc $F -DNETLOOP_ASM=1 -c -o $o/pnet_asm.o $t/pnet_asm.S
  m68k-amigaos-gcc $F -c -o $o/pnet_asm_tables.o $t/pnet_asm_tables.c
  m68k-amigaos-gcc $F -I $lm -DLZ4_MEMORY_USAGE=12 -c -o $o/lz4bench.o $lm/m68k/lz4bench.c
  m68k-amigaos-gcc -noixemul -m68000 -s -o $lm/build/m68k/lz4bench $o/lz4bench.o $o/lz4.o \
    $o/glue_fastest.o $o/glue_normal.o $o/pnet_mfm_c.o $o/pnet_asm.o $o/pnet_asm_tables.o $o/lz4p_asm.o $o/lz4p.o
'

py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
vam() {   # cpu args... -> program output and the total cycles line
  local cpu="$1"; shift
  (cd "$out/vamos-vols" && "$py" - "$out/vamos-vols" "$cpu" "$out/lz4bench" "$@" <<'PY' 2>&1
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
sys.argv = ['vamos', '--vols-base-dir', sys.argv[1], '-C', sys.argv[2], '-m', '8192', '-s', '64',
            '-l', 'main:info', sys.argv[3]] + sys.argv[4:]
sys.exit(main())
PY
  )
}
cyc() { vam "$@" | sed -n 's/.*total cycles: //p'; }

types=(dl-ftp-text dl-ftp-source dl-http dl-ftp-adf dl-ftp-random ul-acks ul-ftp-text)
fcodecs=(lzfast lznorm lzfastl lzc rledasm rledc lzenc rleeasm rleec lz4pasm lz4pc)
bcodecs=(lzfast lznorm lzc lzenc lz4pasm)
fail=0
for ty in "${types[@]}"; do
  for kind in F B; do
    f="$frames/$ty.$([ $kind = F ] && echo frames || echo batches)"
    [ -s "$f" ] || continue
    cp "$f" "$out/vamos-vols/in.bin"
    if [ $kind = F ]; then cs=("${fcodecs[@]}"); else cs=("${bcodecs[@]}"); fi
    for c in "${cs[@]}"; do
      r="$(vam 68000 in.bin $kind "$c" VERIFY || true)"
      case "$r" in *"RESULT: PASS"*) ;; *) echo "VERIFY FAIL: $ty $kind $c: $(echo "$r" | tail -3)"; fail=1 ;; esac
    done
  done
done
[ $fail = 0 ] || exit 1
echo "verify: every codec's output checked against the raw bytes on every file: PASS"

printf '\ncycles per raw byte (vamos/Musashi), and KB/s of raw bytes at 7.09 MHz (68000) / 14.19 MHz (68020)\n'
printf '%-14s %-5s %-8s %9s %9s %10s %10s\n' type kind codec "68000c/B" "68020c/B" "KB/s@7.09" "KB/s@14.2"
for ty in "${types[@]}"; do
  for kind in F B; do
    f="$frames/$ty.$([ $kind = F ] && echo frames || echo batches)"
    [ -s "$f" ] || continue
    cp "$f" "$out/vamos-vols/in.bin"
    raw="$(vam 68000 in.bin $kind none 1 | sed -n 's/.*raw \([0-9]*\) reps.*/\1/p')"
    if [ $kind = F ]; then cs=("${fcodecs[@]}"); else cs=("${bcodecs[@]}"); fi
    b0="$(cyc 68000 in.bin $kind none "$reps")"
    b2="$(cyc 68020 in.bin $kind none "$reps")"
    for c in "${cs[@]}"; do
      c0="$(cyc 68000 in.bin $kind "$c" "$reps")"
      c2="$(cyc 68020 in.bin $kind "$c" "$reps")"
      awk -v ty="$ty" -v k="$kind" -v c="$c" -v a="$c0" -v b="$b0" -v x="$c2" -v y="$b2" -v r="$reps" -v n="$raw" 'BEGIN {
        p0 = (a - b) / r / n; p2 = (x - y) / r / n
        printf "%-14s %-5s %-8s %9.1f %9.1f %10.1f %10.1f\n", ty, k, c, p0, p2, 7093790 / p0 / 1024, 14187580 / p2 / 1024 }'
    done
  done
done | tee "$out/cycles.txt"
