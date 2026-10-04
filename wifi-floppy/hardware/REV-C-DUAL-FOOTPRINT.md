# Rev C: one footprint for either the PIM726 or the Challenger+ RP2350 WiFi6/BLE5

Operator decision 2026-10-04: rev C carries footprints for **both** modules. Only one is fitted, and every board net
goes to the right pad of each:

- **PIM726**: Pimoroni Pico Plus 2 W. RP2350B, RM2 radio with an on-board antenna. This is rev B's module.
- **Challenger+ RP2350 WiFi6/BLE5 IPEX3** (iLabs). RP2350A, ESP32-C6 radio, IPEX3 (MHF III) antenna connector, for
  big-box Amigas.

The firmware picks the pin map at build time, one board definition per module.

## Sources

Each was checked against the others on 2026-10-04:

- **PIM726:** `wifi-floppy/firmware/src/floppy_io.h`, which `pnpm hw:verify` checks against the rev B netlist, plus
  the standard Pico 40-pin header numbering.
- **Challenger:** arduino-pico `variants/challenger_2350_wifi6_ble5/pins_arduino.h` (D-label to GPIO) and
  CircuitPython `boards/challenger_rp2350_wifi6_ble5`. Both agree with each other and with the iLabs datasheet
  (https://ilabs.se/challenger-rp2350-wifi-ble/). Note: the datasheet's "A0-A3" are GPIO 29-26, the only ADC pins
  on an RP2350A, and its "D13" is GPIO 7, not GPIO 13.
- **Still to verify on iLabs' pinout drawing before layout:** the physical position of each label on the
  Feather-format headers.

## Pins the Challenger uses internally (never route a board net to these)

| GPIO | Use on the Challenger |
|---|---|
| 0 | PSRAM chip select |
| 4, 5 | ESP32-C6 UART |
| 8, 9, 10, 11 | ESP32-C6 SPI1 (MISO, CS, SCK, MOSI) |
| 14 | ESP32-C6 boot mode / data ready |
| 15 | ESP32-C6 reset |
| 22 | ESP32-C6 handshake |
| 7 | on-board green LED. It is also on the header as **D13**, and we reuse it as our activity LED |

## The two firmware constraints that fix the choice

1. **SEL0, SEL1, MTR, DIR must be four CONSECUTIVE GPIOs, in that order.** The step tracker samples them in one PIO
   `in pins, 4`. On the PIM726 they are GP2-5. On the Challenger header the only consecutive runs of four are
   GP16-19 and GP26-29. **GP26-29 is used**, which leaves the SPI0 pins free.
2. **I2C must be a hardware I2C pair:** I2C1 on GP18/19 for the PIM726, I2C0 on GP20/21 (the header's SDA/SCL) for
   the Challenger.

Every other signal may go on any GPIO. Firmware work this needs:

- `drive_id` waits on `gpio 2` literally, so it must follow SEL0;
- a per-board `floppy_io.h`;
- the status output window: the outputs below all fall in GP2-GP25, inside one window.

## The mapping, net by net

Header pin numbers for the PIM726 are the standard Pico 1-40. For the Challenger, the Feather silk label is given
because iLabs prints it.

| Board net | Direction (module side) | PIM726 GPIO (header pin) | Challenger GPIO (Feather label) |
|---|---|---|---|
| INDEX | out (via FET) | GP0 (1) | GP3 (D11) |
| CHNG (disk change) | out (via FET) | GP1 (2) | GP6 (D12) |
| **SEL0** | in (via 74LVC541A) | GP2 (4) | **GP26 (A3)** |
| **SEL1** | in | GP3 (5) | **GP27 (A2)** |
| **MTR** | in | GP4 (6) | **GP28 (A1)** |
| **DIR** | in | GP5 (7) | **GP29 (A0)** |
| STEP | in | GP6 (9) | GP16 (MISO) |
| WDATA | in | GP7 (10) | GP17 (A5/SS) |
| WGATE | in | GP8 (11) | GP18 (SCK) |
| SIDE | in | GP9 (12) | GP19 (MOSI) |
| WPROT | out (via FET) | GP10 (14) | GP23 (D5) |
| RDATA | out (via FET) | GP11 (15) | GP24 (D6) |
| RDY | out (via FET) | GP12 (16) | GP25 (D9) |
| TRK0 | out (via FET) | GP13 (17) | GP2 (D10) |
| I2C SDA (J3 OLED, J4 NFC) | bidir | GP18 (24) | GP20 (SDA) |
| I2C SCL | out | GP19 (25) | GP21 (SCL) |
| NFC reset (RSTPDN, new in rev C) | out | GP20 (26) | GP12 (TX/D1) |
| Buzzer (via Q7 gate) | out (PWM) | GP21 (27) | GP13 (RX/D0) |
| Activity LED (via R4) | out | GP22 (29) | GP7 (D13, also the on-board LED) |
| Amiga RESET (new in rev C) | in (via buffer) | GP27 (32) | GP1 (A4) |

This assigns **all 20** of the Challenger's header GPIOs (1, 2, 3, 6, 7, 12, 13, 16-21, 23-29), so **there is no
spare.** The DF0 passthrough switch sense, which is GP26 (31) on the PIM726 (2026-09-28 study), has no Challenger pin
left. It would need a GPIO expander on the I2C bus, or the Challenger build does without passthrough's automatic
follow. On the PIM726, GP14-17 stay unused (rev B antenna keepout) and GP28 is free.

## Power

- **Rev B:** +5 V from J2 (Berg) through D1 into the PIM726's **VSYS** (pin 39). The PIM726's **3V3** (pin 36)
  feeds the 74LVC541A and the I2C headers. The floppy-line pull-ups go to +5 V.
- **Challenger** (to check on iLabs' schematic before layout):
  - Where +5 V may be fed in: the Feather **USB** pin is VBUS. Check whether back-feeding it is safe with USB-C
    connected (is there a diode?), or whether **BAT** is the intended input.
  - Its **3V3** pin's current budget, for the 74LVC541A, the OLED and the NFC reader.
  - Its **RST** (and **EN**) pins: leave them unconnected, or route them to a test pad.
- GND: every GND pad of both footprints to the ground plane.

## Not affected by the choice

The floppy connector J1, the 74LVC541A input buffer, the BSS138 output FETs, the 1 kOhm pull-ups, the buzzer
circuit, and the I2C headers are identical for both modules. Only the net-to-pad assignment differs.

## Firmware cost of the Challenger (for planning, not layout)

The floppy side is a pin remap. The network side is real work. The ESP32-C6 ships with ESP-AT, while our stack is
CYW43 + lwIP + mbedTLS on the RP2350. arduino-pico's variant defines ESP-Hosted pins (data-ready, handshake, CS,
reset). That suggests ESP-Hosted over SPI is an option, which would keep lwIP and mbedTLS on the RP2350 and swap
only the WiFi driver. To evaluate before committing.
