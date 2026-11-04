#!/usr/bin/env python3
"""Write a Devs/system-configuration for the HDPart boot floppy.

Kickstart reads this file at boot. Without it the system default font is
topaz 9, so the Workbench screen and window titles look wrong on the ADF.

The file is struct Preferences from intuition/preferences.h, 232 bytes,
big-endian. It is built from named fields rather than copied from a Workbench
disk, so the ADF stays free of Commodore files. The pointer is drawn here.

Usage: mksysconfig.py OUTPUT
"""
import struct
import sys

SIZE = 232

# One row per line: . clear, R color17, K color18, W color19.
POINTER = """
KK..............
KWK.............
KWWK............
KWWWK...........
KWWWWK..........
KWWWWWK.........
KWWWWWWK........
KWWWWWWWK.......
KWWWWWKKKK......
KWWKWWK.........
KWK.KWWK........
KK..KWWK........
.....KWWK.......
.....KWWK.......
......KK........
................
""".split()

PLANES = {".": (0, 0), "R": (1, 0), "K": (0, 1), "W": (1, 1)}


def pointer_matrix():
    """Two control words, 16 rows of two bitplanes, two end words: 36 words."""
    if len(POINTER) != 16 or any(len(row) != 16 for row in POINTER):
        raise ValueError("pointer must be 16 by 16")
    words = [0, 0]
    for row in POINTER:
        plane0 = plane1 = 0
        for ch in row:
            bit0, bit1 = PLANES[ch]
            plane0 = plane0 << 1 | bit0
            plane1 = plane1 << 1 | bit1
        words += [plane0, plane1]
    return words + [0, 0]


def build():
    data = struct.pack(">bBH", 8, 0, 5)              # FontHeight (TOPAZ_EIGHTY), PrinterPort, BaudRate 9600
    data += struct.pack(">II", 0, 50000)             # KeyRptSpeed
    data += struct.pack(">II", 0, 600000)            # KeyRptDelay
    data += struct.pack(">II", 1, 20000)             # DoubleClick
    data += struct.pack(">36H", *pointer_matrix())   # PointerMatrix
    data += struct.pack(">bb", -1, 0)                # XOffset, YOffset
    data += struct.pack(">3H", 0x0E44, 0x0000, 0x0EEC)  # color17 to color19
    data += struct.pack(">H", 1)                     # PointerTicks
    data += struct.pack(">4H", 0x0AAA, 0x0000, 0x0FFF, 0x068B)  # color0 to color3
    data += struct.pack(">bbhh", 0, 0, 0x81, 0x2C)   # ViewXOffset, ViewYOffset, ViewInitX, ViewInitY
    data += struct.pack(">HH", 0, 0)                 # EnableCLI, PrinterType
    data += struct.pack(">30s", b"generic")          # PrinterFilename
    data += struct.pack(">3H", 0, 0, 0)              # PrintPitch, PrintQuality, PrintSpacing
    data += struct.pack(">HH", 5, 75)                # PrintLeftMargin, PrintRightMargin
    data += struct.pack(">3Hh", 0, 0, 0, 7)          # PrintImage, PrintAspect, PrintShade, PrintThreshold
    data += struct.pack(">3H", 0x20, 0x42, 0)        # PaperSize, PaperLength, PaperType
    data += bytes(4)                                 # SerRWBits, SerStopBuf, SerParShk, LaceWB
    data += bytes(12)                                # Pad
    data += bytes(16)                                # PrtDevName
    data += bytes(4)                                 # DefaultPrtUnit, DefaultSerUnit, RowSizeChange, ColumnSizeChange
    data += struct.pack(">3H", 0, 0, 0)              # PrintFlags, PrintMaxWidth, PrintMaxHeight
    data += struct.pack(">BB", 1, 0)                 # PrintDensity, PrintXOffset
    data += struct.pack(">HHBB", 0, 0, 0, 0)         # wb_Width, wb_Height, wb_Depth, ext_size
    if len(data) != SIZE:
        raise ValueError(f"built {len(data)} bytes, expected {SIZE}")
    return data


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], "wb") as out:
        out.write(build())


if __name__ == "__main__":
    main()
