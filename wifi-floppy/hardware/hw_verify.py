#!/usr/bin/env python3
"""Pre-fab check for the wifi-floppy board: `pnpm hw:verify`.

Runs KiCad's own ERC and DRC (kicad-cli) on the project in this directory, then checks the
netlist against what the firmware and the recorded design decisions require. Exits non-zero
if anything that should stop a fab order is found.

Accepted, and not reported as failures:
  - DRC: U1's own GPIO14-17 pads inside U1's RF keepout (they are part of the Pico footprint
    and unconnected; the keepout forbids tracks to them, not the pads).
  - ERC: VSYS "not driven" (fed from +5 V through D1; KiCad wants a PWR_FLAG) and the Pico
    symbol's GND/AGND both being power outputs.
"""
import json
import os
import shutil
import subprocess
import sys
import re
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCH = os.path.join(HERE, 'wifi_floppy.kicad_sch')
PCB = os.path.join(HERE, 'wifi_floppy.kicad_pcb')

def kicad_cli():
    for c in (shutil.which('kicad-cli'),
              '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'):
        if c and os.path.exists(c):
            return c
    sys.exit('kicad-cli not found: install KiCad 8 or later')

def run(cli, *args):
    r = subprocess.run([cli, *args], capture_output=True, text=True)
    if r.returncode not in (0, 5):          # 5 = violations found, report written
        sys.exit(f'kicad-cli {" ".join(args[:2])} failed:\n{r.stderr or r.stdout}')

failures, notes = [], []

def fail(msg):
    failures.append(msg)

def descr(v):
    return '; '.join(i.get('description', '') for i in v.get('items', []))

# --- KiCad ERC / DRC -------------------------------------------------------------------------
cli = kicad_cli()
tmp = tempfile.mkdtemp()
erc_json, drc_json, net_file = (os.path.join(tmp, n) for n in ('erc.json', 'drc.json', 'net.sexpr'))
run(cli, 'sch', 'erc', '--severity-all', '--format', 'json', '-o', erc_json, SCH)
run(cli, 'pcb', 'drc', '--severity-all', '--schematic-parity', '--format', 'json', '-o', drc_json, PCB)
run(cli, 'sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', net_file, SCH)

erc = json.load(open(erc_json))
warnings = 0
for sheet in erc.get('sheets', []):
    for v in sheet.get('violations', []):
        d = descr(v)
        if v['severity'] != 'error':
            warnings += 1
        elif v['type'] == 'power_pin_not_driven' and 'VSYS' in d:
            pass
        elif v['type'] == 'pin_to_pin' and 'GND' in d and 'AGND' in d:
            pass
        else:
            fail(f'ERC {v["type"]}: {d}')
if warnings:
    notes.append(f'ERC: {warnings} warnings (see KiCad)')

drc = json.load(open(drc_json))
for v in drc.get('violations', []):
    d = descr(v)
    if v['severity'] != 'error':
        notes.append(f'DRC warning {v["type"]}: {d}')
    elif (v['type'] == 'items_not_allowed' and d.endswith('of U1')
          and any(f'(U1-GPIO{g}-' in d for g in (14, 15, 16, 17))):
        pass
    else:
        fail(f'DRC {v["type"]}: {v["description"]}: {d}')
for v in drc.get('unconnected_items', []):
    fail(f'DRC unconnected: {descr(v)}')
for v in drc.get('schematic_parity', []):
    notes.append(f'parity: {v["description"]}: {descr(v)}')

# --- netlist against the firmware and the design decisions --------------------------------
def parse_sexpr(text):
    """KiCad's netlist S-expression as nested lists of strings."""
    stack, cur = [], []
    for tok in re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text):
        if tok == '(':
            stack.append(cur)
            cur = []
        elif tok == ')':
            done, cur = cur, stack.pop()
            cur.append(done)
        else:
            cur.append(tok[1:-1] if tok.startswith('"') else tok)
    return cur[0]

def field(node, key):
    for c in node:
        if isinstance(c, list) and c and c[0] == key:
            return c[1] if len(c) > 1 else ''
    return None

def children(node, key):
    for c in node:
        if isinstance(c, list) and c and c[0] == key:
            yield c

tree = parse_sexpr(open(net_file).read())
comps, nets = {}, {}
for section in tree:
    if isinstance(section, list) and section and section[0] == 'components':
        for c in children(section, 'comp'):
            comps[field(c, 'ref')] = field(c, 'value') or ''
    if isinstance(section, list) and section and section[0] == 'nets':
        for n in children(section, 'net'):
            nets[field(n, 'name').lstrip('/')] = [(field(x, 'ref'), field(x, 'pin'))
                                                  for x in children(n, 'node')]

def net_of(ref, pin):
    for name, nodes in nets.items():
        if (ref, str(pin)) in nodes:
            return name
    return None

def on_net(name):
    return nets.get(name, [])

# Pico pin (physical) -> net name the firmware expects (src/floppy_io.h).
PICO = {1: 'INDEX', 2: 'CHNG', 4: 'SEL0', 5: 'SEL1', 6: 'MTR', 7: 'DIR', 9: 'STEP',
        10: 'WDATA', 11: 'WGATE', 12: 'SIDE', 14: 'WPROT', 15: 'RDATA', 16: 'RDY',
        17: 'TRK0', 24: 'OLED_SDA', 25: 'OLED_SCL', 27: 'BUZZER', 29: 'ACT_LED'}
for pin, want in PICO.items():
    got = net_of('U1', pin)
    if got != want:
        fail(f'U1 pin {pin}: net {got!r}, firmware expects {want!r}')
for pin in (19, 20, 21, 22):                       # GP14-17: antenna keepout
    got = net_of('U1', pin) or ''
    if not got.startswith('unconnected'):
        fail(f'U1 pin {pin} (GP{pin - 5}) is connected ({got}); it sits in the antenna keepout')

# The Amiga's J1 pin for each floppy line.
J1 = {'CHNG': 2, 'INDEX': 8, 'SEL0': 10, 'SEL1': 12, 'MTR': 16, 'DIR': 18, 'STEP': 20,
      'WDATA': 22, 'WGATE': 24, 'TRK0': 26, 'WPROT': 28, 'RDATA': 30, 'SIDE': 32, 'RDY': 34}
for line, pin in J1.items():
    if net_of('J1', pin) != f'{line}_B':
        fail(f'J1 pin {pin}: net {net_of("J1", pin)!r}, expected {line}_B')

def pulled_up(net):
    for ref, _ in on_net(net):
        if ref.startswith('R') and comps.get(ref) == '1k':
            other = [n for n, nodes in nets.items() if (ref, '1') in nodes or (ref, '2') in nodes]
            if '+5V' in other:
                return True
    return False

# HANDOFF §4c, decided 2026-09-20: 1 kOhm to +5 V on the host-driven inputs.
REQUIRED = ('WGATE', 'MTR')
DECIDED = ('WDATA', 'DIR', 'STEP', 'SIDE', 'SEL0')
for line in REQUIRED:
    if not pulled_up(f'{line}_B'):
        fail(f'{line}_B has no 1k pull-up to +5V (required: the line floats without it)')
missing = [l for l in DECIDED if not pulled_up(f'{l}_B')]
if missing:
    notes.append('decided 1k pull-ups not fitted (HANDOFF §4c): ' + ', '.join(missing))

# Activity LED needs a series resistor; the buzzer FET gate needs a pull-down.
if not any(r.startswith('R') for r, _ in on_net('ACT_LED')):
    fail('ACT_LED (GP22) drives the LED with no series resistor')
gate = [n for n, nodes in nets.items() if any(r.startswith('Q') and p == '1' for r, p in nodes)
        and any(r.startswith('R') for r, _ in nodes) and 'BUZZER' not in n]
if not any(any(comps.get(r) == '10k' for r, _ in nets[g]) for g in gate):
    fail('buzzer FET gate has no 10k pull-down')

for ref in ('J3', 'J4'):
    if ref in comps:
        if net_of(ref, 3) != 'OLED_SCL' or net_of(ref, 4) != 'OLED_SDA' or net_of(ref, 2) != '+3.3V':
            fail(f'{ref}: expected 1 GND, 2 +3.3V, 3 SCL, 4 SDA')

# --- report ------------------------------------------------------------------------------
for n in notes:
    print('note:', n)
if failures:
    for f in failures:
        print('FAIL:', f)
    print(f'\n{len(failures)} problem(s): do not order this board.')
    sys.exit(1)
print('\nhw:verify passed.')
