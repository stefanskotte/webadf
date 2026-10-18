#!/usr/bin/env bash
# Fetches the third-party sources tools/lz4-measure builds against, pinned and checked, into $1:
#   lz4/        the reference LZ4 library, tag v1.10.0 (BSD-2-Clause; lib/LICENSE)
#   lz4-68k/    Arnaud Carre's 68000 LZ4 block decoders, commit 773f8a0 (MIT; LICENSE)
# Nothing of either is committed to this repo; both licences travel with the fetched files.
set -euo pipefail
dst="$1"
mkdir -p "$dst/lz4" "$dst/lz4-68k"
LZ4=https://raw.githubusercontent.com/lz4/lz4/v1.10.0/lib
L68=https://raw.githubusercontent.com/arnaud-carre/lz4-68k/773f8a083764d2fd001408f65ffcb94ae8e13a6c
get() {   # url file sha256
  if [ ! -f "$2" ] || ! echo "$3  $2" | shasum -a 256 -c --status; then
    curl -sSfL -o "$2" "$1"
  fi
  echo "$3  $2" | shasum -a 256 -c --status || { echo "fetch.sh: checksum mismatch: $2"; exit 1; }
}
while read -r f sha; do get "$LZ4/$f" "$dst/lz4/$f" "$sha"; done <<'EOF'
lz4.c 9396f7de527bc8435de9c7569fb7998e56545a84b4f3c2d808c0235c01774539
lz4.h 26b82efc53d1570f3b54eef02e9c4764c1ad374ff03cac04e2ced5ea4d4c552f
lz4hc.c 126cafafdb91767e6e55238298a910903851b35b2cee27ce80ae2280469ee232
lz4hc.h e43824e8a9ba16f54100c4ccbccfa5782a858ca9ab83c48aac303fea3e76e21e
LICENSE 8b58c446121a109ccf32edc094bba3010a3d85e4ee3702950db55e4d3e87736c
EOF
while read -r f sha; do get "$L68/$f" "$dst/lz4-68k/$f" "$sha"; done <<'EOF'
lz4_fastest.asm 8278197ff9ee4d97aea7a161a2c048c3c8ba75b00bcfc366be7e7b400e5c8aa9
lz4_normal.asm eaffd16a7e359b51784cd115b26661cc111f0b2c0e00544afe484c7bb8baccd5
LICENSE e8e3ea6ef611632c79f05c4fac874ceee398de00f87c70348f7ba6f889c51afa
README.md c2d047d5252cde3152207f45e19285936565866a4b6db2ba4dfe09acf49c3ed0
EOF
