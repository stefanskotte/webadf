#!/usr/bin/env bash
# Builds Receive (68000, Kickstart 2.04+) with the pinned amiga-gcc image. Deterministic: the same sources give the
# same bytes (checked 2026-10-16), pinned in receive.sha256.
# Usage: tools/receive/build.sh <out file> [--pin]   (--pin writes the pin; without it a mismatch fails)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"; pin="${2:-}"
img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# sh -c so the amiga/*.c glob expands inside the container; sorted, so the link order never changes.
docker run --rm --platform linux/amd64 -v "$here:/src:ro" -v "$tmp:/o" -w /src "$img" sh -c \
  'm68k-amigaos-gcc -m68000 -Os -noixemul -s -Wall -Werror -Icore \
    -o /o/Receive core/rx_crc.c core/rx_names.c core/rx_proto.c $(ls amiga/*.c | LC_ALL=C sort)'
cp "$tmp/Receive" "$out"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
got="$(sha256 "$out")"
echo "$got  $out ($(wc -c < "$out" | tr -d ' ') bytes)"
if [ "$pin" = "--pin" ]; then echo "$got" > "$here/receive.sha256"; echo "pinned"; exit 0; fi
[ -f "$here/receive.sha256" ] || { echo "FAIL: no receive.sha256 -- run with --pin once the build is final"; exit 1; }
[ "$(cat "$here/receive.sha256")" = "$got" ] || { echo "FAIL: not the pinned binary ($(cat "$here/receive.sha256"))"; exit 1; }
echo "PASS pinned"
