#!/bin/bash
# variants.sh: one pre-routed board, several Freerouting strategies side by side; the DRC of each.
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3; KC=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
rm -rf vb; mkdir -p vb; cp ../wifi_floppy.kicad_pro vb/rev-c.kicad_pro
$PY build_board.py 2 vb/rev-c.kicad_pcb 2>&1 | grep -v "memory leak\|create wxApp"
python3 rules.py vb/rev-c.kicad_pro
$PY regulator.py vb/rev-c.kicad_pcb 2>&1 | grep -v "create wxApp\|memory"
$PY stitch.py vb/rev-c.kicad_pcb 2>&1 | grep -v "create wxApp\|memory"
$PY route.py export vb/rev-c.kicad_pcb vb/rev-c.dsn 2>&1 | grep -v "create wxApp\|memory" >/dev/null
python3 - vb/rev-c.dsn <<'PY'
import re,sys
s=open(sys.argv[1]).read()
for n in ('GND', r'"?\+3\.3V"?'):
    s,c=re.subn(r'(\(net %s\s*\n?\s*\(pins)[^)]*\)'%n, r'\1)', s)
open(sys.argv[1],'w').write(s)
PY
run() { d=$1; shift; mkdir -p $d; cp vb/rev-c.kicad_pcb vb/rev-c.kicad_pro vb/rev-c.dsn $d/
  timeout 1500 /Applications/freerouting.app/Contents/MacOS/freerouting -de $d/rev-c.dsn -do $d/rev-c.ses -mp ${PASSES:-30} --gui.enabled=false "$@" > $d/fr.log 2>&1
  $PY route.py import $d/rev-c.kicad_pcb $d/rev-c.ses 4 2>&1 | grep -v "create wxApp\|memory" >/dev/null
  $KC pcb drc --format json --all-track-errors -o $d/drc1.json $d/rev-c.kicad_pcb >/dev/null 2>&1
  echo "== $d $* $(grep -c 'Auto-routing pass' $d/fr.log) passes"; python3 drc_sum.py $d/drc1.json | cut -c1-240; }
run v1 -is random -us global
