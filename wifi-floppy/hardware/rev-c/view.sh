#!/bin/bash
# view.sh <dir> <layers> <png>: a picture of the board for review.
KC=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
$KC pcb export pdf --mode-single -l "$2" --drill-shape-opt 2 -o "$1/v.pdf" "$1/rev-c.kicad_pcb" >/dev/null 2>&1
pdftoppm -r 500 -png -singlefile "$1/v.pdf" "$1/v" && magick "$1/v.png" -trim +repage "$3"
