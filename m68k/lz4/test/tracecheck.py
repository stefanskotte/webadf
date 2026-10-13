"""tracecheck.py: filters a vamos memory trace (-t) on stdin, as test.sh uses it.
Copyright (c) 2026 Stefan Skotte and contributors. MIT licence (../LICENSE).

  tracecheck.py odd           report every word or long access at an odd address
  tracecheck.py guard LO HI   report every access touching [LO, HI) (hex addresses)
Lines reported start with BAD; the last line counts the accesses seen.
"""
import re, sys

mode = sys.argv[1]
pat = re.compile(r' ([RW])\((\d)\): ([0-9a-f]+): ')
if mode == 'guard':
    lo, hi = int(sys.argv[2], 16), int(sys.argv[3], 16)
n = bad = 0
for line in sys.stdin:
    m = pat.search(line)
    if not m:
        continue
    n += 1
    a, size = int(m.group(3), 16), int(m.group(2))
    if (size > 1 and a & 1) if mode == 'odd' else (a + size > lo and a < hi):
        bad += 1
        if bad <= 20:
            print('BAD', line.rstrip())
print('%d accesses traced, %d bad' % (n, bad))
