# PaulaNET: permission to use and redistribute

Author: Rob Smith (RobSmithDev), https://github.com/RobSmithDev/PaulaNET
Licence: "Copyright © 2026 RobSmithDev. All rights reserved." (LICENSE in this directory)

Two grants, both relayed to webadf by its operator, Stefan Skotte:

1. **2026-10-09:** the PaulaNET protocol may be implemented in webadf's firmware and tools, provided his
   licences are respected and he is credited. (THIRD-PARTY-NOTICES.md, "Protocols used with permission".)
2. **2026-10-12:** all of his PaulaNET code may be used and redistributed, on his terms. webadf uses this to
   put his `PaulaNET Config` (unmodified) and a `PaulaNET.device` built from his driver on the PaulaNET driver disk
   that the board serves as DF1 in Network mode (spec
   docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md).

   **Modified builds (operator confirmation, 2026-10-18):** "We have permission to do modified builds." His
   permission covers builds of his driver that webadf has changed. From plan 2026-10-18 on, the driver disk's
   `PaulaNET.device` is no longer his binary but webadf's LZ4 variant: his source at commit 0afd5fa
   (`src/NetDevice/` in this directory) plus `tools/paulanet-driver/webadf-lz4.patch`, built by
   `tools/paulanet-driver/build.sh` and pinned in `tools/paulanet-driver/driver.sha256`
   (spec docs/superpowers/specs/2026-10-18-paulanet-lz4-design.md §4). His source in `src/` stays unchanged; the
   changes live only in the patch. The variant remains his work under his terms, not MIT; only the patch's own new
   files (`tools/paulanet-driver/src/`) and `m68k/lz4/` are webadf's, MIT.

Rob's own message is to be added here by the operator when convenient.
