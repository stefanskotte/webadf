#!/usr/bin/env python3
"""Check wifi_floppy.kicad_sch against the PCB: ERC, then a pad-by-pad netlist comparison.

The reference netlist is read straight from ../wifi_floppy.kicad_pcb (every pad's net), so this
script needs nothing outside the repo. Bench parts (R1-R3, D2, J3) are reported separately, as are
the three U1 header pads that carry bench flying leads (unrouted on the PCB).
"""
import os
import re
import subprocess
import sys
import tempfile

import sexpr
from sexpr import find, findall

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
SCH = os.path.join(HERE, "wifi_floppy.kicad_sch")
PCB = os.path.join(HERE, "..", "wifi_floppy.kicad_pcb")
BENCH_REFS = {"R1", "R2", "R3", "D2", "J3"}
# U1 pads that are unrouted on the PCB but carry bench flying leads on rev A2
BENCH_U1_PADS = {("U1", "24"), ("U1", "25"), ("U1", "29")}


def pcb_links():
    text = open(PCB).read()
    links = {}
    for m in re.finditer(r'\(footprint "[^"]*".*?\n \)', text, re.S):
        block = m.group(0)
        ref = re.search(r'\(fp_text reference "([^"]+)"', block) or re.search(r'\(property "Reference" "([^"]+)"', block)
        ref = ref.group(1)
        for pm in re.finditer(r'\(pad "([^"]+)"[^\n]*?\(net \d+ "([^"]+)"\)', block):
            links[(ref, pm.group(1))] = pm.group(2)
    return links


def sch_links():
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "net.net")
        subprocess.run([CLI, "sch", "export", "netlist", "-o", out, SCH], check=True, capture_output=True)
        tree = sexpr.parse(open(out).read())[0]
    links = {}
    for net in findall(find(tree, "nets"), "net"):
        name = str(find(net, "name")[1]).lstrip("/")
        if name.startswith("unconnected-"):
            continue  # KiCad's placeholder for a pin with no net (no-connect flag) = no connection
        for node in findall(net, "node"):
            ref, pin = str(find(node, "ref")[1]), str(find(node, "pin")[1])
            links[(ref, pin)] = name
    return links


def main():
    erc = subprocess.run([CLI, "sch", "erc", "--severity-all", "-o", os.path.join(HERE, "erc.rpt"), SCH],
                         capture_output=True, text=True)
    print(erc.stdout.strip())
    print(open(os.path.join(HERE, "erc.rpt")).read())

    pcb = pcb_links()
    sch = sch_links()
    pcb_refs = {r for r, _ in pcb}
    sch_pcbpart = {k: v for k, v in sch.items() if k[0] in pcb_refs and k not in BENCH_U1_PADS}
    match = [k for k in pcb if sch.get(k) == pcb[k]]
    wrong = [(k, pcb[k], sch.get(k)) for k in pcb if k in sch and sch[k] != pcb[k]]
    missing = [k for k in pcb if k not in sch]
    extra = [k for k in sch_pcbpart if k not in pcb]
    print("PCB parts: %s" % " ".join(sorted(pcb_refs, key=lambda r: (r[0], int(r[1:])))))
    print("%d/%d links match, %d extra, %d missing, %d on a different net"
          % (len(match), len(pcb), len(extra), len(missing), len(wrong)))
    for k in extra:
        print("  EXTRA", k, sch[k])
    for k in missing:
        print("  MISSING", k, pcb[k])
    for k, a, b in wrong:
        print("  WRONG", k, "pcb", a, "sch", b)
    print("Bench-mod additions on PCB-part pads (unrouted on the PCB):")
    for k in sorted(BENCH_U1_PADS):
        print("  %s.%s -> %s  (PCB: %s)" % (k[0], k[1], sch.get(k), pcb.get(k, "no net")))
    print("Bench parts:")
    for k in sorted(k for k in sch if k[0] in BENCH_REFS):
        print("  %s.%s -> %s" % (k[0], k[1], sch[k]))
    unknown = sorted({k[0] for k in sch} - pcb_refs - BENCH_REFS)
    if unknown:
        print("UNEXPECTED refs in schematic netlist:", unknown)
    ok = not (extra or missing or wrong or unknown) and len(match) == len(pcb)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
