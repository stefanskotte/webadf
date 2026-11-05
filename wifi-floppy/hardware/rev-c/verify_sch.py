#!/usr/bin/env python3
# Rev C: the schematic against the routed board, connection by connection, whatever the nets are called. Also runs ERC.
# The symbol pins come from KiCad's own library, by pin NAME; the board's came from the datasheet table: two sources.
# Usage: verify_sch.py   (needs kicad-cli; run with KiCad's Python for pcbnew)
import json, os, re, subprocess, sys, tempfile, collections
import pcbnew
HERE = os.path.dirname(os.path.abspath(__file__))
CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
SCH, PCB = os.path.join(HERE, 'rev-c.kicad_sch'), os.path.join(HERE, 'rev-c.kicad_pcb')
tmp = tempfile.mkdtemp()
def run(*a):
    r = subprocess.run([CLI, *a], capture_output=True, text=True)
    if r.returncode not in (0, 5): sys.exit(r.stderr + r.stdout)
run('sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', tmp + '/n.net', SCH)
run('sch', 'erc', '--severity-all', '--format', 'json', '-o', tmp + '/e.json', SCH)
t = open(tmp + '/n.net').read()
snets = {}
for m in re.finditer(r'\(net\s+\(code "\d+"\)\s+\(name "([^"]*)"(.*?)(?=\(net\s+\(code|\Z)', t[t.index('(nets'):], re.S):
    nodes = frozenset(re.findall(r'\(ref "([^"]+)"\)\s+\(pin "([^"]+)"', m.group(2)))
    if len(nodes) > 0: snets[m.group(1)] = nodes
b = pcbnew.LoadBoard(PCB)
bn = collections.defaultdict(set)
for f in b.GetFootprints():
    for p in f.Pads():
        if p.GetNumber() and p.GetNetname():
            bn[p.GetNetname()].add((f.GetReference(), p.GetNumber()))
# the board's unconnected_ nets and the schematic's single-pin nets say nothing
bp = {n: frozenset(v) for n, v in bn.items() if not n.startswith('unconnected') and not n.startswith('Net-(unc')}
sp = {n: v for n, v in snets.items() if not n.startswith('unconnected')}
def norm(v, exp):
    return frozenset(x for x in v if x[0] not in exp)
EXCL = set()
A = collections.Counter(norm(v, EXCL) for v in bp.values() if len(norm(v, EXCL)) > 1)
B = collections.Counter(norm(v, EXCL) for v in sp.values() if len(norm(v, EXCL)) > 1)
bad = 0
for v in (A - B):
    bad += 1
    print('ONLY ON BOARD    :', [n for n, x in bp.items() if norm(x, EXCL) == v], sorted(v)[:14], len(v))
for v in (B - A):
    bad += 1
    print('ONLY IN SCHEMATIC:', [n for n, x in sp.items() if norm(x, EXCL) == v], sorted(v)[:14], len(v))
srefs = {r for v in snets.values() for r, _ in v}
brefs = {f.GetReference() for f in b.GetFootprints()}
print('refs only on board:', sorted(x for x in brefs - srefs if not x.startswith(('FID', 'kibuzzard', 'REF'))))
print('refs only in schematic:', sorted(srefs - brefs))
print(f'nets compared: board {sum(A.values())}, schematic {sum(B.values())}, differing {bad}')
e = json.load(open(tmp + '/e.json'))
c = collections.Counter()
for sh in e['sheets']:
    for v in sh['violations']:
        c[(v['severity'], v['type'])] += 1
        if v['severity'] == 'error':
            print('ERC', sh.get('path'), v['type'], '; '.join(i['description'] for i in v['items'])[:150])
print('ERC:', dict(c))
sys.exit(1 if bad or any(k[0] == 'error' for k in c) else 0)
