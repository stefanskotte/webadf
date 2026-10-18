#!/usr/bin/env python3
"""Regenerate the -lh1- fixtures in src/lib/archive/fixtures (lh1.test.ts).

    python3 -I scripts/lh1-fixtures.py <empty work dir>

Writes the input files into <dir>/in, then runs the REFERENCE encoder,
/opt/homebrew/bin/lha (LHa for UNIX 1.14i-ac20211125), as `lha -ao1`
(method -lh1-, header level 1) to build lh1.lzh and lh1-big.lzh, and writes
lh1-fuzz.lzh (random bytes in -lh1- members) directly. The expected hashes in
lh1.test.ts come from `lha -x` / `lha -p` of these archives, not from here.
Deterministic: the same seeds give the same inputs.
"""
import os, random, struct, subprocess, sys

work = sys.argv[1]
d = os.path.join(work, 'in'); os.makedirs(d, exist_ok=True)
r = random.Random(1987)
w = lambda n, b: open(os.path.join(d, n), 'wb').write(b)
w('readme.txt', (('The quick brown fox jumps over the lazy dog. ' * 3).rstrip() + '\n').encode())
# binary: random bytes from a skewed distribution so lha compresses rather than stores
w('binary.bin', bytes(min(255, int(r.expovariate(0.08))) for _ in range(3000)))
w('repeat.bin', b'AMIGA' * 4000 + b'\x00' * 3000)
w('empty.txt', b'')
# > 4 KB: a 1.5 KB block repeated at distances inside and outside the 4 KB window
blk = bytes(r.randrange(32, 96) for _ in range(1500))
w('window.txt', blk + bytes(r.randrange(32,96) for _ in range(5000)) + blk + blk[:700] + bytes(r.randrange(256) for _ in range(300)) + blk)
lines = []
for i in range(9000):
    lines.append('%06d %s track %02d side %d sector %02d crc %x\n' % (i, r.choice(['DF0:', 'DF1:', 'RAM:', 'SYS:']), i % 80, i % 2, i % 11, r.randrange(16)))
w('big.txt', ''.join(lines).encode())

out = os.path.join(work, 'out'); os.makedirs(out, exist_ok=True)
subprocess.run(['lha', '-ao1q', os.path.join(out, 'lh1.lzh'), 'readme.txt', 'binary.bin',
                'repeat.bin', 'empty.txt', 'window.txt'], cwd=d, check=True)
subprocess.run(['lha', '-ao1q', os.path.join(out, 'lh1-big.lzh'), 'big.txt'], cwd=d, check=True)

# Level-0 -lh1- members whose data is random bytes: the reference decoder's
# output for them pins garbage-path behaviour (the space-filled window etc.).
r = random.Random(4096)
arc = b''
for k in range(8):
    data = bytes(r.randrange(256) for _ in range(1500))
    name = b'fuzz%d.bin' % k
    body = (b'-lh1-' + struct.pack('<II', len(data), 1000) + struct.pack('<HH', 0, 0)
            + b'\x20\x00' + bytes([len(name)]) + name + struct.pack('<H', 0))
    arc += bytes([len(body), sum(body) & 0xff]) + body + data
arc += b'\x00'
open(os.path.join(out, 'lh1-fuzz.lzh'), 'wb').write(arc)
