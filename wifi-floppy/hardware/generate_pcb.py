#!/usr/bin/env python3
"""
WiFi floppy emulator — PCB generator.

Emits wifi_floppy.kicad_pcb (KiCad 7/8 openable, s-expr version 20221018)
with placed footprints and fully routed 45-degree traces, then runs a
DRC-lite pass (same-layer segment crossings, clearance, 45-degree rule).

Board:
  J1  2x17 THT 34-pin floppy header (Amiga internal pinout)
  J2  4-pin Berg power (5V in)
  U1  Pimoroni PIM726 on two 1x20 THT rows (rows 17.78 mm apart). The part
      number is a REQUIREMENT: the firmware targets
      pimoroni_pico_plus2_w_rp2350 and psram_image.c is a 2.03 MB store in
      that board's PSRAM. A pin-compatible module without PSRAM fits and
      then does not work.
  U2  74LVC541A SOIC-20W (bus -> Pico input buffer, 5V-tolerant).
      The ONLY part with silkscreen: it is the one that can be fitted the
      wrong way round and not be obvious. Caps and SOT-23s are deliberately
      left bare (operator's call, 2026-09-04).
  Q1..Q6 BSS138 SOT-23 open-drain output drivers (GPIO high = bus low)
  D1  SS14 Schottky 5V -> VSYS
  C1  100n (U2), C3 10u bulk
"""
import uuid, math, sys, os, os

# Paths resolve against THIS FILE, not the working directory. These were
# absolute /home/claude/... paths from wherever the script was first written,
# so none of them could run on another machine -- which is why the board could
# not be regenerated here until 2026-09-04.
HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- geometry
def J1_y(row): return 107.0 + (row - 1) * 2.54          # rows 1..17
J1_XA, J1_XB = 106.0, 108.54                             # odd / even columns

U2_X, U2_Y = 137.0, 112.0
U2_XL, U2_XR = 132.3, 141.7
def U2_pin(n):                                           # SOIC-20W
    if n <= 10:  return (U2_XL, 106.285 + (n - 1) * 1.27)
    else:        return (U2_XR, 106.285 + (20 - n) * 1.27)

PICO_XW, PICO_XE = 166.0, 183.78
def PICO_pin(n):                                         # 2x20 THT rows
    if n <= 20:  return (PICO_XW, 107.0 + (n - 1) * 2.54)
    else:        return (PICO_XE, 107.0 + (40 - n) * 2.54)

# FETs: D pad (pin 3) west at cx-1.1; G (pin 1) and S (pin 2) east at cx+1.1.
# Canonical KiCad SOT-23: pad1(-1,-0.95) pad2(-1,+0.95) pad3(+1,0). Rotated
# 180 deg to put the drain west, a real part has GATE at cy+0.95 and SOURCE
# at cy-0.95. Any other arrangement is a REFLECTION and cannot be soldered.
FETS = {   # name: (cx, cy, J1pin, J1row)
 'Q1': (112.6, 107.00, 2 , 1 ),   # CHNG
 'Q2': (112.6, 113.40, 8 , 4 ),   # INDEX
 'Q3': (112.6, 136.88, 26, 13),   # TRK0 (offset 0.6 north, drain jogs)
 'Q4': (112.6, 140.02, 28, 14),   # WPROT
 'Q5': (112.6, 143.20, 30, 15),   # RDATA
 'Q6': (112.6, 147.64, 34, 17),   # RDY
}
def fet_pads(cx, cy):
    return {'G': (cx + 1.1, cy + 0.95),      # pad 1
            'S': (cx + 1.1, cy - 0.95),      # pad 2
            'D': (cx - 1.1, cy)}             # pad 3

D1_X = 190.0; D1_CATH = (D1_X, 148.0); D1_AN = (D1_X, 152.0)
J2_Y = 156.0; J2_X0 = 112.0
C1 = (147.6, 107.15)      # 0603 vertical: pad1 y-0.8, pad2 y+0.8
C3 = (128.0, 152.5)      # 0805 horizontal: pad1 x-0.95, pad2 x+0.95
# Antenna keepout: Pico 2 W onboard antenna segment (south end of module).
# No traces / vias / copper pour on either layer. Pins 19-22 fall inside and
# are left unconnected (module pin escape allowance not needed - unused).
KEEPOUT = (164.4, 151.2, 185.4, 157.3)   # x1,y1,x2,y2

# ---------------------------------------------------------------- nets
NETS = ['', 'GND', '+5V', '+3V3', '+12V',
        'SEL0_B','SEL1_B','MTR_B','DIR_B','STEP_B','WDATA_B','WGATE_B','SIDE_B',
        'SEL0','SEL1','MTR','DIR','STEP','WDATA','WGATE','SIDE',
        'WPROT','RDATA','RDY','TRK0','INDEX','CHNG',
        'WPROT_B','RDATA_B','RDY_B','TRK0_B','INDEX_B','CHNG_B','VSYS']
NID = {n: i for i, n in enumerate(NETS)}

# inputs: order = J1 top->bottom = U2 A1..A8 = GP2..GP9 (crossing-free)
INPUTS = [  # (name, J1pin, J1row, U2_A_pin, pico_pin)
 ('SEL0', 10, 5 , 2, 4 ), ('SEL1', 12, 6 , 3, 5 ), ('MTR', 16, 8 , 4, 6 ),
 ('DIR' , 18, 9 , 5, 7 ), ('STEP', 20, 10, 6, 9 ), ('WDATA',22, 11, 7, 10),
 ('WGATE',24, 12, 8, 11), ('SIDE', 32, 16, 9, 12)]

# outputs: (name, fet, pico_pin)  GPIO high = bus asserted low
# CHNG/INDEX moved to GP0/GP1 (pins 1/2): pins 19/20 sit in the antenna
# keepout zone and stay unconnected.
OUTPUTS = [('WPROT','Q4',14), ('RDATA','Q5',15), ('RDY','Q6',16),
           ('TRK0','Q3',17), ('INDEX','Q2',1), ('CHNG','Q1',2)]

segs, vias, corner_bad = [], [], []
def R(p): return (round(p[0], 3), round(p[1], 3))
def S(net, layer, pts, w=0.3):
    pts = [R(p) for p in pts]
    dirs = []
    for a, b in zip(pts, pts[1:]):
        if a == b: continue
        segs.append((net, layer, a, b, w))
        dx, dy = b[0]-a[0], b[1]-a[1]
        L = math.hypot(dx, dy); dirs.append((dx/L, dy/L))
    for u, v in zip(dirs, dirs[1:]):           # corner rule: max 45 deg turn
        dot = u[0]*v[0] + u[1]*v[1]
        if dot < 0.7:                          # cos(45)=0.707; 90 deg -> 0
            corner_bad.append((net, layer, pts))
def V(net, x, y): vias.append((net, round(x, 3), round(y, 3)))

# ---------------------------------------------------------------- routing
# J1 -> U2 (F.Cu), staggered vertical channels
for i, (nm, j1p, row, apin, _) in enumerate(INPUTS):
    ys = J1_y(row); xt, yt = U2_pin(apin); xc = 116.0 + 0.9 * i
    S(nm + '_B', 'F.Cu', [(J1_XB, ys), (xc - 1, ys), (xc, ys - 1),
                          (xc, yt + 1), (xc + 1, yt), (xt, yt)])

# U2 Y -> Pico (F.Cu). Y1..Y8 = pins 18..11, targets GP2..GP9
for i, (nm, _, _, apin, ppin) in enumerate(INPUTS):
    ysrc = U2_pin(20 - apin)[1]              # A2->Y@18, A3->17 ... A9->11
    xs = U2_XR; xt, yt = PICO_pin(ppin); xc = 154.1 - 1.3 * i
    S(nm, 'F.Cu', [(xs, ysrc), (xc - 1, ysrc), (xc, ysrc + 1),
                   (xc, yt - 1), (xc + 1, yt), (xt, yt)])

# FET drain -> J1 (F.Cu)
DRAIN_NET = {'Q1':'CHNG_B','Q2':'INDEX_B','Q3':'TRK0_B','Q4':'WPROT_B',
             'Q5':'RDATA_B','Q6':'RDY_B'}
for q, (cx, cy, j1p, row) in FETS.items():
    d = fet_pads(cx, cy)['D']; ty = J1_y(row); nm = DRAIN_NET[q]
    if abs(ty - cy) < 1e-6:
        S(nm, 'F.Cu', [d, (J1_XB, ty)])
S('INDEX_B','F.Cu',[fet_pads(*FETS['Q2'][:2])['D'],(110.2,113.40),(108.98,114.62),(J1_XB,114.62)])
S('RDATA_B','F.Cu',[fet_pads(*FETS['Q5'][:2])['D'],(110.2,143.20),(109.56,142.56),(J1_XB,142.56)])
S('TRK0_B','F.Cu',[fet_pads(*FETS['Q3'][:2])['D'],(110.2,136.88),(109.6,137.48),(J1_XB,137.48)])

# Pico GP10..GP15 -> FET gates
STUB_X = 152.0
def gate_route(name, ppin, bpts, gpad):
    px, py = PICO_pin(ppin)
    S(name, 'F.Cu', [(px, py), (STUB_X, py)]); V(name, STUB_X, py)
    S(name, 'B.Cu', [(STUB_X, py)] + bpts)
    gx, gy = bpts[-1]; V(name, gx, gy)
    S(name, 'F.Cu', [(gx, gy), gpad])

gQ = {q: fet_pads(*FETS[q][:2])['G'] for q in FETS}
# WPROT GP10 y140.02 -> Q4 G (113.7,140.97)
gate_route('WPROT', 14, [(116.6,140.02),(115.65,140.97),(114.7,140.97)], gQ['Q4'])
# RDATA GP11 y142.56 -> Q5 G (113.7,144.15)
gate_route('RDATA', 15, [(116.29,142.56),(114.70,144.15)], gQ['Q5'])
# RDY GP12 y145.10 -> Q6 G (113.7,146.69)
gate_route('RDY',   16, [(117.5,145.10),(116.29,146.31),(116.29,147.0),
                          (114.7,148.59)], gQ['Q6'])
# TRK0 GP13 y147.64: B west -> F vert x125.3 -> B west y137.48 -> Q3 G (113.7,136.53)
px, py = PICO_pin(17)
S('TRK0','F.Cu',[(px,py),(STUB_X,py)]); V('TRK0',STUB_X,py)
S('TRK0','B.Cu',[(STUB_X,147.64),(125.3,147.64)]); V('TRK0',125.3,147.64)
S('TRK0','F.Cu',[(125.3,147.64),(125.3,137.48)]);  V('TRK0',125.3,137.48)
S('TRK0','B.Cu',[(125.3,137.48),(116.5,137.48),(116.15,137.83),(114.7,137.83)])
V('TRK0',114.7,137.83); S('TRK0','F.Cu',[(114.7,137.83),gQ['Q3']])
# INDEX GP0 (pin1, 166,107): upper F.Cu lane y104.6 west past everything,
# drop to B.Cu west of the FET column, approach Q2 gate from the west.
px, py = PICO_pin(1)
S('INDEX','F.Cu',[(px,py),(165.5,107.0),(163.1,104.6),(111.9,104.6),
                  (110.2,106.3)])
V('INDEX',110.2,106.3)
S('INDEX','B.Cu',[(110.2,106.3),(110.2,113.5),(111.05,114.35),(112.7,114.35)])
V('INDEX',112.7,114.35)
S('INDEX','F.Cu',[(112.7,114.35),gQ['Q2']])
# CHNG GP1 (pin2, 166,109.54): lower F.Cu lane y105.25, 45-deg drop straight
# into Q1 gate pad from the east (stops east of INDEX's descent - no cross).
px, py = PICO_pin(2)
S('CHNG','F.Cu',[(px,py),(165.26,109.54),(160.97,105.25),(118.0,105.25),
                 (115.3,107.95),gQ['Q1']])

# 3V3: Pico pin36 (THT) -> B.Cu -> via -> F stub -> U2 pin20 + C1
p36 = PICO_pin(36); u2p20 = U2_pin(20)
S('+3V3','B.Cu',[p36,(180.0,117.16),(178.73,115.89),(146.9,115.89),
                 (145.9,114.89),(145.9,106.285)],0.4)
V('+3V3',145.9,106.285)
S('+3V3','F.Cu',[(145.9,106.285),u2p20],0.5)
# C1 pad1 (147.6,106.5) taps the 3V3 stub via a 45-deg jog off the via line
S('+3V3','F.Cu',[(145.9,106.285),(147.535,106.285),(147.6,106.35)],0.3)
# C1 pad2 (147.6,108.1) -> short east stub -> GND via
S('GND','F.Cu',[(C1[0],C1[1]+0.8),(148.6,C1[1]+0.8)],0.3); V('GND',148.6,C1[1]+0.8)

# 5V: J2 pin1 -> rail y158 (south of antenna keepout) -> D1 anode (190,152)
S('+5V','F.Cu',[(J2_X0,J2_Y),(114.0,158.0),(189.0,158.0),(190.0,157.0),D1_AN],0.8)
S('+5V','F.Cu',[(C3[0]-0.95,C3[1]),(C3[0]-0.95,157.05),(C3[0]+0.0,158.0)],0.5)
S('GND','F.Cu',[(C3[0]+0.95,C3[1]),(C3[0]+0.95,153.8)],0.5); V('GND',C3[0]+0.95,153.8)
# VSYS: D1 cathode (190,148) north along east strip -> pin39 (183.78,109.54)
p39 = PICO_pin(39)
S('VSYS','F.Cu',[D1_CATH,(D1_X,110.5),(189.04,109.54),p39],0.8)

# U2 GND + /OE
S('GND','F.Cu',[U2_pin(10),(130.5,117.715)],0.3); V('GND',130.5,117.715)
S('GND','F.Cu',[U2_pin(1),(130.8,106.285)],0.3);  V('GND',130.8,106.285)
S('GND','F.Cu',[U2_pin(19),(143.5,107.555)],0.3); V('GND',143.5,107.555)
# FET source -> GND vias
for q in FETS:
    s = fet_pads(*FETS[q][:2])['S']
    S('GND','F.Cu',[s,(114.9,s[1])],0.3); V('GND',114.9,s[1])

# ---------------------------------------------------------------- checker
def ang_ok(a,b):
    dx,dy = b[0]-a[0], b[1]-a[1]
    return dx==0 or dy==0 or abs(abs(dx)-abs(dy))<1e-6
def seg_dist(p,a,b):
    ax,ay=a; bx,by=b; px,py=p
    dx,dy=bx-ax,by-ay; L2=dx*dx+dy*dy
    t=0 if L2==0 else max(0,min(1,((px-ax)*dx+(py-ay)*dy)/L2))
    cx,cy=ax+t*dx, ay+t*dy
    return math.hypot(px-cx,py-cy)
def segseg(a1,a2,b1,b2):
    # min distance between two segments
    def cross(o,a,b): return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
    d1,d2 = cross(b1,b2,a1), cross(b1,b2,a2)
    d3,d4 = cross(a1,a2,b1), cross(a1,a2,b2)
    if ((d1>0)!=(d2>0)) and ((d3>0)!=(d4>0)): return 0.0
    return min(seg_dist(a1,b1,b2),seg_dist(a2,b1,b2),
               seg_dist(b1,a1,a2),seg_dist(b2,a1,a2))

# pad table for clearance checks: (net, cx, cy, halfw, halfh)
PADS = []
def _reg(net, x, y, sx, sy): PADS.append((net, x, y, sx/2, sy/2))
_j1nets = {p: ('GND' if p % 2 == 1 else '') for p in range(1, 35)}
for _nm, _p, _r, _a, _pp in INPUTS: _j1nets[_p] = _nm + '_B'
for _q,(_cx,_cy,_p,_row) in FETS.items():
    _j1nets[_p] = {'Q1':'CHNG_B','Q2':'INDEX_B','Q3':'TRK0_B','Q4':'WPROT_B',
                   'Q5':'RDATA_B','Q6':'RDY_B'}[_q]
for _p in range(1, 35):
    _r=(_p+1)//2; _x=J1_XA if _p%2 else J1_XB
    _reg(_j1nets[_p], _x, J1_y(_r), 1.7, 1.7)
for _i,_n in enumerate(['+5V','GND','GND','+12V']): _reg(_n, J2_X0+_i*2.54, J2_Y, 1.7, 1.7)
_pico_nets = {1:'INDEX',2:'CHNG',4:'SEL0',5:'SEL1',6:'MTR',7:'DIR',9:'STEP',
              10:'WDATA',11:'WGATE',12:'SIDE',14:'WPROT',15:'RDATA',16:'RDY',
              17:'TRK0',36:'+3V3',39:'VSYS'}
_gnds={3,8,13,18,23,28,33,38}
for _n in range(1,41):
    _x,_y=PICO_pin(_n); _reg(_pico_nets.get(_n,'GND' if _n in _gnds else ''),_x,_y,1.7,1.7)
_u2nets={1:'GND',10:'GND',19:'GND',20:'+3V3'}
for _i,(_nm,_,_,_ap,_) in enumerate(INPUTS):
    _u2nets[_ap]=_nm+'_B'; _u2nets[20-_ap]=_nm
for _n in range(1,21):
    _x,_y=U2_pin(_n); _reg(_u2nets.get(_n,''),_x,_y,1.9,0.6)
for _q,(_cx,_cy,_p,_row) in FETS.items():
    _sig={'Q1':'CHNG','Q2':'INDEX','Q3':'TRK0','Q4':'WPROT','Q5':'RDATA','Q6':'RDY'}[_q]
    _pd=fet_pads(_cx,_cy)
    _reg(_sig,_pd['G'][0],_pd['G'][1],1.0,0.9)
    _reg('GND',_pd['S'][0],_pd['S'][1],1.0,0.9)
    _reg(_sig+'_B',_pd['D'][0],_pd['D'][1],1.0,0.9)
_reg('VSYS',D1_CATH[0],D1_CATH[1],1.6,1.8); _reg('+5V',D1_AN[0],D1_AN[1],1.6,1.8)
_reg('+3V3',C1[0],C1[1]-0.8,0.9,0.95); _reg('GND',C1[0],C1[1]+0.8,0.9,0.95)
_reg('+5V',C3[0]-0.95,C3[1],1.0,1.25); _reg('GND',C3[0]+0.95,C3[1],1.0,1.25)

def seg_rect_dist(a, b, cx, cy, hw, hh):
    # distance between segment ab and axis-aligned rect; 0 if intersecting
    rx1,ry1,rx2,ry2 = cx-hw, cy-hh, cx+hw, cy+hh
    inside=lambda p: rx1<=p[0]<=rx2 and ry1<=p[1]<=ry2
    if inside(a) or inside(b): return 0.0
    edges=[((rx1,ry1),(rx2,ry1)),((rx2,ry1),(rx2,ry2)),
           ((rx2,ry2),(rx1,ry2)),((rx1,ry2),(rx1,ry1))]
    return min(segseg(a,b,e[0],e[1]) for e in edges)

CLR = 0.15
bad = 0
for net,layer,pts in corner_bad:
    print(f"CORNER >45deg  {net} {layer} {pts}"); bad+=1
for s in segs:
    if not ang_ok(s[2],s[3]):
        print(f"ANGLE  {s[0]} {s[2]}->{s[3]}"); bad+=1
# copper in antenna keepout (any layer)
kx1,ky1,kx2,ky2 = KEEPOUT
kcx,kcy,khw,khh = (kx1+kx2)/2,(ky1+ky2)/2,(kx2-kx1)/2,(ky2-ky1)/2
for s in segs:
    if seg_rect_dist(s[2],s[3],kcx,kcy,khw,khh) < s[4]/2:
        print(f"KEEPOUT seg {s[0]} {s[1]} {s[2]}->{s[3]}"); bad+=1
for v in vias:
    if seg_rect_dist((v[1],v[2]),(v[1],v[2]),kcx,kcy,khw,khh) < 0.35:
        print(f"KEEPOUT via {v[0]}"); bad+=1
# trace / via vs foreign pads
for net,cx,cy,hw,hh in PADS:
    for s in segs:
        if s[0]==net: continue
        d = seg_rect_dist(s[2],s[3],cx,cy,hw,hh) - s[4]/2
        if d < CLR:
            print(f"PAD {d:6.3f} {net}@({cx},{cy}) vs {s[0]} {s[1]} {s[2]}->{s[3]}"); bad+=1
    for v in vias:
        if v[0]==net: continue
        d = seg_rect_dist((v[1],v[2]),(v[1],v[2]),cx,cy,hw,hh) - 0.35
        if d < CLR:
            print(f"PADVIA {d:6.3f} {net}@({cx},{cy}) vs {v[0]}@({v[1]},{v[2]})"); bad+=1
for i in range(len(segs)):
    for j in range(i+1,len(segs)):
        a,b = segs[i],segs[j]
        if a[0]==b[0] or a[1]!=b[1]: continue
        d = segseg(a[2],a[3],b[2],b[3]) - (a[4]+b[4])/2
        if d < CLR:
            print(f"CLR {d:6.3f} {a[1]}  {a[0]} {a[2]}->{a[3]}  vs  {b[0]} {b[2]}->{b[3]}"); bad+=1
for v in vias:
    for s in segs:
        if s[0]==v[0]: continue
        # via copper exists on both layers
        d = seg_dist((v[1],v[2]),s[2],s[3]) - 0.35 - s[4]/2
        if d < CLR:
            print(f"VIA {d:6.3f} {v[0]}@({v[1]},{v[2]}) vs {s[0]} {s[1]} {s[2]}->{s[3]}"); bad+=1
for i in range(len(vias)):
    for j in range(i+1,len(vias)):
        a,b=vias[i],vias[j]
        if a[0]==b[0]: continue
        d=math.hypot(a[1]-b[1],a[2]-b[2])-0.7
        if d<CLR: print(f"VIAVIA {d:6.3f} {a[0]} vs {b[0]}"); bad+=1
print(f"--- DRC-lite: {bad} violations ---")
if bad: sys.exit(1)

# ---------------------------------------------------------------- emit
def U(): return str(uuid.uuid4())
out = []
out.append('(kicad_pcb (version 20221018) (generator wifi_floppy_gen)')
out.append(' (general (thickness 1.6)) (paper "A4")')
out.append(''' (layers
  (0 "F.Cu" signal) (31 "B.Cu" signal)
  (32 "B.Adhes" user "B.Adhesive") (33 "F.Adhes" user "F.Adhesive")
  (34 "B.Paste" user) (35 "F.Paste" user)
  (36 "B.SilkS" user "B.Silkscreen") (37 "F.SilkS" user "F.Silkscreen")
  (38 "B.Mask" user) (39 "F.Mask" user)
  (40 "Dwgs.User" user "User.Drawings") (44 "Edge.Cuts" user)
  (46 "B.CrtYd" user "B.Courtyard") (47 "F.CrtYd" user "F.Courtyard")
  (48 "B.Fab" user) (49 "F.Fab" user))''')
out.append(' (setup (pad_to_mask_clearance 0.05))')
for i,n in enumerate(NETS): out.append(f' (net {i} "{n}")')

def fp_open(name,ref,val,x,y,layer='F.Cu'):
    return (f' (footprint "{name}" (layer "{layer}") (tstamp {U()}) (at {x} {y})\n'
            f'  (attr through_hole)\n'
            f'  (fp_text reference "{ref}" (at 0 -2.2) (layer "F.SilkS") (tstamp {U()})'
            f' (effects (font (size 1 1) (thickness 0.15))))\n'
            f'  (fp_text value "{val}" (at 0 2.2) (layer "F.Fab") (tstamp {U()})'
            f' (effects (font (size 1 1) (thickness 0.15))))\n')
def tht(num,dx,dy,net,drill=1.0,size=1.7,shape='circle'):
    return (f'  (pad "{num}" thru_hole {shape} (at {dx} {dy}) (size {size} {size})'
            f' (drill {drill}) (layers "*.Cu" "*.Mask") (net {NID[net]} "{net}") (tstamp {U()}))\n')

def silk(x1,y1,x2,y2,ox,oy,layer='F.SilkS'):
    """rectangle outline in footprint-local coords"""
    pts=[(x1,y1),(x2,y1),(x2,y2),(x1,y2),(x1,y1)]
    out=''
    for a,b in zip(pts,pts[1:]):
        out+=(f'  (fp_line (start {a[0]-ox:.3f} {a[1]-oy:.3f}) (end {b[0]-ox:.3f} {b[1]-oy:.3f})'
              f' (stroke (width 0.12) (type solid)) (layer "{layer}") (tstamp {U()}))\n')
    return out
def smd(num,dx,dy,net,sx,sy):
    return (f'  (pad "{num}" smd rect (at {dx} {dy}) (size {sx} {sy})'
            f' (layers "F.Cu" "F.Paste" "F.Mask") (net {NID[net]} "{net}") (tstamp {U()}))\n')

# J1
j1nets = {p:'' for p in range(1,35)}
for p in range(1,35,2): j1nets[p]='GND'
for nm,p,_,_,_ in INPUTS: j1nets[p]=nm+'_B'
for q,(cx,cy,p,row) in FETS.items():
    j1nets[p]={'Q1':'CHNG_B','Q2':'INDEX_B','Q3':'TRK0_B','Q4':'WPROT_B','Q5':'RDATA_B','Q6':'RDY_B'}[q]
f = fp_open('Connector_PinHeader_2.54mm:PinHeader_2x17','J1','FLOPPY34',J1_XA,J1_y(1))
for r in range(1,18):
    for c,(pn,x) in enumerate([(2*r-1,J1_XA),(2*r,J1_XB)]):
        n=j1nets[pn]
        shp = 'rect' if pn==1 else 'circle'     # square pad marks pin 1
        f+=tht(pn,x-J1_XA,J1_y(r)-J1_y(1),n if n else 'GND',shape=shp) if n else \
           f'  (pad "{pn}" thru_hole {shp} (at {x-J1_XA} {J1_y(r)-J1_y(1)}) (size 1.7 1.7) (drill 1.0) (layers "*.Cu" "*.Mask") (tstamp {U()}))\n'
# plain (unshrouded) 2x17 body: 5.08 mm across the rows, 43.18 mm long
_cx=(J1_XA+J1_XB)/2
f+=silk(_cx-2.54, J1_y(1)-1.27, _cx+2.54, J1_y(17)+1.27, J1_XA, J1_y(1))
# pin-1 chevron outside the body, next to the square pad
f+=(f'  (fp_line (start {J1_XA-3.4-J1_XA:.3f} {J1_y(1)-1.27-J1_y(1):.3f})'
    f' (end {J1_XA-2.0-J1_XA:.3f} {J1_y(1)-J1_y(1):.3f})'
    f' (stroke (width 0.15) (type solid)) (layer "F.SilkS") (tstamp {U()}))\n')
f+=(f'  (fp_line (start {J1_XA-3.4-J1_XA:.3f} {J1_y(1)+1.27-J1_y(1):.3f})'
    f' (end {J1_XA-2.0-J1_XA:.3f} {J1_y(1)-J1_y(1):.3f})'
    f' (stroke (width 0.15) (type solid)) (layer "F.SilkS") (tstamp {U()}))\n'
    )
f+=' )'; out.append(f)
# J2
f = fp_open('Connector_PinHeader_2.54mm:PinHeader_1x04','J2','PWR-BERG',J2_X0,J2_Y)
for i,n in enumerate(['+5V','GND','GND','+12V']):
    f+=tht(i+1,i*2.54,0,n,shape='rect' if i==0 else 'circle')
f+=silk(J2_X0-1.27, J2_Y-1.27, J2_X0+3*2.54+1.27, J2_Y+1.27, J2_X0, J2_Y)
f+=' )'; out.append(f)
# Pico rows
f = fp_open('wifi_floppy:Pico2W_THT','U1','Pico2W/PicoPlus2W',PICO_XW,107.0)
for n in range(1,41):
    x,y = PICO_pin(n)
    nets_p = {1:'INDEX',2:'CHNG',
              4:'SEL0',5:'SEL1',6:'MTR',7:'DIR',9:'STEP',10:'WDATA',11:'WGATE',12:'SIDE',
              14:'WPROT',15:'RDATA',16:'RDY',17:'TRK0',
              36:'+3V3',39:'VSYS'}
    gnds={3,8,13,18,23,28,33,38}
    net = nets_p.get(n,'GND' if n in gnds else '')
    if net: f+=tht(n,x-PICO_XW,y-107.0,net,shape='rect' if n==1 else 'circle')
    else:   f+=f'  (pad "{n}" thru_hole circle (at {x-PICO_XW} {y-107.0}) (size 1.7 1.7) (drill 1.0) (layers "*.Cu" "*.Mask") (tstamp {U()}))\n'
f+=silk(PICO_XW-2.0, 107.0-2.0, PICO_XE+2.0, PICO_pin(21)[1]+2.0, PICO_XW, 107.0)
f+=' )'; out.append(f)
# U2
f = fp_open('Package_SO:SOIC-20W','U2','74LVC541A',U2_X,U2_Y).replace('through_hole','smd')
u2nets={1:'GND',10:'GND',19:'GND',20:'+3V3'}
for i,(nm,_,_,ap,_) in enumerate(INPUTS):
    u2nets[ap]=nm+'_B'; u2nets[20-ap+1 if False else (20-ap+1)]=nm   # placeholder
# fix Y mapping: A pin a -> Y pin (20 - a + 1)?? actually Ai=pin(1+i), Yi=pin(19-i+? )
u2nets={1:'GND',10:'GND',19:'GND',20:'+3V3'}
for i,(nm,_,_,ap,_) in enumerate(INPUTS):
    u2nets[ap]=nm+'_B'
    u2nets[20-ap]=nm          # A2->Y at pin18, A3->17 ... A9->11
for n in range(1,21):
    x,y=U2_pin(n)
    f+=smd(n,x-U2_X,y-U2_Y,u2nets.get(n,'GND'),1.9,0.6)

# U2 silkscreen. SOIC-20W body is 7.5 x 12.8 mm, so in footprint-local
# coordinates the outline is +-3.75 x +-6.4.
#
# ONLY THE SHORT EDGES ARE DRAWN, and that is measured rather than stylistic:
# the pads run from x = -5.650 to -3.750 and +3.750 to +5.650, so they reach
# the body's long edges EXACTLY. A rectangle outline -- what silk() would draw
# -- would put ink on twenty pads, which a fab either strips or, worse, prints
# and leaves as a solder-mask defect under the part. The short edges have
# 0.385 mm of clearance to the nearest pad, which is over the usual 0.2 mm
# minimum, so those are safe.
U2_HW, U2_HL = 3.75, 6.4
for _ey in (-U2_HL, U2_HL):
    f += (f'  (fp_line (start {-U2_HW:.3f} {_ey:.3f}) (end {U2_HW:.3f} {_ey:.3f})'
          f' (stroke (width 0.12) (type solid)) (layer "F.SilkS") (tstamp {U()}))\n')
# Pin-1 marker, OUTSIDE the pad field entirely. Pin 1 sits at local
# (-4.700, -5.715) and the pads stop at y = -6.015, so a dot at y = -7.0
# clears the nearest copper by 0.735 mm. Without this the part can be fitted
# 180 degrees out, which no amount of correct footprint geometry prevents --
# and rotation is exactly the failure this board has already paid for once.
f += (f'  (fp_circle (center -4.700 -7.000) (end -4.450 -7.000)'
      f' (stroke (width 0.12) (type solid)) (fill solid)'
      f' (layer "F.SilkS") (tstamp {U()}))\n')
f+=' )'; out.append(f)
# FETs
for q,(cx,cy,p,row) in FETS.items():
    sig={'Q1':'CHNG','Q2':'INDEX','Q3':'TRK0','Q4':'WPROT','Q5':'RDATA','Q6':'RDY'}[q]
    f=fp_open('Package_TO_SOT_SMD:SOT-23','%s'%q,'BSS138',cx,cy).replace('through_hole','smd')
    pads=fet_pads(cx,cy)
    f+=smd(1,pads['G'][0]-cx,pads['G'][1]-cy,sig,1.0,0.9)
    f+=smd(2,pads['S'][0]-cx,pads['S'][1]-cy,'GND',1.0,0.9)
    f+=smd(3,pads['D'][0]-cx,pads['D'][1]-cy,sig+'_B',1.0,0.9)
    f+=' )'; out.append(f)
# D1
f=fp_open('Diode_SMD:D_SMA','D1','SS14',D1_X,150.0).replace('through_hole','smd')
f+=smd(1,0,-2.0,'VSYS',1.6,1.8)
f+=smd(2,0, 2.0,'+5V',1.6,1.8)
f+=' )'; out.append(f)
# C1 C3
f=fp_open('Capacitor_SMD:C_0603','C1','100n',C1[0],C1[1]).replace('through_hole','smd')
f+=smd(1,0,-0.8,'+3V3',0.9,0.95); f+=smd(2,0,0.8,'GND',0.9,0.95); f+=' )'; out.append(f)
f=fp_open('Capacitor_SMD:C_0805','C3','10u',C3[0],C3[1]).replace('through_hole','smd')
f+=smd(1,-0.95,0,'+5V',1.0,1.25); f+=smd(2,0.95,0,'GND',1.0,1.25); f+=' )'; out.append(f)

# tracks
for net,layer,a,b,w in segs:
    out.append(f' (segment (start {a[0]:.3f} {a[1]:.3f}) (end {b[0]:.3f} {b[1]:.3f})'
               f' (width {w}) (layer "{layer}") (net {NID[net]}) (tstamp {U()}))')
for net,x,y in vias:
    out.append(f' (via (at {x:.3f} {y:.3f}) (size 0.7) (drill 0.35)'
               f' (layers "F.Cu" "B.Cu") (net {NID[net]}) (tstamp {U()}))')

# edge cuts
E=[(100,100),(196,100),(196,162),(100,162)]
for i in range(4):
    a,b=E[i],E[(i+1)%4]
    out.append(f' (gr_line (start {a[0]} {a[1]}) (end {b[0]} {b[1]})'
               f' (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (tstamp {U()}))')

# antenna keepout: no tracks/vias/pour, both layers
kx1,ky1,kx2,ky2 = KEEPOUT
out.append(f''' (zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (tstamp {U()})
  (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25)
  (keepout (tracks not_allowed) (vias not_allowed) (pads allowed)
           (copperpour not_allowed) (footprints allowed))
  (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
  (polygon (pts (xy {kx1} {ky1}) (xy {kx2} {ky1}) (xy {kx2} {ky2}) (xy {kx1} {ky2}))))''')
out.append(f''' (gr_text "PICO 2 W ANTENNA\\nKEEPOUT" (at {(kx1+kx2)/2} {(ky1+ky2)/2}) (layer "F.SilkS") (tstamp {U()})
  (effects (font (size 1 1) (thickness 0.15))))''')

# B.Cu GND zone
out.append(f''' (zone (net {NID["GND"]}) (net_name "GND") (layer "B.Cu") (tstamp {U()})
  (hatch edge 0.5) (connect_pads (clearance 0.3)) (min_thickness 0.25)
  (fill yes (thermal_gap 0.4) (thermal_bridge_width 0.4))
  (polygon (pts (xy 100 100) (xy 196 100) (xy 196 162) (xy 100 162))))''')
out.append(')')

open(os.path.join(HERE, 'wifi_floppy.kicad_pcb'), 'w').write('\n'.join(out))
# paren balance sanity
txt=open(os.path.join(HERE, 'wifi_floppy.kicad_pcb')).read()
assert txt.count('(')==txt.count(')'), 'paren imbalance'
print(f'wrote wifi_floppy.kicad_pcb  ({len(segs)} segments, {len(vias)} vias)')
