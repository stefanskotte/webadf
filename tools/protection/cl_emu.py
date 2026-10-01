"""Emulate the Gods Copylock (file calways4.pi1, loaded to $35dac) on a 68000.

Unicorn does not implement the 68000 trace exception, so the step loop takes
trace / illegal / line-A / line-F exceptions and RTE itself.  Custom chips and
CIAs are MMIO with a crude model of an Amiga floppy drive fed by MFM that is
generated from the ADF (i.e. what a Gotek-style board would serve).

Usage: python cl_emu.py [--track1 zero|<file>] [--maxsteps N]
"""
import struct, sys, argparse
from unicorn import *
from unicorn.m68k_const import *
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000

ap = argparse.ArgumentParser()
ap.add_argument('--adf', default='g1.adf')
ap.add_argument('--maxsteps', type=int, default=3_000_000)
ap.add_argument('--trace', default='cl_trace.txt')
ap.add_argument('--quiet', action='store_true')
ap.add_argument('--stop-at', type=lambda s: int(s, 0), default=None)
ap.add_argument('--dump', default='cl_after.bin')
args = ap.parse_args()

md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
adf = open(args.adf, 'rb').read()

# ---------------------------------------------------------------- MFM track
def mfm_encode_bits(data_bits, prev):
    out = []
    for b in data_bits:
        clk = 1 if (prev == 0 and b == 0) else 0
        out += [clk, b]
        prev = b
    return out, prev

def longs_oddeven(buf):
    """AmigaDOS: odd bits of all longs first, then even bits."""
    odd = bytearray(); even = bytearray()
    for i in range(0, len(buf), 4):
        v = struct.unpack('>I', buf[i:i+4])[0]
        odd += struct.pack('>I', (v >> 1) & 0x55555555)
        even += struct.pack('>I', v & 0x55555555)
    return bytes(odd), bytes(even)

def build_track(trk):
    """Return the track as a list of 16-bit MFM words, standard AmigaDOS layout."""
    words = []
    bits_out = []
    prev = 0
    def raw_bytes_as_mfm(bs):
        nonlocal prev
        bits = []
        for byte in bs:
            for k in range(7, -1, -1):
                bits.append((byte >> k) & 1)
        enc, prev = mfm_encode_bits(bits, prev)
        return enc
    def data_only(bs):
        # bs already contains only data bits in the 0x55555555 positions (odd/even split)
        nonlocal prev
        bits = []
        for byte in bs:
            for k in range(7, -1, -1):
                bits.append((byte >> k) & 1)
        # these 32-bit words have data in even bit positions only (mask 0x55555555):
        # MFM-encode the masked values: bit pairs (clock,data) where the data bit is the masked bit
        out = []
        for i in range(0, len(bits), 2):
            d = bits[i + 1]
            c = 1 if (prev == 0 and d == 0) else 0
            out += [c, d]
            prev = d
        return out
    stream = []
    # gap
    stream += raw_bytes_as_mfm(b'\x00' * 700)
    for s in range(11):
        sec = adf[(trk * 11 + s) * 512:(trk * 11 + s + 1) * 512]
        stream += raw_bytes_as_mfm(b'\x00\x00')
        stream += [int(c) for c in format(0x4489, '016b')] * 2
        prev = 1
        info = struct.pack('>BBBB', 0xff, trk, s, 11 - s)
        label = b'\x00' * 16
        o, e = longs_oddeven(info)
        hdr_mfm = data_only(o + e)
        lo, le = longs_oddeven(label)
        lab_mfm = data_only(lo + le)
        # header checksum: xor of the raw longs (info+label odd/even)
        def csum(b):
            c = 0
            for i in range(0, len(b), 4):
                c ^= struct.unpack('>I', b[i:i+4])[0]
            return c & 0x55555555
        hc = csum(o + e + lo + le)
        do, de = longs_oddeven(sec)
        dc = csum(do + de)
        ho, he = longs_oddeven(struct.pack('>I', hc))
        dco, dce = longs_oddeven(struct.pack('>I', dc))
        stream += hdr_mfm + lab_mfm + data_only(ho + he) + data_only(dco + dce) + data_only(do + de)
    # pad to 12668 bytes ~ 6334 words
    while len(stream) < 6334 * 16:
        stream += raw_bytes_as_mfm(b'\x00')
    stream = stream[:6334 * 16]
    for i in range(0, len(stream), 16):
        words.append(int(''.join(map(str, stream[i:i+16])), 2))
    return words

track_cache = {}
def track_words(t):
    if t not in track_cache:
        track_cache[t] = build_track(t)
    return track_cache[t]

# ---------------------------------------------------------------- machine
mu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
mu.ctl_set_cpu_model(UC_CPU_M68K_M68000)
mu.mem_map(0, 0x200000)
mu.mem_map(0xc00000, 0x80000)
mu.mem_map(0xf80000, 0x80000)
try:
    rom = open('/Users/sfs/Devel/webadf/docs/kickstart3.1.rom', 'rb').read()
    mu.mem_write(0xf80000, rom[:0x80000])
except Exception as ex:
    print('no rom', ex)

game = open('game2_mem.bin', 'rb').read()
mu.mem_write(0, game[:0x80000])
cl = open('cl_file.bin', 'rb').read()
CL_BASE = 0x35dac
mu.mem_write(CL_BASE, cl)

log = open(args.trace, 'w')
cycles = 0
hwlog = []

def r16(a): return struct.unpack('>H', mu.mem_read(a, 2))[0]
def r32(a): return struct.unpack('>I', mu.mem_read(a, 4))[0]
def w16(a, v): mu.mem_write(a, struct.pack('>H', v & 0xffff))
def w32(a, v): mu.mem_write(a, struct.pack('>I', v & 0xffffffff))

class Drive:
    cyl = 49
    side = 0
    sel = False
    motor = False
    prev_prb = 0xff
drv = Drive()

custom = {}
intreq = 0
intena = 0
dmacon = 0
adkcon = 0
dskpt = 0
dsklen_prev = 0
dma_pending = None
cia = {'a': {}, 'b': {}}
cia_icr = {'a': 0, 'b': 0}
timers = {}

def cur_pc():
    return mu.reg_read(UC_M68K_REG_PC)

def note(kind, addr, val, size):
    hwlog.append((step_no, cur_pc(), kind, addr, val, size))
    if not args.quiet:
        log.write('    HW %s %06x %s=%x (step %d)\n' % (kind, addr, 'w' if kind == 'W' else 'r', val, step_no))

def start_dma(length):
    global dma_pending
    t = drv.cyl * 2 + drv.side
    words = track_words(t)
    n = len(words)
    pos = (cycles // 227) % n
    wordsync = bool(adkcon & 0x0400)
    sync = custom.get(0x7e, 0x4489)
    start = pos
    found = True
    if wordsync:
        found = False
        for k in range(n):
            if words[(pos + k) % n] == sync:
                start = (pos + k + 1) % n
                found = True
                delay = k + 1
                break
    else:
        delay = 0
    info = dict(track=t, cyl=drv.cyl, side=drv.side, sync=sync, wordsync=wordsync, len=length,
                dest=dskpt, found=found, step=step_no, pc=cur_pc())
    log.write('  DISK DMA %r\n' % info)
    hwlog.append((step_no, cur_pc(), 'DMA', 0, info, 0))
    if found:
        data = [words[(start + i) % n] for i in range(length)]
        dma_pending = (cycles + (delay + length) * 227, dskpt, data)
    else:
        dma_pending = None

def poll_dma():
    global dma_pending, intreq
    if dma_pending and cycles >= dma_pending[0]:
        _, dest, data = dma_pending
        mu.mem_write(dest, b''.join(struct.pack('>H', w) for w in data))
        intreq |= 0x0002
        dma_pending = None

def custom_read(uc, off, size, ud):
    global intreq
    reg = off & 0x1fe
    poll_dma()
    v = 0
    if reg == 0x002: v = dmacon
    elif reg == 0x004:  # VPOSR
        c = cycles // 2
        v = ((c // 227) % 312) >> 8
    elif reg == 0x006:
        c = cycles // 2
        v = ((((c // 227) % 312) & 0xff) << 8) | ((c % 227) & 0xff)
    elif reg == 0x01a: v = 0x8000 | (0x4000 if dma_pending else 0)
    elif reg == 0x01c: v = intena
    elif reg == 0x01e: v = intreq
    elif reg == 0x010: v = adkcon
    else: v = custom.get(reg, 0)
    if size == 1:
        v = (v >> 8) if (off & 1) == 0 else (v & 0xff)
    elif size == 4:
        v = (v << 16) | custom_read(uc, off + 2, 2, ud)
    note('R', 0xdff000 + off, v, size)
    return v

def custom_write(uc, off, size, val, ud):
    global intreq, intena, dmacon, adkcon, dskpt, dsklen_prev
    if size == 4:
        custom_write(uc, off, 2, val >> 16, ud)
        custom_write(uc, off + 2, 2, val & 0xffff, ud)
        return
    note('W', 0xdff000 + off, val, size)
    reg = off & 0x1fe
    def setclr(old, v):
        return (old | (v & 0x7fff)) if v & 0x8000 else (old & ~v)
    if reg == 0x096: dmacon = setclr(dmacon, val)
    elif reg == 0x09a: intena = setclr(intena, val)
    elif reg == 0x09c: intreq = setclr(intreq, val)
    elif reg == 0x09e: adkcon = setclr(adkcon, val)
    elif reg == 0x020: dskpt = (dskpt & 0xffff) | ((val & 0x1f) << 16)
    elif reg == 0x022: dskpt = (dskpt & 0xff0000) | (val & 0xfffe)
    elif reg == 0x024:
        if (val & 0x8000) and (dsklen_prev & 0x8000):
            if val & 0x4000:
                log.write('  DISK WRITE requested len=%d\n' % (val & 0x3fff))
            else:
                start_dma(val & 0x3fff)
        dsklen_prev = val
    custom[reg] = val

def cia_read(uc, off, size, ud):
    addr = 0xbfd000 + off
    poll_dma()
    v = 0xff
    if addr == 0xbfe001:
        v = 0xff
        if drv.sel:
            if drv.cyl == 0: v &= ~0x10
            v &= ~0x20  # ready
            # write-protect bit3 low=protected; disk in drive bit2 high
        v &= 0xff
    elif addr == 0xbfd100:
        v = drv.prev_prb
    else:
        reg = (addr >> 8) & 0xf
        which = 'a' if addr & 1 else 'b'
        if reg == 0xd:
            v = cia_icr[which] | (0x80 if cia_icr[which] else 0)
            cia_icr[which] = 0
        elif reg in (4, 5, 6, 7):
            v = timer_value(which, reg)
        elif reg in (8, 9, 0xa):
            ecl = cycles // 10
            tod = ecl // 14187 if which == 'a' else ecl // 451
            v = (tod >> (8 * (reg - 8))) & 0xff
        else:
            v = cia[which].get(reg, 0)
    note('R', addr, v, size)
    return v

def timer_value(which, reg):
    t = 'A' if reg in (4, 5) else 'B'
    key = which + t
    st = timers.get(key)
    latch = (cia[which].get(5 if t == 'A' else 7, 0) << 8) | cia[which].get(4 if t == 'A' else 6, 0)
    if not st:
        val = latch
    else:
        el = (cycles - st) // 10
        if latch == 0: latch = 0x10000
        val = (latch - (el % (latch + 1))) & 0xffff
    return (val & 0xff) if reg in (4, 6) else (val >> 8)

def cia_write(uc, off, size, val, ud):
    addr = 0xbfd000 + off
    note('W', addr, val, size)
    if addr == 0xbfd100:
        prb = val & 0xff
        old = drv.prev_prb
        sel = not (prb & 0x08)  # DF0
        drv.sel = sel
        drv.side = 0 if (prb & 0x04) else 1
        if sel and (old & 1) and not (prb & 1):
            if prb & 2:
                drv.cyl = max(0, drv.cyl - 1)
            else:
                drv.cyl = min(83, drv.cyl + 1)
        drv.prev_prb = prb
        return
    reg = (addr >> 8) & 0xf
    which = 'a' if addr & 1 else 'b'
    cia[which][reg] = val & 0xff
    if reg in (0xe, 0xf):
        t = 'A' if reg == 0xe else 'B'
        if val & 1:
            timers[which + t] = cycles
        else:
            timers.pop(which + t, None)

mu.mmio_map(0xdff000, 0x1000, custom_read, None, custom_write, None)
mu.mmio_map(0xbfd000, 0x2000, cia_read, None, cia_write, None)

# ---------------------------------------------------------------- CPU state at entry
mu.reg_write(UC_M68K_REG_SR, 0x2004)
mu.reg_write(UC_M68K_REG_A7, 0x78000)
mu.reg_write(UC_M68K_REG_D0, 0x00030000)
mu.reg_write(UC_M68K_REG_D3, 0x4540)
mu.reg_write(UC_M68K_REG_D4, 0x671711)
mu.reg_write(UC_M68K_REG_A5, 0x1f9da)
mu.reg_write(UC_M68K_REG_A0, 0x196ca)
mu.reg_write(UC_M68K_REG_PC, CL_BASE)
# mark a return sentinel: whatever is above the stack
w32(0x78000, 0xDEAD0000)

REGS = [UC_M68K_REG_D0 + i for i in range(8)] + [UC_M68K_REG_A0 + i for i in range(8)]
def regs():
    return [mu.reg_read(r) for r in REGS]

def take_exception(vector_addr, push_pc, why):
    sr = mu.reg_read(UC_M68K_REG_SR)
    sp = mu.reg_read(UC_M68K_REG_A7)
    if not (sr & 0x2000):
        raise RuntimeError('exception from user mode not modelled')
    sp -= 4; w32(sp, push_pc)
    sp -= 2; w16(sp, sr)
    mu.reg_write(UC_M68K_REG_A7, sp)
    mu.reg_write(UC_M68K_REG_SR, (sr | 0x2000) & ~0x8000)
    tgt = r32(vector_addr)
    mu.reg_write(UC_M68K_REG_PC, tgt)
    return tgt

step_no = 0
exec_log = []  # (step, pc, bytes, text, traced)
counts = {'trace': 0, 'illegal': 0}
last_pc = None
ret_sentinel_hit = False
while step_no < args.maxsteps:
    pc = mu.reg_read(UC_M68K_REG_PC)
    if args.stop_at is not None and pc == args.stop_at:
        log.write('STOP-AT reached\n'); break
    if pc == 0xDEAD0000:
        ret_sentinel_hit = True
        log.write('RETURNED to sentinel (rts with empty stack)\n')
        break
    sr = mu.reg_read(UC_M68K_REG_SR)
    code = bytes(mu.mem_read(pc, 10))
    ins = next(md.disasm(code, pc), None)
    txt = ('%s %s' % (ins.mnemonic, ins.op_str)) if ins else 'dc.w $%04x' % struct.unpack('>H', code[:2])[0]
    size = ins.size if ins else 2
    traced_flag = bool(sr & 0x8000)
    exec_log.append((step_no, pc, code[:size].hex(), txt, traced_flag))
    if not args.quiet:
        log.write('%7d %08x %04x %s%-20s %s\n' % (step_no, pc, sr, 'T ' if traced_flag else '  ', code[:size].hex(), txt))
    op = struct.unpack('>H', code[:2])[0]
    step_no += 1
    cycles += 8
    # exceptions we model
    if op == 0x4afc or (op & 0xfffe) == 0x4e7a or op in (0x4e7a, 0x4e7b):
        counts['illegal'] += 1
        take_exception(0x10, pc, 'illegal')
        cycles += 34
        continue
    if (op & 0xf000) == 0xa000:
        take_exception(0x28, pc, 'lineA'); continue
    if (op & 0xf000) == 0xf000:
        take_exception(0x2c, pc, 'lineF'); continue
    if op == 0x4e73:  # RTE (68000 frame)
        sp = mu.reg_read(UC_M68K_REG_A7)
        nsr = r16(sp); npc = r32(sp + 2)
        mu.reg_write(UC_M68K_REG_A7, sp + 6)
        mu.reg_write(UC_M68K_REG_SR, nsr)
        mu.reg_write(UC_M68K_REG_PC, npc)
        if traced_flag:
            counts['trace'] += 1
            take_exception(0x24, npc, 'trace')
        continue
    if op == 0x4e72:  # STOP
        log.write('STOP instruction\n'); break
    mu.ctl_remove_cache(pc, pc + 16)
    try:
        mu.emu_start(pc, 0xffffffff, count=1)
    except UcError as e:
        log.write('UcError %s at %08x (%s)\n' % (e, pc, txt))
        print('UcError', e, hex(pc), txt)
        break
    npc = mu.reg_read(UC_M68K_REG_PC)
    if traced_flag:
        counts['trace'] += 1
        take_exception(0x24, npc, 'trace')
    poll_dma()

log.write('END step=%d pc=%08x counts=%r\n' % (step_no, mu.reg_read(UC_M68K_REG_PC), counts))
r = regs()
log.write('REGS ' + ' '.join('%s=%08x' % (n, v) for n, v in zip(['d%d' % i for i in range(8)] + ['a%d' % i for i in range(8)], r)) + '\n')
log.close()
open(args.dump, 'wb').write(bytes(mu.mem_read(0, 0x80000)))
import pickle
pickle.dump({'exec': exec_log, 'hw': hwlog, 'regs': r, 'counts': counts, 'end_pc': mu.reg_read(UC_M68K_REG_PC)}, open('cl_run.pkl', 'wb'))
print('steps', step_no, 'end pc %08x' % mu.reg_read(UC_M68K_REG_PC), counts)
print('regs', ' '.join('%08x' % v for v in r))
