"""Checks a built PaulaNET disk without an Amiga: the files are there with the
right bytes, and cylinders 75-79 are still allocated in the bitmap, so no file can
ever land on the network cylinders. Usage: check.py <disk.adf> <listing.txt>
(listing = `xdftool <disk> list` output). Prints PASS lines; exits 1 on a failure."""
import struct, sys

WANT = {'PaulaNET.device': 13872, 'PaulaNET Config': 55536, 'Install': None, 'Install.info': None,
        'ReadMe': None, 'ReadMe.info': None, 'Receive': None, 'Receive.info': None, 'disk.info': 364}

disk = open(sys.argv[1], 'rb').read()
listing = open(sys.argv[2]).read().splitlines()
fail = 0
def check(ok, what):
    global fail
    print(('PASS ' if ok else 'FAIL ') + what)
    if not ok: fail = 1

check(len(disk) == 901120, 'a DD disk image, 901,120 bytes')
sizes = {}
for line in listing[1:]:
    parts = line.split()
    # "  <name...>  <size>  <flags>  <date> <time>": the size is the 4th field from the end
    if len(parts) >= 4 and parts[-4].isdigit():
        sizes[' '.join(parts[:-4])] = int(parts[-4])
for name, size in WANT.items():
    check(name in sizes and (size is None or sizes[name] == size), f'{name} present' + (f', {size} bytes' if size else ''))
root = disk[880 * 512:881 * 512]
bm_block = struct.unpack('>I', root[316:320])[0]
bm = disk[bm_block * 512:(bm_block + 1) * 512]
def free(b):
    i = b - 2
    return (struct.unpack('>I', bm[4 + 4 * (i // 32):8 + 4 * (i // 32)])[0] >> (i % 32)) & 1 == 1
check(not any(free(b) for b in range(75 * 22, 80 * 22)), 'cylinders 75-79 (blocks 1650-1759) all allocated')
sys.exit(fail)
