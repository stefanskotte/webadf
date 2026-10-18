#!/usr/bin/env bash
# Builds webadf's PaulaNET.device variant (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §4): Rob
# Smith's NetDevice at 0afd5fa (third-party/paulanet/src/NetDevice, unchanged), webadf-lz4.patch, src/webadf_lz4.c/.h
# and m68k/lz4 (both MIT, ours), by his own Makefile with the vbcc in the pinned amiga-gcc image (vc -cpu=68000: one
# binary for every 68k, the 68020 upload path chosen at run time) and the AmigaOS 3.2 NDK R4 headers, downloaded from
# Aminet and pinned (never committed: Hyperion's licence). Deterministic. Rob's own binary (13,872 B) is not what his
# source builds to (12,808 B, below), so the pin is ours: driver.sha256.
# Usage: tools/paulanet-driver/build.sh <out file> [--pin]   (--pin writes the pin; without it a mismatch fails)
#        STOCK=1 tools/paulanet-driver/build.sh <out file>   his sources alone, must give stock_sha (the toolchain check)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$1"; pin="${2:-}"
img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
ndk_url=https://aminet.net/dev/misc/NDK3.2.lha
ndk_sha=96cabd4ad683dced632e147bf86dee0f50dcb1254386216c25c362916a6409bb
stock_sha=7d14d9d1ecc3dc986b47120781bf091928c228c04c1cc3f5b9b8c24c1466a29b
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
cache="${PAULANET_NDK_CACHE:-$here/.cache}"
mkdir -p "$cache"
if [ ! -f "$cache/NDK3.2.lha" ] || [ "$(sha256 "$cache/NDK3.2.lha")" != "$ndk_sha" ]; then
  curl -fsSL --retry 3 -o "$cache/NDK3.2.lha" "$ndk_url"
fi
[ "$(sha256 "$cache/NDK3.2.lha")" = "$ndk_sha" ] || { echo "FAIL: $ndk_url is not the pinned NDK 3.2 R4 ($ndk_sha)"; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$repo/third-party/paulanet/src/NetDevice" "$tmp/src"
if [ "${STOCK:-}" != 1 ]; then
  ( cd "$tmp/src" && patch -p1 -s < "$here/webadf-lz4.patch" )
  cp "$here/src/webadf_lz4.c" "$here/src/webadf_lz4.h" "$repo/m68k/lz4/lz4_68k.asm" "$repo/m68k/lz4/lz4_68k.h" "$tmp/src/"
fi
cp "$cache/NDK3.2.lha" "$tmp/NDK3.2.lha"
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$tmp:/w" -w /w "$img" sh -euc '
  mkdir ndk && cd ndk && lha xq ../NDK3.2.lha >/dev/null && cd ../src
  make VBCC=/opt/amiga/m68k-amigaos/vbcc IPATH=-I/w/ndk/Include_H >/w/make.log 2>&1 || { tail -40 /w/make.log; exit 1; }'
cp "$tmp/src/PaulaNET.device" "$out"
got="$(sha256 "$out")"
echo "$got  $out ($(wc -c < "$out" | tr -d ' ') bytes)"
if [ "${STOCK:-}" = 1 ]; then
  [ "$got" = "$stock_sha" ] || { echo "FAIL: Rob's sources did not build to $stock_sha -- the toolchain or the NDK moved"; exit 1; }
  echo "PASS stock build"; exit 0
fi
LC_ALL=C grep -q 'PaulaNET.device 1.1-webadf-lz4' "$out" || { echo "FAIL: no 'PaulaNET.device 1.1-webadf-lz4' version string"; exit 1; }
if [ "$pin" = "--pin" ]; then echo "$got" > "$here/driver.sha256"; echo "pinned"; exit 0; fi
[ -f "$here/driver.sha256" ] || { echo "FAIL: no driver.sha256 -- run with --pin once the build is final"; exit 1; }
[ "$(cat "$here/driver.sha256")" = "$got" ] || { echo "FAIL: not the pinned binary ($(cat "$here/driver.sha256"))"; exit 1; }
echo "PASS pinned"
