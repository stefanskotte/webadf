#!/usr/bin/env python3
"""Byte-diff our encoder against Greaseweazle over every ADF in a directory.

MUST run under ~/.local/pipx/venvs/greaseweazle/bin/python.

Phase 1 compares per-track SHA-256. Phase 2 byte-diffs only the tracks that
disagree, so a clean run never materialises 244 MB of temp files.
"""
import sys, os, glob, hashlib, subprocess, tempfile
from greaseweazle.codec.amiga import amigados

adf_dir = sys.argv[1]
paths = sorted(glob.glob(os.path.join(adf_dir, '*.adf')) +
               glob.glob(os.path.join(adf_dir, '*.ADF')))
if not paths:
    sys.exit(f'no ADFs under {adf_dir}')

def reference_track(raw, tno):
    trk = amigados.AmigaDOS_DD(tno // 2, tno % 2)
    trk.set_img_track(raw[tno * 5632:(tno + 1) * 5632])
    return trk.master_track().bits.tobytes()

def field_of(off):
    """Name the sector field a byte offset lands in, so a failure is readable."""
    if off < 256: return 'lead-in gap'
    off -= 256
    if off >= 11 * 1088: return 'trailing gap'
    sec, o = divmod(off, 1088)
    for name, size in (('sync', 4), ('header', 8), ('label', 32),
                       ('header checksum', 8), ('data checksum', 8),
                       ('data', 1024), ('sector gap', 4)):
        if o < size: return f'sector {sec} {name} (+{o})'
        o -= size
    return f'sector {sec} ???'

TSX = 'node_modules/.bin/tsx'

# Phase 1: every disk's per-track hashes, in ONE node startup.
usable = [p for p in paths if os.path.getsize(p) == 901120]
if not usable:
    sys.exit(f'no usable (901,120-byte) ADFs under {adf_dir} -- {len(paths)} '
             f'file(s) found but all wrong-sized; nothing was verified')
print(f'hashing {len(usable)} disks with our encoder...')
all_ours = {}
out = subprocess.run([TSX, 'scripts/adfmfm-diff.ts', 'hash'] + usable,
                     capture_output=True, text=True)
if out.returncode != 0:
    sys.exit('our encoder failed:\n' + out.stderr)
for line in out.stdout.strip().splitlines():
    path, t, h = line.split('\t')
    all_ours.setdefault(path, {})[int(t)] = h

bad = 0
skipped = 0
for path in paths:
    raw = open(path, 'rb').read()
    name = os.path.basename(path)
    if len(raw) != 901120:
        skipped += 1
        print(f'SKIP {name}: {len(raw)} bytes, not a standard DD ADF -- NOT VERIFIED')
        continue

    ours = all_ours[path]
    mismatched = [t for t in range(160)
                  if ours[t] != hashlib.sha256(reference_track(raw, t)).hexdigest()]

    if not mismatched:
        print(f'OK   {name}  160/160 tracks identical')
        continue

    bad += 1
    print(f'FAIL {name}  {len(mismatched)} of 160 tracks differ: {mismatched[:8]}')
    t = mismatched[0]
    theirs = reference_track(raw, t)
    with tempfile.NamedTemporaryFile(suffix='.mfm', delete=False) as f:
        tmp = f.name
    subprocess.run([TSX, 'scripts/adfmfm-diff.ts', 'dump', path, str(t), tmp], check=True)
    mine = open(tmp, 'rb').read()
    os.unlink(tmp)
    if len(mine) != len(theirs):
        print(f'     track {t}: length {len(mine)} vs reference {len(theirs)}')
        continue
    off = next(i for i in range(len(mine)) if mine[i] != theirs[i])
    print(f'     track {t}: first difference at byte {off} -- {field_of(off)}')
    print(f'       ours      {mine[max(0,off-4):off+8].hex()}')
    print(f'       reference {theirs[max(0,off-4):off+8].hex()}')

print()
print(f'{len(paths) - bad - skipped}/{len(paths) - skipped} disks verified identical to the reference')
if skipped:
    print(f'{skipped} disk(s) SKIPPED (wrong size) and NOT verified -- treated as a failure')
sys.exit(1 if (bad or skipped) else 0)
