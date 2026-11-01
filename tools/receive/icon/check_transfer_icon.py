"""Reads Transfer.info back the way icon.library does and checks it: a classic OS 2 tool icon, two 4-colour images of
the source's size whose pixels match the source, the default tool types. Usage: check_transfer_icon.py <source.txt> <info>
Prints PASS or FAIL lines; exit 1 on a failure."""
import struct, sys

src, info = sys.argv[1], sys.argv[2]
d = open(info, 'rb').read()
fails = []
def check(ok, what):
    print(('PASS ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

magic, ver = struct.unpack('>HH', d[0:4])
w, h = struct.unpack('>hh', d[12:16])
flags = struct.unpack('>H', d[16:18])[0]
gr, sr = struct.unpack('>II', d[22:30])
userdata = struct.unpack('>I', d[44:48])[0]
dtype = d[48]
deftool, tts = struct.unpack('>II', d[50:58])
cx, cy = struct.unpack('>II', d[58:66])
drawer, toolwin, stack = struct.unpack('>III', d[66:78])
check(magic == 0xE310 and ver == 1, 'DiskObject magic E310, version 1')
check(dtype == 3 and drawer == 0 and deftool == 0 and toolwin == 0, 'WBTOOL, no drawer data, no default tool')
check(gr and sr and flags & 6 == 6, 'two images, the second shown when selected')
check(userdata == 1, 'OS 2 revision')
check(cx == 0x80000000 and cy == 0x80000000, 'no position: Workbench places it')
check(stack == 32768, 'stack 32768')

rows = {'normal': [], 'selected': []}; cur = None
for line in open(src).read().splitlines():
    if line in rows: cur = rows[line]
    elif line and not line.startswith('#') and cur is not None: cur.append(line)
pens = {'.': 0, '#': 1, 'o': 2, '*': 3}
p = 78
for name in ('normal', 'selected'):
    iw, ih, depth = struct.unpack('>hhh', d[p + 4:p + 10])
    pick = d[p + 14]
    check((iw, ih, depth, pick) == (w, h, 2, 3), '%s image %dx%d, 2 planes' % (name, iw, ih))
    bpr = ((iw + 15) // 16) * 2
    planes = [d[p + 20 + k * bpr * ih:p + 20 + (k + 1) * bpr * ih] for k in range(2)]
    ok = True
    for y in range(ih):
        for x in range(iw):
            pen = sum(((planes[k][y * bpr + x // 8] >> (7 - x % 8)) & 1) << k for k in range(2))
            ok = ok and pen == pens[rows[name][y][x]]
    check(ok, '%s pixels match the source' % name)
    p += 20 + bpr * ih * 2
n = struct.unpack('>I', d[p:p + 4])[0] // 4 - 1; p += 4
got = []
for _ in range(n):
    k = struct.unpack('>I', d[p:p + 4])[0]; got.append(d[p + 4:p + 4 + k - 1].decode('latin-1')); p += 4 + k
check(tts != 0 and got == ['DONOTWAIT', 'CX_POPUP=YES', 'CX_POPKEY=ctrl alt w', '(CX_POPUP=NO)', '(CX_PRIORITY=0)', '(TO=SYS:Downloads)'],
      'tool types %s' % got)
check(p == len(d), 'nothing after the tool types (%d bytes)' % len(d))
sys.exit(1 if fails else 0)
