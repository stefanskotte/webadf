# wifi-floppy board: licence notice

Copyright (c) 2026 Stefan Skotte and contributors. Rev B PCB layout by Shanshe.

This source describes Open Hardware and is licensed under the CERN-OHL-P v2 (see `LICENSE` in this directory).
You may redistribute and modify this documentation and make products using it under the terms of the CERN-OHL-P v2
(https://cern.ch/cern-ohl). This documentation is distributed WITHOUT ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING OF
MERCHANTABILITY, SATISFACTORY QUALITY AND FITNESS FOR A PARTICULAR PURPOSE. Please see the CERN-OHL-P v2 for
applicable conditions.

Source location: https://github.com/stefanskotte/webadf/tree/master/wifi-floppy/hardware

Anyone may build, modify and sell their own boards from these files.

## Contributors and grant

- The rev B PCB layout (commits `11fd87b`, `89bb7f7`, `5b25572` and PR #2) is **Shanshe**'s work. Shanshe agreed to
  it being licensed this way on 2026-09-28: "For me it is fine. I did the PCB layout on your request, so I don't need
  even credits... License whatever you want. ;)"
  (https://github.com/stefanskotte/webadf/pull/3#issuecomment-5864414711). Credited here and in
  `THIRD-PARTY-NOTICES.md` with thanks.
- The KiCad library parts copied into `wifi-floppy-lib.*` keep their own licence; see `KICAD-LIBRARY-LICENSE.md`.
- Rev C's core regulator pattern and its inductor and capacitor footprints (`rev-c/reg_pattern.py`, `rev-c/rev-c-lib.pretty/L_Abracon_AOTA-B201610S3R3-101-T`, `C_0402_1005Metric_RP_wide`) come from Raspberry Pi's RP2350 minimal design R4, under this licence:

```
= MIT License =
Copyright (c) 2026 Raspberry Pi Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
