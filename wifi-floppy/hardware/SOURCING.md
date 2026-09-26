# Rev B sourcing list

Every LCSC number below was checked on its lcsc.com product page on 2026-09-26 (value, package,
manufacturer part). Stock figures are from that day.

| Ref | Part | Qty | LCSC | Manufacturer part | JLC | Stock |
|---|---|---|---|---|---|---|
| C1 | 100 nF, 1206, X7R, 50 V | 1 | [C24497](https://www.lcsc.com/product-detail/C24497.html) | Samsung CL31B104KBCNNNC | Basic | 1.02 M |
| C3 | 10 µF, 1206, X5R, 50 V | 1 | [C13585](https://www.lcsc.com/product-detail/C13585.html) | Samsung CL31A106KBHNNNE | Basic | 274 k |
| D1 | SS14 Schottky, SMA | 1 | [C2480](https://www.lcsc.com/product-detail/C2480.html) | MDD SS14 | Basic | 890 k |
| D2 | LED red, 1206 | 1 | [C49018](https://www.lcsc.com/product-detail/C49018.html) | Hubei Kento KT-1206R | Extended | 59 k |
| Q1–Q8 | BSS138 N-MOSFET, SOT-23 | 8 | [C78284](https://www.lcsc.com/product-detail/C78284.html) | JSCJ BSS138 | Extended | 210 k |
| R1–R5 | 1 kΩ, 1206 | 5 | [C1469](https://www.lcsc.com/product-detail/C1469.html) | Uni-Royal 1206W4J0102T5E | Extended | 146 k |
| R6 | 10 kΩ, 1206 | 1 | [C1489](https://www.lcsc.com/product-detail/C1489.html) | Uni-Royal 1206W4J0103T5E | Extended | 199 k |
| U2 | 74LVC541A buffer, SOIC-20 wide (300 mil) | 1 | [C2652110](https://www.lcsc.com/product-detail/C2652110.html) | TI SN74LVC541ADWR | Extended | **1,773 (low)** |
| BZ1 | Piezo buzzer, passive, 12.2 mm | 1 | [C76871](https://www.lcsc.com/product-detail/C76871.html) | TDK PS1240P02BT | Extended | 25 k |
| J1 | 2×17 (34-pin) 2.54 mm shrouded box header, vertical | 1 | [C20920](https://www.lcsc.com/product-detail/C20920.html) | Boomele 2.54-2×17P | Extended | 3.7 k |
| J2 | 1×4 2.54 mm pin header, right-angle | 1 | [C492412](https://www.lcsc.com/product-detail/C492412.html) | XFCN PZ254R-11-04P | Extended | 55 k |
| J3, J4 | 1×4 2.54 mm pin header, vertical | 2 | [C2691448](https://www.lcsc.com/product-detail/C2691448.html) | XFCN PZ254V-11-04P | Extended | 933 k |

## Not from LCSC

| Ref | Part | Where |
|---|---|---|
| U1 | Pimoroni Pico Plus 2 W (**PIM726** exactly: it carries the PSRAM the firmware needs) | Pimoroni |
| — | OLED, SSD1306 128×32, I2C, 4-pin (GND, VCC, SCL, SDA) | generic module |
| — | NFC reader HW-147C (Si512), set to I2C (switch 1 ON, 2 OFF) | generic module |
| — | 3.5" floppy power (Berg) cable, 34-pin floppy ribbon | generic |

## Notes

- U2 is the only thin line in stock; check it again close to ordering.
- The three LCSC numbers already in the design's BOM (C1469, C1489, C49018) are correct.
- The piezo is listed at 3 V nominal and the board drives it from +5 V through Q7. Check the TDK
  datasheet's maximum input voltage before ordering (not yet verified).
