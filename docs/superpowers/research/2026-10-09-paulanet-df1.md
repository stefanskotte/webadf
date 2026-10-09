# PaulaNET-style networking on DF1 (research spike, 2026-10-09)

Operator's request: the HANDOFF backlog entry "Amiga networking over the floppy port (PaulaNET-style)". Operator
decisions already taken (2026-10-09):
- Network is a **third DF1 mode** (Off / Disk / Network) in the existing `secondDrive` setting. DF0 keeps serving
  full 80-cylinder ADFs.
- Scope is **Workbench only**.
- The Amiga-side stack is **AmiTCP_NG**.
- RobSmithDev agreed to us implementing PaulaNET "as long as the licences are respected". His repo carries no
  licence.

Also read: HANDOFF 3bc (DF1, fw 1.9.0) and "Before you touch the firmware again".

Nothing in the repo was edited except this file. Firmware was built (not flashed) in the worktree
`.claude/worktrees/paulanet-spike` (branch `research/paulanet`, at master `ed5e1ad`). Every claim carries one of
these labels:
- **READ**: a file and line in his repo or ours.
- **MEASURED**: from the build or from HANDOFF bench records.
- **INFERRED**: my reasoning.
- **(unverified)**: general Amiga knowledge not checked here.

Sources:
- PaulaNET: https://github.com/RobSmithDev/PaulaNET at commit `0afd5fa` (pushed 2026-06-13; the GitHub API reports
  `license: null`). The video is https://youtu.be/AhAg-fT83o8 and the PCBWay listing is
  https://www.pcbway.com/project/shareproject/PaulaNET_Amiga_Wifi_Network_Adapter_a4e3f0e2.html. Paths below are
  relative to that repo.
- AmiTCP_NG: https://github.com/MW0MWZ/AmiTCP_NG at `90575fa` (2026-10-08), release v4.1.8, which ships an `.adf`.
- wifipi.device: https://github.com/michalsc/WiFiPi.device (a submodule of michalsc/Emu68-tools; the repo has no
  licence file).

I have not copied any of his code into this repo. The protocol description in §1 is in my own words.

---

## Recommendation

1. **Build Network mode as board firmware that bridges Ethernet frames at layer 2 onto the board's existing Wi-Fi
   link (STA).** The board and the Amiga share the board's MAC, and the board sorts inbound frames by destination
   IP. There is no NAT and no second lwIP stack, and the TLS session on core1 is untouched. Inbound frames wait in a
   PSRAM ring (1.62 MB of PSRAM is free). The Amiga-bound track reuses DF1's existing 14,336 B stream buffer, and
   the Amiga's writes reuse the existing 32 KB capture buffer. **New SRAM is a few hundred bytes**, which matters
   because the heap floor is the tightest budget on the board.
2. **The wire protocol should be PaulaNET-compatible on cylinder 77, subject to one measurement and one email.**
   - The email (§7) asks Rob for written permission to implement the protocol and to redistribute his unmodified
     `PaulaNET.device` with credit.
   - If he grants both, the first working network needs **no Amiga code from us**: his driver plus AmiTCP_NG. That
     removes the largest piece of work (a SANA-II driver).
   - If he grants the protocol only, we write our own SANA-II driver against the same protocol.
   - If phase 0 shows that his framing (raw RLE bits with a software bit-shift) is too slow for a 7 MHz 68000, we
     use our own MFM + hardware word-sync framing instead.
3. **Prove the A500 first.** Two checks come before any SANA-II or bridging work:
   - **Phase -1, no code:** does AmiTCP_NG v4.1.8 run under Kickstart 3.1 with the bench A500's RAM?
   - **Phase 0:** a track-77 loopback that measures KB/s and round-trip time on the A500.

**Riskiest unknown:** whether a stock 7 MHz 68000 A500 under Workbench gets useful throughput and latency through
`trackdisk.device` raw I/O. PaulaNET's published 43 KB/s and 80-120 ms are from an **A1200** (68EC020). Its Amiga
side spends CPU time on a bit-level realignment of each received buffer, plus RLE and MFM codecs. The second unknown
is that AmiTCP_NG is validated only on OS 3.2 and PiStorm, never on Kickstart 3.1 or a 1 MB machine (§4.1).

---

## 1. PaulaNET as published

### 1.1 Track map and direction (READ)

| Cylinder | Function | Source |
|---|---|---|
| 0-74 (and 78+) | A normal read-only AmigaDOS disk (FFS, label "PaulaNET") holding the driver and the config tool | `Pico/PaulaNET/PaulaNET.cpp:36-50`, `MakeDiskImage/MakeDiskImage.cpp:39-62` |
| 75 | Access-point scan results | `PaulaNET.cpp:75`, `NetDevice/paulanetio.c:42` |
| 76 | Device configuration (SSID, password, hostname, flags, max sizes) plus live status (version, MAC, RSSI, link) | `PaulaNET.cpp:111-133, 866-890` |
| 77 | Ethernet frames | `PaulaNET.cpp:77, 1105-1106` |

- The "tracks" are **cylinders**. The **side line chooses the direction** (`PaulaNET.cpp:44-49`,
  `paulanetio.c:45-52`):
  - **Side 0:** the Amiga writes to the Pico (ETD_RAWWRITE, raw track `cyl*2+0`).
  - **Side 1:** the Amiga reads from the Pico (ETD_RAWREAD, raw track `cyl*2+1`).
- `MakeDiskImage.cpp:39-45` marks the blocks on the special cylinders as used, so the filesystem never allocates
  there.
- The README text says "tracks 76, 77 and 78", but its own table and the code say 75-77. **Trust the code.**
- **WPROT is a signal**, not a disk property (`PaulaNET.cpp:46-49, 1046-1052`):
  - Disk cylinders are always write-protected.
  - On 76 and 77 the drive reads writable.
  - On 75 the drive reads protected while a Wi-Fi scan runs. The config tool polls `TD_PROTSTATUS` to see when the
    scan is done (`paulanetio.c:734-746`).
- **Mode switching** happens in the STEP handler: the cylinder number alone selects the mode
  (`PaulaNET.cpp:446-451`).
- The Pico waits **5 ms after the last step** before it serves anything (`PaulaNET.cpp:1055`).

### 1.2 Framing (READ)

**Pico to Amiga** (`PaulaNET.cpp:802-834, 837-928`):
1. 120 bytes of `0xAA` lead-in, which gives Paula's data separator something to lock onto
   (`PAULA_INDEX_PADDING`, `:83`).
2. Two sync words, `0x4489 0x4489`.
3. A 12-byte `DataHeader`, MFM-encoded (24 bytes on the wire) (`:136-145`):
   - magic `0x5450`
   - XOR-of-words checksum
   - dataSize and compressedSize
   - mode
   - compression flags
   - an Amiga counter and a Pico counter
4. The payload.
5. `0xAA` padding.

Two more details of this direction:
- The board raises INDEX for 1-3 ms at the start of every repetition of the buffer, and DMA repeats the buffer for as
  long as the Amiga stays on that side and track (`:1113-1129`).
- The Amiga reads with `IOTDF_INDEXSYNC`, **not** hardware word sync. It then finds `0x44894489` in software, at
  any bit offset, and bit-shifts the whole buffer into alignment (`paulanetio.c:344-386, 389-458`).

**Amiga to Pico** (`paulanetio.c:465-508, 1046-1109`):
1. `0x0001 0x0001` (two pulses 16 cells apart).
2. The MFM header.
3. The payload.
4. A short `0xAA` trailer.

The write starts immediately (no index sync). The Pico times the cell from the first two pulses
(`bitPeriod = delta/16`, `PaulaNET.cpp:956-962`), then classifies every later interval by its length
(`:971-1001`). That is a *timing* decoder, not an MFM decoder: it accepts runs of 1 bits (2 µs intervals).

**Ethernet payload** (`PaulaNET.cpp:690-756, 765-799`):
- A 2-byte `PacketsHeader`, MFM-encoded: numPackets, and status flags `CANSEND` / `CANRECEIVE`.
- Then per frame: a 4-byte `CompressionHeader` (MFM-encoded), then the frame, either RLE or MFM. Bit 15 of the
  size says which.
- Up to 20 frames per batch on the Amiga side (`paulanetstruct.h:41`); queues of 30 frames on an RP2350
  (`PaulaNET.cpp:160-165`).

**Acknowledgement and retransmit** (`PaulaNET.cpp:583, 687-688, 773, 808`; `paulanetio.c:785-788, 931-935`):
- Each side increments its own 8-bit counter per batch and echoes the other side's.
- The Pico keeps its last batch (`PacketBackup`) until the Amiga echoes its counter.
- The Amiga keeps its batch (`writePosition`) until the Pico's reply echoes the Amiga counter.
- A repeated counter is ignored. **This is the whole reliability layer**, and it makes lost tracks harmless.

**MTU:**
- 1518-byte frame buffers (`ETH_MTU`, `paulanetstruct.h:39`). `S2_DEVICEQUERY` reports an MTU of 1504 and a raw MTU
  of 1518 (`NetDevice/device.c:443-455`).
- Transfers are at most 16,384 bytes per track operation (`MAX_TRANSFER_SIZE`). The default is 16,128
  (`PaulaNET.cpp:80, 344-345`), and it can be set between 1,536 and 16,128 from the config tool.

### 1.3 The RLE scheme and why Paula can read it (READ, then INFERRED)

**READ** (`rleCompression.h:25-29`, `rleCompression.cpp:44-117`):
- Each control byte is followed by its data:
  - **MSB set:** the low 7 bits are a count of literal bytes that follow.
  - **MSB clear:** the low 7 bits say how many times to repeat the next byte.
- Runs of 3 or more become repeats. Runs of 1-2 are absorbed into literals. Counts are capped at 127.
- Output is padded to an even length and word-swapped for the Pico's little-endian side.
- The README states the worst case: a random 1536-byte frame becomes 1549 bytes, and a best case packs 1536 bytes
  into 26.
- **The RLE output is sent as raw bits, with no clock bits**, so one byte of data is 8 cells (16 µs). MFM needs 16
  cells (32 µs) per byte. That is the claimed 2x.

**INFERRED: why it is safe to send raw.**
- RLE bounds the longest run of zero bits. A run of three or more equal bytes, including `0x00`, is always encoded
  as a 2-byte repeat, and every control byte is non-zero. At most two `0x00` literals can sit side by side, so the
  longest flux gap is about 16 + 7 + 7 cells.
- Unencoded data could carry a kilobyte of zeros: a 16,000-cell gap that no data separator holds through.
- Both ends are crystal-timed, which leaves far more margin than real media, whose MFM rule (no more than 3 zeros)
  exists because of disk jitter.
- **Paula never sees the raw payload through its sync detector**, because the read uses INDEXSYNC plus software
  alignment. So a `0x4489` pattern inside the data is harmless. With `IOTDF_WORDSYNC` it would not be: Paula would
  re-align on it (unverified, but this is the classic trackloader behaviour).
- The protocol keeps everything structural (header, packet headers) in MFM, so a framing error cannot pass as a
  valid header.

### 1.4 How the Amiga polls (READ)

There are no interrupts. The driver's packet-server process runs at **task priority 1** and **loops without
sleeping** while it is online (`device.c:718, 757-826`). Every 5 s it re-reads the config and status track
(`:727-756`). Each pass does:
1. A header-only ETD_RAWREAD of cylinder 77 side 1 (at least 1,024 bytes, INDEXSYNC) (`paulanetio.c:889-899`,
   `:765-776`).
2. A `TD_SEEK` back to side 0 (`:902-906`).
3. If compressedSize is not 0: a second read sized to the payload (`:915`).
4. A gather of queued SANA-II writes into one batch, and an ETD_RAWWRITE of side 0 (`:997-1109`). The write is
   skipped when there is nothing to send and nothing to ack (`:1052-1056`).

Latency is therefore at least one or two rotation-free raw reads plus a write per round trip, plus trackdisk's own
overhead. The device uses three 16 KB+ buffers, two of them in CHIP RAM (`paulanetio.c:611-629`). **On a 512 KB-chip
A500 that is about 33 KB of chip RAM.**

### 1.5 Measured numbers (READ, published by the author, not measured here)

- About **43 KB/s** sustained.
- **80-120 ms** ping on an unaccelerated **A1200**, with Roadshow.
- Pico W and Pico 2 W both work.

Sources: the README "Current Status" section; the PCBWay listing; theoasisbbs
(https://theoasisbbs.com/paulanet-amiga-wifi-brings-networking-to-the-amiga-floppy-port/). **There are no A500 or
68000 figures.** The line rate is 500 kbit/s raw = 62.5 KB/s, so 43 KB/s is 69% of it. If 43 KB/s holds on
uncompressed payloads, that is only possible with raw RLE framing (MFM caps the line at 31.25 KB/s) (INFERRED).

---

## 2. How frames reach Wi-Fi, and what we should do

### 2.1 PaulaNET: MAC cloning, the Pico has no IP (READ)

- `main()` replaces the STA netif's input function with its own (`PaulaNET.cpp:1304-1305`). Every received frame is
  copied into a queue for the Amiga and freed (`:1198-1219`). **lwIP on the Pico never sees a frame.**
- Frames from the Amiga go out unchanged through `cyw43_send_ethernet(…, CYW43_ITF_STA, …)` (`:1375-1379`).
- The Amiga driver reads the **Pico's STA MAC** from the status block and uses it as its own station address
  (`device.c:177-182`).
- So the Amiga *is* the Wi-Fi client at layer 2:
  - Its stack runs DHCP against the home router and gets a LAN address, router and DNS.
  - The header comment `LINK_STATUS_NOIP // No IP (normal for UP)` (`paulanetstruct.h:45`) confirms that the Pico
    itself never holds an address.
- This is neither bridging (a CYW43 STA cannot carry a second MAC without 4-address/WDS mode, which home APs do not
  offer) nor NAT. It is **the Amiga borrowing the radio's identity outright.**
- INFERRED: the Pico's own lwIP DHCP client still starts at link-up and transmits, but its replies are swallowed.
  Harmless for him.

**That design is closed to us.** Our board has to keep its own IP for the TLS session to webadf.vercel.app (core1,
`device_client.c:200-214`), for the poll, the uploads and OTA.

### 2.2 Options for us

| Option | What the Amiga sees | Board cost | Verdict |
|---|---|---|---|
| A. **Shared MAC, sort by IP** | Its own DHCP lease on the LAN, the real router and DNS, reachable from the LAN (Amiga Explorer, FTP) | One hook on the STA netif's input. Per frame: is it ARP for the Amiga's IP, IPv4 to the Amiga's IP, or a DHCP reply? Broadcasts go to both. Board-bound frames continue into lwIP unchanged | **Recommended.** Cheapest; lwIP, TLS and the pbuf budget untouched |
| B. MAC rewrite ("MAC-NAT", as wireless bridge/WET modes do) | Same as A, but the Amiga uses a locally-administered MAC that the board rewrites in Ethernet headers and ARP bodies | A, plus rewriting ARP payloads | **Fallback**, if some router gives the board and the Amiga the same lease under A |
| C. NAT/NAPT on the board | A private /30 from the board's DHCP server (we already have `dhcp_server.c`), the board's DNS relay; not reachable from the LAN | pico-sdk's lwIP has no NAPT upstream, so we would port one. Every Amiga packet goes through core1's lwIP and its 64-pbuf pool, which the TLS window already budgets (`lwipopts.h:8-31`). State tables, timers | **Rejected:** the most RAM and code, it competes with TLS for pbufs, and it breaks inbound connections |
| D. Socket proxy (Rob's own "bsdsocket proxy" future idea, README) | No IP stack on the Amiga at all | A TCP/UDP proxy on the board | Out of scope: contradicts the AmiTCP_NG decision |

**The one real risk in A is DHCP.** Both stacks put the same MAC in `chaddr`. Lease identity:
- AmiTCP_NG sends client-id `01:<MAC>` (READ: `src/api/amiga_roadshow_compat.c:4346-4347`).
- lwIP sends no client-id by default (READ: `pico-sdk/lib/lwip/src/core/ipv4/dhcp.c` has no option-61 code; it
  offers the `LWIP_HOOK_DHCP_APPEND_OPTIONS` hook at `:89-90`).
- RFC 2131 keys a lease on the client-id when one is present, so most servers should give two leases. **Some
  consumer routers key on chaddr alone.**

Mitigations, cheapest first:
1. Make the board send a distinct client-id of its own through that hook.
2. The board sees every Amiga DHCP ACK on the way in. If `yiaddr` equals its own address, it refuses to forward and
   switches to option B.

Measure on the operator's router in phase 1.

**Filtering is part of the design, not an afterthought** (INFERRED). The link is about 40-60 KB/s and polled, so the
board should forward to the Amiga only:
- ARP that concerns the Amiga's IP;
- IPv4 unicast to it;
- DHCP and BOOTP replies (UDP 68);
- IPv4 broadcast, optionally (needed for DHCP; NetBIOS/SSDP noise can be dropped).

Drop multicast (mDNS, SSDP, IPv6 ND), since AmiTCP_NG does not receive multicast (README "Deferred"), and drop all
IPv6. A busy home LAN's broadcast chatter would otherwise eat a visible share of the floppy link.

---

## 3. Board headroom (measured from the build at master `ed5e1ad`, fw 1.10.0)

The build was `cmake … && cmake --build build` in the worktree, the same commands `pnpm firmware:build` runs.
**Exit code 0**, 731/731 steps. `pnpm install` was not needed: the script is CMake only. Toolchain: Arm GNU
15.3.rel1, prepended to `PATH` as `docs/decisions/2026-08-30-device-firmware-rulings.md:52-72` requires. Image
`wifi_floppy.uf2` is 1,222,144 B.

### 3.1 SRAM (MEASURED from `arm-none-eabi-size -A` / `nm`)

| Item | Bytes |
|---|---|
| `.bss` | 419,436 |
| `.data` | 10,328 |
| Heap arena (`end` 0x2006a66c to `__HeapLimit` 0x20080000) | **88,468** |
| core0 and core1 stacks (SCRATCH_Y/X) | 4,096 + 4,096 |

Largest objects:

| Object | Bytes |
|---|---|
| lwIP `PBUF_POOL` (64 pbufs, `lwipopts.h:31`) | 98,051 |
| `buf` | 50,712 |
| Capture `mfm_buf` (`flux_capture.c:33`) | 32,768 |
| DF0 `track_words` (HD-sized) | 25,344 |
| lwIP `ram_heap` (`MEM_SIZE` 16384, `lwipopts.h:7`) | 16,403 |
| Capture `ring` | 16,384 |
| DF1 `track_words1` (`main.c:477-481`, DD-sized) | 14,336 |
| `g_http_conns` | 12,408 |

**Heap headroom** comes from HANDOFF (fw 1.8.1, bench): the low-water mark was **36,864 B**, with
`tls held 42556 peak 50116`, against the R11 floor of **20,480 B**. That leaves about 16 KB above the floor, as of
1.8.1. **It has not been re-read on 1.10.0. Re-read it before phase 1.** Every byte of new `.bss` comes straight
out of this margin. So the design adds no large SRAM buffers:
- **Inbound frames for the Amiga:** a PSRAM ring. Core1 copies each frame out of its pbuf at once and frees the
  pbuf, so the pool that the TLS receive window depends on (`lwipopts.h:8-31`) is never held by the Amiga.
- **The Amiga-bound track:** built straight into DF1's existing `track_words1`. Network mode needs no DF1 disk
  stream while the head is on cylinder 77, and the buffer is refilled from PSRAM when the head leaves.
- **The Amiga's writes:** captured into the existing `mfm_buf`. Frames are parsed into a PSRAM TX ring, and core1
  hands them to `cyw43_send_ethernet` from there.
- **New SRAM** is ring indices, the sorter state and a raw-cell classifier: **a few hundred bytes** (INFERRED).

### 3.2 PSRAM (MEASURED)

`.psram_noload` is 6,684,672 B of the 8 MB (`PICO_PSRAM_SIZE_BYTES`, pimoroni_pico_plus2_w_rp2350.h:91-93):
- `device_image` (2 slots x 160 tracks x 14,336 B, `psram_image.c:31`): 4,587,520 B.
- `g_fw_stage`: 2,097,152 B.

**Free: 1,703,936 B.** Network mode needs about 64 KB for an RX ring (42 frames) plus 32 KB for TX. DF1's PSRAM
slot keeps holding the **driver disk** (cylinders 0-74), served exactly like a DF1 disk today.

### 3.3 lwIP

- `NO_SYS=1`, `pico_cyw43_arch_lwip_threadsafe_background` (`CMakeLists.txt:431`), radio and lwIP on core1.
- Under option A the board's own lwIP traffic is unchanged.
- Amiga traffic touches lwIP only for the instant a received pbuf is copied to PSRAM and freed (in cyw43's
  receive path, i.e. the netif input hook), and for `cyw43_send_ethernet` on the way out. That must be called from
  core1 under `cyw43_arch_lwip_begin/end`. **No new pbufs, no new memp pools, no NAT tables.**
- Option C would have added a NAPT table, forwarding through `ip4_forward`, and pool pressure against
  `TCP_WND = 32*TCP_MSS` (`lwipopts.h:74`).

### 3.4 Core0 time and the track paths (READ and MEASURED)

**How DF1 tracks are produced now:**
1. `serve_drive()` (`main.c:2751-2815`) asks `track_cache_get_token()` for the PSRAM track.
2. `start_streaming()` (`main.c:558-606`) stops the old DMA, repacks bytes into 32-bit words in the drive's SRAM
   buffer, and starts a DMA into that drive's `flux_out` state machine. Every cell is 8 PIO cycles; a 1 bit is a
   750 ns pulse, and the pulse is gated on the drive's select (`floppy.pio:1-42`).
3. `dma_irq` re-arms each revolution and raises INDEX per drive (`main.c:632-670`).

A short network track works with this unchanged: the "revolution" is the buffer length, so INDEX repeats every
buffer, which is exactly what the Amiga's INDEXSYNC read wants. Pulses 2 µs apart (raw 1-runs) fit: 750 ns pulse,
1,250 ns gap. HD already runs 1 µs cells on the same SM.

**Time budget (MEASURED reference):** encoding one HD track (12.7 KB MFM) takes a median of 3.7 ms, worst 4.9 ms
(HANDOFF 2312, `main.c:2770-2773`), against a ~15 ms settle. Building a 14 KB network track from PSRAM costs about
the same or less (INFERRED). There is also time: PaulaNET builds the buffer only when the Amiga selects side 1, then
waits 1 ms (`PaulaNET.cpp:1105-1110`).

**Write capture today:** `flux_in` (pio2) measures falling-edge intervals into a 16 KB ring by DMA
(`flux_capture.c:25-33`). `flux_capture_poll()` turns them into bits in core0's loop, bounded per pass
(`flux_capture.h:46-55`). After WGATE rises, the loop takes the capture and runs the MFM sector decode
(`main.c:3557-3651`). The decode time is logged as `dec N us` but **not recorded in HANDOFF**; the comment there
expects about 6-7 ms for HD. Two blockers for network mode, both READ:
1. **Only DF0's writes are captured.** The WGATE ISR drops any write without SEL0 (`main.c:1232-1238`). Network mode
   must also arm on SEL1 when DF1's head is on cylinder 77, side 0.
2. **The classifier is MFM-only.** It sorts intervals into 2, 3 or 4 cells and counts anything under 3,000 ns as a
   glitch (`flux_bits.h:57`). PaulaNET's raw RLE has 2 µs intervals (1 cell) and long gaps. A
   PaulaNET-compatible receiver needs a second classifier: interval / cell, rounded, any count. It is pure and
   host-testable like `flux_bits.c`. **An MFM-only protocol of our own would reuse the existing classifier
   unchanged.**

**PIO:** no new state machines.
- The boot log reads `pio claims: pio0=3 pio1=3 pio2=7` (HANDOFF 3bc, Phase 1).
- DF1's `flux_out` SM, the shared `flux_in` on pio2, and DF1's `step_dir`/`sel_mtr`/`drive_id` SMs already exist.

**Generating and consuming at Paula rate: yes** (INFERRED, from the numbers above). The DMA does the bit timing. The
CPU work is one build of at most 14 KB per Amiga read and one parse per Amiga write, each a few ms, on a core that
idles between track changes.

**The one real core0 hazard: the OTA idle gate.** It requires `!gate_mounted && slot == SLOT_NONE && !g_motor_on`
(`main.c:2396-2410`). A networking Amiga keeps DF1's motor on and a driver disk mounted indefinitely, so **OTA would
never install while the network is in use.** Network mode needs its own definition of idle. One candidate: no
cylinder-77 traffic for N seconds, and DF0 idle.

---

## 4. The Amiga side

### 4.1 AmiTCP_NG

- **Licence:** GPL-2.0 (`COPYING`).
- **Interface:** "any SANA-II device"; `device=` is required in the interface file. A bare name resolves to
  `DEVS:Networks/<name>`. `configure=dhcp` leases the address. (README, lines 36, 144-172.)
- **SANA-II commands it issues** (READ: occurrence counts in `src/net/if_sana.c` and `sana2copybuff.c`):
  - `CMD_READ`, `CMD_WRITE`, `S2_DEVICEQUERY`, `S2_GETSTATIONADDRESS`, `S2_CONFIGINTERFACE`, `S2_ONLINE`,
    `S2_OFFLINE`, `S2_ONEVENT`, `S2_TRACKTYPE`, `S2_BROADCAST`, `S2_READORPHAN`, `S2_GETGLOBALSTATS`.
  - `S2_TRACKTYPE` and `S2_CONFIGINTERFACE` are allowed to fail with `S2ERR_NOT_SUPPORTED` / `IOERR_NOCMD`
    (`if_sana.c:2275-2338`).
  - It passes buffer-management tags `S2_CopyToBuff`/`S2_CopyFromBuff`, their `…32` variants and
    `S2_DMACopy…32`. A driver must look these up with `GetTagData` at `OpenDevice` and call them to move frame
    bodies (`sana2copybuff.c:433-587`). PaulaNET does exactly that (`device.c:229-234`).
- **It reads `S2_DEVICEQUERY` BPS to size the TCP window** (README §5, `if_sana.c:1079`). PaulaNET reports
  100 Mbit/s (`device.c:450`), which makes a RAM-limited window the binding limit. Our driver should report the true
  ~400 kbit/s.
- **Validated** on OS 3.2 (emulated) and on PiStorm with wifipi.device. It claims "one build for every Amiga", and
  its RAM table has a "<= 1 MB (e.g. 512K A500): ~16 KB window" row. **Kickstart 3.1 is never stated, and the bench
  A500's RAM is not recorded in HANDOFF.** Hence phase -1. The release ships an `.adf`, so the operator can mount it
  from the webadf library and install from it.

### 4.2 wifipi.device as the structural precedent (READ: `src/unit.c` of michalsc/WiFiPi.device)

- `HandleRequest()` dispatches the SANA-II commands (`unit.c:1619-1740`):
  - Quick ones are answered inline: `NSCMD_DEVICEQUERY`, `S2_DEVICEQUERY`, `S2_GETSTATIONADDRESS`, stats, online and
    offline.
  - `CMD_READ`, `CMD_WRITE`, `S2_BROADCAST`, `S2_READORPHAN` and `S2_ONEVENT` are queued.
- A unit task (`UnitTask`, `:37-199`, started by `AddTask` at `:236-283`) `Wait`s on its command port and services
  the queues.
- It also implements the sana2wireless commands (`S2_GETNETWORKS`, `S2_SETOPTIONS`…) for WirelessManager. **We do
  not need these:** Wi-Fi is set on the website, not from the Amiga.

PaulaNET's `device.c` has the same shape: a server process that owns the trackdisk I/O and loops. **Our driver
would be: a device with BeginIO/AbortIO, plus one process that owns an `IOExtTD` on trackdisk unit 1 and runs the
poll loop.**

### 4.3 Can the driver use trackdisk raw I/O on unit 1 from its own task?

**Yes (READ: PaulaNET does).** Its server process opens `trackdisk.device` unit 1 (scanning 1, 3, 2, 0;
`paulanetio.c:511-517, 631`). It then uses `ETD_RAWREAD` / `ETD_RAWWRITE` with `iotd_Count = 0xFFFFFFFF` (which
disables the disk-change counter check), `TD_SEEK`, `TD_PROTSTATUS`, `TD_CHANGESTATE` and `TD_MOTOR`.

**Requirements** (unverified; checkable against the 3.1 ROM in `docs/` by disassembly, per memory):
- Raw commands are V36+, so Kickstart 3.1 (V40) is fine.
- Buffers must be **CHIP RAM**.
- Paula's `DSKLEN` limits one transfer to 0x3FFF words (32,766 B).

**Toolchain:**
- PaulaNET's driver uses **VBCC** (README, `NetDevice/Makefile`); its config tool uses bebbo GCC.
- AmiTCP_NG builds with **bebbo `m68k-amigaos-gcc` 6.5 in Docker** (`docs/BUILDING.md:3-33`).
- **This Mac has Docker and FS-UAE, but no m68k toolchain installed** (checked: `/opt/homebrew/bin/vc` is the Vercel
  CLI, not VBCC).
- Recommendation: use **bebbo gcc in Docker**. It matches the stack we test against, and one toolchain covers the
  phase 0 test tool and the driver.

### 4.4 Licences

- **AmiTCP_NG (GPL-2.0) and our driver:** a SANA-II driver is a separately loaded Exec device that the stack talks
  to through `OpenDevice`/`BeginIO`. It does not link against AmiTCP_NG, so it is not a derivative work. (This
  repeats HANDOFF's reasoning; it is not legal advice.)
  - Use a `sana2.h` that is not AmiTCP_NG's copy: the NDK 3.2 or the AROS header.
  - **If we put AmiTCP_NG's binaries on our driver disk,** GPL-2.0 §3 requires shipping the source or a written
    offer. Simpler: link to its release, or put the source archive on the same disk.
- **PaulaNET:** "Copyright © 2026 RobSmithDev. All rights reserved." (README; no licence in the API either).
  - His **code** cannot be copied, vendored or redistributed without a grant. That includes the `PaulaNET.device`
    binary inside his ADF image (`Pico/PaulaNET/DiskImage.cpp` embeds it).
  - A **protocol** as such (track numbers, header layout, counters, the RLE format) is generally not protected by
    copyright the way its code is. But we have *read* his code, so a written grant is the clean way to be
    "compatible", and it is what "as long as the licences are respected" asks for. With no licence to respect, the
    only terms are the ones he writes. **Hence the exact question in §7.**
  - Our MIT licence (`LICENSE`) is compatible with any permissive grant he gives.

---

## 5. DF0 and DF1 sharing under Workbench

**Arbitration** (unverified, standard Kickstart behaviour):
- Each trackdisk unit has its own unit task.
- Before touching the hardware, the unit calls `disk.resource` `GetUnit()`, and it calls `GiveUnit()` after the
  operation. Waiters queue in order.
- A DF0 filesystem read makes trackdisk read a **whole track** (~12.7 KB, about one revolution of DMA, ~203 ms at
  300 rpm), plus step and settle.

**So network I/O waits at most about one DF0 track, ~0.2-0.25 s per round, during a DF0 copy** (estimate). That
matches HANDOFF's "several hundred ms ping during a DF0 copy". An idle DF0 costs nothing. Our board already serves
DF0 and DF1 interleaved: the 2-disk copy passed on the bench (HANDOFF 3bc Phase 2, step 3).

**The other DF1 client is the filesystem on the driver disk itself** (cylinders 0-74). trackdisk serialises the
filesystem's reads and the driver's raw I/O on unit 1, so the head moves between them (INFERRED).

**What the board must emulate on DF1 in Network mode:**

| Line or behaviour | Network mode | Today in Disk mode |
|---|---|---|
| Drive ID (SEL1) | DD (`0xFFFFFFFF`), so Kickstart finds DF1 at reset. The mode must therefore be the stored mode at boot, as DF1 is today (3bc) | Same |
| CHNG | A disk is present (the driver disk) and stays present. Never toggle it while networking, or the filesystem re-reads and the driver's `TD_CHANGESTATE` check fails (`paulanetio.c:638-647`) | Same mechanism (`dskchg`) |
| WPROT | Per cylinder: protected on 0-74, **writable on 77** (and 76 if we keep a status cylinder). Updated when DF1's cylinder changes (step ISR). trackdisk reads WPROT when a write starts, so it must be right before the Amiga's ETD_RAWWRITE | Always protected (3bc Phase 2 step 4) |
| TRK0 | From DF1's head, as today | Same |
| Motor | Follow `sel_mtr` as today. Only stream on side 1 while the motor is latched on, as PaulaNET does (`PaulaNET.cpp:1098`) | Same |
| INDEX | Per drive at each buffer wrap (`main.c:648`): already right for INDEXSYNC reads | Same |
| Write capture | **New:** arm on SEL1 when DF1 is on cylinder 77, side 0 | DF1 writes are ignored |
| Settle | Do not change mode until about 5 ms after the last step (`PaulaNET.cpp:1055`) | n/a |

**Kickstart reset (Ctrl-A-A):** DF1 must answer the ID again and present the driver disk. 3bc Phase 2 step 6 shows this
already works for Disk mode.

---

## 6. Open questions

1. **Bench A500 RAM** (chip/fast), and does AmiTCP_NG v4.1.8 start under Kickstart 3.1 on it? (phase -1)
2. **A500 throughput and latency, and which framing.** Raw RLE with INDEXSYNC and a software bit-shift (PaulaNET),
   or MFM with `IOTDF_WORDSYNC` (half the line rate, no shift, no new board classifier)? Decided by phase 0's
   numbers.
3. **The operator's router:** does it give the board and the Amiga separate leases with option A?
4. **Rob's answer** (§7): protocol only, or protocol plus his binary?
5. **OTA while networking:** what counts as "idle"? (§3.4)
6. **Is a status/config cylinder needed?** Wi-Fi is configured on the web, so 75 (scan) is not needed and 76 could
   be read-only status. That matters only if we stay compatible with his config tool.
7. **Re-read the heap low-water on 1.10.0** before phase 1; the 36,864 B figure is from 1.8.1.
8. **Real external DF1:** Network mode, like Disk mode, must refuse when `df1Seen` (3bc).

---

## 7. The question for Rob (draft, for the operator to send)

> Hi Rob,
>
> Thank you again for saying you have no issue with us implementing PaulaNET. Your repository says "All rights
> reserved" and has no licence file, so we would like your permission in writing, in a form we can keep in our
> repository (an MIT-licensed open-source project, https://github.com/stefanskotte/webadf). We will credit you as "PaulaNET protocol by
> RobSmithDev (https://github.com/RobSmithDev/PaulaNET), used with permission" in the firmware's notices, the
> README and the driver disk.
>
> Could you confirm which of these you are happy with?
>
> 1. **Protocol.** That our board firmware (written by us, MIT licence, none of your code copied) may implement the
>    PaulaNET floppy-track protocol, so that the PaulaNET Amiga driver works with our board, and may call this
>    "PaulaNET-compatible". The protocol is the cylinder 75/76/77 track map, the side and write-protect signalling,
>    the DataHeader/PacketsHeader/CompressionHeader layouts, the counters and ack scheme, and the RLE format.
> 2. **Driver binary.** That we may redistribute your unmodified `PaulaNET.device` (and, if you like, the
>    "PaulaNET Config" tool) on a driver disk our board serves to the Amiga, with your copyright notice intact,
>    free of charge. Or would you rather we only link to your release?
> 3. **Our own driver.** If you would rather not have the binary redistributed: may we write our own SANA-II driver
>    (MIT) that speaks the same protocol? It would then also work with your PaulaNET hardware.
> 4. **Licence.** Would you consider putting a licence on the repository (MIT or BSD, for example)? That would answer
>    1-3 for everyone, not only us. If not, a short reply to this email granting 1-3 is enough for us.
> 5. **Stability.** Is the protocol as of commit 0afd5fa stable? Is a version or capability field planned, for
>    example for the LZ4 or disk.resource ideas in your README? We would rather follow you than fork it.
>
> Many thanks,
> Stefan

---

## 8. Phased plan (riskiest first; the bench is the A500 rev 8a.1 with Kickstart 3.1)

Sizes are rough developer-days for the implementer, excluding review and bench rounds.

### Phase -1: the stack on the bench machine (no code, about 30 minutes for the operator)

**Do:**
1. Upload `AmiTCP_NG-v4.1.8.adf` to the webadf library and mount it on DF0.
2. Install it (Novice mode) to the Workbench disk or RAM.
3. Run `ping 127.0.0.1` over `lo0`.
4. Record `avail` (chip and fast RAM) before and after.

**Accept:**
- The stack starts and loopback ping replies.
- At least 100 KB of chip RAM is free with Workbench, the stack and a shell open.

**If it fails:** stop and decide (another stack, or require a RAM expansion) before any work.

### Phase 0: track-77 loopback, measured (the riskiest unknown; about 3-4 days)

**Board** (TEST build, Network mode hard-wired):
- DF1 serves a test ADF on cylinders 0-74, as Disk mode does.
- On cylinder 77, side 0, capture the Amiga's write (SEL1 arming, a new raw-cell classifier beside the MFM one).
- On side 1, serve back an echo of the last write, in the same framing: header, counters and checksum.
- Log the capture-to-ready time and the build time.
- Host tests for the classifier and the framing.

**Amiga:** a CLI tool, `NetLoop` (bebbo gcc in Docker), that opens trackdisk unit 1 and loops: write N bytes, read
the echo, compare. Two framings behind a switch:
- (a) raw RLE, INDEXSYNC, software align;
- (b) MFM with `IOTDF_WORDSYNC`.

It prints KB/s, round-trip ms (timer.device) and errors for N = 64, 1,500 and 8,000 B.

**Accept** (operator, one step per turn):
1. `NetLoop` runs 1,000 round trips with 0 mismatches for each framing.
2. Record KB/s and median and 95th-percentile round trip for each.
3. Repeat during `copy df0:#? ram:` and record the round trip.
4. Ctrl-A-A: DF1 is still listed, and `NetLoop` works again.

**Decides:** compatible vs own framing (open question 2), and whether the product is worth building on an A500. A
proposed bar is ≥ 15 KB/s and a median ping ≤ 250 ms (operator to set).

### Phase 1: layer-2 sharing on the board (about 3-4 days)

**Board:**
- The netif input hook on core1 implements option A, including the board's distinct DHCP client-id and the filter
  list in §2.2.
- PSRAM RX and TX rings; batches on cylinder 77 with the counter/ack scheme.
- `cyw43_send_ethernet` from core1.
- The OTA idle rule for Network mode.
- Heap low-water logged.
- Host tests: the frame sorter (ARP, IPv4, DHCP, broadcast, IPv6 dropped) and the rings.

**Amiga:** `NetLoop` gains a mode that sends a hand-made ARP request for the router and a DHCP DISCOVER, then
prints the replies.

**Accept:**
1. `NetLoop arp` prints the router's MAC.
2. `NetLoop dhcp` prints an offer whose `yiaddr` differs from the board's IP.
3. The board's web card stays "online" and a DF0 mount and write-back still work during this.
4. The heap low-water is ≥ 20,480 B.

### Phase 2: SANA-II driver plus AmiTCP_NG (1 day with Rob's binary, about 7-10 days for our own)

**With Rob's binary:** add his `PaulaNET.device` to the driver disk and answer its config/status cylinder (76)
read-only.

**Our own driver:** `webadf.device` in the wifipi shape (§4.2):
- the §4.1 command set and buffer-management hooks;
- events;
- an honest BPS;
- one CHIP buffer of about 8 KB plus one non-CHIP buffer, not three 16 KB ones;
- a poll loop that backs off (e.g. 20 ms → 200 ms) when idle, so Workbench stays responsive on a 68000.

**Accept:**
1. AmiTCP_NG with `device=…` and `configure=dhcp` comes online; `ShowNetStatus` shows a LAN address.
2. `ping <router>` and `ping 8.8.8.8` reply; record the times.
3. `nslookup amiga.org` resolves.
4. `ftp` or `tftp` fetches a 200 KB file; record the KB/s.
5. The same transfer while copying on DF0 completes.
6. Ctrl-A-A, then `Online` again, works.

### Phase 3: product integration (about 3 days)

**Server and web:**
- `secondDrive` gains Network (Off / Disk / Network).
- The board refuses Network when `df1Seen` (3bc).
- The driver disk is built from source and published in the library.
- Help topics cover the A500 numbers, DF0-copy latency, "Workbench only", and that DF1 holds no game disk in this
  mode.
- THIRD-PARTY-NOTICES lists Rob's grant (and AmiTCP_NG, if shipped).

**Board:** live mode switching, following the df1_live rules for Disk mode.

**Accept:**
1. Switch Off → Network from the web, restart the Amiga: DF1 shows the driver disk, and the stack comes online with
   no file edits beyond the install.
2. Network → Disk → Off behave as 3bc Phase 3 bench steps 2 and 5.
3. A firmware update offered while the stack is online installs once the Amiga is idle by the new rule, or after a
   power-off.

### Phase 4: hardening (about 2 days, plus bench)

**Test:**
- An Amiga power-off with the stack online: the board stays healthy, and the motor latch clears (the 1.9.x OTA
  stall lesson).
- A long-running transfer (one hour), with the heap low-water and dropped-frame counters checked.
- Broadcast-heavy LAN behaviour.
- A real external DF1 present: refused.

**Accept:** a one-hour `ftp` loop with no board reboot, a heap low-water ≥ 20,480 B, and every drop counted in the
log.
