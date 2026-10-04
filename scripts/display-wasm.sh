#!/usr/bin/env bash
# scripts/display-wasm.sh -- builds public/display.wasm from the firmware's own
# renderer, and records a hash of its C sources so a stale module cannot ship.
#   --hash   print the sources' hash and exit (test/run.sh's staleness check
#            calls this, so the build and the check cannot hash differently).
set -euo pipefail
cd "$(dirname "$0")/.."
F=wifi-floppy/firmware
SRC="$F/src/display.c $F/src/display_layout.c $F/wasm/display_wasm.c"
HDR="$F/src/display.h $F/src/display_layout.h"
src_hash() { cat $SRC $HDR | shasum -a 256 | cut -d' ' -f1; }
if [ "${1:-}" = "--hash" ]; then src_hash; exit 0; fi
PATH="$(brew --prefix lld)/bin:$PATH" "$(brew --prefix llvm)/bin/clang" \
  --target=wasm32-unknown-wasip1 -O2 -mexec-model=reactor -I"$F/src" $SRC -o public/display.wasm
src_hash > src/lib/display-wasm.version
echo "public/display.wasm $(wc -c < public/display.wasm) bytes, sources $(cat src/lib/display-wasm.version)"
