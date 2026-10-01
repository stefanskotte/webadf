"""Minimal Amiga floppy/custom/CIA model for single-stepping protection code.

The disk is fed from an ADF as standard AmigaDOS MFM (what an ADF-serving
floppy emulator produces).  Optionally a track can be replaced by raw MFM words.
"""
import struct

def _bits_of(bs):
    for byte in bs:
        for k in range(7, -1, -1):
            yield (byte >> k) & 1

class MFM:
    def __init__(self):
        self.bits = []
        self.prev = 0
    def raw(self, bs):
        for d in _bits_of(bs):
            c = 1 if (self.prev == 0 and d == 0) else 0
            self.bits += [c, d]
            self.prev = d
    def oddeven_data(self, bs):
        """bs are longs already masked 0x55555555: emit their data bits (odd positions)."""
        b = list(_bits_of(bs))
        for i in range(0, len(b), 2):
            d = b[i + 1]
            c = 1 if (self.prev == 0 and d == 0) else 0
            self.bits += [c, d]
            self.prev = d
    def sync(self, w):
        self.bits += [(w >> k) & 1 for k in range(15, -1, -1)]
        self.prev = w & 1

def _split(buf):
    odd = bytearray(); even = bytearray()
    for i in range(0, len(buf), 4):
        v = struct.unpack('>I', buf[i:i+4])[0]
        odd += struct.pack('>I', (v >> 1) & 0x55555555)
        even += struct.pack('>I', v & 0x55555555)
    return bytes(odd), bytes(even)

def _csum(b):
    c = 0
    for i in range(0, len(b), 4):
        c ^= struct.unpack('>I', b[i:i+4])[0]
    return c & 0x55555555

TRACK_WORDS = 6334  # ~ 12668 bytes, a nominal DD track

def adf_track_mfm(adf, trk):
    m = MFM()
    m.raw(b'\x00' * 700)
    for s in range(11):
        sec = adf[(trk * 11 + s) * 512:(trk * 11 + s + 1) * 512]
        m.raw(b'\x00\x00')
        m.sync(0x4489); m.sync(0x4489)
        o, e = _split(struct.pack('>BBBB', 0xff, trk, s, 11 - s))
        lo, le = _split(b'\x00' * 16)
        do, de = _split(sec)
        ho, he = _split(struct.pack('>I', _csum(o + e + lo + le)))
        co, ce = _split(struct.pack('>I', _csum(do + de)))
        for part in (o + e, lo + le, ho + he, co + ce, do + de):
            m.oddeven_data(part)
    while len(m.bits) < TRACK_WORDS * 16:
        m.raw(b'\x00')
    bits = m.bits[:TRACK_WORDS * 16]
    return [int(''.join(map(str, bits[i:i+16])), 2) for i in range(0, len(bits), 16)]


class Amiga:
    CYC_PER_WORD = 227  # 2us/bitcell * 16 bits * 7.09 MHz

    def __init__(self, adf, start_cyl=0, log=None, track_override=None):
        self.adf = adf
        self.cycles = 0
        self.cur_pc = 0
        self.step = 0
        self.log = log
        self.events = []
        self.cache = {}
        self.track_override = track_override or {}
        self.cyl = start_cyl
        self.side = 0
        self.sel = False
        self.prb = 0xff
        self.custom = {}
        self.intreq = 0; self.intena = 0; self.dmacon = 0; self.adkcon = 0
        self.dskpt = 0; self.dsklen_prev = 0
        self.pending = None
        self.cia = {'a': {}, 'b': {}}
        self.icr = {'a': 0, 'b': 0}
        self.timers = {}
        self.mem_write_block = None  # set by CPU wrapper

    # ---------------- disk
    def track(self, t):
        if t in self.track_override:
            return self.track_override[t]
        if t not in self.cache:
            self.cache[t] = adf_track_mfm(self.adf, t)
        return self.cache[t]

    def ev(self, kind, **kw):
        kw.update(kind=kind, step=self.step, pc=self.cur_pc)
        self.events.append(kw)
        if self.log:
            self.log.write('    EV %r\n' % kw)

    def start_dma(self, length, write=False):
        t = self.cyl * 2 + self.side
        words = self.track(t)
        n = len(words)
        pos = (self.cycles // self.CYC_PER_WORD) % n
        wordsync = bool(self.adkcon & 0x0400)
        sync = self.custom.get(0x7e, 0x4489)
        found = True; delay = 0; start = pos
        if wordsync and not write:
            found = False
            for k in range(n):
                if words[(pos + k) % n] == sync:
                    start = (pos + k + 1) % n; delay = k + 1; found = True
                    break
        self.ev('DMA', write=write, track=t, cyl=self.cyl, side=self.side, sync='%04x' % sync,
                wordsync=wordsync, words=length, dest='%06x' % self.dskpt, sync_found=found)
        if write:
            return
        if found:
            data = [words[(start + i) % n] for i in range(length)]
            self.pending = (self.cycles + (delay + length) * self.CYC_PER_WORD, self.dskpt, data)
        else:
            self.pending = None  # never completes: like real hw with an absent sync

    def poll(self):
        if self.pending and self.cycles >= self.pending[0]:
            _, dest, data = self.pending
            self.mem_write_block(dest, b''.join(struct.pack('>H', w) for w in data))
            self.intreq |= 0x0002
            self.pending = None

    # ---------------- custom
    def custom_rw(self, addr):
        reg = addr & 0x1fe
        self.poll()
        if reg == 0x002: v = self.dmacon
        elif reg == 0x004:
            c = self.cycles // 2
            v = ((c // 227) % 312) >> 8
        elif reg == 0x006:
            c = self.cycles // 2
            v = ((((c // 227) % 312) & 0xff) << 8) | (c % 227)
        elif reg == 0x01a: v = 0x8000 | (0x4000 if self.pending else 0)
        elif reg == 0x01c: v = self.intena
        elif reg == 0x01e: v = self.intreq
        elif reg == 0x010: v = self.adkcon
        else: v = self.custom.get(reg, 0)
        return v

    def custom_read(self, addr, width):
        if width == 2:
            v = (self.custom_rw(addr) << 16) | self.custom_rw(addr + 2)
        elif width == 1:
            v = self.custom_rw(addr)
        else:
            w = self.custom_rw(addr)
            v = (w >> 8) if not (addr & 1) else (w & 0xff)
        self.ev('R', addr='%06x' % addr, val='%x' % v, w=width)
        return v

    def custom_write(self, addr, val, width):
        if width == 2:
            self.custom_write(addr, val >> 16, 1)
            self.custom_write(addr + 2, val & 0xffff, 1)
            return
        self.ev('W', addr='%06x' % addr, val='%x' % val, w=width)
        reg = addr & 0x1fe
        def sc(old, v):
            return (old | (v & 0x7fff)) if v & 0x8000 else (old & ~v)
        if reg == 0x096: self.dmacon = sc(self.dmacon, val)
        elif reg == 0x09a: self.intena = sc(self.intena, val)
        elif reg == 0x09c: self.intreq = sc(self.intreq, val)
        elif reg == 0x09e: self.adkcon = sc(self.adkcon, val)
        elif reg == 0x020: self.dskpt = (self.dskpt & 0xffff) | ((val & 0x1f) << 16)
        elif reg == 0x022: self.dskpt = (self.dskpt & 0xff0000) | (val & 0xfffe)
        elif reg == 0x024:
            if (val & 0x8000) and (self.dsklen_prev & 0x8000):
                self.start_dma(val & 0x3fff, write=bool(val & 0x4000))
            self.dsklen_prev = val
        self.custom[reg] = val

    # ---------------- CIA
    def timer_value(self, which, reg):
        t = 'A' if reg in (4, 5) else 'B'
        lo, hi = (4, 5) if t == 'A' else (6, 7)
        latch = (self.cia[which].get(hi, 0) << 8) | self.cia[which].get(lo, 0)
        st = self.timers.get(which + t)
        if st is None:
            val = latch
        else:
            el = (self.cycles - st) // 10
            L = latch if latch else 0x10000
            val = (L - (el % (L + 1))) & 0xffff
        return (val & 0xff) if reg in (4, 6) else (val >> 8)

    def cia_read(self, addr, width):
        self.poll()
        if addr == 0xbfe001:
            v = 0xff
            if self.sel:
                if self.cyl == 0: v &= ~0x10
                v &= ~0x20
        elif addr == 0xbfd100:
            v = self.prb
        else:
            which = 'a' if addr & 1 else 'b'
            reg = (addr >> 8) & 0xf
            if reg == 0xd:
                v = self.icr[which] | (0x80 if self.icr[which] else 0)
                self.icr[which] = 0
            elif reg in (4, 5, 6, 7):
                v = self.timer_value(which, reg)
            elif reg in (8, 9, 0xa):
                ecl = self.cycles // 10
                tod = ecl // 14187 if which == 'a' else ecl // 451
                v = (tod >> (8 * (reg - 8))) & 0xff
            else:
                v = self.cia[which].get(reg, 0xff)
        if width == 1:  # word read of a CIA: both bytes
            v = (v << 8) | v
        self.ev('R', addr='%06x' % addr, val='%x' % v, w=width)
        return v

    def cia_write(self, addr, val, width):
        self.ev('W', addr='%06x' % addr, val='%x' % val, w=width)
        val &= 0xff
        if addr == 0xbfd100:
            old = self.prb
            self.sel = not (val & 0x08)
            self.side = 0 if (val & 0x04) else 1
            if self.sel and (old & 1) and not (val & 1):
                if val & 2: self.cyl = max(0, self.cyl - 1)
                else: self.cyl = min(83, self.cyl + 1)
                self.ev('STEP', cyl=self.cyl)
            self.prb = val
            return
        which = 'a' if addr & 1 else 'b'
        reg = (addr >> 8) & 0xf
        self.cia[which][reg] = val
        if reg in (0xe, 0xf):
            t = 'A' if reg == 0xe else 'B'
            if val & 1: self.timers[which + t] = self.cycles
            else: self.timers.pop(which + t, None)
