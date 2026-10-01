import sys
from capstone import *
md = Cs(CS_ARCH_M68K, CS_MODE_BIG_ENDIAN | CS_MODE_M68K_000)
def dis(data, base, start, length, addr=None):
    off = start
    end = start+length
    a = addr if addr is not None else start
    while off < end:
        got = False
        for i in md.disasm(data[off:end], a + (off-start)):
            print("%08x  %-20s %s %s" % (i.address, i.bytes.hex(), i.mnemonic, i.op_str))
            off += i.size
            got = True
        if off < end:
            print("%08x  %s  dc.w" % (a+(off-start), data[off:off+2].hex()))
            off += 2
if __name__ == "__main__":
    f, s, l = sys.argv[1], int(sys.argv[2],0), int(sys.argv[3],0)
    addr = int(sys.argv[4],0) if len(sys.argv)>4 else None
    d = open(f,'rb').read()
    dis(d, 0, s, l, addr)
