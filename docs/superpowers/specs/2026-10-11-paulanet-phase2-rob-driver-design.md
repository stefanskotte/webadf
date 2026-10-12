# PaulaNET Phase 2: Rob's PaulaNET.device on our board (design, 2026-10-11)

**Status:** the operator approved the design in conversation on 2026-10-11. This document is for review before the
plan is written.

**Goal:** an A500 running AmiTCP_NG with RobSmithDev's unmodified `PaulaNET.device` comes online through our board's
DF1. The board serves the driver from cylinders 76 and 77, and the frames go out through the board's Wi-Fi using
Phase 1's layer-2 sharing (HANDOFF §3bh).

**Background reading:** research `docs/superpowers/research/2026-10-09-paulanet-df1.md` (§1 protocol, §8 phases),
HANDOFF §3bg (Phase 0) and §3bh (Phase 1).

## 1. Decisions (operator, 2026-10-11)

- **Rob's driver, used as is.** We do not write our own driver, and we do not keep a 1:1 copy to maintain.
- **Phase 2 is a TEST-only build**, as Phases 0 and 1 were: it uses the `WF_PNET_LOOP` and `WF_PNET_L2` options.
  There is no web or server change, so there is no e2e.
- **The Off/Disk/Network setting, the driver disk and live mode switching are Phase 3.**

## 2. What his driver expects, and where our board falls short

Source: his repo at `0afd5fa`, read 2026-10-11. `pnio` is `NetDevice/paulanetio.c`.

| # | His driver | Our board today | Change |
|---|---|---|---|
| 1 | Reads cylinder 76 side 1 at open (two reads) and every 5 s after (`device.c:729`). It takes the MAC, the link state (1, 2, 3 or 5 = online, `device.c:186, 735`), `flags` and `maxTxSize` from it. The header's amiga counter acknowledges its batch (`pnio:794`). If 76 cannot be read, open fails and AmiTCP stays offline (`pnio:656-681`). | Cylinder 76 is served as disk data. | Serve 76 (§3.1). |
| 2 | Bounds a batch only by `maxTxSize`. Its 20-frame check reads the wrong byte (`pnio:1017, 1042`), so a batch can hold up to 255 frames. | Refuses more than 20 frames, a decode over the 32 KB scratch, or more frames than the TX ring holds. Refusing means the batch is never acknowledged, so the driver resends it forever and sending locks up. | Take every well-formed batch (§3.2). |
| 3 | Reads at most `compressedSize + 24 + 128` bytes, capped at 16,640 (`pnio:772-774`). | `PNET_BATCH_CAP` is about 25 KB in `WF_DF1_HD` builds (`main.c:483, 2974`). | Cap batches to the Amiga at 16,128 bytes in every build (§3.3). |
| 4 | Looks for the sync `4489 4489` only in the first ~128 bytes of a read (`pnio:347-361`). | A 200-byte lead-in. About a quarter of reads find the sync at 128 or later (HANDOFF §3bg). | Sync timing (§3.4), measured first. |
| 5 | `TD_CHANGESTATE` must report a disk at open (`pnio:638-653`). | DF1 reports a disk while it holds one. | None: the bench keeps a disk in DF1. |

**Already compatible (checked):**
- Toward the board: `00 01 00 01`, then a raw big-endian DataHeader (`pnio:644-645, 1060-1080`). He always sends a
  PacketsHeader, even on an acknowledge-only write; our parser accepts it. He may send MFM frames; our parser accepts
  both MFM and RLE.
- Toward the Amiga: an MFM header, `compressed` 0, RLE frames with bit 15 clear, `compressedSize` 0 when empty.
- Counters: both start at `FF`, the Amiga counter moves on every pass, and repeated pico counters are not
  delivered twice.
- He finds the drive by scanning trackdisk units 1, 3, 2 and 0 and reading 76. Nothing on cylinders 0-74 is read, so
  DF1 can hold any disk of a set.
- The driver never writes 76 and never touches 75. Those belong to his config tool, which we do not support.

## 3. Board changes (TEST builds only, except §3.3)

### 3.1 Cylinder 76: the status track

- **When:** a read of cylinder 76 side 1 while `WF_PNET_L2` is on. A write to 76 (his config tool) is captured and
  ignored.
- **Framing:** as cylinder 77 (lead-in, sync, MFM DataHeader), with **mode 2** and `compressed` 1 (RLE). The
  checksum covers the payload bytes as sent.
- **Payload, big-endian, 156 bytes** (`paulanetstruct.h:57-75`):

| Offset | Field | Value we send |
|---|---|---|
| 0 | `length` | 142 |
| 2 | SSID [34] | zeros (the board's SSID is not the Amiga's business) |
| 36 | password [66] | zeros, always |
| 102 | hostname [34] | zeros |
| 136 | `flags` | 3: bit 1 makes the driver send RLE |
| 138 | `maxTxSize` | 8,192: the Amiga's batch budget. Never 0 or small, because the driver's unsigned 16-bit sum would wrap and overrun its buffer (`pnio:1005`). |
| 140 | `maxRxSize` | 16,128 (the driver does not use it) |
| 142 | LiveStatus `length` | 14 |
| 144 | version high, low | the firmware's major and minor |
| 146 | MAC [6] | the board's MAC |
| 152 | RSSI (signed 16-bit) | the radio's RSSI, or 0 |
| 154 | link status | 2 while Wi-Fi is associated, 0 otherwise |

- **Header counters:** `amiga_ctr` is the last Amiga counter the board took (the driver treats it as an
  acknowledgement). `pico_ctr` is the board's current pico counter. A read of 76 never delivers or frees a batch.
- The track is built fresh for every read, so the link state is current. It is a few hundred bytes, built in
  microseconds; its lead-in follows §3.4.
- **Host test:** the builder's output decoded with our own parser against the table above, byte for byte.

### 3.2 Batches from the Amiga: always take a well-formed batch

- A batch that passes the header checks (magic, mode, checksum) is always **taken**: its counter becomes the board's
  last, and its frames go to the TX ring up to the ring's free space.
- Frames that do not fit are **dropped and counted** (`pnet: l2 … over N`). This is Rob's own board's rule
  (`PN.cpp:687-745`): TCP retransmits, and the alternative locks up his driver.
- The frame limit rises from 20 to 255 for parsing. The decode stops feeding the ring when the ring is full instead
  of failing the whole batch. The 32 KB scratch never overflows, because `maxTxSize` (8,192) bounds what the driver
  sends.
- A batch larger than the scratch anyway (a driver that ignores 76) is still refused, as today, and counted.

### 3.3 Batches to the Amiga: at most 16,128 bytes, in every build

- The board-to-Amiga batch is capped at 16,128 bytes of encoded payload, so that the whole track (lead, sync,
  header, payload, trailer) is inside the driver's 16,640-byte read.
- This applies to every build, because `WF_DF1_HD` enlarges the buffer whatever the network options are.
- **Host test:** a ring of frames whose encoding would exceed the cap yields a batch at or under it, and the rest
  stays queued.

### 3.4 Sync timing: the sync within the first 124 bytes of every read

**Measure first (a spike, no product code kept).**
- A NetLoop build whose sync scan stops at 124 bytes, like the driver's, run against the board as it is. This gives
  the share of reads that the driver would miss today.
- Then a TEST board build that starts the side-1 stream at a fixed delay after the SIDE edge, with a 120-byte
  lead-in. Phase 0 measured the Amiga's read DMA at 2.4-4.2 ms after the SIDE edge, a spread of about 112 bytes of
  lead-in. A start just before 2.4 ms should put the sync between bytes 8 and 120 of every read.
- The delay and the lead-in become constants once the bench shows that NetLoop's 124-byte scan never misses in
  1,000 rounds.

**If the bench disproves the arithmetic:** stop and decide with the operator. The spec does not guess a fallback.

The same timing serves cylinders 76 and 77.

## 4. The Amiga side (the operator's steps)

- Rob's disk image, rebuilt from `Pico/PaulaNET/DiskImage.cpp` at `0afd5fa`: FFS, 12.06.2026, holding
  `PaulaNET.device` (13,872 bytes) and `PaulaNET Config`. Release 1.1 ships no ADF.
- Copy `PaulaNET.device` to `DEVS:Networks/` on the IDE Workbench.
- Create `DEVS:NetInterfaces/eth0` holding:

```
device=PaulaNET.device
unit=0
configure=dhcp
```

- The driver serves only unit 0 (`device.c:166`).
- **Licence:** Rob granted use of all of PaulaNET (HANDOFF backlog, 2026-10-09). The bench copy comes from his public
  source. Redistributing it on a driver disk is Phase 3, and needs his written message stored under `docs/` first.

## 5. Acceptance (bench, A500, KS 3.1)

1. AmiTCP_NG comes online, and `ShowNetStatus` shows a lease from the router, distinct from the board's.
2. `ping` the router and `ping 8.8.8.8` both reply; record the times.
3. `nslookup amiga.org` resolves.
4. A 200 KB file transfer (ftp or http) completes; record the KB/s.
5. The same transfer completes while copying on DF0, and the DF0 writes are `ALL bad 0`.
6. After Ctrl-A-A, the stack comes online again.
7. Board, throughout: heap low-water at least 20,480 B, no lock-up, and every drop counted in the log.

## 6. Known limits accepted for Phase 2

- **The first batch after the driver restarts:** about 1 time in 256, its counter equals the board's last, and it is
  dropped silently. Rob's board has the same behaviour.
- **The Amiga's RESET:** the board does not reset on it, as his does. It relies on the counters as above.
- **His config tool:** cylinder 75 (scan) and writes to 76 are not supported. The board's Wi-Fi is set up on the web.
- **His driver's busy-poll** (priority 1, no sleep) costs Workbench responsiveness on a 68000. That is his design,
  and we measure it rather than change it.

## 7. Testing

- **Host:**
  - the cylinder 76 builder (§3.1);
  - batches of 21 to 255 frames, and a ring overflow, both taken and counted (§3.2);
  - the 16,128-byte cap (§3.3);
  - the release build stays source-identical outside the cap (`tools/pnet_off_identical.sh`, with the cap's change
    accounted for).
- **Bench:** §3.4's spike, then §5.

## Amendments after the bench (2026-10-12)

The original text above is unchanged. The bench (HANDOFF 3bi) and the plan's corrections changed these points.

- **§3.4, the gate and the result.** The gate "NetLoop's 124-byte scan never misses in 1,000 rounds" could not be met.
  The Amiga's read DMA starts 1.0-5.4 ms after the SIDE edge (bulk 1.6-3.1 ms, peak about 2.6 ms), a spread wider than
  the driver's 124-byte, 1.98 ms window, and it is timed from SIDE, not from INDEX. The operator changed the gate to
  "1000/1000 rounds ok, 0 mismatches, misses <= ~2%". The constants kept are the planned ones: 120-byte lead-in and a
  start 2,360 us after SIDE. Measured at N=64 x1000 with `SCAN=124`: 1000/1000 ok, 0 mismatches, header nosync 4.5%,
  payload 3.1%. A second timing (1,650 us) was worse (5.4% / 5.0%). So the "never misses" gate and the 2% figure were
  not met; the driver retries about 4-5% of its reads. The acceptance run still passed at 47.5 KB/s.
- **§3.2, no scratch.** The 32 KB scratch is gone. Frames decode straight into the TX ring's slots (plan correction 1
  and ruling 12), because `maxTxSize` does not bound the decoded size under RLE. Nothing is refused for size; frames
  past the ring's free space are dropped and counted.
- **§3.1, the record is built per arrival.** The status record is built once per arrival on cylinder 76,
  not once per read.
- **§3.1, writes to 76 fail.** Cylinder 76 stays write-protected, so a write from his config tool fails ("write
  protected") instead of being captured and ignored (plan correction 3). The driver never writes 76.
