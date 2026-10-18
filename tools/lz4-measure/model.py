#!/usr/bin/env python3
"""
model.py: the throughput arithmetic of docs/superpowers/research/2026-10-13-paulanet-lz4.md.
ESTIMATES built on MEASURED inputs (ratios: build/results.txt; cycles: build/m68k/cycles.txt,
copied below as of 2026-10-13). The model is serial: per KB of frame bytes,
    T = O + r * L + D
  L  16.384 ms: one KB of wire bytes at 16 us a byte (8 cells of 2 us; batches carry raw bytes)
  r  wire bytes / frame bytes (results.txt)
  D  the Amiga's decode (download) or encode (upload) time for 1 KB (cycles.txt)
  O  everything else (AmiTCP, the MFM headers, sync retries, turnarounds), calibrated so that
     random data with RLE gives the 47.5 KB/s measured in Phase 2 (HANDOFF 3bi; the file was
     /dev/urandom) and assumed the same for every traffic type and codec.
"""
L = 16.384
F0, F2 = 7.09379e6, 14.18758e6


def ms(cyc_per_byte, hz):
    return cyc_per_byte * 1024 / hz * 1000


# wire/frames: rle, lz4 per frame, linkf, link9 (results.txt, Homebrew liblz4 1.10.0)
R = {"dl-ftp-random": (1.014, 1.010, 0.987, 0.987), "dl-ftp-text": (1.011, 0.859, 0.713, 0.629),
     "dl-ftp-source": (0.958, 0.718, 0.570, 0.496), "dl-ftp-adf": (0.843, 0.736, 0.669, 0.622),
     "dl-http": (0.967, 0.600, 0.414, 0.357)}
# cycles per frame byte, 68000 / 68020 (vamos): our asm RLE decode; lz4_fastest on frames; on batches
C0 = {"dl-ftp-random": (11.2, 13.6, 13.5), "dl-ftp-text": (11.5, 20.0, 22.8),
      "dl-ftp-source": (15.1, 19.9, 21.5), "dl-ftp-adf": (15.2, 18.1, 19.3), "dl-http": (14.7, 18.8, 18.6)}
C2 = {"dl-ftp-random": (6.4, 8.8, 8.8), "dl-ftp-text": (6.6, 12.7, 14.6),
      "dl-ftp-source": (8.5, 12.7, 13.7), "dl-ftp-adf": (8.5, 11.5, 12.3), "dl-http": (8.3, 11.9, 11.9)}

O = 1000 / 47.5 - R["dl-ftp-random"][0] * L - ms(C0["dl-ftp-random"][0], F0)
print("O = %.2f ms per KB (calibrated)\n" % O)
print("DOWNLOAD, 68000 7.09 MHz: KB/s of frame bytes (gain over RLE)")
print("%-14s %7s %9s %15s %15s | %s" % ("type", "RLE", "lz4/frame", "linkf", "link9",
                                        "per KB: link saved by linkf vs extra decode, 68000 / 68020@14"))
for t in R:
    rr, rl, rf, r9 = R[t]
    dr, df, db = C0[t]
    dr2, df2, db2 = C2[t]
    tr = O + rr * L + ms(dr, F0)
    tp = O + rl * L + ms(df, F0)
    tf = O + rf * L + ms(db, F0)
    t9 = O + r9 * L + ms(db, F0)
    print("%-14s %7.1f %9.1f %8.1f (%+3.0f%%) %8.1f (%+3.0f%%) | %.2f ms vs %.2f ms / %.2f ms" %
          (t, 1000 / tr, 1000 / tp, 1000 / tf, 100 * (tr / tf - 1), 1000 / t9, 100 * (tr / t9 - 1),
           (rr - rf) * L, ms(db - dr, F0), ms(db2 - dr2, F2)))

print("\nUPLOAD (the Amiga compresses), per KB: link time saved vs extra encode time over our asm RLE")
print("encoder: our lz4p.asm prototype (cycles.txt); 68030@50 uses the 68020 cycle counts (estimate)")
for name, rr, rl, e0, e2, er0, er2 in [
        ("ul-ftp-text, lz4p per frame", 1.011, 0.871, 242.4, 113.0, 41.1, 23.3),
        ("ul-ftp-text, if linked (linkf)", 1.011, 0.757, 242.4, 113.0, 41.1, 23.3),
        ("ul-ftp-random", 1.014, 1.010, 79.9, 36.2, 40.5, 22.9),
        ("ul-acks (per frame: no gain)", 1.164, 1.164, 227.7, 105.8, 63.9, 35.5)]:
    save = (rr - rl) * L
    be = save / 1000 * F0 / 1024 + er0
    print("%-31s saved %5.2f ms | extra 68000 %6.2f ms, 68020@14 %5.2f, 68030@50 %5.2f, "
          "68060@50 (~1/3 the 020 cycles) %5.2f | break-even encoder on a 68000: %3.0f c/B" %
          (name, save, ms(e0 - er0, F0), ms(e2 - er2, F2), ms(e2 - er2, 50e6), ms((e2 - er2) / 3, 50e6), be))
