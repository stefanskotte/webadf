# Rev C radio bring-up: Sterling-LWB+ on a plain Pico 2

Proves the Ezurio Sterling-LWB+ 453-00084 (CYW43439, MHF4) talks to the pico-sdk
`cyw43` driver over gSPI, before rev C is laid out (HANDOFF rev C section).

## Wiring (module pad -> Pico 2)

| LWB+ pad | Signal | Pico 2 |
|---|---|---|
| 5, 20 | VDD_3V3, VDD_VIO | 3V3(OUT), pin 36 (+10 uF and 100 nF at the module) |
| 1, 6, 14, 18, 24, 30 | GND | GND (at least three) |
| 12 | WL_REG_ON | GP2 (pin 4) |
| 26 | SDIO_CMD (SPI data in) | GP3 (pin 5), direct |
| 22 | SDIO_D0 (SPI data out) | GP3 via 470 ohm |
| 23 | SDIO_D1 (IRQ) | GP3 via 10 kohm |
| 25 | SDIO_D2 (mode strap, low = SPI) | GP3, direct |
| 27 | SDIO_D3 (CS) | GP4 (pin 6) |
| 29 | SDIO_CLK | GP5 (pin 7) |
| 19 | 32KHZ_OSC_IN | open (this is what the test checks) |

Same network as the Pico (2) W, per iosoft's PicoWi analysis. Keep the wires short;
the SPI clock is slowed (CYW43_PIO_CLOCK_DIV_INT=8) for breadboard wiring.

## Build and run

    mkdir build && cd build && cmake -DPICO_SDK_PATH=$HOME/pico-sdk .. && make
    # hold BOOTSEL, plug in, copy build/lwbtest.uf2; then open the USB serial port

Pass: `PASS: radio up, MAC ...` and a scan list with RSSI every 5 s (LED blinks once
per scan). Fail: `FAIL: cyw43 init` and a fast-blinking LED.

## Parts (Mouser DK, checked 2026-10-22)

| Qty | Mfr part | Mouser part | What |
|---|---|---|---|
| 3 | Ezurio 453-00084R | 239-453-00084R | Sterling LWB+ MHF4 module (54,46 kr, cut tape from 1) |
| 1 | GCT CAB556RF-0200-A-1 | 640-CAB556RF0200A1 | MHF4 to SMA rear-mount bulkhead jack, 200 mm |
| 1 | Linx ANT-DB1-LCD-SMA | 712-ANT-DB1-LCD-SMA | 2.4/5.8 GHz swivel dipole, SMA male (fits the cable and the Raspberry Pi kit's style) |
| 1 | KYOCERA AVX W3P35X8W04-H100D3B0A | 581-P35X8W04H10D3B0A | optional: stick-on PCB antenna on a 100 mm MHF4 lead (in-case use) |
| 1 | YAGEO MFR-25FBF52-470R | 603-MFR-25FBF52-470R | 470 ohm |
| 1 | YAGEO MFR-25FBF52-10K | 603-MFR-25FBF52-10K | 10 kohm |
| 1 | KEMET C320C104K5R5TA | 80-C320C104K5R | 100 nF |
| 1 | TDK FG28X5R1E106MRT06 | 810-FG28X5R1E106MR06 | 10 uF |
| 1 | Jonard R30R-0100 | 801-R30R | optional: 30 AWG Kynar wire, 100 ft |

SMA, not RP-SMA: the cable is an SMA jack, so the antenna must be SMA male.
