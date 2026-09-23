#!/usr/bin/env python3
"""Generate wifi_floppy.kicad_sch -- the as-built schematic of the wifi-floppy board.

Sources (nothing here is invented):
  * the pad-to-net netlist of ../wifi_floppy.kicad_pcb (rev B; rev A2 differs only in layout),
  * firmware pin names from ../../firmware/src/floppy_io.h,
  * the bench modifications hand-wired on the operator's rev A2 board, from HANDOFF.md
    (section 4d: 1 k pull-ups on J1 pins 24/22/16; 2026-09-11 notes: activity LED on GP22,
    SSD1306 128x32 OLED on I2C1 GP18/GP19, 3V3 pin 36, GND pin 23).

Symbols are copied verbatim from KiCad 10's stock libraries (derived symbols are flattened the
way eeschema embeds them). Every connection is made by a label, power symbol or wire whose end
sits exactly on a pin's electrical endpoint, computed from the symbol's pin (at x y angle) with
KiCad's inverted Y axis. Run verify_schematic.py afterwards: it runs ERC, exports the netlist
and compares it pad-for-pad against the PCB.
"""
import copy
import json
import os
import uuid

import sexpr
from sexpr import Str, find, findall

HERE = os.path.dirname(os.path.abspath(__file__))
SYMLIB = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols/"
OUT = os.path.join(HERE, "wifi_floppy.kicad_sch")
PRO = os.path.join(HERE, "wifi_floppy.kicad_pro")
PROJECT = "wifi_floppy"
G = 2.54

_ns = uuid.UUID("6b1d6c1e-9f3c-4b8e-a1f0-000000000000")
_uc = [0]


def uid():
    _uc[0] += 1
    return Str(str(uuid.uuid5(_ns, "wf-%d" % _uc[0])))


ROOT_UUID = uid()


def r2(v):
    v = round(v + 0.0, 4)
    return int(v) if v == int(v) else v


# ---------------------------------------------------------------- library symbols
_libs = {}


def _lib(name):
    if name not in _libs:
        with open(SYMLIB + name + ".kicad_sym") as f:
            _libs[name] = sexpr.parse(f.read())[0]
    return _libs[name]


def _raw(libname, sym):
    for s in findall(_lib(libname), "symbol"):
        if s[1] == sym:
            return s
    raise KeyError("%s:%s" % (libname, sym))


def flat_symbol(libname, sym):
    """Return the symbol with any (extends ...) resolved, named for embedding."""
    s = copy.deepcopy(_raw(libname, sym))
    ext = find(s, "extends")
    if ext is None:
        return s
    parent = flat_symbol(libname, ext[1])
    pname = parent[1]
    out = copy.deepcopy(parent)
    out[1] = Str(sym)
    # child properties override the parent's
    child_props = {p[1]: p for p in findall(s, "property")}
    new = []
    for c in out:
        if isinstance(c, list) and c and c[0] == "property" and c[1] in child_props:
            new.append(child_props.pop(c[1]))
        else:
            new.append(c)
    # remaining child-only properties go after the last property
    idx = max(i for i, c in enumerate(new) if isinstance(c, list) and c and c[0] == "property")
    for p in child_props.values():
        idx += 1
        new.insert(idx, p)
    for c in new:
        if isinstance(c, list) and c and c[0] == "symbol" and c[1].startswith(pname + "_"):
            c[1] = Str(sym + c[1][len(pname):])
    return new


class LibSym:
    def __init__(self, libname, sym):
        self.lib_id = "%s:%s" % (libname, sym)
        self.node = flat_symbol(libname, sym)
        self.node[1] = Str(self.lib_id)
        self.pins = {}
        for sub in findall(self.node, "symbol"):
            for p in findall(sub, "pin"):
                num = find(p, "number")[1]
                at = find(p, "at")
                self.pins.setdefault(str(num), []).append(
                    (float(at[1]), float(at[2]), float(at[3]) if len(at) > 3 else 0.0, p[1]))
        self.props = {p[1]: p for p in findall(self.node, "property")}


# ---------------------------------------------------------------- schematic model
class Sch:
    def __init__(self):
        self.libsyms = {}
        self.items = []
        self.pwr_n = 0
        self.flg_n = 0
        self.exclusions = []
        self.footprints = set()

    def libsym(self, libname, sym):
        key = (libname, sym)
        if key not in self.libsyms:
            self.libsyms[key] = LibSym(libname, sym)
        return self.libsyms[key]

    # -- primitive items
    def wire(self, *pts):
        for a, b in zip(pts, pts[1:]):
            self.items.append(["wire", ["pts", ["xy", r2(a[0]), r2(a[1])], ["xy", r2(b[0]), r2(b[1])]],
                               ["stroke", ["width", 0], ["type", "default"]], ["uuid", uid()]])
        return pts[-1]

    def junction(self, p):
        self.items.append(["junction", ["at", r2(p[0]), r2(p[1])], ["diameter", 0],
                           ["color", 0, 0, 0, 0], ["uuid", uid()]])

    def no_connect(self, p):
        self.items.append(["no_connect", ["at", r2(p[0]), r2(p[1])], ["uuid", uid()]])

    def label(self, p, name, outward):
        ang = {(-1, 0): 180, (1, 0): 0, (0, -1): 90, (0, 1): 270}[outward]
        just = "left" if ang in (0, 90) else "right"
        self.items.append(["label", Str(name), ["at", r2(p[0]), r2(p[1]), ang],
                           ["effects", ["font", ["size", 1.27, 1.27]], ["justify", just, "bottom"]],
                           ["uuid", uid()]])

    def text(self, p, s, size=1.27, bold=False, just="left", italic=False):
        font = ["font", ["size", size, size]]
        if bold:
            font.append(["bold", "yes"])
        if italic:
            font.append(["italic", "yes"])
        self.items.append(["text", Str(s), ["exclude_from_sim", "no"], ["at", r2(p[0]), r2(p[1]), 0],
                           ["effects", font, ["justify", just, "top"]], ["uuid", uid()]])

    def rect(self, a, b, width=0.3, dash=True):
        self.items.append(["rectangle", ["start", r2(a[0]), r2(a[1])], ["end", r2(b[0]), r2(b[1])],
                           ["stroke", ["width", width], ["type", "dash" if dash else "default"]],
                           ["fill", ["type", "none"]], ["uuid", uid()]])

    # -- symbols
    def place(self, libname, sym, ref, value, x, y, rot=0, mirror=None, footprint=None,
              ref_at=None, val_at=None, hide_value=False, extra_props=None):
        ls = self.libsym(libname, sym)
        part = Part(self, ls, ref, x, y, rot, mirror)
        node = ["symbol", ["lib_id", Str(ls.lib_id)], ["at", r2(x), r2(y), rot]]
        if mirror:
            node.append(["mirror", mirror])
        node += [["unit", 1], ["exclude_from_sim", "no"],
                 ["in_bom", "no" if ref.startswith("#") else "yes"],
                 ["on_board", "no" if ref.startswith("#") else "yes"], ["dnp", "no"], ["uuid", uid()]]
        for key, lp in ls.props.items():
            if key.startswith("ki_"):
                continue
            p = copy.deepcopy(lp)
            at = find(p, "at")
            px, py = part.xy(float(at[1]), float(at[2]))
            if key == "Reference":
                p[2] = Str(ref)
                if ref_at:
                    px, py = ref_at
            elif key == "Value":
                p[2] = Str(value)
                if val_at:
                    px, py = val_at
            elif key == "Footprint" and footprint is not None:
                p[2] = Str(footprint)
                self.footprints.add(footprint)
            at[1], at[2] = r2(px), r2(py)
            # field angles are relative to the symbol: undo the rotation so text reads horizontally
            ang = (-rot) % 180 if rot % 180 else 0
            if len(at) > 3:
                at[3] = ang
            else:
                at.append(ang)
            eff = find(p, "effects")
            if key == "Value" and hide_value and eff is not None:
                eff.append(["hide", "yes"])
            if (ref_at and key == "Reference") or (val_at and key == "Value"):
                # manual placement: left-justify so the text starts at the given point
                if eff is not None:
                    eff[:] = [e for e in eff if not (isinstance(e, list) and e[0] == "justify")]
                    # a 90-degree field in a 90-degree symbol renders at 180, which flips justification
                    eff.append(["justify", "right" if rot % 180 else "left"])
            node.append(p)
        for key, val in (extra_props or {}).items():
            node.append(["property", Str(key), Str(val), ["at", r2(x), r2(y), 0],
                         ["effects", ["font", ["size", 1.27, 1.27]], ["hide", "yes"]]])
        for num in ls.pins:
            part.pin_uuids[num] = uid()
            node.append(["pin", Str(num), ["uuid", part.pin_uuids[num]]])
        node.append(["instances", ["project", Str(PROJECT),
                                   ["path", Str("/" + ROOT_UUID), ["reference", Str(ref)], ["unit", 1]]]])
        self.items.append(node)
        return part

    def power(self, kind, p, rot=0):
        self.pwr_n += 1
        self.place("power", kind, "#PWR%02d" % self.pwr_n, kind, p[0], p[1], rot=rot)

    def pwr_flag(self, p):
        self.flg_n += 1
        self.place("power", "PWR_FLAG", "#FLG%02d" % self.flg_n, "PWR_FLAG", p[0], p[1])

    # -- output
    def write(self):
        tb = ["title_block",
              ["title", Str("WIFI FLOPPY — schematic (as built)")],
              ["date", Str("2026-09-23")],
              ["rev", Str("A2 + bench mods")],
              ["company", Str("Generated from wifi_floppy.kicad_pcb netlist + HANDOFF bench notes")],
              ["comment", 1, Str("Circuit: rev B PCB netlist = rev A2 as built (layout-only diffs) + bench mods")],
              ["comment", 2, Str("Bench mods (R1-R3, D2, J3) are hand-wired on rev A2, NOT on the PCB")],
              ["comment", 3, Str("Source: hardware/schematic/generate_schematic.py")]]
        libs = ["lib_symbols"] + [ls.node for ls in self.libsyms.values()]
        doc = ["kicad_sch", ["version", 20250114], ["generator", Str("eeschema")],
               ["generator_version", Str("9.0")], ["uuid", ROOT_UUID], ["paper", Str("A3")], tb, libs]
        doc += self.items
        doc += [["sheet_instances", ["path", Str("/"), ["page", Str("1")]]], ["embedded_fonts", "no"]]
        with open(OUT, "w") as f:
            f.write(sexpr.dump(doc) + "\n")
        root = "/" + ROOT_UUID
        excl = ["%s|%d|%d|%s|%s|%s|%s|%s" % (key, round(pos[0] * 10000), round(pos[1] * 10000),
                                            a, b, root, root, root)
                for key, pos, a, b, _why in self.exclusions]
        pro = {"meta": {"filename": "wifi_floppy.kicad_pro", "version": 3},
               "erc": {"erc_exclusions": [[e, why] for e, (_k, _p, _a, _b, why) in zip(excl, self.exclusions)]},
               "schematic": {"page_layout_descr_file": "wifi_floppy.kicad_wks"},
               "sheets": [[str(ROOT_UUID), "Root"]]}
        with open(PRO, "w") as f:
            json.dump(pro, f, indent=2)
            f.write("\n")
        libs_used = sorted({k[0] for k in self.libsyms})
        with open(os.path.join(HERE, "sym-lib-table"), "w") as f:
            f.write("(sym_lib_table\n  (version 7)\n")
            for l in libs_used:
                f.write('  (lib (name "%s") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/%s.kicad_sym") (options "") (descr ""))\n' % (l, l))
            f.write(")\n")
        fp_used = sorted({fp.split(":")[0] for fp in self.footprints if fp})
        with open(os.path.join(HERE, "fp-lib-table"), "w") as f:
            f.write("(fp_lib_table\n  (version 7)\n")
            for l in fp_used:
                f.write('  (lib (name "%s") (type "KiCad") (uri "${KICAD10_FOOTPRINT_DIR}/%s.pretty") (options "") (descr ""))\n' % (l, l))
            f.write(")\n")


class Part:
    def __init__(self, sch, ls, ref, x, y, rot, mirror):
        self.sch, self.ls, self.ref, self.x, self.y, self.rot, self.mirror = sch, ls, ref, x, y, rot, mirror
        self.pin_uuids = {}

    def _vec(self, dx, dy):
        """lib-space vector (Y up) -> schematic vector (Y down)."""
        dy = -dy
        if self.mirror == "y":
            dx = -dx
        elif self.mirror == "x":
            dy = -dy
        r = self.rot % 360
        if r == 90:
            dx, dy = dy, -dx
        elif r == 180:
            dx, dy = -dx, -dy
        elif r == 270:
            dx, dy = -dy, dx
        return dx, dy

    def xy(self, px, py):
        dx, dy = self._vec(px, py)
        return (r2(self.x + dx), r2(self.y + dy))

    def pin(self, num):
        """(endpoint, outward unit vector) of a pin."""
        px, py, ang, _t = self.ls.pins[str(num)][0]
        import math
        bx, by = self._vec(round(math.cos(math.radians(ang))), round(math.sin(math.radians(ang))))
        return self.xy(px, py), (int(-bx), int(-by))

    def end(self, num):
        return self.pin(num)[0]

    # -- connection helpers
    def lab(self, num, net, stub=0.0):
        p, o = self.pin(num)
        if stub:
            q = (p[0] + o[0] * stub, p[1] + o[1] * stub)
            self.sch.wire(p, q)
            p = q
        self.sch.label(p, net, o)
        return p

    def nc(self, num):
        self.sch.no_connect(self.end(num))

    def pwr(self, num, kind, stub=0.0, rot=0):
        p, o = self.pin(num)
        if stub:
            q = (p[0] + o[0] * stub, p[1] + o[1] * stub)
            self.sch.wire(p, q)
            p = q
        self.sch.power(kind, p, rot=rot)
        return p


# ---------------------------------------------------------------- the circuit
def build():
    s = Sch()
    FP_HDR34 = "Connector_PinHeader_2.54mm:PinHeader_2x17_P2.54mm_Vertical"
    FP_HDR4 = "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"

    # ============ POWER INPUT (J2, D1, C3) + U2 decoupling C1 ==========================
    s.text((20.32, 17.78), "POWER INPUT", size=2.2, bold=True)
    s.text((20.32, 21.59), "Floppy 'Berg' power header. +5V feeds the module's VSYS through Schottky D1\n"
                           "so USB and floppy power can be connected together. +12V (J2 pin 4) is a\n"
                           "header pad only: unused on the board. J2 is UNKEYED - reversed, +12V reaches VSYS.",
           size=1.27)
    Jx, Jy = 106.68, 33.02
    j2 = s.place("Connector_Generic", "Conn_01x04", "J2", "PWR-BERG 1x4", Jx, Jy, rot=90,
                 footprint=FP_HDR4, ref_at=(Jx + 7.62, Jy - 2.54), val_at=(Jx + 7.62, Jy + 0.0))
    p1, p2, p3, p4 = (j2.end(n) for n in (1, 2, 3, 4))
    rail_y = p1[1] + 7.62
    # +5V rail runs left from J2 pin 1
    a = s.wire(p1, (p1[0], rail_y))
    # GND pins 2 + 3
    g2 = s.wire(p2, (p2[0], p2[1] + 2.54))
    g3 = s.wire(p3, (p3[0], p3[1] + 2.54))
    s.wire(g2, g3)
    s.junction(g3)
    g3b = s.wire(g3, (g3[0], g3[1] + 2.54))
    s.power("GND", g3b)
    # +12V pin 4
    q4 = s.wire(p4, (p4[0], p4[1] + 2.54), (p4[0] + 7.62, p4[1] + 2.54))
    s.label(q4, "+12V", (1, 0))
    s.text((q4[0] + 7.62, q4[1] - 1.9), "(unused on board)", size=1.27, italic=True)

    x_c3 = a[0] - 12.7
    x_5v = x_c3 - 10.16
    x_flg = x_5v - 7.62
    d1_x = x_flg - 10.16 - 3.81
    d1 = s.place("Device", "D_Schottky", "D1", "SS14", d1_x, rail_y, footprint="Diode_SMD:D_SMA",
                 ref_at=(d1_x - 3.81, rail_y - 5.08), val_at=(d1_x - 3.81, rail_y + 2.54))
    s.wire(a, (x_c3, rail_y), (x_5v, rail_y), (x_flg, rail_y), d1.end(2))
    for xx in (x_c3, x_5v, x_flg):
        s.junction((xx, rail_y))
    s.power("+5V", (x_5v, rail_y))
    s.pwr_flag((x_flg, rail_y))
    c3 = s.place("Device", "C", "C3", "10u", x_c3, rail_y + 3.81, footprint="Capacitor_SMD:C_0805_2012Metric",
                 ref_at=(x_c3 + 2.54, rail_y + 2.54), val_at=(x_c3 + 2.54, rail_y + 5.08))
    c3.pwr(2, "GND")
    # VSYS side
    k = d1.end(1)
    kv = (k[0] - 7.62, k[1])
    s.wire(k, kv)
    s.pwr_flag(kv)
    kl = s.wire(kv, (kv[0] - 5.08, kv[1]))
    s.junction(kv)
    s.label(kl, "VSYS", (-1, 0))

    # C1: 100n decoupling on +3V3 at U2 pin 20
    c1x = 157.48
    c1 = s.place("Device", "C", "C1", "100n", c1x, rail_y, footprint="Capacitor_SMD:C_0603_1608Metric",
                 ref_at=(c1x + 2.54, rail_y - 1.27), val_at=(c1x + 2.54, rail_y + 1.27))
    c1.pwr(1, "+3V3")
    c1.pwr(2, "GND")
    s.text((c1x - 3.81, rail_y + 8.89), "C1: decoupling at U2 pin 20", size=1.1, italic=True)

    # ============ J1 FLOPPY CONNECTOR ==================================================
    jx, jy = 45.72, 132.08
    s.text((jx - 25.4, jy - 43.18), "J1  FLOPPY BUS (34-way, Amiga side, 5 V)", size=2.2, bold=True)
    s.text((jx - 25.4, jy - 39.37), "All odd pins GND. Pins 4, 6, 14 not connected.\n"
                                     "*_B nets = floppy-bus side of the buffers/drivers.", size=1.27)
    j1 = s.place("Connector_Generic", "Conn_02x17_Odd_Even", "J1", "FLOPPY34 2x17", jx, jy,
                 footprint=FP_HDR34, ref_at=(jx - 3.81, jy - 25.4), val_at=(jx - 3.81, jy + 24.13))
    J1_EVEN = {2: "CHNG_B", 8: "INDEX_B", 10: "SEL0_B", 12: "SEL1_B", 16: "MTR_B", 18: "DIR_B",
               20: "STEP_B", 22: "WDATA_B", 24: "WGATE_B", 26: "TRK0_B", 28: "WPROT_B",
               30: "RDATA_B", 32: "SIDE_B", 34: "RDY_B"}
    for n in range(2, 35, 2):
        if n in J1_EVEN:
            j1.lab(n, J1_EVEN[n], stub=2.54)
        else:
            j1.nc(n)
    bus_x = j1.end(1)[0] - 5.08
    for n in range(1, 34, 2):
        e = j1.end(n)
        s.wire(e, (bus_x, e[1]))
        if n not in (1,):
            s.junction((bus_x, e[1]))
    bot = s.wire((bus_x, j1.end(1)[1]), (bus_x, j1.end(33)[1]))
    gb = s.wire(bot, (bus_x, bot[1] + 5.08))
    s.power("GND", gb)

    # ============ U2 INPUT BUFFER (Amiga -> Pico) =====================================
    ux, uy = 116.84, 111.76
    s.text((ux - 27.94, uy - 36.83), "U2  INPUT BUFFER  Amiga → board", size=2.2, bold=True)
    s.text((ux - 27.94, uy - 33.02), "74LVC541A at 3V3: 5 V-tolerant inputs from the bus,\n"
                                     "3.3 V outputs to the Pico. OE1/OE2 tied low (always on).\n"
                                     "Symbol body 74xx:74AHC541 (A0-A7/Y0-Y7 = A1-A8/Y1-Y8).", size=1.27)
    u2 = s.place("74xx", "74AHC541", "U2", "74LVC541A", ux, uy, footprint="Package_SO:SOIC-20W_7.5x12.8mm_P1.27mm",
                 ref_at=(ux + 2.54, uy - 22.86), val_at=(ux + 2.54, uy + 22.86))
    U2_IN = {2: "SEL0_B", 3: "SEL1_B", 4: "MTR_B", 5: "DIR_B", 6: "STEP_B", 7: "WDATA_B", 8: "WGATE_B", 9: "SIDE_B"}
    U2_OUT = {18: "SEL0", 17: "SEL1", 16: "MTR", 15: "DIR", 14: "STEP", 13: "WDATA", 12: "WGATE", 11: "SIDE"}
    for n, net in U2_IN.items():
        u2.lab(n, net, stub=2.54)
    for n, net in U2_OUT.items():
        u2.lab(n, net, stub=2.54)
    e1, e19 = u2.end(1), u2.end(19)
    gx = e1[0] - 5.08
    s.wire(e1, (gx, e1[1]))
    s.wire(e19, (gx, e19[1]))
    s.wire((gx, e1[1]), (gx, e19[1]))
    s.power("GND", (gx, e19[1]))
    u2.pwr(20, "+3V3")
    u2.pwr(10, "GND")

    # ============ U1 PICO MODULE ======================================================
    px, py = 205.74, 124.46
    s.text((px - 38.1, py - 58.42), "U1  RP2350 MODULE (Pico 2 W / Pimoroni Pico Plus 2 W, PIM726)", size=2.2, bold=True)
    s.text((px - 38.1, py - 54.61), "Pin numbers = physical header pins 1-40. Net names = firmware names (floppy_io.h).\n"
                                    "Powered from VSYS (pin 39); its 3V3 output (pin 36) supplies U2 and the OLED.",
           size=1.27)
    u1 = s.place("MCU_Module", "RaspberryPi_Pico_W", "U1", "Pico 2 W / Pimoroni Pico Plus 2 W", px, py,
                 footprint="", extra_props={"PCB footprint": "wifi_floppy:Pico2W_THT (custom, generated by ../generate_pcb.py)"},
                 ref_at=(px + 8.89, py - 40.64), val_at=(px + 8.89, py - 38.1 + 0.0))
    U1_SIG = {1: "INDEX", 2: "CHNG", 4: "SEL0", 5: "SEL1", 6: "MTR", 7: "DIR", 9: "STEP", 10: "WDATA",
              11: "WGATE", 12: "SIDE", 14: "WPROT", 15: "RDATA", 16: "RDY", 17: "TRK0"}
    for n, net in U1_SIG.items():
        u1.lab(n, net, stub=2.54)
    # GND: pins 3,8,13,18,23,28,38 are stacked at one point on the symbol; 33 (AGND) on its own
    u1.pwr(3, "GND")
    s.text((px + 3.81, py + 38.1), "GND = pins 3, 8, 13, 18, 23, 28, 38\n(stacked on one symbol pin); AGND 33 = GND",
           size=1.1, italic=True)
    u1.pwr(33, "GND", stub=2.54)
    s.exclusions.append(("pin_to_pin", u1.end(3), u1.pin_uuids["3"], u1.pin_uuids["33"],
                         "Stock RaspberryPi_Pico symbol types both GND (pin 3) and AGND (pin 33) as power "
                         "output; on the module and on this PCB both are ground (netlist: U1.3 and U1.33 = GND)."))
    u1.pwr(36, "+3V3")
    v = u1.end(39)
    vt = s.wire(v, (v[0], v[1] - 5.08), (v[0] - 7.62, v[1] - 5.08))
    s.label(vt, "VSYS", (-1, 0))
    for n in (19, 20, 21, 22, 26, 27, 30, 31, 32, 34, 35, 37, 40):
        u1.nc(n)
    # bench flying leads onto otherwise-unused header pins
    u1.lab(24, "OLED_SDA", stub=2.54)
    u1.lab(25, "OLED_SCL", stub=2.54)
    u1.lab(29, "ACT_LED", stub=2.54)
    s.text((px + 38.1, py - 19.05), "GP18/GP19/GP22 (pins 24/25/29):\nunrouted pads on the PCB -\nbench flying leads, see box",
           size=1.1, italic=True)

    # ============ Q1-Q6 OPEN-DRAIN DRIVERS (Pico -> Amiga) =============================
    qx0, qy0 = 312.42, 78.74
    s.text((qx0 - 20.32, qy0 - 20.32), "Q1-Q6  OPEN-DRAIN DRIVERS  board → Amiga", size=2.2, bold=True)
    s.text((qx0 - 20.32, qy0 - 16.51), "BSS138 N-FETs: GPIO high = bus line pulled low (inverting).\n"
                                       "No pull-ups on the board: the Amiga's own pull-ups set the high level.",
           size=1.27)
    QS = [("Q1", "CHNG", "CHNG_B"), ("Q2", "INDEX", "INDEX_B"), ("Q3", "TRK0", "TRK0_B"),
          ("Q4", "WPROT", "WPROT_B"), ("Q5", "RDATA", "RDATA_B"), ("Q6", "RDY", "RDY_B")]
    for i, (ref, g, d) in enumerate(QS):
        col, row = i % 2, i // 2
        x = qx0 + col * 50.8
        y = qy0 + 5.08 + row * 33.02
        q = s.place("Transistor_FET", "BSS138", ref, "BSS138", x, y, footprint="Package_TO_SOT_SMD:SOT-23",
                    ref_at=(x + 5.08, y - 1.27), val_at=(x + 5.08, y + 1.27))
        q.lab(1, g, stub=2.54)
        de = q.end(3)
        dl = s.wire(de, (de[0], de[1] - 5.08), (de[0] + 5.08, de[1] - 5.08))
        s.label(dl, d, (1, 0))
        q.pwr(2, "GND")

    # ============ NOTES ===============================================================
    nx, ny = 283.21, 190.5
    s.text((nx, ny), "NOTES", size=2.0, bold=True)
    s.text((nx, ny + 3.81),
           "1. Circuit = rev B PCB netlist (wifi_floppy.kicad_pcb). Rev A2, the board in\n"
           "   hand, differs from rev B only in layout/silkscreen, not circuit.\n"
           "2. Amiga → board (SEL0, SEL1, MTR, DIR, STEP, WDATA, WGATE, SIDE):\n"
           "   buffered by U2 (5 V-tolerant 74LVC541A).\n"
           "3. Board → Amiga (INDEX, CHNG, TRK0, WPROT, RDATA, RDY): open-drain\n"
           "   via Q1-Q6; the high level comes from the Amiga's pull-ups.\n"
           "4. J1 odd pins 1-33 are all GND. J2: 1 = +5V, 2/3 = GND, 4 = +12V (unused).\n"
           "5. Connections are by net label: same name = same net.\n"
           "6. Bench parts (box, left) are hand-wired on rev A2, not on the PCB.",
           size=1.27)

    # ============ BENCH MODIFICATIONS BOX ==============================================
    bx0, by0, bx1, by1 = 20.32, 187.96, 269.24, 256.54
    s.rect((bx0, by0), (bx1, by1), width=0.5, dash=True)
    s.text((bx0 + 2.54, by0 + 2.54), "BENCH MODIFICATIONS — hand-wired on rev A2, not on the PCB",
           size=2.2, bold=True)
    s.text((bx0 + 2.54, by0 + 6.35), "Source: HANDOFF.md §4d (pull-ups, 2026-09-15) and the 2026-09-11 OLED / activity-LED notes.",
           size=1.27, italic=True)

    # pull-ups R1-R3
    s.text((bx0 + 5.08, by0 + 12.7), "Floppy-line pull-ups, 1 kΩ to +5V (J2 pin 1)", size=1.5, bold=True)
    s.text((bx0 + 5.08, by0 + 16.51), "On J1 pins 24 (WGATE), 22 (WDATA), 16 (MTR):\n"
                                       "host-driven lines the Amiga leaves open-collector.\n"
                                       "Without them WGATE floated; see HANDOFF 4d.", size=1.1)
    for i, (ref, net, pin) in enumerate((("R1", "WGATE_B", 24), ("R2", "WDATA_B", 22), ("R3", "MTR_B", 16))):
        x = bx0 + 12.7 + i * 22.86
        y = by0 + 38.1
        r = s.place("Device", "R", ref, "1k", x, y, footprint="",
                    ref_at=(x + 2.54, y - 1.27), val_at=(x + 2.54, y + 1.27))
        r.pwr(1, "+5V")
        b = r.end(2)
        bl = s.wire(b, (b[0], b[1] + 2.54), (b[0] + 2.54, b[1] + 2.54))
        s.label(bl, net, (1, 0))
        s.text((x - 2.54, y + 10.16), "J1 pin %d" % pin, size=1.1, italic=True)

    # activity LED D2
    lx, ly = bx0 + 96.52, by0 + 38.1
    s.text((lx - 10.16, by0 + 12.7), "Activity LED on GP22 (header pin 29)", size=1.5, bold=True)
    d2 = s.place("Device", "LED", "D2", "LED (activity)", lx, ly, footprint="",
                 ref_at=(lx - 3.81, ly - 5.08), val_at=(lx - 3.81, ly + 3.81))
    a2 = d2.end(2)
    s.wire(a2, (a2[0] + 5.08, a2[1]))
    s.label((a2[0] + 5.08, a2[1]), "ACT_LED", (1, 0))
    kk = d2.end(1)
    kg = s.wire(kk, (kk[0] - 5.08, kk[1]))
    s.power("GND", kg)
    s.text((lx - 10.16, ly + 10.16), "!! No series resistor — see HANDOFF;\n"
                                     "add one on the next revision.\n"
                                     "(firmware limits the pad to 2 mA drive\n"
                                     "strength: a mitigation, not a fix)", size=1.27, bold=True)

    # OLED J3
    ox, oy = bx0 + 175.26, by0 + 30.48
    s.text((ox - 22.86, by0 + 12.7), "SSD1306 128x32 OLED module on I2C1", size=1.5, bold=True)
    j3 = s.place("Connector_Generic", "Conn_01x04", "J3", "SSD1306 128x32 OLED (4-pin module)", ox, oy, rot=90,
                 footprint="", ref_at=(ox + 7.62, oy - 3.81), val_at=(ox + 7.62, oy - 1.27))
    s.text((ox + 7.62, oy + 1.27), "pin 1 GND, 2 VCC,\npin 3 SCL, 4 SDA", size=1.1)
    q1_, q2_, q3_, q4_ = (j3.end(n) for n in (1, 2, 3, 4))
    g = s.wire(q1_, (q1_[0], q1_[1] + 5.08), (q1_[0] - 5.08, q1_[1] + 5.08))
    s.power("GND", g)
    v3 = s.wire(q2_, (q2_[0], q2_[1] + 12.7), (q2_[0] - 15.24, q2_[1] + 12.7))
    s.power("+3V3", v3)
    sda = s.wire(q4_, (q4_[0], q4_[1] + 5.08), (q4_[0] + 5.08, q4_[1] + 5.08))
    s.label(sda, "OLED_SDA", (1, 0))
    scl = s.wire(q3_, (q3_[0], q3_[1] + 10.16), (q3_[0] + 7.62, q3_[1] + 10.16))
    s.label(scl, "OLED_SCL", (1, 0))
    s.text((ox - 22.86, oy + 22.86), "SDA = GP18 (pin 24), SCL = GP19 (pin 25), VCC = 3V3 (pin 36),\n"
                                      "GND = pin 23. The module's own pull-ups go to its VCC, so it\n"
                                      "must stay on 3V3: RP2350 GPIOs are not 5 V tolerant. Never\n"
                                      "use the PIM726 Qw/ST connector (hardwired to GP4/GP5 = MTR/DIR).",
           size=1.1)
    return s


if __name__ == "__main__":
    build().write()
    print("wrote", OUT)
