"""Transfer.info, the Workbench tool icon, from its text source (Transfer 2.7, plan 2026-11-01 ruling R14).
Usage: make_transfer_icon.py <transfer-icon.txt> <out.info> [--pos X,Y] [--tooltypes "A=1|(B=2)"]
  --pos       a fixed place (FS-UAE checks); without it Workbench places the icon (NO_ICON_POSITION)
  --tooltypes replaces the default tool types, '|' between them (FS-UAE checks: CX_POPUP=NO)
The output is a classic OS 2 DiskObject (icon.library V37 reads it): WBTOOL, two 2-bitplane images (normal and
selected), no default tool, the tool types below. Deterministic: the same source gives the same bytes."""
import struct, sys

TOOLTYPES = ['DONOTWAIT', 'CX_POPUP=YES', 'CX_POPKEY=ctrl alt w', '(CX_POPUP=NO)', '(CX_PRIORITY=0)', '(TO=SYS:Downloads)']
PENS = {'.': 0, '#': 1, 'o': 2, '*': 3}   # grey, black, white, blue: the Workbench 2/3 palette
STACK = 32768                              # the window's stack (main.c RX_STACK_GUI): no StackSwap needed
NO_ICON_POSITION = 0x80000000


def read_source(path):
    imgs, cur = {}, None
    for line in open(path, encoding='ascii').read().splitlines():
        if not line or line.startswith('#'):
            continue
        if line in ('normal', 'selected'):
            cur = imgs.setdefault(line, [])
            continue
        if cur is None or any(c not in PENS for c in line):
            sys.exit('make_transfer_icon: bad line %r' % line)
        cur.append(line)
    if set(imgs) != {'normal', 'selected'}:
        sys.exit('make_transfer_icon: need a normal and a selected image')
    w, h = len(imgs['normal'][0]), len(imgs['normal'])
    for rows in imgs.values():
        if len(rows) != h or any(len(r) != w for r in rows):
            sys.exit('make_transfer_icon: both images must be %d x %d' % (w, h))
    return w, h, imgs['normal'], imgs['selected']


def image(rows, w, h):
    """struct Image (20 bytes) and its two bitplanes, rows padded to 16 bits."""
    words = (w + 15) // 16
    out = struct.pack('>hhhhhIBBI', 0, 0, w, h, 2, 1, 3, 0, 0)   # ImageData non-zero: present; PlanePick 3
    for plane in range(2):
        for r in rows:
            bits = [(PENS[c] >> plane) & 1 for c in r] + [0] * (words * 16 - w)
            out += bytes(int(''.join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8))
    return out


def disk_object(w, h, normal, selected, pos, tooltypes):
    x, y = pos if pos else (NO_ICON_POSITION, NO_ICON_POSITION)
    gadget = struct.pack('>IhhhhHHHIIIIIhI',
                         0, 0, 0, w, h,
                         0x0006,       # GFLG_GADGIMAGE | GFLG_GADGHIMAGE: the second image when selected
                         0x0003,       # GACT_RELVERIFY | GACT_IMMEDIATE
                         0x0001,       # GTYP_BOOLGADGET
                         1, 1,         # GadgetRender, SelectRender: present
                         0, 0, 0, 0,   # GadgetText, MutualExclude, SpecialInfo, GadgetID
                         1)            # UserData: WB_DISKREVISION 1 (OS 2)
    head = struct.pack('>HH', 0xE310, 1) + gadget + struct.pack('>BBIIIIIII',
                         3, 0,         # WBTOOL, pad
                         0, 1 if tooltypes else 0,   # DefaultTool none, ToolTypes present
                         x & 0xFFFFFFFF, y & 0xFFFFFFFF, 0, 0, STACK)
    assert len(head) == 78
    out = head + image(normal, w, h) + image(selected, w, h)
    if tooltypes:
        out += struct.pack('>I', (len(tooltypes) + 1) * 4)
        for t in tooltypes:
            s = t.encode('latin-1') + b'\x00'
            out += struct.pack('>I', len(s)) + s
    return out


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    pos, tts = None, TOOLTYPES
    rest = argv[3:]
    while rest:
        if rest[0] == '--pos' and len(rest) > 1:
            pos = tuple(int(v) for v in rest[1].split(',')); rest = rest[2:]
        elif rest[0] == '--tooltypes' and len(rest) > 1:
            tts = [t for t in rest[1].split('|') if t]; rest = rest[2:]
        else:
            sys.exit(__doc__)
    w, h, normal, selected = read_source(argv[1])
    open(argv[2], 'wb').write(disk_object(w, h, normal, selected, pos, tts))


if __name__ == '__main__':
    main(sys.argv)
