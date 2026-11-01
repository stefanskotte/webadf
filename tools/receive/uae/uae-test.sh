#!/usr/bin/env bash
# Boots FS-UAE with Transfer and runs the shared scenarios against it through bsdsocket emulation (the Amiga's
# listen on 6800 is the Mac's port 6800). Usage: uae-test.sh 204|31|32 [shell|gui|space|ram|send|browse|write|flip|icon|cx]
# flip, icon and cx (Transfer 2.7) drive the Amiga with poke (uae/poke.c) and save screenshots in WEBADF_SHOTS (default:
# the run's folder).
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
  *) echo "usage: uae-test.sh 204|31|32 [shell|gui|space|ram|send|browse|write|flip|icon|cx]"; exit 2;;
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
tools_out="$work/hd/Transfer"
# WEBADF_TRANSFER=<file>: run that binary (an older release, say) instead of building this tree.
if [ -n "${WEBADF_TRANSFER:-}" ]; then cp "$WEBADF_TRANSFER" "$tools_out"; else "$repo/tools/receive/build.sh" "$tools_out" >/dev/null; fi
target='Work:Out'; df0=''
shots="${WEBADF_SHOTS:-$work}"
# Transfer 2.7's modes: poke drives the Amiga (keys typed on the Mac never reach FS-UAE's Amiga, measured 2026-11-01).
case "$mode" in flip|icon|cx)
  img=stefanreinauer/amiga-gcc@sha256:cafc64bc34a5450d858cf27d6f399222bed241fced3c093123b9ec764a82f26f
  docker run --rm --platform linux/amd64 -v "$here:/src:ro" -v "$work/hd:/o" -w /src "$img" \
    m68k-amigaos-gcc -m68000 -Os -noixemul -s -Wall -Werror -o /o/poke poke.c
  wid() { swift "$here/window-id.swift" FS-UAE; }
  shot() { sleep 2; screencapture -x -o -l"$(wid)" "$shots/transfer-2.7-$ks-$1.png" && echo "  screenshot $shots/transfer-2.7-$ks-$1.png"; }
  waitf() { for _ in $(seq 1 "${2:-120}"); do [ -e "$work/hd/$1" ] && return 0; sleep 1; done; echo "FAIL: no Work:$1"; return 1; }
  say() { [ -e "$work/hd/$1" ] || { echo "(no $1)"; return 0; }; tr -d '\r' < "$work/hd/$1" | tr '\n' ' ' | sed 's/ *$//'; }
  expect() { local got; got="$(say "$1")"; if [ "$got" = "$2" ]; then echo "PASS $3 ($got)"; else echo "FAIL $3: got '$got', want '$2'"; rc=1; fi; }
  ;;
esac
df2=''; fdc=2
if [ "$mode" = ram ]; then target='RAM:'; fi
if [ "$mode" = space ]; then
  xdftool "$work/small.adf" create + format Small ofs >/dev/null; df0="$work/small.adf"; target='DF0:'
fi
if [ "$mode" = send ]; then
  # Uploads (spec 2026-10-18 §10 increment 1): files on Work:Up for thirteen `Transfer SEND` runs (and one RECEIVE SEND, refused), played by send-scenarios.ts.
  mkdir -p "$work/hd/Up/Mods/sub"
  printf 'hello from the Amiga\n' > "$work/hd/Up/Hello.txt"
  head -c 4194304 /dev/urandom > "$work/hd/Up/Big.bin"
  printf 'a' > "$work/hd/Up/Mods/a.mod"; printf 'i' > "$work/hd/Up/Mods/a.mod.info"; printf 'b' > "$work/hd/Up/Mods/sub/b.mod"
  head -c 100000 /dev/urandom > "$work/hd/Up/Resume.bin"
  head -c 20000 /dev/urandom > "$work/hd/Up/Crc.bin"
  printf 'x' > "$work/hd/Up/Refused.bin"
  printf 'e' > "$work/hd/Up/Café.txt"
fi
if [ "$mode" = flip ]; then printf 'old\n' > "$work/hd/Keep.txt"; fi
if [ "$mode" = icon ]; then
  # The icon left out on Workbench's window at a fixed place (Work:.backdrop), so poke can double-click it.
  python3 -I "$repo/tools/receive/icon/make_transfer_icon.py" "$repo/tools/receive/icon/transfer-icon.txt" "$work/hd/Transfer.info" --pos 300,20
  printf ':Transfer\n' > "$work/hd/.backdrop"
fi
if [ "$mode" = cx ]; then
  # WBStartup with CX_POPUP=NO: SYS: is Work: then the Workbench disk, so LoadWB finds SYS:WBStartup on Work:.
  mkdir -p "$work/hd/WBStartup"
  cp "$tools_out" "$work/hd/WBStartup/Transfer"
  python3 -I "$repo/tools/receive/icon/make_transfer_icon.py" "$repo/tools/receive/icon/transfer-icon.txt" "$work/hd/WBStartup/Transfer.info" \
    --tooltypes 'DONOTWAIT|CX_POPUP=NO|CX_POPKEY=ctrl alt w'
  case "$ks" in   # Exchange: on the 2.04 Workbench disk; on the Extras disk for 3.1 and 3.2
    204) exch='DF1:Utilities/Exchange';;
    31) xdftool "${WEBADF_EX31:-$main/adf-archive/Workbench31 - extras31.adf}" read Tools/Commodities/Exchange "$work/hd/Exchange" >/dev/null; exch='Work:Exchange';;
    32) xdftool "${WEBADF_EX32:-$HOME/Downloads/workbench-3.2-adf/Extras3.2.adf}" read Tools/Commodities/Exchange "$work/hd/Exchange" >/dev/null; exch='Work:Exchange';;
  esac
fi
if [ "$mode" = gui ]; then
  mkdir -p "$work/hd/Up"; head -c 901120 /dev/zero > "$work/hd/Up/Lemmings.adf"; printf 'notes\n' > "$work/hd/Up/Notes.txt"
fi
if [ "$mode" = browse ]; then
  # NET: volumes (spec 2026-10-30 §2.4), the fixture scenarios.ts's makeBrowseFixture describes:
  # - Work:Programs/a.txt, and Work:Big with 1005 empty files;
  # - two floppies both named Empty (DF0:, DF2:), each with a Which.txt naming its drive.
  mkdir -p "$work/hd/Programs" "$work/hd/Big"
  printf 'hello from the Amiga\n' > "$work/hd/Programs/a.txt"
  for i in $(seq -w 0 1004); do : > "$work/hd/Big/f$i"; done
  printf 'df0\n' > "$work/which0"; printf 'df2\n' > "$work/which2"
  xdftool "$work/empty0.adf" create + format Empty ofs + write "$work/which0" Which.txt >/dev/null
  sleep 3   # AmigaDOS takes two disks with one name AND one volume date for the same volume: format them apart
  xdftool "$work/empty2.adf" create + format Empty ofs + write "$work/which2" Which.txt >/dev/null
  df0="$work/empty0.adf"; df2="$work/empty2.adf"; fdc=3
fi
if [ "$mode" = write ]; then
  # Protocol 4 (spec 2026-10-31 §2.6), the fixture scenarios.ts's makeWriteFixture describes:
  # - Work: Tools/, a.txt, Keep.txt, Old/ with 300 files;
  # - DF0: Prot, write-protected; DF2: Full, 146 KB free, with Locked and Stuck/locked (d-bit off), Stuck/a, Stuck/b,
  #   and Hold.txt held open by a running Wait (on the ADF: FS-UAE's folder hard drive lets an open file be deleted).
  mkdir -p "$work/hd/Tools" "$work/hd/Old"
  printf 'a\n' > "$work/hd/a.txt"; printf 'old\n' > "$work/hd/Keep.txt"
  for i in $(seq -w 0 299); do : > "$work/hd/Old/f$i"; done
  # protocol 5 (spec §9): One5.txt, Empty5/, Full5/f, Old5/ with 60 files
  mkdir -p "$work/hd/Empty5" "$work/hd/Full5" "$work/hd/Old5"; printf '1' > "$work/hd/One5.txt"; printf 'f' > "$work/hd/Full5/f"
  for i in $(seq -w 0 59); do : > "$work/hd/Old5/f$i"; done
  printf 'x' > "$work/x1"; head -c 700000 /dev/zero > "$work/big"
  xdftool "$work/prot.adf" create + format Prot ofs >/dev/null
  sleep 2   # two volume dates apart
  xdftool "$work/full.adf" create + format Full ofs + write "$work/big" Big.bin + write "$work/x1" Locked + makedir Stuck \
    + write "$work/x1" Stuck/a + write "$work/x1" Stuck/b + write "$work/x1" Stuck/locked \
    + protect Locked rwe + protect Stuck/locked rwe >/dev/null
  df0="$work/prot.adf"; df2="$work/full.adf"; fdc=3
fi
W='"WebFloppy - Receive & Send"'
case "$mode" in
  shell|space|ram) run_line="Work:Transfer RECEIVE TO $target SAVE >Work:receive.log";;
  # The steps run detached (Run ... Execute), so the boot Shell's window can close and show Workbench.
  flip) cat > "$work/hd/steps" <<EOS
FailAt 21
Work:poke waitfile Work:go 600
Work:poke gadget $W 8 >Work:f1.log
Work:poke gadsel $W 8 >Work:f2.log
Echo >Work:fdone x
Work:poke waitfile Work:go2 600
Work:poke gadget $W 7 >Work:f3.log
Wait 1
Work:poke gadsel $W 7 >Work:f4.log
Work:poke gadsel $W 8 >Work:f5.log
Echo >Work:fdone2 x
EOS
        run_line="DF1:C/Assign >NIL: SYS: DF1:
DF1:C/LoadWB
Run >NIL: Work:Transfer TO Work:Out GUI BROWSE WRITE
Run >NIL: DF1:C/Execute Work:steps
EndCLI >NIL:";;
  icon) cat > "$work/hd/steps" <<EOS
FailAt 21
Wait 6
Echo >Work:i0 x
Work:poke waitfile Work:a1 300
Work:poke wbclick 332 30 2 >Work:i1.log
Wait 6
Work:poke win $W >Work:i2.log
Work:poke list >Work:i3.log
Echo >Work:i4 x
Work:poke waitfile Work:a2 300
Work:poke wbclick 332 30 2 >NIL:
Wait 6
Work:poke list >Work:i5.log
Work:poke win $W >Work:i6.log
Echo >Work:i7 x
EOS
        run_line="DF1:C/Assign >NIL: SYS: DF1:
DF1:C/LoadWB
Run >NIL: DF1:C/Execute Work:steps
EndCLI >NIL:";;
  cx) cat > "$work/hd/steps" <<EOS
FailAt 21
Wait 10
Work:poke win $W >Work:c01.log
Work:poke list >Work:c02.log
Echo >Work:m0 x
Work:poke waitfile Work:a0 300
Work:poke key 11 18 >NIL:
Wait 4
Work:poke win $W >Work:c03.log
Work:poke cx Transfer disappear >NIL:
Wait 3
Work:poke win $W >Work:c04.log
Work:poke cx Transfer appear >NIL:
Wait 4
Work:poke win $W >Work:c05.log
Work:poke gadget $W -1 >NIL:
Wait 3
Work:poke win $W >Work:c06.log
Echo >Work:m1 x
Work:poke waitfile Work:a1 300
Work:poke cx Transfer disable >NIL:
Wait 4
Echo >Work:m2 x
Work:poke waitfile Work:a2 300
Work:poke cx Transfer enable >NIL:
Wait 4
Echo >Work:m3 x
Work:poke waitfile Work:a3 300
Work:WBStartup/Transfer GUI >Work:c07.log
Wait 4
Work:poke win $W >Work:c08.log
Work:poke list >Work:c08b.log
Work:poke key 10 80 >NIL:
Wait 5
Work:poke win $W >Work:c09.log
Work:poke list >Work:c10.log
Echo >Work:m4 x
Work:poke waitfile Work:a4 300
Run >NIL: Work:WBStartup/Transfer GUI
Wait 8
Work:poke cx Transfer kill >NIL:
Wait 5
Work:poke list >Work:c11.log
Work:poke win $W >Work:c12.log
Run >NIL: Work:WBStartup/Transfer GUI
Wait 8
Run >NIL: $exch
Wait 8
Echo >Work:m5 x
EOS
        run_line="DF1:C/Assign >NIL: SYS: Work: DF1:
DF1:C/LoadWB
Run >NIL: DF1:C/Execute Work:steps
EndCLI >NIL:";;
  gui) run_line="DF1:C/Assign >NIL: SYS: DF1:
DF1:C/LoadWB
Run >NIL: Work:Transfer TO $target GUI BROWSE WRITE SEND Work:Up/Lemmings.adf Work:Up/Notes.txt";;
  browse) run_line="Work:Transfer BROWSE TO Work:Out >Work:receive.log";;
  # FS-UAE writes a floppy to an overlay whatever its write-protect options say: AmigaDOS's own Lock makes Prot
  # write-protected (DOS error 214), as the tab does.
  # The busy proof: AmigaDOS's own Delete of Hold.txt must fail (in use), or w-replace-busy proves nothing. Hold2.txt
  # is the form that did NOT hold on the A500 (Run's own redirection, closed once Run returns), for comparison.
  write) run_line="Run >NIL: Wait >Full:Hold.txt 600
Run >Full:Hold2.txt Wait 600
Wait 3
Delete >Work:holddel.log Full:Hold.txt
Delete >Work:hold2del.log Full:Hold2.txt
Lock >NIL: DF0: ON
Work:Transfer WRITE TO Work:Out >Work:receive.log";;
  send) e9=$(printf '\351')   # é in Latin-1: the Amiga reads the script byte by byte
        run_line=""
        # <log>:<file>; s03b is the drawer again with the slash Shell TAB completion adds.
        for step in s01:Hello.txt s02:Big.bin s03:Mods s03b:Mods/ s04:Resume.bin s05:Resume.bin s06:Crc.bin \
                    s07:Refused.bin "s08:Caf${e9}.txt" s09:Hello.txt s10:Hello.txt; do
          log=${step%%:*}; f=${step#*:}
          run_line="${run_line}Work:Transfer SEND Work:Up/$f >Work:$log.log
Echo >>Work:$log.log "'"rc=$RC"'"
"
        done
        run_line="${run_line}Work:Transfer SEND TRUST Work:Up/Hello.txt >Work:s11.log
Echo >>Work:s11.log "'"rc=$RC"'"
Run >NIL: Work:Transfer TO Work:Out
Wait 3
Work:Transfer SEND Work:Up/Hello.txt >Work:s12.log
Echo >>Work:s12.log "'"rc=$RC"'"
Work:Transfer RECEIVE SEND Work:Up/Hello.txt >Work:s13.log
Echo >>Work:s13.log "'"rc=$RC"'"
Version Work:Transfer >Work:ver.log
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
floppy_drive_count = $fdc
save_states_dir = $work/states
floppy_drive_0 = $df0
floppy_drive_1 = $wb
floppy_drive_1_write_protected = 1
floppy_drive_2 = $df2
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
rc=0
if [ "$mode" != icon ] && [ "$mode" != cx ]; then   # icon and cx start Transfer later, from Workbench
for _ in $(seq 1 90); do nc -z 127.0.0.1 6800 2>/dev/null && break; sleep 1; done
nc -z 127.0.0.1 6800 || { echo "FAIL: Transfer never listened on 6800"; tail -20 "$work/fs-uae.log"; exit 1; }
fi
listens() { nc -z -G 3 127.0.0.1 6800 2>/dev/null; }
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
  browse) pnpm exec tsx "$repo/tools/receive/run-scenarios.ts" --port 6800 --browse --uae || rc=1
          [ -e "$work/hd/EnvArc/webadf/Browse" ] && { echo "FAIL BROWSE without SAVE stored the switch"; rc=1; } \
            || echo "PASS BROWSE without SAVE stored nothing"
          sleep 2; echo "--- receive.log"; cat "$work/hd/receive.log" 2>/dev/null || true;;
  send) pnpm exec tsx "$repo/tools/receive/uae/send-scenarios.ts" --hd "$work/hd" || rc=1;;
  flip) pnpm exec tsx "$repo/tools/receive/uae/flip-scenario.ts" --hd "$work/hd" --shots "$shots" --ks "$ks" || rc=1
        echo "--- poke: $(say f1.log) / $(say f3.log)";;
  icon) waitf i0 180 || rc=1; sleep 4; shot icon; touch "$work/hd/a1"
        waitf i4 120 || rc=1
        echo "--- poke wbclick: $(say i1.log)"
        expect i2.log open "a double-click on the icon starts Transfer with its window"
        expect i3.log Transfer "Exchange's list has Transfer"
        listens && echo "PASS it listens on 6800" || { echo "FAIL it does not listen"; rc=1; }
        shot icon-run; touch "$work/hd/a2"
        waitf i7 120 || rc=1
        expect i5.log Transfer "a second double-click starts no second Transfer"
        expect i6.log open "and the window is shown";;
  cx) waitf m0 240 || rc=1
      expect c01.log closed "CX_POPUP=NO in WBStartup: no window"
      expect c02.log Transfer "Exchange's list has Transfer"
      listens && echo "PASS hidden, it listens on 6800" || { echo "FAIL hidden, not listening"; rc=1; }
      shot hidden; touch "$work/hd/a0"
      waitf m1 120 || rc=1
      expect c03.log open "the hotkey ctrl alt w shows the window"
      expect c04.log closed "Exchange Hide hides it"
      expect c05.log open "Exchange Show shows it"
      expect c06.log closed "the close gadget hides it"
      listens && echo "PASS closed by its gadget, it still listens" || { echo "FAIL the close gadget stopped it"; rc=1; }
      touch "$work/hd/a1"; waitf m2 120 || rc=1
      listens && { echo "FAIL Exchange Disable: still listening"; rc=1; } || echo "PASS Exchange Disable: no listener"
      touch "$work/hd/a2"; waitf m3 120 || rc=1
      listens && echo "PASS Exchange Enable: listening again" || { echo "FAIL Exchange Enable: not listening"; rc=1; }
      touch "$work/hd/a3"; waitf m4 120 || rc=1
      expect c07.log "Transfer is already running: its window is shown" "a second start says so and quits"
      expect c08.log open "and the first one's window is shown"
      expect c08b.log Transfer "one broker"
      expect c09.log closed "Project/Quit (Right-Amiga Q) closes it"
      expect c10.log "" "and leaves Exchange's list"
      listens && { echo "FAIL after Quit it still listens"; rc=1; } || echo "PASS after Quit nothing listens"
      touch "$work/hd/a4"; waitf m5 180 || rc=1
      expect c11.log "" "Exchange Kill ends it"
      expect c12.log closed "its window with it"
      shot exchange;;
  write) echo "--- Delete Full:Hold.txt (held by Wait's own redirection): $(tr -d '\r' < "$work/hd/holddel.log" 2>/dev/null)"
         echo "--- Delete Full:Hold2.txt (Run's redirection): $(tr -d '\r' < "$work/hd/hold2del.log" 2>/dev/null)"
         # 3.2's Delete says "No file to delete" (its pattern match cannot Lock a file open for writing); older ones may
         # say "in use". Either way it must not say Deleted, and w-replace-busy then lists Hold.txt still there.
         [ -s "$work/hd/holddel.log" ] && ! grep -q 'Deleted' "$work/hd/holddel.log" \
           && echo "PASS Hold.txt is held open: AmigaDOS's Delete could not remove it" \
           || { echo "FAIL Hold.txt is not held open: w-replace-busy would prove nothing"; rc=1; }
         pnpm exec tsx "$repo/tools/receive/run-scenarios.ts" --port 6800 --write "$work/hd" --uae ${WEBADF_ONLY:+--only "$WEBADF_ONLY"} || rc=1
         [ -e "$work/hd/EnvArc/webadf/Write" ] && { echo "FAIL WRITE without SAVE stored the switch"; rc=1; } \
           || echo "PASS WRITE without SAVE stored nothing"
         sleep 2; echo "--- receive.log"; cat "$work/hd/receive.log" 2>/dev/null || true;;
esac
exit $rc
