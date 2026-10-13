"""bench_table.py: tools/lz4-measure's cycles-68k.txt -> the README's markdown table.
Copyright (c) 2026 Stefan Skotte and contributors. MIT licence (../LICENSE).
Rows: corpus type and kind (F = 64 single frames, B = 8 whole batches as one block);
columns: 68000 cycles per raw byte (vamos)."""
import sys
cols = [('ourdec', 'our decode'), ('ourdecu', 'our decode, unchecked reads'), ('lzfast', 'Carré fastest'), ('ourenc', 'our encode 1K'),
        ('ourenc4k', 'our encode 4K'), ('lz4pasm', 'lz4p encode'), ('rledasm', 'asm RLE decode'),
        ('rleeasm', 'asm RLE encode')]
v = {}
order = []
for line in open(sys.argv[1]):
    f = line.split()
    if len(f) < 4 or f[1] not in ('F', 'B'):
        continue
    key = (f[0], f[1])
    if key not in order:
        order.append(key)
    v[key, f[2]] = f[3]
print('| type | kind | ' + ' | '.join(c[1] for c in cols) + ' |')
print('|---|---|' + '---|' * len(cols))
for key in order:
    print('| %s | %s | ' % key + ' | '.join(v.get((key, c[0]), '-') for c in cols) + ' |')
