#!/usr/bin/env bash
# Builds the PaulaNET driver disk (spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md §2)
# from Rob Smith's own disk (third-party/paulanet/, pinned) plus our Install script, ReadMe and their icons.
# Deterministic: the same inputs give the same bytes, whose sha256 is pinned in paulanet-disk.sha256.
# Usage: tools/paulanet-disk/build.sh <out.adf>     Needs xdftool (amitools 0.4.0). Receive comes from tools/receive/dist/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$1"
# Debian has no shasum without perl; macOS has no sha256sum.
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
base="$repo/third-party/paulanet/PaulaNET-0afd5fa.adf"
base_sha=d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0
[ "$(sha256 "$base")" = "$base_sha" ] || { echo "FAIL: $base is not the pinned image"; exit 1; }
# amitools' own interpreter (xdftool's shebang), so xdf_fixed.py imports the same amitools.
py="$(head -1 "$(command -v xdftool)" | sed 's/^#!//')"
xdf() { TZ=UTC "$py" -I "$here/xdf_fixed.py" "$@" </dev/null; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$base" "$tmp/disk.adf"
# Receive (spec 2026-10-16 §5): the committed pinned build, checked here so a stale copy fails the disk build.
cp "$repo/tools/receive/dist/Receive" "$tmp/Receive"
[ "$(sha256 "$tmp/Receive")" = "$(cat "$repo/tools/receive/receive.sha256")" ] \
  || { echo "FAIL: tools/receive/dist/Receive is not the binary pinned in tools/receive/receive.sha256"; exit 1; }
xdftool "$tmp/disk.adf" read "PaulaNET Config.info" "$tmp/tool.info"
python3 -I "$here/make_icon.py" "$tmp/tool.info" "C:IconX" "$tmp/Install.info"
python3 -I "$here/make_icon.py" "$tmp/tool.info" "SYS:Utilities/MultiView" "$tmp/ReadMe.info"
python3 -I "$here/make_icon.py" "$tmp/tool.info" --tool "$tmp/Receive.info"
cp "$here/Install" "$here/ReadMe" "$tmp/"
( cd "$tmp" && xdf disk.adf write Install + write Install.info + write ReadMe + write ReadMe.info \
                + write Receive + write Receive.info + protect Install srwed + protect Receive rwed )
xdftool "$tmp/disk.adf" list > "$tmp/list.txt"
python3 -I "$here/check.py" "$tmp/disk.adf" "$tmp/list.txt"
xdftool "$tmp/disk.adf" read PaulaNET.device "$tmp/driver"
cmp -s "$tmp/driver" "$repo/third-party/paulanet/PaulaNET.device" \
  && echo "PASS PaulaNET.device is the pinned binary" || { echo "FAIL: PaulaNET.device differs from third-party/paulanet/"; exit 1; }
xdftool "$tmp/disk.adf" read Receive "$tmp/receive.back"
cmp -s "$tmp/receive.back" "$tmp/Receive" \
  && echo "PASS Receive is the pinned binary" || { echo "FAIL: Receive on the disk differs from tools/receive/dist/"; exit 1; }
cp "$tmp/disk.adf" "$out"
got="$(sha256 "$out")"
echo "$got  $out"
[ -f "$here/paulanet-disk.sha256" ] || { echo "FAIL: $here/paulanet-disk.sha256 is missing -- the pin is mandatory"; exit 1; }
if [ "$(cat "$here/paulanet-disk.sha256")" != "$got" ]; then
  echo "FAIL: not the pinned disk ($(cat "$here/paulanet-disk.sha256")) -- an input changed; the server's PAULANET_DISK_SHA256 must change with it"
  exit 1
fi
