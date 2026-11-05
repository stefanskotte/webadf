#!/usr/bin/env python3
# Rev C routing proof: rev B with the PIM726 module replaced by its parts (Pimoroni Pico Plus 2 W schematic), the
# GPIOs unchanged. Run with KiCad's own Python. Writes rev-c.kicad_pcb, unrouted. rev B is only read.
# Usage: build_board.py <copper layers 2|4> <out.kicad_pcb>
import sys, os, pcbnew
LAYERS, OUT = int(sys.argv[1]), sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
FP = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/'
mm = pcbnew.FromMM
b = pcbnew.LoadBoard(os.path.join(HERE, '../wifi_floppy.kicad_pcb'))
# Removed items stay referenced: a removed item's wrapper being freed breaks every later SWIG lookup in KiCad 10.
KEEP = [t for t in b.Tracks()] + [z for z in b.Zones()]
for x in KEEP: b.Remove(x)
old = b.FindFootprintByReference('U1')
u1nets = {p.GetNumber(): p.GetNetname() for p in old.Pads()}
b.Remove(old); KEEP.append(old)
b.SetCopperLayerCount(LAYERS)

def net(name):
    n = b.FindNet(name)
    if n is None:
        n = pcbnew.NETINFO_ITEM(b, name); b.Add(n)
    return n
def put(ref, lib, name, x, y, rot=0, val='', nets={}, side='F'):
    f = pcbnew.FootprintLoad(os.path.join(HERE, 'rev-c-lib.pretty') if lib == 'LOCAL' else FP + lib + '.pretty', name)
    assert f is not None, name
    f.SetReference(ref); f.SetValue(val or name)
    b.Add(f)
    f.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y))); f.SetOrientationDegrees(rot)
    for p in f.Pads():
        if p.GetNumber() in nets: p.SetNet(net(nets[p.GetNumber()]))
    for k in nets:
        assert any(p.GetNumber() == k for p in f.Pads()), (ref, k, [p.GetNumber() for p in f.Pads()])
    f.Reference().SetVisible(False)
    return f
def R(ref, x, y, val, a, c, rot=0): return put(ref, 'Resistor_SMD', 'R_0402_1005Metric', x, y, rot, val, {'1': a, '2': c})
def C(ref, x, y, val, a, c='GND', rot=0): return put(ref, 'Capacitor_SMD', 'C_0402_1005Metric', x, y, rot, val, {'1': a, '2': c})
def C6(ref, x, y, val, a, c='GND', rot=0): return put(ref, 'Capacitor_SMD', 'C_0603_1608Metric', x, y, rot, val, {'1': a, '2': c})

V33, VS, DV, VB = '+3.3V', '/VSYS', 'DVDD', 'VBUS'
# The RP2350B: every GPIO on the net the PIM726's header pin carried on rev B.
HDR = {0:1,1:2,2:4,3:5,4:6,5:7,6:9,7:10,8:11,9:12,10:14,11:15,12:16,13:17,18:24,19:25,21:27,22:29}   # GPIO -> PIM726 pad
GP = {0:77,1:78,2:79,3:80,4:1,5:2,6:3,7:4,8:6,9:7,10:8,11:9,12:11,13:12,14:13,15:14,16:16,17:17,18:18,19:19,20:20,21:21,
      22:22,23:23,24:25,25:26,26:27,27:28,28:36,29:37,47:58}                                       # RP2350 DS table 1427
n = {str(GP[g]): u1nets[str(p)] for g, p in HDR.items()}
for p in (5,15,24,29,41,50,60,76, 69,68): n[str(p)] = V33     # IOVDD, QSPI_IOVDD, USB_OTP_VDD
for p in (10,32,51,65): n[str(p)] = DV                        # DVDD, VREG_FB
n.update({'64':V33,'61':'VREG_AVDD','62':'GND','63':'VREG_LX','59':'ADC_AVDD','30':'XIN','31':'XOUT_RP','35':'RUN',
          '33':'SWCLK','34':'SWDIO','67':'USB_DP_RP','66':'USB_DM_RP','70':'QSD3','71':'QSCLK','72':'QSD0','73':'QSD2',
          '74':'QSD1','75':'QCS','81':'GND', str(GP[47]):'PSRAM_CS', str(GP[23]):'WL_ON', str(GP[24]):'WL_D',
          str(GP[25]):'WL_CS', str(GP[29]):'WL_CLK'})
U = (147, 122)
f = put('U1', 'Package_DFN_QFN', 'QFN-80-1EP_10x10mm_P0.4mm_EP3.4x3.4mm_ThermalVias', U[0], U[1], 0, 'RP2350B', n)
for p in f.Pads():
    if p.GetNumber() in ('', '81'): p.SetNet(net('GND'))
# decoupling around the package, as Pimoroni's sheet 1
L = lambda p: U[1]-3.8+0.4*(p-1)      # left side, y of pin p
BX = lambda p: U[0]-3.8+0.4*(p-21)    # bottom, x of pin p
RY = lambda p: U[1]+3.8-0.4*(p-41)    # right, y of pin p
TX = lambda p: U[0]+3.8-0.4*(p-61)    # top, x of pin p
C('C10', U[0]-7.2, L(5)-0.6,  '100nF', V33, rot=90)
C('C11', U[0]-7.2, L(10)+0.2, '100nF', DV,  rot=90)
C('C12', U[0]-7.2, L(15)+1.0, '100nF', V33, rot=90)
C('C13', 143.4, U[1]+7.0, '100nF', V33)
C('C14', 145.8, U[1]+7.0, '100nF', V33)
C('C15', 148.4, U[1]+7.0, '100nF', DV)
C('C16', U[0]+6.4, RY(41), '100nF', V33, rot=90)
C('C17', U[0]+6.4, RY(50)+0.9, '100nF', V33, rot=90)
C('C18', U[0]+6.4, RY(51)-0.9, '100nF', DV, rot=90)
C('C19', U[0]+6.2, RY(60)+0.2, '100nF', V33, rot=90)
C('C20', TX(76), U[1]-6.3, '100nF', V33)
C6('C21', 149.1, 114.6, '10uF', V33, rot=90)                 # VREG_VIN
C6('C22', 151.4, 114.6, '2.2uF', 'VREG_AVDD', rot=90)
R('R20', 151.4, 112.0, '27', V33, 'VREG_AVDD', rot=90)
put('L1', 'Inductor_SMD', 'L_0805_2012Metric', 153.6, 112.8, 90, 'MLZ2012M3R3HT000', {'1':'VREG_LX','2':DV})
C6('C23', 155.7, 112.8, '10uF', DV, rot=90)
R('R21', 154.6, 116.9, '220', V33, 'ADC_AVDD')
C6('C24', 154.6, 115.4, '2.2uF', 'ADC_AVDD')
# crystal
put('Y1', 'Crystal', 'Crystal_SMD_3225-4Pin_3.2x2.5mm', 147, 132.3, 0, '12MHz', {'1':'XIN','2':'GND','3':'XOUT','4':'GND'})
C('C25', 143.9, 132.0, '10pF', 'XIN', rot=90)
C('C26', 150.3, 133.2, '10pF', 'XOUT', rot=90)
R('R22', 150.3, 130.6, '1k', 'XOUT', 'XOUT_RP', rot=90)
# flash and PSRAM on one QSPI bus
put('U3', 'Package_SO', 'SOIC-8_5.3x5.3mm_P1.27mm', 140.6, 107.0, 0, 'W25Q128JVSIQ',
    {'1':'QCS','2':'QSD1','3':'QSD2','4':'GND','5':'QSD0','6':'QSCLK','7':'QSD3','8':V33})
C('C27', 138.6, 111.3, '100nF', V33)
R('R23', 140.9, 111.3, '10k', V33, 'QCS')
put('U4', 'Package_SO', 'SOIC-8_3.9x4.9mm_P1.27mm', 148.9, 106.6, 90, 'IS66WVS16M8FBLL-104NLI',
    {'1':'PSRAM_CS','2':'QSD1','3':'QSD2','4':'GND','5':'QSD0','6':'QSCLK','7':'QSD3','8':V33})
C6('C28', 146.6, 111.5, '2.2uF', V33)
R('R24', 149.3, 111.0, '10k', V33, 'PSRAM_CS')
# USB-C, buttons, SWD, power
j = put('J6', 'Connector_USB', 'USB_C_Receptacle_HRO_TYPE-C-31-M-12', 157.0, 105.2, 180, 'USB-C',
    {'A4':VB,'B4':VB,'A9':VB,'B9':VB,'A5':'CC1','B5':'CC2','A6':'USB_DP','B6':'USB_DP','A7':'USB_DM','B7':'USB_DM',
     'A1':'GND','B1':'GND','A12':'GND','B12':'GND','SH':'GND'})
R('R25', 157.3, 112.4, '27', 'USB_DP', 'USB_DP_RP', rot=90)
R('R26', 158.6, 112.4, '27', 'USB_DM', 'USB_DM_RP', rot=90)
R('R27', 161.3, 112.4, '5k1', 'CC1', 'GND', rot=90)
R('R28', 160.0, 112.4, '5k1', 'CC2', 'GND', rot=90)
put('D3', 'Diode_SMD', 'D_SOD-123F', 159.0, 115.0, 0, 'PMEG40T30ER', {'1':VS,'2':VB})
put('SW1', 'Button_Switch_SMD', 'SW_Push_1P1T_XKB_TS-1187A', 158.4, 122.0, 0, 'BOOTSEL', {'1':'BOOT_R','2':'GND'})
R('R29', 143.2, 111.3, '1k', 'BOOT_R', 'QCS')
put('SW2', 'Button_Switch_SMD', 'SW_Push_1P1T_XKB_TS-1187A', 158.4, 128.0, 0, 'RUN', {'1':'RUN','2':'GND'})
put('J7', 'Connector_JST', 'JST_SH_BM03B-SRSS-TB_1x03-1MP_P1.00mm_Vertical', 136.4, 122.0, 90, 'SWD',
    {'1':'SWCLK','2':'GND','3':'SWDIO','MP':'GND'})
put('U5', 'Package_TO_SOT_SMD', 'SOT-223-3_TabPin2', 137.5, 133.0, 90, 'NCP1117ST33T3G', {'1':'GND','2':V33,'3':VS})
C6('C29', 136.0, 127.3, '10uF', VS)
C6('C30', 139.2, 127.3, '10uF', V33)
# RM2 in the corner, antenna end on the bottom edge (pin use per RM2 DS table 2 and Pimoroni sheet 1)
M = (154.15, 145.75)
put('M1', 'LOCAL', 'Raspberry_Pi_RM2', M[0], M[1], 180, 'RM2',
    {'1':'GND','3':'WL_CLK','4':'GND','5':'WL_D','6':'WL_DO','7':'GND','8':'LED_WL','9':'WL_CS','10':'WL_IRQ','11':'GND',
     '12':'WL_ON','13':'WL_ON','14':'VDDBAT','15':'GND','16':'VDDBAT','17':'VBUS_SENSE','21':'GND'})
R('R30', 160.8, 135.6, '470', 'WL_D', 'WL_DO')
R('R31', 158.4, 135.6, '10k', 'WL_D', 'WL_IRQ')
put('L2', 'Inductor_SMD', 'L_0603_1608Metric', 145.6, 135.5, 0, 'BLM18EG471SN1D', {'1':V33,'2':'VDDBAT'})
C6('C31', 149.6, 135.5, '10uF', 'VDDBAT')
R('R32', 144.0, 141.0, '470', 'LED_WL', 'LED_A', rot=90)
put('D4', 'LED_SMD', 'LED_0603_1608Metric', 144.0, 138.0, 90, 'green', {'1':'GND','2':'LED_A'})
R('R33', 141.9, 138.0, '10k', VB, 'VBUS_SENSE', rot=90)
R('R34', 141.9, 140.4, '10k', 'VBUS_SENSE', 'GND', rot=90)

# rev B's two pull-ups move down to clear the flash
for r in ('R10', 'R11'):
    f = b.FindFootprintByReference(r); p = f.GetPosition(); f.SetPosition(pcbnew.VECTOR2I(p.x, mm(113.2)))

# copper
xl, yt, xr, yb = 101.05, 100.0, 162.4, 154.0
def rect(z, a, c, d, e):
    o = z.Outline(); o.NewOutline()
    for x, y in ((a,c),(d,c),(d,e),(a,e)): o.Append(mm(x), mm(y))
def pour(layer, name, pri=0):
    z = pcbnew.ZONE(b); z.SetLayer(layer); z.SetNet(net(name)); rect(z, xl, yt, xr, yb); z.SetAssignedPriority(pri)
    z.SetLocalClearance(mm(0.2)); z.SetMinThickness(mm(0.15)); z.SetThermalReliefGap(mm(0.2)); z.SetThermalReliefSpokeWidth(mm(0.25))
    b.Add(z)
# F.Cu and B.Cu GND pours go in after routing (route.py): the router treats a pour on a signal layer as a plane.
# RM2's RF keep-out on all layers: 35.5 x 18.5 mm, of which 5 mm is on the board with the antenna end on the edge.
k = pcbnew.ZONE(b); k.SetIsRuleArea(True); k.SetDoNotAllowTracks(True); k.SetDoNotAllowVias(True); k.SetDoNotAllowPads(False)
k.SetDoNotAllowZoneFills(True); k.SetDoNotAllowFootprints(False); k.SetLayerSet(pcbnew.LSET.AllCuMask(LAYERS))
rect(k, M[0]-17.75, yb-5.0, xr, yb); k.SetZoneName('RM2 RF keep-out'); b.Add(k)
b.BuildConnectivity()
pcbnew.SaveBoard(OUT, b)
print('nets', b.GetNetCount())
