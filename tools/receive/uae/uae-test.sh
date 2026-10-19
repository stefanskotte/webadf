#!/usr/bin/env bash
# Boots FS-UAE with Receive and runs the shared scenarios against it through bsdsocket emulation (the Amiga's
# listen on 6800 is the Mac's port 6800). Usage: uae-test.sh 204|31|32 [shell|gui|space|ram|send]
# Never pattern-kills: stops only the FS-UAE PID it started.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../../.." && pwd)"
# ROMs and Workbench disks are gitignored: they live in the main checkout, not in a worktree.
main="$(cd "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
ks="$1"; mode="${2:-shell}"
case "$ks" in
  204) rom="${WEBADF_KS204:-$HOME/Documents/FS-UAE/Kickstarts/amiga-os-204.rom}"
       wb="${WEBADF_WB204:-$HOME/Downloads/WB204/Workbench v2.04 rev 37.67 (1991)(Commodore)(Disk 1 of 4)(Workbench).adf}";;
  31)  rom="${WEBADF_KS31:-$main/docs/kickstart3.1.rom}"
       wb="${WEBADF_WB31:-$main/adf-archive/Workbench31 - wbench31.adf}";;
  32)  rom="${WEBADF_KS32:-$HOME/Documents/FS-UAE/Kickstarts/kickCDTVa1000a500a2000a600.rom}"   # 47.96, the A500 build
       # The Workbench must match the Kickstart: 3.2 boots ask for LIBS/icon.library, which the A500 build keeps on
       # its Modules disk (copied into Work:Libs below), and a 3.1 Workbench has none.
       wb="${WEBADF_WB32:-$HOME/Downloads/workbench-3.2-adf/Workbench3.2.adf}"
       modules="${WEBADF_MOD32:-$HOME/Downloads/workbench-3.2-adf/ModulesA500_3.2.adf}";;
  *) echo "usage: uae-test.sh 204|31|32 [shell|gui|space|ram|send]"; exit 2;;
esac
[ -f "$rom" ] || { echo "FAIL: no Kickstart ROM at $rom"; exit 1; }
[ -f "$wb" ] || { echo "FAIL: no Workbench disk at $wb"; exit 1; }
md5="$(md5 -q "$rom" 2>/dev/null || md5sum "$rom" | cut -d' ' -f1)"
case "$md5" in
  dc10d7bdd1b6f450773dfb558477c230) model=A500+;;   # 2.04 37.175 (A500/A500+)
  e40a5dfb3d017ba8779faba30cbd1c8e) model=A500;;    # 3.1 40.63 (A500/A600/A2000)
  646773759326fbac3b2311fd8c8793ee) model=A1200;;   # 3.1 40.68 (A1200): a 68020
  1d9b6068abff5a44b4b2f1d5d3516dd9) model=A500;;    # 3.2 47.96 (A500/A600/A2000): a 68000
  *) echo "FAIL: unknown Kickstart (md5 $md5): set amiga_model by hand"; exit 1;;
esac
uae="${WEBADF_FSUAE:-/Applications/FS-UAE.app/Contents/MacOS/fs-uae}"
work="$(mktemp -d)"; mkdir -p "$work/hd/S" "$work/hd/Out" "$work/hd/EnvArc"
if [ "$ks" = 32 ]; then
  [ -f "$modules" ] || { echo "FAIL: no 3.2 Modules disk at $modules"; exit 1; }
  mkdir -p "$work/hd/Libs"
  for lib in icon.library workbench.library; do xdftool "$modules" read "LIBS/$lib" "$work/hd/Libs/$lib" >/dev/null; done
fi
pid=""
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; }
trap cleanup EXIT
tools_out="$work/hd/Receive"; "$repo/tools/receive/build.sh" "$tools_out" >/dev/null
target='Work:Out'; df0=''
if [ "$mode" = ram ]; then target='RAM:'; fi
if [ "$mode" = space ]; then
  xdftool "$work/small.adf" create + format Small ofs >/dev/null; df0="$work/small.adf"; target='DF0:'
fi
if [ "$mode" = send ]; then
  # Uploads (spec 2026-10-18 §10 increment 1): files on Work:Up for twelve `Receive SEND` runs, played by send-scenarios.ts.
  mkdir -p "$work/hd/Up/Mods/sub"
  printf 'hello from the Amiga\n' > "$work/hd/Up/Hello.txt"
  head -c 4194304 /dev/urandom > "$work/hd/Up/Big.bin"
  printf 'a' > "$work/hd/Up/Mods/a.mod"; printf 'i' > "$work/hd/Up/Mods/a.mod.info"; printf 'b' > "$work/hd/Up/Mods/sub/b.mod"
  head -c 100000 /dev/urandom > "$work/hd/Up/Resume.bin"
  head -c 20000 /dev/urandom > "$work/hd/Up/Crc.bin"
  printf 'x' > "$work/hd/Up/Refused.bin"
  printf 'e' > "$work/hd/Up/Café.txt"
fi
case "$mode" in
  shell|space|ram) run_line="Work:Receive TO $target SAVE >Work:receive.log";;
  gui) run_line="DF1:C/Assign >NIL: SYS: DF1:
DF1:C/LoadWB
Run >NIL: Work:Receive TO $target GUI";;
  send) e9=$(printf '\351')   # é in Latin-1: the Amiga reads the script byte by byte
        run_line=""
        n=0
        for f in Hello.txt Big.bin Mods Resume.bin Resume.bin Crc.bin Refused.bin "Caf${e9}.txt" Hello.txt Hello.txt; do
          n=$((n + 1)); log=$(printf 's%02d' "$n")
          run_line="${run_line}Work:Receive SEND Work:Up/$f >Work:$log.log
Echo >>Work:$log.log "'"rc=$RC"'"
"
        done
        run_line="${run_line}Work:Receive SEND TRUST Work:Up/Hello.txt >Work:s11.log
Echo >>Work:s11.log "'"rc=$RC"'"
Run >NIL: Work:Receive TO Work:Out
Wait 3
Work:Receive SEND Work:Up/Hello.txt >Work:s12.log
Echo >>Work:s12.log "'"rc=$RC"'"
Echo >Work:done done";;
esac
cat > "$work/hd/S/startup-sequence" <<EOF
FailAt 21
DF1:C/MakeDir >NIL: RAM:ENV RAM:T
DF1:C/Assign >NIL: ENV: RAM:ENV
DF1:C/Assign >NIL: T: RAM:T
DF1:C/Assign >NIL: LIBS: DF1:Libs ADD
DF1:C/Assign >NIL: C: DF1:C ADD
If EXISTS DF1:Fonts
  DF1:C/Assign >NIL: FONTS: DF1:Fonts
EndIf
DF1:C/Assign >NIL: ENVARC: Work:EnvArc
$run_line
EOF
cat > "$work/receive.fs-uae" <<EOF
[fs-uae]
amiga_model = $model
kickstart_file = $rom
chip_memory = 1024
floppy_drive_count = 2
floppy_drive_0 = $df0
floppy_drive_1 = $wb
floppy_drive_1_write_protected = 1
hard_drive_0 = $work/hd
hard_drive_0_label = Work
bsdsocket_library = 1
automatic_input_grab = 0
initial_input_grab = 0
fullscreen = 0
EOF
"$uae" "$work/receive.fs-uae" >"$work/fs-uae.log" 2>&1 &
pid=$!
echo "fs-uae pid $pid, folder $work"
for _ in $(seq 1 90); do nc -z 127.0.0.1 6800 2>/dev/null && break; sleep 1; done
nc -z 127.0.0.1 6800 || { echo "FAIL: Receive never listened on 6800"; tail -20 "$work/fs-uae.log"; exit 1; }
rc=0
case "$mode" in
  shell) pnpm exec tsx "$repo/tools/receive/run-scenarios.ts" --port 6800 --dir "$work/hd/Out" --uae || rc=1
         [ "$(cat "$work/hd/EnvArc/webadf/ReceiveDir" 2>/dev/null)" = "Work:Out" ] && echo "PASS SAVE wrote ENVARC:webadf/ReceiveDir" \
           || { echo "FAIL ENVARC:webadf/ReceiveDir"; rc=1; }
         grep -q 's' "$work/hd/Out/Script.uaem" 2>/dev/null && grep -q 'a comment' "$work/hd/Out/Script.uaem" \
           && echo "PASS Script kept its s bit and comment" || { echo "FAIL Script metadata: $(cat "$work/hd/Out/Script.uaem" 2>/dev/null)"; rc=1; }
         sleep 2; echo "--- receive.log"; cat "$work/hd/receive.log" 2>/dev/null || true;;
  ram) pnpm exec tsx "$repo/tools/receive/run-scenarios.ts" --port 6800 --dir "$work/hd/Out" --only ramdisk || rc=1;;
  space) pnpm exec tsx "$repo/tools/receive/run-scenarios.ts" --port 6800 --dir "$work/hd/Out" --only space || rc=1;;
  gui) echo "GUI is up; touch $work/stop to end (10 minutes at most)"
       for _ in $(seq 1 600); do [ -e "$work/stop" ] && break; sleep 1; done
       echo "--- ENVARC: $(cat "$work/hd/EnvArc/webadf/ReceiveDir" 2>/dev/null)";;
  send) pnpm exec tsx "$repo/tools/receive/uae/send-scenarios.ts" --hd "$work/hd" || rc=1;;
esac
exit $rc
