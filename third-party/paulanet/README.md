# third-party/paulanet

Pinned from https://github.com/RobSmithDev/PaulaNET at commit 0afd5fa (2026-06-13). Not MIT: see LICENSE.

| File | sha256 | What |
|---|---|---|
| `PaulaNET-0afd5fa.adf` | d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0 | His disk image, decoded from `Pico/PaulaNET/DiskImage.cpp` (FFS, volume "PaulaNET", 12.06.2026; cylinders 75-79 allocated) |
| `PaulaNET.device` | 205a4f68dbbb7c58526cfb6c2ead65bf7ba05ad0c59484660574025b31e668cc | His driver, 13,872 bytes, read out of that image |

`tools/paulanet-disk/build.sh` builds the PaulaNET driver disk from the image and checks the driver against the
pinned binary. Neither file is ever modified.
