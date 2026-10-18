# third-party/paulanet

Pinned from https://github.com/RobSmithDev/PaulaNET at commit 0afd5fa (2026-06-13). Not MIT: see LICENSE.

| File | sha256 | What |
|---|---|---|
| `PaulaNET-0afd5fa.adf` | d55d605c020e9204bec3fba07ea1519b1e04c2d85d8e56daf547d1cc23c537d0 | His disk image, decoded from `Pico/PaulaNET/DiskImage.cpp` (FFS, volume "PaulaNET", 12.06.2026; cylinders 75-79 allocated) |
| `PaulaNET.device` | 205a4f68dbbb7c58526cfb6c2ead65bf7ba05ad0c59484660574025b31e668cc | His driver, 13,872 bytes, read out of that image |
| `src/readme.md`, `src/NetDevice/` | (git tree of 0afd5fa081fad008f331d413410dea76e037f30e) | His driver's source, `git archive` of that commit, unchanged |

`tools/paulanet-driver/` builds webadf's LZ4 variant of the driver from `src/NetDevice/` plus a patch of ours
(spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §4); the PaulaNET driver disk carries that build.
His source builds to 12,808 bytes (sha256 7d14d9d1ecc3dc986b47120781bf091928c228c04c1cc3f5b9b8c24c1466a29b), not to
the 13,872-byte binary above, so the variant is pinned by its own digest. Nothing in this directory is ever modified.
