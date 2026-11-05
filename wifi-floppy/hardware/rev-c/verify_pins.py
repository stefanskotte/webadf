#!/usr/bin/env python3
# verify_pins.py <board>: checks rev C's connections against sources that did not build it: the RP2350 datasheet's pin
# table, the firmware's board.c, the pico-sdk board header, the RM2 datasheet's table 2 and rev B's own board.
import re, sys, json, os, pcbnew
HERE = os.path.dirname(os.path.abspath(__file__))
c = pcbnew.LoadBoard(sys.argv[1]); r = pcbnew.LoadBoard(os.path.join(HERE, '../wifi_floppy.kicad_pcb'))
bad = []; ok = 0
def check(what, got, want):
    global ok
    if got == want: ok += 1
    else: bad.append(f'{what}: board has {got!r}, source says {want!r}')
def pad(board, ref, n):
    return [p.GetNetname() for p in board.FindFootprintByReference(ref).Pads() if p.GetNumber() == str(n)]
# RP2350 datasheet tables 1427-1432, extracted from the PDF (RP-008373-DS-2)
DS = json.load(open(os.path.join(HERE, 'rp2350-qfn80-pins.json')))
gp = lambda g: DS[f'GPIO{g}'] if f'GPIO{g}' in DS else DS[[k for k in DS if k.startswith(f'GPIO{g}_')][0]]
# firmware pin map
src = open(os.path.join(HERE, '../../firmware/src/board.c')).read()
role = {m[0]: int(m[1]) for m in re.findall(r'\.(\w+) = (\d+)', src)}
want = dict(sel0='SEL0', sel1='SEL1', mtr='MTR', dir='DIR', step='STEP', wdata='WDATA', wgate='WGATE', side='SIDE', wprot='WPROT', rdata='RDATA',
            rdy='RDY', trk0='TRK0', index='INDEX', chng='CHNG', act_led='ACT_LED', i2c_sda='OLED_SDA', i2c_scl='OLED_SCL')
for k, net in want.items(): check(f'firmware {k} GP{role[k]} pin {gp(role[k])}', pad(c, 'U1', gp(role[k])), [net])
# SDK board header: radio and PSRAM
h = open(os.path.expanduser('~/pico-sdk/src/boards/include/boards/pimoroni_pico_plus2_w_rp2350.h')).read()
val = lambda name: int(re.search(rf'#define {name} (\d+)', h).group(1))
for name, net in (('CYW43_DEFAULT_PIN_WL_REG_ON','WL_ON'),('CYW43_DEFAULT_PIN_WL_DATA_OUT','WL_D'),('CYW43_DEFAULT_PIN_WL_CLOCK','WL_CLK'),
                  ('CYW43_DEFAULT_PIN_WL_CS','WL_CS'),('PIMORONI_PICO_PLUS2_W_PSRAM_CS_PIN','PSRAM_CS')):
    check(f'SDK {name}', pad(c, 'U1', gp(val(name))), [net])
# RP2350 special pins
for name, net in (('QSPI_SS','QCS'),('QSPI_SD0','QSD0'),('QSPI_SD1','QSD1'),('QSPI_SD2','QSD2'),('QSPI_SD3','QSD3'),('QSPI_SCLK','QSCLK'),
                  ('XIN','XIN'),('XOUT','XOUT_RP'),('RUN','RUN'),('SWCLK','SWCLK'),('SWDIO','SWDIO'),('USB_DP','USB_DP_RP'),('USB_DM','USB_DM_RP'),
                  ('VREG_AVDD','VREG_AVDD'),('VREG_LX','VREG_LX'),('VREG_PGND','GND'),('VREG_VIN','+3.3V'),('VREG_FB','DVDD'),('ADC_AVDD','ADC_AVDD'),
                  ('QSPI_IOVDD','+3.3V'),('USB_OTP_VDD','+3.3V')):
    check(f'RP2350 {name}', pad(c, 'U1', DS[name]), [net])
for p in (5,15,24,29,41,50,60,76): check(f'IOVDD pin {p}', pad(c, 'U1', p), ['+3.3V'])
for p in (10,32,51): check(f'DVDD pin {p}', pad(c, 'U1', p), ['DVDD'])
# RM2 datasheet table 2
RM2 = {1:'GND',3:'WL_CLK',4:'GND',5:'WL_D',7:'GND',9:'WL_CS',11:'GND',12:'WL_ON',13:'WL_ON',14:'VDDBAT',15:'GND',16:'VDDBAT',21:'GND'}
for n, net in RM2.items(): check(f'RM2 pad {n}', pad(c, 'M1', n), [net])
def two(ref, a, b):
    got = sorted(pad(c, ref, 1) + pad(c, ref, 2)); check(f'{ref} joins {a} and {b}', got, sorted([a, b]))
two('R30', 'WL_D', 'WL_DO'); two('R31', 'WL_D', 'WL_IRQ')
check('RM2 pad 6 (470 ohm to GP24)', pad(c, 'M1', 6), ['WL_DO']); check('RM2 pad 10 (10k to GP24)', pad(c, 'M1', 10), ['WL_IRQ'])
# memory pinouts (W25Q128 and PSRAM: CS SO SIO2 GND SI CLK SIO3 VCC)
for ref, cs in (('U3','QCS'),('U4','PSRAM_CS')):
    for n, net in zip(range(1, 9), (cs,'QSD1','QSD2','GND','QSD0','QSCLK','QSD3','+3.3V')): check(f'{ref} pin {n}', pad(c, ref, n), [net])
# every part kept from rev B has the same pads on the same nets
kept = 0
for f in r.Footprints():
    ref = f.GetReference()
    if ref == 'U1': continue
    for p in f.Pads():
        kept += 1; check(f'rev B {ref}.{p.GetNumber()}', pad(c, ref, p.GetNumber())[0] if pad(c, ref, p.GetNumber()) else None, p.GetNetname())
print(f'{ok} checks passed ({kept} rev B pads), {len(bad)} failed')
for b in bad: print(' FAIL', b)
