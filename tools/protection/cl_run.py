"""Run the Gods Copylock (calways4.pi1 at $35dac) on Musashi (machine68k), 68000 mode.

Musashi as built in machine68k does not emulate the trace exception, so this
loop single-steps and takes trace exceptions itself (68000 semantics: if T was
set at the start of an instruction that completed normally, push PC+SR and
vector through $24).  Illegal/line-A/F/privilege exceptions are Musashi's own.
"""
import struct, argparse, pickle, json
import machine68k as m
from capstone import Cs, CS_ARCH_M68K, CS_MODE_BIG_ENDIAN, CS_MODE_M68K_000
from amiga_hw import Amiga

ap = argparse.ArgumentParser()
ap.add_argument('--adf', default='g1.adf')
ap.add_argument('--image', default='game2_mem.bin')
ap.add_argument('--maxsteps', type=int, default=5_000_000)
ap.add_argument('--trace', default='cl_trace.txt')
ap.add_argument('--start-cyl', type=int, default=49)
ap.add_argument('--track-override', default=None, help='json {track: [words]}')
ap.add_argument('--out', default='cl_out')
ap.add_argument('--watch', default='', help='comma list of pcs to dump regs at')
args = ap.parse_args()

md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
log = open(args.trace, 'w')
ovr = None
if args.track_override:
    ovr = {int(k): v for k, v in json.load(open(args.track_override)).items()}
hw = Amiga(open(args.adf, 'rb').read(), start_cyl=args.start_cyl, log=log, track_override=ovr)

mc = m.Machine(m.CPUType.M68000, 2048)
mem, cpu = mc.mem, mc.cpu
R = m.Register

def wblock(a, b): mem.w_block(a, b)
hw.mem_write_block = wblock

# custom chips page $df0000, CIAs page $bf0000
def mk(fn_r, fn_w, width):
    return (lambda addr: fn_r(addr, width)), (lambda addr, val: fn_w(addr, val, width))
for w in (0, 1, 2):
    r, wr = mk(hw.custom_read, hw.custom_write, w)
    mem.set_special_range_read_func(0xdf0000, w, r)
    mem.set_special_range_write_func(0xdf0000, w, wr)
    r, wr = mk(hw.cia_read, hw.cia_write, w)
    mem.set_special_range_read_func(0xbf0000, w, r)
    mem.set_special_range_write_func(0xbf0000, w, wr)
rom = open('/Users/sfs/Devel/webadf/docs/kickstart3.1.rom', 'rb').read()
def rom_read(addr, w):
    o = addr - 0xf80000
    n = (1, 2, 4)[w]
    if 0 <= o < len(rom) - n:
        return int.from_bytes(rom[o:o+n], 'big')
    return 0
for page in range(0xf80000, 0x1000000, 0x10000):
    for w in (0, 1, 2):
        mem.set_special_range_read_func(page, w, (lambda w: lambda a: rom_read(a, w))(w))

img = open(args.image, 'rb').read()
mem.w_block(0, img[:0x80000] if len(img) >= 0x80000 else img)
cl = open('cl_file.bin', 'rb').read()
CL_BASE = 0x35dac
mem.w_block(CL_BASE, cl)
SENTINEL = 0x1FFF00
mem.w32(0x78000, SENTINEL)
mem.w16(SENTINEL, 0x4e71)

# reset vectors so pulse_reset gives a sane state, then set entry state
mem.w32(0, 0x78000); mem.w32(4, CL_BASE)
saved0 = img[0:8]
cpu.pulse_reset()
mem.w_block(0, saved0)  # restore image bytes at 0..7
cpu.w_sr(0x2004)
cpu.w_reg(R.A7, 0x78000)
cpu.w_reg(R.D0, 0x00030000)
cpu.w_reg(R.D3, 0x4540)
cpu.w_reg(R.D4, 0x671711)
cpu.w_reg(R.A5, 0x1f9da)
cpu.w_reg(R.A0, 0x196ca)
cpu.w_pc(CL_BASE)

REGN = ['d%d' % i for i in range(8)] + ['a%d' % i for i in range(8)]
REGS = [getattr(R, n.upper()) for n in REGN]
def regs():
    return [cpu.r_reg(r) & 0xffffffff for r in REGS]

def vectors():
    return {mem.r32(v) for v in range(8, 0x30, 4)}

exec_log = []
WATCH = {int(x, 0) for x in args.watch.split(',') if x}
watch_log = []
counts = {'trace': 0, 'exceptions': 0}
step = 0
stop_reason = 'maxsteps'
while step < args.maxsteps:
    pc = cpu.r_pc()
    if pc == SENTINEL:
        stop_reason = 'returned to caller (rts to sentinel)'
        break
    sr = cpu.r_sr()
    code = bytes(mem.r_block(pc, 10))
    ins = next(md.disasm(code, pc), None)
    txt = ('%s %s' % (ins.mnemonic, ins.op_str)) if ins else 'dc.w $%04x' % struct.unpack('>H', code[:2])[0]
    size = ins.size if ins else 2
    T = bool(sr & 0x8000)
    exec_log.append((step, pc, sr, code[:size].hex(), txt))
    log.write('%7d %08x %04x %s%-20s %s\n' % (step, pc, sr, 'T ' if T else '  ', code[:size].hex(), txt))
    hw.cur_pc = pc; hw.step = step
    if pc in WATCH:
        rr = regs(); watch_log.append((step, pc, rr))
        log.write('        WATCH ' + ' '.join('%s=%08x' % (n, v) for n, v in zip(REGN, rr)) + '\n')
    vecs = vectors()
    res = cpu.execute(1)
    hw.cycles += res.cycles
    step += 1
    npc = cpu.r_pc(); nsr = cpu.r_sr()
    op = struct.unpack('>H', code[:2])[0]
    took_exc = op in (0x4afc, 0x4e7a, 0x4e7b) or (op & 0xf000) in (0xa000, 0xf000) or (op & 0xfff0) == 0x4e40
    if took_exc and npc not in vecs:
        log.write('        !! expected exception but pc=%08x not a vector\n' % npc)
    if took_exc:
        counts['exceptions'] += 1
        log.write('        -> exception, handler %08x\n' % npc)
    elif T:
        counts['trace'] += 1
        sp = cpu.r_reg(R.A7) - 6
        mem.w16(sp, nsr)
        mem.w32(sp + 2, npc)
        cpu.w_reg(R.A7, sp)
        cpu.w_sr((nsr | 0x2000) & 0x7fff)
        cpu.w_pc(mem.r32(0x24))
        hw.cycles += 34
    if (nsr & 0x2000) == 0:
        stop_reason = 'left supervisor mode at %08x' % npc
        break
    if cpu.r_pc() >= 0x200000 and cpu.r_pc() != SENTINEL:
        stop_reason = 'pc out of RAM %08x' % cpu.r_pc()
        break

log.write('END %s step=%d pc=%08x %r\n' % (stop_reason, step, cpu.r_pc(), counts))
r = regs()
log.write('REGS ' + ' '.join('%s=%08x' % (n, v) for n, v in zip(REGN, r)) + '\n')
log.close()
memdump = bytes(mem.r_block(0, 0x80000))
open(args.out + '_mem.bin', 'wb').write(memdump)
pickle.dump({'exec': exec_log, 'events': hw.events, 'regs': dict(zip(REGN, r)), 'counts': counts,
             'stop': stop_reason, 'watch': watch_log, 'pc': cpu.r_pc()}, open(args.out + '.pkl', 'wb'))
print(stop_reason, 'steps', step, 'pc %08x' % cpu.r_pc(), counts)
print(' '.join('%s=%08x' % (n, v) for n, v in zip(REGN, r)))
