#!/usr/bin/env bash
# With WF_PNET_LOOP=OFF the firmware must build exactly as <base> (default: master) does -- DF0
# above all (plan docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md, Global
# Constraints). This proves it at the source level: each firmware .c file the plan touches is
# preprocessed with the device build's own compile command (WF_PNET_LOOP=0), and so is the same
# file from <base>; any difference fails. Both copies see THIS tree's headers, which differ from
# <base> only inside #if WF_PNET_LOOP. (A __FILE__ in either file would differ by name alone and
# fail this check; neither file uses one today.)
# <base> is master. PaulaNET Phase 2 (plan 2026-10-11-paulanet-phase2-rob-driver) changes these files
# only inside #if WF_PNET_LOOP / WF_PNET_L2. Its one every-build rule, the 16,128-byte batch cap
# (Task 2), lives in pnet_frame.h and pnet_link.c, which no release image compiles.
set -euo pipefail
fw="$(cd "$(dirname "$0")/.." && pwd)"
base="${1:-master}"
bd="$fw/build-offcheck"
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cmake -S "$fw" -B "$bd" -G Ninja -DPICO_SDK_PATH="$HOME/pico-sdk" \
  -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DWF_PNET_LOOP=OFF -DWF_DF1_DEFAULT=OFF >/dev/null 2>&1 || { echo "FAIL: cmake configure"; exit 1; }
# Generates floppy.pio.h and the version header the sources include.
cmake --build "$bd" >/dev/null 2>&1 || { echo "FAIL: the OFF build itself"; exit 1; }
# The base copies sit in src/ (below), where a careless `git add` would pick one up: they go on
# ANY exit, a failed step under `set -e` included.
cleanup() { rm -f "$fw"/src/.offcheck_base_*.c; }
trap cleanup EXIT
fail=0
for f in main.c flux_capture.c net_radio_cyw43.c; do
  tmp="$fw/src/.offcheck_base_$f"   # beside the original, so its #include "..." resolve the same
  git -C "$fw" show "$base:wifi-floppy/firmware/src/$f" > "$tmp"
  python3 - "$bd/compile_commands.json" "$fw/src/$f" "$tmp" "$bd/offcheck_$f" <<'EOPY'
import json, os, shlex, subprocess, sys
db, src, base, out = sys.argv[1:]
want = os.path.realpath(src)
cmd = next(e for e in json.load(open(db))
           if os.path.realpath(os.path.join(e['directory'], e['file'])) == want
           and 'wifi_floppy.dir' in e['command'])
# Dropped: the output and dependency-file options with their arguments, -c (it takes none; -E
# replaces it), and the source file itself, matched by path -- each run names its own input.
keep, skip = [], False
for a in shlex.split(cmd['command']):
    if skip: skip = False; continue
    if a in ('-o', '-MF', '-MT'): skip = True; continue
    if a in ('-c', '-MD', '-MMD'): continue
    if os.path.realpath(os.path.join(cmd['directory'], a)) == want: continue
    keep.append(a)
for path, tag in ((src, 'new'), (base, 'base')):
    subprocess.run(keep + ['-E', '-P', path, '-o', f'{out}.{tag}.i'], cwd=cmd['directory'], check=True)
EOPY
  rm -f "$tmp"                      # (and again by the trap, if anything above failed)
  if cmp -s "$bd/offcheck_$f.base.i" "$bd/offcheck_$f.new.i"; then
    echo "identical with WF_PNET_LOOP=0 WF_PNET_L2=0: src/$f"
  else
    echo "DIFFERS with WF_PNET_LOOP=0 WF_PNET_L2=0: src/$f"
    diff "$bd/offcheck_$f.base.i" "$bd/offcheck_$f.new.i" | head -40 || true
    fail=1
  fi
done
exit $fail
