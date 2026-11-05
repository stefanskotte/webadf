#!/usr/bin/env python3
# First draft of the rev C schematic: rev B's sheet with the PIM726 module taken out, plus two new sheets with the
# module's parts, after Pimoroni's Pico Plus 2 schematic. Run once to start from; after that the .kicad_sch files are
# the source and are edited in KiCad. It overwrites them, so do not re-run over hand edits.
# Refs and values follow rev-c.kicad_pcb, so verify_sch.py can compare the two.
import os, re, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
STOCK = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols/'
PROJECT = 'rev-c'
ROOT_UUID = 'c9178abf-c4d6-4242-b99e-f9f08c77f33c'     # rev B's, so the symbols' instance paths stay valid
_u = [0]
def uid(seed=''):
    _u[0] += 1
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'rev-c/{_u[0]}/{seed}'))
def num(v):
    v = round(float(v), 4)
    return str(int(v)) if v == int(v) else str(v)

# --- s-expression text helpers -----------------------------------------------------------------
def block_end(s, i):
    d, q = 0, False
    while True:
        c = s[i]
        if q:
            if c == '\\': i += 1
            elif c == '"': q = False
        elif c == '"': q = True
        elif c == '(': d += 1
        elif c == ')':
            d -= 1
            if d == 0: return i + 1
        i += 1
def children(b):
    """Top-level (...) items inside block b."""
    out, i = [], b.index('(') + 1
    while True:
        j = b.find('(', i)
        if j < 0: return out
        e = block_end(b, j)
        out.append(b[j:e]); i = e
def tag(b):
    return re.match(r'\(\s*([^\s()]+)', b).group(1)

# --- symbols -----------------------------------------------------------------------------------
def stock(lib, name):
    s = open(STOCK + lib + '.kicad_sym').read()
    i = s.index(f'(symbol "{name}"\n')
    return s[i:block_end(s, i)], s
def flat(lib, name, newname=None, value=None):
    """A stock symbol with its 'extends' resolved, named newname."""
    b, whole = stock(lib, name)
    parts = children(b)
    m = re.search(r'\(extends "([^"]+)"\)', b)
    base = name
    while m:                     # a symbol may extend one that itself extends another
        base = m.group(1)
        i = whole.index(f'(symbol "{base}"\n')
        pb = whole[i:block_end(whole, i)]
        own = [p for p in parts if tag(p) in ('property', 'description')]
        names = {re.match(r'\(property "([^"]+)"', p).group(1) for p in own if tag(p) == 'property'}
        rest = [p for p in children(pb) if not (tag(p) == 'property' and re.match(r'\(property "([^"]+)"', p).group(1) in names)]
        m = re.search(r'\(extends "([^"]+)"\)', pb)
        parts = [p for p in own + rest if tag(p) != 'extends']
    newname = newname or name
    txt = []
    for p in parts:
        if tag(p) == 'symbol':
            p = re.sub(r'\(symbol "' + re.escape(base) + r'_(\d+_\d+)"', lambda k: f'(symbol "{newname}_{k.group(1)}"', p)
        elif tag(p) == 'property' and value and p.startswith('(property "Value"'):
            p = re.sub(r'\(property "Value" "[^"]*"', f'(property "Value" "{value}"', p)
        txt.append(p)
    return f'(symbol "{newname}"\n' + '\n'.join(txt) + '\n)'
def rm2_symbol():
    pin = lambda t, x, y, r, name, n: (f'(pin {t} line (at {x} {y} {r}) (length 2.54) (name "{name}" (effects (font (size 1.27 1.27)))) '
                                       f'(number "{n}" (effects (font (size 1.27 1.27)))))')
    left = [('3','SCLK','input'),('5','DATA_IN','bidirectional'),('6','DATA_OUT','bidirectional'),('9','~{CS}','input'),('10','~{IRQ}','output'),
            ('12','WL_ON','input'),('13','BT_ON','input')]
    right = [('16','VIN','power_in'),('14','VDDIO','power_in'),('8','GPIO0','bidirectional'),('18','GPIO1','bidirectional'),('17','GPIO2','bidirectional'),
             ('2','NC','no_connect'),('19','NC','no_connect'),('20','NC','no_connect')]
    gnd = ['1','4','7','11','15','21']
    ps = [pin(t, -17.78, 10.16 - 2.54*i, 0, nm, n) for i, (n, nm, t) in enumerate(left)]
    ps += [pin(t, 17.78, 10.16 - 2.54*i, 180, nm, n) for i, (n, nm, t) in enumerate(right)]
    ps += [pin('power_in' if i == 0 else 'passive', -6.35 + 2.54*i, -15.24, 90, 'GND', n) for i, n in enumerate(gnd)]
    f = '(effects (font (size 1.27 1.27)))'
    h = '(effects (font (size 1.27 1.27)) (hide yes))'
    return f'''(symbol "RM2"
(exclude_from_sim no) (in_bom yes) (on_board yes)
(property "Reference" "M" (at -15.24 15.24 0) {f})
(property "Value" "RM2" (at 15.24 15.24 0) {f})
(property "Footprint" "rev-c-lib:Raspberry_Pi_RM2" (at 0 0 0) {h})
(property "Datasheet" "https://datasheets.raspberrypi.com/rm2/rm2-datasheet.pdf" (at 0 0 0) {h})
(property "Description" "Raspberry Pi Radio Module 2 (CYW43439). Pin numbers from RM2 datasheet table 2" (at 0 0 0) {h})
(symbol "RM2_0_1" (rectangle (start -15.24 13.97) (end 15.24 -12.7) (stroke (width 0.254) (type default)) (fill (type background))))
(symbol "RM2_1_1" {' '.join(ps)})
)'''

NEW = {  # name -> symbol text: everything the new sheets use lives in rev-c-lib, like rev B's own library
    'RP2350B': flat('MCU_RaspberryPi', 'RP2350B'),
    'W25Q128JVS': flat('Memory_Flash', 'W25Q128JVS'),
    'IS66WVS16M8FBLL': flat('Memory_RAM', 'APS6404L-3SQRx-SN', 'IS66WVS16M8FBLL', 'IS66WVS16M8FBLL-104NLI'),
    'NCP1117-3.3_SOT223': flat('Regulator_Linear', 'NCP1117-3.3_SOT223'),
    'USB_C_Receptacle_USB2.0_16P': flat('Connector', 'USB_C_Receptacle_USB2.0_16P'),
    'Crystal_GND24': flat('Device', 'Crystal_GND24'),
    'R_Small': flat('Device', 'R_Small'),
    'C_Small': flat('Device', 'C_Small'),
    'L': flat('Device', 'L'),
    'FerriteBead_Small': flat('Device', 'FerriteBead_Small'),
    'LED': flat('Device', 'LED'),
    'D_Schottky': flat('Device', 'D_Schottky'),
    'SW_Push': flat('Switch', 'SW_Push'),
    'Conn_01x03_MountingPin': flat('Connector_Generic_MountingPin', 'Conn_01x03_MountingPin'),
    'TestPoint': flat('Connector', 'TestPoint'),
    'RM2': rm2_symbol(),
}
POWER = {n: flat('power', n) for n in ('+3.3V', 'GND', 'PWR_FLAG', 'VBUS')}
def pins_of(txt):
    r = {}
    for b in re.finditer(r'\(pin (\w+) \w+\s*\(at ([-\d.]+) ([-\d.]+) (\d+)\).*?\(name "([^"]*)".*?\(number "([^"]*)"', txt, re.S):
        r[b.group(6)] = dict(type=b.group(1), x=float(b.group(2)), y=float(b.group(3)), rot=int(b.group(4)), name=b.group(5))
    return r
PINS = {n: pins_of(t) for n, t in NEW.items()}
PPINS = {n: pins_of(t) for n, t in POWER.items()}

def cache(name, txt, prefix):
    return re.sub(r'^\(symbol "[^"]+"', f'(symbol "{prefix}:{name}"', txt, count=1)

# --- a sheet being drawn -----------------------------------------------------------------------
PWR_NO = [100]
class Sheet:
    def __init__(self, fname, sheet_uuid, page, title):
        self.fname, self.sheet_uuid, self.page, self.title = fname, sheet_uuid, page, title
        self.items, self.wires, self.used, self.pused = [], [], set(), set()
    def path(self):
        return f'/{ROOT_UUID}/{self.sheet_uuid}'
    def wire(self, x1, y1, x2, y2):
        if (x1, y1) != (x2, y2):
            self.wires.append((round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4)))
    def text(self, s, x, y, size=1.27):
        self.items.append(f'(text "{s}" (exclude_from_sim no) (at {num(x)} {num(y)} 0) (effects (font (size {size} {size})) (justify left bottom)) (uuid "{uid()}"))')
    def heading(self, s, x, y):
        self.text(s, x, y, 2.0)
    def label(self, name, x, y, a=0):
        j = 'left bottom' if a in (0, 90) else 'right bottom'
        self.items.append(f'(label "{name}" (at {num(x)} {num(y)} {a}) (effects (font (size 1.27 1.27)) (justify {j})) (uuid "{uid()}"))')
    def glabel(self, name, x, y, a=0, shape='bidirectional'):
        j = 'left' if a in (0, 90) else 'right'
        self.items.append(f'(global_label "{name}" (shape {shape}) (at {num(x)} {num(y)} {a}) (effects (font (size 1.27 1.27)) (justify {j})) (uuid "{uid()}") '
                          f'(property "Intersheetrefs" "${{INTERSHEET_REFS}}" (at {num(x)} {num(y)} 0) (effects (font (size 1.27 1.27)) (hide yes))))')
    def nc(self, x, y):
        self.items.append(f'(no_connect (at {num(x)} {num(y)}) (uuid "{uid()}"))')
    def power(self, name, x, y):
        PWR_NO[0] += 1
        self.pused.add(name)
        ref = ('#FLG' if name == 'PWR_FLAG' else '#PWR') + f'{PWR_NO[0]:04d}'
        below = name == 'GND'
        vy = y + (3.81 if below else -3.81)
        hide = name == 'PWR_FLAG' and False
        ps = ' '.join(f'(pin "{n}" (uuid "{uid()}"))' for n in PPINS[name])
        self.items.append(f'''(symbol (lib_id "power:{name}") (at {num(x)} {num(y)} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "{uid()}")
(property "Reference" "{ref}" (at {num(x)} {num(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))
(property "Value" "{name}" (at {num(x)} {num(vy)} 0) (effects (font (size 1.27 1.27))))
(property "Footprint" "" (at {num(x)} {num(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))
(property "Datasheet" "" (at {num(x)} {num(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))
{ps}
(instances (project "{PROJECT}" (path "{self.path()}" (reference "{ref}") (unit 1)))))''')
    def place(self, ref, name, x, y, rot=0, value='', fp='', mpn='', dnp=False, ty=None, label_side=None):
        """A symbol at (x, y). Returns pin-number -> world position and outward direction."""
        self.used.add(name)
        P = PINS[name]
        out = {}
        for n, p in P.items():
            a = {0: (p['x'], p['y']), 90: (-p['y'], p['x']), 180: (-p['x'], -p['y']), 270: (p['y'], -p['x'])}[rot]
            r = (p['rot'] + rot) % 360                # direction the pin points into the body
            d = {0: (-1, 0), 90: (0, 1), 180: (1, 0), 270: (0, -1)}[r]   # outward, screen coordinates
            out[n] = dict(x=round(x + a[0], 4), y=round(y - a[1], 4), d=d, name=p['name'], type=p['type'])
        xs, ys = [o['x'] for o in out.values()], [o['y'] for o in out.values()]
        small = len(P) <= 2
        if small and rot in (0, 180) and P[list(P)[0]]['x'] == 0 or small and rot in (90, 270) and P[list(P)[0]]['x'] != 0:     # vertical part
            rx, ry, ja = x + 2.54, y - 1.27, 'left'
            vx, vy = x + 2.54, y + 1.27
        elif small:                                    # horizontal part
            rx, ry, ja = x, y - 2.54, 'center'
            vx, vy = x, y + 2.54
        else:
            rx, ry, ja = min(xs), min(ys) - 5.08, 'left'
            vx, vy = min(xs), min(ys) - 2.54
        if ty is not None: ry, vy = ty, ty + 2.54
        fa = 90 if small and rot in (90, 270) else 0      # a field's angle turns with the symbol: keep the text upright
        just = '' if ja == 'center' else f'(justify {ja})'
        e = lambda extra='': f'(effects (font (size 1.27 1.27)) {just} {extra})'
        ps = ' '.join(f'(pin "{n}" (uuid "{uid()}"))' for n in P)
        mp = f'(property "MPN" "{mpn}" (at {num(x)} {num(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))' if mpn else ''
        self.items.append(f'''(symbol (lib_id "rev-c-lib:{name}") (at {num(x)} {num(y)} {rot}) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp {'yes' if dnp else 'no'}) (uuid "{uid(ref)}")
(property "Reference" "{ref}" (at {num(rx)} {num(ry)} {fa}) {e()})
(property "Value" "{value or name}" (at {num(vx)} {num(vy)} {fa}) {e()})
(property "Footprint" "{fp}" (at {num(x)} {num(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))
(property "Datasheet" "" (at {num(x)} {num(y)} 0) (effects (font (size 1.27 1.27)) (hide yes)))
{mp}
{ps}
(instances (project "{PROJECT}" (path "{self.path()}" (reference "{ref}") (unit 1)))))''')
        return out
    def tie(self, pin, name, kind='global', stub=2.54, shape='bidirectional'):
        """Run a short stub out of a pin and end it on a label, a power symbol or a no-connect flag."""
        x, y = pin['x'], pin['y']
        if kind == 'nc':
            self.nc(x, y); return
        dx, dy = pin['d']
        ex, ey = x + dx*stub, y + dy*stub
        self.wire(x, y, ex, ey)
        a = {(1, 0): 0, (-1, 0): 180, (0, -1): 90, (0, 1): 270}[(dx, dy)]
        if kind == 'global': self.glabel(name, ex, ey, a, shape)
        elif kind == 'label': self.label(name, ex, ey, a)
        else: self.power(name, ex, ey)
    def write(self):
        ws = sorted(set(self.wires))
        ends = {}
        for x1, y1, x2, y2 in ws:
            for pt in ((x1, y1), (x2, y2)): ends[pt] = ends.get(pt, 0) + 1
        juncs = [p for p, c in ends.items() if c >= 3]
        wtxt = [f'(wire (pts (xy {num(a)} {num(b)}) (xy {num(c)} {num(d)})) (stroke (width 0) (type default)) (uuid "{uid()}"))' for a, b, c, d in ws]
        jtxt = [f'(junction (at {num(x)} {num(y)}) (diameter 0) (color 0 0 0 0) (uuid "{uid()}"))' for x, y in juncs]
        libs = [cache(n, NEW[n], 'rev-c-lib') for n in sorted(self.used)] + [cache(n, POWER[n], 'power') for n in sorted(self.pused)]
        txt = f'''(kicad_sch (version 20260306) (generator "eeschema") (generator_version "10.0")
(uuid "{self.sheet_uuid}x")
(paper "A3")
(title_block (title "{self.title}") (rev "C draft") (comment 1 "After Pimoroni PIM726; differences in README.md"))
(lib_symbols
{chr(10).join(libs)}
)
{chr(10).join(jtxt)}
{chr(10).join(wtxt)}
{chr(10).join(self.items)}
(embedded_fonts no)
)
'''.replace(f'{self.sheet_uuid}x', str(uuid.uuid5(uuid.NAMESPACE_URL, self.fname)))
        open(os.path.join(HERE, self.fname), 'w').write(txt)

FP0402R, FP0402C, FP0603C = 'Resistor_SMD:R_0402_1005Metric', 'Capacitor_SMD:C_0402_1005Metric', 'Capacitor_SMD:C_0603_1608Metric'
def is6(v): return v in ('10uF', '2.2uF')
def cap(s, ref, v, x, y): return s.place(ref, 'C_Small', x, y, 0, v, FP0603C if is6(v) else FP0402C)
def res_v(s, ref, v, x, y): return s.place(ref, 'R_Small', x, y, 0, v, FP0402R)
def res_h(s, ref, v, x, y): return s.place(ref, 'R_Small', x, y, 90, v, FP0402R)

def cap_row(s, x, y, caps, rail, kind='power', pitch=10.16):
    """A row of capacitors between a rail and GND."""
    yb = y + 10.16
    xs = [x + pitch*i for i in range(len(caps))]
    for i, (ref, v) in enumerate(caps):
        p = cap(s, ref, v, xs[i], y + 5.08)
        s.wire(xs[i], y, p['1']['x'], p['1']['y'])
        s.wire(p['2']['x'], p['2']['y'], xs[i], yb)
        if i:
            s.wire(xs[i-1], y, xs[i], y); s.wire(xs[i-1], yb, xs[i], yb)
    if kind == 'power': s.power(rail, x, y)
    elif kind == 'label':
        s.wire(xs[-1], y, xs[-1] + 5.08, y); s.label(rail, xs[-1] + 5.08, y)
    s.power('GND', x, yb)
    return xs[-1]

# --- sheet 2: RP2350B, its supplies, crystal, RM2 ------------------------------------------------
MCU_ID = 'a1f0c350-2350-4b00-9000-000000000002'
SUP_ID = 'a1f0c350-2350-4b00-9000-000000000003'
m = Sheet('mcu.kicad_sch', MCU_ID, 2, 'Rev C: RP2350B and RM2')
UX, UY = 215.9, 142.24
u = m.place('U1', 'RP2350B', UX, UY, 0, 'RP2350B', 'Package_DFN_QFN:QFN-80-1EP_10x10mm_P0.4mm_EP3.4x3.4mm_ThermalVias', 'RP2350B', ty=UY + 66.04)
GP = {0:'INDEX',1:'CHNG',2:'SEL0',3:'SEL1',4:'MTR',5:'DIR',6:'STEP',7:'WDATA',8:'WGATE',9:'SIDE',10:'WPROT',11:'RDATA',12:'RDY',13:'TRK0',
      18:'OLED_SDA',19:'OLED_SCL',21:'BUZZER',22:'ACT_LED'}                    # rev B's U1, GPIO by GPIO
LOCAL = {23:'WL_ON',24:'WL_D',25:'WL_CS',29:'WL_CLK'}
OTHER = {'QSPI_SD0':'QSD0','QSPI_SD1':'QSD1','QSPI_SD2':'QSD2','QSPI_SD3':'QSD3','QSPI_SCLK':'QSCLK','~{QSPI_SS}':'QCS','USB_DP':'USB_DP_RP','USB_DM':'USB_DM_RP',
         'RUN':'RUN','SWCLK':'SWCLK','SWDIO':'SWDIO'}
LOCP = {'XIN':'XIN','XOUT':'XOUT_RP','VREG_AVDD':'VREG_AVDD','VREG_LX':'VREG_LX','VREG_FB':'DVDD','ADC_AVDD':'ADC_AVDD'}
seen, rail, gnds = set(), [], []
for n, p in u.items():
    pos = (p['x'], p['y'])
    nm = p['name']
    g = re.match(r'GPIO(\d+)', nm)
    if pos in seen: continue
    seen.add(pos)
    if g:
        i = int(g.group(1))
        if i in GP: m.tie(p, GP[i])
        elif i in LOCAL: m.tie(p, LOCAL[i], 'label')
        elif i == 47: m.tie(p, 'PSRAM_CS')
        else: m.tie(p, '', 'nc')
    elif nm in OTHER: m.tie(p, OTHER[nm])
    elif nm in ('VREG_AVDD', 'ADC_AVDD'): m.tie(p, LOCP[nm], 'label', stub=15.24)     # clears the +3.3V bus
    elif nm in LOCP: m.tie(p, LOCP[nm], 'label')
    elif nm == 'DVDD': m.tie(p, 'DVDD', 'label')
    elif nm in ('IOVDD', 'USB_OTP_VDD', 'QSPI_IOVDD', 'VREG_VIN'): rail.append(p)
    elif nm in ('GND', 'VREG_PGND'): gnds.append(p)
    else: raise SystemExit(f'U1 pin {n} {nm} not tied')

rail.sort(key=lambda p: p['x'])
ybus = rail[0]['y'] - 7.62
for p in rail: m.wire(p['x'], p['y'], p['x'], ybus)
for a, c in zip(rail, rail[1:]): m.wire(a['x'], ybus, c['x'], ybus)
m.power('+3.3V', [p for p in rail if p['name'] == 'IOVDD'][0]['x'], ybus)
gnds.sort(key=lambda p: p['x'])
yg = gnds[0]['y'] + 2.54
for p in gnds: m.wire(p['x'], p['y'], p['x'], yg)
for a, c in zip(gnds, gnds[1:]): m.wire(a['x'], yg, c['x'], yg)
m.power('GND', gnds[0]['x'], yg)
m.heading('IOVDD, QSPI_IOVDD, USB_OTP_VDD: one 100 nF per IOVDD pin', 25.4, 30.48)
cap_row(m, 30.48, 38.1, [('C10','100nF'),('C12','100nF'),('C13','100nF'),('C14','100nF'),('C16','100nF'),('C17','100nF'),('C19','100nF'),('C20','100nF')], '+3.3V')
m.heading('Core: on-chip switcher, DVDD 1.1 V. Lay out as Raspberry Pi do', 25.4, 66.04)
xs = 30.48
lx = m.place('L1', 'L', xs + 7.62, 73.66, 90, 'MLZ2012M3R3HT000', 'Inductor_SMD:L_0805_2012Metric', 'MLZ2012M3R3HT000')
m.wire(lx['1']['x'], lx['1']['y'], xs, 73.66); m.label('VREG_LX', xs, 73.66, 180)
ex = lx['2']['x']; m.wire(ex, 73.66, 48.26, 73.66)
cap_row(m, 48.26, 73.66, [('C23','10uF'),('C11','100nF'),('C15','100nF'),('C18','100nF')], 'DVDD', 'label')
m.power('PWR_FLAG', 48.26, 73.66)
m.heading('VREG supplies', 25.4, 96.52)
cap_row(m, 30.48, 104.14, [('C21','10uF')], '+3.3V')
r = res_h(m, 'R20', '27', 50.8, 104.14)
m.power('+3.3V', 43.18, 104.14); m.wire(43.18, 104.14, r['1']['x'], r['1']['y'])
m.wire(r['2']['x'], r['2']['y'], 60.96, 104.14)
cap_row(m, 60.96, 104.14, [('C22','2.2uF')], 'VREG_AVDD', 'label')
m.power('PWR_FLAG', 60.96, 104.14)
m.heading('ADC supply', 25.4, 127.0)
r = res_h(m, 'R21', '220', 38.1, 134.62)
m.power('+3.3V', 30.48, 134.62); m.wire(30.48, 134.62, r['1']['x'], r['1']['y'])
m.wire(r['2']['x'], r['2']['y'], 48.26, 134.62)
cap_row(m, 48.26, 134.62, [('C24','2.2uF')], 'ADC_AVDD', 'label')
m.power('PWR_FLAG', 48.26, 134.62)
m.heading('Crystal 12 MHz', 25.4, 157.48)
XY = 172.72
y = m.place('Y1', 'Crystal_GND24', 50.8, XY, 0, '12MHz', 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm', ty=XY - 12.7)
pl, pr = y['1'], y['3']
m.wire(pl['x'], pl['y'], 38.1, XY)
c = cap(m, 'C25', '10pF', 38.1, XY + 5.08); m.wire(38.1, XY, c['1']['x'], c['1']['y'])
m.wire(c['2']['x'], c['2']['y'], 38.1, XY + 10.16); m.power('GND', 38.1, XY + 10.16)
m.wire(38.1, XY, 30.48, XY); m.label('XIN', 30.48, XY, 180)
m.wire(pr['x'], pr['y'], 63.5, XY)
c = cap(m, 'C26', '10pF', 63.5, XY + 5.08); m.wire(63.5, XY, c['1']['x'], c['1']['y'])
m.wire(c['2']['x'], c['2']['y'], 63.5, XY + 10.16); m.power('GND', 63.5, XY + 10.16)
r = res_h(m, 'R22', '1k', 71.12, XY); m.wire(63.5, XY, r['1']['x'], r['1']['y'])
m.wire(r['2']['x'], r['2']['y'], 78.74, XY); m.label('XOUT_RP', 78.74, XY)
m.label('XOUT', 63.5, XY)
a, c = y['2'], y['4']
m.wire(a['x'], a['y'], a['x'], a['y'] - 2.54); m.wire(a['x'], a['y'] - 2.54, a['x'] + 7.62, a['y'] - 2.54)
m.wire(a['x'] + 7.62, a['y'] - 2.54, a['x'] + 7.62, c['y'] + 2.54); m.wire(a['x'] + 7.62, c['y'] + 2.54, c['x'], c['y'] + 2.54)
m.wire(c['x'], c['y'], c['x'], c['y'] + 2.54); m.power('GND', c['x'], c['y'] + 2.54)
m.power('PWR_FLAG', 137.16, 46.99); m.wire(137.16, 46.99, 137.16, 49.53); m.power('GND', 137.16, 49.53)
m.text('RP2350B GND flag: no part on this board drives GND as a power output', 142.24, 49.53)

# RM2
MX, MY = 340.36, 137.16
M = m.place('M1', 'RM2', MX, MY, 0, 'RM2', 'rev-c-lib:Raspberry_Pi_RM2', 'Raspberry Pi RM2', ty=MY + 25.4)
m.heading('RM2 radio module', 300.0, 88.9)
m.tie(M['3'], 'WL_CLK', 'label'); m.tie(M['9'], 'WL_CS', 'label')
m.tie(M['5'], 'WL_D', 'label'); m.tie(M['6'], 'WL_DO', 'label'); m.tie(M['10'], 'WL_IRQ', 'label')
x13, y12, y13 = M['13']['x'] - 2.54, M['12']['y'], M['13']['y']
m.wire(M['12']['x'], y12, x13, y12); m.wire(M['13']['x'], y13, x13, y13); m.wire(x13, y12, x13, y13)
m.wire(x13, y12, x13 - 2.54, y12); m.label('WL_ON', x13 - 2.54, y12, 180)
for k in ('1', '4', '7', '11', '15', '21'):
    p = M[k]; m.wire(p['x'], p['y'], p['x'], p['y'] + 2.54)
xs = sorted(M[k]['x'] for k in ('1', '4', '7', '11', '15', '21'))
yg = M['1']['y'] + 2.54
for a, b in zip(xs, xs[1:]): m.wire(a, yg, b, yg)
m.power('GND', xs[0], yg)
m.tie(M['8'], 'LED_WL'); m.tie(M['17'], 'VBUS_SENSE')
m.nc(M['18']['x'], M['18']['y'])
for k in ('2', '19', '20'): m.nc(M[k]['x'], M[k]['y'])
x = M['16']['x'] + 2.54
m.wire(M['16']['x'], M['16']['y'], x, M['16']['y']); m.wire(M['14']['x'], M['14']['y'], x, M['14']['y'])
m.wire(x, M['14']['y'], x, M['16']['y'])
ytop = M['16']['y'] - 12.7
m.wire(x, M['16']['y'], x, ytop)
fb = m.place('L2', 'FerriteBead_Small', x - 15.24, ytop, 90, 'BLM18EG471SN1D', 'Inductor_SMD:L_0603_1608Metric', 'BLM18EG471SN1D')
m.wire(fb['2']['x'], fb['2']['y'], x, ytop); m.wire(fb['1']['x'], fb['1']['y'], x - 25.4, ytop); m.power('+3.3V', x - 25.4, ytop)
m.label('VDDBAT', x - 6.35, ytop)
m.wire(x, ytop, x + 7.62, ytop)
c = cap(m, 'C31', '10uF', x + 7.62, ytop + 5.08); m.wire(x + 7.62, ytop, c['1']['x'], c['1']['y'])
m.wire(c['2']['x'], c['2']['y'], x + 7.62, ytop + 10.16); m.power('GND', x + 7.62, ytop + 10.16)
m.power('PWR_FLAG', x + 7.62, ytop)
m.heading('gSPI data: one GPIO, two resistors', 300.0, 180.34)
r = res_h(m, 'R30', '470', 330.2, 190.5)
m.label('WL_D', 317.5, 190.5, 180); m.wire(317.5, 190.5, r['1']['x'], r['1']['y']); m.wire(r['2']['x'], r['2']['y'], 342.9, 190.5); m.label('WL_DO', 342.9, 190.5)
r = res_h(m, 'R31', '10k', 330.2, 200.66)
m.label('WL_D', 317.5, 200.66, 180); m.wire(317.5, 200.66, r['1']['x'], r['1']['y']); m.wire(r['2']['x'], r['2']['y'], 342.9, 200.66); m.label('WL_IRQ', 342.9, 200.66)
m.write()

# --- sheet 3: USB, power, memories, boot, debug ------------------------------------------------
s = Sheet('support.kicad_sch', SUP_ID, 3, 'Rev C: USB, power, flash, PSRAM, boot')
s.heading('USB-C', 25.4, 30.48)
J = s.place('J6', 'USB_C_Receptacle_USB2.0_16P', 50.8, 66.04, 0, 'USB-C', 'Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12', 'HRO TYPE-C-31-M-12', ty=35.56)
for k in ('A4',): s.tie(J[k], 'VBUS', 'power')
done = {(J['A4']['x'], J['A4']['y'])}
for k, p in J.items():
    pos = (p['x'], p['y'])
    if pos in done: continue
    done.add(pos)
    n = p['name']
    if n == 'D+': s.tie(p, 'USB_DP', 'label')
    elif n == 'D-': s.tie(p, 'USB_DM', 'label')
    elif n == 'CC1': s.tie(p, 'CC1', 'label')
    elif n == 'CC2': s.tie(p, 'CC2', 'label')
    elif n.startswith('SBU'): s.nc(p['x'], p['y'])
    elif n == 'VBUS': s.tie(p, 'VBUS', 'power')
    elif n in ('GND', 'SHIELD'): s.tie(p, 'GND', 'power')
    else: raise SystemExit(f'J6 {k} {n}')
def series(sh, ref, v, x, y, a, b, ga=False, gb=False):
    r = res_h(sh, ref, v, x, y)
    sh.wire(x - 10.16, y, r['1']['x'], r['1']['y']); sh.wire(r['2']['x'], r['2']['y'], x + 10.16, y)
    (sh.glabel if ga else sh.label)(a, x - 10.16, y, 180)
    (sh.glabel if gb else sh.label)(b, x + 10.16, y, 0)
series(s, 'R25', '27', 104.14, 48.26, 'USB_DP', 'USB_DP_RP', gb=True)
series(s, 'R26', '27', 104.14, 58.42, 'USB_DM', 'USB_DM_RP', gb=True)
def to_gnd(sh, ref, v, x, y, name, g=False):
    r = res_v(sh, ref, v, x, y + 5.08)
    sh.wire(x, y, r['1']['x'], r['1']['y']); sh.wire(r['2']['x'], r['2']['y'], x, y + 10.16); sh.power('GND', x, y + 10.16)
    (sh.glabel if g else sh.label)(name, x, y, 90)
to_gnd(s, 'R27', '5k1', 88.9, 71.12, 'CC1')
to_gnd(s, 'R28', '5k1', 104.14, 71.12, 'CC2')

s.heading('VBUS sense, read by RM2 GPIO2', 25.4, 111.76)
x = 40.64
s.power('VBUS', x, 119.38)
r = res_v(s, 'R33', '10k', x, 124.46); s.wire(x, 119.38, r['1']['x'], r['1']['y'])
s.wire(r['2']['x'], r['2']['y'], x, 129.54)
r2 = res_v(s, 'R34', '10k', x, 134.62); s.wire(x, 129.54, r2['1']['x'], r2['1']['y'])
s.wire(r2['2']['x'], r2['2']['y'], x, 139.7); s.power('GND', x, 139.7)
s.wire(x, 129.54, x + 7.62, 129.54); s.glabel('VBUS_SENSE', x + 7.62, 129.54, 0)
s.wire(x, 119.38, x + 10.16, 119.38); s.power('PWR_FLAG', x + 10.16, 119.38)
s.heading('VBUS to VSYS', 83.82, 111.76)
d = s.place('D3', 'D_Schottky', 101.6, 124.46, 180, 'PMEG40T30ER', 'Diode_SMD:D_SOD-123F', 'PMEG40T30ER')
s.wire(d['2']['x'], d['2']['y'], 91.44, 124.46); s.power('VBUS', 91.44, 124.46)
s.wire(d['1']['x'], d['1']['y'], 111.76, 124.46); s.glabel('VSYS', 111.76, 124.46, 0, 'passive')

s.heading('3.3 V: NCP1117, not the AP7366 of the PIM726', 25.4, 157.48)
U = s.place('U5', 'NCP1117-3.3_SOT223', 76.2, 172.72, 0, 'NCP1117ST33T3G', 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', 'NCP1117ST33T3G', ty=165.1)
vi, vo, g = U['3'], U['2'], U['1']
s.wire(vi['x'], vi['y'], 50.8, vi['y']); s.wire(50.8, vi['y'], 40.64, vi['y']); s.glabel('VSYS', 40.64, vi['y'], 180, 'passive')
c = cap(s, 'C29', '10uF', 50.8, vi['y'] + 5.08); s.wire(50.8, vi['y'], c['1']['x'], c['1']['y']); s.wire(c['2']['x'], c['2']['y'], 50.8, vi['y'] + 10.16); s.power('GND', 50.8, vi['y'] + 10.16)
s.wire(vo['x'], vo['y'], 101.6, vo['y'])
c = cap(s, 'C30', '10uF', 101.6, vo['y'] + 5.08); s.wire(101.6, vo['y'], c['1']['x'], c['1']['y']); s.wire(c['2']['x'], c['2']['y'], 101.6, vo['y'] + 10.16); s.power('GND', 101.6, vo['y'] + 10.16)
s.power('+3.3V', 101.6, vo['y'])
s.wire(g['x'], g['y'], g['x'], g['y'] + 5.08); s.power('GND', g['x'], g['y'] + 5.08)

def memory(sh, ref, name, x, y, value, fp, mpn, cs):
    P = sh.place(ref, name, x, y, 0, value, fp, mpn)
    nets = {'2':'QSD1','3':'QSD2','5':'QSD0','6':'QSCLK','7':'QSD3'}
    for k, n in nets.items(): sh.tie(P[k], n)
    sh.tie(P['1'], cs)
    sh.tie(P['8'], '+3.3V', 'power'); sh.tie(P['4'], 'GND', 'power')
    return P
s.heading('Flash, 16 MB, on QSPI CS0', 170.18, 30.48)
memory(s, 'U3', 'W25Q128JVS', 200.66, 60.96, 'W25Q128JVSIQ', 'Package_SO:SOIC-8_5.3x5.3mm_P1.27mm', 'W25Q128JVSIQ', 'QCS')
cap_row(s, 170.18, 83.82, [('C27','100nF')], '+3.3V')
s.power('+3.3V', 182.88, 83.82); r = res_v(s, 'R23', '10k', 182.88, 88.9); s.wire(182.88, 83.82, r['1']['x'], r['1']['y'])
s.wire(r['2']['x'], r['2']['y'], 182.88, 93.98); s.glabel('QCS', 182.88, 93.98, 270)
s.heading('BOOTSEL: hold while plugging in USB', 170.18, 109.22)
r = s.place('R29', 'R_Small', 190.5, 119.38, 270, '1k', FP0402R)     # pin 1 towards the switch, as on the board
s.wire(180.34, 119.38, r['2']['x'], r['2']['y']); s.glabel('QCS', 180.34, 119.38, 180)
s.wire(r['1']['x'], r['1']['y'], 205.74, 119.38); s.label('BOOT_R', 200.66, 119.38)
sw = s.place('SW1', 'SW_Push', 213.36, 119.38, 0, 'BOOTSEL', 'Button_Switch_SMD:SW_Push_1P1T_XKB_TS-1187A', 'XKB TS-1187A')
s.wire(205.74, 119.38, sw['1']['x'], sw['1']['y'])
s.wire(sw['2']['x'], sw['2']['y'], 226.06, 119.38); s.wire(226.06, 119.38, 226.06, 124.46); s.power('GND', 226.06, 124.46)
s.heading('RUN: no button (operator, 2026-11-05). Internal pull-up; pad for tweezers', 170.18, 139.7)
tp = s.place('TP1', 'TestPoint', 190.5, 149.86, 0, 'RUN', 'TestPoint:TestPoint_Pad_D1.0mm')
s.wire(tp['1']['x'], tp['1']['y'], tp['1']['x'], tp['1']['y'] + 2.54); s.glabel('RUN', tp['1']['x'], tp['1']['y'] + 2.54, 270)

s.heading('PSRAM, 16 MB, GP47: not the APS6404 of the PIM726', 289.56, 30.48)
memory(s, 'U4', 'IS66WVS16M8FBLL', 320.04, 60.96, 'IS66WVS16M8FBLL-104NLI', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', 'IS66WVS16M8FBLL-104NLI', 'PSRAM_CS')
cap_row(s, 289.56, 83.82, [('C28','2.2uF')], '+3.3V')
s.power('+3.3V', 302.26, 83.82); r = res_v(s, 'R24', '10k', 302.26, 88.9); s.wire(302.26, 83.82, r['1']['x'], r['1']['y'])
s.wire(r['2']['x'], r['2']['y'], 302.26, 93.98); s.glabel('PSRAM_CS', 302.26, 93.98, 270)
s.heading('Debug', 289.56, 109.22)
D = s.place('J7', 'Conn_01x03_MountingPin', 317.5, 124.46, 0, 'SWD', 'Connector_JST:JST_SH_BM03B-SRSS-TB_1x03-1MP_P1.00mm_Vertical', 'JST BM03B-SRSS-TB')
s.tie(D['1'], 'SWCLK', stub=5.08); s.tie(D['2'], 'GND', 'power', stub=25.4); s.tie(D['3'], 'SWDIO', stub=5.08)
s.wire(D['MP']['x'], D['MP']['y'], D['MP']['x'], D['MP']['y'] + 2.54); s.power('GND', D['MP']['x'], D['MP']['y'] + 2.54)
s.heading('Wi-Fi LED, driven by RM2 GPIO0', 289.56, 157.48)
s.glabel('LED_WL', 299.72, 170.18, 180)
r = res_h(s, 'R32', '470', 309.88, 170.18); s.wire(299.72, 170.18, r['1']['x'], r['1']['y'])
l = s.place('D4', 'LED', 327.66, 170.18, 180, 'green', 'LED_SMD:LED_0603_1608Metric')
s.wire(r['2']['x'], r['2']['y'], l['2']['x'], l['2']['y']); s.label('LED_A', 317.5, 170.18)
s.wire(l['1']['x'], l['1']['y'], 337.82, 170.18); s.wire(337.82, 170.18, 337.82, 175.26); s.power('GND', 337.82, 175.26)
s.write()

# --- project symbol library ----------------------------------------------------------------------
open(os.path.join(HERE, 'rev-c-lib.kicad_sym'), 'w').write(
    '(kicad_symbol_lib (version 20251024) (generator "draw_schematic") (generator_version "10.0")\n' + '\n'.join(NEW[n] for n in sorted(NEW)) + '\n)\n')
open(os.path.join(HERE, 'sym-lib-table'), 'w').write(
    '(sym_lib_table\n\t(version 7)\n\t(lib (name "rev-c-lib") (type "KiCad") (uri "${KIPRJMOD}/rev-c-lib.kicad_sym") (options "") (descr ""))\n'
    '\t(lib (name "wifi-floppy-lib") (type "KiCad") (uri "${KIPRJMOD}/../wifi-floppy-lib.kicad_sym") (options "") (descr ""))\n'
    '\t(lib (name "power") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/power.kicad_sym") (options "") (descr ""))\n)\n')
open(os.path.join(HERE, 'fp-lib-table'), 'w').write(
    '(fp_lib_table\n\t(version 7)\n\t(lib (name "rev-c-lib") (type "KiCad") (uri "${KIPRJMOD}/rev-c-lib.pretty") (options "") (descr ""))\n'
    '\t(lib (name "wifi-floppy-lib") (type "KiCad") (uri "${KIPRJMOD}/../wifi-floppy-lib.pretty") (options "") (descr ""))\n' + ''.join(
        f'\t(lib (name "{n}") (type "KiCad") (uri "${{KICAD10_FOOTPRINT_DIR}}/{n}.pretty") (options "") (descr ""))\n'
        for n in ('Resistor_SMD', 'Capacitor_SMD', 'Inductor_SMD', 'Package_DFN_QFN', 'Package_SO', 'Package_TO_SOT_SMD', 'Crystal', 'Connector_USB', 'Connector_JST',
                  'Diode_SMD', 'LED_SMD', 'Button_Switch_SMD', 'TestPoint')) + ')\n')

# --- root sheet: rev B with the module out -------------------------------------------------------
src = open(os.path.join(HERE, '../wifi_floppy.kicad_sch')).read()
head_end = src.index('(lib_symbols')
head, parts = src[:head_end], children(src)
U1X, U1Y = 210.82, 74.93
lib = open(os.path.join(HERE, '../wifi-floppy-lib.kicad_sym')).read()
i = lib.index('(symbol "RaspberryPi_Pico_W"')
u1pts = {(round(U1X + p['x'], 2), round(U1Y - p['y'], 2)) for p in pins_of(lib[i:block_end(lib, i)]).values()}
gone = u1pts | {(205.74, 31.75), (195.58, 31.75), (215.9, 31.75), (237.49, 97.79), (237.49, 99.06), (210.82, 114.3)}
removed, keep = [], []
for p in parts:
    t = tag(p)
    if t == 'lib_symbols':
        syms = [c for c in children(p) if 'wifi-floppy-lib:RaspberryPi_Pico_W"' not in c[:60]]
        syms += [cache(n, POWER[n], 'power') for n in () ]
        keep.append('(lib_symbols\n' + '\n'.join(syms) + '\n)'); continue
    if t in ('version', 'generator', 'generator_version', 'uuid', 'paper'): continue
    if t == 'symbol' and 'RaspberryPi_Pico_W' in p[:80]: removed.append('U1'); continue
    at = re.search(r'\(at ([\d.]+) ([\d.]+)', p)
    pos = (round(float(at.group(1)), 2), round(float(at.group(2)), 2)) if at else None
    if t == 'symbol' and p.lstrip().startswith('(symbol') and pos in gone: removed.append(pos); continue
    if t == 'no_connect' and pos in u1pts: removed.append(pos); continue
    if t == 'wire':
        pts = re.findall(r'\(xy ([\d.]+) ([\d.]+)\)', p)
        if any((round(float(a), 2), round(float(b), 2)) in gone for a, b in pts): removed.append('w'); continue
    if t == 'global_label' and pos[0] in (173.99, 241.3): removed.append('g'); continue
    if t == 'label' and pos == (195.58, 31.75): removed.append('l'); continue
    if t == 'label' and pos == (19.05, 31.75):
        s_id = uid('vsys')
        keep.append(f'(global_label "VSYS" (shape passive) (at 19.05 31.75 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "{s_id}") '
                    f'(property "Intersheetrefs" "${{INTERSHEET_REFS}}" (at 19.05 31.75 0) (effects (font (size 1.27 1.27)) (hide yes))))'); continue
    if t in ('sheet_instances', 'embedded_fonts', 'title_block'): continue
    keep.append(p)
def sheet_sym(name, file, x, y, w, h, sid, page):
    return f'''(sheet (at {x} {y}) (size {w} {h}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0)) (uuid "{sid}")
(property "Sheetname" "{name}" (at {x} {y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
(property "Sheetfile" "{file}" (at {x} {y + h + 0.6} 0) (effects (font (size 1.27 1.27)) (justify left top)))
(instances (project "{PROJECT}" (path "/{ROOT_UUID}" (page "{page}")))))'''
out = f'''(kicad_sch (version 20260306) (generator "eeschema") (generator_version "10.0")
(uuid "{ROOT_UUID}")
(paper "A4")
(title_block (title "WiFi Floppy rev C") (rev "C draft") (comment 1 "Floppy side as rev B; the module's parts on two sheets"))
{chr(10).join(keep)}
(text "PIM726's parts: nets cross by global label" (exclude_from_sim no) (at 190.5 35.56 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "{uid()}"))
{sheet_sym('MCU', 'mcu.kicad_sch', 190.5, 43.18, 50.8, 20.32, MCU_ID, 2)}
{sheet_sym('Support', 'support.kicad_sch', 190.5, 72.39, 50.8, 20.32, SUP_ID, 3)}
(sheet_instances (path "/" (page "1")))
(embedded_fonts no)
)
'''.replace('(project "wifi_floppy"', f'(project "{PROJECT}"')
open(os.path.join(HERE, 'rev-c.kicad_sch'), 'w').write(out)
print('removed from rev B sheet:', len(removed))
