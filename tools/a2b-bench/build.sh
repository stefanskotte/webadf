#!/usr/bin/env bash
# Builds the increment 0 bench sender (plan 2026-10-19 Task 1) with Receive's pinned amiga-gcc image, and an OFS disk,
# A2BBench.adf, holding it. Bench only, never on a user's disk. Usage: tools/a2b-bench/build.sh <out folder>
# Needs Docker and xdftool (amitools).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; out="$1"; mkdir -p "$out"; out="$(cd "$out" && pwd)"
img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
docker run --rm --platform linux/amd64 -v "$here:/src:ro" -v "$out:/o" -w /src "$img" \
  m68k-amigaos-gcc -m68000 -Os -noixemul -s -Wall -Werror -o /o/a2bsend a2bsend.c
rm -f "$out/A2BBench.adf"
xdftool "$out/A2BBench.adf" create + format A2BBench ofs + write "$out/a2bsend" a2bsend + protect a2bsend rwed
xdftool "$out/A2BBench.adf" list
