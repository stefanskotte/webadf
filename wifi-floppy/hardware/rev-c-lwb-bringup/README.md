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
