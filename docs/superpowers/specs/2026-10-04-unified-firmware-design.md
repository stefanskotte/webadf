# One firmware for two boards: PIM726 (RM2/CYW43439) and Challenger+ RP2350 WiFi6 (ESP32-C6) — design

Status: written 2026-10-04 from the conversation; **awaiting operator review**. Nothing is built.
Hardware context: rev C carries a dual footprint for either module (`wifi-floppy/hardware/REV-C-DUAL-FOOTPRINT.md`,
HANDOFF §4 rev C).

## 1. What this is for

The operator's plan (2026-10-04): one firmware that runs on both modules, because the main difference between them is
the WiFi chip. The PIM726 stays the default board. The Challenger is the big-box variant: its IPEX3 antenna
connector can be brought out of an A2000, A3000 or A4000's metal case.

**Done means:**

- One signed image, published once.
- Fitted to a PIM726 it behaves exactly as 1.6.2 does today: bench-checked reads, writes, HD, NFC and OTA.
- Fitted to a Challenger, wired to the rev C pin map, it boots, joins WiFi (and runs the setup portal), mounts a
  disk, the Amiga reads and writes it, and it updates itself over the air.
- Neither board ever drives a pin that belongs to the other board's radio.

## 2. Decisions

| Decision | By |
|---|---|
| Rev C has a dual footprint, PIM726 or Challenger | operator, 2026-10-04 |
| Unified firmware for both | operator, 2026-10-04 |
| **One binary that detects its board at boot, rather than one build per board** | proposed here, needs approval |
| The RP2350 keeps lwIP, mbedTLS and our transport code on both boards; only the WiFi driver differs (ESP-Hosted on the C6, not ESP-AT) | proposed here, depends on §8's verification |
| The PIM726's partition table and pin map do not change: rev B boards update over the air as today | proposed here |

**Why one binary rather than two builds.** With two artifacts, a PIM726 image sent to a Challenger (or the reverse)
leaves a board without working WiFi, which is exactly the path its next fix would arrive by. The trial-boot rule (§3)
would revert it, but only after up to 5 minutes and a reboot. One image cannot be the wrong one. It also keeps
publishing, signing, the release registry and the Update button exactly as they are.

## 3. What the code does today (measured 2026-10-04, master `852f7b0`)

**Pins are compile-time.**
- `src/floppy_io.h` defines the floppy pins GP0-13 (INDEX 0, CHNG 1, SEL0 2, SEL1 3, MTR 4, DIR 5, STEP 6, WDATA 7,
  WGATE 8, SIDE 9, WPROT 10, RDATA 11, RDY 12, TRK0 13), I2C1 on GP18/19 and the LED on GP22. The buzzer is GP21.
- `pnpm hw:verify` checks these against rev B's netlist.

**The PIO programs (`src/floppy.pio`) take most pins as parameters, with three exceptions:**
- `step_dir` reads `in pins, 4` from SEL0, so **SEL0, SEL1, MTR and DIR must be consecutive, in that order**.
- `drive_id` waits on `gpio 2` **literally**. There is a `_Static_assert(PIN_SEL0 == 2)` in `bus_out.c`.
- `status_gate` drives an OUT window from GP0. The mask selects the five status pads.
- `bus_sniff` (a debug build only, `-DWF_BUS_SNIFF`) samples GP0-13 as a block.

**PSRAM is started by the SDK before `main()`,** from the board header's compile-time `PICO_PSRAM_CS_PIN` (47 on the
PIM726) and `PICO_PSRAM_SIZE_BYTES`. `psram_image.c` puts the two disk slots in `__uninitialized_psram`.

**The WiFi chip is called directly:** about 95 `cyw43_` call sites in `main.c` (23), `portal_net.c` (43),
`transport_tls.c` (24) and `sntp_time.c` (4). They cover:
- station connect;
- access-point mode for the portal;
- MAC and RSSI;
- lwIP locking (`cyw43_arch_lwip_begin/end`), with lwIP serviced in the background by
  `pico_cyw43_arch_lwip_threadsafe_background`.

The cyw43 driver's PIO-SPI pins are compile-time: GP23 (WL_ON), GP24 (data), GP25 (CS), GP29 (clock).

**Flash:** `partitions.json` has A = 4,096 KB at 32 KB and B = 4,096 KB at 4,128 KB, ending at **8,224 KB**. That fits
the PIM726's 16 MB but **not the Challenger's 8 MB**. The image is 582,512 bytes (1.6.2).

**OTA safety net:** a trial image is kept only after a status report naming its own version gets a 2xx within
`FW_TRIAL_DEADLINE_MS` = 300 s (`fw_trial.c`). Otherwise the board reverts to the previous slot. An image that cannot
reach the network on one board therefore undoes itself there.

## 4. Telling the boards apart

The two modules use the two packages of the same chip:
- PIM726: **RP2350B** (QFN80, 48 GPIO);
- Challenger: **RP2350A** (QFN60, 30 GPIO).

The chip reports this itself: `SYSINFO_PACKAGE_SEL` bit 0 is 0 for QFN80 and 1 for QFN60 (pico-sdk
`hardware/regs/sysinfo.h`). It is read once, first thing in `main()`, before any pad, PIO or radio is touched. No pin
is probed to find out.

Rules:
- **QFN80 means PIM726, QFN60 means Challenger.** A future third module on the same package would need a second
  discriminator (for example a strap resistor read once at boot), designed when it exists.
- **The radio of the other board is never initialised.** On the Challenger, GP23-25/29 are our floppy outputs and
  inputs, so `cyw43_arch_init()` must be unreachable there. On the PIM726, the ESP pins (GP4, 5, 8-11, 14, 15, 22)
  are floppy and other signals, so the ESP driver must be unreachable there. A host test asserts each board's radio
  pins and floppy pins are disjoint.
- The board is logged at boot (`board: pim726` / `board: challenger`) and reported in every status. The server
  stores it on the device and shows it on the Devices page (§9).

## 5. The board table

One `const board_t` per module, chosen at boot and read everywhere a pin or peripheral is named today:

| Field | PIM726 | Challenger |
|---|---|---|
| floppy pins, in `floppy_io.h`'s roles | as today | per REV-C-DUAL-FOOTPRINT.md: SEL0/SEL1/MTR/DIR = GP26-29, STEP 16, WDATA 17, WGATE 18, SIDE 19, WPROT 23, RDATA 24, RDY 25, TRK0 2, INDEX 3, CHNG 6 |
| I2C instance and pins | I2C1, GP18/19 | I2C0, GP20/21 |
| buzzer, LED | GP21, GP22 | GP13, GP7 |
| NFC reset, Amiga RESET (rev C) | GP20, GP27 | GP12, GP1 |
| PSRAM CS, size | GP47, 8 MB | GP0, 8 MB |
| radio | `RADIO_CYW43` | `RADIO_ESP_HOSTED` (SPI1 on GP8/10/11, CS 9, data-ready 14, handshake 22, reset 15) |
| flash | 16 MB | 8 MB |

`floppy_io.h` keeps its names; the constants become fields. Host tests check for each board:
- SEL0..DIR are consecutive;
- no two roles share a pin;
- no role sits on the other radio's or the PSRAM's pin;
- every status output falls inside the `status_gate` window.

## 6. PIO changes

- `drive_id`: `wait 0 gpio 2` becomes `wait 0 pin 0` with `in_base = SEL0`. The `_Static_assert` goes.
  `bus_out.c`'s comment about the 15-instruction budget on pio0 must still hold; recount.
- `status_gate`: the OUT window is set from the board's lowest to highest status pin. On the Challenger the status
  pins span GP2-GP25.
- `bus_sniff` (debug only): sample the board's floppy pins through a remap table instead of GP0-13. It may stay
  PIM726-only.
- Re-prove on the bench, on the PIM726 first, because this touches the HD drive ID that took the longest to get
  right (HANDOFF 3an).

## 7. PSRAM started by the firmware

The SDK's pre-`main` PSRAM setup needs the chip-select pin at compile time. The unified build leaves
`PICO_PSRAM_CS_PIN` undefined, and `main()` starts PSRAM itself with the board table's chip-select pin, before
`psram_image` or the firmware-update stage touches it.

**To verify (V4):**
- Can the SDK's own `hardware_psram` setup be called at runtime with a pin argument, or is a small port of it
  needed? It has to configure the QMI chip-select and the timing for the clock.
- Does `__uninitialized_psram` placement still work when nothing ran pre-`main`?

## 8. The WiFi driver interface (the real work)

A small interface, `net_radio.h`, with two implementations:

| Function | CYW43 (wraps today's calls) | ESP-Hosted |
|---|---|---|
| `init`, `deinit` | `cyw43_arch_init` | reset the C6, bring up SPI and the ESP-Hosted link |
| `sta_connect(ssid, pass, timeout, bssid)` | `cyw43_arch_wifi_connect_*` | ESP-Hosted station connect |
| `ap_start(ssid, pass)`, `ap_stop` | AP mode (portal) | ESP-Hosted softAP — **V1** |
| `mac`, `rssi`, `link_up` | `cyw43_wifi_get_*` | ESP-Hosted queries |
| `lwip_lock`, `lwip_unlock` | `cyw43_arch_lwip_begin/end` | our own lock around the ESP-Hosted netif's servicing |
| an lwIP `netif` per interface | provided by cyw43 | an ESP-Hosted netif: Ethernet frames over SPI |

Everything above the interface stays as it is on both boards: lwIP, mbedTLS (now about 330 ms per handshake), the
transport and keep-alive code, the portal's HTTP, DNS and DHCP servers, SNTP and OTA.

**Why ESP-Hosted, not ESP-AT** (which the C6 ships with). With AT, TCP and TLS run on the C6, so the transport,
keep-alive and abandon logic, the certificate pinning (`roots.h`), the portal and the OTA download would all need a
second implementation over AT commands. That would be two network stacks to keep in step. ESP-Hosted makes the C6 a
network adapter and keeps one stack. arduino-pico's Challenger variant already names ESP-Hosted's pins (data-ready,
handshake, CS, reset), which suggests the board was designed for it.

**Answered 2026-10-04: two host-side paths, each with a catch.**

| | esp-hosted-mcu (Espressif, current) | ESPHost (Arduino / J. Andrassy, used by arduino-pico's `lwIP_ESPHost`) |
|---|---|---|
| C6 co-processor | yes, the reference pairing | **not listed**: speaks esp-hosted-**FG** 0.5.0 (ESP32, S2/S3, C2/C3). C6 support in FG must be checked |
| SoftAP (our portal) | yes: `examples/wifi/softap`, `apsta` (operator, 2026-10-04; confirmed in the repo) | FG has AP control; to confirm |
| Non-ESP bare-metal host | a "real port": implement `port/os/include/eh_host_port*.h` (tasks, queues, sync, timers, GPIO, DMA) and use its vendored `esp_netif`/`lwip`. Our firmware has **no RTOS** | **already bare-metal**: a low-level driver meant to sit under an lwIP netif; proven on iLabs' Challenger RP2040 WiFi/BLE (C3) and the Nano RP2040 Connect |
| Licence | Apache-2.0 (Linux kmod GPL-2.0, not used; shared protocol files GPL-2.0 OR Apache-2.0) | LGPL-2.1: fine for an open-source firmware, but its source and notices must ship with our binaries |

Choosing between them is V2's decision. Either a minimal "OS" shim for esp-hosted-mcu on our core1 loop (or FreeRTOS,
which pico-sdk supports, though a big change to our dual-core design), or ESPHost if the FG firmware runs on a C6. The
first step is to check FG's C6 support. If it is missing, esp-hosted-mcu with a shim is the path.

**The C6's own firmware.**
- It ships with ESP-AT (operator, 2026-10-04, from the iLabs datasheet), so the ESP-Hosted co-processor firmware has
  to be flashed onto it once. arduino-pico's Challenger helper already has `flashReset()`: MODE (GP14) low, then a
  reset pulse on GP15, which puts the C6 into its ROM serial loader on the UART (GP4/5). So the RP2350 can flash it. The RP2350 controls the C6's
  BOOT (GP14) and RESET (GP15) pins and has its UART (GP4/5), so our firmware could do that itself through Espressif's
  serial ROM loader.
- That would also bring C6 firmware updates under our signed OTA.
- To decide (V5): where the C6 image is stored (probably about 1 MB, too large to embed in our app image), and
  whether first-time flashing happens at the bench over USB instead.

## 9. Server

- The status report gains `board: "pim726" | "challenger"`. A new nullable `devices.board` column, additive like
  `track_max_bytes` and `plays_hd` before it.
- The Devices page shows the module, and that is all. Capability flags (`trackMaxBytes`, `playsHd`) stay what they
  are. The release registry is unchanged: one artifact for both.

## 10. Flash layout

- The PIM726's partition table stays as it is. Its boards update over the air as today, because changing a
  partition table needs a USB install.
- The Challenger gets its own table that fits 8 MB, for example A = 3,584 KB at 32 KB and B = 3,584 KB at 3,616 KB,
  installed once over USB at its first flashing, which a new module needs anyway.
- **To verify (V6):** the same image runs from a slot at a different address, through the RP2350 boot ROM's address
  translation, as it already does from A or B today.

## 11. Phases

| Phase | What | Proven by |
|---|---|---|
| **P1** | The board table and `net_radio` interface, with a single board (PIM726) and the CYW43 implementation only. No behaviour change. PSRAM still started by the SDK. | host tests; bench run of reads, DD and HD writes, NFC and OTA on rev B |
| **P2** | Package detection, firmware-started PSRAM (V4), the `drive_id` and `status_gate` changes, and `board` in the status. Still PIM726 only. | bench: HD drive ID, writes, swap gate; `board: pim726` on the server |
| **P3** | The Challenger: the ESP-Hosted driver, a C6 firmware plan (V5), and its partition table. Bring-up on a bare Challenger wired to the rev C pin map, before rev C exists. | portal, join, mount, read, write and OTA on the Challenger |
| **P4** | Rev C hardware, both footprints, both modules. | the full bench list on each |

P1 and P2 are useful even if the Challenger is later dropped: they remove the compile-time pins and the WiFi
coupling.

## 12. Questions to answer before P3

| | Question | How |
|---|---|---|
| V1 | ~~Does ESP-Hosted on the ESP32-C6 support softAP?~~ **ANSWERED: yes**, esp-hosted-mcu has SoftAP and AP+STA (operator, 2026-10-04; the repo's examples) | done |
| V2 | **PARTLY ANSWERED (§8 table).** esp-hosted-mcu needs an OS port on our RTOS-less firmware. ESPHost is bare-metal but targets esp-hosted-FG, with no C6 listed. Next: does FG run on a C6? If not, how small can an `eh_host_port` shim on core1 be? | esp-hosted FG docs; esp-hosted-mcu `port/os/stm32` as the bare-metal reference |
| V3 | The C6's range and throughput behind the IPEX3 antenna, compared with the RM2 (2 MB image fetch time, RSSI in a closed big box) | bench |
| V4 | PSRAM started at runtime with a chosen chip-select pin | SDK source, then bench (§7) |
| V5 | Where the C6 slave firmware lives and how it is first installed and updated | design after V1/V2 |
| V6 | The same image boots from a different partition layout | build a Challenger partition table and test on hardware |
| V7 | Power: may +5 V be fed into the Challenger's USB pin while USB-C is connected, or should it go to BAT? Can its 3V3 supply the 74LVC541A, the OLED and the NFC reader? | iLabs schematic (hardware, rev C) |

## 13. Risks

- **The wrong radio initialised on the wrong board** drives floppy pins as SPI. Mitigation: the package decides
  before anything else, there are disjointness tests, and a boot log line.
- **An image whose network fails on one board.** The trial rule (§3) reverts it within 5 minutes. Keep that rule
  unchanged.
- **PIO re-plumbing touches the HD drive ID.** Mitigation: P1 and P2 run on the PIM726 with the full bench list
  before the Challenger exists.
- **No spare GPIO on the Challenger.** Every header GPIO is assigned (REV-C-DUAL-FOOTPRINT.md). DF0 passthrough's
  automatic switch-follow needs an I2C expander there, or goes without.

## 14. Out of scope

- BLE on either radio.
- WiFi 6 features beyond what ESP-Hosted gives by default.
- A third module.
- Changing the rev B / PIM726 partition table.
