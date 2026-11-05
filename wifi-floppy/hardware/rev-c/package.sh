#!/bin/bash
# Builds rev-c-kicad-project.zip: the project with its libraries inside, openable anywhere with KiCad 10.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/rev-c"
mkdir "$out"
cd "$here"
cp rev-c.kicad_pro rev-c.kicad_sch mcu.kicad_sch support.kicad_sch rev-c.kicad_pcb \
   rev-c-lib.kicad_sym rev-c-schematic.pdf README.md "$out/"
cp -R rev-c-lib.pretty "$out/"
cp ../wifi-floppy-lib.kicad_sym ../NOTICE.md ../KICAD-LIBRARY-LICENSE.md ../LICENSE "$out/"
cp -R ../wifi-floppy-lib.pretty "$out/"
sed 's#${KIPRJMOD}/\.\./#${KIPRJMOD}/#' sym-lib-table > "$out/sym-lib-table"
sed 's#${KIPRJMOD}/\.\./#${KIPRJMOD}/#' fp-lib-table > "$out/fp-lib-table"
if grep -q '\.\./' "$out/sym-lib-table" "$out/fp-lib-table"; then echo "library table still points outside" >&2; exit 1; fi
rm -f "$here/rev-c-kicad-project.zip"
(cd "$tmp" && zip -qr -X "$here/rev-c-kicad-project.zip" rev-c)
echo "$here/rev-c-kicad-project.zip"
