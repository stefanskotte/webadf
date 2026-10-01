import struct
def unpack(src, pos=0):
    out = bytearray()
    while True:
        blk_start = len(out)
        n = src[pos] | (src[pos+1]<<8); pos += 2
        if n == 0: return bytes(out), pos
        end = pos + n
        while end > pos:
            d1 = src[pos]; pos += 1
            if d1 < 0x80:
                cnt = d1 if d1 else 0x10000
                out += src[pos:pos+cnt]; pos += cnt
            else:
                if d1 == 0xff:
                    d1 = src[pos] | (src[pos+1]<<8); pos += 2
                else:
                    d1 &= 0x7f
                off = src[pos] | (src[pos+1]<<8); pos += 2
                if off >= 0x8000: off -= 0x10000
                s = blk_start + off
                cnt = d1 if d1 else 0x10000
                for k in range(cnt): out.append(out[s+k])
if __name__ == "__main__":
    d = open('g1.adf','rb').read()
    out, end = unpack(d, 26*512)
    print(hex(len(out)), hex(end), "loaded end", hex((26+635)*512))
    open('main_at_a00.bin','wb').write(out)
