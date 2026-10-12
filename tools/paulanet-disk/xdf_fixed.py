"""xdftool with a fixed clock, so the disk is the same bytes on every build.
amitools stamps files and the root block with time.localtime(); this pins it to
2026-10-11 12:00:00 UTC (run under TZ=UTC). Usage: as xdftool."""
import sys, time
FIXED = 1791720000
_localtime = time.localtime
time.localtime = lambda secs=None: _localtime(FIXED if secs is None else secs)
time.time = lambda: float(FIXED)
from amitools.tools.xdftool import main
sys.argv = ['xdftool'] + sys.argv[1:]
sys.exit(main())
