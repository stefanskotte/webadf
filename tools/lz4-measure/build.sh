#!/usr/bin/env bash
# tools/lz4-measure: PaulaNET RLE vs LZ4 sizes on the host, then (`build.sh 68k`) the 68000 cycles.
# Needs Homebrew lz4 (brew install lz4) and python3. Output: tools/lz4-measure/build/ (git-ignored).
#   build.sh         corpus (with the live local http server and DNS lookups), host measurement
#   build.sh 68k     the above, then m68k/build.sh (Docker m68k toolchain + vamos cycle counts)
# ADF=path: the image for dl-ftp-adf (none given: that type is left out). NO_LIVE=1: no http/DNS.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/build"
mkdir -p "$out/frames"
lz="$(brew --prefix lz4)"
fw="$root/wifi-floppy/firmware/src"
cc -std=c11 -O2 -Wall -Wextra -Werror -I"$fw" -I"$here" -I"$lz/include" -o "$out/lz4measure" \
   "$here/lz4measure.c" "$here/lz4p.c" "$fw/pnet_mfm.c" "$lz/lib/liblz4.a"
args=()
[ -n "${ADF:-}" ] && args+=(--adf "$ADF")
[ -n "${NO_LIVE:-}" ] && args+=(--no-live)
python3 "$here/corpus.py" "$out/corpus.bin" --root "$root" "${args[@]+"${args[@]}"}"
"$out/lz4measure" "$out/corpus.bin" "$out/frames" | tee "$out/results.txt"
# The board would keep LZ4's state small: the same run with the reference source built for a
# 4 KB (LZ4_MEMORY_USAGE=12) and a 1 KB (10) hash table instead of Homebrew's 16 KB (14).
"$here/fetch.sh" "$out/ext"
for m in 12 10; do
  cc -std=c11 -O2 -Wall -Wextra -Werror -DLZ4_MEMORY_USAGE=$m -I"$fw" -I"$here" -I"$out/ext/lz4" \
     -o "$out/lz4measure-m$m" "$here/lz4measure.c" "$here/lz4p.c" "$fw/pnet_mfm.c" \
     "$out/ext/lz4/lz4.c" "$out/ext/lz4/lz4hc.c"
  echo; echo "LZ4_MEMORY_USAGE=$m (lz4, linkf columns change; hc9/hc12/link9/batch9 do not):"
  "$out/lz4measure-m$m" "$out/corpus.bin" | sed -n '2,16p'
done | tee -a "$out/results.txt"
if [ "${1:-}" = 68k ]; then "$here/m68k/build.sh" "$out/frames"; fi
