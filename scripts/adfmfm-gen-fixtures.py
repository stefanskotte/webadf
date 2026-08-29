#!/usr/bin/env python3
"""Golden MFM fixtures from Greaseweazle's amiga.amigados codec.

MUST run under ~/.local/pipx/venvs/greaseweazle/bin/python -- the module is
not installed in the system interpreter.
"""
import sys, os
from greaseweazle.codec.amiga import amigados

TRACKS = [0, 1, 80, 159]
KINDS = ['zeros', 'ones', 'prng', 'bootblock']

adf_dir, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

for kind in KINDS:
    raw = open(os.path.join(adf_dir, kind + '.adf'), 'rb').read()
    assert len(raw) == 901120, f'{kind}: {len(raw)} bytes'
    for tno in TRACKS:
        cyl, head = tno // 2, tno % 2
        trk = amigados.AmigaDOS_DD(cyl, head)
        trk.set_img_track(raw[tno * 5632:(tno + 1) * 5632])
        mfm = trk.master_track().bits.tobytes()
        assert len(mfm) == 12668, f'{kind} t{tno}: {len(mfm)} bytes'
        path = os.path.join(out_dir, f'{kind}-t{tno:03d}.mfm')
        with open(path, 'wb') as f:
            f.write(mfm)
        print(f'wrote {path}')
