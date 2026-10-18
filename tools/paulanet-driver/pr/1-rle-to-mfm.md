**Pico: always MFM toward the Amiga**

Hi Rob, thank you for PaulaNET. While building webadf's board, which speaks your protocol, we found this one.

Frames sent toward the Amiga with RLE compression go out as raw bytes. RLE output contains zero-bit runs of up to
~30 cells, where MFM has at most 3, and Paula's data separator misreads them. We measured it on an A500 running your
driver, using a debug build that counts each read outcome. Every full-length read of such a batch failed its
checksum (640 of 640), even though the sync word was found where it should be. The link stalled after the first
large delivery. With the frames MFM-encoded instead (bit 15 of the size word, which your driver already decodes),
78 of 79 reads succeeded on the first attempt and none failed, and 8 of 8 plus 4 of 4 back-to-back file sends
completed.

With this change, Ethernet frames toward the Amiga are always MFM-encoded: the block that chose RLE when
`FLAGS_PICO_COMPRESSION` was set is gone, and the existing MFM branch runs every time. Nothing changes toward the
Pico, and nothing changes for the config and access-point tracks. `CompressedPacket.data` is already sized for MFM
(`ETH_MTU_MFM_COMPRESSED`), and the batch builder already caps a batch at `settings.maxTxSize`.

Tested against your commit 0afd5fa. It compiles here with your CMakeLists (pico2_w) on pico-sdk 2.3.0 and
arm-none-eabi-gcc (your file names 2.2.0), with no new warnings. The build has to run in `Pico/PaulaNET/build`,
because `PaulaNET.cpp` includes `build/floppytx.pio.h`. The measurements above come from webadf's board firmware
with the same change (webadf commit c49bccc), not from this exact binary, which has not run on hardware.

**Noticed, not changed here:** `paulaNetAddPacket` in `NetDevice/paulanetio.c` (~line 1032) mishandles an
odd-length RLE frame toward the Pico. `writePosition` is a `UWORD *` and the body starts 8 bytes in, at
`writePosition[sizeof(struct CompressionHeader)]`. The pad byte, however, is written at
`(UBYTE*)writePosition + compressedSize`. That zeroes a byte inside the body, or inside the MFM header when the block
is shorter than 8 bytes. The extra `writePosition++` then moves the next frame 2 bytes past where the Pico expects
it: the Pico skips `compressedSize + 1` bytes and misreads the next header, so the rest of that batch is dropped. A
fix would write the pad at `((UBYTE*)&dev->writePosition[sizeof(struct CompressionHeader)])[hdr.compressedSize]`
and drop the `writePosition++`. We can add that as a second commit here if you prefer.

Stefan Skotte (webadf)
